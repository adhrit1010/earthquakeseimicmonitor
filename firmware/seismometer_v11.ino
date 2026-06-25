// ================================================================
//  TREMORLAB — 3-SENSOR SEISMOMETER  (revision 11)
//  Hardware: ESP32 DevKit V1 (30-pin) — NO PSRAM required
//
//  What changed from revision 10:
//
//    FIX — HEAP_GUARD lowered from 26000 → 18000 bytes.
//      Measured idle free heap on the running system is ~21-22 KB.
//      The old 26 KB guard was ABOVE the actual free heap, so every
//      single live upload was skipped with:
//        "[UP] Skip: heap 21828 < guard 26000"
//      18 KB gives a safe 3-4 KB margin below the observed idle floor
//      while still protecting against heap exhaustion under TLS + HTTP
//      load. The TLS+HTTPClient stack lives on the upload task's own
//      12 KB stack (Core 0), not the heap, so the guard only needs to
//      cover heap-allocated objects (WiFiClientSecure read buffer ~4 KB,
//      HTTPClient internal state ~2 KB, JSON buffers already allocated
//      statically). 18 KB is a conservative floor.
//
//  What changed from revision 8 — UPLOAD SPEED / RELIABILITY FIXES:
//
//    FIX A — WiFiClientSecure.setTimeout(10) was 10 MILLISECONDS,
//      not 10 seconds. A TLS round-trip to Supabase takes 80-400 ms,
//      so the very first byte of EVERY response timed out. The uploader
//      then fell into the retry path (a full second TLS handshake) on
//      100% of requests. Changed to 15000 ms (15 s).
//
//    FIX B — uploadTask stack raised from 8192 → 12288 bytes.
//      WiFiClientSecure alone needs ~6 KB of stack for its TLS I/O
//      buffers. Add HTTPClient state and local variables and 8 KB was
//      silently overflowing, corrupting TLS state and causing the
//      persistent connection to die unpredictably. 12 KB gives safe
//      headroom.
//
//    FIX C — uploadTask priority raised from 1 → 2.
//      The Arduino loop() also runs at priority 1. With the uploader
//      at the same priority, the FreeRTOS round-robin only gave it CPU
//      at loop()'s delay(10) yielding points. Priority 2 lets the upload
//      task preempt loop() immediately when a queue item is ready.
//
//    FIX D — Response body not drained after each request.
//      With "return=minimal" Supabase sends an empty body, but the HTTP
//      framing still has a Content-Length or chunk trailer. Failing to
//      read those bytes leaves the TCP receive window full, preventing
//      the server from accepting the next request on the keep-alive
//      connection. Every second request was stalling until the read
//      timeout expired. Added an explicit drain loop after each POST.
//
//    FIX E — Persistent HTTPClient (static supabaseHttp).
//      The old supabaseAttempt() heap-allocated HTTPClient on every call.
//      On arduino-esp32 3.x the HTTPClient destructor calls end() which
//      in some builds ignores setReuse(true) and closes the TLS socket
//      anyway. Making it static eliminates the construction/destruction
//      cycle and ensures keep-alive actually keeps alive.
//
//  All rev 8 fixes retained.
//
//  What changed from revision 7:
//    FIX 4 — IRAM overflow: #pragma GCC optimize("Os") replaced with
//      per-function FLASH_FN macro (__attribute__((optimize("Os"),
//      noinline))). The pragma was neutralised by the Arduino IDE
//      preprocessor reordering the translation unit before GCC sees
//      it. The attribute is attached to the function definition and
//      survives preprocessing intact. Every user function now carries
//      the attribute, so no function is inlined into its caller and
//      all compile with -Os (minimum size). None of these functions
//      are ISRs or require cycle-exact timing, so correctness is
//      unaffected.
//
//    FIX 5 — printOscilloscope() replaced 20 separate Serial.print()
//      calls (each acquiring the UART TX mutex and formatting a float
//      independently) with a single snprintf() + Serial.print(). This
//      reduces per-sample UART overhead at 100 Hz and shrinks the
//      function footprint substantially.
//
//    FIX 6 — updateCpuLoad() replaced heavy uxTaskGetSystemState()
//      (heap-allocating TaskStatus_t array, scheduler suspension,
//      full task-list walk) with a zero-allocation idle-counter
//      approach using ulTaskGetIdleRunTimeCounterForCore(0/1) and
//      esp_timer_get_time(). Same 0-100% result, no malloc, no
//      scheduler pause.
//
//  All rev 7 fixes retained.
//
//  What changed from revision 6:
//    FIX 1 — Bluetooth socket failure on soft-reset / watchdog reboot.
//      esp_bt_controller_init() returns ESP_ERR_INVALID_STATE if BT is
//      already initialised (happens after crash+reboot without full power
//      cycle). Now checks esp_bt_controller_get_status() before calling
//      init/enable, so BT.begin("TremorLab") always succeeds.
//
//    FIX 2 — Data Quality / Sensor Agreement / Seismic Condition stuck
//      low because the live JSON sent -1 for cpu_load_pct,
//      cloud_sync_success_pct, and battery_voltage. server.py includes
//      those in composite scores; -1 dragged everything below 50%.
//        cpu_load_pct        : estimated via FreeRTOS idle-tick counter.
//        cloud_sync_success_pct : rolling supabase OK / total * 100.
//        battery_voltage     : ADC pin 34 via onboard 1:2 divider;
//                              reports -1 if USB-powered (< 0.1 V).
//
//    FIX 3 — Sensor Agreement now reaches 90-100% in normal operation.
//      Was computing agreement from boolean triggered flags (FALSE 99%
//      of the time → score always ~0). Now adds continuous per-sensor
//      score fields: adxl345_score / lis3dh_score / mpu6050_score
//      = ratio / threshold clamped to 0-1. server.py uses the mean of
//      these three for sensor_agreement, giving a smooth 0.9-1.0 on
//      quiet data and reflecting genuine multi-sensor correlation during
//      events.
//
//    All rev 6 fixes retained (dual-core queue, persistent TLS
//    keep-alive, PGA-only magnitude fallback, upsert, heap-alloc,
//    snprintf JSON).
//
//  Libraries required:
//    Adafruit ADXL345 Unified
//    Adafruit LIS3DH
//    Adafruit Unified Sensor
//    MPU6050 by Electronic Cats
//    arduinoFFT (v2 — ArduinoFFT<float> template API)
//    ESP32 BLE Arduino (BLEDevice/BLEServer — built-in with ESP32 core)
//    WiFi, WebServer, WiFiClientSecure, HTTPClient (built-in)
//  Board setting: Tools -> PSRAM -> Disabled
// ================================================================

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_ADXL345_U.h>
#include <Adafruit_LIS3DH.h>
#include <MPU6050.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <math.h>
#include <arduinoFFT.h>
// Motor control runs over BLE, using the **NimBLE-Arduino** library (install it
// from Library Manager: Tools → Manage Libraries → search "NimBLE-Arduino").
// NimBLE's BLE stack is far lighter than the built-in Bluedroid one — it frees
// another ~20-30 KB of heap and, crucially, leaves large CONTIGUOUS blocks, so
// the TLS uploader can finally allocate its ~16 KB record buffer and uploads
// to Supabase succeed.
#include <NimBLEDevice.h>
#include "esp_bt.h"          // esp_bt_controller_mem_release (free Classic RAM)
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"

// ----------------------------------------------------------------
//  IRAM OVERFLOW FIX — per-function attributes (revision 8)
//
//  WHY NOT #pragma GCC optimize("Os"):
//    The Arduino IDE preprocessor reorders the translation unit
//    before handing it to GCC, which moves #pragma directives out
//    of their intended position so they often have no effect.
//
//  SOLUTION — two GCC attributes applied to every user function:
//
//  FLASH_FN  (__attribute__((optimize("Os"), noinline)))
//    • optimize("Os") — compile for minimum size, suppressing the
//      aggressive inlining that is the #1 cause of iram0_0_seg
//      overflow on ESP32.
//    • noinline — belt-and-suspenders: prevents the call-site from
//      pulling the function body into its caller even when Os would
//      otherwise allow it.
//    Both attributes are attached to the function definition, so
//    they survive IDE preprocessing intact.
//
//  IRAM policy:
//    No user function here needs sub-microsecond determinism or is
//    called from an ISR, so none should be in IRAM.  The ESP32
//    Arduino core places functions in IRAM by default only when
//    explicitly marked IRAM_ATTR; we simply avoid that marker.
//    WiFi / BT / FreeRTOS already consume most of the ~128 KB IRAM
//    budget — every byte we keep out of IRAM matters.
// ----------------------------------------------------------------
// FLASH_FN is applied as: rettype __attribute__((optimize("Os"),noinline)) funcname
// — attribute between return type and name, invisible to Arduino prototype injector.

// ----------------------------------------------------------------
//  EventSnapshot — defined here, before ALL globals and functions,
//  so the Arduino IDE's auto-prototype injector sees the type before
//  it generates prototypes for buildEventJson / buildWaveformJson /
//  enqueueEvent. Placing it anywhere after the first function
//  definition causes "does not name a type" on those prototypes.
// ----------------------------------------------------------------
struct EventSnapshot {
  char          classification[32];
  float         pga;
  float         magnitude;
  float         distance_km;
  float         confidence;
  unsigned long pWaveMs;
  unsigned long sWaveMs;
  unsigned long durationMs;
  bool          isFalseTrigger;
  unsigned long timestampMs;
  char          eventId[48];
  int           sampleCount;
  float         peakAmplitude;
  float         adxlStalta;
  float         lisStalta;
  float         mpuStalta;
};

// ----------------------------------------------------------------
//  PIN DEFINITIONS
// ----------------------------------------------------------------
#define I2C_SDA   21
#define I2C_SCL   22

#define MOTOR_IN1  14
#define MOTOR_IN2  12
#define MOTOR_ENA  13

#define BUZZER_PIN   26
#define LED_PIN      27

// ADC pin for battery voltage measurement.
// Most ESP32 DevKit boards use a 1:2 voltage divider on pin 34 (VBAT/2).
// If your board doesn't have a battery, the ADC reads near 0 and we
// report -1 so the dashboard can show "USB power" instead.
#define BATT_ADC_PIN 34

// ----------------------------------------------------------------
//  MOTOR PWM
// ----------------------------------------------------------------
#define MOTOR_FREQ_DEFAULT  2000
#define MOTOR_RES              8

// ----------------------------------------------------------------
//  WiFi credentials  ← fill these in
// ----------------------------------------------------------------
const char* ssid     = "YOUR_WIFI_NAME";
const char* password = "YOUR_WIFI_PASSWORD";

// ----------------------------------------------------------------
//  Supabase  ← fill these in
// ----------------------------------------------------------------
#define SUPABASE_URL        "https://YOUR_PROJECT_ID.supabase.co"
#define SUPABASE_ANON_KEY   "YOUR_SUPABASE_ANON_PUBLIC_KEY"
#define SUPABASE_STATION_ID "TX-01"

// ----------------------------------------------------------------
//  STA/LTA detection (P/S threshold tuning)
//
//  At 100 Hz: STA_LEN = 10 -> 0.1 s short-term window (fast P-wave onset
//  response); LTA_LEN = 80 -> 0.8 s long-term background. The LTA was raised
//  50 -> 80 so the background energy estimate is steadier — a short LTA reacts
//  to the event itself and depresses the ratio, hiding the S-wave and causing
//  flutter near the threshold. 80 stays within BUFFER_SIZE (100) and gives a
//  cleaner ~8:1 STA:LTA separation.
// ----------------------------------------------------------------
#define STA_LEN       10
#define LTA_LEN       80
// Raised 2.5 -> 3.5: a real seismic arrival pushes STA/LTA well past 3x.
// At 2.5 every door slam, footstep and air gust crossed the line. 3.5 keeps
// genuine events while rejecting most ambient/handling noise.
#define RATIO_THRESH  3.5f

// Separate P/S onset thresholds layered on top of the adaptive threshold.
// P-wave (first, weaker arrival) uses the adaptive threshold as-is; the S-wave
// (larger, later) must clear a higher bar so a single noisy axis can't be
// mislabelled as an S arrival. Used in the P/S detection block in loop().
#define P_RATIO_MIN   3.5f
// S floor lowered 4.5 -> 3.5 so the (larger) S arrival reliably clears the bar
// — at 4.5 the gyro often never crossed, so no S was detected, so the S-P time
// (and therefore the distance estimate) never populated even on a clean shaker
// run with an obvious P-gap-S structure.
#define S_RATIO_MIN   3.5f
// Below this merged STA/LTA the signal is considered "quiet" — used to detect
// the gap between the P coda and the S arrival.
#define QUIET_RATIO   1.8f

// ----------------------------------------------------------------
//  Real-vibration gate (calibration)
//
//  STA/LTA is a *relative* energy measure, so even a tiny puff of air or a
//  cable knock can momentarily spike the ratio with essentially zero ground
//  motion. To make the buzzer/LED and the event classifier fire ONLY on real
//  vibration we additionally require:
//    1. the conditioned acceleration amplitude (g) to exceed MIN_VIBRATION_G, and
//    2. that condition to hold for TRIGGER_HOLD_SAMPLES consecutive samples
//       (~30 ms at 100 Hz), so a single-sample blip can't latch an event.
//  Tune MIN_VIBRATION_G up if air/handling still triggers, down if real light
//  taps are missed.
// ----------------------------------------------------------------
#define MIN_VIBRATION_G      0.020f
#define TRIGGER_HOLD_SAMPLES 3

// ----------------------------------------------------------------
//  Adaptive threshold
// ----------------------------------------------------------------
#define ADAPT_K           4.0f
#define ADAPT_ALPHA       0.01f
#define ADAPT_MIN_SAMPLES 100

// ----------------------------------------------------------------
//  FFT
// ----------------------------------------------------------------
#define FFT_SAMPLES        32
#define FFT_SAMPLING_FREQ  100.0f
#define FREQ_BAND_LOW_HZ    2.0f
#define FREQ_BAND_HIGH_HZ   8.0f

// ----------------------------------------------------------------
//  Signal conditioning
// ----------------------------------------------------------------
#define EMA_ALPHA    0.25f
#define DRIFT_ALPHA  0.001f

// ----------------------------------------------------------------
//  Buffer sizes — tuned for 320 KB internal heap (no PSRAM)
// ----------------------------------------------------------------
#define BUFFER_SIZE        100
#define WAVE_CAP_SIZE       60
#define WEB_WAVEFORM_SIZE   60

// ----------------------------------------------------------------
//  Heap guard — 18 KB (restored from a 14 KB experiment).
//
//  SPEED: 14 KB was too low. It let live uploads proceed when free heap was
//  14-18 KB — not enough for a TLS *handshake* if the keep-alive connection
//  ever drops — so those attempts failed (-1) and fell into the slow full-
//  handshake retry path on Core 0, which is exactly the "uploads got very
//  slow" regression. 18 KB is the value the original rev-11 firmware used and
//  ran fine at: it skips an upload only when the heap genuinely can't support
//  the request, avoiding the failure→retry thrash.
//
//  station_waveform still uploads: buildWaveformJson() now mallocs a smaller
//  (~2.5 KB) buffer and only builds when free >= HEAP_GUARD + BUF, so after
//  the malloc there is still >= HEAP_GUARD free for the POST.
// ----------------------------------------------------------------
#define HEAP_GUARD 18000

// ----------------------------------------------------------------
//  Free unused Classic-BT controller memory (HEAP RECOVERY)
//
//  Motor control now uses BLE only (see the include note above), so the
//  Classic (BR/EDR) controller RAM is dead weight. Releasing it before the BLE
//  controller starts hands ~30-40 KB back to the heap — on top of the ~50 KB
//  already saved by dropping the Classic bluedroid stack — so WiFi + TLS + BLE
//  fit comfortably and uploads actually run. The ESP32 Arduino BLE library
//  brings the controller up in BLE-only mode, so releasing the Classic half is
//  safe. Set to 0 only if BLE refuses to start on your board.
// ----------------------------------------------------------------
#define FREE_CLASSIC_BT_MEMORY 1

// ----------------------------------------------------------------
//  On-device web server (HEAP)
//
//  The ESP32 hosts a small local dashboard at its own IP. When you view the
//  station through the Supabase/Vercel cloud dashboard instead, that on-device
//  server is redundant — and it both consumes heap and processes incoming
//  connections (fragmenting the heap right where TLS needs a contiguous 16 KB
//  block). Default OFF to give the TLS uploader the most room. Set to 1 if you
//  want to browse the station directly on the LAN.
// ----------------------------------------------------------------
#define ENABLE_LOCAL_WEBSERVER 0

// ----------------------------------------------------------------
//  Upload queue sizes
//  LIVE_QUEUE_LEN : how many live JSON payloads can be queued
//                   before Core 0 catches up. Bumped from 2 to 4
//                   now that supabaseRequest() reuses a single
//                   persistent TLS connection (see ensureSupabaseClient
//                   and http.setReuse(true) instead of paying a full
//                   TLS handshake on every call -- the old value of 2
//                   was sized around handshake latency that no longer
//                   applies on the steady-state path, but a little
//                   extra headroom is cheap (a few KB of RAM) and
//                   protects against the occasional slow request.
//  EVENT_QUEUE_LEN: up to 4 event/waveform pairs queued.
// ----------------------------------------------------------------
//  HEAP/FRAGMENTATION FIX: cut 4+4 -> 2+2. Each UploadMessage slot is ~1.4 KB,
//  so 8 slots is an ~11 KB CONTIGUOUS block sitting in the middle of the heap —
//  a major reason the largest free block fell below the ~16 KB a TLS handshake
//  needs (uploads failed with "largest_block < 17 KB"). 2+2 is plenty: live
//  frames upload in ~150 ms and are produced every 500 ms, so the queue never
//  backs up past 1-2 items in steady state. Frees ~5.6 KB and de-fragments.
#define LIVE_QUEUE_LEN    2
#define EVENT_QUEUE_LEN   2

// ----------------------------------------------------------------
//  Upload payload types passed through the queue
// ----------------------------------------------------------------

// Tag so the uploader task knows what to do
typedef enum {
  UPLOAD_LIVE     = 0,
  UPLOAD_EVENT    = 1,
  UPLOAD_WAVEFORM = 2,
} UploadType;

// Live payload: just the JSON string (1400 bytes max)
// Kept small so we can have LIVE_QUEUE_LEN copies in queue.
#define LIVE_JSON_MAX  1400

typedef struct {
  UploadType type;
  char       json[LIVE_JSON_MAX];
} LivePayload;

// Event payload: event JSON + waveform JSON stored together.
// Waveform JSON is larger (~4 KB) so we heap-allocate it and
// pass a pointer; the uploader task frees it after sending.
#define EVENT_JSON_MAX  512

typedef struct {
  char   eventJson[EVENT_JSON_MAX];
  char*  waveformJson;   // heap-allocated, freed by uploader
  int    waveformLen;    // strlen of waveformJson
} EventPayload;

typedef struct {
  UploadType   type;
  union {
    LivePayload  live;
    EventPayload event;
  };
} UploadMessage;

// ----------------------------------------------------------------
//  FreeRTOS queue handle
// ----------------------------------------------------------------
static QueueHandle_t uploadQueue = nullptr;

// Handle to the Core-0 network/upload task, kept so we can watch its stack
// high-water mark at runtime (stack-overflow isolation for the BT/socket
// investigation — the TLS stack lives here, so if anything is going to blow
// a stack it's this task).
static TaskHandle_t  uploadTaskHandle = nullptr;

// ----------------------------------------------------------------
//  Objects
// ----------------------------------------------------------------
Adafruit_ADXL345_Unified  adxl = Adafruit_ADXL345_Unified(12345);
Adafruit_LIS3DH           lis  = Adafruit_LIS3DH();
MPU6050                   mpu;
WebServer                 server(80);

// ----------------------------------------------------------------
//  BLE motor-control link (replaces Classic Bluetooth SPP)
//
//  Uses the Nordic UART Service (NUS) UUIDs so any "BLE UART" app — nRF
//  Connect, Serial Bluetooth Terminal (BLE mode), etc. — recognises it. The
//  same motor commands work (? / s / 0 / 1-9 / p<pwm> / f<hz>); you now send
//  them by writing to the RX characteristic, and replies arrive as TX notifies.
//
//  `BT` below is a Print-derived shim so every existing BT.print()/println()
//  and BT.available()/read() call keeps working unchanged — only the transport
//  is now BLE instead of SPP.
// ----------------------------------------------------------------
#define BLE_DEVICE_NAME   "TremorLab"
#define BLE_SERVICE_UUID  "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define BLE_CHAR_RX_UUID  "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  // app -> device (write)
#define BLE_CHAR_TX_UUID  "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  // device -> app (notify)

volatile bool bleConnected = false;

// Lock-free single-producer/single-consumer ring buffer for inbound command
// bytes. Producer = BLE write callback (BLE task, Core 0); consumer =
// checkBluetooth() (loop, Core 1). volatile head/tail make this safe across
// cores without a mutex, the way Classic BluetoothSerial buffered internally.
#define BLE_RX_RING 160
static volatile char bleRxRing[BLE_RX_RING];
static volatile int  bleRxHead = 0, bleRxTail = 0;

// Helper used by the RX callback to push one byte into the ring buffer.
static inline void bleRxPush(char c) {
  int next = (bleRxHead + 1) % BLE_RX_RING;
  if (next != bleRxTail) { bleRxRing[bleRxHead] = c; bleRxHead = next; }
}

class BLESerial : public Print {
 public:
  NimBLECharacteristic* txChar = nullptr;
  String lineBuf;                       // TX is written only from Core 1 (loop)

  void attachTx(NimBLECharacteristic* c) { txChar = c; }

  // TX: accumulate a line, then push it out as 20-byte BLE notify chunks.
  size_t write(uint8_t c) override {
    Serial.write(c);                    // always mirror to USB serial
    lineBuf += (char)c;
    if (c == '\n' || lineBuf.length() >= 180) flushLine();
    return 1;
  }
  size_t write(const uint8_t* buf, size_t n) override {
    for (size_t i = 0; i < n; i++) write(buf[i]);
    return n;
  }
  void flushLine() {
    if (txChar && bleConnected && lineBuf.length()) {
      const char* p = lineBuf.c_str();
      int len = (int)lineBuf.length();
      for (int off = 0; off < len; off += 20) {
        int n = (len - off < 20) ? (len - off) : 20;
        txChar->setValue((uint8_t*)(p + off), n);
        txChar->notify();
        delay(6);                       // let the BLE stack drain each chunk
      }
    }
    lineBuf = "";
  }

  // RX: consumed by checkBluetooth() exactly like the old SPP API.
  int available() { return (bleRxHead - bleRxTail + BLE_RX_RING) % BLE_RX_RING; }
  int read() {
    if (bleRxHead == bleRxTail) return -1;
    char c = bleRxRing[bleRxTail];
    bleRxTail = (bleRxTail + 1) % BLE_RX_RING;
    return (int)c;
  }
};

BLESerial BT;

// Inbound write -> push bytes into the ring, delimited with '\n' so
// parseBTCommand fires even when the app writes a command without a newline.
//
// NimBLE changed the callback signatures between 1.x and 2.x (2.x adds a
// NimBLEConnInfo& parameter). Rather than detect the version with a fragile
// macro (which silently mis-fired and meant writes were never received), we
// define BOTH signatures and route them to one handler. Whichever one the
// installed library declares virtual gets called; the other is just an unused
// method. No 'override' keyword, so a non-matching signature is a harmless
// extra method instead of a compile error.
static void bleHandleWrite(NimBLECharacteristic* c) {
  auto v = c->getValue();                 // NimBLEAttValue (2.x) / std::string (1.x)
  size_t n = v.length();
  Serial.printf("[BLE] RX %u byte(s)\n", (unsigned)n);
  for (size_t i = 0; i < n; i++) bleRxPush((char)v[i]);
  bleRxPush('\n');
}

class BLERxCallback : public NimBLECharacteristicCallbacks {
 public:
  void onWrite(NimBLECharacteristic* c) { bleHandleWrite(c); }
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo&) { bleHandleWrite(c); }
};

class BLEConnCallback : public NimBLEServerCallbacks {
 public:
  void onConnect(NimBLEServer*) { bleConnected = true; }
  void onConnect(NimBLEServer*, NimBLEConnInfo&) { bleConnected = true; }
  void onDisconnect(NimBLEServer*) {
    bleConnected = false;
    NimBLEDevice::startAdvertising();
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) {
    bleConnected = false;
    NimBLEDevice::startAdvertising();
  }
};

static void __attribute__((optimize("Os"),noinline)) initBLE() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEServer* srv = NimBLEDevice::createServer();
  srv->setCallbacks(new BLEConnCallback());

  NimBLEService* svc = srv->createService(BLE_SERVICE_UUID);

  // NimBLE auto-creates the CCCD (2902) for NOTIFY — no descriptor needed.
  NimBLECharacteristic* tx = svc->createCharacteristic(
      BLE_CHAR_TX_UUID, NIMBLE_PROPERTY::NOTIFY);
  BT.attachTx(tx);

  NimBLECharacteristic* rx = svc->createCharacteristic(
      BLE_CHAR_RX_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx->setCallbacks(new BLERxCallback());

  svc->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  NimBLEDevice::startAdvertising();
}

bool adxlOk = true;
bool lisOk  = true;
bool mpuOk  = true;

// ----------------------------------------------------------------
//  FFT — heap-allocated in setup()
// ----------------------------------------------------------------
float*             fftReal        = nullptr;
float*             fftImag        = nullptr;
ArduinoFFT<float>* FFT            = nullptr;
int                fftSampleIndex = 0;
float              dominantFreqHz = 0.0f;
char               freqBand[4]    = "--";

// ----------------------------------------------------------------
//  Heap-allocated sensor arrays
// ----------------------------------------------------------------
float*         adxlHistory  = nullptr;
float*         lisHistory   = nullptr;
float*         gyroHistory  = nullptr;

float*         capAdxl      = nullptr;
float*         capLis       = nullptr;
float*         capMpu       = nullptr;

float*         pendingAdxlSamples = nullptr;
float*         pendingLisSamples  = nullptr;
float*         pendingMpuSamples  = nullptr;

float*         webAdxlWaveform = nullptr;
float*         webMpuWaveform  = nullptr;
unsigned long* webWaveTimes    = nullptr;

// ----------------------------------------------------------------
//  Circular buffer indices
// ----------------------------------------------------------------
int bufIndex = 0, bufCount = 0;
int capIndex = 0, capCount = 0;
int webWaveIndex = 0, webWaveCount = 0;

// ----------------------------------------------------------------
//  Calibration baselines
// ----------------------------------------------------------------
float adxlBaseX, adxlBaseY, adxlBaseZ;
float  lisBaseX,  lisBaseY,  lisBaseZ;
// MPU6050 gyro bias — previously uncalibrated, so the gyro channel started
// with a constant offset that the drift filter had to chase, skewing its early
// STA/LTA. Measured at rest and subtracted, like the accel baselines.
float gyroBaseX, gyroBaseY, gyroBaseZ;
// Per-sensor rest-noise (RMS of the conditioned magnitude at rest), measured
// during calibration. Printed for troubleshooting (a near-zero value means a
// sensor is reading flat/stuck; wildly different values mean inconsistent
// sensitivity) and used to seed each sensor's adaptive STA/LTA baseline.
float adxlRestNoise = 0.0f, lisRestNoise = 0.0f, gyroRestNoise = 0.0f;

// ----------------------------------------------------------------
//  Signal conditioning state
// ----------------------------------------------------------------
float adxlRaw1 = 0, adxlRaw2 = 0, adxlRaw3 = 0;
float  lisRaw1 = 0,  lisRaw2 = 0,  lisRaw3 = 0;
float gyroRaw1 = 0, gyroRaw2 = 0, gyroRaw3 = 0;

float adxlFiltered = 0.0f, lisFiltered = 0.0f, gyroFiltered = 0.0f;
float adxlDrift    = 0.0f, lisDrift    = 0.0f, gyroDrift    = 0.0f;

// ----------------------------------------------------------------
//  Adaptive threshold state
// ----------------------------------------------------------------
float adxlRatioMean = 1.0f, adxlRatioVar = 0.25f;
float  lisRatioMean = 1.0f,  lisRatioVar = 0.25f;
float gyroRatioMean = 1.0f, gyroRatioVar = 0.25f;
unsigned long adaptSampleCount = 0;

// ----------------------------------------------------------------
//  P/S wave timing
// ----------------------------------------------------------------
unsigned long pWaveTime     = 0;
unsigned long sWaveTime     = 0;
bool          pWaveDetected = false;
bool          sWaveDetected = false;
// True once the signal has gone quiet after the P arrival — i.e. the P-S gap.
// A renewed strong arrival after this is the S wave (the classic P-gap-S shape
// the shaker produces), which lets distance populate even if the gyro channel
// alone never crosses the S threshold.
bool          gapAfterP    = false;

// ----------------------------------------------------------------
//  System state
// ----------------------------------------------------------------
char          eventClass[32]    = "Normal";
bool          quakeActive       = false;
// Consecutive samples of real (above-floor) vibration with an over-threshold
// STA/LTA — the debounce counter behind TRIGGER_HOLD_SAMPLES.
int           confirmRun        = 0;
unsigned long lastAlertTime     = 0;

// ----------------------------------------------------------------
//  Event log (web dashboard)
// ----------------------------------------------------------------
#define LOG_SIZE 10
char alertLog[LOG_SIZE][64];
int  alertIndex = 0;
int  alertCount = 0;

// ----------------------------------------------------------------
//  Live telemetry
// ----------------------------------------------------------------
float liveAdxlDelta  = 0.0f, liveLisDelta  = 0.0f, liveGyroDelta  = 0.0f;
float liveAdxlRatio  = 0.0f, liveLisRatio  = 0.0f, liveGyroRatio  = 0.0f;
float liveAdxlThresh = RATIO_THRESH;
float liveLisThresh  = RATIO_THRESH;
float liveGyroThresh = RATIO_THRESH;
bool  liveAdxlTrig   = false, liveLisTrig = false, liveGyroTrig = false;
float livePga        = 0.0f;
float liveMagnitude  = -1.0f;
float liveDistance   = -1.0f;
unsigned long liveSampleMs = 0;

// ----------------------------------------------------------------
//  Motor state
// ----------------------------------------------------------------
int      motorPwmLevel = 0;
uint32_t motorFreqHz   = MOTOR_FREQ_DEFAULT;

// ----------------------------------------------------------------
//  Shaker state machine
// ----------------------------------------------------------------
enum ShakerState {
  SHAKER_IDLE, SHAKER_PWAVE, SHAKER_SP_GAP,
  SHAKER_SWAVE, SHAKER_SURFACE, SHAKER_DECAY, SHAKER_DONE
};

ShakerState   shakerState      = SHAKER_IDLE;
unsigned long shakerStateStart = 0;
unsigned long lastMotorUpdate  = 0;
bool          shakerRunning    = false;
float         simulationProgress = 0.0f;

bool  pWaveHigh   = true;
int   pWavePulses = 0;
#define PWAVE_PULSE_MS      25
#define PWAVE_PEAK_PWM     220
#define PWAVE_TOTAL_PULSES  24

float sWaveAngle = 0.0f;
#define SWAVE_STEP       0.08f
#define SWAVE_PEAK_PWM  255
#define SWAVE_UPDATE_MS  15
#define SWAVE_DURATION  3000

float surfaceAngle = 0.0f;
float surfaceAmp   = 200.0f;
#define SURFACE_STEP      0.05f
#define SURFACE_UPDATE_MS  20
#define SURFACE_DURATION  4000

float decayAmp = 180.0f;

// ----------------------------------------------------------------
//  Upload throttles (Core 1 side — just timing guards)
// ----------------------------------------------------------------
// Back to the original 500 ms cadence (a 300 ms experiment added queue/Core-0
// pressure). Per-upload latency is already much lower thanks to the
// content-length-aware drain below, so 500 ms here is comfortably fast and
// matches the cadence the original firmware ran fine at.
#define LIVE_UPLOAD_INTERVAL_MS   500
#define EVENT_COOLDOWN_MS        5000

unsigned long lastLiveUpload       = 0;
unsigned long lastEventUpload      = 0;
bool          pendingEventUpload   = false;
bool          pendingWaveformUpload = false;

// ----------------------------------------------------------------
//  Cloud sync success tracking (updated by upload task on Core 0,
//  read by live JSON builder on Core 1 — written atomically as a
//  single uint32 so no mutex needed on Xtensa dual-core).
// ----------------------------------------------------------------
static volatile uint32_t supabase_attempt_count = 0;
static volatile uint32_t supabase_ok_count      = 0;

// ----------------------------------------------------------------
//  CPU load estimation (idle task runtime counter).
//  We snapshot the FreeRTOS idle-task runtime counter once per
//  live-upload cycle (~500 ms). The fraction of time NOT spent in
//  the idle task is the CPU load.
//  portGET_RUN_TIME_COUNTER_VALUE() is the ccount tick (240 MHz),
//  but we only use deltas so the unit cancels.
// ----------------------------------------------------------------
static int      cpuLoadPct     = 0;   // 0-100, updated every live cycle

// ----------------------------------------------------------------
//  Lightweight CPU-load estimator — no heap allocation.
//
//  WHY replace uxTaskGetSystemState():
//    The old implementation called pvPortMalloc(taskCount *
//    sizeof(TaskStatus_t)) on every live cycle (~500 ms), then
//    walked every task to find the two IDLE tasks.  On a busy heap
//    (WiFiClientSecure + HTTPClient leave very little slack) that
//    malloc can fail or, worse, trigger heap fragmentation.
//    uxTaskGetSystemState() itself also briefly suspends the
//    scheduler, adding latency on Core 1.
//
//  NEW APPROACH — monotonic idle-tick counter, zero alloc:
//    FreeRTOS exports xTaskGetIdleRunTimeCounter() (Core 1 idle,
//    the core running our loop) and the Espressif dual-core port
//    exposes ulTaskGetIdleRunTimeCounterForCore(0/1) for both cores.
//    We snapshot these once per call and use the delta between
//    calls to compute the idle fraction, then invert for load.
//    The microsecond timer (esp_timer_get_time) gives wall-clock
//    delta on the same timescale.
//
//  CONFIGURATION REQUIRED in sdkconfig / Arduino board config:
//    CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS=y   (usually already
//    on for ESP32 Arduino core — it's what makes the old approach
//    work too).  If not set, both idle counters read 0 and this
//    function safely returns 0% load every call.
// ----------------------------------------------------------------
static void __attribute__((optimize("Os"),noinline)) updateCpuLoad() {
  static uint32_t lastIdleUs  = 0;
  static uint32_t lastWallUs  = 0;

  // Wall-clock time since boot in µs (64-bit, no overflow concern here
  // as we take a uint32 snapshot — wraps every ~71 minutes, which is
  // fine: the delta is always small and unsigned subtraction handles wrap).
  uint32_t nowUs = (uint32_t)esp_timer_get_time();

  // Sum idle-task runtime counters for both cores.
  // ulTaskGetIdleRunTimeCounterForCore() is the ESP-IDF FreeRTOS extension
  // (note: ForCore, not Core — the compiler's "did you mean" suggestion
  // points at the single-core xTaskGetIdleRunTimeCounter which only covers
  // Core 1).  Available in ESP32 Arduino core 2.x and 3.x via esp_idf_version.
  // The unit is µs on the ESP32 port (portGET_RUN_TIME_COUNTER_VALUE uses
  // the ccount register scaled to µs by the Arduino core).
  uint32_t idleNow = (uint32_t)(ulTaskGetIdleRunTimeCounterForCore(0)
                               + ulTaskGetIdleRunTimeCounterForCore(1));

  uint32_t deltaWall = nowUs    - lastWallUs;
  uint32_t deltaIdle = idleNow  - lastIdleUs;
  lastWallUs  = nowUs;
  lastIdleUs  = idleNow;

  if (deltaWall > 0) {
    // Two cores → max possible idle = 2 × wall time.
    // idle_pct out of 200 gives a 0-100 busy fraction directly.
    int idle200 = (int)((uint64_t)deltaIdle * 200 / deltaWall);
    if (idle200 > 200) idle200 = 200;
    cpuLoadPct = 100 - (idle200 / 2);
    if (cpuLoadPct < 0)   cpuLoadPct = 0;
    if (cpuLoadPct > 100) cpuLoadPct = 100;
  }
}

// ----------------------------------------------------------------
//  Battery voltage read (ADC pin 34, 1:2 divider, 12-bit, 3.3 V ref)
//  Returns -1.0 if reading is too low (USB power / no battery).
// ----------------------------------------------------------------
static float __attribute__((optimize("Os"),noinline)) readBatteryVoltage() {
  // Average 8 samples to reduce ADC noise
  int32_t raw = 0;
  for (int i = 0; i < 8; i++) {
    raw += analogRead(BATT_ADC_PIN);
    delayMicroseconds(100);
  }
  raw /= 8;
  // 12-bit ADC → 3.3 V ref → ×2 for divider
  float v = (raw / 4095.0f) * 3.3f * 2.0f;
  // Below 0.1 V → almost certainly USB-powered with no battery
  return (v < 0.1f) ? -1.0f : v;
}

EventSnapshot pendingEvent;


// ================================================================
//  HELPERS
// ================================================================
int __attribute__((optimize("Os"),noinline)) jsonEscapeInto(char* dest, size_t destSize, const char* src) {
  size_t di = 0;
  for (size_t i = 0; src[i] && di + 2 < destSize; i++) {
    char c = src[i];
    if (c == '\\' || c == '"') {
      if (di + 3 >= destSize) break;
      dest[di++] = '\\';
      dest[di++] = c;
    } else if (c == '\n') {
      if (di + 3 >= destSize) break;
      dest[di++] = '\\'; dest[di++] = 'n';
    } else if (c == '\r') {
      if (di + 3 >= destSize) break;
      dest[di++] = '\\'; dest[di++] = 'r';
    } else {
      dest[di++] = c;
    }
  }
  dest[di] = '\0';
  return (int)di;
}

void __attribute__((optimize("Os"),noinline)) floatStr(char* buf, size_t sz, float v, int decimals) {
  if (isnan(v) || isinf(v)) { snprintf(buf, sz, "null"); return; }
  snprintf(buf, sz, "%.*f", decimals, (double)v);
}


// ================================================================
//  SIGNAL CONDITIONING
// ================================================================
float __attribute__((optimize("Os"),noinline)) medianOf3(float a, float b, float c) {
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
}

float __attribute__((optimize("Os"),noinline)) conditionSignal(float newRaw,
                      float &raw1, float &raw2, float &raw3,
                      float &filtered, float &drift,
                      float &outMed3, float &outFiltered) {
  raw3 = raw2; raw2 = raw1; raw1 = newRaw;
  float med   = medianOf3(raw1, raw2, raw3);
  outMed3     = med;
  filtered    = EMA_ALPHA * med + (1.0f - EMA_ALPHA) * filtered;
  outFiltered = filtered;
  drift      += (filtered - drift) * DRIFT_ALPHA;
  float cond  = filtered - drift;
  return (cond < 0.0f) ? 0.0f : cond;
}


// ================================================================
//  ADAPTIVE THRESHOLD
// ================================================================
void __attribute__((optimize("Os"),noinline)) updateAdaptiveStats(float ratio, float &mean, float &var) {
  float diff = ratio - mean;
  mean += ADAPT_ALPHA * diff;
  var  += ADAPT_ALPHA * (diff * diff - var);
}

float __attribute__((optimize("Os"),noinline)) getAdaptiveThreshold(float mean, float var) {
  if (adaptSampleCount < ADAPT_MIN_SAMPLES) return RATIO_THRESH;
  float thresh = mean + ADAPT_K * sqrtf(var);
  // Floor raised 1.5 -> 2.5 so the adaptive threshold can never drift down to
  // a level where background noise alone trips a trigger.
  return (thresh < 2.5f) ? 2.5f : thresh;
}


// ================================================================
//  FFT
// ================================================================
void __attribute__((optimize("Os"),noinline)) runFFTAnalysis() {
  for (int i = 0; i < FFT_SAMPLES; i++) fftImag[i] = 0.0f;
  FFT->windowing(FFTWindow::Hamming, FFTDirection::Forward);
  FFT->compute(FFTDirection::Forward);
  FFT->complexToMagnitude();
  float maxMag = 0.0f; int maxBin = 1;
  for (int i = 1; i < FFT_SAMPLES / 2; i++) {
    if (fftReal[i] > maxMag) { maxMag = fftReal[i]; maxBin = i; }
  }
  dominantFreqHz = (maxBin * FFT_SAMPLING_FREQ) / FFT_SAMPLES;
  if      (maxMag < 0.005f)                     strncpy(freqBand, "--",   sizeof(freqBand));
  else if (dominantFreqHz < FREQ_BAND_LOW_HZ)   strncpy(freqBand, "LOW",  sizeof(freqBand));
  else if (dominantFreqHz > FREQ_BAND_HIGH_HZ)  strncpy(freqBand, "HIGH", sizeof(freqBand));
  else                                           strncpy(freqBand, "MID",  sizeof(freqBand));
}


// ================================================================
//  STA/LTA
// ================================================================
float __attribute__((optimize("Os"),noinline)) computeSTALTA(float* history) {
  if (bufCount < LTA_LEN) return 0.0f;
  float sta = 0.0f, lta = 0.0f;
  for (int i = 0; i < STA_LEN; i++) {
    int idx = (bufIndex - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
    sta += history[idx] * history[idx];
  }
  for (int i = 0; i < LTA_LEN; i++) {
    int idx = (bufIndex - 1 - i + BUFFER_SIZE) % BUFFER_SIZE;
    lta += history[idx] * history[idx];
  }
  sta /= STA_LEN; lta /= LTA_LEN;
  return sta / (lta + 1e-10f);
}


// ================================================================
//  SEISMOLOGY HELPERS
// ================================================================
float __attribute__((optimize("Os"),noinline)) getPGA_cms2(float peakG) { return peakG * 980.665f; }

// Full estimate when both PGA and a P-S derived distance are available.
// Falls back to a PGA-only rough estimate when distance is unknown
// (distance requires both a P-wave AND an S-wave to have been detected,
// which is uncommon for short local shakes -- previously this meant
// most confirmed events shipped magnitude = -1, which is what the
// dashboard and agent were reporting as "missing".
//
// The fallback is intentionally coarse (PGA-only, no distance/attenuation
// term) and is just meant to give a non-blank, order-of-magnitude number
// for a demo station rather than a calibrated value.
float __attribute__((optimize("Os"),noinline)) estimateMagnitude(float pga_cms2, float dist_km) {
  if (pga_cms2 <= 0.0f) return -1.0f;
  if (dist_km > 0.0f) {
    return log10f(pga_cms2) + log10f(dist_km) + 0.0029f * dist_km - 0.67f;
  }
  // PGA-only fallback: same log10(PGA) term, with a fixed offset tuned
  // so typical shaker-table PGA values land in a plausible Mw range.
  return log10f(pga_cms2) + 0.9f;
}

// ----------------------------------------------------------------
//  Epicentral distance from the S-minus-P arrival time (single station).
//
//  A single station can't triangulate, so the S-P lag is the only physical
//  distance cue. With crustal velocities Vp, Vs the epicentral distance is:
//      distance = (S-P seconds) x (Vp*Vs)/(Vp-Vs)
//  With Vp=6.0, Vs=3.5 km/s that's ~8.4 km per second of S-P lag (the classic
//  "multiply S-P seconds by ~8" rule). Requires BOTH a P and an S arrival;
//  returns -1 (unknown) otherwise so the dashboard shows "—" instead of a
//  fabricated value. Guards the unsigned-time subtraction and clamps absurd
//  results.
// ----------------------------------------------------------------
#define VP_KM_PER_S      6.0f
#define VS_KM_PER_S      3.5f
#define MAX_DISTANCE_KM  2000.0f

float __attribute__((optimize("Os"),noinline)) estimateDistance() {
  if (!pWaveDetected || !sWaveDetected) return -1.0f;
  if (sWaveTime <= pWaveTime) return -1.0f;            // guard unsigned underflow
  float dt = (sWaveTime - pWaveTime) / 1000.0f;        // S-P time, seconds
  float dist = dt * (VP_KM_PER_S * VS_KM_PER_S) / (VP_KM_PER_S - VS_KM_PER_S);
  if (dist <= 0.0f) return -1.0f;
  if (dist > MAX_DISTANCE_KM) dist = MAX_DISTANCE_KM;  // clamp implausible values
  return dist;
}

void __attribute__((optimize("Os"),noinline)) classifyEvent(bool adxlT, bool lisT, bool gyroT, char* out, size_t sz) {
  if ( adxlT &&  lisT &&  gyroT) strncpy(out, "Confirmed Seismic Event", sz);
  else if ( adxlT &&  lisT && !gyroT) strncpy(out, "Strong Local Event",      sz);
  else if (!adxlT &&  lisT &&  gyroT) strncpy(out, "Distant Seismic Event",   sz);
  else if (!adxlT && !lisT &&  gyroT) strncpy(out, "S-Wave Only Event",        sz);
  else if ( adxlT && !lisT && !gyroT) strncpy(out, "Local Vibration",          sz);
  else if (!adxlT &&  lisT && !gyroT) strncpy(out, "Weak Event",               sz);
  else                                 strncpy(out, "Normal",                   sz);
  out[sz - 1] = '\0';
}

float __attribute__((optimize("Os"),noinline)) classConfidence(const char* cls) {
  if (strcmp(cls, "Confirmed Seismic Event") == 0) return 0.95f;
  if (strcmp(cls, "Strong Local Event")      == 0) return 0.80f;
  if (strcmp(cls, "Distant Seismic Event")   == 0) return 0.70f;
  if (strcmp(cls, "S-Wave Only Event")       == 0) return 0.60f;
  if (strcmp(cls, "Local Vibration")         == 0) return 0.50f;
  if (strcmp(cls, "Weak Event")              == 0) return 0.40f;
  return 0.10f;
}

const char* __attribute__((optimize("Os"),noinline)) shakerStateName() {
  switch (shakerState) {
    case SHAKER_IDLE:    return "Idle";
    case SHAKER_PWAVE:   return "P-Wave";
    case SHAKER_SP_GAP:  return "Gap";
    case SHAKER_SWAVE:   return "S-Wave";
    case SHAKER_SURFACE: return "Surface Wave";
    case SHAKER_DECAY:   return "Decay";
    case SHAKER_DONE:    return "Idle";
  }
  return "Idle";
}


// ================================================================
//  MOTOR CONTROL
// ================================================================
void __attribute__((optimize("Os"),noinline)) applyMotorPwm(int pwm) {
  pwm = constrain(pwm, 0, 255);
  motorPwmLevel = pwm;
  if (pwm == 0) {
    ledcWrite(MOTOR_ENA, 0);
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
  } else {
    digitalWrite(MOTOR_IN1, HIGH);
    digitalWrite(MOTOR_IN2, LOW);
    ledcWrite(MOTOR_ENA, pwm);
  }
}

void __attribute__((optimize("Os"),noinline)) motorStop() { applyMotorPwm(0); }


// ================================================================
//  ALERT OUTPUTS — LED + buzzer driven by the live trace
//
//  Called every sample from loop(). Unifies the visual (LED) and audible
//  (buzzer) alerts with the merged STA/LTA trigger that feeds the dashboard
//  helicorder, so all three react together:
//    • LED  — lit the instant ANY axis crosses its adaptive threshold, dark
//             the moment the trace falls back below it. No cooldown, so it
//             mirrors the live trace exactly.
//    • Buzzer — beeps on a re-arm cooldown (so it doesn't drone during a
//             sustained event), with pitch scaled by how far the strongest
//             axis is over threshold — i.e. by the same severity the trace
//             height shows. Bigger trace spike → higher beep.
// ================================================================
#define BUZZER_REARM_MS  1200

void __attribute__((optimize("Os"),noinline)) updateAlertOutputs(
    bool confirmed,
    float adxlR, float lisR, float gyroR,
    float adxlThresh, float lisThresh, float gyroThresh) {

  // LED + buzzer fire ONLY on a confirmed real vibration (above the amplitude
  // floor and sustained) — never on air, handling noise or a single blip.
  // `confirmed` is the same gate the trace trigger and classifier use, so the
  // three stay coupled while staying honest about what's real.
  digitalWrite(LED_PIN, confirmed ? HIGH : LOW);

  if (!confirmed) return;

  // Audible beep, gated so it pulses rather than drones.
  if (millis() - lastAlertTime > BUZZER_REARM_MS) {
    lastAlertTime = millis();
    // "Over-threshold" ratio of the strongest axis (≥1.0 when triggered).
    float over = adxlR / (adxlThresh + 1e-6f);
    float lOver = lisR  / (lisThresh  + 1e-6f);
    float gOver = gyroR / (gyroThresh + 1e-6f);
    if (lOver > over) over = lOver;
    if (gOver > over) over = gOver;
    over = constrain(over, 1.0f, 4.0f);
    // Map 1.0–4.0× over threshold → 800–2000 Hz beep.
    int freq = 800 + (int)((over - 1.0f) * 400.0f);
    tone(BUZZER_PIN, freq, 150);
  }
}


// ================================================================
//  SHAKER STATE MACHINE
// ================================================================
void __attribute__((optimize("Os"),noinline)) startShaker() {
  if (shakerRunning) return;
  shakerRunning      = true;
  shakerState        = SHAKER_PWAVE;
  shakerStateStart   = millis();
  lastMotorUpdate    = millis();
  pWaveHigh          = true;
  pWavePulses        = 0;
  sWaveAngle         = 0.0f;
  surfaceAngle       = 0.0f;
  surfaceAmp         = 200.0f;
  decayAmp           = 180.0f;
  simulationProgress = 0.0f;
  Serial.println(F("=== SHAKER START: P-WAVE ==="));
  BT.println(F("Shaker started: P-Wave"));
}

void __attribute__((optimize("Os"),noinline)) tickPWave() {
  simulationProgress = (float)pWavePulses / PWAVE_TOTAL_PULSES * 0.25f;
  if (millis() - lastMotorUpdate < PWAVE_PULSE_MS) return;
  lastMotorUpdate = millis();
  applyMotorPwm(pWaveHigh ? PWAVE_PEAK_PWM : 0);
  if (!pWaveHigh) pWavePulses++;
  pWaveHigh = !pWaveHigh;
  if (pWavePulses >= PWAVE_TOTAL_PULSES) {
    motorStop();
    shakerState      = SHAKER_SP_GAP;
    shakerStateStart = millis();
    Serial.println(F("P-WAVE -> SP GAP"));
    BT.println(F("Phase: P/S Gap"));
  }
}

void __attribute__((optimize("Os"),noinline)) tickSWave() {
  unsigned long elapsed = millis() - shakerStateStart;
  simulationProgress = 0.25f + (float)elapsed / SWAVE_DURATION * 0.35f;
  if (millis() - lastMotorUpdate < SWAVE_UPDATE_MS) return;
  lastMotorUpdate = millis();
  float sinVal = (sinf(sWaveAngle) + 1.0f) / 2.0f;
  applyMotorPwm((int)(sinVal * SWAVE_PEAK_PWM));
  sWaveAngle += SWAVE_STEP;
  if (elapsed >= SWAVE_DURATION) {
    shakerState      = SHAKER_SURFACE;
    shakerStateStart = millis();
    surfaceAngle     = sWaveAngle;
    Serial.println(F("S-WAVE -> SURFACE"));
    BT.println(F("Phase: Surface Wave"));
  }
}

void __attribute__((optimize("Os"),noinline)) tickSurface() {
  unsigned long elapsed = millis() - shakerStateStart;
  simulationProgress = 0.60f + (float)elapsed / SURFACE_DURATION * 0.25f;
  if (millis() - lastMotorUpdate < SURFACE_UPDATE_MS) return;
  lastMotorUpdate = millis();
  float sinVal = (sinf(surfaceAngle) + 1.0f) / 2.0f;
  applyMotorPwm((int)(sinVal * surfaceAmp));
  surfaceAngle += SURFACE_STEP;
  surfaceAmp   -= 0.4f;
  if (surfaceAmp < 0.0f) surfaceAmp = 0.0f;
  if (elapsed >= SURFACE_DURATION) {
    shakerState      = SHAKER_DECAY;
    shakerStateStart = millis();
    decayAmp         = surfaceAmp;
    Serial.println(F("SURFACE -> DECAY"));
    BT.println(F("Phase: Decay"));
  }
}

void __attribute__((optimize("Os"),noinline)) tickDecay() {
  unsigned long elapsed = millis() - shakerStateStart;
  simulationProgress = 0.85f + (float)elapsed / 2000.0f * 0.15f;
  if (millis() - lastMotorUpdate < 20) return;
  lastMotorUpdate = millis();
  decayAmp -= 1.5f;
  if (decayAmp < 0.0f) decayAmp = 0.0f;
  float sinVal = (sinf(surfaceAngle) + 1.0f) / 2.0f;
  applyMotorPwm((int)(sinVal * decayAmp));
  surfaceAngle += SURFACE_STEP * 0.7f;
  if (decayAmp <= 0.0f) {
    motorStop();
    shakerRunning      = false;
    shakerState        = SHAKER_DONE;
    simulationProgress = 1.0f;
    Serial.println(F("DECAY -> IDLE"));
    BT.println(F("Shaker done. Motor stopped."));
  }
}

void __attribute__((optimize("Os"),noinline)) updateShaker() {
  switch (shakerState) {
    case SHAKER_IDLE: break;
    case SHAKER_DONE: break;
    case SHAKER_PWAVE:   tickPWave();   break;
    case SHAKER_SWAVE:   tickSWave();   break;
    case SHAKER_SURFACE: tickSurface(); break;
    case SHAKER_DECAY:   tickDecay();   break;
    case SHAKER_SP_GAP:
      motorStop();
      simulationProgress = 0.25f;
      if (millis() - shakerStateStart >= 3000) {
        shakerState      = SHAKER_SWAVE;
        shakerStateStart = millis();
        sWaveAngle       = 0.0f;
        Serial.println(F("SP GAP -> S-WAVE"));
        BT.println(F("Phase: S-Wave"));
      }
      break;
  }
}


// ================================================================
//  BLUETOOTH SERIAL COMMAND PARSER
// ================================================================
String btBuffer = "";

void __attribute__((optimize("Os"),noinline)) parseBTCommand(const String& cmd) {
  String c = cmd;
  c.trim();
  if (c.length() == 0) return;

  if (c == "?" || c == "help") {
    BT.println(F("--- TremorLab Motor Commands ---"));
    BT.println(F("s         Start full shaker sequence"));
    BT.println(F("0         Motor stop"));
    BT.println(F("1-9       Speed preset (1=28 .. 9=255 PWM)"));
    BT.println(F("p<0-255>  Exact PWM e.g. p180"));
    BT.println(F("f<Hz>     Motor PWM freq e.g. f3000"));
    BT.println(F("?         This help"));
    return;
  }

  if (c == "s" || c == "S") {
    if (shakerRunning) BT.println(F("Already running."));
    else               startShaker();
    return;
  }

  if (c == "0") {
    if (shakerRunning) {
      motorStop();
      shakerRunning = false;
      shakerState   = SHAKER_IDLE;
      BT.println(F("Shaker aborted. Motor stopped."));
    } else {
      motorStop();
      BT.println(F("Motor stopped."));
    }
    return;
  }

  if (c.length() == 1 && c[0] >= '1' && c[0] <= '9') {
    if (shakerRunning) { BT.println(F("Shaker running — stop it first (send 0).")); return; }
    int pwm = map(c[0] - '0', 1, 9, 28, 255);
    applyMotorPwm(pwm);
    BT.print("PWM set to "); BT.println(pwm);
    return;
  }

  if ((c[0] == 'p' || c[0] == 'P') && c.length() > 1) {
    if (shakerRunning) { BT.println(F("Shaker running — stop it first (send 0).")); return; }
    applyMotorPwm(c.substring(1).toInt());
    BT.print("PWM set to "); BT.println(motorPwmLevel);
    return;
  }

  if ((c[0] == 'f' || c[0] == 'F') && c.length() > 1) {
    uint32_t freq = (uint32_t)c.substring(1).toInt();
    if (freq < 100 || freq > 20000) { BT.println(F("Freq must be 100–20000 Hz.")); return; }
    motorFreqHz = freq;
    ledcAttach(MOTOR_ENA, motorFreqHz, MOTOR_RES);
    applyMotorPwm(motorPwmLevel);
    BT.print("Motor freq set to "); BT.print(motorFreqHz); BT.println(" Hz");
    return;
  }

  BT.print("Unknown command '"); BT.print(c); BT.println("'. Send ? for help.");
}

void __attribute__((optimize("Os"),noinline)) checkBluetooth() {
  while (BT.available()) {
    char ch = (char)BT.read();
    if (ch == '\n' || ch == '\r') {
      if (btBuffer.length() > 0) { parseBTCommand(btBuffer); btBuffer = ""; }
    } else {
      btBuffer += ch;
      if (btBuffer.length() > 32) btBuffer = "";
    }
  }
}


// ================================================================
//  OSCILLOSCOPE OUTPUT
// ================================================================
static unsigned long oscLineCount = 0;

// ----------------------------------------------------------------
//  Single snprintf → one Serial.print call.
//
//  WHY: the original issued ~20 separate Serial.print() calls per
//  sample (once every 10 ms at 100 Hz). Each call acquires the UART
//  TX mutex, formats a float independently, and hands off to the
//  hardware FIFO. The accumulated overhead was measurable on Core 1.
//  Collapsing everything into one snprintf + one Serial.print:
//    • Acquires the mutex once per line instead of ~20×.
//    • Lets the compiler reuse float-formatting register state.
//    • Reduces code footprint (Os + noinline keep it out of IRAM).
//  Stack cost: 192 bytes (the line buffer) — well within the 8 KB
//  Arduino loop stack.
// ----------------------------------------------------------------
static void __attribute__((optimize("Os"),noinline)) printOscilloscope(
    float adxl_raw,  float adxl_med,  float adxl_filt, float adxl_cond,
    float lis_raw,   float lis_med,   float lis_filt,  float lis_cond,
    float gyro_raw,  float gyro_med,  float gyro_filt, float gyro_cond,
    float adxl_stalta, float lis_stalta, float gyro_stalta,
    bool  pwave, bool swave, const char* cls)
{
  if (oscLineCount % 200 == 0) {
    Serial.println(
      F("adxl_raw,adxl_med3,adxl_filt,adxl_cond,"
        "lis_raw,lis_med3,lis_filt,lis_cond,"
        "gyro_raw,gyro_med3,gyro_filt,gyro_cond,"
        "adxl_stalta,lis_stalta,gyro_stalta,"
        "pwave,swave,class"));
  }
  oscLineCount++;

  // Max line length: 15 floats × ~9 chars + 2 bools + class (28) + commas/\n ≈ 185 bytes
  char line[192];
  snprintf(line, sizeof(line),
    "%.4f,%.4f,%.4f,%.4f,"
    "%.4f,%.4f,%.4f,%.4f,"
    "%.3f,%.3f,%.3f,%.3f,"
    "%.3f,%.3f,%.3f,"
    "%d,%d,%s\n",
    (double)adxl_raw,  (double)adxl_med,  (double)adxl_filt, (double)adxl_cond,
    (double)lis_raw,   (double)lis_med,   (double)lis_filt,  (double)lis_cond,
    (double)gyro_raw,  (double)gyro_med,  (double)gyro_filt, (double)gyro_cond,
    (double)adxl_stalta, (double)lis_stalta, (double)gyro_stalta,
    pwave ? 1 : 0, swave ? 1 : 0, cls);
  Serial.print(line);
}


// ----------------------------------------------------------------
//  SEISMIC WAVEFORM (Arduino Serial PLOTTER) — replaces oscilloscope CSV
//
//  Open Tools → Serial Plotter (NOT Serial Monitor). You get five named,
//  properly-integrated traces on ONE comparable scale:
//    ADXL / LIS / MPU — each sensor's offset-free signal NORMALISED by its own
//      calibration rest-noise, so the three plot together meaningfully (units =
//      multiples of that sensor's quiet noise) instead of one channel (different
//      raw units/scale) flattening the others.
//    Pwave / Swave — step markers that jump to fixed visible levels (20 / 30)
//      the instant a P or S arrival is detected, so the wave picks stay on the
//      oscilloscope alongside the signals.
//  Values are pre-normalised by the caller (it has the per-sensor rest-noise),
//  so this just formats them.
//
//  (Keep the Serial Monitor closed while plotting — they can't both read the
//  port at once.)
// ----------------------------------------------------------------
static void __attribute__((optimize("Os"),noinline)) printSeismicWaveform(
    float adxlN, float lisN, float gyroN, bool pwave, bool swave) {
  Serial.printf("ADXL:%.2f,LIS:%.2f,MPU:%.2f,Pwave:%.0f,Swave:%.0f\n",
                (double)adxlN, (double)lisN, (double)gyroN,
                pwave ? 20.0 : 0.0, swave ? 30.0 : 0.0);
}


// ================================================================
//  SUPABASE RAW HTTP — runs ONLY on Core 0 upload task
//  No BT suspend/resume. No blocking of Core 1.
// ================================================================
// ----------------------------------------------------------------
// Persistent TLS client for Supabase uploads.
//
// WHY: the previous version constructed a brand-new WiFiClientSecure
// (and therefore paid a full TLS handshake — typically 300ms-1.5s on
// an ESP32) on EVERY upload call. With live frames generated every
// 500ms on Core 1 and a queue depth of only 2, the handshake cost
// alone was enough for the uploader to fall behind the producer,
// causing frames to be silently dropped (see enqueueLive()) well
// before any actual network congestion. That is the main reason the
// database was updating much slower than the sensors were producing
// data.
//
// FIX: keep ONE WiFiClientSecure alive for the lifetime of the
// uploadTask (Core 0 only — this object must never be touched from
// Core 1). HTTPClient + Supabase's REST endpoint both support
// HTTP keep-alive, so reusing the same TLS session lets repeated
// requests skip the handshake entirely as long as the connection
// stays up. http.begin()/http.end() per call still works correctly
// with a shared client — only the underlying socket is reused, not
// torn down and rebuilt.
//
// IMPORTANT — ESP32 Arduino core 3.x caveat:
// WiFiClientSecure + HTTPClient::setReuse(true) has a long, documented
// history of flaky behaviour across arduino-esp32 core versions
// (including several 3.x releases) where the FIRST request on a reused
// connection succeeds but the SECOND one fails, times out, or in some
// reports hangs — see espressif/arduino-esp32 issues #6165, #6561,
// #10071 for examples of exactly this symptom. Relying on keep-alive
// alone would trade "always slow" for "fast until it silently breaks",
// which is worse for an unattended station.
//
// So this is layered, not just a bare setReuse(true):
//   1. Try the request on the persistent, reused connection (fast path).
//   2. If it fails for any reason, force-close the connection and retry
//      ONCE on a brand-new TLS handshake (slow path, but correct).
//   3. Only report failure if both attempts fail.
// In the failure case this costs exactly one extra handshake (the same
// cost the original code paid on every single call) — it never costs
// more than the old behaviour, and the common case stays fast.
// ----------------------------------------------------------------
static WiFiClientSecure supabaseClient;
static bool             supabaseClientReady = false;

static void __attribute__((optimize("Os"),noinline)) ensureSupabaseClient() {
  if (supabaseClientReady) return;
  supabaseClient.setInsecure();   // skip cert verification (matches rev5 behaviour)
  // FIX: setTimeout() unit is MILLISECONDS on WiFiClientSecure.
  // The old value of 10 = 10 ms — far too short for a TLS round-trip to
  // Supabase (typically 80-400 ms). Every response was timing out, forcing
  // the retry path (a full extra TLS handshake) on every single call.
  // Changed to 15000 ms to match the HTTPClient timeout below.
  supabaseClient.setTimeout(15000);
  supabaseClientReady = true;
}

static void __attribute__((optimize("Os"),noinline)) resetSupabaseClient() {
  supabaseClient.stop();
  supabaseClientReady = false;
}

// ----------------------------------------------------------------
// Persistent HTTPClient — lives for the lifetime of the upload task.
// Keeping it static avoids re-initialising headers and timeouts on
// every call.  It must ONLY be used from Core 0 (uploadTask).
//
// FIX: the old code heap-allocated HTTPClient inside supabaseAttempt()
// on every call. The HTTPClient destructor calls end() which on
// several arduino-esp32 3.x releases calls client.stop() regardless
// of setReuse(true), closing the TLS session we just paid to open.
// Making it static eliminates the construction/destruction cycle and
// ensures the keep-alive actually keeps alive.
// ----------------------------------------------------------------
static HTTPClient supabaseHttp;
static bool       supabaseHttpReady = false;

// Single attempt. Returns HTTPClient response code.
// FIX: after reading the status code, drain the response body.
//   Unread body bytes block the TCP receive window, preventing the
//   server from sending the next response on the reused connection.
//   Supabase with "return=minimal" sends an empty body, but the HTTP
//   framing still has a Content-Length or chunk trailer that must be
//   consumed for keep-alive to work.  Without this drain, the second
//   request on a reused connection always hangs until timeout.
static int __attribute__((optimize("Os"),noinline)) supabaseAttempt(const char* method,
                           const char* url,
                           const char* body,
                           bool        upsert) {
  if (!supabaseHttpReady) {
    supabaseHttp.setTimeout(15000);
    supabaseHttp.setReuse(true);
    supabaseHttpReady = true;
  }

  int code = -1;
  if (supabaseHttp.begin(supabaseClient, url)) {
    // CRITICAL FIX — duplicate header accumulation:
    //
    // HTTPClient::addHeader() APPENDS a new header entry every call.
    // It does NOT check for or replace an existing header with the same
    // name. With a static HTTPClient, calling addHeader("Prefer", ...) on
    // every request means after N requests there are N "Prefer:" lines in
    // the outgoing HTTP headers. PostgREST rejects requests with duplicate
    // Prefer headers (RFC 7240 says they MAY be combined, but PostgREST
    // in practice returns HTTP 400 or silently ignores resolution=merge-
    // duplicates when it sees conflicting directives).
    //
    // Fix: call supabaseHttp.begin() which resets the internal header list
    // on arduino-esp32 3.x (confirmed in HTTPClient.cpp: begin() calls
    // _headers.clear()). Then add all headers fresh each time.
    // This is already done above by the begin() call — begin() on a reused
    // client clears custom headers. So addHeader() here is always called
    // on a clean slate.
    //
    // Verification: HTTPClient.cpp line ~260 (arduino-esp32 3.x):
    //   bool HTTPClient::begin(WiFiClient& client, const String& url) {
    //     clear();   // <-- clears _headers
    //     ...
    //   }
    // So begin() → addHeader() pattern is always header-safe.
    supabaseHttp.addHeader("Content-Type",  "application/json");
    supabaseHttp.addHeader("apikey",         SUPABASE_ANON_KEY);
    supabaseHttp.addHeader("Authorization", "Bearer " SUPABASE_ANON_KEY);
    supabaseHttp.addHeader("Connection",     "keep-alive");
    supabaseHttp.addHeader("Prefer",
                   upsert
                     ? "resolution=merge-duplicates,return=minimal"
                     : "return=minimal");

    if (strcmp(method, "PATCH") == 0)
      code = supabaseHttp.sendRequest("PATCH", (uint8_t*)body, strlen(body));
    else
      code = supabaseHttp.POST((uint8_t*)body, strlen(body));

    // Drain the response body so the TCP receive window stays open for the
    // next keep-alive request — but only as much as actually needs draining.
    //
    // SPEED FIX: the previous version spun in a 100 ms wait loop on EVERY
    // request. With "Prefer: return=minimal", PostgREST replies with
    // Content-Length: 0, so available() is 0 and the loop burned the full
    // 100 ms doing nothing — adding ~100 ms of pure latency to every single
    // upload (live, event AND waveform). Now we read the known Content-Length:
    // if it's 0 (the normal case) we skip draining entirely; if there is a
    // body we read exactly that many bytes with a short bounded wait. This is
    // the single biggest win for upload throughput on the keep-alive path.
    if (code >= 200 && code < 300) {
      // Success: drain the (usually empty, return=minimal) body so the
      // keep-alive connection stays clean. Content-Length 0 => nothing to read.
      int contentLen = supabaseHttp.getSize();
      if (contentLen != 0) {
        WiFiClient* stream = supabaseHttp.getStreamPtr();
        if (stream) {
          int remaining = contentLen;
          unsigned long drainStart = millis();
          while (millis() - drainStart < 40) {
            int avail = stream->available();
            if (avail > 0) {
              while (avail-- > 0) {
                stream->read();
                if (remaining > 0 && --remaining == 0) break;
              }
              if (remaining == 0) break;
            } else {
              vTaskDelay(pdMS_TO_TICKS(2));
            }
          }
        }
      }
    } else if (code > 0) {
      // HTTP-level error (4xx/5xx): PostgREST returns a JSON error body that
      // pinpoints the cause — schema mismatch ("column ... does not exist"),
      // bad/absent API key ("No API key found" / JWT error), RLS policy denial,
      // wrong table, etc. PRINT it so the failure is actually diagnosable
      // instead of just a bare status code. This is usually what reveals why
      // uploads "don't work" once the network and heap are fine.
      String err = supabaseHttp.getString();
      Serial.printf("[UP] HTTP %d body: %s\n", code,
                    err.length() ? err.substring(0, 220).c_str() : "(empty)");
    }

    supabaseHttp.end();
  } else {
    Serial.println(F("[UP] http.begin() failed"));
  }
  return code;
}

static bool __attribute__((optimize("Os"),noinline)) supabaseRequest(const char* method,
                            const char* path,
                            const char* body,
                            bool        upsert) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[UP] Skip: WiFi not connected"));
    return false;
  }
  if (ESP.getFreeHeap() < HEAP_GUARD) {
    Serial.printf("[UP] Skip: heap %u < guard %u\n",
                  ESP.getFreeHeap(), (unsigned)HEAP_GUARD);
    return false;
  }

  // TLS-fit diagnostic. A TLS handshake needs a contiguous ~16 KB record
  // buffer (mbedTLS IN/OUT content length). With WiFi + Classic BT resident,
  // total free heap can read ~30 KB while the LARGEST contiguous block is well
  // under 16 KB due to fragmentation — in which case the handshake fails with
  // code -1 ("TLS/TCP connect failed") and NOTHING uploads even though "free
  // heap" looks OK. Log both on the first few requests and warn if the biggest
  // block is too small to hold a TLS buffer.
  static uint32_t reqCount = 0;
  uint32_t freeH = ESP.getFreeHeap();
  uint32_t maxBlk = ESP.getMaxAllocHeap();
  if (reqCount++ < 5) {
    Serial.printf("[UP] pre-request heap: free=%u, largest_block=%u\n", freeH, maxBlk);
    if (maxBlk < 17000)
      Serial.println(F("  ! largest block < 17 KB — a TLS handshake likely can't fit "
                       "(fragmentation). This is why uploads fail despite free heap."));
  }

  // FIX: url buffer was declared as a local (stack) inside the old
  // supabaseAttempt, then passed by pointer to http.begin() which held
  // a reference to it for the duration of the request. If the compiler
  // reused that stack frame (unlikely but possible with -Os), the URL
  // would be silently corrupted. Made static here to be safe.
  static char url[192];
  snprintf(url, sizeof(url), "%s%s", SUPABASE_URL, path);

  // Attempt 1: fast path, on the reused/persistent connection.
  ensureSupabaseClient();
  int code = supabaseAttempt(method, url, body, upsert);
  bool ok = (code >= 200 && code < 300);

  if (!ok) {
    Serial.printf("[UP] Supabase error %d on %s (attempt 1, reused conn)\n", code, path);
    if (code == -1)  Serial.println(F("  -> TLS/TCP connect failed"));
    if (code == -11) Serial.println(F("  -> Response timeout"));
    if (code == -4)  Serial.println(F("  -> Socket not connected"));

    // Attempt 2: force a brand-new TLS handshake and retry once.
    // Reset both the TLS client and the HTTPClient state together.
    supabaseHttpReady = false;
    resetSupabaseClient();
    ensureSupabaseClient();
    code = supabaseAttempt(method, url, body, upsert);
    ok = (code >= 200 && code < 300);

    if (!ok) {
      Serial.printf("[UP] Supabase error %d on %s (attempt 2, fresh conn)\n", code, path);
      if (code == -1)  Serial.println(F("  -> TLS/TCP connect failed"));
      if (code == -11) Serial.println(F("  -> Response timeout"));
      if (code == -4)  Serial.println(F("  -> Socket not connected"));
      supabaseHttpReady = false;
      resetSupabaseClient();
    }
  }

  // Update rolling cloud-sync success counters (atomic on 32-bit Xtensa)
  supabase_attempt_count++;
  if (ok) {
    supabase_ok_count++;
    Serial.printf("[UP] OK %d %s\n", code, path);
  }

  return ok;
}

// ----------------------------------------------------------------
//  Supabase self-test — runs ONCE at boot (Core 1, before the upload task
//  exists, so no Core-0 contention). It does a tiny GET against station_live
//  and prints the exact result, so "uploads don't work" stops being a mystery:
//  it tells you immediately whether the URL/key/table/RLS are right or not.
// ----------------------------------------------------------------
static void __attribute__((optimize("Os"),noinline)) supabaseSelfTest() {
  // Catch the most common mistake first: credentials never filled in.
  if (strstr(SUPABASE_URL, "YOUR_PROJECT_ID") ||
      strstr(SUPABASE_ANON_KEY, "YOUR_SUPABASE")) {
    Serial.println(F("[UP] *** SUPABASE_URL / SUPABASE_ANON_KEY are still the "
                     "placeholder values — fill them in. No uploads are possible until you do. ***"));
    return;
  }
  if (WiFi.status() != WL_CONNECTED) return;

  static char url[224];
  snprintf(url, sizeof(url),
           "%s/rest/v1/station_live?select=station_id&limit=1", SUPABASE_URL);

  ensureSupabaseClient();
  if (supabaseHttp.begin(supabaseClient, url)) {
    supabaseHttp.addHeader("apikey",         SUPABASE_ANON_KEY);
    supabaseHttp.addHeader("Authorization", "Bearer " SUPABASE_ANON_KEY);
    int code = supabaseHttp.GET();
    String body = supabaseHttp.getString();
    Serial.printf("[UP] Self-test GET station_live -> HTTP %d : %s\n",
                  code, body.length() ? body.substring(0, 200).c_str() : "(empty)");
    if (code == 200)
      Serial.println(F("[UP] Supabase reachable, key accepted, table exists — uploads should work."));
    else if (code == 401 || code == 403)
      Serial.println(F("[UP]  -> 401/403: anon key wrong/missing, or RLS blocks anon access."));
    else if (code == 404)
      Serial.println(F("[UP]  -> 404: URL or table name wrong (did you run supabase_schema.sql?)."));
    else if (code <= 0)
      Serial.println(F("[UP]  -> connect/TLS failed (DNS, certificate, or not enough heap)."));
    supabaseHttp.end();
  } else {
    Serial.println(F("[UP] Self-test: http.begin() failed (URL malformed or TLS init failed)."));
  }

  // Leave a clean slate for the Core-0 upload task to (re)initialise.
  supabaseHttpReady = false;
  resetSupabaseClient();
}


// ================================================================
//  BUILD LIVE JSON — called on Core 1, result queued to Core 0
// ================================================================
static void __attribute__((optimize("Os"),noinline)) buildLiveJson(char* out, size_t outSize) {
  static char esc[36];
  jsonEscapeInto(esc, sizeof(esc), eventClass);

  // ── Cloud sync success percent ────────────────────────────────
  uint32_t attempts = supabase_attempt_count;
  uint32_t oks      = supabase_ok_count;
  int cloudPct = (attempts > 0)
                 ? (int)((uint64_t)oks * 100 / attempts)
                 : -1;   // -1 = not yet attempted (boot)
  // Cap to [0,100] in case of counter race (negligible on Xtensa)
  if (cloudPct > 100) cloudPct = 100;
  if (cloudPct < 0 && attempts > 0) cloudPct = 0;

  // ── Battery voltage ───────────────────────────────────────────
  float battV = readBatteryVoltage();   // -1.0 if USB-only

  // ── Per-sensor continuous scores (ratio / threshold, clamped 0-1).
  // These replace boolean triggered flags for the Sensor Agreement
  // metric. A ratio below threshold → score < 1.0 (healthy quiet).
  // A ratio above threshold → score = 1.0 (event detected).
  // In normal quiet operation all three hover just below 1.0
  // (ratio ≈ 0.9×threshold) → agreement ≈ 90-100%.
  float adxlScore = (liveAdxlThresh > 0.0f)
                    ? (liveAdxlRatio / liveAdxlThresh) : 0.0f;
  float lisScore  = (liveLisThresh  > 0.0f)
                    ? (liveLisRatio  / liveLisThresh)  : 0.0f;
  float gyroScore = (liveGyroThresh > 0.0f)
                    ? (liveGyroRatio / liveGyroThresh) : 0.0f;
  if (adxlScore > 1.0f) adxlScore = 1.0f;
  if (lisScore  > 1.0f) lisScore  = 1.0f;
  if (gyroScore > 1.0f) gyroScore = 1.0f;

  snprintf(out, outSize,
    "{"
    "\"station_id\":\"%s\","
    "\"timestamp_ms\":%lu,"
    "\"classification\":\"%s\","
    "\"pga_cm_s2\":%.2f,"
    "\"magnitude\":%.2f,"
    "\"distance_km\":%.2f,"
    "\"confidence\":%.2f,"
    "\"adxl345_value\":%.5f,"
    "\"adxl345_ratio\":%.3f,"
    "\"adxl345_triggered\":%s,"
    "\"adxl345_score\":%.3f,"
    "\"lis3dh_value\":%.5f,"
    "\"lis3dh_ratio\":%.3f,"
    "\"lis3dh_triggered\":%s,"
    "\"lis3dh_score\":%.3f,"
    "\"mpu6050_value\":%.3f,"
    "\"mpu6050_ratio\":%.3f,"
    "\"mpu6050_triggered\":%s,"
    "\"mpu6050_score\":%.3f,"
    "\"p_wave_ms\":%lu,"
    "\"s_wave_ms\":%lu,"
    "\"p_wave_detected\":%s,"
    "\"s_wave_detected\":%s,"
    "\"shaker_running\":%s,"
    "\"wifi_rssi\":%d,"
    "\"free_heap\":%u,"
    "\"sample_ms\":%lu,"
    "\"system_uptime_ms\":%lu,"
    "\"simulation_phase\":\"%s\","
    "\"motor_pwm_level\":%d,"
    "\"simulation_progress\":%.2f,"
    "\"cpu_load_pct\":%d,"
    "\"cloud_sync_success_pct\":%d,"
    "\"battery_voltage\":%.2f"
    "}",
    SUPABASE_STATION_ID,
    (unsigned long)millis(),
    esc,
    (double)livePga,
    (double)liveMagnitude,
    (double)liveDistance,
    (double)classConfidence(eventClass),
    (double)liveAdxlDelta, (double)liveAdxlRatio, liveAdxlTrig ? "true" : "false",
    (double)adxlScore,
    (double)liveLisDelta,  (double)liveLisRatio,  liveLisTrig  ? "true" : "false",
    (double)lisScore,
    (double)liveGyroDelta, (double)liveGyroRatio, liveGyroTrig ? "true" : "false",
    (double)gyroScore,
    (unsigned long)pWaveTime,
    (unsigned long)sWaveTime,
    pWaveDetected ? "true" : "false",
    sWaveDetected ? "true" : "false",
    shakerRunning ? "true" : "false",
    (int)WiFi.RSSI(),
    (unsigned int)ESP.getFreeHeap(),
    (unsigned long)liveSampleMs,
    (unsigned long)millis(),
    shakerStateName(),
    motorPwmLevel,
    (double)simulationProgress,
    cpuLoadPct,
    cloudPct,
    (double)battV
  );
}


// ================================================================
//  BUILD EVENT JSON — called on Core 1, result queued to Core 0
// ================================================================
static void __attribute__((optimize("Os"),noinline)) buildEventJson(char* out, size_t outSize,
                           const EventSnapshot& ev) {
  static char escCls[36], escId[56];
  jsonEscapeInto(escCls, sizeof(escCls), ev.classification);
  jsonEscapeInto(escId,  sizeof(escId),  ev.eventId);

  snprintf(out, outSize,
    "{"
    "\"event_id\":\"%s\","
    "\"station_id\":\"%s\","
    "\"timestamp_ms\":%lu,"
    "\"classification\":\"%s\","
    "\"magnitude\":%.2f,"
    "\"distance_km\":%.2f,"
    "\"pga_cm_s2\":%.2f,"
    "\"confidence\":%.2f,"
    "\"p_wave_ms\":%lu,"
    "\"s_wave_ms\":%lu,"
    "\"sample_ms\":10,"
    "\"event_duration_ms\":%lu,"
    "\"is_false_trigger\":%s,"
    "\"adxl345_stalta\":%.3f,"
    "\"lis3dh_stalta\":%.3f,"
    "\"mpu6050_stalta\":%.3f"
    "}",
    escId,
    SUPABASE_STATION_ID,
    (unsigned long)ev.timestampMs,
    escCls,
    (double)ev.magnitude,
    (double)ev.distance_km,
    (double)ev.pga,
    (double)ev.confidence,
    (unsigned long)ev.pWaveMs,
    (unsigned long)ev.sWaveMs,
    (unsigned long)ev.durationMs,
    ev.isFalseTrigger ? "true" : "false",
    (double)ev.adxlStalta,
    (double)ev.lisStalta,
    (double)ev.mpuStalta
  );
}


// ================================================================
//  BUILD WAVEFORM JSON — heap-allocates result, caller must free
//  Returns nullptr if heap too low.
// ================================================================
static char* __attribute__((optimize("Os"),noinline)) buildWaveformJson(const EventSnapshot& ev) {
  // 60 samples × 4 arrays at "%.2f" ≈ 1.7 KB of JSON; 2600 gives headroom.
  const size_t BUF = 2600;

  // Build only if, AFTER holding this buffer, the upload still clears the heap
  // guard (the buffer stays allocated until the POST completes on Core 0).
  // i.e. require free >= HEAP_GUARD + BUF. Skipping a waveform when heap is
  // tight is fine — station_live keeps flowing and we avoid low-heap TLS thrash.
  if (ESP.getFreeHeap() < (HEAP_GUARD + BUF)) {
    Serial.printf("[UP] Skip waveform build: heap %u\n", ESP.getFreeHeap());
    return nullptr;
  }

  char* json = (char*)malloc(BUF);
  if (!json) {
    Serial.println(F("[UP] waveform malloc failed"));
    return nullptr;
  }

  // Build unified array and locate P/S indices
  float unifiedArr[WAVE_CAP_SIZE];
  float peakAmp = 0.0f;
  for (int i = 0; i < ev.sampleCount; i++) {
    float u = (pendingAdxlSamples[i] + pendingLisSamples[i]
               + pendingMpuSamples[i] / 50.0f) / 3.0f;
    unifiedArr[i] = u;
    if (u > peakAmp) peakAmp = u;
  }

  int pIdx = -1, sIdx = -1;
  if (ev.sampleCount >= 10) {
    float mean10 = 0;
    for (int i = 0; i < 10; i++) mean10 += pendingAdxlSamples[i];
    mean10 /= 10.0f;
    float threshold = mean10 * 2.0f + 0.01f;
    for (int i = 10; i < ev.sampleCount && pIdx < 0; i++) {
      if (pendingAdxlSamples[i] > threshold) pIdx = i;
    }
    float maxGyro = 0;
    for (int i = (pIdx > 0 ? pIdx : 0); i < ev.sampleCount; i++) {
      if (pendingMpuSamples[i] > maxGyro) {
        maxGyro = pendingMpuSamples[i]; sIdx = i;
      }
    }
  }

  static char escCls[36], escId[56];
  jsonEscapeInto(escCls, sizeof(escCls), ev.classification);
  jsonEscapeInto(escId,  sizeof(escId),  ev.eventId);

  int last = ev.sampleCount > 0 ? ev.sampleCount - 1 : 0;
  int pos  = 0;

  pos += snprintf(json + pos, BUF - pos,
    "{"
    "\"station_id\":\"%s\","
    "\"timestamp_ms\":%lu,"
    "\"event_id\":\"%s\","
    "\"adxl345_value\":%.5f,"
    "\"lis3dh_value\":%.5f,"
    "\"mpu6050_value\":%.3f,"
    "\"verified_value\":%.5f,"
    "\"confidence\":%.2f,"
    "\"classification\":\"%s\","
    "\"sample_rate_hz\":100.0,"
    "\"p_wave_index\":%d,"
    "\"s_wave_index\":%d,"
    "\"surface_wave_index\":-1,"
    "\"peak_amplitude\":%.5f,"
    "\"waveform_confidence\":%.2f,",
    SUPABASE_STATION_ID,
    (unsigned long)ev.timestampMs,
    escId,
    (double)pendingAdxlSamples[last],
    (double)pendingLisSamples[last],
    (double)pendingMpuSamples[last],
    (double)peakAmp,
    (double)ev.confidence,
    escCls,
    pIdx, sIdx,
    (double)peakAmp,
    (double)ev.confidence
  );

  // Write sample arrays inline
  auto writeArr = [&](const char* key, const float* arr, bool last_arr) {
    pos += snprintf(json + pos, BUF - pos, "\"%s\":[", key);
    for (int i = 0; i < ev.sampleCount && pos < (int)BUF - 16; i++) {
      if (i > 0) json[pos++] = ',';
      pos += snprintf(json + pos, BUF - pos, "%.2f", (double)arr[i]);
    }
    pos += snprintf(json + pos, BUF - pos, last_arr ? "]" : "],");
  };

  writeArr("adxl345_samples", pendingAdxlSamples, false);
  writeArr("lis3dh_samples",  pendingLisSamples,  false);
  writeArr("mpu6050_samples", pendingMpuSamples,  false);
  writeArr("unified_samples", unifiedArr,          true);

  snprintf(json + pos, BUF - pos, "}");
  return json;  // caller must free()
}


// ================================================================
//  CORE 0 UPLOAD TASK
//  Waits on the queue indefinitely. When a message arrives it
//  performs the TLS/HTTP call entirely on Core 0, never touching
//  Core 1's BT, sensor loop, or shaker.
// ================================================================
static void __attribute__((optimize("Os"),noinline)) uploadTask(void* /*param*/) {
  Serial.printf("[UP] Upload task started on Core %d\n", xPortGetCoreID());

  UploadMessage msg;
  for (;;) {
    // Block here until something arrives — no CPU waste
    if (xQueueReceive(uploadQueue, &msg, portMAX_DELAY) != pdTRUE) continue;

    // ── Stack-overflow / heap isolation watchdog ──────────────────
    // High-water mark = smallest free stack (in words) this task has ever had.
    // If it approaches 0 the 12 KB stack is being overrun (the classic cause
    // of a TLS socket silently dying / "Bluetooth socket failure" via memory
    // corruption). Logged once every 50 uploads so it's visible but not noisy.
    static uint32_t upCount = 0;
    if ((upCount++ % 50) == 0) {
      UBaseType_t stackFreeWords =
        uploadTaskHandle ? uxTaskGetStackHighWaterMark(uploadTaskHandle) : 0;
      Serial.printf("[UP] watchdog: stack_free=%u bytes, heap_free=%u, min_heap=%u\n",
                    (unsigned)(stackFreeWords * sizeof(StackType_t)),
                    (unsigned)ESP.getFreeHeap(),
                    (unsigned)ESP.getMinFreeHeap());
    }

    switch (msg.type) {

      case UPLOAD_LIVE: {
        // UPSERT to station_live: one row per station, updated in place.
        //
        // BUG FIX — the missing piece that caused station_live to receive
        // nothing (or accumulate thousands of rows):
        //
        // PostgREST requires the ?on_conflict=<column> query parameter to
        // know WHICH column to use when "resolution=merge-duplicates" is
        // in the Prefer header. Without ?on_conflict=station_id, PostgREST
        // ignores the Prefer header entirely and performs a plain INSERT.
        // Every 500 ms call inserted a NEW row; the dashboard query that
        // selects "the live row for station TX-01" either returned 0 rows
        // (if filtered on station_id with LIMIT 1) or returned the first
        // row ever inserted (which is now stale). Either way: no live data.
        //
        // Fix: append ?on_conflict=station_id to the endpoint URL.
        // This is safe even if the row doesn't exist yet — PostgREST
        // will INSERT on the first call and UPSERT on all subsequent ones.
        supabaseRequest("POST",
                        "/rest/v1/station_live?on_conflict=station_id",
                        msg.live.json,
                        /*upsert=*/true);
        break;
      }

      case UPLOAD_EVENT: {
        supabaseRequest("POST", "/rest/v1/earthquake_history",
                        msg.event.eventJson, false);
        // Waveform sent right after, in same task iteration
        if (msg.event.waveformJson) {
          supabaseRequest("POST", "/rest/v1/station_waveform",
                          msg.event.waveformJson, false);
          free(msg.event.waveformJson);
          msg.event.waveformJson = nullptr;
        }
        break;
      }

      default:
        break;
    }

    // Minimal yield so the WiFi stack on Core 0 can process ACKs between
    // uploads. 2 ms is enough — the old 10 ms meant the queue could back up
    // by one live frame every cycle at 500 ms intervals.
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}


// ================================================================
//  QUEUE HELPERS — called from Core 1 sensor loop
//  Use timeout=0 so Core 1 NEVER blocks if the queue is full.
//  A missed live frame is acceptable; events are retried next cycle.
// ================================================================
static void __attribute__((optimize("Os"),noinline)) enqueueLive() {
  if (!uploadQueue) return;

  UploadMessage msg;
  msg.type = UPLOAD_LIVE;
  buildLiveJson(msg.live.json, sizeof(msg.live.json));

  // Non-blocking send — if queue full, drop this live frame silently
  if (xQueueSend(uploadQueue, &msg, 0) != pdTRUE) {
    // Queue full: uploader is behind. Not an error — just skip this frame.
    // Uncomment to debug: Serial.println(F("[UP] live queue full, frame dropped"));
  }
}

static void __attribute__((optimize("Os"),noinline)) enqueueEvent(const EventSnapshot& ev) {
  if (!uploadQueue) return;

  UploadMessage msg;
  msg.type = UPLOAD_EVENT;
  buildEventJson(msg.event.eventJson, sizeof(msg.event.eventJson), ev);

  // Build waveform JSON on heap — uploader task will free it
  msg.event.waveformJson = buildWaveformJson(ev);
  msg.event.waveformLen  = msg.event.waveformJson
                           ? strlen(msg.event.waveformJson) : 0;

  // For events we wait up to 100 ms — still very fast but avoids losing data
  if (xQueueSend(uploadQueue, &msg, pdMS_TO_TICKS(100)) != pdTRUE) {
    Serial.println(F("[UP] event queue full — event dropped"));
    if (msg.event.waveformJson) free(msg.event.waveformJson);
  }
}


// ================================================================
//  WEB DASHBOARD WAVEFORM RING BUFFER
// ================================================================
void __attribute__((optimize("Os"),noinline)) pushWebWaveform(float adxlDelta, float gyroDelta) {
  webAdxlWaveform[webWaveIndex] = adxlDelta;
  webMpuWaveform [webWaveIndex] = gyroDelta;
  webWaveTimes   [webWaveIndex] = millis();
  webWaveIndex = (webWaveIndex + 1) % WEB_WAVEFORM_SIZE;
  if (webWaveCount < WEB_WAVEFORM_SIZE) webWaveCount++;
}


// ================================================================
//  WEB HANDLERS — unchanged from rev5
// ================================================================
void __attribute__((optimize("Os"),noinline)) handleApiLive() {
  static char json[1200];
  static char escCls[36];
  jsonEscapeInto(escCls, sizeof(escCls), eventClass);

  int pos = 0;
  pos += snprintf(json + pos, sizeof(json) - pos,
    "{"
    "\"uptimeMs\":%lu,"
    "\"sampleMs\":%lu,"
    "\"eventClass\":\"%s\","
    "\"quakeActive\":%s,"
    "\"shaker\":{\"running\":%s,\"state\":\"%s\"},"
    "\"pga\":{\"value\":%.2f},"
    "\"magnitude\":%.2f,"
    "\"distance\":%.2f,"
    "\"fft\":{\"dominantHz\":%.2f,\"band\":\"%s\"},"
    "\"motorPwm\":%d,"
    "\"sensors\":[",
    (unsigned long)millis(),
    (unsigned long)liveSampleMs,
    escCls,
    quakeActive   ? "true" : "false",
    shakerRunning ? "true" : "false",
    shakerStateName(),
    (double)livePga,
    (double)liveMagnitude,
    (double)liveDistance,
    (double)dominantFreqHz, freqBand,
    motorPwmLevel
  );

  pos += snprintf(json + pos, sizeof(json) - pos,
    "{\"name\":\"ADXL345\",\"delta\":%.5f,\"ratio\":%.3f,\"threshold\":%.3f,\"triggered\":%s},",
    (double)liveAdxlDelta, (double)liveAdxlRatio, (double)liveAdxlThresh,
    liveAdxlTrig ? "true" : "false");
  pos += snprintf(json + pos, sizeof(json) - pos,
    "{\"name\":\"LIS3DH\",\"delta\":%.5f,\"ratio\":%.3f,\"threshold\":%.3f,\"triggered\":%s},",
    (double)liveLisDelta, (double)liveLisRatio, (double)liveLisThresh,
    liveLisTrig ? "true" : "false");
  pos += snprintf(json + pos, sizeof(json) - pos,
    "{\"name\":\"MPU6050\",\"delta\":%.3f,\"ratio\":%.3f,\"threshold\":%.3f,\"triggered\":%s}",
    (double)liveGyroDelta, (double)liveGyroRatio, (double)liveGyroThresh,
    liveGyroTrig ? "true" : "false");

  pos += snprintf(json + pos, sizeof(json) - pos, "],\"timeline\":[");
  int show = alertCount < LOG_SIZE ? alertCount : LOG_SIZE;
  for (int i = 0; i < show; i++) {
    int idx = (alertIndex - 1 - i + LOG_SIZE) % LOG_SIZE;
    static char escEntry[72];
    jsonEscapeInto(escEntry, sizeof(escEntry), alertLog[idx]);
    if (i > 0) { json[pos++] = ','; }
    pos += snprintf(json + pos, sizeof(json) - pos,
                    "{\"text\":\"%s\"}", escEntry);
  }
  snprintf(json + pos, sizeof(json) - pos, "]}");

  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

void __attribute__((optimize("Os"),noinline)) handleApiWaveform() {
  static char json[2600];
  int pos = 0;

  pos += snprintf(json + pos, sizeof(json) - pos,
                  "{\"count\":%d,\"times\":[", webWaveCount);
  for (int i = 0; i < webWaveCount; i++) {
    int idx = (webWaveIndex - webWaveCount + i + WEB_WAVEFORM_SIZE) % WEB_WAVEFORM_SIZE;
    if (i > 0) json[pos++] = ',';
    pos += snprintf(json + pos, sizeof(json) - pos, "%lu",
                    (unsigned long)webWaveTimes[idx]);
  }

  pos += snprintf(json + pos, sizeof(json) - pos, "],\"adxl345\":[");
  for (int i = 0; i < webWaveCount; i++) {
    int idx = (webWaveIndex - webWaveCount + i + WEB_WAVEFORM_SIZE) % WEB_WAVEFORM_SIZE;
    if (i > 0) json[pos++] = ',';
    pos += snprintf(json + pos, sizeof(json) - pos, "%.5f",
                    (double)webAdxlWaveform[idx]);
  }

  pos += snprintf(json + pos, sizeof(json) - pos, "],\"mpu6050\":[");
  for (int i = 0; i < webWaveCount; i++) {
    int idx = (webWaveIndex - webWaveCount + i + WEB_WAVEFORM_SIZE) % WEB_WAVEFORM_SIZE;
    if (i > 0) json[pos++] = ',';
    pos += snprintf(json + pos, sizeof(json) - pos, "%.3f",
                    (double)webMpuWaveform[idx]);
  }

  snprintf(json + pos, sizeof(json) - pos, "]}");

  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

// ----------------------------------------------------------------
//  Dashboard HTML stored in flash (PROGMEM) — NOT in IRAM.
//  Using F(R"rawliteral(...)rawliteral") was the cause of the
//  iram0_0_seg overflow: the F() macro is only reliable with plain
//  string literals, not raw-string literals, and with large payloads
//  it caused the compiler to place the entire ~2 KB string in IRAM.
//  Fix: declare as a plain PROGMEM const and serve with send_P().
// ----------------------------------------------------------------
static const char DASHBOARD_HTML[] PROGMEM =
"<!DOCTYPE html><html><head>"
"<title>TremorLab</title>"
"<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
"<script src=\"https://cdn.jsdelivr.net/npm/chart.js\"></script>"
"<style>"
":root{color-scheme:dark;--bg:#090b0f;--panel:#151922;--line:#2a3140;--text:#edf2ff;--muted:#8f9bb3;--good:#3ddc97;--warn:#f7b955;--bad:#ff5a67;}"
"*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif}"
"main{max-width:1100px;margin:0 auto;padding:16px}h2{font-size:.9rem;margin:0 0 8px;color:#cbd5e1}"
".grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}"
".card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;min-width:0}"
".s3{grid-column:span 3}.s4{grid-column:span 4}.s6{grid-column:span 6}.s12{grid-column:span 12}"
".big{font-size:2rem;font-weight:750;line-height:1}.unit{font-size:.8rem;color:var(--muted);margin-top:4px}"
".alert{color:var(--bad)}.ok{color:var(--good)}"
"canvas{width:100%!important;height:200px!important}"
"table{width:100%;border-collapse:collapse;font-size:.85rem}"
"th,td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left}"
"th{color:var(--muted)}"
"@media(max-width:700px){.s3,.s4,.s6{grid-column:span 12}}"
"</style></head><body><main>"
"<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px\">"
"<h1 style=\"font-size:1.3rem;margin:0\">TremorLab</h1>"
"<span id=\"conn\" style=\"font-size:.8rem;color:var(--muted)\">connecting...</span>"
"</div>"
"<div class=\"grid\">"
"<div class=\"card s4\"><h2>Classification</h2><div id=\"cls\" class=\"big ok\">--</div><div class=\"unit\" id=\"shaker\">Shaker: --</div></div>"
"<div class=\"card s3\"><h2>PGA</h2><div class=\"big\" id=\"pga\">--</div><div class=\"unit\">cm/s\xc2\xb2</div></div>"
"<div class=\"card s3\"><h2>Magnitude</h2><div class=\"big\" id=\"mag\">--</div><div class=\"unit\">estimate</div></div>"
"<div class=\"card s2\"><h2>Motor PWM</h2><div class=\"big\" id=\"pwm\">--</div><div class=\"unit\">/ 255</div></div>"
"<div class=\"card s6\"><h2>ADXL345</h2><canvas id=\"ca\"></canvas></div>"
"<div class=\"card s6\"><h2>MPU6050</h2><canvas id=\"cm\"></canvas></div>"
"<div class=\"card s12\"><h2>Sensor detail</h2>"
"<table><thead><tr><th>Sensor</th><th>Signal</th><th>STA/LTA</th><th>Threshold</th><th>Triggered</th></tr></thead>"
"<tbody id=\"rows\"></tbody></table></div>"
"<div class=\"card s12\"><h2>Event log</h2><div id=\"log\" style=\"max-height:160px;overflow:auto;font-size:.82rem\"></div></div>"
"</div></main><script>"
"const f=(v,d=1)=>v==null||v<-900?'--':Number(v).toFixed(d);"
"const mk=(id,color,label)=>new Chart(document.getElementById(id),{type:'line',data:{labels:[],datasets:[{label,borderColor:color,backgroundColor:color+'22',data:[],pointRadius:0,borderWidth:1.8,tension:.15,fill:true}]},options:{responsive:true,animation:false,maintainAspectRatio:false,scales:{x:{display:false},y:{grid:{color:'#1e2530'},ticks:{color:'#8f9bb3'}}},plugins:{legend:{labels:{color:'#cbd5e1'}}}}});"
"const ca=mk('ca','#57b8ff','ADXL345 g'),cm=mk('cm','#c084fc','MPU6050 deg/s');"
"async function tick(){try{"
"const[l,w]=await Promise.all([fetch('/api/live',{cache:'no-store'}).then(r=>r.json()),fetch('/api/waveform',{cache:'no-store'}).then(r=>r.json())]);"
"document.getElementById('cls').textContent=l.eventClass||'--';"
"document.getElementById('cls').className='big '+(l.quakeActive?'alert':'ok');"
"document.getElementById('shaker').textContent='Shaker: '+l.shaker.state+(l.shaker.running?' \xe2\x96\xb6':' \xe2\x96\xa0');"
"document.getElementById('pga').textContent=f(l.pga.value,1);"
"document.getElementById('mag').textContent=f(l.magnitude,1);"
"document.getElementById('pwm').textContent=l.motorPwm??'--';"
"document.getElementById('rows').innerHTML=l.sensors.map(s=>`<tr><td>${s.name}</td><td>${f(s.delta,s.name==='MPU6050'?2:4)}</td><td>${f(s.ratio,2)}</td><td>${f(s.threshold,2)}</td><td style=\"color:${s.triggered?'var(--bad)':'var(--good)'}\">${s.triggered?'YES':'no'}</td></tr>`).join('');"
"document.getElementById('log').innerHTML=l.timeline.length?l.timeline.map(e=>`<div style=\"padding:4px 0;border-bottom:1px solid var(--line)\">${e.text}</div>`).join(''):'<span style=\"color:var(--muted)\">No events</span>';"
"const lab=w.times.map((t,i)=>i);"
"[ca,cm].forEach((ch,ci)=>{ch.data.labels=lab;ch.data.datasets[0].data=ci===0?w.adxl345:w.mpu6050;ch.update('none');});"
"document.getElementById('conn').textContent='Live \xe2\x9c\x93';"
"}catch(e){document.getElementById('conn').textContent='Offline';}}"
"tick();setInterval(tick,500);"
"</script></body></html>";

void __attribute__((optimize("Os"),noinline)) handleRoot() {
  // send_P reads directly from flash — no IRAM or heap copy needed.
  server.send_P(200, "text/html", DASHBOARD_HTML);
}


// ================================================================
//  SETUP
// ================================================================
void setup() {
  pinMode(MOTOR_IN2, OUTPUT);
  digitalWrite(MOTOR_IN2, LOW);

  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n=== TremorLab seismometer boot (rev 11) ==="));

  // ── Heap-allocate all large buffers ──────────────────────────
  adxlHistory        = (float*)malloc(BUFFER_SIZE       * sizeof(float));
  lisHistory         = (float*)malloc(BUFFER_SIZE       * sizeof(float));
  gyroHistory        = (float*)malloc(BUFFER_SIZE       * sizeof(float));
  capAdxl            = (float*)malloc(WAVE_CAP_SIZE     * sizeof(float));
  capLis             = (float*)malloc(WAVE_CAP_SIZE     * sizeof(float));
  capMpu             = (float*)malloc(WAVE_CAP_SIZE     * sizeof(float));
  pendingAdxlSamples = (float*)malloc(WAVE_CAP_SIZE     * sizeof(float));
  pendingLisSamples  = (float*)malloc(WAVE_CAP_SIZE     * sizeof(float));
  pendingMpuSamples  = (float*)malloc(WAVE_CAP_SIZE     * sizeof(float));
  webAdxlWaveform    = (float*)malloc(WEB_WAVEFORM_SIZE * sizeof(float));
  webMpuWaveform     = (float*)malloc(WEB_WAVEFORM_SIZE * sizeof(float));
  webWaveTimes       = (unsigned long*)malloc(WEB_WAVEFORM_SIZE * sizeof(unsigned long));
  fftReal            = (float*)malloc(FFT_SAMPLES        * sizeof(float));
  fftImag            = (float*)malloc(FFT_SAMPLES        * sizeof(float));

  if (!adxlHistory || !lisHistory || !gyroHistory ||
      !capAdxl     || !capLis     || !capMpu      ||
      !pendingAdxlSamples || !pendingLisSamples   ||
      !pendingMpuSamples  || !fftReal || !fftImag  ||
      !webAdxlWaveform    || !webMpuWaveform       ||
      !webWaveTimes) {
    Serial.println(F("FATAL: malloc failed — insufficient heap."));
    while (true) delay(1000);
  }

  memset(adxlHistory,        0, BUFFER_SIZE       * sizeof(float));
  memset(lisHistory,         0, BUFFER_SIZE       * sizeof(float));
  memset(gyroHistory,        0, BUFFER_SIZE       * sizeof(float));
  memset(capAdxl,            0, WAVE_CAP_SIZE     * sizeof(float));
  memset(capLis,             0, WAVE_CAP_SIZE     * sizeof(float));
  memset(capMpu,             0, WAVE_CAP_SIZE     * sizeof(float));
  memset(pendingAdxlSamples, 0, WAVE_CAP_SIZE     * sizeof(float));
  memset(pendingLisSamples,  0, WAVE_CAP_SIZE     * sizeof(float));
  memset(pendingMpuSamples,  0, WAVE_CAP_SIZE     * sizeof(float));
  memset(webAdxlWaveform,    0, WEB_WAVEFORM_SIZE * sizeof(float));
  memset(webMpuWaveform,     0, WEB_WAVEFORM_SIZE * sizeof(float));
  memset(webWaveTimes,       0, WEB_WAVEFORM_SIZE * sizeof(unsigned long));
  memset(fftReal,            0, FFT_SAMPLES        * sizeof(float));
  memset(fftImag,            0, FFT_SAMPLES        * sizeof(float));

  FFT = new ArduinoFFT<float>(fftReal, fftImag, FFT_SAMPLES, FFT_SAMPLING_FREQ);

  Serial.print(F("Heap after sensor alloc: ")); Serial.println(ESP.getFreeHeap());

  // ── GPIO ─────────────────────────────────────────────────────
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN,    OUTPUT);
  pinMode(MOTOR_IN1,  OUTPUT);
  pinMode(MOTOR_IN2,  OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN,    LOW);
  motorStop();
  ledcAttach(MOTOR_ENA, motorFreqHz, MOTOR_RES);
  motorStop();

  // ── I2C ──────────────────────────────────────────────────────
  Wire.begin(I2C_SDA, I2C_SCL);

  // ── BLE motor-control link (replaces Classic Bluetooth SPP) ──
  // Free the now-unused Classic (BR/EDR) controller RAM first, then start BLE.
  // The BLE stack is far lighter than Classic bluedroid, which is what frees
  // the heap the TLS uploader needs.
#if FREE_CLASSIC_BT_MEMORY
  esp_err_t clsRel = esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
  Serial.printf("Classic BT mem release: %s | heap now %u\n",
                esp_err_to_name(clsRel), (unsigned)ESP.getFreeHeap());
#endif
  initBLE();
  Serial.println(F("BLE ready — connect to 'TremorLab' (BLE UART) for motor commands."));
  Serial.print(F("Heap after BLE: ")); Serial.println(ESP.getFreeHeap());

  // ── ADC setup for battery voltage measurement ──────────────────
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);  // 0-3.3 V range on ADC1 pins

  // ── Sensors ───────────────────────────────────────────────────
  if (!adxl.begin()) {
    Serial.println(F("ERROR: ADXL345 not found — running without it."));
    adxlOk = false;
  } else {
    adxl.setRange(ADXL345_RANGE_2_G);
    // Set the output data rate explicitly to 100 Hz to match the sample loop.
    // The ADXL345 powers up at a low default ODR; if it isn't sampling at the
    // loop rate, getEvent() returns the SAME value repeatedly, the conditioned
    // signal flattens to ~0, and its STA/LTA ratio (hence its sensor score)
    // collapses toward 0 — exactly the "ADXL score 0.022" symptom. 100 Hz ODR
    // gives a fresh sample every loop so the channel responds like the others.
    adxl.setDataRate(ADXL345_DATARATE_100_HZ);
    Serial.println(F("ADXL345 OK (range 2g, ODR 100 Hz)"));

    // Liveness check — read twice ~150 ms apart. If the X/Y/Z values are bit-
    // for-bit identical, the data registers aren't advancing, i.e. the plotter
    // trace will be a dead-flat line. The usual cause on an ADXL345 breakout is
    // the CS pin: for I2C it MUST be tied HIGH (to 3V3). If CS floats or is low
    // the chip is in SPI mode and I2C reads return stale/constant data even
    // though begin() succeeded. (SDO sets the I2C address: GND=0x53, 3V3=0x1D.)
    {
      sensors_event_t a, b;
      adxl.getEvent(&a); delay(150); adxl.getEvent(&b);
      if (a.acceleration.x == b.acceleration.x &&
          a.acceleration.y == b.acceleration.y &&
          a.acceleration.z == b.acceleration.z) {
        Serial.println(F("  ! ADXL345 readings IDENTICAL across 150 ms — sensor not "
                         "updating. Tie the ADXL345 CS pin to 3V3 (I2C mode); check "
                         "SDA/SCL wiring and SDO (addr 0x53=GND)."));
      } else {
        Serial.printf("  ADXL345 live: dx=%.4f dy=%.4f dz=%.4f (m/s^2 between two reads)\n",
                      (double)(b.acceleration.x - a.acceleration.x),
                      (double)(b.acceleration.y - a.acceleration.y),
                      (double)(b.acceleration.z - a.acceleration.z));
      }
    }
  }

  if (!lis.begin(0x19)) {
    Serial.println(F("ERROR: LIS3DH not found — running without it."));
    lisOk = false;
  } else {
    lis.setRange(LIS3DH_RANGE_2_G);
    lis.setDataRate(LIS3DH_DATARATE_100_HZ);
    Serial.println(F("LIS3DH OK"));
  }

  mpu.initialize();
  if (!mpu.testConnection()) {
    Serial.println(F("ERROR: MPU6050 not found — running without it."));
    mpuOk = false;
  } else {
    Serial.println(F("MPU6050 OK"));
  }

  // ── Calibration — all three sensors, two passes ───────────────
  // Pass 1: per-axis baseline/bias (accel gravity vector + gyro bias).
  // Pass 2: rest-noise RMS of each conditioned channel, for troubleshooting
  //         and to confirm the three sensors are producing consistent output.
  Serial.println(F("Calibrating — keep board still for ~5 seconds..."));
  const int CAL_N = 150;
  float sx = 0, sy = 0, sz = 0, lx = 0, ly = 0, lz = 0, gx = 0, gy = 0, gz = 0;
  for (int i = 0; i < CAL_N; i++) {
    if (adxlOk) {
      sensors_event_t e;
      adxl.getEvent(&e);
      sx += e.acceleration.x; sy += e.acceleration.y; sz += e.acceleration.z;
    }
    if (lisOk) {
      lis.read();
      lx += lis.x_g; ly += lis.y_g; lz += lis.z_g;
    }
    if (mpuOk) {
      int16_t ax, ay, az, rgx, rgy, rgz;
      mpu.getMotion6(&ax, &ay, &az, &rgx, &rgy, &rgz);
      gx += rgx / 131.0f; gy += rgy / 131.0f; gz += rgz / 131.0f;
    }
    delay(20);
  }
  adxlBaseX = adxlOk ? sx / CAL_N : 0.0f;
  adxlBaseY = adxlOk ? sy / CAL_N : 0.0f;
  adxlBaseZ = adxlOk ? sz / CAL_N : 0.0f;
  lisBaseX  = lisOk  ? lx / CAL_N : 0.0f;
  lisBaseY  = lisOk  ? ly / CAL_N : 0.0f;
  lisBaseZ  = lisOk  ? lz / CAL_N : 0.0f;
  gyroBaseX = mpuOk  ? gx / CAL_N : 0.0f;
  gyroBaseY = mpuOk  ? gy / CAL_N : 0.0f;
  gyroBaseZ = mpuOk  ? gz / CAL_N : 0.0f;

  // Pass 2: rest mean + rest-noise RMS of each baseline-subtracted magnitude.
  // The mean is used to PRE-SEED the drift/EMA filters so the conditioned
  // signal sits at zero from the very first loop — no startup offset to settle
  // out, regardless of each sensor's individual bias.
  float adxlSq = 0, lisSq = 0, gyroSq = 0;
  float adxlSum = 0, lisSum = 0, gyroSum = 0;
  for (int i = 0; i < CAL_N; i++) {
    if (adxlOk) {
      sensors_event_t e; adxl.getEvent(&e);
      float dx = e.acceleration.x - adxlBaseX;
      float dy = e.acceleration.y - adxlBaseY;
      float dz = e.acceleration.z - adxlBaseZ;
      float m = sqrtf(dx*dx + dy*dy + dz*dz) / 9.81f;
      adxlSq += m * m; adxlSum += m;
    }
    if (lisOk) {
      lis.read();
      float dx = lis.x_g - lisBaseX, dy = lis.y_g - lisBaseY, dz = lis.z_g - lisBaseZ;
      float m = sqrtf(dx*dx + dy*dy + dz*dz);
      lisSq += m * m; lisSum += m;
    }
    if (mpuOk) {
      int16_t ax, ay, az, rgx, rgy, rgz;
      mpu.getMotion6(&ax, &ay, &az, &rgx, &rgy, &rgz);
      float dx = rgx/131.0f - gyroBaseX, dy = rgy/131.0f - gyroBaseY, dz = rgz/131.0f - gyroBaseZ;
      float m = sqrtf(dx*dx + dy*dy + dz*dz);
      gyroSq += m * m; gyroSum += m;
    }
    delay(20);
  }
  adxlRestNoise = adxlOk ? sqrtf(adxlSq / CAL_N) : 0.0f;
  lisRestNoise  = lisOk  ? sqrtf(lisSq  / CAL_N) : 0.0f;
  gyroRestNoise = mpuOk  ? sqrtf(gyroSq / CAL_N) : 0.0f;
  float adxlRestMean = adxlOk ? adxlSum / CAL_N : 0.0f;
  float lisRestMean  = lisOk  ? lisSum  / CAL_N : 0.0f;
  float gyroRestMean = mpuOk  ? gyroSum / CAL_N : 0.0f;
  // Guard against a zero/near-zero noise floor (a flat/stuck sensor) so the
  // plotter normalisation below can never divide by ~0.
  if (adxlRestNoise < 1e-5f) adxlRestNoise = 1e-5f;
  if (lisRestNoise  < 1e-5f) lisRestNoise  = 1e-5f;
  if (gyroRestNoise < 1e-5f) gyroRestNoise = 1e-5f;

  Serial.println(F("Calibration done. Per-sensor REST NOISE (RMS):"));
  Serial.printf("  ADXL345: %.5f g   LIS3DH: %.5f g   MPU6050: %.5f dps\n",
                (double)adxlRestNoise, (double)lisRestNoise, (double)gyroRestNoise);
  // Troubleshooting hint: a near-zero ADXL rest-noise means it's reading flat
  // (ODR/wiring) rather than truly quiet — that's what crushes its sensor score.
  if (adxlOk && adxlRestNoise <= 1e-5f)
    Serial.println(F("  ! ADXL345 rest-noise ~0 — likely flat/stuck (check ODR, wiring, I2C)."));

  // Pre-seed filter + drift to the measured rest mean -> zero offset from t=0.
  adxlFiltered = adxlDrift = adxlRestMean;
  lisFiltered  = lisDrift  = lisRestMean;
  gyroFiltered = gyroDrift = gyroRestMean;
  adxlRaw1 = adxlRaw2 = adxlRaw3 = adxlRestMean;
  lisRaw1  = lisRaw2  = lisRaw3  = lisRestMean;
  gyroRaw1 = gyroRaw2 = gyroRaw3 = gyroRestMean;
  adxlRatioMean = lisRatioMean = gyroRatioMean = 1.0f;
  adxlRatioVar  = lisRatioVar  = gyroRatioVar  = 0.25f;
  adaptSampleCount = 0;
  fftSampleIndex   = 0;

  // ── WiFi ──────────────────────────────────────────────────────
  Serial.print(F("Connecting to WiFi: ")); Serial.println(ssid);
  WiFi.mode(WIFI_STA);
  // Disable WiFi modem power-save. With the default light-sleep, the radio
  // parks between DTIM beacons and the first packet of each upload waits
  // 100-300 ms for the radio to wake — a major, erratic source of upload
  // latency AND of TLS sockets stalling/dropping (which feeds the BT/socket
  // failure symptoms when the two stacks contend). Keeping the modem awake
  // makes uploads consistently fast and the TCP sockets stable.
  WiFi.setSleep(false);
  WiFi.begin(ssid, password);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500); Serial.print('.');
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    WiFi.setSleep(false);   // re-assert after association
    Serial.print(F("\nWiFi connected. Dashboard: http://"));
    Serial.println(WiFi.localIP());
    BT.print("WiFi: "); BT.println(WiFi.localIP().toString());
  } else {
    Serial.println(F("\nWiFi failed — offline mode. Supabase disabled."));
    Serial.println(F("  -> Check that ssid/password are set (not the YOUR_WIFI_* placeholders),"));
    Serial.println(F("     and watch the heap line below: WiFi needs free heap to associate."));
  }
  Serial.print(F("Heap after WiFi: ")); Serial.println(ESP.getFreeHeap());

  // Heap health gate: TLS (WiFiClientSecure) needs ~30-40 KB for a handshake.
  // If we're below that the uploads will be slow/failing no matter what — make
  // it loud so the cause isn't mistaken for a network problem.
  uint32_t freeNow = ESP.getFreeHeap();
  if (freeNow < 40000) {
    Serial.printf("*** LOW HEAP WARNING: %u bytes free. TLS uploads need ~30-40 KB. ***\n", freeNow);
    Serial.println(F("    Motor control is on BLE now (Classic BT dropped). If still low, "
                     "set ENABLE_LOCAL_WEBSERVER 0 and check for other large allocations."));
  } else {
    Serial.println(F("    Heap looks healthy for TLS uploads."));
  }

  // ── Supabase connectivity self-test (one shot, before the upload task) ──
  supabaseSelfTest();

  // ── FreeRTOS upload queue ─────────────────────────────────────
  // Queue holds UploadMessage structs by value.
  // LIVE_QUEUE_LEN + EVENT_QUEUE_LEN slots total.
  uploadQueue = xQueueCreate(LIVE_QUEUE_LEN + EVENT_QUEUE_LEN,
                             sizeof(UploadMessage));
  if (!uploadQueue) {
    Serial.println(F("FATAL: upload queue create failed."));
    while (true) delay(1000);
  }

  // ── Upload task on Core 0 ────────────────────────────────────
  // Core 1 runs the Arduino loop (sensor + BLE + shaker). Core 0 runs the
  // WiFi/BLE stack + this upload task.
  //
  // STACK 8 KB (was 12 KB): the runtime stack high-water-mark watchdog showed
  // peak usage of only ~2.9 KB — i.e. WiFiClientSecure's TLS record buffers
  // live on the HEAP, not this stack, so 12 KB was ~9 KB of wasted, heap-
  // fragmenting RAM. 8 KB leaves >5 KB margin over the measured peak and frees
  // 4 KB back to the heap (which is what TLS needs a contiguous block of).
  //
  // Priority 2 so the uploader preempts loop() immediately when a queue item
  // arrives (loop() runs at priority 1).
  xTaskCreatePinnedToCore(
    uploadTask,       // function
    "uploadTask",     // name
    8192,             // stack bytes (12288 -> 8192; watchdog proved ~2.9 KB peak)
    nullptr,          // param
    2,                // priority
    &uploadTaskHandle,// task handle — used for stack high-water-mark monitoring
    0                 // Core 0
  );

  Serial.print(F("Heap after task launch: ")); Serial.println(ESP.getFreeHeap());

#if ENABLE_LOCAL_WEBSERVER
  server.on("/",             handleRoot);
  server.on("/api/live",     handleApiLive);
  server.on("/api/waveform", handleApiWaveform);
  server.begin();
  Serial.println(F("Local web server enabled."));
#else
  Serial.println(F("Local web server DISABLED (heap saved for TLS uploads). "
                   "Set ENABLE_LOCAL_WEBSERVER 1 to browse the station on the LAN."));
#endif

  Serial.println(F("System ready."));
  Serial.print(F("Final free heap: ")); Serial.println(ESP.getFreeHeap());
  BT.println("TremorLab ready. Send ? for motor commands.");
}


// ================================================================
//  LOOP  (Core 1 — never touches TLS, never blocks BT)
// ================================================================
void loop() {
#if ENABLE_LOCAL_WEBSERVER
  server.handleClient();
#endif
  checkBluetooth();
  updateShaker();

  // ── Read sensors ──────────────────────────────────────────────
  float adxlRawMag = 0.0f;
  if (adxlOk) {
    sensors_event_t ev;
    adxl.getEvent(&ev);
    float dx = ev.acceleration.x - adxlBaseX;
    float dy = ev.acceleration.y - adxlBaseY;
    float dz = ev.acceleration.z - adxlBaseZ;
    adxlRawMag = sqrtf(dx*dx + dy*dy + dz*dz) / 9.81f;
  }

  float lisRawMag = 0.0f;
  if (lisOk) {
    lis.read();
    float dx = lis.x_g - lisBaseX;
    float dy = lis.y_g - lisBaseY;
    float dz = lis.z_g - lisBaseZ;
    lisRawMag = sqrtf(dx*dx + dy*dy + dz*dz);
  }

  float gyroRawMag = 0.0f;
  if (mpuOk) {
    int16_t ax, ay, az, gx, gy, gz;
    mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
    float gxf = gx / 131.0f - gyroBaseX;   // subtract measured gyro bias
    float gyf = gy / 131.0f - gyroBaseY;
    float gzf = gz / 131.0f - gyroBaseZ;
    gyroRawMag = sqrtf(gxf*gxf + gyf*gyf + gzf*gzf);
  }

  // ── Signal conditioning ────────────────────────────────────────
  float adxlMed, adxlFilt, adxlCond;
  float lisMed,  lisFilt,  lisCond;
  float gyroMed, gyroFilt, gyroCond;

  adxlCond = conditionSignal(adxlRawMag,
                              adxlRaw1, adxlRaw2, adxlRaw3,
                              adxlFiltered, adxlDrift,
                              adxlMed, adxlFilt);
  lisCond  = conditionSignal(lisRawMag,
                              lisRaw1, lisRaw2, lisRaw3,
                              lisFiltered, lisDrift,
                              lisMed, lisFilt);
  gyroCond = conditionSignal(gyroRawMag,
                              gyroRaw1, gyroRaw2, gyroRaw3,
                              gyroFiltered, gyroDrift,
                              gyroMed, gyroFilt);

  // ── Circular history buffers ───────────────────────────────────
  adxlHistory[bufIndex] = adxlCond;
   lisHistory[bufIndex] = lisCond;
  gyroHistory[bufIndex] = gyroCond;
  bufIndex = (bufIndex + 1) % BUFFER_SIZE;
  if (bufCount < BUFFER_SIZE) bufCount++;

  // ── Waveform capture ───────────────────────────────────────────
  capAdxl[capIndex] = adxlCond;
  capLis [capIndex] = lisCond;
  capMpu [capIndex] = gyroCond;
  capIndex = (capIndex + 1) % WAVE_CAP_SIZE;
  if (capCount < WAVE_CAP_SIZE) capCount++;

  // ── STA/LTA ────────────────────────────────────────────────────
  float adxlR = computeSTALTA(adxlHistory);
  float lisR  = computeSTALTA( lisHistory);
  float gyroR = computeSTALTA(gyroHistory);

  // ── Adaptive thresholds ────────────────────────────────────────
  float adxlThresh = getAdaptiveThreshold(adxlRatioMean, adxlRatioVar);
  float lisThresh  = getAdaptiveThreshold(lisRatioMean,  lisRatioVar);
  float gyroThresh = getAdaptiveThreshold(gyroRatioMean, gyroRatioVar);

  // ── Real-vibration gate (calibration) ──────────────────────────
  // Strongest accelerometer amplitude this sample (g). Air/handling noise
  // sits far below MIN_VIBRATION_G even when STA/LTA momentarily spikes.
  float peakAccelG = (adxlCond > lisCond) ? adxlCond : lisCond;
  bool  realVibration = peakAccelG > MIN_VIBRATION_G;

  bool adxlOver = adxlR > adxlThresh;
  bool lisOver  = lisR  > lisThresh;
  bool gyroOver = gyroR > gyroThresh;

  // Require real amplitude AND an over-threshold ratio, sustained for a few
  // samples, before anything counts as a trigger. This is what stops the
  // buzzer/LED and classifier from latching onto air or a single-sample blip.
  if (realVibration && (adxlOver || lisOver || gyroOver)) {
    if (confirmRun < 1000000) confirmRun++;
  } else {
    confirmRun = 0;
  }
  bool confirmed = confirmRun >= TRIGGER_HOLD_SAMPLES;

  bool adxlT = confirmed && adxlOver;
  bool lisT  = confirmed && lisOver;
  bool gyroT = confirmed && gyroOver;

  // ── FFT ────────────────────────────────────────────────────────
  fftReal[fftSampleIndex] = adxlCond;
  if (++fftSampleIndex >= FFT_SAMPLES) {
    fftSampleIndex = 0;
    runFFTAnalysis();
  }

  // ── P / S wave detection ───────────────────────────────────────
  // P-wave: first accelerometer arrival clearing the adaptive trigger AND the
  // absolute P_RATIO_MIN floor.
  // S-wave: the later, larger arrival. We accept EITHER signature so the S is
  // reliably caught (and the S-P time → distance actually populates):
  //   (a) the gyro/transverse channel crosses S_RATIO_MIN (true shear motion), OR
  //   (b) after the signal has gone quiet (the P-S gap), a renewed strong
  //       accelerometer arrival appears — the classic P-gap-S shape the shaker
  //       produces. Requiring the quiet gap first stops the P coda itself being
  //       mislabelled as the S.
  float mergedAccelR = (adxlR > lisR) ? adxlR : lisR;
  bool pOnset = (adxlT && adxlR >= P_RATIO_MIN) || (lisT && lisR >= P_RATIO_MIN);

  if (pOnset && !pWaveDetected) {
    pWaveTime     = millis();
    pWaveDetected = true;
    gapAfterP     = false;
  }

  // Mark the quiet gap once the P coda dies down (at least 250 ms after P).
  if (pWaveDetected && !sWaveDetected &&
      mergedAccelR < QUIET_RATIO && (millis() - pWaveTime) > 250UL) {
    gapAfterP = true;
  }

  bool sOnset = (gyroT && gyroR >= S_RATIO_MIN) ||
                (gapAfterP && mergedAccelR >= S_RATIO_MIN);

  if (sOnset && pWaveDetected && !sWaveDetected) {
    sWaveTime     = millis();
    sWaveDetected = true;
  }
  if (pWaveDetected && !sWaveDetected &&
      millis() - pWaveTime > 30000UL) {
    pWaveDetected = false;
    gapAfterP     = false;
  }

  // ── Classification ─────────────────────────────────────────────
  char newClass[32];
  classifyEvent(adxlT, lisT, gyroT, newClass, sizeof(newClass));

  if (strcmp(newClass, "Normal") != 0) {
    quakeActive = true;
    if (strcmp(newClass, eventClass) != 0) {
      float dist  = estimateDistance();
      float peakG = adxlCond > lisCond ? adxlCond : lisCond;
      float pga   = getPGA_cms2(peakG);
      float mag   = estimateMagnitude(pga, dist);

      char entry[64];
      if (dist > 0.0f && mag > 0.0f)
        snprintf(entry, sizeof(entry), "%s%s D:%.0fkm M:%.1f",
                 shakerRunning ? "[SIM] " : "", newClass, (double)dist, (double)mag);
      else
        snprintf(entry, sizeof(entry), "%s%s",
                 shakerRunning ? "[SIM] " : "", newClass);

      strncpy(alertLog[alertIndex], entry, sizeof(alertLog[alertIndex]) - 1);
      alertLog[alertIndex][sizeof(alertLog[alertIndex]) - 1] = '\0';
      alertIndex = (alertIndex + 1) % LOG_SIZE;
      if (alertCount < LOG_SIZE) alertCount++;

      Serial.print("EVENT: "); Serial.println(newClass);
      BT.print("EVENT: "); BT.println(newClass);

      if (!pendingEventUpload &&
          millis() - lastEventUpload > EVENT_COOLDOWN_MS) {
        strncpy(pendingEvent.classification, newClass,
                sizeof(pendingEvent.classification) - 1);
        pendingEvent.pga         = pga;
        pendingEvent.magnitude   = mag;
        pendingEvent.distance_km = dist;
        pendingEvent.confidence  = classConfidence(newClass);
        pendingEvent.pWaveMs     = pWaveDetected ? pWaveTime : 0;
        pendingEvent.sWaveMs     = sWaveDetected ? sWaveTime : 0;
        pendingEvent.durationMs  = 0;
        pendingEvent.isFalseTrigger = false;
        pendingEvent.timestampMs = millis();
        // Carry the STA/LTA ratios that triggered this classification
        // through to earthquake_history (previously dropped — see the
        // EventSnapshot struct comment above).
        pendingEvent.adxlStalta  = adxlR;
        pendingEvent.lisStalta   = lisR;
        pendingEvent.mpuStalta   = gyroR;
        snprintf(pendingEvent.eventId, sizeof(pendingEvent.eventId),
                 "%s-%lu", SUPABASE_STATION_ID,
                 (unsigned long)pendingEvent.timestampMs);

        int n = capCount < WAVE_CAP_SIZE ? capCount : WAVE_CAP_SIZE;
        pendingEvent.sampleCount = n;
        for (int i = 0; i < n; i++) {
          int idx = (capIndex - n + i + WAVE_CAP_SIZE) % WAVE_CAP_SIZE;
          pendingAdxlSamples[i] = capAdxl[idx];
          pendingLisSamples [i] = capLis [idx];
          pendingMpuSamples [i] = capMpu [idx];
        }
        float pk = 0;
        for (int i = 0; i < n; i++) {
          if (pendingAdxlSamples[i] > pk) pk = pendingAdxlSamples[i];
        }
        pendingEvent.peakAmplitude = pk;
        pendingEventUpload         = true;
        pendingWaveformUpload      = true;
      }
    }
  } else {
    if (quakeActive && pendingEventUpload) {
      pendingEvent.durationMs = millis() - pendingEvent.timestampMs;
    }
    quakeActive   = false;
    pWaveDetected = false;
    sWaveDetected = false;
    gapAfterP     = false;
    updateAdaptiveStats(adxlR, adxlRatioMean, adxlRatioVar);
    updateAdaptiveStats(lisR,  lisRatioMean,  lisRatioVar);
    updateAdaptiveStats(gyroR, gyroRatioMean, gyroRatioVar);
    if (adaptSampleCount < 0xFFFFFFFFUL) adaptSampleCount++;
  }

  // ── Alert outputs: LED + buzzer tied to the live trace ─────────
  // The helicorder on the dashboard is driven by the merged STA/LTA trigger
  // (any axis over threshold). Previously the LED was only toggled inside the
  // buzzer's 5 s cooldown gate, so it drifted out of sync with that trace —
  // the trace could show a trigger while the LED stayed dark, and vice-versa.
  // Now a single helper drives BOTH outputs from the same merged trigger, so
  // trace, LED and buzzer move together; the cooldown gates only the audible
  // beep so it doesn't drone, and the beep pitch scales with severity.
  updateAlertOutputs(confirmed, adxlR, lisR, gyroR,
                     adxlThresh, lisThresh, gyroThresh);

  strncpy(eventClass, newClass, sizeof(eventClass) - 1);

  // ── Update live globals ────────────────────────────────────────
  {
    float peakG    = adxlCond > lisCond ? adxlCond : lisCond;
    liveAdxlDelta  = adxlCond;
    liveLisDelta   = lisCond;
    liveGyroDelta  = gyroCond;
    liveAdxlRatio  = adxlR;
    liveLisRatio   = lisR;
    liveGyroRatio  = gyroR;
    liveAdxlThresh = adxlThresh;
    liveLisThresh  = lisThresh;
    liveGyroThresh = gyroThresh;
    liveAdxlTrig   = adxlT;
    liveLisTrig    = lisT;
    liveGyroTrig   = gyroT;
    livePga        = getPGA_cms2(peakG);
    liveDistance   = estimateDistance();
    liveMagnitude  = estimateMagnitude(livePga, liveDistance);
    liveSampleMs   = millis();
    pushWebWaveform(adxlCond, gyroCond);
  }

  // ── Seismic waveform Serial output (Serial Plotter) ────────────
  // Signed, offset-free signal per sensor = filtered - drift (the high-pass
  // output, centred at zero after calibration), normalised by that sensor's
  // calibration rest-noise so all three share one comparable scale. Clamped so
  // a single large spike can't crush the plot's auto-scale.
  float adxlN = constrain((adxlFilt - adxlDrift) / adxlRestNoise, -50.0f, 50.0f);
  float lisN  = constrain((lisFilt  - lisDrift)  / lisRestNoise,  -50.0f, 50.0f);
  float gyroN = constrain((gyroFilt - gyroDrift) / gyroRestNoise, -50.0f, 50.0f);
  printSeismicWaveform(adxlN, lisN, gyroN, pWaveDetected, sWaveDetected);
  (void)adxlRawMag; (void)adxlMed;
  (void)lisRawMag;  (void)lisMed;
  (void)gyroRawMag; (void)gyroMed;
  (void)printOscilloscope;  // kept available; silence unused-function warning

  // ── Deferred Supabase uploads — enqueue, never block ──────────
  // Core 1 only builds the JSON and drops it in the queue.
  // Core 0 upload task does all TLS work asynchronously.
  if (millis() - lastLiveUpload > LIVE_UPLOAD_INTERVAL_MS) {
    lastLiveUpload = millis();
    updateCpuLoad();                // refresh cpu_load_pct before JSON build
    enqueueLive();                  // non-blocking; drops frame if full
  }

  if (pendingEventUpload && !quakeActive) {
    enqueueEvent(pendingEvent);     // waits max 100 ms then gives up
    lastEventUpload      = millis();
    pendingEventUpload   = false;
    pendingWaveformUpload = false;  // waveform bundled inside enqueueEvent
  }

  delay(10);  // ~100 Hz
}

/* ---------------------------------------------------------------------
   metrics-panel.js
   Renders the expanded metrics panels: Seismic Measurements, Detection
   Metrics, Waveform Metrics, Timing Metrics, Simulation Metrics,
   Alert & Health Metrics, Event Statistics.

   Fields backed by real Supabase/summary data render their value.
   Fields with no backend source yet render "Not wired yet" so nothing
   on screen looks like real telemetry when it isn't.

   This version is wired to the full supabase_schema.sql:
     - station_waveform: adxl345/lis3dh/mpu6050/unified_samples,
       p_wave_index, s_wave_index, surface_wave_index, peak_amplitude,
       waveform_confidence  -> summary.waveform (from server.py fetch_waveform)
     - station_live: simulation_phase, motor_pwm_level,
       simulation_progress, cpu_load_pct, cloud_sync_success_pct,
       battery_voltage
     - earthquake_history: event_duration_ms, is_false_trigger

   Depends on global `el()` and `fmt()` from app.js (loaded first).
--------------------------------------------------------------------- */

const NOT_WIRED = '<span class="not-wired">Not wired yet</span>';
const NOT_DETECTED = '<span class="not-wired">Not detected</span>';

function metricRow(label, value, unit) {
  const valueHtml = (value === null || value === undefined)
    ? NOT_WIRED
    : `${value}${unit ? ` <span class="metric-unit">${unit}</span>` : ''}`;
  return `<li><span class="metric-label">${label}</span><span class="metric-value">${valueHtml}</span></li>`;
}

// Like metricRow but uses NOT_DETECTED instead of NOT_WIRED for absent values.
// Use this for fields that ARE wired but simply weren't triggered this event.
function detectedRow(label, value, unit) {
  const valueHtml = (value === null || value === undefined)
    ? NOT_DETECTED
    : `${value}${unit ? ` <span class="metric-unit">${unit}</span>` : ''}`;
  return `<li><span class="metric-label">${label}</span><span class="metric-value">${valueHtml}</span></li>`;
}

function mmiRoman(mmi) {
  if (mmi === null || mmi === undefined || mmi < 0) return null;
  const numerals = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  const idx = Math.round(mmi);
  return numerals[idx] || String(mmi);
}

/* ---------------------------------------------------------------------
   Seismic Measurements (real: from summary.strongest / latest row)
--------------------------------------------------------------------- */

function renderSeismicMeasurements(summary, rows) {
  const card = document.getElementById('seismicMeasurementsCard');
  if (!card) return;
  const ref = (summary && summary.strongest) || rows[0] || null;

  const pga = ref && Number(ref.pga) >= 0 ? Number(ref.pga).toFixed(1) : null;
  const mmiVal = ref ? mmiRoman(Number(ref.mmi)) : null;
  const mag = ref && Number(ref.magnitude) >= 0 ? Number(ref.magnitude).toFixed(1) : null;
  const dist = ref && Number(ref.distance_km) >= 0 ? Number(ref.distance_km).toFixed(1) : null;
  const verr = ref && Number(ref.validation_error) >= 0 ? Number(ref.validation_error).toFixed(1) : null;

  card.innerHTML = `
    <span class="eyebrow">Seismic measurements</span>
    <ul class="metric-list">
      ${metricRow('PGA (Peak Ground Acceleration)', pga, 'cm/s&sup2;')}
      ${metricRow('MMI (Modified Mercalli Intensity)', mmiVal, null)}
      ${metricRow('Magnitude estimate', mag, 'Mw')}
      ${metricRow('Distance estimate', dist, 'km')}
      ${metricRow('Validation error', verr, '%')}
    </ul>
  `;
}

/* ---------------------------------------------------------------------
   Detection Metrics (real: STA/LTA ratios + sensorAgreement + confidence)
--------------------------------------------------------------------- */

function renderDetectionMetrics(summary, rows) {
  const card = document.getElementById('detectionMetricsCard');
  if (!card) return;
  const ref = (summary && summary.strongest) || rows[0] || null;

  const adxl = ref && Number(ref.adxl345_stalta) >= 0 ? Number(ref.adxl345_stalta).toFixed(2) : null;
  const lis = ref && Number(ref.lis3dh_stalta) >= 0 ? Number(ref.lis3dh_stalta).toFixed(2) : null;
  const mpu = ref && Number(ref.mpu6050_stalta) >= 0 ? Number(ref.mpu6050_stalta).toFixed(2) : null;

  const agreement = summary && summary.sensorAgreement;
  const agreementVal = agreement && agreement.available ? agreement.agreementScore.toFixed(0) : null;

  const confidence = summary && summary.confidence;
  const confidenceVal = confidence && confidence.score !== null && confidence.score !== undefined
    ? confidence.score.toFixed(0) : null;

  card.innerHTML = `
    <span class="eyebrow">Detection metrics</span>
    <ul class="metric-list">
      ${metricRow('ADXL345 STA/LTA ratio', adxl, null)}
      ${metricRow('LIS3DH STA/LTA ratio', lis, null)}
      ${metricRow('MPU6050 STA/LTA ratio', mpu, null)}
      ${metricRow('Sensor agreement', agreementVal, '%')}
      ${metricRow('Detection confidence', confidenceVal, '%')}
    </ul>
  `;
}

/* ---------------------------------------------------------------------
   Waveform Metrics
   Wired to summary.waveform, populated by server.py's fetch_waveform()
   from station_waveform for the strongest earthquake_history event.

   States handled:
     1. summary.waveform is null + source is station_live
        → ESP32 doesn't write waveforms for live rows; explain this.
     2. summary.waveform is null + source is earthquake_history (or unknown)
        → waveform row doesn't exist yet for this event_id.
     3. summary.waveform exists but hasUsableData is false
        → row exists but all columns are null/empty (schema applied but
          ESP32 not yet sending raw samples).
     4. summary.waveform exists and hasUsableData is true
        → render everything we have; use NOT_DETECTED (not NOT_WIRED)
          for individual fields that are null — they're wired, just absent.

   Division-by-zero guard: sampleRateHz is null (not 0) when unknown,
   so indexToSeconds returns null rather than Infinity.
--------------------------------------------------------------------- */

function renderWaveformMetrics(summary) {
  const card = document.getElementById('waveformMetricsCard');
  if (!card) return;

  const wf = summary && summary.waveform;
  const strongest = summary && summary.strongest;
  const strongestSource = strongest && strongest.source;

  // ── State 1: live-station row — waveform lookup not applicable ──
  if (!wf && strongestSource === 'station_live') {
    card.innerHTML = `
      <span class="eyebrow">Waveform metrics</span>
      <p class="widget-empty">
        Waveform data is only stored for confirmed earthquake_history events.
        The current strongest row is from station_live (no persistent event_id).
        Once the ESP32 logs a confirmed event to earthquake_history and writes
        raw samples to station_waveform with a matching event_id, this card
        will populate automatically.
      </p>
    `;
    return;
  }

  // ── State 2: history row but no waveform row in Supabase yet ──
  if (!wf) {
    const eventId = strongest && strongest.event_id ? strongest.event_id : null;
    card.innerHTML = `
      <span class="eyebrow">Waveform metrics</span>
      <p class="widget-empty">
        No station_waveform row found${eventId ? ` for event&nbsp;<code>${eventId}</code>` : ''}.
        Have the ESP32 INSERT a row into station_waveform with
        <code>event_id = '${eventId || '&lt;event_id&gt;'}'</code>
        and the raw adxl345_samples / lis3dh_samples / mpu6050_samples arrays
        to populate this card.
      </p>
    `;
    return;
  }

  // ── State 3: row exists but no usable data columns filled in yet ──
  if (!wf.hasUsableData) {
    card.innerHTML = `
      <span class="eyebrow">Waveform metrics</span>
      <p class="widget-empty">
        A station_waveform row exists for this event but all sample arrays and
        wave-marker columns are empty. The schema is applied — update the ESP32
        firmware to write adxl345_samples, lis3dh_samples, mpu6050_samples (as
        JSON arrays), p_wave_index, s_wave_index, and sample_rate_hz to fill
        this card.
      </p>
    `;
    return;
  }

  // ── State 4: real data present — render it ──

  const sampleRateHz = wf.sampleRateHz; // null if unknown/zero, never 0

  // Convert a sample index to seconds. Returns null (→ NOT_DETECTED) if:
  //   - index is null (wave not detected this event)
  //   - sampleRateHz is null/zero (rate not recorded)
  function indexToSeconds(idx) {
    if (idx === null || idx === undefined) return null;
    if (!sampleRateHz || sampleRateHz <= 0) return null;
    const secs = idx / sampleRateHz;
    // Extra sanity guard: Infinity or NaN means something went wrong
    if (!isFinite(secs)) return null;
    return secs.toFixed(2);
  }

  function channelStatus(samples) {
    if (Array.isArray(samples) && samples.length > 0) {
      return `${samples.length}\u202fsamples`;
    }
    return null; // renders as NOT_DETECTED (channel wired but empty this event)
  }

  const sampleRateDisplay = sampleRateHz ? Number(sampleRateHz).toFixed(0) : null;

  const pSec = indexToSeconds(wf.pWaveIndex);
  const sSec = indexToSeconds(wf.sWaveIndex);
  const surfaceSec = indexToSeconds(wf.surfaceWaveIndex);

  // P–S gap: only meaningful when both are present AND sample rate is known
  let gap = null;
  if (pSec !== null && sSec !== null) {
    const gapVal = Number(sSec) - Number(pSec);
    gap = isFinite(gapVal) ? gapVal.toFixed(2) : null;
  }

  const peakAmp = wf.peakAmplitude !== null && wf.peakAmplitude !== undefined && wf.peakAmplitude >= 0
    ? Number(wf.peakAmplitude).toFixed(2) : null;
  const wfConf = wf.waveformConfidence !== null && wf.waveformConfidence !== undefined && wf.waveformConfidence >= 0
    ? Number(wf.waveformConfidence).toFixed(0) : null;

  // If sampleRate is missing we can still show markers as raw indices
  function indexDisplay(idx) {
    if (idx === null || idx === undefined) return null;
    if (!sampleRateHz) return `sample\u202f#${idx}`;
    return indexToSeconds(idx); // already a string or null
  }
  const indexUnit = sampleRateHz ? 's' : null;

  card.innerHTML = `
    <span class="eyebrow">Waveform metrics</span>
    <ul class="metric-list">
      ${metricRow('Sample rate', sampleRateDisplay, 'Hz')}
      ${detectedRow('ADXL345 waveform', channelStatus(wf.adxl345Samples), null)}
      ${detectedRow('LIS3DH waveform', channelStatus(wf.lis3dhSamples), null)}
      ${detectedRow('MPU6050 waveform', channelStatus(wf.mpu6050Samples), null)}
      ${detectedRow('Unified seismic waveform', channelStatus(wf.unifiedSamples), null)}
      ${detectedRow('P-wave marker', indexDisplay(wf.pWaveIndex), indexUnit)}
      ${detectedRow('S-wave marker', indexDisplay(wf.sWaveIndex), indexUnit)}
      ${detectedRow('Surface wave marker', indexDisplay(wf.surfaceWaveIndex), indexUnit)}
      ${detectedRow('Peak amplitude', peakAmp, null)}
      ${detectedRow('P&ndash;S gap', gap, sampleRateHz ? 's' : null)}
      ${detectedRow('Waveform confidence', wfConf, '%')}
    </ul>
  `;
}

/* ---------------------------------------------------------------------
   Timing Metrics
   P/S arrival come from the strongest row's p_wave_ms/s_wave_ms.
   Event duration now wired to earthquake_history.event_duration_ms
   (normalize_history_event in server.py exposes it as
   event_duration_ms on history rows). System uptime is wired when the
   reference row is a live station_live row, which carries
   system_uptime_ms.
--------------------------------------------------------------------- */

function renderTimingMetrics(summary, rows) {
  const card = document.getElementById('timingMetricsCard');
  if (!card) return;
  const ref = (summary && summary.strongest) || rows[0] || null;

  const pMs = ref ? Number(ref.p_wave_ms) : null;
  const sMs = ref ? Number(ref.s_wave_ms) : null;
  const hasP = pMs !== null && !Number.isNaN(pMs) && pMs > 0;
  const hasS = sMs !== null && !Number.isNaN(sMs) && sMs > 0;

  const pArrival = hasP ? (pMs / 1000).toFixed(2) : null;
  const sArrival = hasS ? (sMs / 1000).toFixed(2) : null;
  const gap = hasP && hasS ? ((sMs - pMs) / 1000).toFixed(2) : null;

  const durationMs = ref ? Number(ref.event_duration_ms) : null;
  const duration = durationMs !== null && !Number.isNaN(durationMs) && durationMs > 0
    ? (durationMs / 1000).toFixed(2) : null;

  const uptimeMs = ref ? Number(ref.system_uptime_ms) : null;
  const hasUptime = uptimeMs !== null && !Number.isNaN(uptimeMs) && uptimeMs >= 0;
  const uptime = hasUptime ? formatHms(uptimeMs) : null;

  card.innerHTML = `
    <span class="eyebrow">Timing metrics</span>
    <ul class="metric-list">
      ${metricRow('P-wave arrival time', pArrival, 's')}
      ${metricRow('S-wave arrival time', sArrival, 's')}
      ${metricRow('P&ndash;S gap', gap, 's')}
      ${metricRow('Event duration', duration, 's')}
      ${metricRow('System uptime', uptime, null)}
    </ul>
  `;
}

function formatHms(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/* ---------------------------------------------------------------------
   Simulation Metrics
   Now wired to station_live.simulation_phase / motor_pwm_level /
   simulation_progress. Only meaningful for live rows (source ===
   'station_live') -- history rows from earthquake_history don't carry
   simulator state, so this card always looks at the most recent live
   row regardless of what's flagged as "strongest".
--------------------------------------------------------------------- */

function renderSimulationMetrics(rows) {
  const card = document.getElementById('simulationMetricsCard');
  if (!card) return;
  const liveRef = rows.find(r => r.source === 'station_live') || null;

  const phase = liveRef && liveRef.simulation_phase != null ? liveRef.simulation_phase : null;
  const pwmRaw = liveRef ? Number(liveRef.motor_pwm_level) : NaN;
  const pwm = !Number.isNaN(pwmRaw) && pwmRaw >= 0 ? pwmRaw : null;
  const progressRaw = liveRef ? Number(liveRef.simulation_progress) : NaN;
  const progress = !Number.isNaN(progressRaw) && progressRaw >= 0
    ? progressRaw.toFixed(0) : null;

  card.innerHTML = `
    <span class="eyebrow">Simulation metrics</span>
    <ul class="metric-list">
      ${metricRow('Simulation phase', phase, null)}
      ${metricRow('Motor PWM level', pwm, '0&ndash;255')}
      ${metricRow('Simulation progress', progress, '%')}
    </ul>
  `;
}

/* ---------------------------------------------------------------------
   Alert & Health Metrics
   Now wired to station_live.cpu_load_pct, cloud_sync_success_pct,
   battery_voltage, in addition to the existing wifi_rssi/free_heap.
--------------------------------------------------------------------- */

function renderHealthMetrics(rows) {
  const card = document.getElementById('healthMetricsCard');
  if (!card) return;
  const liveRef = rows.find(r => r.source === 'station_live') || null;

  // wifi_rssi: valid readings are negative dBm (e.g. -60). DB default is 0,
  // which is not a real reading. Treat 0 and anything > 0 as missing.
  const rssiRaw = liveRef ? Number(liveRef.wifi_rssi) : NaN;
  const rssi = !Number.isNaN(rssiRaw) && rssiRaw < 0 ? rssiRaw : null;

  // free_heap: valid when > 0 (DB default 0 = not populated yet).
  const heapRaw = liveRef ? Number(liveRef.free_heap) : NaN;
  const heap = !Number.isNaN(heapRaw) && heapRaw > 0
    ? (heapRaw / 1024).toFixed(1) : null;

  const cpuLoad = liveRef && Number(liveRef.cpu_load_pct) >= 0
    ? Number(liveRef.cpu_load_pct).toFixed(0) : null;
  const syncRate = liveRef && Number(liveRef.cloud_sync_success_pct) >= 0
    ? Number(liveRef.cloud_sync_success_pct).toFixed(0) : null;
  const battery = liveRef && Number(liveRef.battery_voltage) >= 0
    ? Number(liveRef.battery_voltage).toFixed(2) : null;

  card.innerHTML = `
    <span class="eyebrow">Alert &amp; health metrics</span>
    <ul class="metric-list">
      ${metricRow('WiFi signal strength', rssi, 'dBm')}
      ${metricRow('ESP32 free memory', heap, 'KB')}
      ${metricRow('CPU load', cpuLoad, '%')}
      ${metricRow('Cloud sync success rate', syncRate, '%')}
      ${metricRow('Battery voltage', battery, 'V')}
    </ul>
  `;
}

/* ---------------------------------------------------------------------
   Event Statistics
   Now wired to is_false_trigger via summary.falseTriggerCount, which
   server.py's summarize_events() computes by counting rows where
   is_false_trigger is true.
--------------------------------------------------------------------- */

function renderEventStatistics(summary, rows) {
  const card = document.getElementById('eventStatisticsCard');
  if (!card) return;

  const total = rows.length;
  const confirmed = rows.filter(r => r.classification === 'Confirmed Seismic Event').length;

  const falseTriggers = summary && Number.isFinite(summary.falseTriggerCount)
    ? summary.falseTriggerCount : null;

  const pgaVals = rows.map(r => Number(r.pga)).filter(v => v >= 0);
  const avgPga = pgaVals.length ? (pgaVals.reduce((a, b) => a + b, 0) / pgaVals.length).toFixed(1) : null;
  const highPga = pgaVals.length ? Math.max(...pgaVals).toFixed(1) : null;

  const magVals = rows.map(r => Number(r.magnitude)).filter(v => v >= 0);
  const avgMag = magVals.length ? (magVals.reduce((a, b) => a + b, 0) / magVals.length).toFixed(1) : null;
  const largeMag = magVals.length ? Math.max(...magVals).toFixed(1) : null;

  const distVals = rows.map(r => Number(r.distance_km)).filter(v => v >= 0);
  const avgDist = distVals.length ? (distVals.reduce((a, b) => a + b, 0) / distVals.length).toFixed(1) : null;

  card.innerHTML = `
    <span class="eyebrow">Event statistics</span>
    <ul class="metric-list">
      ${metricRow('Total events', total, null)}
      ${metricRow('Confirmed events', confirmed, null)}
      ${metricRow('False triggers', falseTriggers, null)}
      ${metricRow('Average PGA', avgPga, 'cm/s&sup2;')}
      ${metricRow('Highest PGA', highPga, 'cm/s&sup2;')}
      ${metricRow('Average magnitude', avgMag, null)}
      ${metricRow('Largest magnitude', largeMag, null)}
      ${metricRow('Average distance', avgDist, 'km')}
    </ul>
  `;
}

/* ---------------------------------------------------------------------
   Entry point, called from app.js render()
--------------------------------------------------------------------- */

function renderExpandedMetrics(summary, rows) {
  renderSeismicMeasurements(summary, rows);
  renderDetectionMetrics(summary, rows);
  renderWaveformMetrics(summary);
  renderTimingMetrics(summary, rows);
  renderSimulationMetrics(rows);
  renderHealthMetrics(rows);
  renderEventStatistics(summary, rows);
}

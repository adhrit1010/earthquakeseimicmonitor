/* ---------------------------------------------------------------------
   metrics-panel.js
   Renders the expanded metrics panels: Seismic Measurements, Detection
   Metrics, Timing Metrics, Event Statistics.

   Fields backed by real Supabase/summary data render their value.
   Fields with no backend source yet render "Not wired yet" so nothing
   on screen looks like real telemetry when it isn't.

   This version is wired to the full supabase_schema.sql:
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

// A short, field-engineer-oriented interpretation note shown under a panel.
// Kept factual and tied to what the panel actually displays.
function metricNote(html) {
  return `<p class="metric-note">${html}</p>`;
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
    ${metricNote(
      '<strong>Engineer note:</strong> these describe the single strongest event in the ' +
      'window. MMI&nbsp;&ge;&nbsp;V is generally the threshold for being felt indoors; PGA and ' +
      'MMI should move together. Magnitude here is a coarse PGA/distance estimate from a demo ' +
      'array &mdash; treat it as order-of-magnitude, and trust it more when validation error is low.'
    )}
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

  // NOTE: "Sensor agreement" and "Detection confidence" were removed here —
  // they duplicated the dedicated Sensor-correlation and Seismic-confidence
  // cards (which read the same summary.sensorAgreement / summary.confidence).
  // This panel now shows only the three raw per-sensor STA/LTA ratios.
  card.innerHTML = `
    <span class="eyebrow">Detection metrics</span>
    <ul class="metric-list">
      ${metricRow('ADXL345 STA/LTA ratio', adxl, null)}
      ${metricRow('LIS3DH STA/LTA ratio', lis, null)}
      ${metricRow('MPU6050 STA/LTA ratio', mpu, null)}
    </ul>
    ${metricNote(
      '<strong>Engineer note:</strong> STA/LTA is the short- vs long-term energy ratio. ' +
      '&asymp;1.0 is background noise; a trigger typically fires around 2.5&ndash;4&times;. ' +
      'Look for all three sensors rising together &mdash; a single channel spiking alone is ' +
      'usually a local knock or instrument noise, not ground motion.'
    )}
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
  const hasUptime = uptimeMs !== null && !Number.isNaN(uptimeMs) && uptimeMs > 0;
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
    ${metricNote(
      '<strong>Engineer note:</strong> the P&ndash;S gap sets epicentral distance &mdash; ' +
      'rule of thumb, distance&nbsp;(km)&nbsp;&asymp;&nbsp;(S&minus;P seconds)&nbsp;&times;&nbsp;8. ' +
      'A clean P-then-S ordering with a positive gap is the signature of a real teleseism; ' +
      'no gap (P or S only) means distance can&rsquo;t be resolved from this event.'
    )}
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
   Event Statistics
   Now wired to is_false_trigger via summary.falseTriggerCount, which
   server.py's summarize_events() computes by counting rows where
   is_false_trigger is true.
--------------------------------------------------------------------- */

function renderEventStatistics(summary, rows) {
  const card = document.getElementById('eventStatisticsCard');
  if (!card) return;

  const confirmed = rows.filter(r => r.classification === 'Confirmed Seismic Event').length;

  const falseTriggers = summary && Number.isFinite(summary.falseTriggerCount)
    ? summary.falseTriggerCount : null;

  const pgaVals = rows.map(r => Number(r.pga)).filter(v => v >= 0);
  const avgPga = pgaVals.length ? (pgaVals.reduce((a, b) => a + b, 0) / pgaVals.length).toFixed(1) : null;

  const magVals = rows.map(r => Number(r.magnitude)).filter(v => v >= 0);
  const avgMag = magVals.length ? (magVals.reduce((a, b) => a + b, 0) / magVals.length).toFixed(1) : null;

  const distVals = rows.map(r => Number(r.distance_km)).filter(v => v >= 0);
  const avgDist = distVals.length ? (distVals.reduce((a, b) => a + b, 0) / distVals.length).toFixed(1) : null;

  // NOTE: "Total events", "Highest PGA" and "Largest magnitude" were removed —
  // they duplicate the Events-loaded, Peak-PGA and Max-magnitude gauges at the
  // top of the dashboard. This panel now carries only window-level aggregates
  // that aren't shown elsewhere.
  card.innerHTML = `
    <span class="eyebrow">Event statistics</span>
    <ul class="metric-list">
      ${metricRow('Confirmed events', confirmed, null)}
      ${metricRow('False triggers', falseTriggers, null)}
      ${metricRow('Average PGA', avgPga, 'cm/s&sup2;')}
      ${metricRow('Average magnitude', avgMag, null)}
      ${metricRow('Average distance', avgDist, 'km')}
    </ul>
    ${metricNote(
      '<strong>Engineer note:</strong> watch the false-trigger count against confirmed ' +
      'events &mdash; a rising ratio means thresholds are set too low. Compare these window ' +
      'averages with the Peak-PGA / Max-magnitude gauges above to see how much a single ' +
      'event dominates the record.'
    )}
  `;
}

/* ---------------------------------------------------------------------
   Entry point, called from app.js render()
--------------------------------------------------------------------- */

/* ---------------------------------------------------------------------
   Station / Sensor health (real: summary.health from latest live row)
--------------------------------------------------------------------- */

function healthBar(score) {
  if (score === null || score === undefined) return '';
  const pct = Math.max(0, Math.min(100, score));
  return `<div class="quality-bar"><div class="quality-bar-fill" style="width:${pct}%"></div></div>`;
}

function renderStationHealth(summary) {
  const card = document.getElementById('stationHealthCard');
  if (!card) return;
  const h = summary && summary.health;

  if (!h || !h.available) {
    card.innerHTML = `
      <span class="eyebrow">Station health</span>
      <p class="widget-empty">No live station data yet — health appears once the ESP32 is streaming to station_live.</p>
    `;
    return;
  }

  const num = (v, d = 0) => (v === null || v === undefined) ? null : Number(v).toFixed(d);
  const score = h.score == null ? null : Number(h.score).toFixed(0);
  const heapKb = h.freeHeap == null ? null : (Number(h.freeHeap) / 1024).toFixed(1);
  const battery = h.battery == null ? 'USB power' : `${Number(h.battery).toFixed(2)} V`;
  const scores = h.sensorScores || {};
  const pct = v => v == null ? null : (Number(v) * 100).toFixed(0);

  card.innerHTML = `
    <span class="eyebrow">Station health</span>
    <div class="agreement-score">
      <span class="agreement-value">${score == null ? '—' : score + '%'}</span>
      <span class="agreement-key">overall health</span>
    </div>
    ${healthBar(h.score)}
    <ul class="metric-list">
      ${metricRow('WiFi signal (RSSI)', num(h.wifiRssi), 'dBm')}
      ${metricRow('Free heap', heapKb, 'KB')}
      ${metricRow('CPU load', num(h.cpuLoad), '%')}
      ${metricRow('Cloud sync success', num(h.cloudSync), '%')}
      ${detectedRow('Battery', battery, null)}
      ${metricRow('ADXL345 sensor score', pct(scores.adxl345), '%')}
      ${metricRow('LIS3DH sensor score', pct(scores.lis3dh), '%')}
      ${metricRow('MPU6050 sensor score', pct(scores.mpu6050), '%')}
    </ul>
    ${metricNote(
      '<strong>Engineer note:</strong> RSSI better than &minus;70 dBm and CPU load ' +
      'under ~60% keep uploads timely; sensor scores near 100% mean each axis is ' +
      'tracking the others. A falling cloud-sync % points to WiFi or heap pressure ' +
      'on the station, not a seismic issue.'
    )}
  `;
}

function renderExpandedMetrics(summary, rows) {
  renderSeismicMeasurements(summary, rows);
  renderDetectionMetrics(summary, rows);
  renderTimingMetrics(summary, rows);
  renderEventStatistics(summary, rows);
  renderStationHealth(summary);
}

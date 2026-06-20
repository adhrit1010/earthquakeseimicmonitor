/* ---------------------------------------------------------------------
   metrics-panel.js
   Renders the expanded metrics panels: Seismic Measurements, Detection
   Metrics, Waveform Metrics, Timing Metrics, Simulation Metrics,
   Alert & Health Metrics, Event Statistics.

   Fields backed by real Supabase/summary data render their value.
   Fields with no backend source yet render "Not wired yet" so nothing
   on screen looks like real telemetry when it isn't.

   Depends on global `el()` and `fmt()` from app.js (loaded first).
--------------------------------------------------------------------- */

const NOT_WIRED = '<span class="not-wired">Not wired yet</span>';

function metricRow(label, value, unit) {
  const valueHtml = (value === null || value === undefined)
    ? NOT_WIRED
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
    <p class="widget-note">From the strongest event in the loaded window, or the most recent row if no summary is available.</p>
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
    <p class="widget-note">STA/LTA ratios from the strongest event; agreement and confidence are window-wide.</p>
  `;
}

/* ---------------------------------------------------------------------
   Waveform Metrics (not wired: schema stores STA/LTA ratios, not raw
   waveform sample arrays, so there is nothing real to plot here yet)
--------------------------------------------------------------------- */

function renderWaveformMetrics() {
  const card = document.getElementById('waveformMetricsCard');
  if (!card) return;
  card.innerHTML = `
    <span class="eyebrow">Waveform metrics</span>
    <ul class="metric-list">
      ${metricRow('ADXL345 waveform', null, null)}
      ${metricRow('LIS3DH waveform', null, null)}
      ${metricRow('MPU6050 waveform', null, null)}
      ${metricRow('Unified seismic waveform', null, null)}
      ${metricRow('P-wave marker', null, null)}
      ${metricRow('S-wave marker', null, null)}
      ${metricRow('Surface wave marker', null, null)}
      ${metricRow('Peak amplitude', null, null)}
      ${metricRow('P&ndash;S gap', null, 's')}
      ${metricRow('Waveform confidence', null, '%')}
    </ul>
    <p class="widget-note">Requires raw waveform sample arrays from the ESP32 &mdash; the current schema stores only STA/LTA ratios, not the underlying signal.</p>
  `;
}

/* ---------------------------------------------------------------------
   Timing Metrics (real: p_wave_ms / s_wave_ms when present; rest unwired)
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

  card.innerHTML = `
    <span class="eyebrow">Timing metrics</span>
    <ul class="metric-list">
      ${metricRow('P-wave arrival time', pArrival, 's')}
      ${metricRow('S-wave arrival time', sArrival, 's')}
      ${metricRow('P&ndash;S gap', gap, 's')}
      ${metricRow('Event duration', null, 's')}
      ${metricRow('System uptime', null, 'hh:mm:ss')}
    </ul>
    <p class="widget-note">P/S arrival times come from the strongest event's recorded timestamps. Event duration and uptime need new ESP32 fields.</p>
  `;
}

/* ---------------------------------------------------------------------
   Simulation Metrics (not wired: ESP32 doesn't report simulator phase/PWM)
--------------------------------------------------------------------- */

function renderSimulationMetrics() {
  const card = document.getElementById('simulationMetricsCard');
  if (!card) return;
  card.innerHTML = `
    <span class="eyebrow">Simulation metrics</span>
    <ul class="metric-list">
      ${metricRow('Simulation phase', null, null)}
      ${metricRow('Motor PWM level', null, '0&ndash;255')}
      ${metricRow('Simulation progress', null, '%')}
    </ul>
    <p class="widget-note">Phase options: Idle, P-Wave, Gap, S-Wave, Surface Wave, Decay. Needs the ESP32 to report current shaker-simulator state.</p>
  `;
}

/* ---------------------------------------------------------------------
   Alert & Health Metrics (real: wifi_rssi / free_heap when present on
   live station rows; rest unwired)
--------------------------------------------------------------------- */

function renderHealthMetrics(rows) {
  const card = document.getElementById('healthMetricsCard');
  if (!card) return;
  const liveRef = rows.find(r => r.source === 'station_live') || null;

  const rssi = liveRef && liveRef.wifi_rssi !== undefined && liveRef.wifi_rssi !== null
    ? Number(liveRef.wifi_rssi) : null;
  const heap = liveRef && liveRef.free_heap !== undefined && liveRef.free_heap !== null
    ? (Number(liveRef.free_heap) / 1024).toFixed(1) : null;

  card.innerHTML = `
    <span class="eyebrow">Alert &amp; health metrics</span>
    <ul class="metric-list">
      ${metricRow('WiFi signal strength', rssi, 'dBm')}
      ${metricRow('ESP32 free memory', heap, 'KB')}
      ${metricRow('CPU load', null, '%')}
      ${metricRow('Cloud sync success rate', null, '%')}
      ${metricRow('Battery voltage', null, 'V')}
    </ul>
    <p class="widget-note">WiFi RSSI and free memory come from the most recent live station row. CPU load, sync rate, and battery need new ESP32/backend fields.</p>
  `;
}

/* ---------------------------------------------------------------------
   Event Statistics (real: derived from the loaded rows window)
--------------------------------------------------------------------- */

function renderEventStatistics(summary, rows) {
  const card = document.getElementById('eventStatisticsCard');
  if (!card) return;

  const total = rows.length;
  const confirmed = rows.filter(r => r.classification === 'Confirmed Seismic Event').length;

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
      ${metricRow('False triggers', null, null)}
      ${metricRow('Average PGA', avgPga, 'cm/s&sup2;')}
      ${metricRow('Highest PGA', highPga, 'cm/s&sup2;')}
      ${metricRow('Average magnitude', avgMag, null)}
      ${metricRow('Largest magnitude', largeMag, null)}
      ${metricRow('Average distance', avgDist, 'km')}
    </ul>
    <p class="widget-note">Computed from all events currently loaded in this window. "False triggers" needs an explicit rejected/false-positive flag from the backend.</p>
  `;
}

/* ---------------------------------------------------------------------
   Entry point, called from app.js render()
--------------------------------------------------------------------- */

function renderExpandedMetrics(summary, rows) {
  renderSeismicMeasurements(summary, rows);
  renderDetectionMetrics(summary, rows);
  renderWaveformMetrics();
  renderTimingMetrics(summary, rows);
  renderSimulationMetrics();
  renderHealthMetrics(rows);
  renderEventStatistics(summary, rows);
}

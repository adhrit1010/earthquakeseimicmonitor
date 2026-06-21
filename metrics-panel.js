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
   Now wired to summary.waveform, which server.py's fetch_waveform()
   populates from station_waveform for the strongest event:
     adxl345Samples, lis3dhSamples, mpu6050Samples, unifiedSamples,
     pWaveIndex, sWaveIndex, surfaceWaveIndex,
     peakAmplitude, waveformConfidence, sampleRateHz

   Sample arrays themselves aren't itemized as metric rows (they're
   raw signal data, not a single value) -- this renders the markers
   derived from them plus a presence indicator for each channel's
   array, so the card honestly reflects what's actually in Supabase.
--------------------------------------------------------------------- */

function renderWaveformMetrics(summary) {
  const card = document.getElementById('waveformMetricsCard');
  if (!card) return;
  const wf = summary && summary.waveform;

  if (!wf) {
    card.innerHTML = `
      <span class="eyebrow">Waveform metrics</span>
      <p class="widget-empty">No station_waveform row for this event yet &mdash; point the ESP32's raw adxl345/lis3dh/mpu6050 sample writes at this event_id to populate it.</p>
    `;
    return;
  }

  const channelStatus = (samples) =>
    Array.isArray(samples) && samples.length ? `${samples.length} samples` : null;

  const sampleRate = Number(wf.sampleRateHz) > 0 ? Number(wf.sampleRateHz).toFixed(0) : null;

  const indexToSeconds = (idx) => {
    if (idx === null || idx === undefined || idx < 0 || !sampleRate) return null;
    return (idx / Number(wf.sampleRateHz)).toFixed(2);
  };

  const pMarker = indexToSeconds(wf.pWaveIndex);
  const sMarker = indexToSeconds(wf.sWaveIndex);
  const surfaceMarker = indexToSeconds(wf.surfaceWaveIndex);
  const gap = (pMarker !== null && sMarker !== null)
    ? (Number(sMarker) - Number(pMarker)).toFixed(2)
    : null;

  const peakAmp = Number(wf.peakAmplitude) >= 0 ? Number(wf.peakAmplitude).toFixed(2) : null;
  const wfConfidence = Number(wf.waveformConfidence) >= 0 ? Number(wf.waveformConfidence).toFixed(0) : null;

  card.innerHTML = `
    <span class="eyebrow">Waveform metrics</span>
    <ul class="metric-list">
      ${metricRow('Sample rate', sampleRate, 'Hz')}
      ${metricRow('ADXL345 waveform', channelStatus(wf.adxl345Samples), null)}
      ${metricRow('LIS3DH waveform', channelStatus(wf.lis3dhSamples), null)}
      ${metricRow('MPU6050 waveform', channelStatus(wf.mpu6050Samples), null)}
      ${metricRow('Unified seismic waveform', channelStatus(wf.unifiedSamples), null)}
      ${metricRow('P-wave marker', pMarker, 's')}
      ${metricRow('S-wave marker', sMarker, 's')}
      ${metricRow('Surface wave marker', surfaceMarker, 's')}
      ${metricRow('Peak amplitude', peakAmp, null)}
      ${metricRow('P&ndash;S gap', gap, 's')}
      ${metricRow('Waveform confidence', wfConfidence, '%')}
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

  const phase = liveRef && liveRef.simulation_phase ? liveRef.simulation_phase : null;
  const pwm = liveRef && Number(liveRef.motor_pwm_level) >= 0 ? Number(liveRef.motor_pwm_level) : null;
  const progress = liveRef && Number(liveRef.simulation_progress) >= 0
    ? Number(liveRef.simulation_progress).toFixed(0) : null;

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

  const rssi = liveRef && liveRef.wifi_rssi !== undefined && liveRef.wifi_rssi !== null
    ? Number(liveRef.wifi_rssi) : null;
  const heap = liveRef && liveRef.free_heap !== undefined && liveRef.free_heap !== null
    ? (Number(liveRef.free_heap) / 1024).toFixed(1) : null;
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

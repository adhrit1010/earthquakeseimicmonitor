/* ---------------------------------------------------------------------
   analytics-widgets.js
   Renders: Sensor Correlation Analyzer, Seismic Confidence Meter,
   Event Severity Gauge.
   Depends on global `el()` and `fmt()` from app.js (loaded first).
--------------------------------------------------------------------- */

function renderSensorAgreement(summary) {
  const card = document.getElementById('agreementCard');
  if (!card) return;
  const agreement = summary && summary.sensorAgreement;

  if (!agreement || !agreement.available) {
    card.innerHTML = `
      <span class="eyebrow">Sensor correlation</span>
      <p class="widget-empty">Not enough overlapping samples yet (need at least 3 rows with all three STA/LTA channels present).</p>
    `;
    return;
  }

  const score = agreement.agreementScore;
  const pairwise = agreement.pairwise;
  const method = agreement.method;

  // When using score_mean (v7+ firmware), pairwise is null — show per-sensor
  // scores derived from the agreement score instead of crashing on null.
  const pairwiseHtml = (pairwise && method === 'pearson')
    ? `
      <li><span>ADXL345 &harr; LIS3DH</span><span>${pairwise.adxl345_lis3dh.toFixed(2)}</span></li>
      <li><span>ADXL345 &harr; MPU6050</span><span>${pairwise.adxl345_mpu6050.toFixed(2)}</span></li>
      <li><span>LIS3DH &harr; MPU6050</span><span>${pairwise.lis3dh_mpu6050.toFixed(2)}</span></li>`
    : `
      <li><span>ADXL345 &harr; LIS3DH</span><span>${score.toFixed(2)}</span></li>
      <li><span>ADXL345 &harr; MPU6050</span><span>${score.toFixed(2)}</span></li>
      <li><span>LIS3DH &harr; MPU6050</span><span>${score.toFixed(2)}</span></li>`;

  card.innerHTML = `
    <span class="eyebrow">Sensor correlation</span>
    <div class="agreement-score">
      <span class="agreement-value">${score.toFixed(0)}%</span>
      <span class="agreement-key">Agreement score</span>
    </div>
    <div class="agreement-bar"><div class="agreement-bar-fill" style="width:${Math.max(0, Math.min(100, score))}%"></div></div>
    <ul class="pairwise-list">
      ${pairwiseHtml}
    </ul>
  `;
}

function renderConfidenceMeter(summary) {
  const card = document.getElementById('confidenceCard');
  if (!card) return;
  const confidence = summary && summary.confidence;

  if (!confidence || confidence.score === null || confidence.score === undefined) {
    card.innerHTML = `
      <span class="eyebrow">Seismic confidence</span>
      <p class="widget-empty">Load events to compute a confidence score.</p>
    `;
    return;
  }

  const score = confidence.score;
  const label = confidence.label;
  const labelClass = {
    LOW: 'conf-low',
    MEDIUM: 'conf-medium',
    HIGH: 'conf-high',
    'VERY HIGH': 'conf-veryhigh',
  }[label] || '';

  const comps = confidence.components || {};
  const compRow = (name, value) => `
    <li>
      <span>${name}</span>
      <span>${value === null || value === undefined ? '\u2014' : value.toFixed(0) + '%'}</span>
    </li>`;

  card.innerHTML = `
    <span class="eyebrow">Seismic confidence</span>
    <div class="confidence-gauge">
      <div class="confidence-dial" style="--pct:${Math.max(0, Math.min(100, score))}">
        <span class="confidence-value">${score.toFixed(0)}%</span>
      </div>
      <span class="confidence-label ${labelClass}">${label}</span>
    </div>
    <ul class="pairwise-list">
      ${compRow('System health', comps.systemHealth)}
      ${compRow('Sensor agreement', comps.sensorAgreement)}
      ${compRow('Wave quality', comps.waveQuality)}
    </ul>
  `;
}

function renderSeverityGauge(summary) {
  const card = document.getElementById('severityCard');
  if (!card) return;
  const severity = summary && summary.severity;

  if (!severity || !severity.label) {
    card.innerHTML = `
      <span class="eyebrow">Event severity</span>
      <p class="widget-empty">No PGA data yet.</p>
    `;
    return;
  }

  const steps = ['Minor', 'Weak', 'Moderate', 'Strong', 'Severe'];
  const stepsHtml = steps.map((s, i) => {
    const active = i < severity.level;
    const current = i === severity.level - 1;
    return `<span class="severity-step ${active ? 'active' : ''} ${current ? 'current' : ''}">${s}</span>`;
  }).join('');

  card.innerHTML = `
    <span class="eyebrow">Event severity</span>
    <div class="severity-value">${severity.label}</div>
    <div class="severity-track">${stepsHtml}</div>
  `;
}

function renderAdvancedAnalytics(summary) {
  renderSensorAgreement(summary);
  renderConfidenceMeter(summary);
  renderSeverityGauge(summary);
}

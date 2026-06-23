const state = {
  rows: [],
  summary: null,
  autoTimer: null,
  helicorderBuffer: [],   // rolling buffer of recent ratio samples for the live trace
  helicorderRaf: null,
  helicorderPollTimer: null,
  lastHelicorderFetchAt: 0,
};

const el = id => document.getElementById(id);
const fmt = (v, d = 1) => v === null || v === undefined || Number(v) < 0 ? '\u2014' : Number(v).toFixed(d);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Pull well beyond the old 500-row ceiling. The backend pages past the
// PostgREST per-request cap, so this can exceed 1000 too.
const EVENT_LIMIT = 2000;

function filters() {
  return {
    from: el('dateFrom').value,
    to: el('dateTo').value,
    classification: el('classification').value,
    limit: EVENT_LIMIT,
  };
}

function queryString(obj) {
  const params = new URLSearchParams();
  Object.entries(obj).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  });
  return params.toString();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function setCloud(ok, text) {
  const dot = el('cloudDot');
  dot.classList.remove('ok', 'bad');
  dot.classList.add(ok ? 'ok' : 'bad');
  el('cloudText').textContent = text;
}

/* ---------------------------------------------------------------------
   Helicorder: continuously sweeping trace, drum-recorder style.

   CHANGED FROM THE PREVIOUS VERSION:
   Previously this only pulled in real samples opportunistically, right
   after the full dashboard refresh (every 15s via setAutoRefresh), and
   spent the rest of its time injecting random ambient drift on every
   animation tick. That meant the trace was real data for a brief moment
   once every 15 seconds and synthetic noise the rest of the time --
   functionally disconnected from what the station was actually doing
   in between.

   Now the helicorder polls /api/events on its own short interval
   (HELICORDER_POLL_MS, independent of the slower full-dashboard
   autoRefresh) and pushes ONLY real merged STA/LTA samples into the
   buffer. Ambient drift is now used ONLY before any real data has
   arrived at all (so the trace isn't a flat dead line on first load),
   and is removed entirely the moment real samples exist.
--------------------------------------------------------------------- */

const HELICORDER_POLL_MS = 2000; // independent of the 15s full dashboard refresh
const HELICORDER_MAX_SAMPLES = 220;

function mergedRatio(row) {
  return Math.max(
    Number(row.adxl345_stalta || 0),
    Number(row.lis3dh_stalta || 0),
    Number(row.mpu6050_stalta || 0),
  );
}

function seedHelicorder(rows) {
  const chronological = rows.slice().reverse();
  const samples = chronological.slice(-120).map(mergedRatio).filter(v => v >= 0);
  state.helicorderBuffer = samples.length ? samples : [0, 0, 0, 0, 0];
}

function drawHelicorder() {
  const canvas = el('helicorderChart');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  // baseline grid (subtle horizontal divisions, like graticule paper)
  ctx.strokeStyle = 'rgba(232,228,216,0.05)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (rect.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(rect.width, y);
    ctx.stroke();
  }

  const buf = state.helicorderBuffer;
  if (buf.length < 2) return;
  const mid = rect.height / 2;
  const max = Math.max(2, ...buf.map(v => Math.abs(v - 1)) ) ;
  const scale = (rect.height * 0.42) / Math.max(0.5, max);

  // glow pass
  ctx.shadowColor = 'rgba(255,207,64,0.5)';
  ctx.shadowBlur = 6;
  ctx.strokeStyle = '#ffcf40';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  buf.forEach((v, i) => {
    const x = (i / (buf.length - 1)) * rect.width;
    const y = mid - (v - 1) * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;

  // bright head dot at the most recent sample
  const lastX = rect.width;
  const lastY = mid - (buf[buf.length - 1] - 1) * scale;
  ctx.fillStyle = '#ffe080';
  ctx.beginPath();
  ctx.arc(lastX - 2, lastY, 3, 0, Math.PI * 2);
  ctx.fill();
}

// Single rAF loop: just redraws + updates the readout label at a smooth
// frame rate. It no longer invents data — new samples only enter the
// buffer from pollHelicorder() below.
function tickHelicorder() {
  state.helicorderRaf = true; // mark started immediately to avoid duplicate loops
  drawHelicorder();

  const buf = state.helicorderBuffer;
  const last = buf.length ? buf[buf.length - 1] : 0;
  el('liveRatio').textContent = fmt(last, 2);

  state.helicorderRaf = requestAnimationFrame(() => {
    setTimeout(tickHelicorder, 60);
  });
}

// Ambient drift is now a one-shot fallback: it only runs before any real
// sample has ever arrived (so a fresh page load shows a gently moving
// line instead of a dead flat one), and stops permanently the first time
// pollHelicorder() successfully appends a real sample.
let everReceivedRealSample = false;
let ambientDriftTimer = null;

function startAmbientDriftFallback() {
  if (ambientDriftTimer || everReceivedRealSample) return;
  ambientDriftTimer = setInterval(() => {
    if (everReceivedRealSample) {
      clearInterval(ambientDriftTimer);
      ambientDriftTimer = null;
      return;
    }
    const buf = state.helicorderBuffer;
    const last = buf.length ? buf[buf.length - 1] : 0;
    const drift = (Math.random() - 0.5) * 0.04;
    const next = Math.max(0, last * 0.99 + drift);
    buf.push(next);
    if (buf.length > HELICORDER_MAX_SAMPLES) buf.shift();
  }, 250);
}

// Polls /api/live (the latest station_live row) on HELICORDER_POLL_MS,
// independent of the slower full-dashboard refresh. This is the live, ever-
// changing station state — so the readout label, the LED/buzzer alert and the
// helicorder trace all update continuously instead of being pinned to a single
// frozen history event (which is what made the title "say one type of event").
async function pollHelicorder() {
  try {
    const data = await fetchJson('/api/live');
    const row = data.live;
    if (!row) return;

    // Live state label + LED/buzzer alert track the real-time row every poll.
    applyLiveState(row);

    const v = mergedRatio(row);
    if (v < 0) return;

    const ts = row.timestamp;
    if (ts && ts === state.lastHelicorderFetchAt) return;  // no new frame yet

    everReceivedRealSample = true;
    const buf = state.helicorderBuffer;
    buf.push(v);
    while (buf.length > HELICORDER_MAX_SAMPLES) buf.shift();
    state.lastHelicorderFetchAt = ts || Date.now();
  } catch (error) {
    // Connectivity hiccup on the fast poll shouldn't disturb the rest of
    // the dashboard — the slower full refresh will surface real errors.
  }
}

function setHelicorderPolling() {
  if (state.helicorderPollTimer) clearInterval(state.helicorderPollTimer);
  pollHelicorder();
  state.helicorderPollTimer = setInterval(pollHelicorder, HELICORDER_POLL_MS);
}

// Build the live "state" label from a single row, including the simulation
// phase when the shaker is running so the readout isn't stuck on one word.
function liveStateLabel(row) {
  if (!row) return 'IDLE';
  const cls = String(row.classification || 'IDLE');
  const phase = row.simulation_phase;
  if (phase && phase !== 'Idle') return `${cls} · ${phase}`;
  return cls;
}

// Device alert tile: the on-station LED + buzzer fire together the instant any
// sensor crosses its STA/LTA threshold. We mirror that here from the REAL
// trigger booleans in the live row — never synthesised. earthquake_history
// rows don't carry these booleans, so the tile marks itself "not live" then.
function updateDeviceAlert(row) {
  const wrap = el('deviceAlert');
  const led = el('ledIndicator');
  const buzzer = el('buzzerIndicator');
  if (!wrap || !led || !buzzer) return;
  const keys = ['adxl345_triggered', 'lis3dh_triggered', 'mpu6050_triggered', 'shaker_running'];
  const hasTriggerData = !!row && keys.some(k => typeof row[k] === 'boolean');
  wrap.dataset.live = hasTriggerData ? 'true' : 'false';
  const triggered = hasTriggerData && keys.some(k => row[k] === true);
  led.dataset.on = triggered ? 'true' : 'false';
  buzzer.dataset.on = triggered ? 'true' : 'false';
}

// Push a single live row into the live readout (STA/LTA state + device alert).
function applyLiveState(row) {
  if (!row) return;
  el('liveClass').textContent = liveStateLabel(row).toUpperCase();
  updateDeviceAlert(row);
}

function updateLiveReadout(summary, rows) {
  // Reflect the NEWEST streamed row (rows arrive newest-first) instead of the
  // frozen strongest historical event — that stale binding is exactly why the
  // live state and alert sat constant between refreshes.
  const newest = rows && rows.length ? rows[0] : null;
  if (newest) applyLiveState(newest);
  else if (summary && summary.strongest) applyLiveState(summary.strongest);
}

/* ---------------------------------------------------------------------
   Charts
--------------------------------------------------------------------- */

function drawLine(id, rows, field, color) {
  const canvas = el(id);
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = 'rgba(232,228,216,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, rect.height - 22);
  ctx.lineTo(rect.width, rect.height - 22);
  ctx.stroke();

  const vals = rows.map(r => Number(r[field] || 0));
  if (vals.length < 2) return;
  const max = Math.max(1, ...vals.map(v => Math.abs(v)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = i / (vals.length - 1) * rect.width;
    const y = rect.height - 22 - (v / max) * (rect.height - 38);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // fill under curve, faint
  ctx.lineTo(rect.width, rect.height - 22);
  ctx.lineTo(0, rect.height - 22);
  ctx.closePath();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawClassChart(rows) {
  const counts = {};
  rows.forEach(r => counts[r.classification] = (counts[r.classification] || 0) + 1);
  const entries = Object.entries(counts);
  const canvas = el('classChart');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!entries.length) return;
  const max = Math.max(1, ...entries.map(e => e[1]));
  const bw = rect.width / entries.length;
  entries.forEach(([name, count], i) => {
    const h = (count / max) * (rect.height - 46);
    ctx.fillStyle = '#ffcf40';
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * bw + 6, rect.height - h - 26, Math.max(4, bw - 12), h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#9aa3a3';
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillText(name.slice(0, 14), i * bw + 6, rect.height - 8);
  });
}

function drawStalta(rows) {
  const merged = rows.map(r => ({ v: mergedRatio(r) }));
  drawLine('staltaChart', merged, 'v', '#ffcf40');
}

/* ---------------------------------------------------------------------
   Table + summary panel
--------------------------------------------------------------------- */

function classCellClass(cls) {
  if (cls === 'Confirmed Seismic Event') return 'cls-confirmed';
  if (cls === 'Strong Local Event') return 'cls-strong';
  return '';
}

// Identify a row as "the" peak-PGA / max-magnitude event. Match on event_id
// when present, else fall back to timestamp (live rows have no event_id).
function isSameEvent(row, ref) {
  if (!row || !ref) return false;
  if (ref.event_id && row.event_id) return row.event_id === ref.event_id;
  return !!row.timestamp && row.timestamp === ref.timestamp;
}

function renderTable(rows, summary) {
  const peakRef = summary && summary.peakPgaEvent;
  const magRef = summary && summary.maxMagnitudeEvent;
  el('rows').innerHTML = rows.length ? rows.map(r => {
    const isPeakPga = isSameEvent(r, peakRef);
    const isMaxMag = isSameEvent(r, magRef);
    const rowCls = [isPeakPga ? 'row-peak-pga' : '', isMaxMag ? 'row-max-mag' : ''].filter(Boolean).join(' ');
    const pgaBadge = isPeakPga ? ' <span class="peak-badge peak-badge--pga" title="Highest PGA in this window">MAX PGA</span>' : '';
    const magBadge = isMaxMag ? ' <span class="peak-badge peak-badge--mag" title="Largest magnitude in this window">MAX MAG</span>' : '';
    return `
    <tr class="${rowCls}">
      <td>${new Date(r.timestamp).toLocaleString()}</td>
      <td class="${classCellClass(r.classification)}">${escapeHtml(r.classification || '\u2014')}</td>
      <td>${fmt(r.pga, 1)}${pgaBadge}</td>
      <td>${fmt(r.mmi, 1)}</td>
      <td>${fmt(r.distance_km, 1)}</td>
      <td>${fmt(r.magnitude, 1)}${magBadge}</td>
      <td>${fmt(r.adxl345_stalta, 2)}</td>
      <td>${fmt(r.lis3dh_stalta, 2)}</td>
      <td>${fmt(r.mpu6050_stalta, 2)}</td>
      <td>${fmt(r.validation_error, 1)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" class="empty-state">No matching events</td></tr>';
}

// When the peak-PGA / max-magnitude events happened (shown under the gauges).
function setGaugeEventTimes(summary) {
  const fmtWhen = ref => (ref && ref.timestamp)
    ? `${new Date(ref.timestamp).toLocaleString()}` : '';
  el('peakPgaWhen').textContent = fmtWhen(summary && summary.peakPgaEvent);
  el('maxMagWhen').textContent = fmtWhen(summary && summary.maxMagnitudeEvent);
}

/* ---------------------------------------------------------------------
   Event waveform chart \u2014 plots the captured per-sensor samples for the
   strongest event (summary.waveform), with P/S arrival markers. This is
   the on-dashboard replacement for the serial oscilloscope view.
--------------------------------------------------------------------- */

function drawWaveform(waveform) {
  const canvas = el('waveformChart');
  const empty = el('waveformEmpty');
  const legend = el('waveformLegend');
  if (!canvas) return;

  const series = waveform ? [
    { key: 'adxl345Samples', label: 'ADXL345', color: '#ffcf40' },
    { key: 'lis3dhSamples', label: 'LIS3DH', color: '#58d5ff' },
    { key: 'mpu6050Samples', label: 'MPU6050', color: '#c084fc' },
  ].filter(s => Array.isArray(waveform[s.key]) && waveform[s.key].length > 1) : [];

  const hasData = !!waveform && series.length > 0;
  canvas.hidden = !hasData;
  empty.hidden = hasData;
  el('waveformPeak').textContent = waveform && Number(waveform.peakAmplitude) >= 0
    ? Number(waveform.peakAmplitude).toFixed(3) : '\u2014';

  if (!hasData) {
    legend.innerHTML = '';
    if (waveform && waveform.hasUsableData === false) {
      empty.textContent = 'Strongest event has a waveform row, but no raw samples were uploaded for it yet.';
    } else {
      empty.textContent = 'Waiting for a captured event waveform\u2026';
    }
    return;
  }

  legend.innerHTML = series.map(s =>
    `<span class="wf-key"><span class="wf-swatch" style="background:${s.color}"></span>${s.label}</span>`
  ).join('') +
    `<span class="wf-key"><span class="wf-swatch wf-swatch--p"></span>P-wave</span>` +
    `<span class="wf-key"><span class="wf-swatch wf-swatch--s"></span>S-wave</span>`;

  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const n = Math.max(...series.map(s => waveform[s.key].length));
  let max = 0;
  series.forEach(s => waveform[s.key].forEach(v => { max = Math.max(max, Math.abs(Number(v) || 0)); }));
  max = Math.max(max, 0.001);
  const mid = rect.height / 2;
  const scale = (rect.height * 0.42) / max;

  // baseline
  ctx.strokeStyle = 'rgba(232,228,216,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(rect.width, mid);
  ctx.stroke();

  // P / S markers
  const marker = (idx, color) => {
    if (idx === null || idx === undefined || idx < 0 || n < 2) return;
    const x = (idx / (n - 1)) * rect.width;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 6);
    ctx.lineTo(x, rect.height - 6);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  marker(waveform.pWaveIndex, 'rgba(95,184,138,0.9)');
  marker(waveform.sWaveIndex, 'rgba(214,102,74,0.95)');

  // sensor traces
  series.forEach(s => {
    const arr = waveform[s.key];
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const x = (i / (arr.length - 1)) * rect.width;
      const y = mid - (Number(v) || 0) * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

function render(data) {
  const rows = data.events || [];
  const summary = data.summary || {};
  state.rows = rows;
  state.summary = summary;

  el('count').textContent = summary.count ?? rows.length;
  el('peakPga').textContent = fmt(summary.peakPga, 1);
  el('maxMag').textContent = fmt(summary.maxMagnitude, 1);
  el('quality').textContent = summary.qualityScore == null ? '\u2014' : `${fmt(summary.qualityScore, 0)}%`;
  el('action').textContent = summary.suggestedAction || '\u2014';
  el('qualityFill').style.width = summary.qualityScore == null ? '0%' : `${Math.max(0, Math.min(100, summary.qualityScore))}%`;
  renderTable(rows, summary);
  setGaugeEventTimes(summary);

  const chronological = rows.slice().reverse();
  drawLine('pgaChart', chronological, 'pga', '#58d5ff');
  drawLine('magChart', chronological, 'magnitude', '#5fb88a');
  drawLine('distChart', chronological, 'distance_km', '#c084fc');
  drawClassChart(rows);
  drawStalta(chronological);
  drawWaveform(summary.waveform);

  if (!state.helicorderRaf) {
    seedHelicorder(rows);
    tickHelicorder();
    startAmbientDriftFallback();
    setHelicorderPolling();
  }
  updateLiveReadout(summary, rows);
  if (typeof renderAdvancedAnalytics === 'function') renderAdvancedAnalytics(summary);
  if (typeof renderExpandedMetrics === 'function') renderExpandedMetrics(summary, rows);
}

async function loadData() {
  try {
    const status = await fetchJson('/api/status');
    setCloud(status.supabaseConfigured, status.supabaseConfigured ? 'Backend online' : 'Configure Supabase');
    const data = await fetchJson(`/api/analytics?${queryString(filters())}`);
    render(data);
  } catch (error) {
    setCloud(false, 'Backend error');
  }
}

/* ---------------------------------------------------------------------
   Agent chat
--------------------------------------------------------------------- */

function addChat(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `chat-msg chat-msg--${role}`;
  const tag = document.createElement('span');
  tag.className = 'chat-tag';
  tag.textContent = role === 'user' ? 'You' : 'Agent';
  const p = document.createElement('p');
  p.textContent = text;
  wrap.appendChild(tag);
  wrap.appendChild(p);
  el('chatLog').appendChild(wrap);
  el('chatLog').scrollTop = el('chatLog').scrollHeight;
}

let agentBusy = false;

async function askAgent(question) {
  if (!question.trim() || agentBusy) return;
  agentBusy = true;
  el('askBtn').disabled = true;
  addChat('user', question);
  el('agentInput').value = '';
  try {
    const data = await fetchJson('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, filters: filters() }),
    });
    addChat('agent', data.answer);
  } catch (error) {
    addChat('agent', `Agent error: ${error.message}`);
  } finally {
    agentBusy = false;
    el('askBtn').disabled = false;
  }
}

function setAutoRefresh() {
  if (state.autoTimer) clearInterval(state.autoTimer);
  if (el('autoRefresh').checked) state.autoTimer = setInterval(loadData, 8000);
}

el('loadBtn').addEventListener('click', loadData);
el('autoRefresh').addEventListener('change', setAutoRefresh);
el('agentForm').addEventListener('submit', event => {
  event.preventDefault();
  askAgent(el('agentInput').value);
});
document.querySelectorAll('[data-question]').forEach(btn => {
  btn.addEventListener('click', () => askAgent(btn.dataset.question));
});
window.addEventListener('resize', () => {
  render({ events: state.rows, summary: state.summary });
  drawHelicorder();
});

loadData();
setAutoRefresh();

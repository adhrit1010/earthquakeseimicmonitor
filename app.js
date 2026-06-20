const state = {
  rows: [],
  summary: null,
  autoTimer: null,
  helicorderBuffer: [],   // rolling buffer of recent ratio samples for the live trace
  helicorderRaf: null,
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

function filters() {
  return {
    from: el('dateFrom').value,
    to: el('dateTo').value,
    classification: el('classification').value,
    limit: 500,
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
   Built from the merged STA/LTA ratio of the most recent rows, then
   ambient-jittered between refreshes so the instrument always feels alive.
--------------------------------------------------------------------- */

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
  ctx.shadowColor = 'rgba(232,196,104,0.45)';
  ctx.shadowBlur = 6;
  ctx.strokeStyle = '#e8c468';
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
  ctx.fillStyle = '#f0d27e';
  ctx.beginPath();
  ctx.arc(lastX - 2, lastY, 3, 0, Math.PI * 2);
  ctx.fill();
}

function tickHelicorder() {
  state.helicorderRaf = true; // mark started immediately to avoid duplicate loops
  // ambient jitter around the last known ratio so the trace always sweeps,
  // even between data refreshes
  const buf = state.helicorderBuffer;
  const last = buf.length ? buf[buf.length - 1] : 0;
  const drift = (Math.random() - 0.5) * 0.06;
  const next = Math.max(0, last * 0.985 + drift + (Math.random() < 0.01 ? Math.random() * 0.3 : 0));
  buf.push(next);
  if (buf.length > 220) buf.shift();
  drawHelicorder();

  const ratioOut = fmt(last, 2);
  el('liveRatio').textContent = ratioOut;

  state.helicorderRaf = requestAnimationFrame(() => {
    setTimeout(tickHelicorder, 60);
  });
}

function updateLiveReadout(summary, rows) {
  const strongest = summary && summary.strongest;
  if (strongest) {
    el('liveClass').textContent = (strongest.classification || 'IDLE').toUpperCase();
  } else if (rows.length) {
    el('liveClass').textContent = (rows[0].classification || 'IDLE').toUpperCase();
  }
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
    ctx.fillStyle = '#e8c468';
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
  drawLine('staltaChart', merged, 'v', '#e8c468');
}

/* ---------------------------------------------------------------------
   Table + summary panel
--------------------------------------------------------------------- */

function classCellClass(cls) {
  if (cls === 'Confirmed Seismic Event') return 'cls-confirmed';
  if (cls === 'Strong Local Event') return 'cls-strong';
  return '';
}

function renderTable(rows) {
  el('rows').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${new Date(r.timestamp).toLocaleString()}</td>
      <td class="${classCellClass(r.classification)}">${escapeHtml(r.classification || '\u2014')}</td>
      <td>${fmt(r.pga, 1)}</td>
      <td>${fmt(r.mmi, 1)}</td>
      <td>${fmt(r.distance_km, 1)}</td>
      <td>${fmt(r.magnitude, 1)}</td>
      <td>${fmt(r.adxl345_stalta, 2)}</td>
      <td>${fmt(r.lis3dh_stalta, 2)}</td>
      <td>${fmt(r.mpu6050_stalta, 2)}</td>
      <td>${fmt(r.validation_error, 1)}</td>
    </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No matching events</td></tr>';
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
  renderTable(rows);

  const chronological = rows.slice().reverse();
  drawLine('pgaChart', chronological, 'pga', '#58d5ff');
  drawLine('magChart', chronological, 'magnitude', '#5fb88a');
  drawLine('distChart', chronological, 'distance_km', '#c084fc');
  drawClassChart(rows);
  drawStalta(chronological);

  if (!state.helicorderRaf) {
    seedHelicorder(rows);
    tickHelicorder();
  } else if (rows.length) {
    // splice in fresh real samples so the live trace reflects real data
    const fresh = chronological.slice(-40).map(mergedRatio).filter(v => v >= 0);
    if (fresh.length) state.helicorderBuffer = state.helicorderBuffer.slice(0, -fresh.length).concat(fresh);
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
  if (el('autoRefresh').checked) state.autoTimer = setInterval(loadData, 15000);
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

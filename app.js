const state = {
  rows: [],
  summary: null,
  autoTimer: null,
};

const el = id => document.getElementById(id);
const fmt = (v, d = 1) => v === null || v === undefined || Number(v) < 0 ? '--' : Number(v).toFixed(d);

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
  el('cloudDot').style.background = ok ? 'var(--green)' : 'var(--red)';
  el('cloudText').textContent = text;
}

function drawLine(id, rows, field, color) {
  const canvas = el(id);
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = 'rgba(144,164,188,.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, rect.height - 24);
  ctx.lineTo(rect.width, rect.height - 24);
  ctx.stroke();

  const vals = rows.map(r => Number(r[field] || 0));
  if (vals.length < 2) return;
  const max = Math.max(1, ...vals.map(v => Math.abs(v)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = i / (vals.length - 1) * rect.width;
    const y = rect.height - 24 - (v / max) * (rect.height - 44);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
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
  const max = Math.max(1, ...entries.map(e => e[1]));
  const bw = rect.width / Math.max(1, entries.length);
  entries.forEach(([name, count], i) => {
    const h = (count / max) * (rect.height - 50);
    ctx.fillStyle = '#58d5ff';
    ctx.fillRect(i * bw + 8, rect.height - h - 28, Math.max(4, bw - 16), h);
    ctx.fillStyle = '#90a4bc';
    ctx.font = '11px Arial';
    ctx.fillText(name.slice(0, 16), i * bw + 8, rect.height - 10);
  });
}

function drawStalta(rows) {
  const merged = rows.map(r => ({
    v: Math.max(
      Number(r.adxl345_stalta || 0),
      Number(r.lis3dh_stalta || 0),
      Number(r.mpu6050_stalta || 0),
    ),
  }));
  drawLine('staltaChart', merged, 'v', '#ffd166');
}

function renderTable(rows) {
  el('rows').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${new Date(r.timestamp).toLocaleString()}</td>
      <td>${r.classification || '--'}</td>
      <td>${fmt(r.pga, 1)}</td>
      <td>${fmt(r.mmi, 1)}</td>
      <td>${fmt(r.distance_km, 1)}</td>
      <td>${fmt(r.magnitude, 1)}</td>
      <td>${fmt(r.adxl345_stalta, 2)}</td>
      <td>${fmt(r.lis3dh_stalta, 2)}</td>
      <td>${fmt(r.mpu6050_stalta, 2)}</td>
      <td>${fmt(r.validation_error, 1)}</td>
    </tr>`).join('') : '<tr><td colspan="10">No matching events</td></tr>';
}

function render(data) {
  const rows = data.events || [];
  const summary = data.summary || {};
  state.rows = rows;
  state.summary = summary;

  el('count').textContent = summary.count ?? rows.length;
  el('peakPga').textContent = fmt(summary.peakPga, 1);
  el('maxMag').textContent = fmt(summary.maxMagnitude, 1);
  el('quality').textContent = summary.qualityScore == null ? '--' : `${fmt(summary.qualityScore, 0)}%`;
  el('action').textContent = summary.suggestedAction || '--';
  renderTable(rows);

  const chronological = rows.slice().reverse();
  drawLine('pgaChart', chronological, 'pga', '#58d5ff');
  drawLine('magChart', chronological, 'magnitude', '#42f5a7');
  drawLine('distChart', chronological, 'distance_km', '#c084fc');
  drawClassChart(rows);
  drawStalta(chronological);
}

async function loadData() {
  try {
    const status = await fetchJson('/api/status');
    setCloud(status.supabaseConfigured, status.supabaseConfigured ? 'Backend online' : 'Configure Supabase');
    el('status').textContent = `Backend ready | AI ${status.openaiConfigured ? 'OpenAI enabled' : 'local fallback'} | model ${status.model}`;
    const data = await fetchJson(`/api/analytics?${queryString(filters())}`);
    render(data);
  } catch (error) {
    setCloud(false, 'Backend error');
    el('status').textContent = error.message;
  }
}

function addChat(role, text) {
  const p = document.createElement('p');
  p.className = role;
  p.innerHTML = `<b>${role === 'user' ? 'You' : 'Agent'}:</b> ${text.replace(/\n/g, '<br>')}`;
  el('chatLog').appendChild(p);
  el('chatLog').scrollTop = el('chatLog').scrollHeight;
}

async function askAgent(question) {
  if (!question.trim()) return;
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
  }
}

function setAutoRefresh() {
  if (state.autoTimer) clearInterval(state.autoTimer);
  if (el('autoRefresh').checked) state.autoTimer = setInterval(loadData, 15000);
}

el('loadBtn').addEventListener('click', loadData);
el('autoRefresh').addEventListener('change', setAutoRefresh);
el('askBtn').addEventListener('click', () => askAgent(el('agentInput').value));
el('agentInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') askAgent(el('agentInput').value);
});
document.querySelectorAll('[data-question]').forEach(btn => {
  btn.addEventListener('click', () => askAgent(btn.dataset.question));
});
window.addEventListener('resize', () => render({ events: state.rows, summary: state.summary }));

loadData();
setAutoRefresh();


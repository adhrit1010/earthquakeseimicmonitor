const state = {
  allRows: [],       // everything fetched from /api/events for the current server-side filter
  filteredRows: [],  // after client-side search/min-mag/max-dist filtering
  sortField: 'timestamp',
  sortDir: 'desc',   // 'asc' | 'desc'
  page: 1,
  pageSize: 50,
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

function classCellClass(cls) {
  if (cls === 'Confirmed Seismic Event') return 'cls-confirmed';
  if (cls === 'Strong Local Event') return 'cls-strong';
  return '';
}

/* ---------------------------------------------------------------------
   Server-side filters (date range + classification) -> /api/events
--------------------------------------------------------------------- */

function serverFilters() {
  return {
    from: el('dateFrom').value,
    to: el('dateTo').value,
    classification: el('classification').value,
    limit: 2000,
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

async function loadData() {
  const tbody = el('rows');
  tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Loading&hellip;</td></tr>';
  try {
    const data = await fetchJson(`/api/events?${queryString(serverFilters())}`);
    state.allRows = data.events || [];
    state.page = 1;
    applyClientFilters();
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-state">Error: ${escapeHtml(error.message)}</td></tr>`;
  }
}

/* ---------------------------------------------------------------------
   Client-side search, min magnitude, max distance, sort, paginate
--------------------------------------------------------------------- */

function applyClientFilters() {
  const search = el('searchBox').value.trim().toLowerCase();
  const minMag = el('minMag').value === '' ? null : Number(el('minMag').value);
  const maxDist = el('maxDist').value === '' ? null : Number(el('maxDist').value);

  let rows = state.allRows.slice();

  if (search) {
    rows = rows.filter(r => {
      const haystack = [
        r.classification, r.id, r.source, r.timestamp,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(search);
    });
  }

  if (minMag !== null && !Number.isNaN(minMag)) {
    rows = rows.filter(r => Number(r.magnitude) >= minMag);
  }

  if (maxDist !== null && !Number.isNaN(maxDist)) {
    rows = rows.filter(r => Number(r.distance_km) >= 0 && Number(r.distance_km) <= maxDist);
  }

  rows.sort((a, b) => {
    let av = a[state.sortField];
    let bv = b[state.sortField];
    if (state.sortField === 'timestamp') {
      av = new Date(av).getTime();
      bv = new Date(bv).getTime();
    } else if (state.sortField !== 'classification') {
      av = Number(av);
      bv = Number(bv);
    }
    if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
    if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  state.filteredRows = rows;
  state.page = Math.min(state.page, Math.max(1, Math.ceil(rows.length / state.pageSize)));
  renderTable();
  renderSummary();
}

function renderSummary() {
  const total = state.filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const startIdx = (state.page - 1) * state.pageSize;
  const endIdx = Math.min(startIdx + state.pageSize, total);

  el('matchCount').textContent = total;
  el('pageRange').textContent = total === 0 ? '0' : `${startIdx + 1}\u2013${endIdx}`;
  el('pageIndicator').textContent = `${state.page} / ${totalPages}`;
  el('paginationLabel').textContent = total === 0
    ? 'No matching events'
    : `Page ${state.page} of ${totalPages} \u00b7 ${total} total`;

  el('prevPageBtn').disabled = state.page <= 1;
  el('nextPageBtn').disabled = state.page >= totalPages;
}

function renderTable() {
  const startIdx = (state.page - 1) * state.pageSize;
  const pageRows = state.filteredRows.slice(startIdx, startIdx + state.pageSize);

  el('rows').innerHTML = pageRows.length ? pageRows.map(r => `
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

/* ---------------------------------------------------------------------
   Export
--------------------------------------------------------------------- */

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const rows = state.filteredRows;
  if (!rows.length) return;
  const columns = [
    'timestamp', 'classification', 'pga', 'mmi', 'distance_km', 'magnitude',
    'adxl345_stalta', 'lis3dh_stalta', 'mpu6050_stalta', 'validation_error', 'id', 'source',
  ];
  const escapeCsv = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  rows.forEach(r => {
    lines.push(columns.map(c => escapeCsv(r[c])).join(','));
  });
  downloadBlob(lines.join('\n'), `triaxis-events-${Date.now()}.csv`, 'text/csv;charset=utf-8');
}

function exportJson() {
  const rows = state.filteredRows;
  if (!rows.length) return;
  downloadBlob(JSON.stringify(rows, null, 2), `triaxis-events-${Date.now()}.json`, 'application/json;charset=utf-8');
}

/* ---------------------------------------------------------------------
   Wiring
--------------------------------------------------------------------- */

function setupSortHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortField = field;
        state.sortDir = 'desc';
      }
      document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      applyClientFilters();
    });
  });
}

let debounceTimer = null;
function debounced(fn, delay = 250) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), delay);
  };
}

el('loadBtn').addEventListener('click', loadData);
el('searchBox').addEventListener('input', debounced(() => { state.page = 1; applyClientFilters(); }));
el('minMag').addEventListener('input', debounced(() => { state.page = 1; applyClientFilters(); }));
el('maxDist').addEventListener('input', debounced(() => { state.page = 1; applyClientFilters(); }));
el('dateFrom').addEventListener('change', loadData);
el('dateTo').addEventListener('change', loadData);
el('classification').addEventListener('change', loadData);
el('pageSize').addEventListener('change', () => {
  state.pageSize = Number(el('pageSize').value);
  state.page = 1;
  applyClientFilters();
});
el('prevPageBtn').addEventListener('click', () => {
  if (state.page > 1) { state.page -= 1; renderTable(); renderSummary(); }
});
el('nextPageBtn').addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / state.pageSize));
  if (state.page < totalPages) { state.page += 1; renderTable(); renderSummary(); }
});
el('exportCsvBtn').addEventListener('click', exportCsv);
el('exportJsonBtn').addEventListener('click', exportJson);

setupSortHeaders();
loadData();

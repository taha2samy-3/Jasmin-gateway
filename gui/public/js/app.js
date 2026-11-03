// Jasmin Enterprise Console Frontend Engine
let trafficChart;
let statusChart;
let smppBindsChart;
let liquidityChart;
let terminal;
let terminalFitAddon;
let terminalWs;

let lastRequestCount = 0;
const historyPoints = Array(20).fill(0);
const historyLabels = Array(20).fill('');

let trafficMessages = [];

// Initialize Charts
function initCharts() {
  const chartCanvas = document.getElementById('throughputChart');
  if (!chartCanvas) return;

  const ctxTraffic = chartCanvas.getContext('2d');
  trafficChart = new Chart(ctxTraffic, {
    type: 'line',
    data: {
      labels: historyLabels,
      datasets: [{
        label: 'HTTP Requests/Sec',
        data: historyPoints,
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.08)',
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#38bdf8'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          borderColor: '#334155',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#94a3b8'
        }
      },
      scales: {
        x: { display: false },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(51, 65, 85, 0.4)' },
          ticks: { color: '#64748b', font: { family: 'var(--font-mono)', size: 10 } }
        }
      }
    }
  });
}

// Tab Switching
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (btn) btn.classList.add('active');
  const target = document.getElementById(`tab-${name}`);
  if (target) target.classList.add('active');

  if (name === 'config') {
    loadConfig();
  } else if (name === 'traffic') {
    loadTraffic();
  } else if (name === 'terminal') {
    initTerminal();
  }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
    location.hash = btn.dataset.tab;
  });
});

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace('#', '');
  if (hash) switchTab(hash);
});

// Modal Controls
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
}

// Modal Trigger Bindings
const openUserBtn = document.getElementById('btn-open-add-user');
if (openUserBtn) openUserBtn.onclick = () => openModal('modal-add-user');

const openGroupBtn = document.getElementById('btn-open-add-group');
if (openGroupBtn) openGroupBtn.onclick = () => openModal('modal-add-group');

const openSmppBtn = document.getElementById('btn-open-add-smpp');
if (openSmppBtn) openSmppBtn.onclick = () => openModal('modal-add-smpp');

const openHttpBtn = document.getElementById('btn-open-add-http');
if (openHttpBtn) openHttpBtn.onclick = () => openModal('modal-add-http');

const openMtRouteBtn = document.getElementById('btn-open-add-mt-route');
if (openMtRouteBtn) openMtRouteBtn.onclick = () => openModal('modal-add-mt-route');

const openMoRouteBtn = document.getElementById('btn-open-add-route');
if (openMoRouteBtn) openMoRouteBtn.onclick = () => openModal('modal-add-route');

const openFilterBtn = document.getElementById('btn-open-add-filter');
if (openFilterBtn) openFilterBtn.onclick = () => openModal('modal-add-filter');

// Fetch and Render NOC Overview
async function loadOverview() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    renderOverview(data);
  } catch (err) {
    console.error('Error loading overview:', err);
  }
}

function renderOverview(data) {
  if (!data || !data.stats) return;

  const http = data.stats.httpApi || {};
  const smpps = data.stats.smppsApi || {};
  const counts = data.counts || {};
  const traffic = data.trafficStats || {};

  // Stat Counters
  const elHttpReq = document.getElementById('stat-http-requests');
  if (elHttpReq) elHttpReq.textContent = http.requestCount || 0;

  const elHttpSuccess = document.getElementById('stat-http-success');
  if (elHttpSuccess) {
    elHttpSuccess.textContent = `Success: ${http.successCount || 0} | Errors: ${(http.authErrorCount || 0) + (http.routeErrorCount || 0)}`;
  }

  const elSmppsSubmits = document.getElementById('stat-smpps-submits');
  if (elSmppsSubmits) elSmppsSubmits.textContent = smpps.submitSmCount || 0;

  const elSmppsErrors = document.getElementById('stat-smpps-errors');
  if (elSmppsErrors) {
    elSmppsErrors.textContent = `Errors: ${smpps.otherSubmitErrorCount || 0} | Throttled: ${smpps.throttlingErrorCount || 0}`;
  }

  const elSmppsBinds = document.getElementById('stat-smpps-binds');
  if (elSmppsBinds) elSmppsBinds.textContent = smpps.boundTrxCount || 0;

  const elSmppsBindTypes = document.getElementById('stat-smpps-bind-types');
  if (elSmppsBindTypes) {
    elSmppsBindTypes.textContent = `TRX: ${smpps.boundTrxCount || 0} | RX: ${smpps.boundRxCount || 0} | TX: ${smpps.boundTxCount || 0}`;
  }

  const elTrafficTotal = document.getElementById('stat-traffic-total');
  if (elTrafficTotal) elTrafficTotal.textContent = traffic.total || 0;

  const elTrafficSummary = document.getElementById('stat-traffic-summary');
  if (elTrafficSummary) {
    elTrafficSummary.textContent = `Delivered: ${traffic.delivered || 0} | Errors: ${traffic.errors || 0}`;
  }

  // Chart Throughput Update
  const delta = Math.max(0, (http.requestCount || 0) - lastRequestCount);
  lastRequestCount = http.requestCount || 0;
  historyPoints.shift();
  historyPoints.push(delta);
  if (trafficChart) trafficChart.update();

  // Active Carriers Table on Overview
  const tbodyOverviewConnectors = document.querySelector('#table-overview-connectors tbody');
  if (tbodyOverviewConnectors) {
    fetch('/api/connectors/smpp').then(r => r.json()).then(connectors => {
      if (!connectors || connectors.length === 0) {
        tbodyOverviewConnectors.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No active carrier SMPP connectors found.</td></tr>`;
      } else {
        tbodyOverviewConnectors.innerHTML = connectors.map(c => `
          <tr>
            <td><strong>#${c.cid}</strong></td>
            <td><span class="badge ${c.connectedAt ? 'badge-success' : 'badge-danger'}">${c.connectedAt ? 'BOUND' : 'DISCONNECTED'}</span></td>
            <td><code>${c.boundAt || 'N/A'}</code></td>
            <td><strong style="color: #38bdf8;">${c.submits || 0}</strong></td>
            <td><strong style="color: #a855f7;">${c.delivers || 0}</strong></td>
            <td><span class="badge ${(c.qosErrors || 0) + (c.otherErrors || 0) > 0 ? 'badge-danger' : 'badge-dark'}">${(c.qosErrors || 0) + (c.otherErrors || 0)}</span></td>
          </tr>
        `).join('');
      }
    }).catch(() => {});
  }

  // Render individual tables if active
  loadUsersTable();
  loadGroupsTable();
  loadConnectorsTable();
  loadRoutesTable();
  loadFiltersTable();
}

// User Accounts Table Loader
async function loadUsersTable() {
  const tbody = document.querySelector('#table-users tbody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    if (!users || users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No users found. Click "+ Add User" to provision credentials.</td></tr>`;
    } else {
      tbody.innerHTML = users.map(u => `
        <tr>
          <td><strong>#${u.uid}</strong></td>
          <td><span class="badge badge-outline">${u.gid}</span></td>
          <td><code>${u.username}</code></td>
          <td><strong style="color: #22c55e;">$${parseFloat(u.balance || 0).toFixed(2)}</strong></td>
          <td>${u.mtSmsQuota || 'Unlimited'}</td>
          <td>${u.throughput || 0} MPS</td>
          <td>
            <button class="btn btn-danger" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="deleteUser('${u.uid}')">Delete</button>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {}
}

// Groups Table Loader
async function loadGroupsTable() {
  const tbody = document.querySelector('#table-groups tbody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/groups');
    const groups = await res.json();
    if (!groups || groups.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No groups found. Click "+ Add Group".</td></tr>`;
    } else {
      tbody.innerHTML = groups.map(g => `
        <tr>
          <td><strong>#${g.gid}</strong></td>
          <td><span class="badge badge-success">ACTIVE</span></td>
          <td>—</td>
        </tr>
      `).join('');
    }
  } catch (err) {}
}

// Connectors Table Loader
async function loadConnectorsTable() {
  const tbodySmpp = document.querySelector('#table-smpp-connectors tbody');
  if (tbodySmpp) {
    try {
      const res = await fetch('/api/connectors/smpp');
      const connectors = await res.json();
      if (!connectors || connectors.length === 0) {
        tbodySmpp.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No SMPP connectors found.</td></tr>`;
      } else {
        tbodySmpp.innerHTML = connectors.map(c => `
          <tr>
            <td><strong>#${c.cid}</strong></td>
            <td><span class="badge ${c.connectedAt ? 'badge-success' : 'badge-danger'}">${c.connectedAt ? 'BOUND' : 'DISCONNECTED'}</span></td>
            <td>${c.submits || 0}</td>
            <td>${c.delivers || 0}</td>
            <td><span class="badge ${(c.qosErrors || 0) + (c.otherErrors || 0) > 0 ? 'badge-danger' : 'badge-dark'}">${(c.qosErrors || 0) + (c.otherErrors || 0)}</span></td>
            <td>
              <div style="display: flex; gap: 0.35rem;">
                <button class="btn btn-outline" style="padding: 0.2rem 0.45rem; font-size: 0.75rem;" onclick="startSmpp('${c.cid}')">Start</button>
                <button class="btn btn-outline" style="padding: 0.2rem 0.45rem; font-size: 0.75rem;" onclick="stopSmpp('${c.cid}')">Stop</button>
                <button class="btn btn-danger" style="padding: 0.2rem 0.45rem; font-size: 0.75rem;" onclick="deleteSmpp('${c.cid}')">Delete</button>
              </div>
            </td>
          </tr>
        `).join('');
      }
    } catch (err) {}
  }

  const tbodyHttp = document.querySelector('#table-http-connectors tbody');
  if (tbodyHttp) {
    try {
      const res = await fetch('/api/connectors/http');
      const connectors = await res.json();
      if (!connectors || connectors.length === 0) {
        tbodyHttp.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No HTTP webhooks found.</td></tr>`;
      } else {
        tbodyHttp.innerHTML = connectors.map(c => `
          <tr>
            <td><strong>#${c.cid}</strong></td>
            <td><span class="badge badge-outline">${c.method}</span></td>
            <td style="font-family: var(--font-mono); font-size: 0.82rem;">${c.url}</td>
            <td>
              <button class="btn btn-danger" style="padding: 0.2rem 0.45rem; font-size: 0.75rem;" onclick="deleteHttp('${c.cid}')">Delete</button>
            </td>
          </tr>
        `).join('');
      }
    } catch (err) {}
  }
}

// Routes Table Loader
async function loadRoutesTable() {
  const tbodyMt = document.querySelector('#table-mt-routes tbody');
  if (tbodyMt) {
    try {
      const res = await fetch('/api/routes/mt');
      const routes = await res.json();
      if (!routes || routes.length === 0) {
        tbodyMt.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No MT routes configured.</td></tr>`;
      } else {
        tbodyMt.innerHTML = routes.map(r => `
          <tr>
            <td><strong>#${r.order}</strong></td>
            <td><span class="badge badge-outline">${r.type}</span></td>
            <td><strong style="color: #22c55e;">$${parseFloat(r.rate || 0).toFixed(4)}</strong></td>
            <td><code>${r.connector}</code></td>
            <td>${r.filters && r.filters.length > 0 ? r.filters.map(f => `<span class="badge badge-dark" style="margin-right: 3px;">${f}</span>`).join('') : 'None'}</td>
            <td>
              <button class="btn btn-danger" style="padding: 0.2rem 0.45rem; font-size: 0.75rem;" onclick="deleteMtRoute(${r.order})">Delete</button>
            </td>
          </tr>
        `).join('');
      }
    } catch (err) {}
  }

  const tbodyMo = document.querySelector('#table-mo-routes tbody');
  if (tbodyMo) {
    try {
      const res = await fetch('/api/routes/mo');
      const routes = await res.json();
      if (!routes || routes.length === 0) {
        tbodyMo.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No MO routes configured.</td></tr>`;
      } else {
        tbodyMo.innerHTML = routes.map(r => `
          <tr>
            <td><strong>#${r.order}</strong></td>
            <td><span class="badge badge-outline">${r.type}</span></td>
            <td><code>${r.connector}</code></td>
            <td>${r.filters && r.filters.length > 0 ? r.filters.map(f => `<span class="badge badge-dark" style="margin-right: 3px;">${f}</span>`).join('') : 'None'}</td>
            <td>
              <button class="btn btn-danger" style="padding: 0.2rem 0.45rem; font-size: 0.75rem;" onclick="deleteMoRoute(${r.order})">Delete</button>
            </td>
          </tr>
        `).join('');
      }
    } catch (err) {}
  }
}

// Filters Table Loader
async function loadFiltersTable() {
  const tbody = document.querySelector('#table-filters tbody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/filters');
    const filters = await res.json();
    if (!filters || filters.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No filters configured.</td></tr>`;
    } else {
      tbody.innerHTML = filters.map(f => `
        <tr>
          <td><strong>#${f.fid}</strong></td>
          <td><span class="badge badge-outline">${f.type}</span></td>
          <td style="font-family: var(--font-mono); font-size: 0.82rem;"><code>${f.description || 'None'}</code></td>
          <td><span class="badge badge-dark">${f.routes || 'MO MT'}</span></td>
          <td>
            <button class="btn btn-danger" style="padding: 0.2rem 0.45rem; font-size: 0.75rem;" onclick="deleteFilter('${f.fid}')">Delete</button>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {}
}

// --- Live Traffic & DLR Monitor Module ---
async function loadTraffic() {
  const searchInput = document.getElementById('traffic-search-input');
  const statusFilter = document.getElementById('traffic-status-filter');
  const q = searchInput ? searchInput.value : '';
  const status = statusFilter ? statusFilter.value : '';

  try {
    const res = await fetch(`/api/traffic?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
    const data = await res.json();
    trafficMessages = data.messages || [];
    renderTrafficTable(trafficMessages);
    updateTrafficStats(data.stats);
  } catch (err) {
    console.error('Error loading traffic:', err);
  }
}

function updateTrafficStats(stats) {
  if (!stats) return;
  const setCard = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setCard('traffic-card-total', stats.total || 0);
  setCard('traffic-card-submitted', stats.submitted || 0);
  setCard('traffic-card-roks', stats.esmeRok || 0);
  setCard('traffic-card-delivered', stats.delivered || 0);
  setCard('traffic-card-errors', stats.errors || 0);
}

function renderTrafficTable(messages) {
  const tbody = document.getElementById('table-traffic-body');
  if (!tbody) return;

  if (!messages || messages.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">No message traffic found matching current criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = messages.map(m => formatTrafficRow(m)).join('');
}

function formatTrafficRow(m) {
  const timeStr = new Date(m.timestamp).toLocaleTimeString();
  let statusBadge = '';

  if (m.status === 'SUBMITTED') {
    statusBadge = `<span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3);">SUBMITTED</span>`;
  } else if (m.status === 'ESME_ROK') {
    statusBadge = `<span class="badge" style="background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.3);">ESME_ROK</span>`;
  } else if (m.status === 'DELIVRD') {
    statusBadge = `<span class="badge" style="background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3);">DELIVRD</span>`;
  } else {
    statusBadge = `<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">${m.status}</span>`;
  }

  return `
    <tr id="traffic-row-${m.msgid}" style="transition: background 0.3s ease;">
      <td style="color: var(--text-muted); font-size: 0.8rem; font-family: var(--font-mono);">${timeStr}</td>
      <td style="font-family: var(--font-mono); font-size: 0.82rem;"><strong>${m.msgid}</strong></td>
      <td><code>${m.sourceAddr || 'N/A'}</code></td>
      <td><strong>${m.destAddr}</strong></td>
      <td style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${m.shortMessage}">
        ${m.shortMessage || '<em>(Empty Body)</em>'}
      </td>
      <td><span class="badge badge-outline">${m.routedCid || m.connector || 'default'}</span></td>
      <td>${statusBadge}</td>
      <td style="font-family: var(--font-mono); font-size: 0.8rem; color: #94a3b8;">${m.latencyMs ? m.latencyMs + 'ms' : '—'}</td>
      <td>
        <button class="btn btn-outline" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="inspectPdu('${m.msgid}')">Inspect</button>
      </td>
    </tr>
  `;
}

function handleIncomingTraffic(m, isUpdate) {
  const tbody = document.getElementById('table-traffic-body');
  if (!tbody) return;

  const existingRow = document.getElementById(`traffic-row-${m.msgid}`);
  if (existingRow && isUpdate) {
    existingRow.outerHTML = formatTrafficRow(m);
    const updatedRow = document.getElementById(`traffic-row-${m.msgid}`);
    if (updatedRow) {
      updatedRow.style.background = 'rgba(56, 189, 248, 0.12)';
      setTimeout(() => { updatedRow.style.background = ''; }, 1200);
    }
  } else if (!existingRow) {
    const firstTr = tbody.querySelector('tr');
    if (firstTr && firstTr.children.length === 1) {
      tbody.innerHTML = '';
    }
    tbody.insertAdjacentHTML('afterbegin', formatTrafficRow(m));
    const newRow = document.getElementById(`traffic-row-${m.msgid}`);
    if (newRow) {
      newRow.style.background = 'rgba(34, 197, 94, 0.15)';
      setTimeout(() => { newRow.style.background = ''; }, 1200);
    }
    const autoScroll = document.getElementById('traffic-autoscroll');
    if (autoScroll && autoScroll.checked) {
      const container = tbody.closest('.table-container');
      if (container) container.scrollTop = 0;
    }
  }
}

// Deep PDU Inspector Modal
async function inspectPdu(msgid) {
  try {
    const res = await fetch(`/api/traffic/${encodeURIComponent(msgid)}`);
    const data = await res.json();
    const titleEl = document.getElementById('pdu-modal-title');
    const bodyEl = document.getElementById('pdu-modal-body');
    if (titleEl) titleEl.textContent = `PDU Deep Inspector — Message #${msgid}`;
    if (bodyEl) {
      bodyEl.innerHTML = `<pre style="margin: 0;">${JSON.stringify(data, null, 2)}</pre>`;
    }
    openModal('modal-pdu-inspector');
  } catch (err) {
    alert('Error inspecting PDU: ' + err.message);
  }
}

// Export Traffic to CSV
function exportTrafficCsv() {
  if (!trafficMessages || trafficMessages.length === 0) {
    alert('No traffic messages to export!');
    return;
  }

  const headers = ['Timestamp', 'MessageID', 'Sender', 'Recipient', 'Content', 'Connector', 'Status', 'LatencyMs'];
  const rows = trafficMessages.map(m => [
    new Date(m.timestamp).toISOString(),
    `"${m.msgid}"`,
    `"${m.sourceAddr}"`,
    `"${m.destAddr}"`,
    `"${(m.shortMessage || '').replace(/"/g, '""')}"`,
    `"${m.routedCid || m.connector}"`,
    m.status,
    m.latencyMs || 0
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `jasmin-traffic-${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Clear Traffic Ring Buffer
async function clearTrafficBuffer() {
  if (!confirm('Are you sure you want to clear the real-time message ring buffer?')) return;
  try {
    await fetch('/api/traffic', { method: 'DELETE' });
    trafficMessages = [];
    renderTrafficTable([]);
    updateTrafficStats({ total: 0, submitted: 0, esmeRok: 0, delivered: 0, errors: 0 });
  } catch (err) {
    alert('Clear failed: ' + err.message);
  }
}

// Traffic Filter Input Listeners
const trafficSearch = document.getElementById('traffic-search-input');
if (trafficSearch) trafficSearch.addEventListener('input', () => loadTraffic());

const trafficStatus = document.getElementById('traffic-status-filter');
if (trafficStatus) trafficStatus.addEventListener('change', () => loadTraffic());

const btnClearTraffic = document.getElementById('btn-clear-traffic');
if (btnClearTraffic) btnClearTraffic.addEventListener('click', clearTrafficBuffer);

const btnExportCsv = document.getElementById('btn-export-traffic-csv');
if (btnExportCsv) btnExportCsv.addEventListener('click', exportTrafficCsv);

// --- Interactive jCLI Web Terminal (xterm.js) Module ---
function initTerminal() {
  const container = document.getElementById('terminal-container');
  if (!container || terminal) return;

  if (typeof Terminal === 'undefined') {
    container.innerHTML = `<div style="padding: 2rem; color: #ef4444;">xterm.js library failed to load from CDN. Please check network connectivity.</div>`;
    return;
  }

  terminal = new Terminal({
    theme: {
      background: '#0b0f19',
      foreground: '#f8fafc',
      cursor: '#38bdf8',
      selectionBackground: '#1e293b'
    },
    cursorBlink: true,
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    rows: 24
  });

  if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
    terminalFitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(terminalFitAddon);
  }

  terminal.open(container);
  if (terminalFitAddon) terminalFitAddon.fit();

  connectTerminalWs();
}

function connectTerminalWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  terminalWs = new WebSocket(`${protocol}//${location.host}/ws/terminal`);

  terminalWs.onopen = () => {
    terminal.write('\x1b[32m[Connected to jCLI Terminal Gateway]\x1b[0m\r\n');
  };

  terminalWs.onmessage = (event) => {
    terminal.write(event.data);
  };

  terminalWs.onclose = () => {
    terminal.write('\r\n\x1b[31m[jCLI Terminal Session Terminated]\x1b[0m\r\n');
  };

  terminal.onData((data) => {
    if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(data);
    }
  });
}

function sendTerminalCommand(cmd) {
  if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
    terminalWs.send(`${cmd}\n`);
    if (terminal) terminal.focus();
  }
}

function reconnectTerminal() {
  if (terminalWs) {
    terminalWs.close();
  }
  if (terminal) {
    terminal.clear();
  }
  connectTerminalWs();
}

// --- Interactive Route Match Simulator ---
const formSimulate = document.getElementById('form-simulate-route');
if (formSimulate) {
  formSimulate.onsubmit = async (e) => {
    e.preventDefault();
    const resultBox = document.getElementById('sim-result');
    resultBox.style.display = 'block';
    resultBox.innerHTML = '<em>Running route match simulation against active filters...</em>';

    const payload = {
      uid: document.getElementById('sim-uid').value.trim(),
      source_addr: document.getElementById('sim-source').value.trim(),
      destination_addr: document.getElementById('sim-dest').value.trim(),
      text: document.getElementById('sim-content').value.trim()
    };

    try {
      const res = await fetch('/api/routes/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.matched) {
        resultBox.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
            <div>
              <span class="badge badge-success" style="font-size: 0.9rem;">✓ ROUTE MATCHED (Order #${data.winningRoute.order})</span>
              <span style="margin-left: 0.5rem; font-weight: 600;">Strategy: ${data.winningRoute.type}</span>
            </div>
            <div>
              Target Connector: <code style="font-size: 0.95rem; font-weight: 700; color: #38bdf8;">${data.targetConnector}</code>
            </div>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem;">Evaluation Step Trace:</div>
          <table style="width: 100%; font-size: 0.8rem; border-collapse: collapse;">
            <thead>
              <tr style="border-bottom: 1px solid var(--border-color); text-align: left;">
                <th style="padding: 4px;">Order</th>
                <th style="padding: 4px;">Route Strategy</th>
                <th style="padding: 4px;">Filters Tested</th>
                <th style="padding: 4px;">Result</th>
              </tr>
            </thead>
            <tbody>
              ${data.trace.map(t => `
                <tr style="border-bottom: 1px solid rgba(51, 65, 85, 0.2);">
                  <td style="padding: 4px;">#${t.order}</td>
                  <td style="padding: 4px;">${t.type}</td>
                  <td style="padding: 4px;">
                    ${t.filtersEvaluated.length === 0 ? '<em>Pass-through (No Filters)</em>' : t.filtersEvaluated.map(f => `<span class="badge ${f.matched ? 'badge-success' : 'badge-danger'}" title="${f.reason}">${f.fid} (${f.matched ? 'Match' : 'Miss'})</span>`).join(' ')}
                  </td>
                  <td style="padding: 4px;">
                    <span class="badge ${t.routeMatched ? 'badge-success' : 'badge-dark'}">${t.routeMatched ? 'SELECTED' : 'SKIPPED'}</span>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      } else {
        resultBox.innerHTML = `
          <div style="color: #ef4444; font-weight: 600;">✗ NO ROUTE MATCHED</div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">
            None of the active MT routes satisfied the specified parameters. Message would be rejected or dropped by gateway.
          </p>
        `;
      }
    } catch (err) {
      resultBox.innerHTML = `<div style="color: #ef4444;">Simulation error: ${err.message}</div>`;
    }
  };
}

// --- Live Regex Tester in Filter Modal ---
const filterValInput = document.getElementById('new-filter-val');
const filterSampleInput = document.getElementById('regex-test-sample');
const filterTypeSelect = document.getElementById('new-filter-type');
const regexBadge = document.getElementById('regex-test-badge');

async function testRegexValidation() {
  const pattern = filterValInput ? filterValInput.value.trim() : '';
  const sample = filterSampleInput ? filterSampleInput.value.trim() : '';
  if (!pattern || !regexBadge) return;

  try {
    const res = await fetch('/api/filters/validate-regex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, sample })
    });
    const result = await res.json();

    if (!result.valid) {
      regexBadge.className = 'badge badge-danger';
      regexBadge.textContent = 'Invalid Syntax';
    } else if (sample && result.matches) {
      regexBadge.className = 'badge badge-success';
      regexBadge.textContent = '✓ Matches Sample';
    } else if (sample && !result.matches) {
      regexBadge.className = 'badge badge-danger';
      regexBadge.textContent = '✗ No Match';
    } else {
      regexBadge.className = 'badge badge-outline';
      regexBadge.textContent = 'Valid Pattern';
    }
  } catch (err) {}
}

if (filterValInput) filterValInput.addEventListener('input', testRegexValidation);
if (filterSampleInput) filterSampleInput.addEventListener('input', testRegexValidation);

// --- Form Actions & CRUD Handlers ---

// Create User
const formAddUser = document.getElementById('form-add-user');
if (formAddUser) {
  formAddUser.onsubmit = async (e) => {
    e.preventDefault();
    const uid = document.getElementById('new-user-uid').value.trim();
    const gid = document.getElementById('new-user-gid').value.trim();
    const username = document.getElementById('new-user-username').value.trim();
    const password = document.getElementById('new-user-password').value;
    const balance = document.getElementById('new-user-balance').value;
    const throughput = document.getElementById('new-user-throughput').value;

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, gid, username, password, balance, throughput })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert(`User #${uid} created successfully!`);
      closeModals();
      loadOverview();
    } catch (err) {
      alert('Error creating user: ' + err.message);
    }
  };
}

async function deleteUser(uid) {
  if (!confirm(`Are you sure you want to delete User #${uid}?`)) return;
  try {
    await fetch(`/api/users/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    loadOverview();
  } catch (err) {
    alert('Delete error: ' + err.message);
  }
}

// Create Group
const formAddGroup = document.getElementById('form-add-group');
if (formAddGroup) {
  formAddGroup.onsubmit = async (e) => {
    e.preventDefault();
    const gid = document.getElementById('new-group-gid').value.trim();
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gid })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert(`Group #${gid} created successfully!`);
      closeModals();
      loadOverview();
    } catch (err) {
      alert('Error creating group: ' + err.message);
    }
  };
}

// Create SMPP Connector
const formAddSmpp = document.getElementById('form-add-smpp');
if (formAddSmpp) {
  formAddSmpp.onsubmit = async (e) => {
    e.preventDefault();
    const cid = document.getElementById('new-smpp-cid').value.trim();
    const host = document.getElementById('new-smpp-host').value.trim();
    const port = document.getElementById('new-smpp-port').value.trim();
    const username = document.getElementById('new-smpp-username').value.trim();
    const password = document.getElementById('new-smpp-password').value;

    try {
      const res = await fetch('/api/connectors/smpp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid, host, port, username, password })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert(`SMPP Connector #${cid} created!`);
      closeModals();
      loadOverview();
    } catch (err) {
      alert('Error creating SMPP connector: ' + err.message);
    }
  };
}

async function startSmpp(cid) {
  try {
    await fetch(`/api/connectors/smpp/${encodeURIComponent(cid)}/start`, { method: 'POST' });
    loadOverview();
  } catch (err) {
    alert('Start error: ' + err.message);
  }
}

async function stopSmpp(cid) {
  try {
    await fetch(`/api/connectors/smpp/${encodeURIComponent(cid)}/stop`, { method: 'POST' });
    loadOverview();
  } catch (err) {
    alert('Stop error: ' + err.message);
  }
}

async function deleteSmpp(cid) {
  if (!confirm(`Are you sure you want to delete SMPP Connector #${cid}?`)) return;
  try {
    await fetch(`/api/connectors/smpp/${encodeURIComponent(cid)}`, { method: 'DELETE' });
    loadOverview();
  } catch (err) {
    alert('Delete error: ' + err.message);
  }
}

// Create HTTP Connector
const formAddHttp = document.getElementById('form-add-http');
if (formAddHttp) {
  formAddHttp.onsubmit = async (e) => {
    e.preventDefault();
    const cid = document.getElementById('new-http-cid').value.trim();
    const url = document.getElementById('new-http-url').value.trim();

    try {
      const res = await fetch('/api/connectors/http', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid, url })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert(`HTTP Webhook #${cid} created!`);
      closeModals();
      loadOverview();
    } catch (err) {
      alert('Error creating HTTP connector: ' + err.message);
    }
  };
}

async function deleteHttp(cid) {
  if (!confirm(`Are you sure you want to delete HTTP Webhook #${cid}?`)) return;
  try {
    await fetch(`/api/connectors/http/${encodeURIComponent(cid)}`, { method: 'DELETE' });
    loadOverview();
  } catch (err) {
    alert('Delete error: ' + err.message);
  }
}

// Create MT Route
const formAddMtRoute = document.getElementById('form-add-mt-route');
if (formAddMtRoute) {
  formAddMtRoute.onsubmit = async (e) => {
    e.preventDefault();
    const type = document.getElementById('new-mt-route-type').value;
    const order = document.getElementById('new-mt-route-order').value;
    const rate = document.getElementById('new-mt-route-rate').value;
    const connector = document.getElementById('new-mt-route-cid').value.trim();
    const filtersStr = document.getElementById('new-mt-route-filters').value.trim();
    const filters = filtersStr ? filtersStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    try {
      const res = await fetch('/api/routes/mt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, order, rate, connector, filters })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert('MT Route created successfully!');
      closeModals();
      loadOverview();
    } catch (err) {
      alert('Error creating MT route: ' + err.message);
    }
  };
}

async function deleteMtRoute(order) {
  if (!confirm(`Are you sure you want to delete MT Route #${order}?`)) return;
  try {
    await fetch(`/api/routes/mt/${order}`, { method: 'DELETE' });
    loadOverview();
  } catch (err) {
    alert('Delete error: ' + err.message);
  }
}

// Create MO Route
const formAddMoRoute = document.getElementById('form-add-route');
if (formAddMoRoute) {
  formAddMoRoute.onsubmit = async (e) => {
    e.preventDefault();
    const type = document.getElementById('new-route-type').value;
    const connector = document.getElementById('new-route-cid').value.trim();

    try {
      const res = await fetch('/api/routes/mo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, connector })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert('MO Route created successfully!');
      closeModals();
      loadOverview();
    } catch (err) {
      alert('Error creating MO route: ' + err.message);
    }
  };
}

async function deleteMoRoute(order) {
  if (!confirm(`Are you sure you want to delete MO Route #${order}?`)) return;
  try {
    await fetch(`/api/routes/mo/${order}`, { method: 'DELETE' });
    loadOverview();
  } catch (err) {
    alert('Delete error: ' + err.message);
  }
}

// Create Filter
const formAddFilter = document.getElementById('form-add-filter');
if (formAddFilter) {
  formAddFilter.onsubmit = async (e) => {
    e.preventDefault();
    const fid = document.getElementById('new-filter-fid').value.trim();
    const type = document.getElementById('new-filter-type').value;
    const val = document.getElementById('new-filter-val').value.trim();

    let paramKey = 'pattern';
    if (type === 'DestinationAddrFilter') paramKey = 'destination_addr';
    else if (type === 'SourceAddrFilter') paramKey = 'source_addr';
    else if (type === 'ShortMessageFilter') paramKey = 'short_message';
    else if (type === 'UserFilter') paramKey = 'uid';
    else if (type === 'GroupFilter') paramKey = 'gid';
    else if (type === 'TagFilter') paramKey = 'tag';

    try {
      const res = await fetch('/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fid, type, paramKey, paramValue: val })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert(`Filter #${fid} created successfully!`);
      closeModals();
      loadOverview();
    } catch (err) {
      alert('Error creating filter: ' + err.message);
    }
  };
}

async function deleteFilter(fid) {
  if (!confirm(`Are you sure you want to delete Filter #${fid}?`)) return;
  try {
    await fetch(`/api/filters/${encodeURIComponent(fid)}`, { method: 'DELETE' });
    loadOverview();
  } catch (err) {
    alert('Delete error: ' + err.message);
  }
}

// Test SMS Injection
const formSendSms = document.getElementById('form-send-sms');
if (formSendSms) {
  formSendSms.onsubmit = async (e) => {
    e.preventDefault();
    const resultBox = document.getElementById('sms-result-box');
    resultBox.style.display = 'block';
    resultBox.innerHTML = '<em>Injecting message into Jasmin HTTP API (Port 1401)...</em>';

    const payload = {
      username: document.getElementById('sms-user').value.trim(),
      password: document.getElementById('sms-pass').value,
      from: document.getElementById('sms-from').value.trim(),
      to: document.getElementById('sms-to').value.trim(),
      content: document.getElementById('sms-content').value.trim()
    };

    try {
      const res = await fetch('/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        resultBox.innerHTML = `
          <div class="card" style="border-left: 4px solid #22c55e;">
            <strong style="color: #22c55e;">✓ SMS Submitted Successfully</strong>
            <pre style="margin-top: 0.5rem; font-size: 0.8rem;">${data.response}</pre>
          </div>
        `;
      } else {
        resultBox.innerHTML = `
          <div class="card" style="border-left: 4px solid #ef4444;">
            <strong style="color: #ef4444;">✗ SMS Submission Failed (HTTP ${data.status})</strong>
            <pre style="margin-top: 0.5rem; font-size: 0.8rem;">${data.response || data.error}</pre>
          </div>
        `;
      }
      loadOverview();
    } catch (err) {
      resultBox.innerHTML = `<div style="color: #ef4444;">Dispatch error: ${err.message}</div>`;
    }
  };
}

// System Persistence (Save Config)
const btnPersist = document.getElementById('btn-persist');
if (btnPersist) {
  btnPersist.onclick = async () => {
    btnPersist.textContent = 'Saving...';
    try {
      const res = await fetch('/api/system/persist', { method: 'POST' });
      const data = await res.json();
      alert('Configuration persisted to disk successfully!\n\n' + data.log);
    } catch (err) {
      alert('Save failed: ' + err.message);
    } finally {
      btnPersist.textContent = 'Save Config';
    }
  };
}

const btnPersistCfg = document.getElementById('btn-persist-cfg');
if (btnPersistCfg) {
  btnPersistCfg.onclick = () => btnPersist.click();
}

// Export Snapshot Backup (JSON)
function exportSnapshot() {
  window.location.href = '/api/system/export';
}

const btnExportBackup = document.getElementById('btn-export-backup');
if (btnExportBackup) btnExportBackup.onclick = exportSnapshot;

const btnExportBackup2 = document.getElementById('btn-export-backup-2');
if (btnExportBackup2) btnExportBackup2.onclick = exportSnapshot;

// Config Loader
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const container = document.getElementById('config-sections-container');
    if (!container) return;

    container.innerHTML = Object.entries(cfg.sections || {}).map(([secName, secData]) => `
      <div class="card" style="margin-bottom: 1rem;">
        <h3 style="font-size: 1rem; color: #38bdf8; margin-bottom: 0.75rem;">[${secName}]</h3>
        <table style="width: 100%; font-family: var(--font-mono); font-size: 0.8rem;">
          ${Object.entries(secData).map(([k, v]) => `
            <tr>
              <td style="color: var(--text-muted); width: 220px; padding: 2px 0;">${k}</td>
              <td style="color: var(--text-primary); padding: 2px 0;">${v}</td>
            </tr>
          `).join('')}
        </table>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load configuration:', err);
  }
}

// Real-time Telemetry WebSocket Client
function setupWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/telemetry`);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'STATS_UPDATE') {
        renderOverview({ stats: msg.data, trafficStats: msg.data.trafficStats });
      } else if (msg.type === 'TRAFFIC_NEW') {
        handleIncomingTraffic(msg.data, false);
      } else if (msg.type === 'TRAFFIC_UPDATE') {
        handleIncomingTraffic(msg.data, true);
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    setTimeout(setupWebSocket, 3000);
  };
}

// Initial Bootstrap on DOM Load
window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  loadOverview();
  setupWebSocket();

  const initialTab = location.hash.replace('#', '');
  if (initialTab) {
    switchTab(initialTab);
  }

  // Fallback poll every 5s if WebSocket disconnects
  setInterval(loadOverview, 5000);
});

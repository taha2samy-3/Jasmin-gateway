// Jasmin Enterprise Console Frontend Engine
let trafficChart;
let statusChart;
let smppBindsChart;
let liquidityChart;

let lastRequestCount = 0;
const historyPoints = Array(20).fill(0);
const historyLabels = Array(20).fill('');

// Initialize Charts (Monochrome Linear & Nord Theme)
function initCharts() {
  // 1. Traffic Velocity Line Chart
  const ctxTraffic = document.getElementById('trafficChart').getContext('2d');
  trafficChart = new Chart(ctxTraffic, {
    type: 'line',
    data: {
      labels: historyLabels,
      datasets: [{
        label: 'HTTP Requests/Sec',
        data: historyPoints,
        borderColor: '#ffffff',
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#18181b',
          borderColor: '#3f3f46',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#a1a1aa'
        }
      },
      scales: {
        x: { display: false },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(39, 39, 42, 0.7)' },
          ticks: { color: '#71717a', font: { family: 'JetBrains Mono, monospace', size: 10 } }
        }
      }
    }
  });

  // 2. Delivery & Status Ratio Doughnut Chart
  const ctxStatus = document.getElementById('statusChart').getContext('2d');
  statusChart = new Chart(ctxStatus, {
    type: 'doughnut',
    data: {
      labels: ['Success (200)', 'Auth Error', 'Route Error', 'Throttling', 'Other Error'],
      datasets: [{
        data: [0, 0, 0, 0, 0],
        backgroundColor: [
          '#ffffff',
          'rgba(239, 68, 68, 0.85)',
          'rgba(249, 115, 22, 0.85)',
          'rgba(168, 85, 247, 0.85)',
          'rgba(113, 113, 122, 0.6)'
        ],
        borderColor: '#18181b',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#a1a1aa', font: { family: 'JetBrains Mono, monospace', size: 10 }, boxWidth: 10 }
        }
      },
      cutout: '68%'
    }
  });

  // 3. SMPP Protocol Binds Horizontal Bar Chart
  const ctxSmpp = document.getElementById('smppBindsChart').getContext('2d');
  smppBindsChart = new Chart(ctxSmpp, {
    type: 'bar',
    data: {
      labels: ['Bound TRX', 'Bound TX', 'Bound RX', 'Connected', 'Connectors'],
      datasets: [{
        label: 'Sessions',
        data: [0, 0, 0, 0, 0],
        backgroundColor: 'rgba(255, 255, 255, 0.85)',
        borderColor: '#ffffff',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { color: '#71717a', stepSize: 1, font: { family: 'JetBrains Mono, monospace', size: 10 } },
          grid: { color: 'rgba(39, 39, 42, 0.7)' }
        },
        y: {
          ticks: { color: '#a1a1aa', font: { family: 'JetBrains Mono, monospace', size: 10 } },
          grid: { display: false }
        }
      }
    }
  });

  // 4. Account Credit Liquidity Bar Chart
  const ctxLiq = document.getElementById('liquidityChart').getContext('2d');
  liquidityChart = new Chart(ctxLiq, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Balance ($)',
        data: [],
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        borderColor: '#ffffff',
        borderWidth: 1.5,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: { color: '#a1a1aa', font: { family: 'JetBrains Mono, monospace', size: 10 } },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#71717a', font: { family: 'JetBrains Mono, monospace', size: 10 } },
          grid: { color: 'rgba(39, 39, 42, 0.7)' }
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
  document.getElementById(id).classList.add('open');
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
}

document.getElementById('btn-open-add-user').onclick = () => openModal('modal-add-user');
document.getElementById('btn-open-add-connector').onclick = () => openModal('modal-add-connector');
document.getElementById('btn-open-add-smpp-connector').onclick = () => openModal('modal-add-smpp-connector');
document.getElementById('btn-open-add-route').onclick = () => openModal('modal-add-route');
document.getElementById('btn-open-add-mt-route').onclick = () => openModal('modal-add-mt-route');
document.getElementById('btn-open-add-filter').onclick = () => openModal('modal-add-filter');

// Fetch and render overview
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
  // Counts
  document.getElementById('stat-http-requests').textContent = data.stats.httpApi.requestCount;
  document.getElementById('stat-http-success').textContent =
    `Success: ${data.stats.httpApi.successCount} | Errors: ${data.stats.httpApi.authErrorCount + data.stats.httpApi.routeErrorCount}`;
  document.getElementById('stat-total-users').textContent = data.counts.users;
  document.getElementById('stat-total-groups').textContent = `${data.counts.groups} Groups configured`;
  document.getElementById('stat-http-connectors').textContent = data.counts.httpConnectors;
  document.getElementById('stat-mo-routes').textContent = data.counts.moRoutes;

  // Chart update
  const delta = Math.max(0, data.stats.httpApi.requestCount - lastRequestCount);
  lastRequestCount = data.stats.httpApi.requestCount;
  historyPoints.shift();
  historyPoints.push(delta);
  if (trafficChart) trafficChart.update();

  // 1. Delivery & Error Distribution Doughnut Update
  if (statusChart) {
    const s = data.stats.httpApi;
    const sm = data.stats.smppsApi;
    const totalEvents = s.successCount + s.authErrorCount + s.routeErrorCount + sm.otherSubmitErrorCount + sm.throttlingErrorCount;
    const badgeEl = document.getElementById('badge-total-events');
    if (badgeEl) badgeEl.textContent = `${totalEvents} Events`;
    statusChart.data.datasets[0].data = [
      s.successCount || 0,
      s.authErrorCount || 0,
      s.routeErrorCount || 0,
      sm.throttlingErrorCount || 0,
      sm.otherSubmitErrorCount || 0
    ];
    statusChart.update();
  }

  // 2. SMPP Binds Breakdown Update
  if (smppBindsChart) {
    const sm = data.stats.smppsApi;
    smppBindsChart.data.datasets[0].data = [
      sm.boundTrxCount || 0,
      sm.boundTxCount || 0,
      sm.boundRxCount || 0,
      sm.connectedCount || 0,
      data.counts.smppConnectors || 0
    ];
    smppBindsChart.update();
  }

  // 3. User Liquidity Bar Chart Update
  if (liquidityChart && data.users) {
    liquidityChart.data.labels = data.users.map(u => u.username || u.uid);
    liquidityChart.data.datasets[0].data = data.users.map(u => parseFloat(u.balance) || 0);
    liquidityChart.update();
  }

  // Core Stats Table
  const tbodyStats = document.querySelector('#table-overview-stats tbody');
  tbodyStats.innerHTML = `
    <tr>
      <td><strong>HTTP API (Port 1401)</strong></td>
      <td><code>${data.stats.httpApi.createdAt}</code></td>
      <td>${data.stats.httpApi.requestCount}</td>
      <td><span class="badge badge-success">${data.stats.httpApi.successCount}</span></td>
      <td><span class="badge ${data.stats.httpApi.authErrorCount > 0 ? 'badge-danger' : 'badge-dark'}">${data.stats.httpApi.authErrorCount}</span></td>
      <td><span class="badge ${data.stats.httpApi.routeErrorCount > 0 ? 'badge-danger' : 'badge-dark'}">${data.stats.httpApi.routeErrorCount}</span></td>
      <td><code>${data.stats.httpApi.lastRequestAt}</code></td>
    </tr>
    <tr>
      <td><strong>SMPP Server API (Port 2775)</strong></td>
      <td><code>${data.stats.smppsApi.createdAt}</code></td>
      <td>${data.stats.smppsApi.submitSmCount}</td>
      <td><span class="badge badge-success">${data.stats.smppsApi.boundTrxCount} binds</span></td>
      <td><span class="badge badge-dark">0</span></td>
      <td><span class="badge ${data.stats.smppsApi.otherSubmitErrorCount > 0 ? 'badge-danger' : 'badge-dark'}">${data.stats.smppsApi.otherSubmitErrorCount}</span></td>
      <td>Connected: <strong>${data.stats.smppsApi.connectedCount}</strong></td>
    </tr>
  `;

  // Users Table
  const tbodyUsers = document.querySelector('#table-users tbody');
  if (data.users.length === 0) {
    tbodyUsers.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No users found. Click "+ Add User" to create one.</td></tr>`;
  } else {
    tbodyUsers.innerHTML = data.users.map(u => `
      <tr>
        <td><strong>#${u.uid}</strong></td>
        <td><span class="badge badge-outline">${u.gid}</span></td>
        <td><code>${u.username}</code></td>
        <td><span style="font-weight: 700; color: var(--text-primary);">$${parseFloat(u.balance).toFixed(2)}</span></td>
        <td>${u.mtSmsQuota}</td>
        <td>${u.throughput} msg/s</td>
        <td>
          <button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;" onclick="deleteUser('${u.uid}')">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // SMPP Connectors Table
  const tbodySmpp = document.querySelector('#table-smpp-connectors tbody');
  if (!data.smppConnectors || data.smppConnectors.length === 0) {
    tbodySmpp.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No SMPP Connectors configured. Click "+ Add SMPP Connector" to add one.</td></tr>`;
  } else {
    tbodySmpp.innerHTML = data.smppConnectors.map(c => `
      <tr>
        <td><strong>#${c.cid}</strong></td>
        <td>
          <span class="badge ${c.service === 'started' ? 'badge-success' : 'badge-danger'}">
            ${c.service.toUpperCase()}
          </span>
        </td>
        <td><code>${c.session}</code></td>
        <td>${c.starts}</td>
        <td>${c.stops}</td>
        <td>
          <div style="display: flex; gap: 0.35rem;">
            ${c.service === 'started'
              ? `<button class="btn btn-outline" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="stopSmpp('${c.cid}')">Stop</button>`
              : `<button class="btn btn-primary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="startSmpp('${c.cid}')">Start</button>`
            }
            <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="deleteSmpp('${c.cid}')">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  // HTTP Connectors Table
  const tbodyConn = document.querySelector('#table-connectors tbody');
  if (data.httpConnectors.length === 0) {
    tbodyConn.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No HTTP Connectors configured.</td></tr>`;
  } else {
    tbodyConn.innerHTML = data.httpConnectors.map(c => `
      <tr>
        <td><strong>#${c.cid}</strong></td>
        <td>${c.type}</td>
        <td><span class="badge badge-outline">${c.method}</span></td>
        <td style="font-family: var(--font-mono); font-size: 0.8rem;">${c.url}</td>
        <td>
          <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="deleteHttp('${c.cid}')">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // MT Routes Table
  const tbodyMtRoutes = document.querySelector('#table-mt-routes tbody');
  if (!data.mtRoutes || data.mtRoutes.length === 0) {
    tbodyMtRoutes.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No MT Routes configured. Click "+ Add MT Route" to add one.</td></tr>`;
  } else {
    tbodyMtRoutes.innerHTML = data.mtRoutes.map(r => `
      <tr>
        <td><strong>#${r.order}</strong></td>
        <td><span class="badge badge-outline">${r.type}</span></td>
        <td><span style="font-weight: 700; color: var(--text-primary);">$${parseFloat(r.rate).toFixed(4)}</span></td>
        <td><code>${r.connector}</code></td>
        <td>${r.filters.length > 0 ? r.filters.join(', ') : 'None'}</td>
        <td>
          <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="deleteMtRoute(${r.order})">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // MO Routes Table
  const tbodyRoutes = document.querySelector('#table-routes tbody');
  if (data.moRoutes.length === 0) {
    tbodyRoutes.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No MO Routes configured.</td></tr>`;
  } else {
    tbodyRoutes.innerHTML = data.moRoutes.map(r => `
      <tr>
        <td><strong>#${r.order}</strong></td>
        <td><span class="badge badge-outline">${r.type}</span></td>
        <td><code>${r.connector}</code></td>
        <td>${r.filters.length > 0 ? r.filters.join(', ') : 'None'}</td>
        <td>
          <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="deleteMoRoute(${r.order})">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // Filters Table (filtersm)
  const tbodyFilters = document.querySelector('#table-filters tbody');
  if (tbodyFilters) {
    if (!data.filters || data.filters.length === 0) {
      tbodyFilters.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No Filters configured. Click "+ Add Filter" to define routing policies.</td></tr>`;
    } else {
      tbodyFilters.innerHTML = data.filters.map(f => `
        <tr>
          <td><strong>#${f.fid}</strong></td>
          <td><span class="badge badge-outline">${f.type}</span></td>
          <td><span class="badge badge-dark">${f.routes || 'MO MT'}</span></td>
          <td style="font-family: var(--font-mono); font-size: 0.82rem;"><code>${f.description || 'None'}</code></td>
          <td>
            <button class="btn btn-danger" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" onclick="deleteFilter('${f.fid}')">Delete</button>
          </td>
        </tr>
      `).join('');
    }
  }

  // Interceptors Table (interceptorm)
  const tbodyInt = document.querySelector('#table-interceptors tbody');
  if (tbodyInt) {
    const allInts = [
      ...(data.mtInterceptors || []).map(i => ({ ...i, direction: 'MT (Outbound)' })),
      ...(data.moInterceptors || []).map(i => ({ ...i, direction: 'MO (Inbound)' }))
    ];
    if (allInts.length === 0) {
      tbodyInt.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No Python Interceptors configured.</td></tr>`;
    } else {
      tbodyInt.innerHTML = allInts.map(i => `
        <tr>
          <td><strong>#${i.order}</strong></td>
          <td><span class="badge badge-dark">${i.direction}</span></td>
          <td><span class="badge badge-outline">${i.type}</span></td>
          <td style="font-family: var(--font-mono); font-size: 0.82rem;"><code>${i.script}</code></td>
          <td>${i.filters.length > 0 ? i.filters.join(', ') : 'None'}</td>
        </tr>
      `).join('');
    }
  }
}

// Actions: Delete Filter
async function deleteFilter(fid) {
  if (!confirm(`Are you sure you want to delete filter ${fid}?`)) return;
  try {
    const res = await fetch(`/api/filters/${encodeURIComponent(fid)}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'Filter removed');
    loadOverview();
  } catch (err) {
    alert('Failed to delete filter: ' + err.message);
  }
}

// Actions: Delete User
async function deleteUser(uid) {
  if (!confirm(`Are you sure you want to delete user ${uid}?`)) return;
  try {
    const res = await fetch(`/api/users/${uid}`, { method: 'DELETE' });
    const result = await res.json();
    alert(result.message || 'User deleted');
    loadOverview();
  } catch (err) {
    alert('Failed to delete user: ' + err.message);
  }
}

// Forms: Add User
document.getElementById('form-add-user').onsubmit = async (e) => {
  e.preventDefault();
  const uid = document.getElementById('new-user-uid').value;
  const gid = document.getElementById('new-user-gid').value;
  const username = document.getElementById('new-user-username').value;
  const password = document.getElementById('new-user-password').value;
  const balance = document.getElementById('new-user-balance').value;

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, gid, username, password, balance })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'User created successfully!');
    closeModals();
    loadOverview();
  } catch (err) {
    alert('Error creating user: ' + err.message);
  }
};

// Forms: Add Connector
document.getElementById('form-add-connector').onsubmit = async (e) => {
  e.preventDefault();
  const cid = document.getElementById('new-conn-cid').value;
  const url = document.getElementById('new-conn-url').value;
  const method = document.getElementById('new-conn-method').value;

  try {
    const res = await fetch('/api/connectors/http', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, url, method })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'Connector created successfully!');
    closeModals();
    loadOverview();
  } catch (err) {
    alert('Error creating connector: ' + err.message);
  }
};

// Forms: Add Route
document.getElementById('form-add-route').onsubmit = async (e) => {
  e.preventDefault();
  const type = document.getElementById('new-route-type').value;
  const connector = document.getElementById('new-route-cid').value;

  try {
    const res = await fetch('/api/routes/mo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, connector })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'Route created successfully!');
    closeModals();
    loadOverview();
  } catch (err) {
    alert('Error creating route: ' + err.message);
  }
};

// SMPP Actions
async function startSmpp(cid) {
  try {
    const res = await fetch(`/api/connectors/smpp/${cid}/start`, { method: 'POST' });
    const result = await res.json();
    alert(result.message || 'Connector started');
    loadOverview();
  } catch (err) {
    alert('Failed to start connector: ' + err.message);
  }
}

async function stopSmpp(cid) {
  try {
    const res = await fetch(`/api/connectors/smpp/${cid}/stop`, { method: 'POST' });
    const result = await res.json();
    alert(result.message || 'Connector stopped');
    loadOverview();
  } catch (err) {
    alert('Failed to stop connector: ' + err.message);
  }
}

async function deleteSmpp(cid) {
  if (!confirm(`Are you sure you want to remove SMPP connector ${cid}?`)) return;
  try {
    const res = await fetch(`/api/connectors/smpp/${encodeURIComponent(cid)}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'SMPP Connector removed');
    loadOverview();
  } catch (err) {
    alert('Failed to remove SMPP connector: ' + err.message);
  }
}

async function deleteHttp(cid) {
  if (!confirm(`Are you sure you want to remove HTTP connector ${cid}?`)) return;
  try {
    const res = await fetch(`/api/connectors/http/${encodeURIComponent(cid)}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'HTTP Connector removed');
    loadOverview();
  } catch (err) {
    alert('Failed to remove HTTP connector: ' + err.message);
  }
}

async function deleteMtRoute(order) {
  if (!confirm(`Are you sure you want to remove MT route #${order}?`)) return;
  try {
    const res = await fetch(`/api/routes/mt/${order}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'MT Route removed');
    loadOverview();
  } catch (err) {
    alert('Failed to remove MT route: ' + err.message);
  }
}

async function deleteMoRoute(order) {
  if (!confirm(`Are you sure you want to remove MO route #${order}?`)) return;
  try {
    const res = await fetch(`/api/routes/mo/${order}`, { method: 'DELETE' });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'MO Route removed');
    loadOverview();
  } catch (err) {
    alert('Failed to remove MO route: ' + err.message);
  }
}

// Forms: Add SMPP Connector
document.getElementById('form-add-smpp-connector').onsubmit = async (e) => {
  e.preventDefault();
  const cid = document.getElementById('new-smpp-cid').value;
  const host = document.getElementById('new-smpp-host').value;
  const port = document.getElementById('new-smpp-port').value;
  const username = document.getElementById('new-smpp-user').value;
  const password = document.getElementById('new-smpp-pass').value;

  try {
    const res = await fetch('/api/connectors/smpp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, host, port, username, password })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'SMPP Connector created successfully!');
    closeModals();
    loadOverview();
  } catch (err) {
    alert('Error creating SMPP connector: ' + err.message);
  }
};

// Forms: Add MT Route
document.getElementById('form-add-mt-route').onsubmit = async (e) => {
  e.preventDefault();
  const type = document.getElementById('new-mt-route-type').value;
  const rate = document.getElementById('new-mt-route-rate').value;
  const connector = document.getElementById('new-mt-route-cid').value;
  const filters = document.getElementById('new-mt-route-filters').value.trim();

  try {
    const res = await fetch('/api/routes/mt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, rate, connector, filters: filters || undefined })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'MT Route created successfully!');
    closeModals();
    loadOverview();
  } catch (err) {
    alert('Error creating MT route: ' + err.message);
  }
};

// Forms: Add Filter
const filterTypeEl = document.getElementById('new-filter-type');
if (filterTypeEl) {
  filterTypeEl.addEventListener('change', () => {
    const labelEl = document.getElementById('label-filter-val');
    const inputEl = document.getElementById('new-filter-val');
    const t = filterTypeEl.value;
    if (t === 'DestinationAddrFilter') {
      labelEl.textContent = 'Destination Regex (e.g. ^201[0-9]+)';
      inputEl.placeholder = '^201[0-9]+';
      inputEl.disabled = false;
    } else if (t === 'SourceAddrFilter') {
      labelEl.textContent = 'Source ID Regex (e.g. ^AUTH)';
      inputEl.placeholder = '^AUTH';
      inputEl.disabled = false;
    } else if (t === 'ShortMessageFilter') {
      labelEl.textContent = 'Message Regex (e.g. (?i)OTP)';
      inputEl.placeholder = '(?i)OTP';
      inputEl.disabled = false;
    } else if (t === 'UserFilter') {
      labelEl.textContent = 'User UID (e.g. app_user_01)';
      inputEl.placeholder = 'app_user_01';
      inputEl.disabled = false;
    } else if (t === 'TagFilter') {
      labelEl.textContent = 'Tag (Integer)';
      inputEl.placeholder = '100';
      inputEl.disabled = false;
    } else if (t === 'TransparentFilter') {
      labelEl.textContent = 'No Parameters Required';
      inputEl.placeholder = 'N/A';
      inputEl.disabled = true;
    }
  });
}

document.getElementById('form-add-filter').onsubmit = async (e) => {
  e.preventDefault();
  const fid = document.getElementById('new-filter-fid').value.trim();
  const type = document.getElementById('new-filter-type').value;
  const val = document.getElementById('new-filter-val').value.trim();

  let paramKey = '';
  if (type === 'DestinationAddrFilter') paramKey = 'destination_addr';
  else if (type === 'SourceAddrFilter') paramKey = 'source_addr';
  else if (type === 'ShortMessageFilter') paramKey = 'short_message';
  else if (type === 'UserFilter') paramKey = 'uid';
  else if (type === 'TagFilter') paramKey = 'tag';

  try {
    const res = await fetch('/api/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fid, type, paramKey, paramValue: val })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    alert(result.message || 'Filter created successfully!');
    closeModals();
    loadOverview();
  } catch (err) {
    alert('Error creating filter: ' + err.message);
  }
};

// Actions: Send Test SMS
document.getElementById('form-sms-send').onsubmit = async (e) => {
  e.preventDefault();
  const logEl = document.getElementById('sms-response-log');
  logEl.textContent = 'Submitting message to Jasmin HTTP API...';

  const username = document.getElementById('sms-user').value;
  const password = document.getElementById('sms-pass').value;
  const to = document.getElementById('sms-to').value;
  const from = document.getElementById('sms-from').value;
  const content = document.getElementById('sms-content').value;

  try {
    const res = await fetch('/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, to, from, content })
    });
    const result = await res.json();
    logEl.textContent = JSON.stringify(result, null, 2);
    loadOverview();
  } catch (err) {
    logEl.textContent = 'Dispatch error: ' + err.message;
  }
};

// Actions: Persist
document.getElementById('btn-persist').onclick = async () => {
  const btn = document.getElementById('btn-persist');
  btn.textContent = '⏳ Persisting...';
  try {
    const res = await fetch('/api/system/persist', { method: 'POST' });
    const result = await res.json();
    alert('Configuration persisted to disk successfully!\n\n' + result.log);
  } catch (err) {
    alert('Persist failed: ' + err.message);
  } finally {
    btn.textContent = '💾 Persist Config';
  }
};

// Config Loader
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const pathEl = document.getElementById('config-file-path');
    const headerPathEl = document.getElementById('cfg-header-path');
    const rawViewEl = document.getElementById('config-raw-view');
    if (pathEl) pathEl.textContent = cfg.filePath;
    if (headerPathEl) headerPathEl.textContent = cfg.filePath;
    if (rawViewEl) rawViewEl.textContent = cfg.rawMasked || '# Configuration empty or not found';

    const jcli = cfg.sections['jcli'] || {};
    const http = cfg.sections['http-api'] || {};
    const smpp = cfg.sections['smpp-server'] || {};
    const persistence = cfg.sections['persistence'] || {};

    const jcliSock = document.getElementById('cfg-jcli-socket');
    const jcliUser = document.getElementById('cfg-jcli-user');
    const httpSock = document.getElementById('cfg-http-socket');
    const smppSock = document.getElementById('cfg-smpp-socket');
    const smppBill = document.getElementById('cfg-smpp-billing');
    const storeDir = document.getElementById('cfg-store-dir');

    if (jcliSock) jcliSock.textContent = `${jcli.bind || '127.0.0.1'}:${jcli.port || '8990'}`;
    if (jcliUser) jcliUser.textContent = `Admin: ${jcli.admin_username || jcli.admin_user || 'jcliadmin'} (MD5 Auth)`;
    if (httpSock) httpSock.textContent = `${http.bind || '0.0.0.0'}:${http.port || '1401'}`;
    if (smppSock) smppSock.textContent = `${smpp.bind || '0.0.0.0'}:${smpp.port || '2775'}`;
    if (smppBill) smppBill.textContent = `Billing: ${smpp.billing_feature === 'False' ? 'Disabled' : 'Enabled'}`;
    if (storeDir) storeDir.textContent = persistence.store_path || '/etc/jasmin/store';
  } catch (err) {
    console.error('Failed to load configuration:', err);
  }
}

function copyConfig() {
  const text = document.getElementById('config-raw-view').textContent;
  navigator.clipboard.writeText(text).then(() => {
    alert('Configuration copied to clipboard!');
  }).catch(err => {
    alert('Failed to copy: ' + err.message);
  });
}

// Setup WebSocket
function setupWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'STATS_UPDATE') {
        loadOverview();
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    setTimeout(setupWebSocket, 3000);
  };
}

// Start
window.addEventListener('DOMContentLoaded', () => {
  initCharts();
  loadOverview();
  setupWebSocket();
  const initialTab = location.hash.replace('#', '');
  if (initialTab) {
    switchTab(initialTab);
  }
  setInterval(loadOverview, 4000);
});

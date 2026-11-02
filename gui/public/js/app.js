// Jasmin Enterprise Console Frontend Engine
let trafficChart;
let lastRequestCount = 0;
const historyPoints = Array(20).fill(0);
const historyLabels = Array(20).fill('');

// Initialize Chart
function initChart() {
  const ctx = document.getElementById('trafficChart').getContext('2d');
  trafficChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: historyLabels,
      datasets: [{
        label: 'HTTP Requests/Sec',
        data: historyPoints,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.15)',
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { display: false },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(55, 65, 81, 0.5)' },
          ticks: { color: '#9ca3af' }
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
document.getElementById('btn-open-add-route').onclick = () => openModal('modal-add-route');

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

  // Core Stats Table
  const tbodyStats = document.querySelector('#table-overview-stats tbody');
  tbodyStats.innerHTML = `
    <tr>
      <td><strong>HTTP API (Port 1401)</strong></td>
      <td>${data.stats.httpApi.createdAt}</td>
      <td>${data.stats.httpApi.requestCount}</td>
      <td><span style="color: #10b981; font-weight: bold;">${data.stats.httpApi.successCount}</span></td>
      <td><span style="color: #ef4444;">${data.stats.httpApi.authErrorCount}</span></td>
      <td><span style="color: #f59e0b;">${data.stats.httpApi.routeErrorCount}</span></td>
      <td>${data.stats.httpApi.lastRequestAt}</td>
    </tr>
    <tr>
      <td><strong>SMPP Server API (Port 2775)</strong></td>
      <td>${data.stats.smppsApi.createdAt}</td>
      <td>${data.stats.smppsApi.submitSmCount}</td>
      <td><span style="color: #10b981; font-weight: bold;">${data.stats.smppsApi.boundTrxCount} binds</span></td>
      <td>0</td>
      <td><span style="color: #f59e0b;">${data.stats.smppsApi.otherSubmitErrorCount}</span></td>
      <td>Connected: ${data.stats.smppsApi.connectedCount}</td>
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
        <td><span class="badge" style="background: rgba(139, 92, 246, 0.2); color: #c4b5fd;">${u.gid}</span></td>
        <td>${u.username}</td>
        <td><span style="color: #10b981; font-weight: 700;">${u.balance}</span></td>
        <td>${u.mtSmsQuota}</td>
        <td>${u.throughput}</td>
        <td>
          <button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;" onclick="deleteUser('${u.uid}')">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  // Connectors Table
  const tbodyConn = document.querySelector('#table-connectors tbody');
  if (data.httpConnectors.length === 0) {
    tbodyConn.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No HTTP Connectors configured.</td></tr>`;
  } else {
    tbodyConn.innerHTML = data.httpConnectors.map(c => `
      <tr>
        <td><strong>#${c.cid}</strong></td>
        <td>${c.type}</td>
        <td><span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa;">${c.method}</span></td>
        <td style="font-family: var(--font-mono); font-size: 0.8rem;">${c.url}</td>
        <td><span class="badge badge-success">ACTIVE</span></td>
      </tr>
    `).join('');
  }

  // Routes Table
  const tbodyRoutes = document.querySelector('#table-routes tbody');
  if (data.moRoutes.length === 0) {
    tbodyRoutes.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No MO Routes configured.</td></tr>`;
  } else {
    tbodyRoutes.innerHTML = data.moRoutes.map(r => `
      <tr>
        <td><strong>#${r.order}</strong></td>
        <td><span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399;">${r.type}</span></td>
        <td><code>${r.connector}</code></td>
        <td>${r.filters.length > 0 ? r.filters.join(', ') : 'None'}</td>
        <td><span class="badge badge-success">RUNNING</span></td>
      </tr>
    `).join('');
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
  initChart();
  loadOverview();
  setupWebSocket();
  const initialTab = location.hash.replace('#', '');
  if (initialTab) {
    switchTab(initialTab);
  }
  setInterval(loadOverview, 4000);
});

import { api, connectorHealth, fmtNum, fmtTime, html, icon, on, pct, render, toastError } from '../lib.js';
import { loadScript, statusBadge } from './shared.js';

const POINTS = 60;

export default async function overview(root, ctx) {
  render(
    root,
    html`<div class="page">
      <div class="page-head">
        <div><h1>Overview</h1><p>Live health of the gateway: API usage, carrier links and message flow.</p></div>
        <div class="actions"><button class="btn" data-refresh>${icon('refresh')} Refresh</button></div>
      </div>
      <div data-banner></div>
      <div class="kpis" data-kpis>${[1, 2, 3, 4].map(() => html`<div class="kpi"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%;height:24px;margin-top:10px"></div></div>`)}</div>
      <div class="grid grid-main" style="margin-bottom:16px">
        <section class="card">
          <div class="card-head">
            <div><h2>Throughput</h2><p>Messages per second, sampled every 2.5 s</p></div>
            <div class="legend" aria-hidden="true"><span><i style="background:var(--series-1)"></i>HTTP API requests</span><span><i style="background:var(--series-2)"></i>SMPP submit_sm</span></div>
          </div>
          <div class="card-body"><div class="chart-box"><canvas data-chart role="img" aria-label="Throughput over the last minutes for HTTP API requests and SMPP submit_sm"></canvas></div></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Carrier links</h2><p>SMPP client connectors</p></div><a class="btn sm" href="#/connectors">Manage</a></div>
          <ul class="health-list" data-links><li><div class="skeleton" style="width:100%"></div></li></ul>
        </section>
      </div>
      <section class="card" style="margin-bottom:16px">
        <div class="card-head"><div><h2>MT routing pipeline</h2><p>How submitted messages travel from ingress to a carrier</p></div><a class="btn sm" href="#/flow">${icon('flow')} Open flow editor</a></div>
        <div class="card-body"><div class="pipeline" data-pipeline></div></div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Recent messages</h2><p>From the RabbitMQ traffic tap</p></div><a class="btn sm" href="#/traffic">View all</a></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Message ID</th><th>From</th><th>To</th><th>Connector</th><th>Status</th></tr></thead><tbody data-recent></tbody></table></div>
      </section>
    </div>`
  );

  const $ = (s) => root.querySelector(s);
  let state = null;
  let stats = null;
  let traffic = null;
  const samples = []; // {t, http, smpp}
  let chart = null;

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function drawKpis() {
    const h = stats?.httpApi;
    const s = stats?.smppsApi;
    const conns = stats?.smppConnectors || state?.smppConnectors || [];
    const bound = conns.filter((c) => connectorHealth(c).level === 'ok').length;
    const started = conns.filter((c) => c.service === 'started').length;
    const t = traffic || state?.traffic || { total: 0, delivered: 0, errors: 0, esmeRok: 0 };
    const httpErrors = h ? h.authErrorCount + h.routeErrorCount + h.throughputErrorCount + h.chargingErrorCount + h.serverErrorCount + h.interceptorErrorCount : 0;
    const binds = s ? s.boundTrxCount + s.boundRxCount + s.boundTxCount : 0;
    render(
      $('[data-kpis]'),
      html`
      <div class="kpi"><div class="kpi-label">${icon('globe')} HTTP API requests</div><div class="kpi-value">${h ? fmtNum(h.requestCount) : '—'}</div>
        <div class="kpi-foot"><span>Success <b>${h ? pct(h.successCount, h.requestCount) : '—'}</b></span><span>Errors <b class="${httpErrors ? 'text-err' : ''}">${fmtNum(httpErrors)}</b></span></div></div>
      <div class="kpi"><div class="kpi-label">${icon('server')} SMPP server</div><div class="kpi-value">${s ? fmtNum(s.submitSmCount) : '—'}</div>
        <div class="kpi-foot"><span>submit_sm received</span><span>Binds <b>${fmtNum(binds)}</b></span><span>Throttled <b>${s ? fmtNum(s.throttlingErrorCount) : '—'}</b></span></div></div>
      <div class="kpi"><div class="kpi-label">${icon('plug')} Carrier links bound</div><div class="kpi-value">${conns.length ? `${bound} / ${conns.length}` : '0'}</div>
        <div class="kpi-foot"><span>Started <b>${started}</b></span><span>Stopped <b>${conns.length - started}</b></span></div></div>
      <div class="kpi"><div class="kpi-label">${icon('activity')} Messages seen</div><div class="kpi-value">${fmtNum(t.total)}</div>
        <div class="kpi-foot"><span>Accepted <b>${fmtNum(t.esmeRok + t.delivered)}</b></span><span>Delivered <b>${fmtNum(t.delivered)}</b></span><span>Failed <b class="${t.errors ? 'text-err' : ''}">${fmtNum(t.errors)}</b></span></div></div>`
    );
  }

  function drawLinks() {
    const conns = stats?.smppConnectors || state?.smppConnectors || [];
    if (!conns.length) {
      render($('[data-links]'), html`<li class="empty" style="display:block">${icon('plug')}<h3>No SMPP connectors</h3><p>Add a carrier link to start sending.</p></li>`);
      return;
    }
    render(
      $('[data-links]'),
      conns.map((c) => {
        const h = connectorHealth(c);
        return html`<li><span class="dot ${h.level}"></span><div><div class="name">${c.cid}</div><div class="muted" style="font-size:12px">${h.text}</div></div>
          <div class="meta"><div>Submits <b style="color:var(--text-2)">${c.submits || '0'}</b></div><div>Delivers ${c.delivers || '0'}</div></div></li>`;
      })
    );
  }

  function drawPipeline() {
    if (!state) return;
    const steps = [
      ['Ingress', 2, 'HTTP :' + (ctx.status?.ports?.http ?? 1401) + ' · SMPP :' + (ctx.status?.ports?.smpp ?? 2775), 'var(--st-ingress)'],
      ['Users', state.users.length, `${state.groups.length} group(s)`, 'var(--st-user)'],
      ['Interceptors', state.mtInterceptors.length, 'MT scripts', 'var(--st-interceptor)'],
      ['Filters', state.filters.length, 'match rules', 'var(--st-filter)'],
      ['MT routes', state.mtRoutes.length, state.mtRoutes.some((r) => r.order === 0) ? 'default route set' : 'no default route', 'var(--st-route)'],
      ['Connectors', state.smppConnectors.length, `${state.httpConnectors.length} HTTP (MO)`, 'var(--st-connector)']
    ];
    render(
      $('[data-pipeline]'),
      steps.map(
        ([label, value, sub, color], i) =>
          html`${i ? html`<div class="pipe-arrow">${icon('arrowRight')}</div>` : ''}<div class="pipe-step" style="--c:${color}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`
      )
    );
  }

  async function drawRecent() {
    if (!ctx.can('traffic:read')) return;
    try {
      const { messages } = await api('/api/traffic', { query: { limit: 8 } });
      render(
        $('[data-recent]'),
        messages.length
          ? messages.map(
              (m) => html`<tr><td class="nowrap mono">${fmtTime(m.timestamp)}</td><td class="mono ellipsis">${m.msgid}</td><td>${m.sourceAddr || '—'}</td><td class="mono">${m.destAddr || '—'}</td>
                <td>${m.routedCid ? html`<span class="chip">${m.routedCid}</span>` : '—'}</td><td>${statusBadge(m.status)}</td></tr>`
            )
          : html`<tr><td colspan="6"><div class="empty">${icon('inbox')}<h3>No messages yet</h3><p>${ctx.status?.amqp?.connected ? 'Messages appear here as soon as the gateway handles traffic.' : 'The traffic tap is not connected to RabbitMQ.'}</p></div></td></tr>`
      );
    } catch {}
  }

  async function initChart() {
    await loadScript('/vendor/chart.umd.js');
    const Chart = window.Chart;
    const canvas = $('[data-chart]');
    if (!canvas) return;
    const ds = (label, color) => ({ label, data: [], borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, fill: false });
    chart = new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: [ds('HTTP API requests/s', css('--series-1')), ds('SMPP submit_sm/s', css('--series-2'))] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)}` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: css('--muted'), maxTicksLimit: 6, font: { size: 11 } }, border: { display: false } },
          y: { beginAtZero: true, grid: { color: css('--grid-line') }, border: { display: false }, ticks: { color: css('--muted'), font: { size: 11 }, precision: 0 }, title: { display: true, text: 'msg/s', color: css('--muted'), font: { size: 11 } } }
        }
      }
    });
    updateChart();
  }

  function updateChart() {
    if (!chart) return;
    chart.data.labels = samples.map((p) => fmtTime(p.t));
    chart.data.datasets[0].data = samples.map((p) => p.http);
    chart.data.datasets[1].data = samples.map((p) => p.smpp);
    chart.update('none');
  }

  let last = null;
  function onStats(d) {
    stats = d;
    traffic = d.traffic;
    const now = { t: d.at || Date.now(), http: d.httpApi.requestCount, smpp: d.smppsApi.submitSmCount };
    if (last) {
      const dt = (now.t - last.t) / 1000;
      if (dt > 0) {
        // Counters reset when Jasmin restarts: clamp negative deltas to 0.
        samples.push({ t: now.t, http: Math.max(0, now.http - last.http) / dt, smpp: Math.max(0, now.smpp - last.smpp) / dt });
        if (samples.length > POINTS) samples.shift();
      }
    }
    last = now;
    drawKpis();
    drawLinks();
    updateChart();
  }

  async function load(fresh = false) {
    try {
      state = await ctx.state({ fresh });
      $('[data-banner]').innerHTML = '';
      stats = stats || { ...state.stats, smppConnectors: state.smppConnectors, traffic: state.traffic };
      drawKpis();
      drawLinks();
      drawPipeline();
    } catch (err) {
      render($('[data-banner]'), html`<div class="banner err">${icon('alert')}<div><strong>The gateway is not reachable.</strong> ${err.message}</div></div>`);
      drawKpis();
      drawLinks();
    }
    drawRecent();
  }

  $('[data-refresh]').onclick = () => load(true).catch(toastError);
  const offs = [
    on('stats', onStats),
    on('traffic:new', () => drawRecent()),
    on('traffic:update', () => drawRecent()),
    on('theme', () => {
      if (!chart) return;
      chart.data.datasets[0].borderColor = chart.data.datasets[0].backgroundColor = css('--series-1');
      chart.data.datasets[1].borderColor = chart.data.datasets[1].backgroundColor = css('--series-2');
      chart.options.scales.y.grid.color = css('--grid-line');
      chart.update('none');
    })
  ];
  await load();
  initChart().catch(() => {});
  return () => {
    offs.forEach((f) => f());
    chart?.destroy();
  };
}

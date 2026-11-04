import { html, icon, render, toast } from '../lib.js';
import { loadScript, loadStyle } from './shared.js';

const COMMANDS = [
  ['Inspect', [
    ['stats --httpapi', 'HTTP API counters'],
    ['stats --smppsapi', 'SMPP server counters'],
    ['stats --smppcs', 'Per-connector counters'],
    ['stats --users', 'Per-user counters']
  ]],
  ['Users & groups', [
    ['user -l', 'List users'],
    ['user -s ', 'Show one user (add UID)'],
    ['group -l', 'List groups'],
    ['user -a', 'Add a user (interactive)']
  ]],
  ['Connectors', [
    ['smppccm -l', 'List SMPP connectors'],
    ['smppccm -s ', 'Show connector settings (add CID)'],
    ['smppccm -1 ', 'Start connector (add CID)'],
    ['smppccm -0 ', 'Stop connector (add CID)'],
    ['httpccm -l', 'List HTTP connectors']
  ]],
  ['Routing', [
    ['mtrouter -l', 'List MT routes'],
    ['morouter -l', 'List MO routes'],
    ['filter -l', 'List filters'],
    ['mtinterceptor -l', 'List MT interceptors']
  ]],
  ['Session', [
    ['persist', 'Save configuration to disk'],
    ['load', 'Reload configuration from disk'],
    ['ko', 'Abort the current add/update'],
    ['help', 'All commands']
  ]]
];

const THEMES = {
  dark: { background: '#0b0f14', foreground: '#d6dde5', cursor: '#2aa5dd', cursorAccent: '#0b0f14', selectionBackground: 'rgba(42,165,221,.35)',
    black: '#1a2129', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d6dde5',
    brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc' }
};

export default async function terminal(root, ctx) {
  render(
    root,
    html`<div class="term-shell">
      <div class="term-main">
        <div class="term-bar">
          <div class="title"><span class="dot" data-dot></span><span data-title>jCLI</span></div>
          <div style="flex:1"></div>
          <button class="btn" data-act="reconnect" title="Open a new session">${icon('refresh')} Reconnect</button>
          <button class="btn" data-act="clear" title="Clear screen (Ctrl+L)">${icon('x')} Clear</button>
          <button class="btn" data-act="copy" title="Copy selection">${icon('copy')} Copy</button>
          <button class="btn icon-only" data-act="smaller" title="Smaller text" aria-label="Smaller text">${icon('minus')}</button>
          <button class="btn icon-only" data-act="bigger" title="Larger text" aria-label="Larger text">${icon('plus')}</button>
          <button class="btn icon-only" data-act="full" title="Fullscreen" aria-label="Fullscreen">${icon('maximize')}</button>
        </div>
        <div class="term-host" data-host></div>
        <div class="term-status"><span data-state>connecting…</span><span data-session></span><span data-uptime></span><span style="margin-left:auto">↑/↓ history · Tab completes · Ctrl+C cancels</span></div>
      </div>
      <aside class="term-side">
        <div class="search" style="max-width:none;margin-bottom:6px">${icon('search')}<input class="input" data-filter placeholder="Find a command" aria-label="Find a command"></div>
        <p class="muted" style="font-size:12px;margin:6px 2px 4px">Click to type a command, then edit and press Enter.</p>
        <div data-cmds></div>
        <div class="banner warn" style="margin-top:14px;font-size:12px">${icon('alert')}<div>This is a full administrator session on the gateway. Commands are recorded in the audit log; passwords are masked.</div></div>
      </aside>
    </div>`
  );
  const $ = (s) => root.querySelector(s);
  loadStyle('/vendor/xterm.css');
  await Promise.all([loadScript('/vendor/xterm.js'), loadScript('/vendor/addon-fit.js')]);
  await document.fonts.load('13px "JetBrains Mono"').catch(() => {});

  let fontSize = Number(localStorage.getItem('jc-term-font') || 13);
  const term = new window.Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    allowProposedApi: false,
    theme: THEMES.dark
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('[data-host]'));
  const refit = () => {
    try {
      fit.fit();
    } catch {}
  };
  refit();
  const ro = new ResizeObserver(refit);
  ro.observe($('[data-host]'));

  let ws = null;
  let since = null;
  let timer = null;
  const setState = (state, text) => {
    if (!root.isConnected || !$('[data-dot]')) return;
    $('[data-dot]').className = `dot ${state === 'ready' ? 'ok' : state === 'error' || state === 'closed' ? 'err' : 'warn'}`;
    $('[data-state]').textContent = text;
  };

  function connect() {
    ws?.close();
    term.reset();
    setState('connecting', 'connecting…');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'data') term.write(msg.d);
      else if (msg.t === 'status') {
        if (!root.isConnected || !$('[data-title]')) return;
        if (msg.state === 'ready') {
          since = Date.now();
          $('[data-title]').textContent = `jcli@${msg.host}:${msg.port}${msg.version ? ` · Jasmin ${msg.version}` : ''}`;
          $('[data-session]').textContent = msg.session ? `session #${msg.session}` : '';
          setState('ready', 'connected');
          term.focus();
        } else if (msg.state === 'connecting') {
          $('[data-title]').textContent = `jcli@${msg.host}:${msg.port}`;
        } else if (msg.state === 'error') {
          setState('error', 'error');
          term.writeln(`\r\n\x1b[31m✖ ${msg.message}\x1b[0m`);
        } else if (msg.state === 'closed') {
          since = null;
          setState('closed', 'disconnected');
          term.writeln('\r\n\x1b[33m● Session closed. Use Reconnect to open a new one.\x1b[0m');
        }
      }
    };
    ws.onclose = (e) => {
      if (since !== null || e.code !== 1000) {
        since = null;
        setState('closed', 'disconnected');
      }
    };
  }

  term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'input', d })));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'l') {
      term.clear();
      return false;
    }
    return true;
  });
  timer = setInterval(() => {
    if (!since) return ($('[data-uptime]').textContent = '');
    const s = Math.floor((Date.now() - since) / 1000);
    $('[data-uptime]').textContent = `uptime ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }, 1000);

  const drawCmds = () => {
    const q = $('[data-filter]').value.trim().toLowerCase();
    render(
      $('[data-cmds]'),
      COMMANDS.map(([group, list]) => {
        const items = list.filter(([c, d]) => !q || c.includes(q) || d.toLowerCase().includes(q));
        return items.length ? html`<h3>${group}</h3>${items.map(([c, d]) => html`<button class="cmd" data-cmd="${c}"><code>${c}</code><span>${d}</span></button>`)}` : '';
      })
    );
  };
  drawCmds();
  $('[data-filter]').addEventListener('input', drawCmds);
  $('[data-cmds]').onclick = (e) => {
    const c = e.target.closest('[data-cmd]')?.dataset.cmd;
    if (!c || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'input', d: c }));
    term.focus();
  };

  root.querySelector('.term-bar').onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reconnect') connect();
    else if (act === 'clear') term.clear();
    else if (act === 'copy') {
      const sel = term.getSelection();
      if (!sel) return toast('Select text in the terminal first', 'warn');
      await navigator.clipboard.writeText(sel).then(() => toast('Copied', 'ok'), () => toast('Clipboard not available', 'err'));
    } else if (act === 'smaller' || act === 'bigger') {
      fontSize = Math.min(22, Math.max(10, fontSize + (act === 'bigger' ? 1 : -1)));
      term.options.fontSize = fontSize;
      localStorage.setItem('jc-term-font', String(fontSize));
      refit();
    } else if (act === 'full') {
      const el = root.querySelector('.term-main');
      document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();
    }
  };

  connect();
  return () => {
    clearInterval(timer);
    ro.disconnect();
    ws?.close();
    term.dispose();
  };
}

// Interactive shell (`docker exec -it`) with xterm.js, plus a key bar and a
// command line for phones, where typing into a terminal emulator is painful.
import { $, esc, icon, isTouch, loadScript, loadCss, dialog } from './ui.js';

const HIST_KEY = 'taco.shell.history';
const KEYS = [
  ['Ctrl', 'ctrl'],
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['^C', '\x03'],
  ['^D', '\x04'],
  ['^L', '\x0c'],
  ['|', '|'],
  ['/', '/'],
  ['-', '-'],
  ['~', '~'],
  ['$', '$'],
  ['Home', '\x1b[H'],
  ['End', '\x1b[F'],
  ['PgUp', '\x1b[5~'],
  ['PgDn', '\x1b[6~'],
];

export function mount(el, { container }) {
  const name = container.name;
  let cmd = '';
  let user = '';
  el.innerHTML = `
    <div class="pv-tools">
      <span class="dot" data-k="dot"></span><span class="pv-status" data-k="sub">connecting…</span>
      <span class="sp"></span>
      <button class="btn sm ghost" data-k="opts" title="Run another command or as another user">${icon('settings')}<span>Command</span></button>
      <button class="btn sm ghost" data-k="reconnect" title="Reconnect">${icon('refresh')}<span>Reconnect</span></button>
    </div>
    <div class="termwrap"><div class="term-msg">Loading terminal…</div></div>
    <div class="keybar touch-only">${KEYS.map(([l, v]) => `<button class="key" data-key="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    <div class="hist touch-only"></div>
    <form class="cmdline touch-only">
      <input type="text" enterkeyhint="send" placeholder="Type a command…" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
      <button class="btn primary icon" type="submit" aria-label="Send">${icon('play')}</button>
    </form>`;

  const wrap = $('.termwrap', el);
  const input = $('.cmdline input', el);
  const sub = $('[data-k="sub"]', el);
  const dot = $('[data-k="dot"]', el);
  const setDot = (t) => (dot.className = `dot ${t}`);
  let term, fit, ws, ro;
  let ctrlOn = false;
  let destroyed = false;
  let history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');

  const send = (d) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }));
  };
  const setCtrl = (on) => {
    ctrlOn = on;
    $('[data-key="ctrl"]', el)?.classList.toggle('on', on);
  };
  // With sticky Ctrl, turn the next character into its control code.
  const withCtrl = (d) => {
    if (!ctrlOn || d.length !== 1) return d;
    setCtrl(false);
    const c = d.toUpperCase().charCodeAt(0);
    return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : d;
  };

  function renderHist() {
    $('.hist', el).innerHTML = history.slice(0, 12).map((h) => `<button type="button" data-h="${esc(h)}">${esc(h)}</button>`).join('');
  }
  renderHist();

  function connect() {
    ws?.close();
    term.reset();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ cols: term.cols, rows: term.rows });
    if (cmd) q.set('cmd', cmd);
    if (user) q.set('user', user);
    sub.textContent = 'connecting…';
    setDot('warn');
    const sock = (ws = new WebSocket(`${proto}://${location.host}/api/containers/${encodeURIComponent(name)}/shell?${q}`));
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      sub.textContent = `${cmd || 'shell'}${user ? ` as ${user}` : ''} · ${term.cols}×${term.rows}`;
      setDot('ok pulse');
      if (!isTouch) term.focus();
    };
    sock.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.t === 'exit') term.write(`\r\n\x1b[2m[session ended${m.code ? `, exit ${m.code}` : ''} — reconnect to start a new one]\x1b[0m\r\n`);
        if (m.t === 'error') term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
        return;
      }
      term.write(new Uint8Array(e.data));
    };
    sock.onclose = () => {
      if (sock === ws && !destroyed) {
        sub.textContent = 'disconnected';
        setDot('off');
      }
    };
  }

  (async () => {
    loadCss('/vendor/xterm.css');
    await loadScript('/vendor/xterm.js');
    await loadScript('/vendor/addon-fit.js');
    if (destroyed) return;
    wrap.innerHTML = '';
    term = new window.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
      fontSize: isTouch ? 12 : 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: { background: '#141518', foreground: '#e3e4e6', cursor: '#f0a35e', cursorAccent: '#141518', selectionBackground: '#3b82f655' },
      lineHeight: 1.25,
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(wrap);
    fit.fit();
    term.onData((d) => send(withCtrl(d)));
    let rt;
    ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (!term) return;
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
          sub.textContent = sub.textContent.replace(/\d+×\d+$/, `${term.cols}×${term.rows}`);
        }
      }, 80);
    });
    ro.observe(wrap);
    connect();
  })().catch((e) => {
    wrap.innerHTML = `<div class="term-msg">${esc(e.message)}</div>`;
  });

  el.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    const key = e.target.closest('[data-key]')?.dataset.key;
    const h = e.target.closest('[data-h]')?.dataset.h;
    if (k === 'reconnect' && term) connect();
    else if (k === 'opts') {
      const v = await dialog({
        title: 'Shell',
        message: 'Command to run (empty = bash if available, else sh). Optionally as another user, e.g. "root".',
        html: '',
        input: { placeholder: 'e.g. /bin/ash   or   user:root', value: [cmd, user && `user:${user}`].filter(Boolean).join(' ') },
        actions: [{ label: 'Connect', kind: 'primary', value: true }],
      });
      if (v === null) return;
      const um = v.match(/(?:^|\s)user:(\S+)/);
      user = um ? um[1] : '';
      cmd = v.replace(/(?:^|\s)user:\S+/, '').trim();
      if (term) connect();
    } else if (key) {
      e.preventDefault();
      if (key === 'ctrl') setCtrl(!ctrlOn);
      else send(withCtrl(key));
    } else if (h) {
      input.value = h;
      input.focus();
    }
  });
  // Keep the soft keyboard up when tapping key bar buttons.
  $('.keybar', el).addEventListener('pointerdown', (e) => {
    if (e.target.closest('.key') && document.activeElement === input) e.preventDefault();
  });

  $('.cmdline', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    if (ctrlOn && v.length === 1) {
      send(withCtrl(v));
      input.value = '';
      return;
    }
    send(`${v}\r`);
    input.value = '';
    if (v.trim()) {
      history = [v, ...history.filter((x) => x !== v)].slice(0, 30);
      localStorage.setItem(HIST_KEY, JSON.stringify(history));
      renderHist();
    }
  });

  return {
    destroy() {
      destroyed = true;
      ro?.disconnect();
      ws?.close();
      term?.dispose();
      term = null;
    },
  };
}

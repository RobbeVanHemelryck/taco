// Shared UI helpers: DOM, API, icons, toasts, dialogs, ANSI rendering.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- icons (24x24 stroke, lucide-style)
const ICONS = {
  play: '<path d="M6 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L7.5 3.94A1 1 0 0 0 6 4.8z"/>',
  stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>',
  restart: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  logs: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  chevdown: '<path d="m6 9 6 6 6-6"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  pull: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  wrap: '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  minus: '<path d="M5 12h14"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  recreate: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
  key: '<path d="M2.59 17.41A2 2 0 0 0 2 18.83V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.17a2 2 0 0 0 1.42-.59l.81-.81a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>',
  link: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  hammer: '<path d="m15 12-8.37 8.37a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.91-1.91A2 2 0 0 1 19 8.17V7l-2.26-2.26a6 6 0 0 0-4.2-1.76L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.17a2 2 0 0 1 1.42.59L18.5 14.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  disk: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  inspect: '<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M4.27 21.9A2 2 0 0 0 6 22h12a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"/><circle cx="5" cy="14" r="3"/><path d="m9 18-1.5-1.5"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

export const isWide = () => matchMedia('(min-width: 900px)').matches;

// ---------------------------------------------------------------- api
export async function api(url, { method = 'GET', body, signal } = {}) {
  const r = await fetch(url, {
    method,
    signal,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isJson = (r.headers.get('content-type') || '').includes('json');
  const data = isJson ? await r.json() : await r.text();
  if (!r.ok) {
    const e = new Error((isJson ? data.error : data) || r.statusText);
    Object.assign(e, { status: r.status, data });
    throw e;
  }
  return data;
}

// Read a streaming response chunk by chunk.
export async function stream(url, { method = 'GET', body, signal, onChunk }) {
  const r = await fetch(url, {
    method,
    signal,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk(value);
  }
}

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${kind === 'ok' ? icon('check') : kind === 'err' ? icon('alert') : ''}<span>${esc(msg)}</span>`;
  box.append(el);
  setTimeout(() => el.classList.add('out'), kind === 'err' ? 5000 : 2500);
  setTimeout(() => el.remove(), kind === 'err' ? 5400 : 2900);
  el.onclick = () => el.remove();
}

// ---------------------------------------------------------------- modal dialog
// Promise-based dialog. Resolves with the chosen action's value (or null).
export function dialog({ title, message = '', html = '', actions = [{ label: 'OK', value: true, kind: 'primary' }], input }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        ${title ? `<h3>${esc(title)}</h3>` : ''}
        ${message ? `<p>${esc(message)}</p>` : ''}${html}
        ${input ? `<input class="field" type="text" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" autocapitalize="off" autocorrect="off" spellcheck="false">` : ''}
        <div class="modal-actions">
          <button class="btn" data-v="__cancel">Cancel</button>
          ${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>`;
    const field = $('input', wrap);
    const close = (v) => {
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 120);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const pick = (i) => close(input ? (actions[i].value === false ? null : field.value.trim()) : actions[i].value);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
      if (e.key === 'Enter' && input) pick(actions.length - 1);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) return close(null);
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.v === '__cancel') close(null);
      else pick(+b.dataset.i);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    if (field) field.focus();
    else $('.modal-actions .btn:last-child', wrap).focus();
  });
}

export const confirmAction = (title, message, label = 'Confirm', kind = 'danger') =>
  dialog({ title, message, actions: [{ label, value: true, kind }] }).then(Boolean);

// ---------------------------------------------------------------- menus
// A dropdown anchored to a button on wide screens, a bottom sheet on phones.
// items: { label, icon, value, hint, danger, disabled } | 'sep' | { heading }
// Resolves with the picked item's value, or null.
let closeOpenMenu = null;
export function menu(anchor, { title = '', subtitle = '', items }) {
  closeOpenMenu?.(null);
  return new Promise((resolve) => {
    const sheet = !isWide();
    const layer = document.createElement('div');
    layer.className = `menu-layer ${sheet ? 'sheet' : ''}`;
    const body = items
      .filter(Boolean)
      .map((it, i) => {
        if (it === 'sep') return '<div class="menu-sep"></div>';
        if (it.heading) return `<div class="menu-heading">${esc(it.heading)}</div>`;
        return `<button class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}" role="menuitem" ${it.disabled ? 'disabled' : ''}>${icon(it.icon || '')}<span class="ml">${esc(it.label)}</span>${it.hint ? `<span class="mh">${esc(it.hint)}</span>` : ''}</button>`;
      })
      .join('');
    layer.innerHTML = `<div class="menu" role="menu">${sheet ? '<div class="grab"></div>' : ''}${title ? `<div class="menu-title"><div class="t">${esc(title)}</div>${subtitle ? `<div class="s">${esc(subtitle)}</div>` : ''}</div>` : ''}${body}</div>`;
    const box = $('.menu', layer);
    const list = items.filter(Boolean);
    anchor?.classList.add('open');

    // On phones the sheet gets a history entry, so the back gesture closes it.
    let pushed = false;
    const onPop = () => {
      pushed = false;
      finish(null);
    };
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeOpenMenu = null;
      anchor?.classList.remove('open');
      document.removeEventListener('keydown', onKey, true);
      removeEventListener('popstate', onPop);
      removeEventListener('resize', onResize);
      layer.classList.add('out');
      setTimeout(() => layer.remove(), sheet ? 180 : 90);
      if (pushed) {
        // Wait for the sheet's history entry to be popped before acting on the pick.
        addEventListener('popstate', () => resolve(v), { once: true });
        history.back();
      } else resolve(v);
    };
    closeOpenMenu = finish;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        finish(null);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const bs = $$('.menu-item:not(:disabled)', box);
        const i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
      }
    };
    const onResize = () => finish(null);
    layer.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.menu')) finish(null);
    });
    layer.addEventListener('click', (e) => {
      const b = e.target.closest('.menu-item');
      if (b && !b.disabled) finish(list[+b.dataset.i].value);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(layer);

    if (sheet) {
      history.pushState({ ...(history.state || {}), menu: 1 }, '', location.hash);
      pushed = true;
      addEventListener('popstate', onPop, { once: true });
    } else {
      const r = anchor.getBoundingClientRect();
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      let left = r.right - w;
      if (left < 8) left = Math.min(r.left, innerWidth - w - 8);
      let top = r.bottom + 6;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
      box.style.left = `${Math.max(8, left)}px`;
      box.style.top = `${top}px`;
      addEventListener('resize', onResize);
      $('.menu-item:not(:disabled)', box)?.focus({ preventScroll: true });
    }
  });
}
export const menuOpen = () => !!closeOpenMenu;

// ---------------------------------------------------------------- formatting
const UNITS = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' };
export const shortDur = (s) =>
  s
    .replace(/Less than a second/i, '<1s')
    .replace(/About an? /i, '1 ')
    .replace(/(\d+) (second|minute|hour|day|week|month|year)s?/gi, (_, n, u) => n + UNITS[u.toLowerCase()]);

// "Up 3 hours (healthy)" -> { text: "3h", health: "healthy" }
export function shortStatus(c) {
  const s = c.status || '';
  let m;
  if ((m = s.match(/^Up (.+?)(?: \((.+)\))?$/))) {
    const flag = m[2] || '';
    return { text: shortDur(m[1]), health: /paused/i.test(flag) ? '' : flag.replace(/^health: /, '') };
  }
  if ((m = s.match(/^Exited \((-?\d+)\) (.+) ago$/))) return { text: `exit ${m[1]} · ${shortDur(m[2])}`, code: +m[1] };
  if ((m = s.match(/^Restarting \((-?\d+)\) (.+) ago$/))) return { text: `restarting · ${shortDur(m[2])}` };
  return { text: s.toLowerCase() };
}

// Status colour for a container: ok | warn | err | off | paused
export function tone(c) {
  const st = shortStatus(c);
  if (c.state === 'running') return st.health === 'unhealthy' ? 'err' : st.health === 'starting' ? 'warn' : 'ok';
  if (c.state === 'paused') return 'paused';
  if (c.state === 'restarting') return 'warn';
  if (c.state === 'exited' && st.code) return 'err';
  if (c.state === 'dead') return 'err';
  return 'off';
}

export const shortImage = (img) => img.replace(/^(docker\.io\/)?(library\/)?/, '').replace(/@sha256:.*/, '');

export function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)}${u[i]}`;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d) || d.getFullYear() < 1971) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const hueOf = (s) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
};

// ---------------------------------------------------------------- ANSI -> HTML
const BASIC = ['#555', '#e5534b', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#ccc'];
const BRIGHT = ['#888', '#ff7b72', '#7ee787', '#f2cc60', '#79c0ff', '#d2a8ff', '#76e3ea', '#fff'];
function color256(n) {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    n -= 16;
    const v = (x) => (x ? x * 40 + 55 : 0);
    return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`;
  }
  const g = (n - 232) * 10 + 8;
  return `rgb(${g},${g},${g})`;
}

const ANSI_RE = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;
export function ansiToHtml(text) {
  if (!text.includes('\x1b')) return esc(text.replace(/\r/g, ''));
  let out = '';
  let last = 0;
  let st = {};
  let open = false;
  const flush = (s) => {
    if (!s) return;
    const style = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg}`, st.b && 'font-weight:600', st.d && 'opacity:.7', st.i && 'font-style:italic', st.u && 'text-decoration:underline']
      .filter(Boolean)
      .join(';');
    out += style ? `<span style="${style}">${esc(s)}</span>` : esc(s);
  };
  let m;
  ANSI_RE.lastIndex = 0;
  while ((m = ANSI_RE.exec(text))) {
    flush(text.slice(last, m.index));
    last = ANSI_RE.lastIndex;
    if (m[1] === undefined) continue;
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {};
      else if (c === 1) st.b = 1;
      else if (c === 2) st.d = 1;
      else if (c === 3) st.i = 1;
      else if (c === 4) st.u = 1;
      else if (c === 22) st.b = st.d = 0;
      else if (c === 23) st.i = 0;
      else if (c === 24) st.u = 0;
      else if (c >= 30 && c <= 37) st.fg = BASIC[c - 30];
      else if (c >= 90 && c <= 97) st.fg = BRIGHT[c - 90];
      else if (c === 39) st.fg = '';
      else if (c >= 40 && c <= 47) st.bg = BASIC[c - 40];
      else if (c === 49) st.bg = '';
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        st[c === 38 ? 'fg' : 'bg'] = color256(codes[i + 2]);
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        st[c === 38 ? 'fg' : 'bg'] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
    open = true;
  }
  flush(text.slice(last));
  return open ? out : out;
}

export const stripAnsi = (s) => s.replace(ANSI_RE, '');

// Lazy-load a classic script once.
const loaded = {};
export function loadScript(src) {
  return (loaded[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(s);
  }));
}
export function loadCss(href) {
  if (loaded[href]) return;
  loaded[href] = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.append(l);
}

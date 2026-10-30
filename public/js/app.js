import { $, $$, esc, icon, api, stream, toast, dialog, confirmAction, menu, menuOpen, shortStatus, tone, shortImage, isTouch, isWide } from './ui.js';

const S = {
  info: null,
  projects: [],
  containers: [],
  stats: {},
  services: {}, // project -> { at, services, error }
  filter: '',
  error: '',
  tab: '_home',
  view: null, // side panel: { key, hash, destroy }
  files: null, // the stack page's file editors: { name, canLeave, destroy, ... }
  sel: new Set(), // selected rows on the current page: c:<container> | s:<service> | i:<image id>
  images: null, // { at, list, error, loading }
  imgFilter: 'all', // all | used | unused
  lastSel: null,
};

// ================================================================ data

async function refresh() {
  try {
    const d = await api('/api/overview');
    S.projects = d.projects;
    S.containers = d.containers;
    S.error = '';
    S.loaded = true;
  } catch (e) {
    S.error = e.message || 'cannot reach taco';
  }
  renderBanner();
  renderSidebar();
  renderTabbar();
  renderMain();
  renderPanelHead();
}

async function refreshStats() {
  if (!S.containers.some((c) => c.state === 'running')) return;
  try {
    S.stats = await api('/api/stats');
    renderMain();
  } catch {}
}

async function loadServices(name, force) {
  const cur = S.services[name];
  if (!force && cur && (cur.loading || Date.now() - cur.at < 30_000)) return;
  S.services[name] = { ...(cur || { services: [] }), loading: true, at: Date.now() };
  try {
    const r = await api(`/api/projects/${encodeURIComponent(name)}/services`);
    S.services[name] = { at: Date.now(), ...r };
  } catch (e) {
    S.services[name] = { at: Date.now(), services: [], error: e.message };
  }
  renderMain();
}

const projectByName = (n) => S.projects.find((p) => p.name === n);
const containerByName = (n) => S.containers.find((c) => c.name === n || c.id === n);
const standalone = () => S.containers.filter((c) => !c.project).sort((a, b) => a.name.localeCompare(b.name));
const projectContainers = (n) =>
  S.containers
    .filter((c) => c.project === n)
    .sort((a, b) => a.oneoff - b.oneoff || a.service.localeCompare(b.service) || a.number - b.number);

// Containers plus services from the compose file that have no container yet.
function projectRows(name) {
  const cs = projectContainers(name);
  const have = new Set(cs.map((c) => c.service));
  const ghosts = (S.services[name]?.services || []).filter((s) => !have.has(s.name));
  return { cs, ghosts };
}

function projectTone(name) {
  const { cs, ghosts } = projectRows(name);
  const running = cs.filter((c) => c.state === 'running').length;
  const tones = cs.map(tone);
  const total = cs.filter((c) => !c.oneoff).length + ghosts.length;
  let t = 'ok';
  if (!running) t = 'off';
  else if (tones.includes('err')) t = 'err';
  else if (running < total || tones.includes('warn')) t = 'warn';
  return { tone: t, running, total };
}

// Paths are ellipsized at the start (direction: rtl); marks keep their slashes in place.
const ltr = (s) => `\u200e${esc(s)}\u200e`;

const countLabel = (pt) => (pt.total ? `${pt.running}/${pt.total}` : 'down');

// ================================================================ routing
//   #/<tab>[/<view>]
//   tab:  (empty) = overview   standalone   p/<name>
//   view: c/<container>/logs|shell|info   p/<name>/logs
// The view is a side panel on wide screens (it stays open while you browse
// other stacks) and a full-screen page on phones.

const C_MODES = ['logs', 'shell', 'info'];
const P_MODES = ['logs'];

function tabs() {
  const t = [{ id: '_home', label: 'Overview' }];
  for (const p of S.projects) t.push({ id: `p:${p.name}`, label: p.name, project: p.name });
  if (standalone().length) t.push({ id: '_standalone', label: 'Standalone' });
  t.push({ id: '_images', label: 'Images' });
  return t;
}
const tabIndex = (id) => tabs().findIndex((t) => t.id === id);

const TAB_PATHS = { _home: '', _standalone: 'standalone', _images: 'images' };
const tabPath = (id) => TAB_PATHS[id] ?? `p/${encodeURIComponent(id.slice(2))}`;
const viewPath = (v) => (v ? `${v.kind}/${encodeURIComponent(v.name)}/${v.mode}` : '');
const hashFor = (tab, view) => `#/${[tabPath(tab), view || ''].filter(Boolean).join('/')}`;
const viewKey = (v) => (v ? `${v.kind}:${v.name}:${v.mode}` : null);
const openKey = () => S.view?.key || '';

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  let tab = '_home';
  let rest = parts;
  if (parts[0] === 'standalone' || parts[0] === 'images') {
    tab = `_${parts[0]}`;
    rest = parts.slice(1);
  } else if (parts[0] === 'p' && parts[1]) {
    tab = `p:${parts[1]}`;
    rest = parts.slice(2);
    if (rest.length === 1 && P_MODES.includes(rest[0])) rest = ['p', parts[1], rest[0]];
  }
  const [kind, name, mode] = rest;
  if (name && ((kind === 'c' && C_MODES.includes(mode)) || (kind === 'p' && P_MODES.includes(mode)))) {
    return { tab, view: { kind, name, mode } };
  }
  return { tab };
}

async function goTab(id) {
  if (id === S.tab) return;
  if (S.files && !S.files.canLeave()) {
    const ok = await confirmAction('Discard changes?', `Unsaved edits in ${S.files.dirtyNames().join(', ')} will be lost.`, 'Discard');
    if (!ok) return;
  }
  history.replaceState(history.state, '', hashFor(id, viewPath(parseRoute().view)));
  render();
}

function openView(path) {
  const hash = hashFor(parseRoute().tab, path);
  if (hash === location.hash) return;
  // With a panel already open, swap it in place instead of stacking history entries.
  if (S.view) history.replaceState(history.state, '', hash);
  else history.pushState({ ov: 1 }, '', hash);
  render();
}

function closeView() {
  if (history.state?.ov) {
    // The entry underneath may still point at the tab the view was opened from.
    S.returnTab = S.tab;
    history.back();
  } else {
    history.replaceState(null, '', hashFor(S.tab));
    render();
  }
}

function toggleView(path) {
  const r = parseRoute();
  if (r.view && viewPath(r.view) === path) closeView();
  else openView(path);
}

function render() {
  const route = parseRoute();
  const key = viewKey(route.view);
  if (S.view && S.view.key !== key) {
    S.view.destroy?.();
    S.view = null;
    $('#panel').hidden = true;
    $('#resizer').hidden = true;
    $('#panel').innerHTML = '';
    document.body.classList.remove('panel-open');
  } else if (S.view) S.view.hash = location.hash;

  const prevTab = S.tab;
  S.tab = route.tab;
  if (prevTab !== S.tab) {
    S.sel.clear();
    S.lastSel = null;
  }
  if (!S.view && route.view) mountView(route.view, key);
  renderSidebar();
  renderTabbar(prevTab !== S.tab);
  renderMain(prevTab === S.tab ? '' : tabIndex(S.tab) >= tabIndex(prevTab) ? 'slide-l' : 'slide-r');
  renderPanelHead();
}

// ================================================================ side panel (logs / shell / inspect)

async function mountView(v, key) {
  const box = $('#panel');
  box.hidden = false;
  $('#resizer').hidden = false;
  document.body.classList.add('panel-open');
  box.innerHTML = `<div class="pv"><header class="pv-head" data-r="phead"></header><div class="pv-body"></div></div>`;
  const el = $('.pv-body', box);
  const ctx = { back: closeView, runJob, refresh };
  if (v.kind === 'c') ctx.container = containerByName(v.name) || { name: v.name, id: v.name, state: 'unknown', image: '' };
  else ctx.project = projectByName(v.name) || { name: v.name, configFiles: [] };
  S.view = { key, hash: location.hash, v, lastHead: '' };
  renderPanelHead();
  const mod = await import(`./${v.mode}.js`);
  if (S.view?.key !== key) return;
  Object.assign(S.view, mod.mount(el, ctx) || {});
}

function renderPanelHead() {
  if (!S.view) return;
  const head = $('#panel [data-r="phead"]');
  if (!head) return;
  const { v } = S.view;
  let title;
  let sub;
  let dot;
  let seg = '';
  if (v.kind === 'c') {
    const c = containerByName(v.name);
    const st = c ? shortStatus(c) : { text: 'not found' };
    dot = c ? tone(c) : 'off';
    title = c?.service && c.project ? c.service : v.name;
    sub = [c?.project, c ? shortImage(c.image) : '', st.text].filter(Boolean).join(' · ');
    const running = c?.state === 'running';
    const sbtn = (mode, ic, label, dis = false) =>
      `<button class="seg-b ${v.mode === mode ? 'on' : ''}" data-act="view" data-v="${esc(viewPath({ kind: 'c', name: v.name, mode }))}" ${dis ? 'disabled' : ''}>${icon(ic)}<span>${label}</span></button>`;
    seg = `<div class="seg">${sbtn('logs', 'logs', 'Logs')}${sbtn('shell', 'terminal', 'Shell', !running && v.mode !== 'shell')}${sbtn('info', 'inspect', 'Inspect')}</div>`;
  } else {
    const pt = projectTone(v.name);
    dot = pt.tone;
    title = v.name;
    sub = `Stack logs · ${countLabel(pt)} running`;
  }
  const html = `
    <button class="iconbtn pv-back narrow-only" data-act="closeview" aria-label="Back">${icon('back')}</button>
    <div class="pv-title"><div class="t"><span class="dot ${dot}"></span><span>${esc(title)}</span></div><div class="s">${esc(sub)}</div></div>
    ${seg}
    <button class="iconbtn wide-only" data-act="closeview" aria-label="Close panel" title="Close (Esc)">${icon('x')}</button>`;
  if (html !== S.view.lastHead) head.innerHTML = S.view.lastHead = html;
}

// ================================================================ chrome: banner, sidebar, tab bar

function renderBanner() {
  const b = $('#banner');
  b.hidden = !S.error;
  b.innerHTML = S.error ? `${icon('alert')}<span>${esc(S.error)}</span>` : '';
}

const hostLine = (i) => (i ? `Docker ${esc(i.serverVersion)} · Compose ${esc(i.composeVersion)}` : '&nbsp;');

let lastSide = { head: '', list: '' };
function renderSidebar() {
  const sb = $('#sidebar');
  if (!sb.firstChild) {
    sb.innerHTML = `<div data-n="head"></div>
      <label class="sb-search">${icon('search')}<input class="filter" type="search" placeholder="Search" value="${esc(S.filter)}" autocapitalize="off" autocorrect="off" spellcheck="false"><kbd>/</kbd></label>
      <nav class="sb-list" data-n="list"></nav>
      <div class="sb-foot"><button class="sb-theme" data-act="theme" title="Toggle light/dark mode" aria-label="Toggle light/dark mode">${icon('sun', 'sun')}${icon('moon', 'moon')}</button></div>`;
  }
  const i = S.info;
  const head = `<div class="sb-head">
      <img src="/icon.svg" alt="">
      <div class="b"><div class="h">${esc(i?.host || 'taco')}</div><div class="s">${hostLine(i)}</div></div>
    </div>`;
  const f = S.filter.trim().toLowerCase();
  const item = (id, lead, label, count, cls = '') =>
    `<button class="sb-item ${id === S.tab ? 'active' : ''} ${cls}" data-tab="${esc(id)}" title="${esc(label)}">${lead}<span class="n">${esc(label)}</span><span class="c">${count}</span></button>`;
  const running = S.containers.filter((c) => c.state === 'running').length;
  const ps = S.projects.filter((p) => !f || p.name.toLowerCase().includes(f) || projectContainers(p.name).some((c) => c.name.includes(f)));
  const sa = standalone();
  let list = item('_home', icon('home'), 'Overview', `${running}/${S.containers.length}`);
  list += `<div class="sb-section"><span>Stacks</span><span class="sp"></span>${i?.stacksDir ? `<button class="sb-add" data-act="newstack" title="New stack" aria-label="New stack">${icon('plus')}</button>` : ''}</div>`;
  list += ps
    .map((p) => {
      const pt = projectTone(p.name);
      return item(`p:${p.name}`, `<span class="dot ${pt.tone}"></span>`, p.name, countLabel(pt));
    })
    .join('');
  if (!ps.length && S.loaded) list += `<div class="sb-empty">${S.projects.length ? 'No match' : 'No stacks found'}</div>`;
  list += `<div class="sb-section"><span>Other</span></div>`;
  if (sa.length) list += item('_standalone', icon('box'), 'Standalone', `${sa.filter((c) => c.state === 'running').length}/${sa.length}`);
  const imgs = S.images?.list;
  list += item('_images', icon('disk'), 'Images', imgs ? (imgs.some((x) => !x.containers.length) ? `${imgs.filter((x) => !x.containers.length).length} unused` : imgs.length) : '');
  if (head !== lastSide.head) $('[data-n="head"]', sb).innerHTML = lastSide.head = head;
  if (list !== lastSide.list) $('[data-n="list"]', sb).innerHTML = lastSide.list = list;
}

let lastTabs = '';
function renderTabbar(scroll) {
  const bar = $('#tabbar');
  if (!bar.firstChild) {
    bar.innerHTML = `<button class="tb-jump" data-act="jump" aria-label="Jump to stack">${icon('grid')}</button><div class="tb-tabs" role="tablist"></div>`;
  }
  const html = tabs()
    .map((t) => {
      const lead = t.project ? `<span class="dot ${projectTone(t.project).tone}"></span>` : icon({ _home: 'home', _images: 'disk' }[t.id] || 'box');
      return `<button class="tb-tab ${t.id === S.tab ? 'active' : ''}" role="tab" data-tab="${esc(t.id)}">${lead}<span>${esc(t.label)}</span></button>`;
    })
    .join('');
  const box = $('.tb-tabs', bar);
  if (html !== lastTabs) {
    box.innerHTML = lastTabs = html;
    scroll = true;
  }
  if (scroll) $('.tb-tab.active', box)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

// ================================================================ theme

const root = document.documentElement;
const syncThemeColor = () => $('meta[name="theme-color"]').setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
function toggleTheme() {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('taco.theme', next);
  syncThemeColor();
}
// Until the toggle is used, follow the OS setting.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (localStorage.getItem('taco.theme')) return;
  root.dataset.theme = e.matches ? 'dark' : 'light';
  syncThemeColor();
});
syncThemeColor();

// ================================================================ main page

// Polling re-renders the page; don't swap DOM out from under a finger mid-tap.
let pointerDown = false;
let deferred = false;
addEventListener('pointerdown', () => (pointerDown = true), true);
const release = () => {
  pointerDown = false;
  if (deferred) {
    setTimeout(() => {
      deferred = false;
      renderMain();
    }, 50);
  }
};
addEventListener('pointerup', release, true);
addEventListener('pointercancel', release, true);

let page = { tab: null, slots: {} };
function renderMain(anim = '') {
  const main = $('#main');
  if (!anim && page.tab === S.tab && (pointerDown || menuOpen())) {
    deferred = true;
    return;
  }
  const r = renderers();
  if (page.tab !== S.tab || anim || page.kind !== r.kind) {
    S.files?.destroy();
    S.files = null;
    main.innerHTML = `<div class="page ${r.kind} ${anim}">${r.slots.map((s) => `<div data-r="${s}"></div>`).join('')}<div class="savebar" data-r="savebar" hidden></div></div>`;
    main.scrollTop = 0;
    page = { tab: S.tab, kind: r.kind, slots: {} };
  }
  for (const [k, html] of Object.entries(r.html)) {
    if (page.slots[k] === html) continue;
    page.slots[k] = html;
    $(`[data-r="${k}"]`, main).innerHTML = html;
  }
  r.after?.(main);
  updateStuck();
}

function renderers() {
  if (S.tab === '_home') return renderHome();
  if (S.tab === '_standalone') return renderStandalone();
  if (S.tab === '_images') return renderImages();
  const name = S.tab.slice(2);
  const p = projectByName(name);
  if (!p) {
    return {
      kind: 'missing',
      slots: ['body'],
      html: { body: S.projects.length || S.error ? `<div class="empty">${icon('layers')}<div class="et">No stack named “${esc(name)}”</div><button class="btn" data-tab="_home">Back to overview</button></div>` : '' },
    };
  }
  loadServices(name);
  return renderProject(p);
}

// ---------------------------------------------------------------- status & rows

function statusPill(c) {
  const st = shortStatus(c);
  const t = tone(c);
  let label;
  let detail = '';
  if (c.state === 'running') {
    label = st.health === 'unhealthy' ? 'Unhealthy' : st.health === 'starting' ? 'Starting' : st.health === 'healthy' ? 'Healthy' : 'Running';
    detail = st.text;
  } else if (c.state === 'paused') label = 'Paused';
  else if (c.state === 'restarting') {
    label = 'Restarting';
  } else if (c.state === 'exited') {
    label = st.code ? `Exited (${st.code})` : 'Exited';
    detail = st.text.split(' · ')[1] || '';
  } else label = c.state ? c.state[0].toUpperCase() + c.state.slice(1) : 'Unknown';
  return `<span class="pill ${t}"><span class="dot"></span>${esc(label)}</span>${detail ? `<span class="since">${esc(detail)}</span>` : ''}`;
}

function portsHtml(c, max = 3) {
  if (c.state !== 'running' || !c.ports.length) return '';
  const ps = c.ports.filter((p, i, a) => a.findIndex((q) => q.host === p.host) === i);
  const chips = ps.slice(0, max).map((p) => {
    const label = p.host === p.container ? p.host : `${p.host}:${p.container}`;
    if (p.proto !== 'tcp' || (p.ip && p.ip !== location.hostname)) return `<span class="port">${esc(label)}</span>`;
    return `<a class="port" href="http://${esc(location.hostname)}:${esc(p.host.split('-')[0])}" target="_blank" rel="noopener" title="Open :${esc(p.host)}">${esc(label)}${icon('link')}</a>`;
  });
  if (ps.length > max) chips.push(`<span class="port more">+${ps.length - max}</span>`);
  return chips.join('');
}

function usageHtml(c) {
  const s = S.stats[c.id.slice(0, 12)];
  if (!s || c.state !== 'running') return '';
  const cpu = parseFloat(s.cpu) || 0;
  return `<span class="usage" title="CPU ${esc(s.cpu)} · memory ${esc(s.mem)} (${esc(s.memPerc)}) · net ${esc(s.net)}"><span class="u-cpu">${cpu.toFixed(1)}%</span><span class="u-mem">${esc(s.mem.replace(/iB$/, 'B'))}</span></span>`;
}

const rowBtn = (act, ic, label, attrs, { on = false, disabled = false } = {}) =>
  `<button class="rb ${on ? 'on' : ''}" data-act="${act}" ${attrs} title="${esc(label)}" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}>${icon(ic)}<span>${esc(label)}</span></button>`;

const checkbox = (state, attrs, label) =>
  `<button class="cb ${state}" role="checkbox" aria-checked="${state === 'on' ? 'true' : state === 'mixed' ? 'mixed' : 'false'}" aria-label="${esc(label)}" ${attrs}>${icon(state === 'mixed' ? 'minus' : 'check')}</button>`;

function containerRow(c, { selectable = true, withProject = false } = {}) {
  const key = `c:${c.name}`;
  const sel = S.sel.has(key);
  const label = c.service && !c.oneoff ? (c.number > 1 ? `${c.service} #${c.number}` : c.service) : c.name;
  const open = openKey().startsWith(`c:${c.name}:`) ? openKey().split(':').pop() : '';
  const v = (mode) => `data-v="${esc(viewPath({ kind: 'c', name: c.name, mode }))}"`;
  const run = c.state === 'running';
  const proj = withProject && c.project ? `<span class="tag">${esc(c.project)}</span>` : '';
  return `<div class="crow ${sel ? 'selected' : ''} ${open ? 'active' : ''}" data-key="${esc(key)}" ${selectable ? 'data-act="rowsel"' : ''}>
    ${selectable ? checkbox(sel ? 'on' : '', `data-act="sel" data-key="${esc(key)}"`, `Select ${label}`) : ''}
    <div class="c-name"><span class="dot ${tone(c)}"></span><div class="c-txt"><div class="n" title="${esc(c.name)}">${esc(label)}${proj}</div><div class="img" title="${esc(c.image)}">${esc(shortImage(c.image))}</div></div></div>
    <div class="c-meta">
      <div class="c-status">${statusPill(c)}</div>
      <div class="c-ports">${portsHtml(c)}</div>
      <div class="c-usage">${usageHtml(c)}</div>
    </div>
    <div class="c-acts">
      ${rowBtn('view', 'logs', 'Logs', v('logs'), { on: open === 'logs' })}
      ${rowBtn('view', 'terminal', 'Shell', v('shell'), { on: open === 'shell', disabled: !run })}
      <button class="rb icon" data-act="cmenu" data-id="${esc(c.name)}" aria-label="More actions for ${esc(label)}" title="More">${icon('more')}</button>
    </div>
  </div>`;
}

function ghostRow(project, s) {
  const key = `s:${s.name}`;
  const sel = S.sel.has(key);
  return `<div class="crow ghost ${sel ? 'selected' : ''}" data-key="${esc(key)}" data-act="rowsel">
    ${checkbox(sel ? 'on' : '', `data-act="sel" data-key="${esc(key)}"`, `Select ${s.name}`)}
    <div class="c-name"><span class="dot ghost"></span><div class="c-txt"><div class="n">${esc(s.name)}</div><div class="img">${esc(s.image ? shortImage(s.image) : s.build ? 'built from Dockerfile' : '')}</div></div></div>
    <div class="c-meta"><div class="c-status"><span class="pill off ghost"><span class="dot"></span>Not created</span></div><div class="c-ports"></div><div class="c-usage"></div></div>
    <div class="c-acts">
      ${rowBtn('view', 'logs', 'Logs', '', { disabled: true })}
      ${rowBtn('view', 'terminal', 'Shell', '', { disabled: true })}
      <button class="rb icon" data-act="gmenu" data-p="${esc(project)}" data-svc="${esc(s.name)}" data-build="${s.build ? 1 : ''}" aria-label="More actions for ${esc(s.name)}" title="More">${icon('more')}</button>
    </div>
  </div>`;
}

function listHtml(rowsHtml, keys, { title = 'Containers', selectable = true, cols = ['Status', 'Ports', 'CPU · Mem'] } = {}) {
  const n = keys.length;
  const selN = keys.filter((k) => S.sel.has(k)).length;
  const all = selN && selN === n ? 'on' : selN ? 'mixed' : '';
  return `<div class="clist ${selectable ? '' : 'nosel'}">
    <div class="chead">
      ${selectable ? checkbox(all, 'data-act="selall"', 'Select all') : ''}
      <div class="ch-name">${esc(title)} <span class="ch-count">${n}</span></div>
      <div class="ch-col c-status">${esc(cols[0])}</div>
      <div class="ch-col c-ports">${esc(cols[1])}</div>
      <div class="ch-col c-usage">${esc(cols[2])}</div>
      <div class="ch-col c-acts"></div>
    </div>
    ${rowsHtml}
  </div>`;
}

// ---------------------------------------------------------------- toolbar

const tbtn = (act, ic, label, attrs = '', cls = '') => `<button class="btn ${cls}" data-act="${act}" ${attrs} title="${esc(label)}">${icon(ic)}<span>${esc(label)}</span></button>`;

function selectionBar(kind) {
  const n = S.sel.size;
  const a = (action, ic, label, cls = '') => tbtn('selact', ic, label, `data-a="${action}"`, cls);
  return `<div class="toolbar selmode">
    <div class="selchip"><span class="selnum">${n}</span><span>selected</span><button class="selx" data-act="selclear" aria-label="Clear selection" title="Clear selection (Esc)">${icon('x')}</button></div>
    <div class="tb-scroll">
      ${a('start', 'play', 'Start')}
      ${a('restart', 'restart', 'Restart')}
      ${a('stop', 'stop', 'Stop')}
      ${kind === 'project' ? a('recreate', 'recreate', 'Recreate') + a('pull-up', 'pull', 'Pull & up') : ''}
      <span class="tb-sep"></span>
      ${a('kill', 'zap', 'Kill', 'danger-text')}
      ${a('rm', 'trash', 'Remove', 'danger-text')}
    </div>
  </div>`;
}

function projectToolbar(p, pt) {
  if (S.sel.size) return selectionBar('project');
  const enc = esc(p.name);
  const any = pt.running > 0;
  const a = (action, ic, label, cls = '') => tbtn('pact', ic, label, `data-p="${enc}" data-a="${action}"`, cls);
  const logsOn = openKey() === `p:${p.name}:logs`;
  return `<div class="toolbar">
    <div class="tb-scroll">
      ${a('up', 'play', 'Up', any ? '' : 'primary')}
      ${a('restart', 'restart', 'Restart')}
      ${a('stop', 'stop', 'Stop')}
      ${a('pull-up', 'pull', 'Pull & up')}
      ${a('recreate', 'recreate', 'Recreate')}
      <span class="tb-sep"></span>
      ${tbtn('view', 'logs', 'Logs', `data-v="${esc(viewPath({ kind: 'p', name: p.name, mode: 'logs' }))}"`, logsOn ? 'on' : '')}
      <span class="tb-sep"></span>
      ${a('down', 'power', 'Down', 'danger-text')}
    </div>
    <button class="btn icon" data-act="pmenu" data-p="${enc}" aria-label="More stack actions" title="More">${icon('more')}</button>
  </div>`;
}

// ---------------------------------------------------------------- pages

function renderProject(p) {
  const name = p.name;
  const pt = projectTone(name);
  const { cs, ghosts } = projectRows(name);
  const svc = S.services[name];
  pruneSelection([...cs.map((c) => `c:${c.name}`), ...ghosts.map((g) => `s:${g.name}`)]);
  const dir = p.workingDir || p.configFiles[0]?.replace(/\/[^/]+$/, '') || '';
  const head = `<header class="phead">
    <div class="crumbs wide-only"><button data-tab="_home">${esc(S.info?.host || 'Overview')}</button>${icon('chevron')}<span>Stacks</span>${icon('chevron')}<span class="cur">${esc(name)}</span></div>
    <div class="ptitle">
      <span class="picon">${icon('layers')}</span>
      <h1>${esc(name)}</h1>
      <span class="pill ${pt.tone} lg"><span class="dot"></span>${pt.total ? `${pt.running} of ${pt.total} running` : 'Down'}</span>
    </div>
    <div class="ppath" title="${esc(p.configFiles.join('\n'))}">${ltr(dir || 'compose file unknown')}</div>
  </header>`;

  let notice = '';
  if (!p.filesAccessible) {
    notice = `<div class="notice warn">${icon('alert')}<div>The compose file isn't readable by taco${p.configFiles[0] ? ` (<code>${esc(p.configFiles[0])}</code>)` : ''}. If taco runs in a container, mount the stack directory at the same path. Start, stop, restart and down still work.</div></div>`;
  } else if (svc?.error) notice = `<div class="notice">${icon('alert')}<div>${esc(svc.error)}</div></div>`;

  const keys = [...cs.map((c) => `c:${c.name}`), ...ghosts.map((g) => `s:${g.name}`)];
  const rows = cs.map((c) => containerRow(c)).join('') + ghosts.map((s) => ghostRow(name, s)).join('');
  const list = rows
    ? listHtml(rows, keys)
    : `<div class="empty card">${icon('layers')}<div class="et">This stack is down</div><div class="es">No containers exist for it right now.</div><button class="btn primary" data-act="pact" data-p="${esc(name)}" data-a="up">${icon('play')}Bring it up</button></div>`;

  return {
    kind: 'stack',
    slots: ['head', 'toolbar', 'notice', 'list', 'files'],
    html: { head, toolbar: projectToolbar(p, pt), notice, list },
    after(main) {
      if (S.files || !p.filesAccessible) return;
      const el = $('[data-r="files"]', main);
      const bar = $('[data-r="savebar"]', main);
      S.files = { name, canLeave: () => true, destroy() {}, dirtyNames: () => [] };
      const holder = S.files;
      import('./editor.js')
        .then((m) => {
          if (S.files !== holder) return;
          S.files = m.mountFiles(el, bar, {
            project: p,
            runJob,
            onSaved: () => {
              for (const k of Object.keys(S.services)) S.services[k].at = 0;
              refresh();
            },
          });
          if (S.focusEditor) {
            S.focusEditor = false;
            setTimeout(() => S.files?.focus?.(), 400);
          }
        })
        .catch((e) => (el.innerHTML = `<div class="notice">${icon('alert')}<div>Editor failed to load: ${esc(e.message)}</div></div>`));
    },
  };
}

function renderStandalone() {
  const sa = standalone();
  pruneSelection(sa.map((c) => `c:${c.name}`));
  const running = sa.filter((c) => c.state === 'running').length;
  const head = `<header class="phead">
    <div class="crumbs wide-only"><button data-tab="_home">${esc(S.info?.host || 'Overview')}</button>${icon('chevron')}<span class="cur">Standalone</span></div>
    <div class="ptitle"><span class="picon">${icon('box')}</span><h1>Standalone</h1><span class="pill ${running ? 'ok' : 'off'} lg"><span class="dot"></span>${running} of ${sa.length} running</span></div>
    <div class="ppath">Containers not managed by compose</div>
  </header>`;
  const toolbar = S.sel.size ? selectionBar('standalone') : `<div class="toolbar hint">${icon('check')}<span>Select containers to start, stop or remove several at once</span></div>`;
  const list = sa.length ? listHtml(sa.map((c) => containerRow(c)).join(''), sa.map((c) => `c:${c.name}`)) : `<div class="empty card">${icon('box')}<div class="et">No standalone containers</div></div>`;
  return { kind: 'standalone', slots: ['head', 'toolbar', 'list'], html: { head, toolbar, list } };
}

function stackCard(p) {
  const pt = projectTone(p.name);
  const { cs, ghosts } = projectRows(p.name);
  const items = [...cs.filter((c) => !c.oneoff).map((c) => ({ n: c.service, t: tone(c) })), ...ghosts.map((g) => ({ n: g.name, t: 'ghost' }))];
  const shown = items.slice(0, 6);
  const bad = cs.filter((c) => tone(c) === 'err').length;
  return `<button class="scard" data-tab="p:${esc(p.name)}">
    <div class="sc-top">
      <span class="sc-icon ${pt.tone}">${icon('layers')}</span>
      <div class="sc-title"><div class="sc-name">${esc(p.name)}</div><div class="sc-sub">${pt.total ? `${pt.running}/${pt.total} running` : 'Down'}${bad ? ` · <span class="errt">${bad} failing</span>` : ''}</div></div>
      ${icon('chevron', 'sc-chev')}
    </div>
    <div class="sc-svcs">${shown.map((s) => `<span class="svc"><span class="dot ${s.t}"></span>${esc(s.n)}</span>`).join('')}${items.length > shown.length ? `<span class="svc more">+${items.length - shown.length}</span>` : ''}${items.length ? '' : '<span class="svc none">No containers</span>'}</div>
  </button>`;
}

function renderHome() {
  const i = S.info;
  const running = S.containers.filter((c) => c.state === 'running').length;
  const upStacks = S.projects.filter((p) => projectContainers(p.name).some((c) => c.state === 'running')).length;
  const bad = S.containers.filter((c) => tone(c) === 'err');
  const f = S.filter.trim().toLowerCase();
  const head = `<header class="hero">
    <img class="hero-logo" src="/icon.svg" alt="">
    <h1>${esc(i?.host || 'taco')}</h1>
    <div class="hero-sub">${i ? [esc(i.os), hostLine(i), i.cpus ? `${i.cpus} CPUs` : ''].filter(Boolean).join(' · ') : '&nbsp;'}</div>
  </header>`;
  const stats = `<div class="stats">
    <div class="stat"><div class="sl">Stacks up</div><div class="sv">${upStacks}<span>/${S.projects.length}</span></div></div>
    <div class="stat"><div class="sl">Containers running</div><div class="sv">${running}<span>/${S.containers.length}</span></div></div>
    <div class="stat ${bad.length ? 'bad' : ''}"><div class="sl">Need attention</div><div class="sv">${bad.length}</div></div>
  </div>`;
  const search = `<label class="search narrow-only">${icon('search')}<input class="filter" type="search" placeholder="Search stacks & containers" value="${esc(S.filter)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>`;
  let body = '';
  if (f) {
    const cs = S.containers.filter((c) => [c.name, c.image, c.service, c.project].some((x) => x?.toLowerCase().includes(f)));
    const ps = S.projects.filter((p) => p.name.toLowerCase().includes(f));
    if (ps.length) body += `<div class="sec-head"><h2>Stacks</h2></div><div class="sgrid">${ps.map(stackCard).join('')}</div>`;
    if (cs.length) body += `<div class="sec-head"><h2>Containers</h2></div>${listHtml(cs.map((c) => containerRow(c, { selectable: false, withProject: true })).join(''), cs.map((c) => c.name), { selectable: false })}`;
    if (!body) body = `<div class="empty">${icon('search')}<div class="et">Nothing matches “${esc(S.filter)}”</div></div>`;
  } else {
    body += `<div class="sec-head"><h2>Stacks</h2><span class="sec-sub">${S.projects.length}</span><span class="sp"></span>${i?.stacksDir ? `<button class="btn sm" data-act="newstack">${icon('plus')}<span>New stack</span></button>` : ''}</div>`;
    body += S.projects.length ? `<div class="sgrid">${S.projects.map(stackCard).join('')}</div>` : `<div class="empty card">${icon('layers')}<div class="et">No stacks found</div><div class="es">Compose projects started on this host, or found in /stacks, show up here.</div></div>`;
    if (bad.length) {
      body += `<div class="sec-head"><h2>Need attention</h2><span class="sec-sub">${bad.length}</span></div>`;
      body += listHtml(bad.map((c) => containerRow(c, { selectable: false, withProject: true })).join(''), bad.map((c) => c.name), { selectable: false, title: 'Failing' });
    }
    const sa = standalone();
    if (sa.length) {
      body += `<div class="sec-head"><h2>Standalone</h2><span class="sec-sub">${sa.length}</span><span class="sp"></span><button class="btn sm ghost" data-tab="_standalone">Open${icon('chevron')}</button></div>`;
      body += listHtml(sa.map((c) => containerRow(c, { selectable: false })).join(''), sa.map((c) => c.name), { selectable: false });
    }
  }
  return { kind: 'home', slots: ['head', 'stats', 'search', 'body'], html: { head, stats, search, body } };
}

// ---------------------------------------------------------------- images

async function loadImages(force) {
  const cur = S.images;
  if (!force && cur && (cur.loading || Date.now() - cur.at < 15_000)) return;
  S.images = { ...(cur || { list: null }), loading: true, at: Date.now() };
  try {
    const r = await api('/api/images');
    S.images = { at: Date.now(), list: r.images };
  } catch (e) {
    S.images = { at: Date.now(), list: cur?.list || null, error: e.message };
  }
  renderSidebar();
  if (S.tab === '_images') renderMain();
}

// Docker reports sizes in decimal units (263MB), so show them the same way.
function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log10(n) / 3));
  return `${(n / 1000 ** i).toFixed(i > 1 ? 1 : 0).replace(/\.0$/, '')} ${u[i]}`;
}

const imageKey = (img) => `i:${img.id}`;
const shortId = (id) => id.replace(/^sha256:/, '').slice(0, 12);
function imageName(img) {
  if (img.tags.length) return { name: img.tags[0], untagged: false };
  const repo = img.digests[0]?.split('@')[0];
  return { name: repo || '<none>', untagged: true };
}

function imageRow(img) {
  const key = imageKey(img);
  const used = img.containers.length > 0;
  const running = img.containers.some((c) => c.state === 'running');
  const sel = S.sel.has(key);
  const { name, untagged } = imageName(img);
  const pill = running
    ? '<span class="pill ok"><span class="dot"></span>In use</span>'
    : used
      ? '<span class="pill off"><span class="dot"></span>Stopped</span>'
      : `<span class="pill off ghost"><span class="dot"></span>${untagged ? 'Untagged' : 'Unused'}</span>`;
  const users = img.containers
    .slice(0, 3)
    .map((c) => `<button class="port user" ${c.project ? `data-tab="p:${esc(c.project)}"` : 'data-tab="_standalone"'} title="${esc(c.name)} (${esc(c.state)})"><span class="dot ${c.state === 'running' ? 'ok' : 'off'}"></span><span class="lbl">${esc(c.service && c.project ? `${c.project}/${c.service}` : c.name)}</span></button>`)
    .join('');
  const more = img.containers.length > 3 ? `<span class="port more">+${img.containers.length - 3}</span>` : '';
  const extraTags = img.tags.length > 1 ? ` · +${img.tags.length - 1} tag${img.tags.length > 2 ? 's' : ''}` : '';
  return `<div class="crow img-row ${sel ? 'selected' : ''} ${used ? 'in-use' : ''}" data-key="${esc(key)}" ${used ? '' : 'data-act="rowsel"'}>
    ${used ? '<span class="cb disabled" title="In use by a container"></span>' : checkbox(sel ? 'on' : '', `data-act="sel" data-key="${esc(key)}"`, `Select ${name}`)}
    <div class="c-name"><div class="c-txt"><div class="n ${untagged ? 'untagged' : ''}" title="${esc([...img.tags, ...img.digests].join('\n') || img.id)}">${esc(name)}</div><div class="img">${esc(shortId(img.id))}${esc(extraTags)}</div></div></div>
    <div class="c-meta">
      <div class="c-status">${pill}<span class="since">${esc((img.createdSince || '').replace(/ ago$/, ''))}</span></div>
      <div class="c-ports">${users}${more}</div>
      <div class="c-usage"><span class="usage"><span class="u-cpu">${esc(fmtSize(img.size))}</span></span></div>
    </div>
    <div class="c-acts"><button class="rb icon" data-act="imenu" data-id="${esc(img.id)}" aria-label="Image actions" title="More">${icon('more')}</button></div>
  </div>`;
}

function renderImages() {
  loadImages();
  const list = S.images?.list;
  const head = `<header class="phead">
    <div class="crumbs wide-only"><button data-tab="_home">${esc(S.info?.host || 'Overview')}</button>${icon('chevron')}<span class="cur">Images</span></div>
    <div class="ptitle"><span class="picon">${icon('disk')}</span><h1>Images</h1>${list ? `<span class="pill off lg"><span class="dot"></span>${list.length} images · ${list.filter((x) => !x.containers.length).length} unused</span>` : ''}</div>
    <div class="ppath" style="direction:ltr">Every image on this host (docker image ls -a), and the containers using it</div>
  </header>`;
  if (!list) {
    const body = S.images?.error
      ? `<div class="notice">${icon('alert')}<div>${esc(S.images.error)}</div></div>`
      : '<div class="fcard loading"><div class="shimmer"></div><div class="shimmer short"></div><div class="shimmer"></div></div>';
    return { kind: 'images', slots: ['head', 'toolbar', 'list'], html: { head, toolbar: '<div class="toolbar"></div>', list: body } };
  }
  const f = S.filter.trim().toLowerCase();
  const unused = list.filter((x) => !x.containers.length);
  pruneSelection(unused.map(imageKey));
  const shown = list
    .filter((x) => (S.imgFilter === 'used' ? x.containers.length : S.imgFilter === 'unused' ? !x.containers.length : true))
    .filter((x) => !f || [...x.tags, ...x.digests, x.id].some((t) => t.toLowerCase().includes(f)))
    .sort((a, b) => imageName(a).untagged - imageName(b).untagged || imageName(a).name.localeCompare(imageName(b).name) || String(b.created).localeCompare(String(a.created)));

  let toolbar;
  if (S.sel.size) {
    const size = list.filter((x) => S.sel.has(imageKey(x))).reduce((a, x) => a + x.size, 0);
    toolbar = `<div class="toolbar selmode">
      <div class="selchip"><span class="selnum">${S.sel.size}</span><span>selected</span><button class="selx" data-act="selclear" aria-label="Clear selection" title="Clear selection (Esc)">${icon('x')}</button></div>
      <div class="tb-scroll"><span class="tb-note">up to ${esc(fmtSize(size))}</span>${tbtn('imgdel', 'trash', 'Delete', '', 'danger')}</div>
    </div>`;
  } else {
    const seg = (v, label, n) => `<button class="seg-b ${S.imgFilter === v ? 'on' : ''}" data-act="imgfilter" data-f="${v}">${label}<span class="seg-n">${n}</span></button>`;
    toolbar = `<div class="toolbar">
      <div class="seg">${seg('all', 'All', list.length)}${seg('used', 'In use', list.length - unused.length)}${seg('unused', 'Unused', unused.length)}</div>
      <span class="sp"></span>
      ${tbtn('imgprune', 'trash', 'Remove all unused', unused.length ? '' : 'disabled', 'danger-text')}
      <button class="btn icon" data-act="imgreload" aria-label="Reload" title="Reload">${icon('refresh')}</button>
    </div>`;
  }
  const body = shown.length
    ? listHtml(shown.map(imageRow).join(''), shown.filter((x) => !x.containers.length).map(imageKey), { title: 'Images', cols: ['Status', 'Used by', 'Size'] })
    : `<div class="empty card">${icon('disk')}<div class="et">${f ? `Nothing matches “${esc(S.filter)}”` : S.imgFilter === 'unused' ? 'No unused images' : 'No images'}</div></div>`;
  return { kind: 'images', slots: ['head', 'toolbar', 'list'], html: { head, toolbar, list: body } };
}

async function deleteImages(ids) {
  const list = S.images?.list || [];
  const imgs = ids.map((id) => list.find((x) => x.id === id)).filter(Boolean);
  if (!imgs.length) return;
  const size = imgs.reduce((a, x) => a + x.size, 0);
  const names = imgs.slice(0, 3).map((x) => imageName(x).name).join(', ') + (imgs.length > 3 ? ` and ${imgs.length - 3} more` : '');
  const ok = await confirmAction(`Delete ${imgs.length === 1 ? names : `${imgs.length} images`}?`, `${imgs.length > 1 ? `${names}. ` : ''}Frees up to ${fmtSize(size)} (layers shared with other images are kept).`, 'Delete');
  if (!ok) return;
  S.sel.clear();
  await runJob(`Delete ${imgs.length === 1 ? names : `${imgs.length} images`}`, '/api/images/rm', { ids: imgs.map((x) => x.id) });
}

async function pruneImages() {
  const unused = (S.images?.list || []).filter((x) => !x.containers.length);
  const ok = await confirmAction(`Remove all ${unused.length} unused images?`, 'Runs docker image prune --all: every image not used by any container, running or stopped, is deleted.', 'Remove');
  if (ok) await runJob('Remove unused images', '/api/images/prune', {});
}

async function imageMenu(btn, id) {
  const img = S.images?.list?.find((x) => x.id === id);
  if (!img) return;
  const used = img.containers.length > 0;
  const v = await menu(btn, {
    title: imageName(img).name,
    subtitle: `${shortId(img.id)} · ${fmtSize(img.size)}`,
    items: [
      { label: 'Copy ID', icon: 'file', value: 'copyid' },
      img.tags.length && { label: 'Copy name', icon: 'file', value: 'copyname' },
      'sep',
      { label: used ? 'Delete (in use)' : 'Delete', icon: 'trash', value: 'del', danger: true, disabled: used },
    ],
  });
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copied'), () => toast(t));
  if (v === 'copyid') copy(img.id);
  else if (v === 'copyname') copy(img.tags[0]);
  else if (v === 'del') deleteImages([img.id]);
}

// ================================================================ selection

function pruneSelection(valid) {
  const ok = new Set(valid);
  for (const k of S.sel) if (!ok.has(k)) S.sel.delete(k);
}

function currentKeys() {
  return $$('#main .crow[data-act="rowsel"]').map((r) => r.dataset.key);
}

function toggleSel(key, { range = false } = {}) {
  if (range && S.lastSel) {
    const keys = currentKeys();
    const a = keys.indexOf(S.lastSel);
    const b = keys.indexOf(key);
    if (a >= 0 && b >= 0) {
      const on = !S.sel.has(key);
      for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? S.sel.add(k) : S.sel.delete(k);
      S.lastSel = key;
      return renderMain();
    }
  }
  S.sel.has(key) ? S.sel.delete(key) : S.sel.add(key);
  S.lastSel = key;
  renderMain();
}

function selectAll() {
  const keys = currentKeys();
  if (keys.every((k) => S.sel.has(k))) S.sel.clear();
  else keys.forEach((k) => S.sel.add(k));
  renderMain();
}

const SEL_LABEL = { start: 'Start', restart: 'Restart', stop: 'Stop', recreate: 'Recreate', 'pull-up': 'Pull & up', kill: 'Kill', rm: 'Remove' };

async function selectionAction(action) {
  const keys = [...S.sel];
  if (!keys.length) return;
  const label = SEL_LABEL[action];
  const name = S.tab.startsWith('p:') ? S.tab.slice(2) : '';
  const containers = keys.filter((k) => k.startsWith('c:')).map((k) => containerByName(k.slice(2))).filter(Boolean);
  const ghostSvcs = keys.filter((k) => k.startsWith('s:')).map((k) => k.slice(2));
  const what = `${keys.length} container${keys.length > 1 ? 's' : ''}`;
  if (action === 'rm' && !(await confirmAction(`Remove ${what}?`, 'Running ones are stopped first. Volumes are kept.', 'Remove'))) return;
  if (action === 'kill' && !(await confirmAction(`Kill ${what}?`, 'Sends SIGKILL to each container.', 'Kill'))) return;

  // Compose services go through compose (one command for all of them); one-off
  // and standalone containers through plain docker, one by one.
  const viaCompose = name ? containers.filter((c) => c.project === name && !c.oneoff) : [];
  const direct = containers.filter((c) => !viaCompose.includes(c));
  const services = [...new Set([...viaCompose.map((c) => c.service), ...ghostSvcs])];
  S.sel.clear();
  renderMain();
  if (services.length) {
    // "Start" a not-yet-created service means creating it, so it is `up` for compose.
    const a = action === 'start' ? 'up' : action;
    await runJob(`${label} ${name}/${services.join(', ')}`, `/api/projects/${encodeURIComponent(name)}/action/${a}`, { services });
  }
  if (direct.length) await bulkContainerAction(direct, action === 'rm' ? 'rm' : action === 'pull-up' || action === 'recreate' ? 'restart' : action, label);
}

// ================================================================ actions

const JOB_OK_HIDE = 1800;
let jobSeq = 0;

function jobUi(title) {
  const id = ++jobSeq;
  const el = $('#job');
  el.hidden = false;
  el.className = '';
  el.innerHTML = `<div class="job-head"><span class="job-ic"><span class="spin"></span></span><div class="t">${esc(title)}</div><button class="iconbtn sm" data-job="min" aria-label="Collapse">${icon('chevdown')}</button><button class="iconbtn sm" data-job="close" aria-label="Close">${icon('x')}</button></div><pre class="job-out"></pre>`;
  const out = $('.job-out', el);
  let touched = false;
  el.onclick = (e) => {
    const j = e.target.closest('[data-job]')?.dataset.job;
    if (j === 'close') {
      el.hidden = true;
      return;
    }
    if (j === 'min' || e.target.closest('.job-head')) el.classList.toggle('min');
    touched = true;
  };
  return {
    id,
    append(text, cls) {
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = text;
      out.append(span);
      if (atBottom) out.scrollTop = out.scrollHeight;
    },
    finish(ok, summary) {
      if (id !== jobSeq) return;
      el.classList.add(ok ? 'ok' : 'failed');
      $('.job-ic', el).innerHTML = ok ? icon('check') : icon('x');
      $('.job-head .t', el).textContent = `${title} — ${summary}`;
      toast(`${title}: ${ok ? 'done' : 'failed'}`, ok ? 'ok' : 'err');
      if (ok) setTimeout(() => !touched && id === jobSeq && (el.hidden = true), JOB_OK_HIDE);
    },
  };
}

async function runJob(title, url, body) {
  const job = jobUi(title);
  let code = -1;
  let buf = '';
  try {
    await stream(url, {
      method: 'POST',
      body: body || {},
      onChunk: (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.t === 'cmd') job.append(`$ ${m.d.replace(/ -f \S+| --project-directory \S+| --env-file \S+/g, '')}\n`, 'cmd');
          else if (m.t === 'o') job.append(m.d);
          else if (m.t === 'exit') code = m.code;
        }
      },
    });
  } catch (e) {
    job.append(`${e.message}\n`, 'errline');
  }
  job.finish(code === 0, code === 0 ? 'done' : `failed (exit ${code})`);
  for (const k of Object.keys(S.services)) S.services[k].at = 0;
  refresh();
  if (S.images) loadImages(true);
  return code;
}

async function bulkContainerAction(list, action, label) {
  const job = jobUi(`${label} ${list.length} container${list.length > 1 ? 's' : ''}`);
  let failed = 0;
  for (const c of list) {
    const running = c.state === 'running' || c.state === 'paused';
    const force = action === 'rm' && running;
    job.append(`$ docker ${action}${force ? ' -f' : ''} ${c.name}\n`, 'cmd');
    try {
      await api(`/api/containers/${encodeURIComponent(c.name)}/${action}`, { method: 'POST', body: { force } });
      job.append(`${c.name}\n`);
    } catch (e) {
      failed++;
      job.append(`${e.message}\n`, 'errline');
    }
  }
  job.finish(!failed, failed ? `${failed} failed` : 'done');
  refresh();
}

const ACTION_LABEL = { up: 'Up', down: 'Down', stop: 'Stop', start: 'Start', restart: 'Restart', pull: 'Pull', 'pull-up': 'Pull & up', recreate: 'Recreate', build: 'Build & up', kill: 'Kill', rm: 'Remove' };

async function projectAction(name, action, services) {
  const target = services ? `${name}/${services.join(',')}` : name;
  if (action === 'down' && !(await confirmAction(`Down ${name}?`, 'Stops and removes all containers and networks of this stack. Volumes are kept.', 'Down'))) return;
  return runJob(`${ACTION_LABEL[action]} ${target}`, `/api/projects/${encodeURIComponent(name)}/action/${action}`, services ? { services } : {});
}

async function containerAction(name, action) {
  const c = containerByName(name);
  const running = c && (c.state === 'running' || c.state === 'paused');
  if (action === 'kill' && !(await confirmAction(`Kill ${name}?`, 'Sends SIGKILL to the container.', 'Kill'))) return;
  if (action === 'rm' && !(await confirmAction(`Remove ${name}?`, running ? 'The container is running and will be force-removed.' : 'The container will be deleted. Volumes are kept.', 'Remove'))) return;
  toast(`${action} ${name}…`);
  try {
    await api(`/api/containers/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: { force: action === 'rm' && running } });
    toast(`${name}: ${action} ok`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
  refresh();
}

async function containerMenu(btn, name) {
  const c = containerByName(name);
  if (!c) return;
  const run = c.state === 'running';
  const paused = c.state === 'paused';
  const svc = c.project && !c.oneoff;
  const v = await menu(btn, {
    title: c.service && c.project ? c.service : c.name,
    subtitle: [c.name, shortImage(c.image)].join(' · '),
    items: [
      !run && !paused && { label: 'Start', icon: 'play', value: 'c:start' },
      run && { label: 'Restart', icon: 'restart', value: 'c:restart' },
      run && { label: 'Stop', icon: 'stop', value: 'c:stop' },
      run && { label: 'Pause', icon: 'pause', value: 'c:pause' },
      paused && { label: 'Unpause', icon: 'play', value: 'c:unpause' },
      svc && 'sep',
      svc && { label: 'Recreate', icon: 'recreate', value: 's:recreate', hint: 'up --force-recreate' },
      svc && { label: 'Pull & recreate', icon: 'pull', value: 's:pull-up' },
      'sep',
      { label: 'Logs', icon: 'logs', value: 'v:logs' },
      { label: 'Shell', icon: 'terminal', value: 'v:shell', disabled: !run },
      { label: 'Inspect', icon: 'inspect', value: 'v:info' },
      'sep',
      (run || paused) && { label: 'Kill', icon: 'zap', value: 'c:kill', danger: true },
      { label: run || paused ? 'Force remove' : 'Remove', icon: 'trash', value: 'c:rm', danger: true },
    ],
  });
  if (!v) return;
  const [k, a] = v.split(':');
  if (k === 'c') containerAction(c.name, a);
  else if (k === 's') projectAction(c.project, a, [c.service]);
  else if (k === 'v') openView(viewPath({ kind: 'c', name: c.name, mode: a }));
}

async function ghostMenu(btn, project, svc, build) {
  const v = await menu(btn, {
    title: svc,
    subtitle: 'Not created yet',
    items: [
      { label: 'Up', icon: 'play', value: 'up', hint: 'create & start' },
      build ? { label: 'Build & up', icon: 'hammer', value: 'build' } : { label: 'Pull & up', icon: 'pull', value: 'pull-up' },
    ],
  });
  if (v) projectAction(project, v, [svc]);
}

async function projectMenu(btn, name) {
  const p = projectByName(name);
  if (!p) return;
  const hasBuild = S.services[name]?.services.some((s) => s.build);
  const v = await menu(btn, {
    title: name,
    subtitle: p.configFiles[0] || '',
    items: [
      { label: 'Start', icon: 'play', value: 'start', hint: 'existing containers' },
      { label: 'Pull images', icon: 'pull', value: 'pull' },
      hasBuild && { label: 'Build & up', icon: 'hammer', value: 'build' },
      'sep',
      { label: 'Kill', icon: 'zap', value: 'kill', danger: true },
      { label: 'Down', icon: 'power', value: 'down', danger: true, hint: 'removes containers' },
    ],
  });
  if (v) projectAction(name, v);
}

async function jumpMenu(btn) {
  const v = await menu(btn, {
    title: 'Go to',
    items: [
      ...tabs().map((t) => {
        const pt = t.project && projectTone(t.project);
        return { label: t.label, icon: t.project ? 'layers' : { _home: 'home', _images: 'disk' }[t.id] || 'box', value: `t:${t.id}`, hint: pt ? countLabel(pt) : '' };
      }),
      S.info?.stacksDir && 'sep',
      S.info?.stacksDir && { label: 'New stack', icon: 'plus', value: 'new' },
    ],
  });
  if (v === 'new') newStack();
  else if (v) goTab(v.slice(2));
}

async function newStack() {
  const name = await dialog({
    title: 'New stack',
    message: `Creates ${S.info.stacksDir}/<name>.yaml with a starter service.`,
    input: { placeholder: 'name (a-z, 0-9, -, _)' },
    actions: [{ label: 'Create', kind: 'primary', value: true }],
  });
  if (!name) return;
  try {
    const p = await api('/api/stacks', { method: 'POST', body: { name } });
    await refresh();
    S.focusEditor = true;
    goTab(`p:${p.name}`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ================================================================ events

document.addEventListener('click', async (e) => {
  if (e.target.closest('a.port')) return;
  const t = e.target.closest('[data-act],[data-tab]');
  if (!t || t.disabled) return;
  const a = t.dataset.act;
  if (!a && t.dataset.tab) return goTab(t.dataset.tab);
  switch (a) {
    case 'view':
      if (!t.dataset.v) return;
      // In the panel's segmented control, switch; elsewhere, the open view's button closes it.
      if (t.closest('.seg')) return openView(t.dataset.v);
      return toggleView(t.dataset.v);
    case 'closeview':
      return closeView();
    case 'pact':
      return projectAction(t.dataset.p, t.dataset.a);
    case 'pmenu':
      return projectMenu(t, t.dataset.p);
    case 'cmenu':
      return containerMenu(t, t.dataset.id);
    case 'gmenu':
      return ghostMenu(t, t.dataset.p, t.dataset.svc, !!t.dataset.build);
    case 'sel':
      return toggleSel(t.dataset.key, { range: e.shiftKey });
    case 'rowsel':
      // Clicking a row's empty space selects it too (but not text being selected).
      if (getSelection()?.toString()) return;
      return toggleSel(t.dataset.key, { range: e.shiftKey });
    case 'selall':
      return selectAll();
    case 'selclear':
      S.sel.clear();
      return renderMain();
    case 'selact':
      return selectionAction(t.dataset.a);
    case 'newstack':
      return newStack();
    case 'theme':
      return toggleTheme();
    case 'jump':
      return jumpMenu(t);
    case 'imenu':
      return imageMenu(t, t.dataset.id);
    case 'imgdel':
      return deleteImages([...S.sel].map((k) => k.slice(2)));
    case 'imgprune':
      return pruneImages();
    case 'imgreload':
      return loadImages(true);
    case 'imgfilter':
      S.imgFilter = t.dataset.f;
      S.sel.clear();
      return renderMain();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  const inField = e.target.closest?.('input, textarea, select, .cm-editor, .xterm');
  if (e.key === 'Escape' && !inField) {
    if (S.sel.size) {
      S.sel.clear();
      renderMain();
    } else if (S.view && isWide()) closeView();
    return;
  }
  if (inField) {
    if (e.key === 'Escape' && e.target.classList.contains('filter')) e.target.blur();
    return;
  }
  if (e.key === '/' && isWide()) {
    e.preventDefault();
    $('#sidebar .filter')?.focus();
  }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const ts = tabs();
    const i = tabIndex(S.tab) + (e.key === 'ArrowRight' ? 1 : -1);
    if (ts[i]) goTab(ts[i].id);
  }
});

document.addEventListener('input', (e) => {
  if (!e.target.classList.contains('filter')) return;
  S.filter = e.target.value;
  for (const f of $$('.filter')) if (f !== e.target) f.value = S.filter;
  renderSidebar();
  renderMain();
});
document.addEventListener('keydown', (e) => {
  // Enter in the sidebar search opens the first matching stack.
  if (e.target.classList?.contains('filter') && e.key === 'Enter' && e.target.closest('#sidebar')) {
    const first = $('#sidebar .sb-item[data-tab^="p:"]');
    if (first) goTab(first.dataset.tab);
  }
});

// Swipe left/right on the page to move between tabs (phones).
(() => {
  let sx = 0;
  let sy = 0;
  let ok = false;
  const main = $('#main');
  main.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    ok = e.touches.length === 1 && !e.target.closest('.toolbar, .c-ports, input, .cm-editor, .files') && sx > 20 && sx < innerWidth - 20;
  }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (!ok || isWide()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const ts = tabs();
    const next = ts[tabIndex(S.tab) + (dx < 0 ? 1 : -1)];
    if (next) goTab(next.id);
  }, { passive: true });
})();

addEventListener('popstate', () => {
  if (history.state?.menu) return;
  // Closing a panel pops back to the entry it was opened from; keep the tab the user is on now.
  const t = S.returnTab;
  S.returnTab = null;
  const r = parseRoute();
  if (t && !r.view && r.tab !== t) history.replaceState(history.state, '', hashFor(t));
  render();
});

// Drag the sidebar's right edge to resize it.
(() => {
  const rz = $('#sb-resizer');
  const saved = localStorage.getItem('taco.sidebarw');
  if (saved) document.documentElement.style.setProperty('--sidebar-w', saved);
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('drag');
    document.body.classList.add('resizing');
    const left = $('#sidebar').getBoundingClientRect().left;
    const move = (ev) => {
      const w = Math.round(Math.min(480, Math.max(180, ev.clientX - left)));
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
    };
    const up = () => {
      rz.classList.remove('drag');
      document.body.classList.remove('resizing');
      rz.removeEventListener('pointermove', move);
      localStorage.setItem('taco.sidebarw', getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim());
    };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up, { once: true });
    rz.addEventListener('pointercancel', up, { once: true });
  });
  // Double-click restores the default width.
  rz.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--sidebar-w');
    localStorage.removeItem('taco.sidebarw');
  });
})();

// Drag the panel's left edge to resize it.
(() => {
  const rz = $('#resizer');
  const saved = localStorage.getItem('taco.panelw');
  if (saved) document.documentElement.style.setProperty('--panel-w', saved);
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('drag');
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = `${Math.round(Math.max(380, innerWidth - ev.clientX))}px`;
      document.documentElement.style.setProperty('--panel-w', w);
    };
    const up = () => {
      rz.classList.remove('drag');
      document.body.classList.remove('resizing');
      rz.removeEventListener('pointermove', move);
      localStorage.setItem('taco.panelw', getComputedStyle(document.documentElement).getPropertyValue('--panel-w').trim());
    };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up, { once: true });
    rz.addEventListener('pointercancel', up, { once: true });
  });
})();

// The toolbar gets a hairline once it sticks to the top while scrolling.
function updateStuck() {
  const main = $('#main');
  const tb = $('.toolbar', main);
  if (tb) tb.classList.toggle('stuck', main.scrollTop > 0 && tb.getBoundingClientRect().top <= main.getBoundingClientRect().top + 1);
}
$('#main').addEventListener('scroll', updateStuck, { passive: true });

// Keep full-height views above the on-screen keyboard.
if (window.visualViewport) {
  const setVh = () => document.documentElement.style.setProperty('--vvh', `${visualViewport.height}px`);
  visualViewport.addEventListener('resize', setVh);
  setVh();
}
if (isTouch) document.documentElement.classList.add('touch');

// ================================================================ boot

let pollTimer;
function schedulePolling() {
  clearInterval(pollTimer);
  if (document.hidden) return;
  let n = 0;
  pollTimer = setInterval(() => {
    refresh();
    if (++n % 4 === 0) refreshStats();
    if (n % 20 === 0) loadImages();
  }, 3000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refresh();
    refreshStats();
    S.files?.reloadClean?.();
  }
  schedulePolling();
});

(async () => {
  S.tab = parseRoute().tab;
  api('/api/info')
    .then((i) => {
      S.info = i;
      renderSidebar();
      renderMain();
    })
    .catch(() => {});
  await refresh();
  // A deep link straight into a view gets a list entry underneath so Back works.
  const r = parseRoute();
  if (r.view) {
    const h = location.hash;
    history.replaceState(null, '', hashFor(r.tab));
    history.pushState({ ov: 1 }, '', h);
  }
  render();
  refreshStats();
  loadImages();
  schedulePolling();
})();

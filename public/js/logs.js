// Live log viewer for a container (`docker logs -f`) or a whole stack (`docker compose logs -f`).
import { $, esc, icon, stream, ansiToHtml, stripAnsi, hueOf } from './ui.js';

const MAX_LINES = 5000;
const PREFS_KEY = 'taco.logs';
const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) ?/;
const PREFIX_RE = /^(\S+?)\s+\| /;

export function mount(el, { container, project }) {
  const prefs = { wrap: true, ts: true, tail: '500', ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  const multi = !!project;
  const base = multi
    ? `/api/projects/${encodeURIComponent(project.name)}/logs`
    : `/api/containers/${encodeURIComponent(container.name)}/logs`;

  el.innerHTML = `
    <div class="pv-tools">
      <label class="pv-search">${icon('search')}<input type="search" placeholder="${multi ? 'Filter stack logs' : 'Filter logs'}" autocapitalize="off" autocorrect="off" spellcheck="false"><span class="matches" data-k="matches"></span></label>
      <button class="iconbtn sm ${prefs.wrap ? 'on' : ''}" data-k="wrap" aria-label="Wrap lines" title="Wrap lines">${icon('wrap')}</button>
      <button class="iconbtn sm ${prefs.ts ? 'on' : ''}" data-k="ts" aria-label="Timestamps" title="Timestamps">${icon('clock')}</button>
      <select data-k="tail" aria-label="Lines" title="Lines of history">
        ${['100', '500', '2000', 'all'].map((v) => `<option value="${v}" ${prefs.tail === v ? 'selected' : ''}>${v === 'all' ? 'All' : v}</option>`).join('')}
      </select>
    </div>
    <div class="logbody"><div class="lines"></div></div>
    <button class="jump" hidden>${icon('down')}<span>Latest</span></button>
    <div class="pv-foot"><span class="dot"></span><span data-k="state">connecting…</span><span class="sp"></span><span data-k="count"></span><button class="btn sm ghost" data-k="reload">${icon('refresh')}<span>Reconnect</span></button></div>`;

  const body = $('.logbody', el);
  const lines = $('.lines', el);
  const jump = $('.jump', el);
  const filterInput = $('.pv-search input', el);
  let filter = '';
  let pending = [];
  let partial = '';
  let follow = true;
  let unseen = 0;
  let count = 0;
  let ctrl = null;
  let raf = 0;

  const applyClasses = () => {
    lines.classList.toggle('wrap', prefs.wrap);
    lines.classList.toggle('nots', !prefs.ts);
  };
  applyClasses();

  const setState = (text, tone) => {
    $('[data-k="state"]', el).textContent = text;
    $('.pv-foot .dot', el).className = `dot ${tone || ''}`;
  };

  const fmtTs = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    const today = new Date().toDateString() === d.toDateString();
    return `${today ? '' : `${p(d.getMonth() + 1)}-${p(d.getDate())} `}${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  function lineNode(raw) {
    let rest = raw;
    let svc = '';
    let m;
    if (multi && (m = rest.match(PREFIX_RE))) {
      svc = m[1];
      rest = rest.slice(m[0].length);
    }
    let ts = '';
    if ((m = rest.match(TS_RE))) {
      ts = m[1];
      rest = rest.slice(m[0].length);
    }
    const div = document.createElement('div');
    div.className = 'ln';
    div.dataset.text = stripAnsi(`${svc} ${rest}`).toLowerCase();
    div.innerHTML =
      (ts ? `<span class="ts" title="${esc(ts)}">${fmtTs(ts)}</span>` : '') +
      (svc ? `<span class="svc" style="color:hsl(${hueOf(svc.replace(/-\d+$/, ''))} 65% 60%)">${esc(svc.replace(/-\d+$/, ''))}</span>` : '') +
      ansiToHtml(rest);
    if (filter && !div.dataset.text.includes(filter)) div.classList.add('hide');
    return div;
  }

  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 40;

  function flush() {
    raf = 0;
    if (!pending.length) return;
    const frag = document.createDocumentFragment();
    for (const l of pending) frag.append(lineNode(l));
    count += pending.length;
    const added = pending.length;
    pending = [];
    lines.append(frag);
    while (lines.childElementCount > MAX_LINES) lines.firstElementChild.remove();
    $('[data-k="count"]', el).textContent = `${Math.min(count, MAX_LINES)} lines`;
    if (follow) body.scrollTop = body.scrollHeight;
    else {
      unseen += added;
      jump.hidden = false;
      $('span', jump).textContent = `${unseen > 999 ? '999+' : unseen} new`;
    }
    if (filter) updateMatches();
  }

  function push(chunk) {
    partial += chunk;
    const parts = partial.split('\n');
    partial = parts.pop();
    for (const p of parts) pending.push(p.replace(/\r$/, ''));
    if (pending.length > MAX_LINES) pending = pending.slice(-MAX_LINES);
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function sysLine(text) {
    const div = document.createElement('div');
    div.className = 'ln sys';
    div.textContent = text;
    lines.append(div);
    if (follow) body.scrollTop = body.scrollHeight;
  }

  async function connect() {
    ctrl?.abort();
    ctrl = new AbortController();
    const my = ctrl;
    lines.innerHTML = '';
    pending = [];
    partial = '';
    count = 0;
    follow = true;
    jump.hidden = true;
    setState('connecting…');
    try {
      let first = true;
      await stream(`${base}?tail=${prefs.tail}&follow=1`, {
        signal: my.signal,
        onChunk: (c) => {
          if (first) setState('live', 'ok pulse');
          first = false;
          push(c);
        },
      });
      if (my !== ctrl) return;
      if (partial) push('\n');
      setState('stream ended', 'off');
      sysLine('— stream ended (container stopped?) — reconnect to follow again —');
    } catch (e) {
      if (e.name === 'AbortError' || my !== ctrl) return;
      setState('error', 'err');
      sysLine(`— ${e.message} —`);
    }
  }

  function updateMatches() {
    const n = filter ? lines.querySelectorAll('.ln:not(.hide):not(.sys)').length : 0;
    $('[data-k="matches"]', el).textContent = filter ? `${n} match${n === 1 ? '' : 'es'}` : '';
  }

  function applyFilter() {
    filter = filterInput.value.trim().toLowerCase();
    for (const n of lines.children) {
      if (n.classList.contains('sys')) continue;
      n.classList.toggle('hide', !!filter && !n.dataset.text.includes(filter));
    }
    updateMatches();
    if (follow) body.scrollTop = body.scrollHeight;
  }

  body.addEventListener('scroll', () => {
    const b = atBottom();
    if (b && !follow) {
      follow = true;
      unseen = 0;
      jump.hidden = true;
    } else if (!b && follow) follow = false;
  }, { passive: true });

  jump.onclick = () => {
    follow = true;
    unseen = 0;
    jump.hidden = true;
    body.scrollTop = body.scrollHeight;
  };

  let ft;
  filterInput.addEventListener('input', () => {
    clearTimeout(ft);
    ft = setTimeout(applyFilter, 120);
  });

  el.addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k === 'reload') connect();
    else if (k === 'wrap' || k === 'ts') {
      prefs[k] = !prefs[k];
      e.target.closest('[data-k]').classList.toggle('on', prefs[k]);
      savePrefs();
      applyClasses();
      if (follow) body.scrollTop = body.scrollHeight;
    }
  });
  $('[data-k="tail"]', el).addEventListener('change', (e) => {
    prefs.tail = e.target.value;
    savePrefs();
    connect();
  });

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      filterInput.focus();
    }
  };
  document.addEventListener('keydown', onKey);

  connect();
  return {
    destroy() {
      ctrl?.abort();
      ctrl = null;
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
    },
  };
}

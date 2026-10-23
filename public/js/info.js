// Compact `docker inspect` summary.
import { $, esc, icon, api, fmtTime } from './ui.js';

export function mount(el, { container }) {
  el.innerHTML = `
    <div class="pv-tools"><span class="pv-status">docker inspect ${esc(container.name)}</span><span class="sp"></span><button class="btn sm ghost" data-k="reload">${icon('refresh')}<span>Reload</span></button></div>
    <div class="infobody"><div class="empty">Loading…</div></div>`;
  const body = $('.infobody', el);

  const kv = (rows) =>
    `<dl class="kv">${rows
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`)
      .join('')}</dl>`;
  const sec = (title, html, n) => (html ? `<section class="isec"><div class="isec-h">${esc(title)}${n !== undefined ? `<span class="chip">${n}</span>` : ''}</div>${html}</section>` : '');
  const fold = (title, html, n) =>
    html ? `<details class="isec"><summary class="isec-h">${esc(title)}<span class="chip">${n}</span><span class="sp"></span>${icon('chevdown')}</summary>${html}</details>` : '';

  async function load() {
    try {
      const d = await api(`/api/containers/${encodeURIComponent(container.name)}`);
      const st = d.State || {};
      const cfg = d.Config || {};
      const hc = d.HostConfig || {};
      const ports = Object.entries(d.NetworkSettings?.Ports || {}).flatMap(([cp, binds]) =>
        binds ? binds.map((b) => [`${b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? `${b.HostIp}:` : ''}${b.HostPort}`, cp]) : [['—', cp]],
      );
      const uniqPorts = ports.filter((p, i) => ports.findIndex((q) => q[0] === p[0] && q[1] === p[1]) === i);
      const nets = Object.entries(d.NetworkSettings?.Networks || {});
      const mounts = d.Mounts || [];
      const env = cfg.Env || [];
      const labels = Object.entries(cfg.Labels || {});
      const cmd = [...(cfg.Entrypoint || []), ...(cfg.Cmd || [])].join(' ');
      body.innerHTML =
        sec('Overview', kv([
          ['state', `${st.Status}${st.Health ? ` (${st.Health.Status})` : ''}${st.ExitCode ? ` · exit ${st.ExitCode}` : ''}`],
          ['image', cfg.Image],
          ['id', d.Id?.slice(0, 12)],
          ['created', fmtTime(d.Created)],
          ['started', fmtTime(st.StartedAt)],
          ['finished', st.Running ? '' : fmtTime(st.FinishedAt)],
          ['restart', `${hc.RestartPolicy?.Name || 'no'}${d.RestartCount ? ` · ${d.RestartCount} restarts` : ''}`],
          ['command', cmd],
          ['workdir', cfg.WorkingDir],
          ['user', cfg.User],
          ['error', st.Error],
        ])) +
        sec('Ports', uniqPorts.length ? kv(uniqPorts.map(([h, c]) => [h, c])) : '', uniqPorts.length) +
        sec('Networks', nets.length ? kv(nets.map(([n, v]) => [n, v.IPAddress || '—'])) : '', nets.length) +
        sec('Mounts', mounts.length ? kv(mounts.map((m) => [m.Destination, `${esc(m.Type === 'volume' ? m.Name : m.Source)}<span class="chip">${esc(m.Type)}${m.RW ? '' : ' · ro'}</span>`, true])) : '', mounts.length) +
        fold('Environment', env.length ? kv(env.map((e) => [e.split('=')[0], e.slice(e.indexOf('=') + 1)])) : '', env.length) +
        fold('Labels', labels.length ? kv(labels) : '', labels.length);
    } catch (e) {
      body.innerHTML = `<div class="notice">${icon('alert')}<div>${esc(e.message)}</div></div>`;
    }
  }

  el.addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k === 'reload') load();
  });
  load();
}

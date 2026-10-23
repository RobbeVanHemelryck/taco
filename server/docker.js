// Thin wrappers around the docker CLI. Taco never talks to the Docker API
// directly and keeps no state of its own about containers: everything is read
// from (and done through) `docker` / `docker compose`, exactly like a user at a shell.
import { spawn } from 'node:child_process';

export const DOCKER_BIN = process.env.TACO_DOCKER_BIN || 'docker';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function spawnDocker(args, opts = {}) {
  return spawn(DOCKER_BIN, args, { env: process.env, ...opts });
}

export function run(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawnDocker(args);
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    p.on('error', (err) => finish({ code: -1, stdout, stderr: err.message }));
    p.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

export async function runOk(args, opts) {
  const r = await run(args, opts);
  if (r.code !== 0) throw new HttpError(502, r.stderr.trim() || `docker ${args[0]} exited with code ${r.code}`);
  return r.stdout;
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export function checkId(id) {
  if (!ID_RE.test(id)) throw new HttpError(400, 'invalid container id');
  return id;
}

const PS_FORMAT = `{${[
  ['id', '.ID'],
  ['name', '.Names'],
  ['image', '.Image'],
  ['state', '.State'],
  ['status', '.Status'],
  ['ports', '.Ports'],
  ['created', '.CreatedAt'],
  ['project', '(.Label "com.docker.compose.project")'],
  ['service', '(.Label "com.docker.compose.service")'],
  ['number', '(.Label "com.docker.compose.container-number")'],
  ['oneoff', '(.Label "com.docker.compose.oneoff")'],
  ['configFiles', '(.Label "com.docker.compose.project.config_files")'],
  ['workingDir', '(.Label "com.docker.compose.project.working_dir")'],
].map(([k, v]) => `"${k}":{{json ${v}}}`).join(',')}}`;

const jsonLines = (out) => out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

export function splitList(s) {
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

// "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 9000/tcp" -> [{ip, host, container, proto}]
export function parsePorts(s) {
  const out = [];
  const seen = new Set();
  for (const part of splitList(s)) {
    const m = part.match(/^(?:(.*):)?([\d-]+)->([\d-]+)\/(\w+)$/);
    if (!m) continue;
    let ip = (m[1] || '').replace(/^\[|\]$/g, '');
    if (ip === '0.0.0.0' || ip === '::' || ip === '') ip = '';
    const key = `${ip}|${m[2]}|${m[3]}|${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ip, host: m[2], container: m[3], proto: m[4] });
  }
  return out;
}

export async function listContainers() {
  const out = await runOk(['ps', '-a', '--no-trunc', '--format', PS_FORMAT]);
  return jsonLines(out).map((c) => ({
    ...c,
    ports: parsePorts(c.ports),
    configFiles: splitList(c.configFiles),
    number: Number(c.number) || 0,
    oneoff: c.oneoff === 'True',
  }));
}

export async function composeLs() {
  const out = await runOk(['compose', 'ls', '-a', '--format', 'json']);
  const list = JSON.parse(out.trim() || '[]') || [];
  return list.map((p) => ({ name: p.Name, status: p.Status, configFiles: splitList(p.ConfigFiles) }));
}

export async function stats() {
  const out = await runOk(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'], { timeout: 30_000 });
  const res = {};
  for (const s of jsonLines(out)) {
    res[s.ID.slice(0, 12)] = { cpu: s.CPUPerc, mem: (s.MemUsage || '').split('/')[0].trim(), memPerc: s.MemPerc, net: s.NetIO, block: s.BlockIO, pids: s.PIDs };
  }
  return res;
}

export async function info() {
  const [i, v] = await Promise.all([
    run(['info', '--format', '{{json .}}'], { timeout: 15_000 }),
    run(['compose', 'version', '--short'], { timeout: 15_000 }),
  ]);
  if (i.code !== 0) throw new HttpError(502, i.stderr.trim() || 'docker info failed');
  const d = JSON.parse(i.stdout);
  return {
    host: d.Name,
    serverVersion: d.ServerVersion,
    composeVersion: v.stdout.trim(),
    os: d.OperatingSystem,
    cpus: d.NCPU,
    mem: d.MemTotal,
  };
}

// ---------------------------------------------------------------- images

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
export function parseSize(s) {
  const m = String(s || '').trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/);
  return m ? Math.round(parseFloat(m[1]) * (UNITS[m[2].toUpperCase() || 'B'] || 1)) : 0;
}

let imageCache = { at: 0, data: null };
export function invalidateImages() {
  imageCache.at = 0;
}

// `docker images`, one entry per image ID with all of its tags.
export async function listImages() {
  if (imageCache.data && Date.now() - imageCache.at < 2000) return imageCache.data;
  // -a: untagged old versions (a tag that moved on after a pull) are hidden otherwise.
  const out = await runOk(['images', '--all', '--no-trunc', '--digests', '--format', '{{json .}}']);
  const byId = new Map();
  for (const r of jsonLines(out)) {
    let img = byId.get(r.ID);
    if (!img) {
      byId.set(r.ID, (img = { id: r.ID, tags: [], digests: [], size: parseSize(r.Size), created: r.CreatedAt, createdSince: r.CreatedSince }));
    }
    const repo = r.Repository && r.Repository !== '<none>' ? r.Repository : '';
    if (repo && r.Tag && r.Tag !== '<none>' && !img.tags.includes(`${repo}:${r.Tag}`)) img.tags.push(`${repo}:${r.Tag}`);
    if (repo && r.Digest && r.Digest !== '<none>' && !img.digests.includes(`${repo}@${r.Digest}`)) img.digests.push(`${repo}@${r.Digest}`);
  }
  imageCache = { at: Date.now(), data: [...byId.values()] };
  return imageCache.data;
}

// The exact image ID of each container: container ID -> image ID.
export async function containerImageIds(ids) {
  if (!ids.length) return new Map();
  const out = await runOk(['inspect', '--type', 'container', '--format', '{{.Id}} {{.Image}}', ...ids]);
  return new Map(out.split('\n').filter(Boolean).map((l) => l.trim().split(' ')));
}

export function attachImageUsage(images, containers, imageIds) {
  return images.map((img) => {
    const users = containers.filter((c) => imageIds.get(c.id) === img.id);
    return { ...img, containers: users.map((c) => ({ name: c.name, state: c.state, project: c.project, service: c.service })) };
  });
}

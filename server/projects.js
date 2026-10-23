// Compose project discovery and compose-file editing.
//
// Projects are discovered from what docker itself reports (`docker compose ls`
// and the compose labels on containers) plus an optional stacks directory.
// Projects that were seen once are remembered so a stack that was brought
// `down` from the CLI keeps its tab.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as docker from './docker.js';
import { HttpError } from './docker.js';

export const DATA_DIR = path.resolve(process.env.TACO_DATA_DIR || 'data');
// Fixed location: mount the host's stacks directory here.
export const STACKS_DIR = '/stacks';
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const KNOWN_FILE = path.join(DATA_DIR, 'known-projects.json');
const MAX_BACKUPS = 20;

let known = null;

async function loadKnown() {
  if (known) return known;
  try {
    known = JSON.parse(await fs.readFile(KNOWN_FILE, 'utf8'));
  } catch {
    known = {};
  }
  return known;
}

async function saveKnown(next) {
  if (JSON.stringify(next) === JSON.stringify(known)) return;
  known = next;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KNOWN_FILE, JSON.stringify(known, null, 2));
}

export const normalizeName = (s) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '');

async function composeNameFromFile(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const m = text.match(/^name:\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/m);
    return m ? normalizeName(m[1]) : '';
  } catch {
    return '';
  }
}

// Two layouts are supported side by side:
//   <dir>/<stack>/compose.yaml (+ <dir>/<stack>/.env, read by compose itself)
//   <dir>/<stack>.yaml          (+ <dir>/<stack>.env, passed with --env-file)
async function scanStacks() {
  let entries;
  try {
    entries = await fs.readdir(STACKS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && /\.ya?ml$/.test(e.name)) {
      const file = path.join(STACKS_DIR, e.name);
      const stem = e.name.replace(/\.ya?ml$/, '');
      const fallback = COMPOSE_NAMES.includes(e.name) ? path.basename(STACKS_DIR) : stem;
      const name = (await composeNameFromFile(file)) || normalizeName(fallback);
      if (name) out.push({ name, configFiles: [file], workingDir: STACKS_DIR, envFile: path.join(STACKS_DIR, `${stem}.env`) });
      continue;
    }
    if (!e.isDirectory()) continue;
    const dir = path.join(STACKS_DIR, e.name);
    const file = COMPOSE_NAMES.map((n) => path.join(dir, n)).find((f) => existsSync(f));
    if (!file) continue;
    const name = (await composeNameFromFile(file)) || normalizeName(e.name);
    if (name) out.push({ name, configFiles: [file], workingDir: dir });
  }
  return out;
}

let cache = { at: 0, data: null, inflight: null };

export function invalidate() {
  cache.at = 0;
}

async function buildOverview() {
  const [containers, ls, scanned, prev] = await Promise.all([
    docker.listContainers(),
    docker.composeLs().catch(() => []),
    scanStacks(),
    loadKnown(),
  ]);

  const map = new Map();
  const put = (name, configFiles, workingDir, envFile) => {
    let p = map.get(name);
    if (!p) map.set(name, (p = { name, configFiles: [], workingDir: '', envFile: '' }));
    if (configFiles?.length) {
      // A different set of compose files means the old env file no longer applies.
      if (p.configFiles.join('\n') !== configFiles.join('\n')) p.envFile = '';
      p.configFiles = configFiles;
    }
    if (workingDir) p.workingDir = workingDir;
    if (envFile) p.envFile = envFile;
  };
  const filesExist = (p) => p.configFiles.length > 0 && p.configFiles.every((f) => existsSync(f));
  for (const k of Object.values(prev)) put(k.name, k.configFiles, k.workingDir, k.envFile);
  for (const l of ls) put(l.name, l.configFiles);
  for (const c of containers) if (c.project) put(c.project, c.configFiles, c.workingDir);

  for (const s of scanned) {
    const owner = [...map.values()].find((p) => p.configFiles.includes(s.configFiles[0]));
    if (owner) {
      if (s.envFile) owner.envFile = s.envFile;
      continue;
    }
    // Compose identifies a project by name, so a same-named project started from
    // files elsewhere (another tool, a copy that was moved here) is taken over by
    // the file in the stacks dir: that is what the next `up` from taco will use.
    const existing = map.get(s.name);
    if (existing && filesExist(existing) && existing.configFiles.every((f) => f.startsWith(STACKS_DIR + path.sep))) continue;
    put(s.name, s.configFiles, s.workingDir, s.envFile);
  }

  const withContainers = new Set(containers.map((c) => c.project).filter(Boolean));
  const next = {};
  const projects = [];
  for (const p of map.values()) {
    const accessible = filesExist(p);
    // Forget projects that have neither containers nor a compose file anymore.
    if (!withContainers.has(p.name) && !accessible) continue;
    next[p.name] = p;
    projects.push({ ...p, filesAccessible: accessible });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  await saveKnown(next).catch(() => {});
  return { projects, containers };
}

export async function overview(maxAge = 0) {
  if (cache.data && Date.now() - cache.at <= maxAge) return cache.data;
  if (!cache.inflight) {
    cache.inflight = buildOverview()
      .then((data) => {
        cache = { at: Date.now(), data, inflight: null };
        return data;
      })
      .finally(() => {
        cache.inflight = null;
      });
  }
  return cache.inflight;
}

export async function getProject(name) {
  let p = (await overview(10_000)).projects.find((x) => x.name === name);
  if (!p) p = (await overview()).projects.find((x) => x.name === name);
  if (!p) throw new HttpError(404, `unknown project ${name}`);
  return p;
}

export const projectDir = (p) => p.workingDir || (p.configFiles[0] ? path.dirname(p.configFiles[0]) : '');

// Base args for `docker compose` targeting a project, optionally swapping one
// config file (or the env file) for another (used to validate unsaved edits).
export function composeArgs(p, swap) {
  const sw = (f) => (swap && swap.from === f ? swap.to : f);
  const args = ['compose', '-p', p.name];
  for (const f of p.configFiles) args.push('-f', sw(f));
  const dir = projectDir(p);
  if (dir && p.configFiles.length) args.push('--project-directory', dir);
  if (p.envFile && (existsSync(p.envFile) || swap?.from === p.envFile)) args.push('--env-file', sw(p.envFile));
  return args;
}

export async function services(p) {
  if (!p.filesAccessible) return { services: [], error: 'compose file is not accessible from taco' };
  const r = await docker.run([...composeArgs(p), 'config', '--format', 'json']);
  if (r.code !== 0) return { services: [], error: r.stderr.trim() };
  const cfg = JSON.parse(r.stdout);
  return {
    services: Object.entries(cfg.services || {}).map(([name, s]) => ({
      name,
      image: s.image || '',
      build: !!s.build,
      containerName: s.container_name || '',
    })),
  };
}

function editableFiles(p) {
  const files = p.configFiles.map((f) => ({ path: f, kind: 'compose' }));
  const dir = projectDir(p);
  if (p.envFile) files.push({ path: p.envFile, kind: 'env' });
  else if (dir) {
    const env = path.join(dir, '.env');
    if (!files.some((f) => f.path === env)) files.push({ path: env, kind: 'env' });
  }
  return files;
}

function resolveEditable(p, file) {
  const f = editableFiles(p).find((x) => x.path === file);
  if (!f) throw new HttpError(403, 'file is not part of this project');
  return f;
}

export async function listFiles(p) {
  return editableFiles(p).map((f) => ({ ...f, exists: existsSync(f.path) }));
}

export async function readFile(p, file) {
  resolveEditable(p, file);
  try {
    const [content, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { path: file, content, mtime: st.mtimeMs, exists: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { path: file, content: '', mtime: 0, exists: false };
    throw new HttpError(500, `cannot read ${file}: ${e.message}`);
  }
}

export async function validate(p, file, content) {
  const f = resolveEditable(p, file);
  // An env file is checked by interpolating the compose files with it (--env-file
  // also replaces compose's implicit .env lookup, so this works for both layouts).
  if (f.kind === 'env' && !p.filesAccessible) return { ok: true };
  const tmpDir = path.join(DATA_DIR, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${crypto.randomUUID()}-${path.basename(file)}`);
  try {
    await fs.writeFile(tmp, content);
    const target = f.kind === 'env' ? { ...p, envFile: file } : p;
    const r = await docker.run([...composeArgs(target, { from: file, to: tmp }), 'config', '-q']);
    if (r.code === 0) return { ok: true };
    return { ok: false, error: r.stderr.split(tmp).join(path.basename(file)).trim() || `invalid ${f.kind === 'env' ? 'env' : 'compose'} file` };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function backup(p, file) {
  if (!existsSync(file)) return;
  const dir = path.join(DATA_DIR, 'backups', p.name);
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.copyFile(file, path.join(dir, `${base}.${stamp}`));
  const old = (await fs.readdir(dir)).filter((n) => n.startsWith(`${base}.`)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) await fs.rm(path.join(dir, n), { force: true });
}

export async function writeFile(p, file, { content, mtime, force }) {
  if (typeof content !== 'string') throw new HttpError(400, 'content required');
  resolveEditable(p, file);
  const st = await fs.stat(file).catch(() => null);
  if (!force && st && mtime !== undefined && Math.abs(st.mtimeMs - mtime) > 1) {
    throw new HttpError(409, 'file was changed on disk since it was opened', { conflict: true });
  }
  if (!force) {
    const v = await validate(p, file, content);
    if (!v.ok) throw new HttpError(422, v.error, { validation: true });
  }
  await backup(p, file);
  // Write in place (no rename) so bind-mounted files and ownership survive.
  await fs.writeFile(file, content);
  if (!st) {
    const owner = await fs.stat(path.dirname(file));
    await fs.chown(file, owner.uid, owner.gid).catch(() => {});
  }
  invalidate();
  const after = await fs.stat(file);
  return { ok: true, mtime: after.mtimeMs };
}

const TEMPLATE = (name) => `name: ${name}

services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;

export async function createStack(name) {
  if (!existsSync(STACKS_DIR)) throw new HttpError(400, `${STACKS_DIR} does not exist (mount your stacks directory there)`);
  name = normalizeName(name || '');
  if (!name) throw new HttpError(400, 'invalid name (use a-z, 0-9, _ and -)');
  const file = path.join(STACKS_DIR, `${name}.yaml`);
  const taken = [file, path.join(STACKS_DIR, `${name}.yml`), path.join(STACKS_DIR, name)].find((f) => existsSync(f));
  if (taken) throw new HttpError(409, `${taken} already exists`);
  if ((await overview()).projects.some((p) => p.name === name)) throw new HttpError(409, `project ${name} already exists`);
  await fs.writeFile(file, TEMPLATE(name), { flag: 'wx' });
  // Hand new files to whoever owns the stacks dir (taco often runs as root).
  const owner = await fs.stat(STACKS_DIR);
  await fs.chown(file, owner.uid, owner.gid).catch(() => {});
  invalidate();
  const p = { name, configFiles: [file], workingDir: STACKS_DIR, envFile: path.join(STACKS_DIR, `${name}.env`) };
  await saveKnown({ ...(await loadKnown()), [name]: p });
  return p;
}

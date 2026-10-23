import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as docker from './docker.js';
import { HttpError, checkId } from './docker.js';
import * as projects from './projects.js';
import { attachShell } from './shell.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.TACO_PORT || process.env.PORT || 8080);
const HOST = process.env.TACO_HOST || '0.0.0.0';

const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};
// Browser-ready ES modules (CodeMirror, yaml) and fonts, served straight from
// node_modules under /npm/ and wired up with the import map in index.html.
const NPM_PACKAGES = [
  '@codemirror/', '@lezer/', '@marijn/find-cluster-break/', 'style-mod/', 'w3c-keyname/', 'crelt/', 'yaml/',
  '@fontsource-variable/inter/', '@fontsource-variable/jetbrains-mono/',
];
const NPM_EXT = new Set(['.js', '.css', '.woff2']);
const NODE_MODULES = path.join(ROOT, 'node_modules');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const CONTAINER_ACTIONS = {
  start: ['start'],
  stop: ['stop'],
  restart: ['restart'],
  kill: ['kill'],
  pause: ['pause'],
  unpause: ['unpause'],
  rm: ['rm'],
};

const PROJECT_ACTIONS = {
  up: [['up', '-d']],
  down: [['down']],
  stop: [['stop']],
  start: [['start']],
  restart: [['restart']],
  pull: [['pull']],
  'pull-up': [['pull'], ['up', '-d']],
  recreate: [['up', '-d', '--force-recreate']],
  build: [['up', '-d', '--build']],
  kill: [['kill']],
  rm: [['rm', '--stop', '--force']],
};

// ---------------------------------------------------------------- helpers

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const STREAM_HEADERS = { 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' };

// Pipe a long-running docker command (logs -f) to the response until the client goes away.
function streamText(res, args) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...STREAM_HEADERS });
  res.on('error', () => {});
  const p = docker.spawnDocker(args);
  p.stdout.pipe(res, { end: false });
  p.stderr.pipe(res, { end: false });
  p.on('error', (e) => res.end(`\n[taco] ${e.message}\n`));
  p.on('close', () => res.end());
  res.on('close', () => p.kill());
}

// Run one or more docker commands, streaming output as NDJSON. The commands keep
// running if the client disconnects: a half-finished `compose up` is worse than an unwatched one.
async function streamJob(res, steps, { keepGoing = false } = {}) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', ...STREAM_HEADERS });
  res.on('error', () => {});
  const send = (o) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n');
  };
  let code = 0;
  let failed = 0;
  for (const args of steps) {
    send({ t: 'cmd', d: `docker ${args.join(' ')}` });
    code = await new Promise((resolve) => {
      const p = docker.spawnDocker(args);
      for (const s of [p.stdout, p.stderr]) {
        const dec = new StringDecoder('utf8');
        s.on('data', (d) => send({ t: 'o', d: dec.write(d) }));
      }
      p.on('error', (e) => {
        send({ t: 'o', d: `${e.message}\n` });
        resolve(-1);
      });
      p.on('close', (c) => resolve(c ?? -1));
    });
    if (code !== 0) failed++;
    if (code !== 0 && !keepGoing) break;
  }
  projects.invalidate();
  docker.invalidateImages();
  send({ t: 'exit', code: failed ? code || 1 : 0 });
  res.end();
}

const tailArg = (q) => {
  const t = q.get('tail') || '200';
  return t === 'all' ? 'all' : String(Math.max(0, parseInt(t, 10) || 0));
};

// ---------------------------------------------------------------- routes

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/info', async () => ({
  ...(await docker.info()),
  stacksDir: fs.existsSync(projects.STACKS_DIR) ? projects.STACKS_DIR : '',
}));

route('GET', '/api/overview', () => projects.overview(1000));

route('GET', '/api/stats', () => docker.stats());

route('GET', '/api/containers/:id', async ({ params }) => {
  const out = await docker.runOk(['inspect', '--type', 'container', checkId(params.id)]);
  return JSON.parse(out)[0];
});

route('POST', '/api/containers/:id/:action', async ({ params, body }) => {
  const base = CONTAINER_ACTIONS[params.action];
  if (!base) throw new HttpError(400, 'unknown action');
  const args = [...base];
  if (params.action === 'rm' && body.force) args.push('-f');
  await docker.runOk([...args, checkId(params.id)]);
  projects.invalidate();
  return { ok: true };
});

route('GET', '/api/containers/:id/logs', ({ params, query, res }) => {
  const args = ['logs', '--timestamps', '--tail', tailArg(query)];
  if (query.get('follow') !== '0') args.push('--follow');
  streamText(res, [...args, checkId(params.id)]);
});

route('POST', '/api/stacks', async ({ body }) => projects.createStack(body.name));

// Images, with the containers (running or not) that use each one.
async function imagesWithUsage() {
  const [images, { containers }] = await Promise.all([docker.listImages(), projects.overview(3000)]);
  return docker.attachImageUsage(images, containers, await docker.containerImageIds(containers.map((c) => c.id)));
}

route('GET', '/api/images', async () => ({ images: await imagesWithUsage() }));

route('POST', '/api/images/rm', async ({ body, res }) => {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const all = await imagesWithUsage();
  const targets = ids.map((id) => all.find((i) => i.id === id));
  if (!targets.length || targets.some((t) => !t)) throw new HttpError(404, 'unknown image');
  const used = targets.filter((t) => t.containers.length);
  if (used.length) throw new HttpError(409, `in use by ${used[0].containers.map((c) => c.name).join(', ')}`);
  // Removing every tag removes the image; an untagged image goes by its ID.
  await streamJob(res, targets.map((t) => ['rmi', ...(t.tags.length > 1 ? t.tags : [t.id])]), { keepGoing: true });
});

route('POST', '/api/images/prune', async ({ res }) => {
  await streamJob(res, [['image', 'prune', '--all', '--force']]);
});

route('GET', '/api/projects/:name/services', async ({ params }) =>
  projects.services(await projects.getProject(params.name)),
);

route('GET', '/api/projects/:name/files', async ({ params }) =>
  projects.listFiles(await projects.getProject(params.name)),
);

route('GET', '/api/projects/:name/file', async ({ params, query }) =>
  projects.readFile(await projects.getProject(params.name), query.get('path')),
);

route('PUT', '/api/projects/:name/file', async ({ params, body }) =>
  projects.writeFile(await projects.getProject(params.name), body.path, body),
);

route('POST', '/api/projects/:name/validate', async ({ params, body }) =>
  projects.validate(await projects.getProject(params.name), body.path, body.content ?? ''),
);

route('POST', '/api/projects/:name/action/:action', async ({ params, body, res }) => {
  const p = await projects.getProject(params.name);
  const steps = PROJECT_ACTIONS[params.action];
  if (!steps) throw new HttpError(400, 'unknown action');
  const svcs = Array.isArray(body.services) ? body.services.filter((s) => /^[a-zA-Z0-9_.-]+$/.test(s)) : [];
  if (!p.filesAccessible && !['stop', 'start', 'restart', 'down', 'kill', 'rm'].includes(params.action)) {
    throw new HttpError(400, 'compose file is not accessible from taco');
  }
  await streamJob(res, steps.map((s) => [...projects.composeArgs(p), ...s, ...svcs]));
});

route('GET', '/api/projects/:name/logs', async ({ params, query, res }) => {
  const p = await projects.getProject(params.name);
  const args = [...projects.composeArgs(p), 'logs', '--timestamps', '--no-color', '--tail', tailArg(query)];
  if (query.get('follow') !== '0') args.push('--follow');
  const svc = query.get('service');
  if (svc && /^[a-zA-Z0-9_.-]+$/.test(svc)) args.push(svc);
  streamText(res, args);
});

// ---------------------------------------------------------------- server

function resolveNpm(pathname) {
  const rel = path.posix.normalize(pathname.slice('/npm/'.length));
  if (!NPM_PACKAGES.some((p) => rel.startsWith(p)) || !NPM_EXT.has(path.extname(rel))) return null;
  const file = path.join(NODE_MODULES, rel);
  return file.startsWith(NODE_MODULES + path.sep) ? file : null;
}

// Front-end assets are served under /v/<version>/ with a long cache lifetime,
// and index.html (never cached) points at the current version. A new build
// therefore can't mix freshly loaded modules with stale cached ones, whatever
// caches sit in between (browser, Cloudflare, …).
let assetVersion = { at: 0, v: '' };
function currentAssetVersion() {
  if (Date.now() - assetVersion.at < 2000) return assetVersion.v;
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const st = fs.statSync(f);
        h.update(`${f}:${st.size}:${st.mtimeMs}\n`);
      }
    }
  };
  walk(PUBLIC);
  for (const f of ['package-lock.json', 'package.json']) {
    const st = fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false });
    if (st) h.update(`${f}:${st.size}:${st.mtimeMs}\n`);
  }
  assetVersion = { at: Date.now(), v: h.digest('hex').slice(0, 10) };
  return assetVersion.v;
}

function serveIndex(req, res) {
  const v = currentAssetVersion();
  const html = fs
    .readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replaceAll('"/npm/', `"/v/${v}/npm/`)
    .replaceAll('"/style.css"', `"/v/${v}/style.css"`)
    .replaceAll('"/js/', `"/v/${v}/js/`);
  res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

function serveStatic(req, res, pathname) {
  let immutable = false;
  const vm = pathname.match(/^\/v\/[\w-]+(\/.*)$/);
  if (vm) {
    pathname = vm[1];
    immutable = true;
  }
  if (pathname === '/' || pathname === '/index.html' || (!path.extname(pathname) && !pathname.startsWith('/npm/'))) return serveIndex(req, res);
  if (pathname.startsWith('/npm/')) {
    const file = resolveNpm(pathname);
    if (!file) return json(res, 404, { error: 'not found' });
    return sendFile(req, res, file, immutable);
  }
  const file = VENDOR[pathname] ? path.join(ROOT, VENDOR[pathname]) : path.join(PUBLIC, path.normalize(pathname));
  if (!VENDOR[pathname] && !file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
  sendFile(req, res, file, immutable);
}

function sendFile(req, res, file, immutable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    const lastModified = new Date(Math.floor(st.mtimeMs / 1000) * 1000).toUTCString();
    const headers = {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'last-modified': lastModified,
    };
    if (!immutable && req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
      const out = await r.handler({ req, res, url, params, body, query: url.searchParams });
      if (out !== undefined && !res.headersSent) json(res, 200, out);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.message, ...e.extra });
      else res.end();
    }
    return;
  }
  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/api\/containers\/([^/]+)\/shell$/);
  let id;
  try {
    id = m && checkId(decodeURIComponent(m[1]));
  } catch {}
  if (!id) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const q = url.searchParams;
    const user = q.get('user') || '';
    attachShell(ws, { id, cols: q.get('cols'), rows: q.get('rows'), cmd: q.get('cmd') || '', user: /^[\w.:-]+$/.test(user) ? user : '' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`taco listening on http://${HOST}:${PORT}`);
  console.log(`  docker: ${docker.DOCKER_BIN}`);
  console.log(`  stacks: ${projects.STACKS_DIR}${fs.existsSync(projects.STACKS_DIR) ? '' : ' (missing, discovering from docker only)'}`);
  console.log(`  data:   ${projects.DATA_DIR}`);
});

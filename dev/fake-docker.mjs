#!/usr/bin/env node
// A tiny stand-in for the docker CLI, for developing taco without a Docker
// daemon. Implements just the subcommands taco uses, backed by a JSON state file.
//   TACO_DOCKER_BIN=$PWD/dev/fake-docker.mjs npm start
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STACKS = path.join(HERE, 'stacks');
const STATE_FILE = process.env.TACO_FAKE_STATE || '/tmp/taco-fake-docker.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const now = () => Date.now();

// ---------------------------------------------------------------- compose parsing (naive)
function parseCompose(file) {
  const text = fs.readFileSync(file, 'utf8');
  const services = {};
  let inServices = false;
  let cur = null;
  let inPorts = false;
  const nameM = text.match(/^name:\s*(\S+)/m);
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inServices = /^services:/.test(line);
      cur = null;
      continue;
    }
    if (!inServices) continue;
    let m;
    if ((m = line.match(/^ {2}([\w.-]+):\s*$/))) {
      cur = services[m[1]] = { image: '', ports: [], build: false };
      inPorts = false;
    } else if (cur && (m = line.match(/^ {4}image:\s*(\S+)/))) cur.image = m[1];
    else if (cur && /^ {4}build:/.test(line)) cur.build = true;
    else if (cur && /^ {4}ports:/.test(line)) inPorts = true;
    else if (cur && /^ {4}\S/.test(line)) inPorts = false;
    else if (cur && inPorts && (m = line.match(/^\s+-\s*"?(\d+):(\d+)"?/))) cur.ports.push({ host: m[1], container: m[2] });
  }
  return { name: nameM?.[1], services };
}

function validate(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('\t')) return `yaml: line ${i + 1}: found character that cannot start any token`;
    if (/^ +\S/.test(lines[i]) && lines[i].match(/^ */)[0].length % 2) return `yaml: line ${i + 1}: did not find expected key`;
  }
  if (!/^services:/m.test(text)) return 'no service selected';
  return null;
}

// ---------------------------------------------------------------- state
function mkContainer(project, service, def, file, state = 'running', extra = {}) {
  return {
    id: crypto.randomBytes(32).toString('hex'),
    name: project ? `${project}-${service}-1` : service,
    image: def.image || `${project}-${service}`,
    project,
    service,
    configFiles: file ? [file] : [],
    workingDir: file ? path.dirname(file) : '',
    ports: def.ports || [],
    state,
    exitCode: 0,
    health: '',
    created: now() - 86400e3 * 3,
    startedAt: now() - 3600e3 * (2 + Math.random() * 40),
    finishedAt: 0,
    ...extra,
  };
}

function seed() {
  const cs = [];
  const add = (dir, opts = {}) => {
    const file = path.join(STACKS, dir, 'compose.yaml');
    const c = parseCompose(file);
    const project = c.name || dir;
    for (const [svc, def] of Object.entries(c.services)) cs.push(mkContainer(project, svc, def, file, 'running', opts[svc] || {}));
  };
  add('media', { qbittorrent: { health: 'unhealthy' }, jellyfin: { health: 'healthy' } });
  add('monitoring', { grafana: { state: 'exited', exitCode: 1, finishedAt: now() - 600e3 } });
  add('web');
  cs.push(mkContainer('', 'watchtower', { image: 'containrrr/watchtower:latest' }, ''));
  cs.push(mkContainer('', 'old-redis', { image: 'redis:6', ports: [{ host: '6379', container: '6379' }] }, '', 'exited', { finishedAt: now() - 86400e3 * 9 }));
  return { containers: cs };
}

const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : seed();

// Images: everything the containers use, plus a few unused ones and a dangling layer.
const hex = () => crypto.randomBytes(32).toString('hex');
const mkImage = (ref, size, daysAgo) => {
  const [repo, tag] = ref ? (ref.includes(':') ? [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)] : [ref, 'latest']) : ['<none>', '<none>'];
  return { id: `sha256:${hex()}`, repo, tag, size, created: now() - daysAgo * 86400e3 };
};
function ensureImage(ref) {
  const r = ref.includes(':') ? ref : `${ref}:latest`;
  if (!state.images.some((i) => `${i.repo}:${i.tag}` === r)) state.images.push(mkImage(r, `${(50 + Math.random() * 900).toFixed(0)}MB`, 1 + Math.random() * 60));
}
if (!state.images) {
  state.images = [];
  for (const c of state.containers) ensureImage(c.image);
  state.images.push(mkImage('postgres:15', '412MB', 120), mkImage('node:20-alpine', '134MB', 40), mkImage('nginx:1.25-alpine', '43.2MB', 200), mkImage('', '1.21GB', 30), mkImage('', '88.4MB', 12));
}
// Volumes, with the containers that mount them (by name) and where.
const mkVolume = (name, size, mounts = [], project = '') => ({
  name,
  size,
  mounts,
  labels: !project ? (/^[0-9a-f]{64}$/.test(name) ? { 'com.docker.volume.anonymous': '' } : {}) : { 'com.docker.compose.project': project, 'com.docker.compose.volume': name.slice(project.length + 1) },
});
if (!state.volumes) {
  state.volumes = [
    mkVolume('media_jellyfin-config', '1.4GB', [['media-jellyfin-1', '/config']], 'media'),
    mkVolume(hex(), '6.2GB', [['media-jellyfin-1', '/cache']]),
    mkVolume('monitoring_prometheus-data', '3.1GB', [['monitoring-prometheus-1', '/prometheus']], 'monitoring'),
    mkVolume('monitoring_grafana-data', '48.2MB', [['monitoring-grafana-1', '/var/lib/grafana']], 'monitoring'),
    mkVolume('blog_db-data', '212MB', [['blog-db-1', '/var/lib/postgresql/data']], 'blog'),
    mkVolume('shared-certs', '24kB', [['blog-nginx-1', '/etc/ssl/private'], ['blog-app-1', '/certs'], ['monitoring-grafana-1', '/certs'], ['media-jellyfin-1', '/certs']]),
    mkVolume('redis-data', '18.4MB', [['old-redis', '/data']]),
    mkVolume('nextcloud_db', '2.3GB'),
    mkVolume(hex(), '840MB'),
    mkVolume(hex(), '0B'),
  ];
}
save();

const volumeMounts = (c) =>
  state.volumes.flatMap((v) => v.mounts.filter(([n]) => n === c.name).map(([, dest]) => ({ Type: 'volume', Name: v.name, Source: `/var/lib/docker/volumes/${v.name}/_data`, Destination: dest, Driver: 'local', RW: !dest.startsWith('/etc/'), Propagation: '' })));
const volumeUsers = (v) => v.mounts.filter(([n]) => state.containers.some((c) => c.name === n));

function find(ref) {
  const c = state.containers.find((x) => x.id.startsWith(ref) || x.name === ref);
  if (!c) {
    err(`Error response from daemon: No such container: ${ref}\n`);
    process.exit(1);
  }
  return c;
}

function human(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return 'Less than a second';
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  if (m === 1) return 'About a minute';
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60);
  if (h === 1) return 'About an hour';
  if (h < 48) return `${h} hours`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} days`;
  return `${Math.floor(d / 7)} weeks`;
}

function statusText(c) {
  if (c.state === 'running') return `Up ${human(now() - c.startedAt)}${c.health ? ` (${c.health})` : ''}`;
  if (c.state === 'paused') return `Up ${human(now() - c.startedAt)} (Paused)`;
  if (c.state === 'exited') return `Exited (${c.exitCode}) ${human(now() - c.finishedAt)} ago`;
  return 'Created';
}

const portsText = (c) =>
  c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/tcp, [::]:${p.host}->${p.container}/tcp`).join(', ');

// ---------------------------------------------------------------- log generator
const MSGS = [
  'GET /api/health 200 1.2ms',
  'GET / 200 12.4ms',
  'POST /api/login 401 3.1ms',
  '\x1b[32mINFO\x1b[0m worker heartbeat ok',
  '\x1b[33mWARN\x1b[0m slow query took 1532ms: SELECT * FROM items WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50',
  '\x1b[31mERROR\x1b[0m connection refused (retrying in 5s)',
  'cache hit ratio 0.93',
  'scheduled job "cleanup" finished in 210ms',
];
const logLine = (t) => `${new Date(t).toISOString().replace('Z', '000000Z')} ${MSGS[Math.floor(Math.random() * MSGS.length)]}\n`;

async function streamLogs(cs, tail, follow, prefix) {
  const n = tail === 'all' ? 300 : Number(tail);
  const width = Math.max(...cs.map((c) => `${c.service}-1`.length));
  const pre = (c) => (prefix ? `${`${c.service}-1`.padEnd(width)}  | ` : '');
  for (let i = n; i > 0; i--) {
    const c = cs[i % cs.length];
    out(pre(c) + logLine(now() - i * 2000));
  }
  if (!follow) return;
  for (;;) {
    await sleep(400 + Math.random() * 1500);
    const live = cs.filter((c) => c.state === 'running');
    if (!live.length) continue;
    const c = live[Math.floor(Math.random() * live.length)];
    out(pre(c) + logLine(now()));
  }
}

// ---------------------------------------------------------------- commands
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function compose(args) {
  let project, dir;
  const files = [];
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === '-p') project = args[++i];
    else if (args[i] === '-f') files.push(args[++i]);
    else if (args[i] === '--project-directory') dir = args[++i];
    else if (args[i] === '--env-file') i++;
    else break;
  }
  const [cmd, ...rest] = args.slice(i);
  if (cmd === 'version') return out('2.31.0\n');
  if (cmd === 'ls') {
    const byP = {};
    for (const c of state.containers) if (c.project) (byP[c.project] ||= []).push(c);
    return out(JSON.stringify(Object.entries(byP).map(([Name, cs]) => {
      const counts = {};
      for (const c of cs) counts[c.state] = (counts[c.state] || 0) + 1;
      return { Name, Status: Object.entries(counts).map(([k, v]) => `${k}(${v})`).join(', '), ConfigFiles: cs[0].configFiles.join(',') };
    })) + '\n');
  }
  const file = files[0];
  const def = file && fs.existsSync(file) ? parseCompose(file) : { services: {} };
  const svcArgs = rest.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a) && a !== 'json');
  const mine = () => state.containers.filter((c) => c.project === project && (!svcArgs.length || svcArgs.includes(c.service)));
  const line = async (s) => {
    err(s + '\n');
    await sleep(250);
  };

  switch (cmd) {
    case 'config': {
      for (const f of files) {
        const e = validate(f);
        if (e) {
          err(`${f}: ${e}\n`);
          process.exit(15);
        }
      }
      if (rest.includes('-q')) return;
      return out(JSON.stringify({ name: project, services: def.services }) + '\n');
    }
    case 'up': {
      const e = file && validate(file);
      if (e) {
        err(`${file}: ${e}\n`);
        process.exit(15);
      }
      const names = svcArgs.length ? svcArgs : Object.keys(def.services);
      await line(`[+] Running ${names.length}/${names.length}`);
      for (const svc of names) {
        let c = state.containers.find((x) => x.project === project && x.service === svc);
        const recreate = rest.includes('--force-recreate') || rest.includes('--build');
        if (c && recreate) {
          state.containers = state.containers.filter((x) => x !== c);
          c = null;
        }
        if (!c) {
          ensureImage((def.services[svc] || {}).image || `${project}-${svc}`);
          await line(` ✔ Container ${project}-${svc}-1  Created`);
          state.containers.push((c = mkContainer(project, svc, def.services[svc] || {}, file, 'created', { startedAt: now(), created: now() })));
        }
        if (c.state !== 'running') {
          c.state = 'running';
          c.startedAt = now();
          await line(` ✔ Container ${c.name}  Started`);
        } else await line(` ✔ Container ${c.name}  Running`);
      }
      // Containers for services no longer in the file are orphans; keep them like docker does.
      break;
    }
    case 'down':
      for (const c of mine()) {
        await line(` ✔ Container ${c.name}  Removed`);
        state.containers = state.containers.filter((x) => x !== c);
      }
      await line(` ✔ Network ${project}_default  Removed`);
      break;
    case 'rm':
      for (const c of mine()) {
        if (c.state === 'running') {
          Object.assign(c, { state: 'exited', exitCode: 0, finishedAt: now() });
          await line(` ✔ Container ${c.name}  Stopped`);
        }
        await line(` ✔ Container ${c.name}  Removed`);
        state.containers = state.containers.filter((x) => x !== c);
      }
      break;
    case 'kill':
      for (const c of mine()) {
        Object.assign(c, { state: 'exited', exitCode: 137, finishedAt: now() });
        await line(` ✔ Container ${c.name}  Killed`);
      }
      break;
    case 'stop':
    case 'start':
    case 'restart':
      for (const c of mine()) {
        if (cmd !== 'start') Object.assign(c, { state: 'exited', exitCode: 0, finishedAt: now() });
        if (cmd !== 'stop') Object.assign(c, { state: 'running', startedAt: now() });
        await line(` ✔ Container ${c.name}  ${cmd === 'stop' ? 'Stopped' : cmd === 'start' ? 'Started' : 'Restarted'}`);
      }
      break;
    case 'pull':
      for (const svc of svcArgs.length ? svcArgs : Object.keys(def.services)) {
        await line(` ${svc} Pulling`);
        await sleep(400);
        await line(` ✔ ${svc} Pulled`);
      }
      break;
    case 'logs':
      save();
      return streamLogs(mine(), flag('--tail') || 'all', rest.includes('--follow'), true);
    default:
      err(`fake docker: unsupported compose command ${cmd}\n`);
      process.exit(1);
  }
  save();
}

async function main() {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'compose':
      return compose(rest);
    case 'info':
      return out(JSON.stringify({ Name: 'fakehost', ServerVersion: '28.0.1', OperatingSystem: 'Debian GNU/Linux 12 (fake)', NCPU: 8, MemTotal: 16e9 }) + '\n');
    case 'ps':
      for (const c of state.containers) {
        out(JSON.stringify({
          id: c.id, name: c.name, image: c.image, state: c.state, status: statusText(c), ports: c.state === 'running' ? portsText(c) : '',
          created: new Date(c.created).toISOString(), project: c.project, service: c.service, number: c.project ? '1' : '', oneoff: c.project ? 'False' : '',
          configFiles: c.configFiles.join(','), workingDir: c.workingDir,
        }) + '\n');
      }
      return;
    case 'images':
      for (const i of state.images) {
        out(JSON.stringify({
          Containers: 'N/A', CreatedAt: new Date(i.created).toISOString().replace('T', ' ').replace(/\..*/, ' +0000 UTC'),
          CreatedSince: `${human(now() - i.created)} ago`, Digest: i.repo === '<none>' ? '<none>' : `sha256:${i.id.slice(7, 71).split('').reverse().join('')}`,
          ID: i.id, Repository: i.repo, SharedSize: 'N/A', Size: i.size, Tag: i.tag, UniqueSize: 'N/A', VirtualSize: i.size,
        }) + '\n');
      }
      return;
    case 'rmi': {
      for (const ref of rest.filter((a) => !a.startsWith('-'))) {
        const img = state.images.find((i) => i.id === ref || `${i.repo}:${i.tag}` === ref);
        if (!img) {
          err(`Error response from daemon: No such image: ${ref}\n`);
          process.exit(1);
        }
        const users = state.containers.filter((c) => c.image === `${img.repo}:${img.tag}` || (img.tag === 'latest' && c.image === img.repo));
        if (users.length) {
          err(`Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container ${users[0].id.slice(0, 12)} is using its referenced image ${img.id.slice(7, 19)}\n`);
          process.exit(1);
        }
        await sleep(300);
        state.images = state.images.filter((i) => i !== img);
        if (img.repo !== '<none>') out(`Untagged: ${img.repo}:${img.tag}\n`);
        out(`Deleted: ${img.id}\n`);
      }
      save();
      return;
    }
    case 'image': {
      if (rest[0] !== 'prune') break;
      const used = new Set(state.containers.map((c) => (c.image.includes(':') ? c.image : `${c.image}:latest`)));
      const gone = state.images.filter((i) => !used.has(`${i.repo}:${i.tag}`));
      for (const i of gone) {
        await sleep(150);
        if (i.repo !== '<none>') out(`untagged: ${i.repo}:${i.tag}\n`);
        out(`deleted: ${i.id}\n`);
      }
      state.images = state.images.filter((i) => !gone.includes(i));
      save();
      out(`\nTotal reclaimed space: ${gone.length ? '1.9GB' : '0B'}\n`);
      return;
    }
    case 'system': {
      // Only `system df -v --format '{{json .Volumes}}'`.
      if (rest[0] !== 'df') break;
      const labels = (v) => Object.entries(v.labels).map(([k, x]) => `${k}=${x}`).join(',');
      return out(JSON.stringify(state.volumes.map((v) => ({
        Availability: 'N/A', Driver: 'local', Group: 'N/A', Labels: labels(v), Links: String(volumeUsers(v).length),
        Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Name: v.name, Scope: 'local', Size: v.size, Status: 'N/A',
      }))) + '\n');
    }
    case 'volume': {
      if (rest[0] === 'rm') {
        for (const name of rest.slice(1).filter((a) => !a.startsWith('-'))) {
          const v = state.volumes.find((x) => x.name === name);
          if (!v) {
            err(`Error response from daemon: get ${name}: no such volume\n`);
            process.exit(1);
          }
          if (volumeUsers(v).length) {
            err(`Error response from daemon: remove ${name}: volume is in use - [${volumeUsers(v).map(([n]) => find(n).id).join(', ')}]\n`);
            process.exit(1);
          }
          await sleep(300);
          state.volumes = state.volumes.filter((x) => x !== v);
          out(`${name}\n`);
        }
        save();
        return;
      }
      if (rest[0] === 'prune') {
        // Like docker >= 23: without --all only anonymous volumes go.
        const all = rest.includes('--all') || rest.includes('-a');
        const gone = state.volumes.filter((v) => !volumeUsers(v).length && (all || 'com.docker.volume.anonymous' in v.labels));
        if (gone.length) out('Deleted Volumes:\n');
        for (const v of gone) {
          await sleep(150);
          out(`${v.name}\n`);
        }
        state.volumes = state.volumes.filter((v) => !gone.includes(v));
        save();
        out(`\nTotal reclaimed space: ${gone.length ? '840MB' : '0B'}\n`);
        return;
      }
      break;
    }
    case 'stats':
      for (const c of state.containers.filter((x) => x.state === 'running')) {
        out(JSON.stringify({ ID: c.id, Name: c.name, CPUPerc: `${(Math.random() * 8).toFixed(2)}%`, MemUsage: `${(20 + Math.random() * 400).toFixed(1)}MiB / 15.5GiB`, MemPerc: '1.2%', NetIO: '1.2MB / 800kB', BlockIO: '20MB / 4MB', PIDs: '12' }) + '\n');
      }
      return;
    case 'inspect': {
      const fi = rest.indexOf('--format');
      if (fi >= 0 && rest[fi + 1].includes('.Mounts')) {
        // --format '{{.Id}} {{json .Mounts}}' <ids…>
        for (const ref of rest.slice(fi + 2)) {
          const c = find(ref);
          out(`${c.id} ${JSON.stringify([{ Type: 'bind', Source: '/srv/data/' + c.service, Destination: '/config', RW: true }, ...volumeMounts(c)])}\n`);
        }
        return;
      }
      if (fi >= 0) {
        // Only the form taco uses: --format '{{.Id}} {{.Image}}' <ids…>
        for (const ref of rest.slice(fi + 2)) {
          const c = find(ref);
          const r = c.image.includes(':') ? c.image : `${c.image}:latest`;
          out(`${c.id} ${state.images.find((i) => `${i.repo}:${i.tag}` === r)?.id || ''}\n`);
        }
        return;
      }
      const c = find(rest[rest.length - 1]);
      return out(JSON.stringify([{
        Id: c.id, Name: '/' + c.name, Created: new Date(c.created).toISOString(), Path: '/init', Args: ['--config', '/config'],
        State: { Status: c.state, Running: c.state === 'running', Paused: c.state === 'paused', ExitCode: c.exitCode, StartedAt: new Date(c.startedAt).toISOString(), FinishedAt: c.finishedAt ? new Date(c.finishedAt).toISOString() : '0001-01-01T00:00:00Z', ...(c.health ? { Health: { Status: c.health } } : {}) },
        RestartCount: 0,
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
        Config: { Image: c.image, User: '', WorkingDir: '/app', Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin', 'TZ=Europe/Brussels', 'PUID=1000'], Cmd: ['--config', '/config'], Entrypoint: ['/init'], Labels: c.project ? { 'com.docker.compose.project': c.project, 'com.docker.compose.service': c.service } : {} },
        Mounts: [{ Type: 'bind', Source: '/srv/data/' + c.service, Destination: '/config', RW: true }, ...volumeMounts(c)],
        NetworkSettings: { Ports: Object.fromEntries(c.ports.map((p) => [`${p.container}/tcp`, [{ HostIp: '0.0.0.0', HostPort: p.host }]])), Networks: { [`${c.project || 'bridge'}_default`]: { IPAddress: '172.18.0.' + (2 + (parseInt(c.id.slice(0, 2), 16) % 200)) } } },
      }]) + '\n');
    }
    case 'logs': {
      const c = find(rest[rest.length - 1]);
      return streamLogs([c], flag('--tail') || 'all', rest.includes('--follow'), false);
    }
    case 'start':
    case 'stop':
    case 'restart':
    case 'kill':
    case 'pause':
    case 'unpause':
    case 'rm': {
      const c = find(rest[rest.length - 1]);
      await sleep(cmd === 'stop' || cmd === 'restart' ? 700 : 200);
      if (cmd === 'rm') {
        if (c.state === 'running' && !rest.includes('-f')) {
          err(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove\n`);
          process.exit(1);
        }
        state.containers = state.containers.filter((x) => x !== c);
      } else if (cmd === 'stop' || cmd === 'kill') Object.assign(c, { state: 'exited', exitCode: cmd === 'kill' ? 137 : 0, finishedAt: now() });
      else if (cmd === 'pause') c.state = 'paused';
      else if (cmd === 'unpause') c.state = 'running';
      else Object.assign(c, { state: 'running', startedAt: now() });
      save();
      return out(rest[rest.length - 1] + '\n');
    }
    case 'exec': {
      // docker exec -it [-e X] [-u U] <id> cmd...
      let i = 0;
      while (rest[i]?.startsWith('-')) i += ['-e', '-u', '-w'].includes(rest[i]) ? 2 : 1;
      const c = find(rest[i]);
      if (c.state !== 'running') {
        err(`Error response from daemon: container ${c.id} is not running\n`);
        process.exit(1);
      }
      const p = spawn(rest[i + 1], rest.slice(i + 2), { stdio: 'inherit', cwd: '/tmp', env: { ...process.env, PS1: `root@${c.id.slice(0, 12)}:\\w# `, HOSTNAME: c.id.slice(0, 12) } });
      p.on('close', (code) => process.exit(code ?? 0));
      return;
    }
    default:
      err(`fake docker: unsupported command ${cmd}\n`);
      process.exit(1);
  }
}

await main();

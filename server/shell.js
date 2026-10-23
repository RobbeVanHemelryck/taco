// Interactive `docker exec -it` sessions over a WebSocket.
//
// `docker exec -it` needs a real TTY, so it runs under util-linux `script`,
// which allocates a pty without needing native node modules. The wrapper
// prints the pty path first so it can be resized later with `stty -F`.
import { spawn, execFile } from 'node:child_process';
import { DOCKER_BIN } from './docker.js';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, Math.round(+n))) : d);
const AUTO_SHELL = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';

export function attachShell(ws, { id, cols, rows, cmd, user }) {
  cols = clamp(cols, 10, 500, 80);
  rows = clamp(rows, 5, 300, 24);
  const execArgs = ['exec', '-it', '-e', 'TERM=xterm-256color'];
  if (user) execArgs.push('-u', user);
  execArgs.push(id, 'sh', '-c', cmd || AUTO_SHELL);
  const inner = `tty; stty cols ${cols} rows ${rows}; exec ${[DOCKER_BIN, ...execArgs].map(q).join(' ')}`;
  const p = spawn('script', ['-qfc', inner, '/dev/null'], { env: { ...process.env, SHELL: '/bin/sh' } });

  let pts = null;
  let head = '';
  const send = (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };

  p.stdout.on('data', (chunk) => {
    if (pts === null) {
      head += chunk.toString('latin1');
      const i = head.indexOf('\n');
      if (i < 0) return;
      pts = head.slice(0, i).trim();
      const rest = Buffer.from(head.slice(i + 1), 'latin1');
      if (rest.length) send(rest);
      return;
    }
    send(chunk);
  });
  p.stderr.on('data', (chunk) => send(chunk));
  p.stdin.on('error', () => {});
  p.on('error', (err) => {
    send(JSON.stringify({ t: 'error', message: err.message }));
    ws.close();
  });
  p.on('close', (code) => {
    send(JSON.stringify({ t: 'exit', code }));
    ws.close();
  });

  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.t === 'i' && typeof m.d === 'string') p.stdin.write(m.d);
    else if (m.t === 'r' && pts?.startsWith('/dev/')) {
      execFile('stty', ['-F', pts, 'cols', String(clamp(m.cols, 10, 500, cols)), 'rows', String(clamp(m.rows, 5, 300, rows))], () => {});
    }
  });
  ws.on('close', () => p.kill('SIGHUP'));
}

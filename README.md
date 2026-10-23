<img src="assets/icon.svg" width="64" height="64" alt="">

# taco

A small, mobile-first web client for Docker Compose hosts.

taco is **just a client of the `docker` CLI**. It has no database of containers and
no ownership over anything: every list it shows comes from `docker ps` /
`docker compose ls`, and every button runs the same `docker` / `docker compose`
command you would type yourself. Manage stacks from your shell, from taco, or
both. They never disagree.

## Features

- **Wide screens**: compose projects in a navigation panel on the left, their
  containers in the middle, and logs / shell / info / the compose editor in a
  resizable panel on the right that stays open while you browse other stacks.
- **Phones**: one tab per compose project, plus *All* and *Standalone*
  (non-compose containers), in a bottom bar within thumb reach; swipe
  left/right to move between them, or tap ⊞ to jump/search. Views open full screen.
- Compact rows: service, status/uptime, health, image, published ports
  (tap to open), CPU and memory, and every container action inline.
- Services defined in the compose file but not created yet are shown too.
- **Lifecycle**: per stack: up, pull & up, build & up, recreate, restart, start,
  stop, down. Per container: start, stop, restart, pause, kill, remove, plus
  recreate / pull & recreate for its service. Compose output streams live.
- **Logs**: follow, filter, wrap, timestamps, tail size; per container or whole stack.
- **Shell**: a real TTY (`docker exec -it`, bash if available, else sh) in
  xterm.js, with a key bar (Ctrl, Esc, Tab, arrows, ^C…) and a command line +
  history for phone keyboards.
- **Compose editor** for the compose file and `.env`: auto-indent, indent and
  comment buttons, validation with `docker compose config` before saving,
  "save & up", refusal to overwrite a file changed on disk since it was opened,
  and a backup of the last 20 versions of each file in the data dir. A
  variables panel matches the compose file against its env file: every
  `${VAR}` with its value, default, or *missing*; and in the env file, which
  variables are unused. Tap one to jump to it.
- Inspect view: ports, networks, mounts, env, labels.
- No auth, by design. **Only expose it on a trusted network** (LAN, VPN,
  Tailscale…): it is equivalent to root on the host.

## How projects are discovered

1. `docker compose ls -a` and the `com.docker.compose.*` labels on containers
   (projects started from anywhere on the host, including your shell).
2. The stacks directory, always `/stacks` (skipped if it doesn't exist), in either
   layout (they can be mixed):
   - flat files: every `<dir>/<stack>.yaml` (or `.yml`), with `<dir>/<stack>.env`
     as its env file, passed with `--env-file`. "New stack" creates these.
   - folders: every `<dir>/<stack>/compose.yaml` (or `compose.yml` /
     `docker-compose.y(a)ml`), with compose's usual `<dir>/<stack>/.env`.

   The project name is the file's top-level `name:`, else the file/folder name.
   These show up even when never started, and a stacks-dir file takes over a
   same-named project that was started from files elsewhere (e.g. by Portainer).
3. Projects seen once are remembered, so a stack you `down` keeps its tab as
   long as its compose file exists.

Stack commands run as `docker compose -p <name> -f <files…> --project-directory <dir> [--env-file <env>]`,
using the same files and directory compose recorded, so they match what you run by hand.

## Run

### Directly on the host (simplest: paths just work)

```sh
npm ci --omit=dev
npm start      # http://<host>:8080, stacks are read from /stacks
```

Needs Node ≥ 20, the docker CLI with the compose plugin, and `script` (util-linux) for shells.

### In a container

```sh
docker compose up -d --build
```

See `compose.yaml`. The Docker socket is mounted, and the host's stacks directory
is mounted at **`/stacks`**. Bind mounts in your compose files should use
absolute host paths: a relative `./data` would resolve to `/stacks/data`, which
the Docker daemon looks up on the host. Compose files outside mounted
paths are still listed and controllable (start/stop/restart/down), but can't
be edited or brought up.

### Configuration

| env               | default   | meaning                                          |
| ----------------- | --------- | ------------------------------------------------ |
| `TACO_PORT`       | `8080`    | listen port                                      |
| `TACO_HOST`       | `0.0.0.0` | listen address                                   |
| `TACO_DATA_DIR`   | `./data`  | remembered projects + compose file backups       |
| `TACO_DOCKER_BIN` | `docker`  | docker binary to run                             |

## Development

`npm run dev` runs taco against `dev/fake-docker.mjs`, a stand-in for the docker
CLI with sample stacks in `dev/stacks`, so the UI can be worked on without a
Docker daemon. (State lives in `/tmp/taco-fake-docker.json`; delete it to reset.)

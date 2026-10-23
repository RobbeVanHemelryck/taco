<img src="assets/icon.svg" width="64" height="64" alt="">

# taco

**TA**ltiko **CO**ntainers. That's where the name comes from.

A small, mobile-first web client for Docker Compose hosts. It just drives the
`docker` CLI: no database, no lock-in. Manage stacks from your shell, from taco, or both.

<img src="assets/screenshot-desktop.png" alt="taco on a desktop: stacks, containers and live logs">

<img src="assets/screenshot-mobile.png" width="300" alt="taco on a phone">

## Run

```sh
docker compose up -d --build   # http://<host>:8080
```

Mount your stacks directory at `/stacks` (see `compose.yaml`).

> There is no auth, by design. It's root on the host, so only expose it on a trusted network.

# DevRoulette

Chatroulette for devs waiting on Claude Code. A long-running task **opens** a chat
and pairs you with a random dev who's also around. From there it's yours — chat as
long as you like, `/skip` for a new dev, `/quit` to close. It's a terminal chat
(and a VS Code sidebar — see `vscode/`).

Anonymous. No accounts. No names you pick. **Chat not logged.**

**18+ only** — you're chatting with random, anonymous strangers, at your own risk.
By using DevRoulette you agree to the [Terms & Privacy](https://devroulette.github.io/DevRoulette/legal.html).

*Not using Claude Code? Open a chat anytime, in any terminal, with `devroulette start`.*

---

## Install (30 seconds)

```bash
npm i -g devroulette-cli
devroulette init
```

That's it. When a Claude Code task runs longer than 30 seconds, DevRoulette quietly
looks for another dev who's also around — **in the background, with no window**. A
chat window only pops the instant you're actually matched. If nobody's around before
your task ends, nothing ever opened and you never saw a thing — you only see the app
when it's working. There's **one window per machine**; a later task won't stack a
second one.

The task is just the **trigger**: once the window is open the chat is yours and is
**not tied to the task** — it stays until *you* leave. `/skip` for a new dev,
`/report` to flag + skip, `/insights` for room stats, `/quit` to close. Partner
leaves → you're matched with someone new. Closed it? Start another long task to
reopen.

`devroulette init` merges two hooks into `~/.claude/settings.json`
(`UserPromptSubmit` + `Stop`). It **backs the file up first** and **never touches
your existing hooks**. Remove them anytime with `devroulette uninstall`.

---

## Run your own server (full VPS deploy)

The matchmaking server is stateless and tiny — a $5 VPS is plenty. It listens on
plain `ws://` bound to localhost; **Caddy terminates TLS** in front of it so clients
connect over `wss://`.

### 1. Build & place the server

```bash
git clone <this repo> /opt/devroulette && cd /opt/devroulette
npm ci
# transpile or run with tsx; example uses tsx:
```

### 2. Run as a non-root user via systemd

Create a dedicated user and a unit file at `/etc/systemd/system/devroulette.service`:

```ini
[Unit]
Description=DevRoulette matchmaking server
After=network.target

[Service]
Type=simple
User=devroulette
Group=devroulette
WorkingDirectory=/opt/devroulette
Environment=HOST=127.0.0.1
Environment=PORT=8787
# Trusted reverse-proxy hops in front of the server. Caddy-only = 1. If a CDN /
# platform edge (Cloudflare, Railway, Fly…) also sits in front, set the TOTAL hop
# count (e.g. 2). Per-IP limits and bans key on the resulting client IP — leave it
# at the default 0 and they key on the proxy's IP (everyone shares one bucket).
Environment=TRUSTED_PROXY_HOPS=1
ExecStart=/usr/bin/npx tsx server/src/index.ts
Restart=always
RestartSec=2
# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin devroulette
sudo systemctl daemon-reload
sudo systemctl enable --now devroulette
```

### 3. Auto-TLS with Caddy

`/etc/caddy/Caddyfile`:

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy fetches and renews the certificate automatically and proxies the WebSocket
upgrade. It appends the real client IP to `X-Forwarded-For`; the server reads the
trusted hop from the **right** (never the spoofable leftmost value) per
`TRUSTED_PROXY_HOPS`. Set Caddy's [`trusted_proxies`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#trusted_proxies)
so the forwarded header is sanitised, and make sure `TRUSTED_PROXY_HOPS` matches
your real proxy depth.

> **Never expose the server without a proxy.** It binds `127.0.0.1` by default and
> the `npm start` script no longer forces `0.0.0.0`. With `TRUSTED_PROXY_HOPS=0`
> (the default) it trusts only the direct socket peer, so per-IP limits stay sound
> even if someone points it straight at the internet — but TLS and real
> rate-limiting still belong in a proxy in front.

Clients then use:

```bash
DEVROULETTE_URL=wss://chat.example.com devroulette init
```

(A bare `devroulette init` bakes the public production server by default. Pass a
URL — `devroulette init ws://127.0.0.1:8787` — or set `DEVROULETTE_URL` to point at
your own server / local dev.)

---

## Develop

```bash
npm install
npm run typecheck   # tsc (server+shared) + tsc (cli/jsx)
npm run lint        # eslint
npm test            # integration tests
npm run server      # run the server locally on :8787
npm run devroulette -- --debug   # join manually (testing only)
```

---

## Threat model — what is and isn't protected

**Protected**

- **Terminal injection.** All inbound text is stripped of ANSI escape sequences and
  C0/C1 control characters **server-side before relay and again client-side before
  render**. Received text is rendered as plain text only — no markdown, no clickable
  links, no emoji-shortcode expansion. Received content is never written to disk and
  never executed.
- **Spam / flooding.** Per-socket 1 msg/sec, 500 chars/msg, 200 msgs/room, 16 KB
  frame cap, min 0.5s between skips. Per-IP (keyed on the real client IP via
  `TRUSTED_PROXY_HOPS`): max 3 concurrent sockets, max 5 queue-joins/min, repeated
  violations → 15-minute in-memory temp-ban (counter resets when a ban is issued).
  A global socket ceiling (`MAX_TOTAL_SOCKETS`) bounds total load regardless of IP.
- **Queue eclipse.** Each session/match-key may hold only ONE queue slot, so an
  attacker can't park a cluster of same-key sockets to capture every real joiner.
- **Coerced bans.** A `report` removes the reporter from the room but **never**
  bans the partner — anonymous, spoofable reports must not drive bans.
- **Malformed input.** Every inbound frame is validated against a strict zod schema;
  anything else is dropped and counts as a violation.
- **Persistence leaks.** Zero persistence: no database, message content is never
  logged, rooms live only in memory and are destroyed on disconnect / `task_done` /
  10-min idle.
- **Resource exhaustion.** Heartbeat ping/pong kills dead sockets within ~30s.
- **Bots / connect-spam.** Every socket must solve a small sha256 proof-of-work
  (~16 leading zero bits) before it can join the queue — silent and instant for a
  real client, but it puts a CPU cost on mass automated connects. A socket that
  never solves the challenge is dropped after `POW_DEADLINE_MS` (10s) instead of
  squatting. Per-IP socket and rate limits still apply on top.
- **Liveness / task gate.** A client only counts as "waiting" while its Claude Code
  task transcript keeps growing. The client checks the transcript by **file size /
  mtime only — it never opens, reads, or transmits the file**, so no code or prompt
  data leaves the machine. It emits a heartbeat while the task is live; the server
  ejects any connection that misses ~2 beats. No live task = no entry, no staying.
- **Debug lockout.** The hidden manual-join mode only activates locally with
  `DEVROULETTE_DEV=1`, and the **server rejects debug connections outright** unless
  the operator sets `DEVROULETTE_ALLOW_DEBUG=1`. Production keeps it off.
- **Hook safety.** The installer backs up `settings.json`, never clobbers existing
  hooks, parses hook JSON in Node (never interpolated into a shell command). The npm
  package has no postinstall scripts and pinned dependencies.
- **Zero AI/API calls.** The app never calls any model or API — it has no HTTP
  client at all. Its only network egress is the WebSocket to the matchmaking server.
  It cannot touch your Claude quota.

**NOT protected (by design / out of scope)**

- **Social engineering.** A human partner can still type a phishing link or lie. We
  render it inert (not clickable) but cannot stop a person from being malicious.
- **Anonymity vs. the server operator.** The server sees IP addresses in memory (used
  for rate-limiting) and could be modified to log them. Run your own if that matters.
  The per-session match key is a salted sha256 of the Claude session id (not the raw
  id), so the operator can't tie it back to your on-disk transcript filename — but a
  hostile operator still sees your IP and the plaintext it relays.
- **Entry gating is best-effort.** Public entry requires the hook trigger plus a live,
  growing task transcript (the liveness gate). This strongly biases the queue toward
  people genuinely waiting — but it watches fs metadata, so a determined user could
  forge a growing file. It is **not** a cryptographic proof of a task.
- **No end-to-end encryption.** TLS protects transport to the server; the server
  relays plaintext in memory. Not for sensitive content.
- **DoS.** Per-IP limits raise the cost of abuse but a distributed flood can still
  exhaust a $5 VPS. Put Cloudflare / a real rate-limiter in front for production.

---

## Legal

DevRoulette is **18+ only** and provided **as-is, with no warranty**. You chat with
random anonymous strangers; we're not responsible for what other users say or do.
Messages are never stored or logged; the server processes IP addresses in memory
only, for rate-limiting and bans. Full terms and the privacy disclosure:

**[Terms & Privacy](https://devroulette.github.io/DevRoulette/legal.html)**

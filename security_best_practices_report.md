# DevRoulette Audit

Executive summary: the core relay is small and mostly careful: zod validation on client frames, server-side and client-side terminal sanitization, PoW, per-IP limits, one-time resume tokens, and no message-content logging. After clarification that non-Claude/manual users are intentional for bootstrapping the network, I do not see a critical blocker. The main launch work is aligning the public copy/threat model with the actual product, plus a few hardening and release-hygiene fixes.

## Product / Positioning

### DR-001: README threat model says task-gated, code is task-triggered/manual-friendly

- Severity: Medium
- Location: `cli/src/client.ts` `Client.startHeartbeats()` lines 118-131; `cli/src/liveness.ts` lines 58-72; `server/src/index.ts` liveness sweep lines 898-909
- Evidence: `Client.startHeartbeats()` calls `startLiveness({ alwaysAlive: true, ... })` for every connection, so `startLiveness()` always emits heartbeats without checking transcript size/mtime.
- Impact: not a security bug if manual/non-Claude users are intended. It is a trust/copy issue: the README currently promises a stronger "live Claude task only" gate than the app enforces.
- Fix: update README, legal/product copy, and server comments to say "Claude Code can trigger it automatically; manual devs can also join." Remove claims that transcript growth is the production gate.
- Mitigation: keep PoW, rate limits, report flow, and global socket limits as the real abuse controls.

### DR-002: Manual entry should be explicit, not accidental

- Severity: Low
- Location: `cli/src/cli.ts` lines 20-23 and 41-55; `cli/src/tui.tsx` lines 130-133; `vscode/src/extension.ts` lines 52-58; `vscode/README.md` lines 34-37
- Evidence: `devroulette start` is publicly documented in CLI help and the VS Code sidebar has a `Connect` button using `{ manual: true }`; neither sends the debug header the server rejects.
- Impact: acceptable if it is the product strategy. The only risk is user confusion if marketing implies everyone is waiting on a Claude task.
- Fix: keep `devroulette start`, but make README/help text honest: "Use it standalone, or auto-open from Claude Code."
- Mitigation: if the pool gets low-quality traffic later, add a server-side flag or separate queue for hook-triggered users.

## Medium

### DR-003: Server frame validation is missing on the client

- Severity: Medium
- Location: `cli/src/client.ts` lines 134-185
- Evidence: inbound JSON is cast directly to `ServerFrame`; fields are not schema-validated before calls like `sanitize(frame.body)`.
- Impact: a hostile or compromised server, or a user-configured custom server, can crash clients with malformed frames or send very large valid-looking payloads. TLS protects the default server path, but custom server support makes this a real boundary.
- Fix: define and use a zod `ServerFrame` schema, set a client `maxPayload`, and drop malformed/oversized server frames.
- Mitigation: keep string sanitization, but first verify field types and lengths.

### DR-004: Admin block/unblock actions are GET links with Basic Auth

- Severity: Medium
- Location: `server/src/index.ts` dashboard links lines 595-601; action handler lines 708-711
- Evidence: state-changing moderation actions are normal `<a href="/admin/block?ip=...">` GET requests.
- Impact: if an operator has cached Basic Auth credentials, a cross-site page can try to trigger block/unblock requests. The attacker still needs a target IP, but the action is unsafe by HTTP semantics.
- Fix: make block/unblock POST-only and require a CSRF token or at least a custom header plus `Sec-Fetch-Site` checks.
- Mitigation: separate the dashboard onto a private/admin-only origin or VPN.

### DR-005: Admin dashboard lacks basic hardening headers

- Severity: Medium
- Location: `server/src/index.ts` lines 696-705 and 719-728
- Evidence: `/admin/reports` returns only `content-type`; no `cache-control: no-store`, CSP, frame protection, referrer policy, or `X-Content-Type-Options`.
- Impact: report pages contain IP-based moderation data and should not be cached/framed. The inline script also has no CSP defense if future dashboard content regresses escaping.
- Fix: add `Cache-Control: no-store`, `Content-Security-Policy`, `X-Frame-Options` or `frame-ancestors`, `Referrer-Policy`, and `X-Content-Type-Options: nosniff` to admin responses.
- Mitigation: verify equivalent headers at the reverse proxy if not set in app code.

### DR-006: Docker runtime image includes dev tooling

- Severity: Medium
- Location: `Dockerfile` lines 6-12
- Evidence: `npm ci` installs all dependencies including devDependencies, builds, then runs the server from the same image.
- Impact: deployment carries unnecessary build tools and vulnerable dev dependencies. Root `npm audit` currently flags `esbuild` through dev tooling, even though production dependencies are clean.
- Fix: use a multi-stage Dockerfile: build with dev deps, then copy `dist`, `package.json`, `package-lock.json`, and install runtime deps with `npm ci --omit=dev`.
- Mitigation: keep Railway/server runtime isolated and patched until the image is slimmed.

### DR-007: VS Code build toolchain has a high advisory

- Severity: Medium
- Location: `vscode/package.json` line 47; `vscode/package-lock.json` lines 17 and 25
- Evidence: `esbuild` is pinned at `^0.21.0` / locked to `0.21.5`; `npm audit` reports GHSA-gv7w-rqvm-qjhr.
- Impact: not a chat runtime vulnerability, but it affects extension packaging/build environments.
- Fix: upgrade `esbuild` to a fixed version and rebuild the VS Code lockfile.
- Mitigation: avoid building the extension in untrusted registry/env contexts until upgraded.

## Low

### DR-008: Root package lock version is stale

- Severity: Low
- Location: `package.json` line 3; `package-lock.json` lines 2-9
- Evidence: `package.json` says `0.1.25`; `package-lock.json` still says `0.1.5`.
- Impact: release review and reproducibility are confusing; stale metadata can hide accidental dependency drift.
- Fix: refresh the lockfile with the current package metadata.

### DR-009: Local ignored scratch helper breaks lint

- Severity: Low
- Location: ignored `hold-window.ts` line 27; `eslint.config.js` lines 4-6; `.gitignore` line 23
- Evidence: `npm run lint` fails because ESLint scans ignored scratch files and reports an unused `client`.
- Impact: local validation fails even though the npm tarball dry-run excludes this file.
- Fix: remove the scratch file, move it under a clearly ignored directory, or add the scratch patterns to ESLint ignores.

### DR-010: CLI state directory validation is inconsistent

- Severity: Low
- Location: `hook-runner.ts` `ensureState()` lines 25-55; `cli/src/cli.ts` lines 88-111
- Evidence: the hook runner validates `/tmp/devroulette` ownership, symlink status, and permissions; the visible CLI path directly creates/uses the same directory.
- Impact: mostly local DoS/pid-file confusion on shared temp-dir systems. The hook path is safer than the manual/window path.
- Fix: share `ensureState()` / `trustedFile()` with `cli.ts` before reading or writing `hub.pid`.

### DR-011: Hook install shell quoting is partially robust

- Severity: Low
- Location: `cli/src/install.ts` lines 29-34 and 74-77
- Evidence: server URL is single-quoted, but `node` and `runner` use a double-quote helper that only checks whitespace and does not escape all shell metacharacters.
- Impact: unusual install paths can break hook execution; hostile local paths could produce shell confusion.
- Fix: use the existing `shSingleQuote()` helper for all shell-interpolated command segments.

## Verification

- `npm run typecheck`: pass
- `npm test`: pass, 11/11
- `npm run build`: pass
- `npm pack --dry-run`: pass; package contains only README, package.json, built CLI, hook runner, liveness, TUI, and shared protocol
- `npm audit --omit=dev` at root: pass, 0 vulnerabilities
- `npm audit` at root: 1 high via dev `esbuild`
- `cd vscode && npm run typecheck`: pass
- `cd vscode && npm audit --omit=dev`: pass, 0 vulnerabilities
- `cd vscode && npm audit`: 1 high via dev `esbuild`
- `npm run lint`: fail because ignored local `hold-window.ts` is still linted

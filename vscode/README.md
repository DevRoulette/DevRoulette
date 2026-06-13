# DevRoulette for VS Code

Chat with a random dev while your Claude Code task runs — in a **docked sidebar**,
not a popup terminal. Anonymous, nothing is logged, 18+.

Connects to the same matchmaking server as the CLI and reuses the exact same
protocol + client (proof-of-work, heartbeat, matchmaking, sanitized relay).

## Develop / run

```bash
cd vscode
npm install
npm run build      # esbuild → dist/extension.js
npm run typecheck
```

Then press **F5** in VS Code to launch an Extension Development Host. Open the
**DevRoulette** icon in the activity bar → the chat panel appears → **Connect**.

Run two Extension Dev Hosts (or one host + the CLI) to chat between them.

## Package

```bash
npm run package    # → devroulette-vscode-*.vsix  (needs `npm i -g @vscode/vsce`)
```
Install the `.vsix` via Extensions → … → *Install from VSIX*.

## Settings

- `devroulette.serverUrl` — matchmaking server (default `wss://devroulette-production.up.railway.app`).

## Status

Phases 1–4 (scaffold, chat UI, host↔webview WS bridge, manual connect/skip/end)
are implemented. Phase 5 (auto-trigger from a live Claude task) is next.

[Terms & Privacy](https://devroulette.github.io/DevRoulette/legal.html)

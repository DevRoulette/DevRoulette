import * as vscode from "vscode";
import { Client, type ClientEvent } from "../../cli/src/client.js";

/**
 * DevRoulette sidebar. The WS connection (PoW, heartbeat, matchmaking, relay) runs
 * here in the extension host using the SAME Client as the CLI; the webview is just
 * the UI. Host ⇄ webview talk over postMessage.
 */
class ChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "devroulette.chat";
  private view?: vscode.WebviewView;
  private client: Client | null = null;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg: { t?: string; body?: string }) => this.onMessage(msg));
    view.onDidDispose(() => {
      this.client?.quit();
      this.client = null;
    });
  }

  private post(e: ClientEvent): void {
    void this.view?.webview.postMessage(e);
  }

  private onMessage(msg: { t?: string; body?: string }): void {
    switch (msg?.t) {
      case "connect":
        this.connect();
        break;
      case "send":
        if (typeof msg.body === "string") this.client?.sendMsg(msg.body);
        break;
      case "skip":
        this.client?.skip();
        break;
      case "report":
        this.client?.report();
        this.client?.skip();
        break;
      case "end":
        this.client?.quit();
        this.client = null;
        this.post({ t: "closed" });
        break;
    }
  }

  private connect(): void {
    const url =
      vscode.workspace.getConfiguration("devroulette").get<string>("serverUrl") ??
      "wss://devroulette-production.up.railway.app";
    this.client?.quit();
    // manual mode → the client heartbeats on its own (no Claude task needed here).
    this.client = new Client(url, (e: ClientEvent) => this.post(e), { manual: true });
  }

  private html(): string {
    const nonce = String(Math.random()).slice(2) + String(Math.random()).slice(2);
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return WEBVIEW_HTML.replace(/%%CSP%%/g, csp).replace(/%%NONCE%%/g, nonce);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatProvider.viewType, new ChatProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond the per-view dispose */
}

// ---------------------------------------------------------------------------
// Webview UI — a clean chat panel themed with VS Code variables. All inbound text
// is already sanitized by the Client; we still set it via textContent (never
// innerHTML) so nothing can inject markup.
// ---------------------------------------------------------------------------
const WEBVIEW_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="%%CSP%%" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: var(--vscode-sideBar-background, transparent);
  }
  header {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25));
  }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
  header .dot.on { background: #3fb950; }
  header .who { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header .online { color: var(--vscode-descriptionForeground); font-size: .85em; }
  header button {
    border: none; border-radius: 5px; padding: 3px 9px; font-size: .85em; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.18));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  header button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }
  #log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; }
  .row.you { justify-content: flex-end; }
  .bubble {
    max-width: 82%; padding: 6px 10px; border-radius: 12px; line-height: 1.4; word-wrap: break-word; white-space: pre-wrap;
  }
  .you .bubble { background: var(--vscode-button-background, #2f6feb); color: var(--vscode-button-foreground, #fff); border-bottom-right-radius: 4px; }
  .them .bubble { background: var(--vscode-input-background, rgba(127,127,127,.15)); border-bottom-left-radius: 4px; }
  .them .name { font-size: .78em; font-weight: 600; color: var(--vscode-textLink-foreground); margin: 0 0 2px 4px; }
  .sys { align-self: center; text-align: center; color: var(--vscode-descriptionForeground); font-size: .85em; padding: 2px 8px; }
  footer { padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); }
  .ad { font-size: .82em; margin-bottom: 6px; }
  .ad a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .ad a:hover { text-decoration: underline; }
  .composer { display: flex; gap: 6px; }
  #input {
    flex: 1; border: 1px solid var(--vscode-input-border, rgba(127,127,127,.4)); border-radius: 6px; padding: 6px 9px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit; outline: none;
  }
  #input:focus { border-color: var(--vscode-focusBorder); }
  #send { border: none; border-radius: 6px; padding: 0 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); }
  .big { border: none; border-radius: 7px; padding: 8px 18px; cursor: pointer; font-size: 1em; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .big:hover { background: var(--vscode-button-hoverBackground); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <header hidden id="bar">
    <span class="dot" id="dot"></span>
    <span class="who" id="who">finding a dev…</span>
    <span class="online" id="online"></span>
    <button id="skip" title="Find a new dev" hidden>Skip</button>
    <button id="end" title="End chat" hidden>End</button>
  </header>

  <div class="center" id="welcome">
    <div style="font-size:1.3em;font-weight:600;color:var(--vscode-foreground)">DevRoulette</div>
    <div>Chat with a random dev. Anonymous, chat not logged. 18+.</div>
    <button class="big" id="connect">Connect</button>
  </div>

  <div id="log" hidden></div>

  <footer hidden id="foot">
    <div class="ad" id="ad"></div>
    <div class="composer">
      <input id="input" type="text" placeholder="Type a message…" maxlength="500" autocomplete="off" />
      <button id="send">Send</button>
    </div>
  </footer>

<script nonce="%%NONCE%%">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const bar = $("bar"), welcome = $("welcome"), log = $("log"), foot = $("foot");
  const who = $("who"), online = $("online"), dot = $("dot"), adEl = $("ad");
  const input = $("input"), skipBtn = $("skip"), endBtn = $("end");
  let partner = "";

  function setState(s) {
    // s: "idle" | "waiting" | "chatting" | "ended"
    welcome.hidden = s !== "idle";
    bar.hidden = s === "idle";
    log.hidden = s === "idle";
    foot.hidden = s === "idle" || s === "ended";
    skipBtn.hidden = s !== "chatting";
    endBtn.hidden = s !== "chatting" && s !== "waiting";
    dot.className = "dot" + (s === "chatting" ? " on" : "");
    if (s === "waiting") who.textContent = "finding a dev…";
    if (s === "ended") who.textContent = "chat ended";
    if (s === "chatting") who.textContent = partner || "matched";
    if (s === "ended") { renderEnded(); }
  }

  function sys(text) { const d = document.createElement("div"); d.className = "sys"; d.textContent = text; log.appendChild(d); scroll(); }
  function bubble(kind, name, body) {
    const row = document.createElement("div"); row.className = "row " + kind;
    const wrap = document.createElement("div");
    if (kind === "them" && name) { const n = document.createElement("div"); n.className = "name"; n.textContent = name; wrap.appendChild(n); }
    const b = document.createElement("div"); b.className = "bubble"; b.textContent = body; wrap.appendChild(b);
    row.appendChild(wrap); log.appendChild(row); scroll();
  }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function clearLog() { log.innerHTML = ""; }

  function setAd(ad) {
    adEl.innerHTML = "";
    const a = document.createElement("a");
    if (ad && ad.text) { a.textContent = ad.text; if (ad.url) { a.href = ad.url; } }
    else { a.textContent = '"Your Ad Here" — advertise: github.com/DevRoulette/ads'; a.href = "https://devroulette.github.io/ads"; }
    adEl.appendChild(a);
  }
  setAd(null);

  function renderEnded() {
    clearLog();
    sys("Chat ended.");
    const r = document.createElement("div"); r.className = "row"; r.style.justifyContent = "center"; r.style.marginTop = "8px";
    const b = document.createElement("button"); b.className = "big"; b.textContent = "Find a new dev";
    b.addEventListener("click", () => { setState("waiting"); clearLog(); vscode.postMessage({ t: "connect" }); });
    r.appendChild(b); log.appendChild(r);
  }

  $("connect").addEventListener("click", () => { setState("waiting"); vscode.postMessage({ t: "connect" }); });
  skipBtn.addEventListener("click", () => { setState("waiting"); clearLog(); vscode.postMessage({ t: "skip" }); });
  endBtn.addEventListener("click", () => { vscode.postMessage({ t: "end" }); });
  $("send").addEventListener("click", sendMsg);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendMsg(); } });
  function sendMsg() {
    const v = input.value.trim(); if (!v) return; input.value = "";
    bubble("you", "you", v); vscode.postMessage({ t: "send", body: v });
  }

  window.addEventListener("message", (ev) => {
    const e = ev.data || {};
    switch (e.t) {
      case "queued": setState("waiting"); break;
      case "online": online.textContent = e.count > 0 ? ("● " + e.count + " online") : ""; if (e.ad) setAd(e.ad); break;
      case "matched":
        partner = e.partner || "a dev"; if (e.ad) setAd(e.ad);
        setState("chatting"); clearLog(); sys("Matched with " + partner + ". Be decent — Chat not logged.");
        sys("⚠ Reminder: avoid clicking links you don't trust.");
        input.focus();
        break;
      case "msg": bubble("them", e.from || partner, e.body); break;
      case "partner_left": sys("Partner left — finding you a new dev…"); partner = ""; setState("waiting"); vscode.postMessage({ t: "skip" }); break;
      case "task_done": sys("The other dev left — finding you a new dev…"); partner = ""; setState("waiting"); vscode.postMessage({ t: "skip" }); break;
      case "error": sys("! " + (e.msg || "error")); break;
      case "banned": sys("You've been temporarily blocked (too many messages). Try later."); setState("ended"); break;
      case "closed": setState("ended"); break;
    }
  });
</script>
</body>
</html>`;

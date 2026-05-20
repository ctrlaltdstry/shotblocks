// Bridge between the React UI and the C++ plugin.
//
// Inbound (C++ → JS): C++ calls htmlView->PostWebMessage(jsonString).
// We listen on window.chrome.webview's 'message' event and dispatch
// parsed messages to registered subscribers.
//
// Outbound (JS → C++): the C++ plugin runs an HTTP server on
// 127.0.0.1:<port> (port announced via the inbound 'hello' message).
// We POST JSON to /cmd and parse the JSON response. See the memory
// `v2-js-to-cpp-via-loopback-http` for why this is the only working
// channel — Maxon's SetWebMessageCallback and
// SetResourceRequestInterceptCallback are both broken in C4D 2026.

export interface OmItem {
  type: number;
  name: string;
  hasAnim: boolean;
  inFrame?: number;
  outFrame?: number;
  /** Session-unique id assigned by C++ on drop FINISH; 0 on hover.
   *  JS stores this on the created Clip and includes it in
   *  set-active-camera so C++ can resolve back to the source
   *  BaseObject. */
  objectId?: number;
}

export type HostInbound =
  | { kind: 'hello'; port: number }
  | { kind: 'tick'; frame: number; fps: number; playing: boolean }
  | { kind: 'doc-info'; fps: number; docFrames: number; playRangeIn: number; playRangeOut: number }
  | { kind: 'om-hover';  viewportX: number; viewportY: number; items: OmItem[] }
  | { kind: 'om-drop';   viewportX: number; viewportY: number; items: OmItem[] }
  | { kind: 'om-cancel' }
  | { kind: 'file-hover'; viewportX: number; viewportY: number; path: string }
  | { kind: 'file-drop';  viewportX: number; viewportY: number; path: string }
  | { kind: 'file-cancel' }
  | { kind: 'state-changed' };

export type HostOutbound =
  | { kind: 'ping'; t: number }
  | { kind: 'seek'; frame: number }
  | { kind: 'tool'; id: string }
  | { kind: 'set-active-camera'; objectId: number }
  | { kind: 'save-state'; json: string; objectIds: number[] }
  | { kind: 'load-state' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'toggle-play' }
  | { kind: 'audio-add'; clipId: number; bytes: string }
  | { kind: 'audio-fetch'; clipId: number }
  | { kind: 'audio-remove'; clipId: number }
  | { kind: 'set-play-range'; inFrame: number; outFrame: number }
  | { kind: 'set-loop'; enabled: boolean }
  | { kind: 'set-cursor-mode'; mode: 'slip' | 'razor' | 'select' | 'av-split' | 'roll' | 'play-range' | 'default' };

type Listener = (msg: HostInbound) => void;

let hostPort = 0;
const pendingSends: Array<{ obj: HostOutbound; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
const listeners = new Set<Listener>();
let inited = false;

function doFetch(obj: HostOutbound): Promise<unknown> {
  // text/plain is a CORS "simple request" so the browser skips the
  // OPTIONS preflight. C++ parses the body as JSON regardless of
  // Content-Type.
  return fetch(`http://127.0.0.1:${hostPort}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(obj),
  })
    .then(r => r.text())
    .then(t => {
      try { return JSON.parse(t); }
      catch { return { raw: t }; }
    });
}

function flushPending() {
  while (pendingSends.length) {
    const item = pendingSends.shift()!;
    doFetch(item.obj).then(item.resolve, item.reject);
  }
}

/** Send a command to C++. Resolves with the parsed JSON response. */
export function send(obj: HostOutbound): Promise<unknown> {
  if (hostPort) return doFetch(obj);
  return new Promise((resolve, reject) => {
    pendingSends.push({ obj, resolve, reject });
  });
}

/** Subscribe to inbound messages. Returns an unsubscribe function. */
export function onMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Initialize the bridge. Idempotent — safe to call multiple times. */
export function init(): void {
  if (inited) return;
  inited = true;
  const webview = (window as unknown as {
    chrome?: { webview?: { addEventListener?: (event: string, handler: (ev: MessageEvent<string>) => void) => void } };
  }).chrome?.webview;
  if (!webview?.addEventListener) {
    console.warn('[host] window.chrome.webview not available — bridge inert');
    return;
  }
  webview.addEventListener('message', (ev: MessageEvent<string>) => {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
    let msg: HostInbound;
    try { msg = JSON.parse(raw) as HostInbound; }
    catch { console.warn('[host] non-JSON inbound:', raw); return; }

    if (msg.kind === 'hello') {
      hostPort = msg.port;
      flushPending();
      // Round-trip ping so C++ knows we're listening; C++ replies with
      // doc-info + tick to bootstrap our state.
      send({ kind: 'ping', t: Date.now() }).catch(() => {});
    }
    for (const l of listeners) l(msg);
  });
}

export function hasHost(): boolean { return hostPort !== 0; }

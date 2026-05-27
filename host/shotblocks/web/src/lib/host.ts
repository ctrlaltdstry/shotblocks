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

/** One row in the inbound `cameras` payload. C++ posts this after
 *  every EVMSG_CHANGE so JS can flag orphan clips (alive === false)
 *  and pick up live camera renames (`name`). One entry per objectId
 *  in C++'s _cameraLinks. */
export interface CameraStatus {
  id: number;
  alive: boolean;
  name: string;
}

export type HostInbound =
  | { kind: 'hello'; port: number }
  | { kind: 'tick'; frame: number; fps: number; playing: boolean; pluginPlaying: boolean }
  | { kind: 'doc-info'; fps: number; docFrames: number; playRangeIn: number; playRangeOut: number }
  | { kind: 'om-hover';  viewportX: number; viewportY: number; items: OmItem[] }
  | { kind: 'om-drop';   viewportX: number; viewportY: number; items: OmItem[] }
  | { kind: 'om-cancel' }
  | { kind: 'file-hover'; viewportX: number; viewportY: number; path: string }
  | { kind: 'file-drop';  viewportX: number; viewportY: number; path: string }
  | { kind: 'file-cancel' }
  | { kind: 'state-changed' }
  | { kind: 'cameras'; items: CameraStatus[] }
  // Master Render Settings has drifted (stale=true) or come back into
  // sync (stale=false) with the snapshot taken at the last
  // Add-to-Queue / Sync. Inspector lights the Sync button on stale.
  | { kind: 'render-settings-drift'; stale: boolean };

export type HostOutbound =
  | { kind: 'ping'; t: number }
  | { kind: 'seek'; frame: number }
  | { kind: 'scrub-begin' }
  | { kind: 'scrub-end' }
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
  | { kind: 'set-cursor-mode'; mode: 'slip' | 'razor' | 'pen' | 'select' | 'av-split' | 'roll' | 'play-range' | 'hand' | 'hand-grab' | 'zoom' | 'default' }
  | { kind: 'sync-render-settings' }
  | { kind: 'add-to-queue'; mode: 'whole-sequence' }
  | { kind: 'add-to-queue';
      mode: 'individual-shots';
      // Document-order list of non-orphan video clips to render. C++
      // filters orphans (objectId not in _cameraLinks / link resolves
      // null) defensively; JS pre-filters by skipping objectId === 0.
      shots: { clipId: number; name: string; inFrame: number; outFrame: number; objectId: number }[];
    }
  // Settings → Defaults → camera-type dropdown. JS asks at Settings
  // panel open; C++ walks the known camera plugin IDs (Ocamera 5103,
  // Orscamera 1057516, …) and returns the ones that resolve, with
  // their localized labels. See plan-4 R1.
  | { kind: 'get-camera-types' }
  // Add Camera button (plan-4 commit 2). C++ allocates a camera of
  // typeId, copies the editor camera's pose + lens, inserts in OM at
  // top, selects it. Ack carries { objectId, typeId, name } — JS uses
  // those to addClip at the playhead. typeId in the ack reflects what
  // was actually used (may differ from request if the requested type
  // is no longer loaded; C++ falls back to Standard).
  | { kind: 'create-camera'; typeId: number }
  // Selection-follows-playhead (plan-4 commit 5). JS fires on scrub-
  // end / playback-stop AND document.hasFocus(). C++ resolves the
  // objectId to a live BaseObject and calls SetActiveObject so the
  // camera appears in OM + AM. objectId=0 is a no-op (used for gap +
  // orphan cases; the OM selection is left untouched, not cleared).
  | { kind: 'select-in-om'; objectId: number }
  // Plan 4.1 commit 2 — push the per-boundary camera event list to
  // C++, which rebuilds the hidden Stage helper's animation track.
  // Events are sorted by frame, deduplicated (no consecutive entries
  // with the same objectId). objectId === 0 = gap (no camera). C++
  // translates each event into a STEP CKey on STAGEOBJECT_CLINK.
  | { kind: 'set-stage-cameras'; events: { frame: number; objectId: number }[] };

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

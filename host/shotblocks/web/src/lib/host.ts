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
  // Deduped, sorted DOCUMENT frames where this camera (or any of its
  // tags) has a keyframe. Drives the read-only keyframe-tick strip on
  // the clip. Capped C++-side (~200); absent on older payloads. Same
  // frame origin as clip in/out, so the renderer clips to the window.
  keyTimes?: number[];
}

export type HostInbound =
  | { kind: 'hello'; port: number }
  | { kind: 'tick'; frame: number; fps: number; playing: boolean; pluginPlaying: boolean }
  // docMin/docMax are absolute document frame bounds (docMin can be
  // negative — v2 mirrors C4D's ruler). docFrames is the span, kept for
  // back-compat with length-based callers. (project_v2_absolute_frame_coords)
  | { kind: 'doc-info'; fps: number; docMin: number; docMax: number; docFrames: number; playRangeIn: number; playRangeOut: number }
  // C4D's native loop button changed (C4D -> ShotBlocks sync). C++
  // polls IsCommandChecked(12427) in its Timer and posts this only on
  // change. JS mirrors it into the store's loopEnabled; it must NOT
  // re-send set-loop or the two sides ping-pong.
  | { kind: 'loop-state'; enabled: boolean }
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
  | { kind: 'save-state'; json: string; objectIds: number[]; removeAudioMedia?: number[];
      // Per-clip-move camera keyframe shifts, applied by C++ inside the
      // save-state undo block so a clip move + its keyframe shift are one
      // Ctrl+Z. refCount guards shared cameras (C++ skips when >1).
      keyframeShifts?: { objectId: number; deltaFrames: number; refCount: number }[];
      // Per-clip Alt-edge-drag camera keyframe retimes — rescale the keys
      // around the non-moving anchor edge so the motion fills the clip's
      // new duration. Applied by C++ in the SAME save-state undo block as
      // the trim (one Ctrl+Z). All frame counts are integers; C++ rounds
      // each rescaled key to a whole frame. refCount guards shared cameras.
      keyframeRetimes?: { objectId: number; anchorFrame: number; oldDur: number; newDur: number; refCount: number }[];
      // Keyframe-dot deletes — remove every key at `frame` on the camera +
      // tags (a dot is a deduped column). Applied by C++ in the same undo
      // block. refCount guards shared cameras (C++ skips when >1).
      keyframeDeletes?: { objectId: number; frame: number; refCount: number }[];
      // Keyframe-dot drags — move every key at `frame` by `deltaFrames`
      // (the dragged column lands on a new frame). Same in-block undo +
      // shared-camera guard.
      keyframeColumnShifts?: { objectId: number; frame: number; deltaFrames: number; refCount: number }[] }
  | { kind: 'load-state' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'toggle-play' }
  // Open the bundled user manual (docs/index.html next to the plugin
  // DLL) in the OS default browser. C++ resolves the plugin folder and
  // ShellExecutes the HTML. Fire-and-forget; the ack is ignored.
  | { kind: 'open-manual' }
  | { kind: 'audio-add'; clipId: number; bytes: string }
  | { kind: 'audio-fetch'; clipId: number }
  | { kind: 'set-play-range'; inFrame: number; outFrame: number }
  // Grow the document length so Add Camera can place a full-length camera
  // at the tail when the targeted track is full (instead of a 1-frame
  // sliver). C++ calls SetMaxTime (not undoable) and re-broadcasts
  // doc-info. See useAddCamera.
  | { kind: 'set-doc-frames'; frames: number }
  | { kind: 'set-loop'; enabled: boolean }
  | { kind: 'warp-cursor'; x: number; y: number }
  | { kind: 'set-cursor-mode'; mode: 'slip' | 'razor' | 'pen' | 'select' | 'av-split' | 'roll' | 'retime' | 'play-range' | 'hand' | 'hand-grab' | 'zoom' | 'default' }
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
  // Dope-sheet key-highlight sync, driven by the timeline's CLIP
  // selection (not the playhead). objectId>0 highlights that camera's
  // keys in the Timeline/dope sheet; objectId=0 clears the highlight
  // (empty selection / gap / non-camera clip). Does not touch OM/AM.
  | { kind: 'sync-dope-keys'; objectId: number }
  // Rename a clip's source camera in the C4D Object Manager (the
  // editable clip title). C++ resolves objectId via _cameraLinks,
  // SetName under undo, then re-pushes `cameras` so the live name echoes
  // back to every clip + the Inspector.
  | { kind: 'rename-camera'; objectId: number; name: string }
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

// Scrub seek with IN-FLIGHT COALESCING. A scrub fires a seek per pointer-
// move; each seek round-trips to C++ where it does a synchronous DrawViews
// (slow). Firing a fetch per move floods the browser's per-origin
// connection pool — the requests QUEUE IN CHROMIUM, each carrying a now-
// stale frame, and C++ drains them one-at-a-time (the [SB/drain] log showed
// queueAfter=0 always: C++ was starved, the backlog lived in the browser).
// The viewport + C4D timeline then ran frames behind and "caught up" on
// release as the queue flushed.
//
// Fix: keep at most ONE seek in flight. While one is pending, just record
// the latest target frame; when it resolves, fire the newest pending frame
// (if it changed). A fast drag collapses to "send current → await → send
// newest", never a backlog — always the current cursor position. Standard
// scrub-over-a-request-channel pattern.
let seekInFlight = false;
let seekPending: number | null = null;
let lastSeekStartMs = 0;
let seekPaceTimer: ReturnType<typeof setTimeout> | null = null;
// Minimum wall-clock spacing between seek STARTS — a steady cadence floor.
// Measured (2026-06-03): the C++ per-frame DrawViews cost is direction-
// dependent in C4D itself — forward scrub is a steady ~49ms, reverse is
// mostly ~10ms with occasional 40-90ms spikes. Firing the next seek the
// instant the previous resolved let reverse run in uneven bursts (= felt
// jittery). NOTE: the underlying reverse roughness is C4D's own animation
// evaluation (its NATIVE timeline scrubs backward the same way) — not
// something we can fully fix. This floor just decouples our seek cadence
// from the variable draw cost so the stream is evenly paced; it noticeably
// smooths slow reverse and is a no-op on forward (33ms ≈ 30fps is below
// forward's natural ~49ms rate, so it never throttles forward).
const MIN_SEEK_INTERVAL_MS = 33;
function pumpSeek(): void {
  if (seekInFlight || seekPending === null) return;
  // Hold the next seek until at least MIN_SEEK_INTERVAL_MS after the last
  // one started, so a burst of cheap (fast) draws can't outrun the pace.
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const wait = MIN_SEEK_INTERVAL_MS - (now - lastSeekStartMs);
  if (wait > 0) {
    if (seekPaceTimer === null) {
      seekPaceTimer = setTimeout(() => { seekPaceTimer = null; pumpSeek(); }, wait);
    }
    return;
  }
  const frame = seekPending;
  seekPending = null;
  seekInFlight = true;
  lastSeekStartMs = now;
  send({ kind: 'seek', frame })
    .catch(() => {})
    .then(() => { seekInFlight = false; pumpSeek(); });
}
/** Seek to `frame`, coalescing so only one request is in flight at a time
 *  and the latest target always wins. Use for scrub/playhead drags instead
 *  of send({kind:'seek'}) directly. */
export function seekToHost(frame: number): void {
  seekPending = frame;
  pumpSeek();
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

// Per-session audio binary store. Lives in JS module memory (NOT in
// the Zustand store, because Blobs aren't structured-cloneable cheaply
// and we don't want them in undo history).
//
// KEYED BY `mediaId`, not clipId. A clip is a window onto a piece of
// audio media; splitting a clip produces two clips sharing one media.
// Keying by mediaId means split halves transparently share the same
// blob + decoded buffer — no re-upload, no re-decode. Populated by:
//
//   - useFileDrop on import → addAudio(mediaId, blob)
//   - usePersistence on doc load → audio-fetch from C++ → addAudio
//
// Drained by:
//
//   - WebAudio playback layer → getAudioBuffer(mediaId) decodes on
//     demand and caches the decoded AudioBuffer alongside the blob.
//   - clip delete → removeAudio(mediaId) — fired only when the LAST
//     clip referencing that media is gone (caller's responsibility).
//
// The C++ side owns persistence: when we add audio we push the
// base64-encoded bytes via 'audio-add' so they ride along with the
// doc through save/load. The wire field is still named `clipId` for
// C++ compatibility, but the value passed is the mediaId.

import { send } from './host';

interface AudioEntry {
  blob: Blob;
  // Decoded AudioBuffer, computed lazily on first playback. Held to
  // avoid re-decoding on every play.
  decoded?: AudioBuffer;
  // Decode promise — if a decode is already in flight, subsequent
  // calls await the same promise instead of kicking off a second one.
  decodePromise?: Promise<AudioBuffer | null>;
}

const entries = new Map<number, AudioEntry>();

/** Notifier set when a mediaId's decode fails. Wired by App-level
 *  startup to push the failure into the Zustand store's
 *  orphanMediaIds — keeping audioStore framework-agnostic and
 *  pluggable. */
let decodeFailureListener: ((mediaId: number) => void) | null = null;
export function onDecodeFailure(fn: (mediaId: number) => void): void {
  decodeFailureListener = fn;
}

/** Add a blob for `mediaId` and push it to C++ for persistence.
 *  Idempotent — re-adding the same mediaId replaces both in-memory
 *  blob and the persisted copy. */
export async function addAudio(mediaId: number, blob: Blob): Promise<void> {
  entries.set(mediaId, { blob });
  // Base64-encode + push to C++. Chunked to avoid blowing call-stack
  // limits on multi-MB inputs. Wire field is `clipId` for C++ compat.
  const buf = await blob.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  await send({ kind: 'audio-add', clipId: mediaId, bytes: b64 });
}

/** Lookup the raw blob for a mediaId, or null if we don't have one. */
export function getBlob(mediaId: number): Blob | null {
  return entries.get(mediaId)?.blob ?? null;
}

/** Get the decoded AudioBuffer, decoding on first call. Returns null
 *  if we don't have audio for this mediaId or decode fails. */
export async function getAudioBuffer(
  mediaId: number,
  ctx: AudioContext,
): Promise<AudioBuffer | null> {
  const e = entries.get(mediaId);
  if (!e) return null;
  if (e.decoded) return e.decoded;
  if (e.decodePromise) return e.decodePromise;
  const p = (async () => {
    try {
      const arr = await e.blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr);
      e.decoded = buf;
      return buf;
    } catch (err) {
      console.warn('[audioStore] decode failed for media', mediaId, err);
      if (decodeFailureListener) decodeFailureListener(mediaId);
      return null;
    } finally {
      e.decodePromise = undefined;
    }
  })();
  e.decodePromise = p;
  return p;
}

/** Drop the in-memory Blob for `mediaId`. The C++ helper's persisted
 *  bytes are freed separately, bundled into the next save-state's undo
 *  block (see usePersistence pendingAudioRemoval) so an audio-clip
 *  delete is a single undo step. Caller must only invoke this once NO
 *  clip references the media any more (a split leaves multiple clips
 *  sharing one mediaId). */
export function dropAudioMemory(mediaId: number): void {
  entries.delete(mediaId);
}

/** True if we have a Blob in memory for this mediaId. */
export function hasAudio(mediaId: number): boolean {
  return entries.has(mediaId);
}

/** Pull audio bytes for `mediaId` from C++ (called on doc load when
 *  a persisted clip references media we don't have in memory yet).
 *  Returns true on success, false if no bytes are stored. */
export async function fetchAudio(mediaId: number): Promise<boolean> {
  const ack = await send({ kind: 'audio-fetch', clipId: mediaId }) as
    | { ok?: boolean; bytes?: string } | undefined;
  if (!ack || !ack.ok || !ack.bytes) return false;
  const bytes = base64ToBlob(ack.bytes);
  entries.set(mediaId, { blob: bytes });
  return true;
}

/** Iterate all known mediaIds (for cleanup / introspection). */
export function knownMediaIds(): number[] {
  return Array.from(entries.keys());
}

// ----- base64 helpers -----

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function base64ToBlob(b64: string): Blob {
  // We don't know the original MIME type from the persisted bytes;
  // decodeAudioData sniffs the format from the byte stream so it
  // doesn't matter. Use 'application/octet-stream' as a generic.
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/octet-stream' });
}

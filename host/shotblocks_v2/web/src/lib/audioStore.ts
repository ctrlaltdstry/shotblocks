// Per-session audio binary store. Lives in JS module memory (NOT in
// the Zustand store, because Blobs aren't structured-cloneable cheaply
// and we don't want them in undo history). Populated by:
//
//   - useFileDrop on import → addAudio(clipId, blob)
//   - usePersistence on doc load → audio-fetch from C++ → addAudio
//
// Drained by:
//
//   - WebAudio playback layer → getAudioBuffer(clipId) decodes on
//     demand and caches the decoded AudioBuffer alongside the blob.
//   - clip delete → removeAudio(clipId) (also fires audio-remove to C++).
//
// The C++ side owns persistence: when we add audio for a clip, we push
// the base64-encoded bytes via 'audio-add' so the bytes ride along
// with the doc through save/load. The bytes are stored ONCE per clip
// (not per save-state event), keeping the auto-save loop cheap.

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

/** Add a blob for `clipId` and push it to C++ for persistence.
 *  Idempotent — re-adding the same clipId replaces both in-memory
 *  blob and the persisted copy. */
export async function addAudio(clipId: number, blob: Blob): Promise<void> {
  entries.set(clipId, { blob });
  // Base64-encode + push to C++. Chunked to avoid blowing call-stack
  // limits on multi-MB inputs.
  const buf = await blob.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  await send({ kind: 'audio-add', clipId, bytes: b64 });
}

/** Lookup the raw blob for a clipId, or null if we don't have one. */
export function getBlob(clipId: number): Blob | null {
  return entries.get(clipId)?.blob ?? null;
}

/** Get the decoded AudioBuffer, decoding on first call. Returns null
 *  if we don't have audio for this clipId or decode fails. */
export async function getAudioBuffer(
  clipId: number,
  ctx: AudioContext,
): Promise<AudioBuffer | null> {
  const e = entries.get(clipId);
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
      console.warn('[audioStore] decode failed for clip', clipId, err);
      return null;
    } finally {
      e.decodePromise = undefined;
    }
  })();
  e.decodePromise = p;
  return p;
}

/** Notify C++ to remove the audio binary for `clipId` from the doc
 *  helper, and drop our in-memory entry. */
export async function removeAudio(clipId: number): Promise<void> {
  entries.delete(clipId);
  await send({ kind: 'audio-remove', clipId });
}

/** True if we have a Blob in memory for this clipId. */
export function hasAudio(clipId: number): boolean {
  return entries.has(clipId);
}

/** Pull audio bytes for `clipId` from C++ (called on doc load when
 *  the persisted clip references audio we don't have in memory yet).
 *  Returns true on success, false if no bytes are stored. */
export async function fetchAudio(clipId: number): Promise<boolean> {
  const ack = await send({ kind: 'audio-fetch', clipId }) as
    | { ok?: boolean; bytes?: string } | undefined;
  if (!ack || !ack.ok || !ack.bytes) return false;
  const bytes = base64ToBlob(ack.bytes);
  entries.set(clipId, { blob: bytes });
  return true;
}

/** Iterate all known clipIds (for cleanup / introspection). */
export function knownClipIds(): number[] {
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

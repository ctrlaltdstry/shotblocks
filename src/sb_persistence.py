"""Shotblocks persistence layer.

Per-document state lives on a hidden helper `BaseObject` (a null with
NBIT_OHIDE) inserted at the document root. Shot list and play range
serialize as JSON in the helper's BaseContainer. The helper is created
lazily on first write and remains in the doc for the document's lifetime.

Reads tolerate a missing or corrupt helper (returning sensible defaults).
Writes wrap in `AddUndo(UNDOTYPE_CHANGE_SMALL, helper)` so create / move /
resize / delete / range edits are all undoable in one Cmd+Z step.
"""

import json

import c4d


# BaseContainer keys on the helper null
BCKEY_HELPER_MARKER = 1010   # str: identifies a null as our data carrier
BCKEY_SHOTS_JSON    = 1011   # str: the JSON-serialized shot list + counters
BCKEY_RANGE_JSON    = 1012   # str: the JSON-serialized play range {in, out}
BCKEY_AUDIO_JSON    = 1013   # str: the JSON-serialized audio track state
                              # (path, timeline placement, trim offsets)
BCKEY_TRACKS_JSON   = 1014   # str: the JSON-serialized per-track state
                              # (targeted/locked/visible/muted/solo by kind+idx)

# Per-shot BaseLink to the camera. Key is BCKEY_CAM_LINK_BASE + shot_id.
# BaseLinks survive save/load and follow the camera even if it's renamed —
# this is what lets in-Object-Manager renames reflect in the timeline after
# a project has been closed and reopened.
BCKEY_CAM_LINK_BASE = 2000

HELPER_MARKER_VALUE = "shotblocks_v1"
HELPER_NULL_NAME    = "Shotblocks Data (do not delete)"

# Play-range defaults when no value is persisted yet
DEFAULT_RANGE_IN    = 0
DEFAULT_RANGE_OUT   = 240


# ---------------------------------------------------------------------------
# Helper-null lifecycle
# ---------------------------------------------------------------------------

def _find_helper(doc):
    """Return the existing helper null in this document, or None."""
    if doc is None:
        return None
    obj = doc.GetFirstObject()
    while obj is not None:
        bc = obj.GetDataInstance()
        try:
            if bc is not None and bc.GetString(BCKEY_HELPER_MARKER) == HELPER_MARKER_VALUE:
                return obj
        except Exception:
            pass
        obj = obj.GetNext()
    return None


def _create_helper(doc):
    """Create the helper null, mark it, hide it, insert at root, and return it.

    Created OUTSIDE the undo system intentionally — once introduced, the helper
    sticks around forever (it's invisible anyway). Subsequent data changes ARE
    undoable; only the very first shot in a fresh document is "non-undoable
    relative to the helper's presence," which is fine.
    """
    null = c4d.BaseObject(c4d.Onull)
    null.SetName(HELPER_NULL_NAME)
    bc = null.GetDataInstance()
    if bc is not None:
        bc.SetString(BCKEY_HELPER_MARKER, HELPER_MARKER_VALUE)
    # Display: NONE so even if visible somewhere, it draws nothing.
    try:
        null[c4d.NULLOBJECT_DISPLAY] = c4d.NULLOBJECT_DISPLAY_NONE
    except Exception:
        pass
    # Hide from editor / Object Manager.
    try:
        null.ChangeNBit(c4d.NBIT_OHIDE, c4d.NBITCONTROL_SET)
    except Exception:
        pass
    doc.InsertObject(null)
    print("[Shotblocks] created helper null")
    return null


def _get_or_create_helper(doc):
    helper = _find_helper(doc)
    if helper is None:
        helper = _create_helper(doc)
    return helper


# ---------------------------------------------------------------------------
# Shots
# ---------------------------------------------------------------------------

def _read_shots(doc):
    """Return (shots, next_id) for the active document."""
    helper = _find_helper(doc)
    if helper is None:
        return [], 1
    bc = helper.GetDataInstance()
    if bc is None:
        return [], 1
    raw = bc.GetString(BCKEY_SHOTS_JSON)
    if not raw:
        return [], 1
    try:
        data = json.loads(raw)
        return data.get("shots", []), data.get("next_id", 1)
    except (ValueError, TypeError):
        return [], 1


def _write_shots(doc, shots, next_id, with_undo=True):
    """Persist shots + next_id on the helper null. Wraps in undo by default."""
    helper = _get_or_create_helper(doc)
    bc = helper.GetDataInstance()
    if bc is None:
        print("[Shotblocks] _write_shots: GetDataInstance returned None")
        return
    if with_undo:
        doc.AddUndo(c4d.UNDOTYPE_CHANGE_SMALL, helper)
    bc.SetString(BCKEY_SHOTS_JSON, json.dumps({"shots": shots, "next_id": next_id}))


# ---------------------------------------------------------------------------
# Per-shot camera BaseLink — survives save/load and follows the camera
# through renames in the Object Manager.
# ---------------------------------------------------------------------------

def _set_shot_cam_link(doc, shot_id, cam_obj):
    """Persist a BaseLink to `cam_obj` keyed by shot_id."""
    helper = _get_or_create_helper(doc)
    bc = helper.GetDataInstance()
    if bc is None:
        return
    key = BCKEY_CAM_LINK_BASE + int(shot_id)
    # SetLink is the BaseContainer accessor for storing a BaseLink to
    # another BaseList2D. Falls back to SetData with an explicit BaseLink
    # object if SetLink isn't available in this SDK build.
    try:
        bc.SetLink(key, cam_obj)
    except Exception:
        try:
            link = c4d.BaseLink()
            link.SetLink(cam_obj)
            bc.SetData(key, link)
        except Exception as e:
            print("[Shotblocks] _set_shot_cam_link failed: {}".format(e))


def _get_shot_cam(doc, shot_id):
    """Resolve and return the BaseObject for `shot_id`'s camera, or None
    if the link is missing or its target has been deleted."""
    helper = _find_helper(doc)
    if helper is None:
        return None
    bc = helper.GetDataInstance()
    if bc is None:
        return None
    key = BCKEY_CAM_LINK_BASE + int(shot_id)
    try:
        cam = bc.GetLink(key, doc)
        if cam is not None:
            return cam
    except Exception:
        pass
    # Fallback: GetData might return the BaseLink directly.
    try:
        link = bc.GetData(key)
        if isinstance(link, c4d.BaseLink):
            return link.GetLink(doc)
    except Exception:
        pass
    return None


def _clear_shot_cam_link(doc, shot_id):
    """Remove the BaseLink for a deleted shot. Called when shots are removed."""
    helper = _find_helper(doc)
    if helper is None:
        return
    bc = helper.GetDataInstance()
    if bc is None:
        return
    key = BCKEY_CAM_LINK_BASE + int(shot_id)
    try:
        bc.RemoveData(key)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Play range
# ---------------------------------------------------------------------------

def _read_range(doc):
    """Return (in_frame, out_frame) for the play range. Defaults if absent.

    The play range is plugin-owned (persisted on our helper null) — distinct
    from C4D's preview-range bar, which is a timeline zoom widget rather
    than a playback gate. Our range is the "from cursor to out, then stop
    or loop" boundary the spacebar engine respects."""
    helper = _find_helper(doc)
    if helper is None:
        return DEFAULT_RANGE_IN, DEFAULT_RANGE_OUT
    bc = helper.GetDataInstance()
    if bc is None:
        return DEFAULT_RANGE_IN, DEFAULT_RANGE_OUT
    raw = bc.GetString(BCKEY_RANGE_JSON)
    if not raw:
        return DEFAULT_RANGE_IN, DEFAULT_RANGE_OUT
    try:
        d = json.loads(raw)
        in_f  = int(d.get("in",  DEFAULT_RANGE_IN))
        out_f = int(d.get("out", DEFAULT_RANGE_OUT))
        if out_f <= in_f:
            return DEFAULT_RANGE_IN, DEFAULT_RANGE_OUT
        return in_f, out_f
    except (ValueError, TypeError):
        return DEFAULT_RANGE_IN, DEFAULT_RANGE_OUT


def _write_range(doc, in_frame, out_frame, with_undo=True):
    """Persist the play range to our helper null. Wraps in undo by default."""
    helper = _get_or_create_helper(doc)
    bc = helper.GetDataInstance()
    if bc is None:
        return
    if with_undo:
        doc.AddUndo(c4d.UNDOTYPE_CHANGE_SMALL, helper)
    bc.SetString(BCKEY_RANGE_JSON,
                 json.dumps({"in": int(in_frame), "out": int(out_frame)}))


# ---------------------------------------------------------------------------
# Audio track (v7)
# ---------------------------------------------------------------------------
#
# v7 ships one audio track per document. The serialized blob holds:
#   path             — string. Project-relative when the doc is saved
#                      and the audio file lives under the doc's folder;
#                      absolute otherwise. The audio-track module
#                      resolves to absolute on read.
#   path_is_relative — bool. True when `path` should be joined to the
#                      doc folder; False = treat as absolute. Stored
#                      explicitly because re-deriving from the string
#                      alone is ambiguous (Windows absolute paths look
#                      relative on macOS and vice versa).
#   in_frame         — int. Timeline frame where audio frame 0 plays.
#   out_frame        — int. Last timeline frame the clip covers
#                      (inclusive). End-of-audio cap is enforced
#                      separately by the playback module (silence
#                      past the last sample).
#   trim_start_audio_frames — int. Audio frames trimmed off the head;
#                      the clip plays starting at this audio-frame
#                      offset within the source file.
#   onsets           — list[int], optional (v9). Source-rate audio-
#                      frame indices of every detected attack. Dense;
#                      kept for v10+ sidechain envelope work but the
#                      canvas does not draw them.
#   prominent_peaks  — list[int], optional (v9). Subset of onsets that
#                      stand out as visual peaks (the "big hits" the
#                      user wants to cut on). Drawn as tall ticks on
#                      the audio block and used as snap targets.
#                      Source-rate audio-frame indices.
#   beat_grid        — dict, optional (v9). {period, phase, confidence}
#                      where period and phase are audio-frame counts.
#                      Confidence in [0, 1]; the canvas suppresses
#                      the grid below CONFIDENCE_FLOOR (sb_audio_onsets).
#                      Drawn canvas-wide as faint dashed lines behind
#                      everything else when displayable.
#   analysis_visible — bool, optional (v9). True = the rail button is
#                      "on", and the canvas draws peak ticks + beat
#                      grid. False (default) hides the analysis even
#                      when the data is present. Persisted so the
#                      visibility state survives doc save/load.
#   waveform_visible — bool, optional. Independent toggle for the
#                      waveform line render. Default True (matches
#                      pre-toggle behavior); only written to the JSON
#                      when False so legacy docs without the key
#                      stay visible after upgrade.
#
# Absent / corrupt blob → returns None and the caller renders no
# waveform. There is intentionally no default audio.

def _read_audios(doc):
    """Return a list of serialized audio-track dicts for the active
    doc. Empty list if none persisted. Tolerates both the new
    multi-track shape (`{"tracks": [dict, ...]}`) and the legacy
    single-dict shape (one-element list returned).
    """
    helper = _find_helper(doc)
    if helper is None:
        return []
    bc = helper.GetDataInstance()
    if bc is None:
        return []
    raw = bc.GetString(BCKEY_AUDIO_JSON)
    if not raw:
        return []
    try:
        d = json.loads(raw)
    except (ValueError, TypeError):
        return []
    # New shape: {"tracks": [ ... ]}
    if isinstance(d, dict) and isinstance(d.get("tracks"), list):
        out = []
        for entry in d["tracks"]:
            if isinstance(entry, dict) and entry.get("path"):
                out.append(entry)
        return out
    # Legacy shape: a single track dict at the top level.
    if isinstance(d, dict) and d.get("path"):
        return [d]
    return []


def _write_audios(doc, audio_dicts, with_undo=True):
    """Persist the list of audio-track dicts to the helper null. Pass
    an empty list (or None) to clear. New shape: {"tracks": [...]} so
    future additions can sit at the top level without ambiguity."""
    helper = _get_or_create_helper(doc)
    bc = helper.GetDataInstance()
    if bc is None:
        return
    if with_undo:
        doc.AddUndo(c4d.UNDOTYPE_CHANGE_SMALL, helper)
    if not audio_dicts:
        bc.SetString(BCKEY_AUDIO_JSON, "")
        return
    bc.SetString(BCKEY_AUDIO_JSON,
                 json.dumps({"tracks": list(audio_dicts)}))


# Back-compat shims for callers still on the single-track API.
# Reading: returns the first track dict (or None). Writing: replaces
# the whole list with the given dict. Deprecated — new code should
# use _read_audios / _write_audios directly.

def _read_audio(doc):
    out = _read_audios(doc)
    return out[0] if out else None


def _write_audio(doc, audio_dict, with_undo=True):
    _write_audios(doc, [audio_dict] if audio_dict else [], with_undo=with_undo)


# ---------------------------------------------------------------------------
# Per-track state (target / lock / visible / mute / solo)
# ---------------------------------------------------------------------------
#
# Serialized shape is a flat list of entries so the persisted blob stays
# stable as new tracks come and go:
#
#   {"entries": [
#       {"kind": "video", "idx": 0, "locked": true},
#       {"kind": "audio", "idx": 0, "muted": true, "solo": false},
#   ]}
#
# Attributes equal to the canvas-side _TRACK_DEFAULTS are omitted on
# write — so a doc with no per-track customizations stores an empty
# `entries` list (or the BC key is empty entirely).

def _read_tracks(doc):
    """Return a {(kind, idx): {attr: bool}} dict for the active doc.
    Empty dict if no entries are persisted or the blob is corrupt."""
    helper = _find_helper(doc)
    if helper is None:
        return {}
    bc = helper.GetDataInstance()
    if bc is None:
        return {}
    raw = bc.GetString(BCKEY_TRACKS_JSON)
    if not raw:
        return {}
    try:
        d = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    out = {}
    for entry in d.get("entries", []):
        try:
            kind = str(entry.get("kind", ""))
            idx  = int(entry.get("idx", 0))
        except (TypeError, ValueError):
            continue
        if kind not in ("video", "audio"):
            continue
        attrs = {k: bool(v) for k, v in entry.items()
                 if k in ("targeted", "locked", "visible", "muted", "solo")}
        if attrs:
            out[(kind, idx)] = attrs
    return out


def _write_tracks(doc, track_state, with_undo=True):
    """Persist the per-track state dict to the helper null. Pass an
    empty dict to clear. `track_state` shape matches `_read_tracks`."""
    helper = _get_or_create_helper(doc)
    bc = helper.GetDataInstance()
    if bc is None:
        return
    if with_undo:
        doc.AddUndo(c4d.UNDOTYPE_CHANGE_SMALL, helper)
    if not track_state:
        bc.SetString(BCKEY_TRACKS_JSON, "")
        return
    entries = []
    for (kind, idx), attrs in sorted(track_state.items()):
        e = {"kind": kind, "idx": int(idx)}
        for k, v in attrs.items():
            e[k] = bool(v)
        entries.append(e)
    bc.SetString(BCKEY_TRACKS_JSON, json.dumps({"entries": entries}))

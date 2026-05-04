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
# Play range
# ---------------------------------------------------------------------------

def _read_range(doc):
    """Return (in_frame, out_frame) for the play range. Defaults if absent."""
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
    """Persist the play range. Wraps in undo by default."""
    helper = _get_or_create_helper(doc)
    bc = helper.GetDataInstance()
    if bc is None:
        return
    if with_undo:
        doc.AddUndo(c4d.UNDOTYPE_CHANGE_SMALL, helper)
    bc.SetString(BCKEY_RANGE_JSON,
                 json.dumps({"in": int(in_frame), "out": int(out_frame)}))

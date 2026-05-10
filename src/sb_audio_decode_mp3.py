"""MP3 decoding for the v8 audio subsystem.

Bundled minimp3 (CC0) via ctypes — no third-party Python deps. Returns
the same `DecodedAudio` shape `sb_audio_decode.load_wav` returns, so
the rest of the audio subsystem stays format-agnostic.

The DLL lives at `vendor/minimp3.dll` next to this module. If the DLL
is missing, wrong-arch, or otherwise unloadable, `load_mp3` raises
`AudioDecodeError` and `is_available()` returns False — the canvas
drag-receive uses that to silently reject `.mp3` drops without
crashing.

Build provenance and rebuild instructions live in
`vendor/README.md`.
"""

import ctypes
import os

from sb_audio_decode import AudioDecodeError, DecodedAudio


_MAX_BYTES = 350 * 1024 * 1024  # mirrors sb_audio_decode._MAX_BYTES


# minimp3_ex.h error codes
_MP3D_E_PARAM   = -1
_MP3D_E_MEMORY  = -2
_MP3D_E_IOERROR = -3
_MP3D_E_USER    = -4
_MP3D_E_DECODE  = -5
_SB_E_OPEN      = -100  # shim-defined: _wfopen failed

_ERROR_NAMES = {
    _MP3D_E_PARAM:   "bad parameter",
    _MP3D_E_MEMORY:  "out of memory",
    _MP3D_E_IOERROR: "I/O error",
    _MP3D_E_USER:    "unrecognized stream (not an MP3?)",
    _MP3D_E_DECODE:  "decode error (corrupt or unsupported MP3)",
    _SB_E_OPEN:      "could not open file",
}


def _dll_path():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "vendor", "minimp3.dll")


_dll = None
_load_error = None


def _load():
    """Lazy-load the DLL on first use. Returns the CDLL handle or None
    on failure (with `_load_error` populated for diagnostics)."""
    global _dll, _load_error
    if _dll is not None:
        return _dll
    if _load_error is not None:
        return None  # already failed once; don't retry
    path = _dll_path()
    if not os.path.exists(path):
        _load_error = "minimp3.dll missing at {}".format(path)
        return None
    try:
        dll = ctypes.CDLL(path)
    except OSError as e:
        _load_error = "minimp3.dll failed to load: {}".format(e)
        return None

    try:
        dll.sb_mp3_decode_file.argtypes = [
            ctypes.c_wchar_p,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_int16)),
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        dll.sb_mp3_decode_file.restype = ctypes.c_int

        dll.sb_mp3_free.argtypes = [ctypes.c_void_p]
        dll.sb_mp3_free.restype = None
    except AttributeError as e:
        _load_error = "minimp3.dll missing expected exports: {}".format(e)
        return None

    _dll = dll
    return _dll


def is_available():
    """True if the MP3 decoder DLL loaded cleanly. Cheap to call."""
    return _load() is not None


def load_error():
    """Why the DLL failed to load, or None if it loaded (or hasn't been
    probed yet)."""
    if _dll is not None:
        return None
    _load()
    return _load_error


def load_mp3(path):
    """Decode an MP3 file and return a `DecodedAudio`.

    Raises `AudioDecodeError` on any failure (DLL missing, file
    unreadable, decode error, oversized).
    """
    if not path:
        raise AudioDecodeError("empty audio path")

    dll = _load()
    if dll is None:
        raise AudioDecodeError(
            "MP3 decoder unavailable: {}".format(_load_error))

    out_buf  = ctypes.POINTER(ctypes.c_int16)()
    out_n    = ctypes.c_size_t(0)
    out_rate = ctypes.c_int(0)
    out_ch   = ctypes.c_int(0)

    rc = dll.sb_mp3_decode_file(
        path,
        ctypes.byref(out_buf),
        ctypes.byref(out_n),
        ctypes.byref(out_rate),
        ctypes.byref(out_ch),
    )
    if rc != 0:
        if out_buf:
            dll.sb_mp3_free(out_buf)
        reason = _ERROR_NAMES.get(rc, "unknown error code {}".format(rc))
        raise AudioDecodeError(
            "MP3 decode failed: {} ({})".format(reason, path))

    n_int16      = int(out_n.value)
    sample_rate  = int(out_rate.value)
    n_channels   = int(out_ch.value)
    sample_width = 2

    # Validate before copying out — failure path still must free the
    # native buffer.
    try:
        # minimp3 returns rc=0 with rate=0 / samples=0 when it scanned
        # the file and never found a valid MPEG frame — i.e. the file
        # isn't an MP3 at all. Flag that as such, not as bad metadata.
        if sample_rate <= 0 or n_int16 <= 0:
            raise AudioDecodeError(
                "no MP3 frames found in {} (not an MP3?)".format(path))
        if n_channels < 1 or n_channels > 8:
            raise AudioDecodeError(
                "MP3 decode produced invalid channel count: {}".format(
                    n_channels))
        if n_int16 % n_channels != 0:
            raise AudioDecodeError(
                "MP3 decode sample count {} not divisible by channels {}".format(
                    n_int16, n_channels))

        total_bytes = n_int16 * sample_width
        if total_bytes > _MAX_BYTES:
            raise AudioDecodeError(
                "MP3 too large: {:.1f} MB decoded (cap {:.0f} MB). "
                "Trim or down-sample before importing.".format(
                    total_bytes / (1024 * 1024),
                    _MAX_BYTES / (1024 * 1024)))

        # Copy bytes out of native memory before freeing.
        samples = ctypes.string_at(out_buf, total_bytes)
    finally:
        dll.sb_mp3_free(out_buf)

    n_frames   = n_int16 // n_channels
    duration_s = n_frames / float(sample_rate)

    return DecodedAudio(
        samples=samples,
        sample_rate=sample_rate,
        sample_width=sample_width,
        n_channels=n_channels,
        n_frames=n_frames,
        duration_s=duration_s,
    )


def is_mp3_path(path):
    """Cheap extension check used by the canvas drag-receive filter."""
    if not path:
        return False
    return os.path.splitext(path)[1].lower() == ".mp3"

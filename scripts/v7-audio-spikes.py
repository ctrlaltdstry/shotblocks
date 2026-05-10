"""v7 audio integration — one-shot spike script.

Run this from C4D 2026's Script Manager (Extensions > Script Manager >
New Script > paste > Execute) to answer the four unknowns from
.agent/tasks/v7-audio-integration.md before we start writing the
real modules.

Output is printed to C4D's Python console. Copy the console output
back to the chat and we'll lock in the implementation choices.

Spike #1 — Audio output API
  Probes c4d.modules.snd, winsound, simpleaudio, sounddevice, pyaudio.
  Reports which (if any) are importable, and which can play in-memory
  PCM samples without writing a temp file.

Spike #2 — wave stdlib
  Imports `wave` and round-trips a tiny in-memory WAV through
  io.BytesIO. Confirms the module is bundled and the read path works.

Spike #3 — file-path drag-receive
  Cannot be answered by a script alone (it requires a real drag
  gesture). Instead this spike prints the BFM_DRAGRECEIVE / DRAG_*
  / DRAGTYPE_* constants exposed by C4D 2026 so we can wire the
  right type filters in _on_drag_receive. The actual gesture test
  follows in the plugin once we know the constants.

Spike #4 — track-Y math
  Pure Python. Computes where the audio block would render given the
  existing layout constants and confirms there's no collision with the
  shot-track stack.
"""

import io
import os
import sys
import wave

import c4d


def _hr(label):
    print("")
    print("=" * 70)
    print(label)
    print("=" * 70)


# ---------------------------------------------------------------------------
# Spike #1 — audio output API options
# ---------------------------------------------------------------------------

def spike_audio_output():
    _hr("SPIKE #1 — audio output API")

    # 1a. c4d.modules.snd — Maxon's older built-in sound module.
    snd = getattr(c4d.modules, "snd", None)
    if snd is None:
        print("[snd] c4d.modules.snd: NOT PRESENT in this build")
    else:
        print("[snd] c4d.modules.snd: present, dir = {}".format(
            sorted(x for x in dir(snd) if not x.startswith("_"))))

    # 1b. winsound — Windows stdlib. PlaySound can play from filename or
    #     in-memory bytes (with SND_MEMORY flag). Only handles WAV.
    try:
        import winsound
        flags = []
        for n in ("SND_MEMORY", "SND_ASYNC", "SND_PURGE",
                 "SND_FILENAME", "SND_LOOP", "SND_NODEFAULT"):
            if hasattr(winsound, n):
                flags.append(n)
        print("[winsound] importable. Useful flags: {}".format(", ".join(flags)))
        # Actually try playing 0.05 s of silence so we know the API path
        # works in this Python build. Tiny WAV header in memory, mono,
        # 22050 Hz, 16-bit PCM, 1102 samples of zero.
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(22050)
            w.writeframes(b"\x00\x00" * 1102)
        winsound.PlaySound(buf.getvalue(),
                           winsound.SND_MEMORY | winsound.SND_ASYNC)
        # Stop immediately so we don't leave anything queued.
        winsound.PlaySound(None, winsound.SND_PURGE)
        print("[winsound] PlaySound(SND_MEMORY | SND_ASYNC) returned cleanly")
    except Exception as e:
        print("[winsound] FAILED: {}: {}".format(type(e).__name__, e))

    # 1c. Third-party output libs. None bundled by default; report whether
    #     they're importable so we know if the user has them on the path.
    for mod in ("simpleaudio", "sounddevice", "pyaudio"):
        try:
            __import__(mod)
            print("[{}] importable (already on sys.path)".format(mod))
        except Exception as e:
            print("[{}] not importable: {}".format(mod, e))

    print("")
    print("Python: {}".format(sys.version))
    print("Platform: {}".format(sys.platform))


# ---------------------------------------------------------------------------
# Spike #2 — wave stdlib
# ---------------------------------------------------------------------------

def spike_wave_stdlib():
    _hr("SPIKE #2 — wave stdlib round-trip")

    # Build a tiny 0.1 s 440 Hz tone in memory.
    import struct
    sample_rate = 44100
    n_samples   = sample_rate // 10  # 0.1 s
    amplitude   = 0.25
    import math
    pcm = bytearray()
    for i in range(n_samples):
        v = int(amplitude * 32767 * math.sin(2 * math.pi * 440 * i / sample_rate))
        pcm += struct.pack("<h", v)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(bytes(pcm))

    # Now read it back.
    buf.seek(0)
    with wave.open(buf, "rb") as r:
        nch  = r.getnchannels()
        sw   = r.getsampwidth()
        sr   = r.getframerate()
        nfr  = r.getnframes()
        data = r.readframes(nfr)

    print("[wave] write+read OK: nchannels={}, sampwidth={}, "
          "framerate={}, nframes={}, len(bytes)={}".format(nch, sw, sr, nfr, len(data)))
    print("[wave] match: {}".format(data == bytes(pcm)))


# ---------------------------------------------------------------------------
# Spike #3 — drag-receive constants
# ---------------------------------------------------------------------------

def spike_drag_constants():
    _hr("SPIKE #3 — BFM_DRAGRECEIVE / DRAG* constants in c4d 2026")

    # Print every BFM_DRAG_* and DRAGTYPE_* constant the build exposes,
    # along with its value. We'll match against these in
    # _on_drag_receive when a file is dropped.
    drag_msg_names = sorted(n for n in dir(c4d) if n.startswith("BFM_DRAG"))
    type_names     = sorted(n for n in dir(c4d) if n.startswith("DRAGTYPE_"))
    for n in drag_msg_names:
        print("c4d.{} = {!r}".format(n, getattr(c4d, n, None)))
    print("")
    for n in type_names:
        print("c4d.{} = {!r}".format(n, getattr(c4d, n, None)))


# ---------------------------------------------------------------------------
# Spike #4 — audio Y-layout math
# ---------------------------------------------------------------------------

def spike_audio_y_layout():
    _hr("SPIKE #4 — audio block Y math")

    # Mirror the layout constants from sb_canvas.py. This is a paper
    # check; we don't import sb_canvas here because that pulls in the
    # whole canvas (and we want this script self-contained).
    RANGE_HEIGHT  = 16
    RULER_HEIGHT  = 24
    SHOT_Y_TOP    = RANGE_HEIGHT + RULER_HEIGHT + 4
    SHOT_HEIGHT   = 48
    AUDIO_HEIGHT  = 96
    LANE_GAP      = 2

    # Worst case: dialog tall enough to allow track 0 to be vertically
    # centered. natural_top picked from the formula in _track_0_top().
    h = 600
    natural_center = (SHOT_Y_TOP + h) // 2
    natural_top    = natural_center - SHOT_HEIGHT // 2
    t0_top         = max(SHOT_Y_TOP, natural_top)
    t0_bot         = t0_top + SHOT_HEIGHT
    audio_top      = t0_bot + LANE_GAP
    audio_bot      = audio_top + AUDIO_HEIGHT

    print("h={}".format(h))
    print("track-0 top..bot        = {}..{}".format(t0_top, t0_bot))
    print("audio block top..bot    = {}..{}".format(audio_top, audio_bot))
    print("audio_bot <= h?         = {} (need True; otherwise scroll later)".format(
        audio_bot <= h))

    # Short-canvas case: dialog only ~240 px tall (the default).
    h2 = 240
    natural_center2 = (SHOT_Y_TOP + h2) // 2
    natural_top2    = natural_center2 - SHOT_HEIGHT // 2
    t0_top2         = max(SHOT_Y_TOP, natural_top2)
    t0_bot2         = t0_top2 + SHOT_HEIGHT
    audio_top2      = t0_bot2 + LANE_GAP
    audio_bot2      = audio_top2 + AUDIO_HEIGHT
    print("")
    print("short canvas h={}".format(h2))
    print("track-0 top..bot        = {}..{}".format(t0_top2, t0_bot2))
    print("audio block top..bot    = {}..{}".format(audio_top2, audio_bot2))
    print("audio_bot <= h?         = {} (False = clipped — surface this)".format(
        audio_bot2 <= h2))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    print("v7 audio spike — running probes")
    spike_audio_output()
    spike_wave_stdlib()
    spike_drag_constants()
    spike_audio_y_layout()
    _hr("v7 audio spike — done")


if __name__ == "__main__":
    main()

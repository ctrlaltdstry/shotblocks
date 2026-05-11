"""v9 onset-detection smoke test — runs `sb_audio_onsets.analyse`
against the user's test MP3 from stock Python (no C4D needed).

Confirms:
  - mp3 decode path works under stock Python (the bundled minimp3
    DLL loads via ctypes regardless of host).
  - mono mixdown produces the expected sample count.
  - `analyse(decoded)` returns plausible onsets + (period, phase, conf).
  - wall-clock time is in the budget (~5-8s per the task spec).

Run:
    set PYTHONPATH=src
    python scripts/v9-onset-smoke.py
"""

import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "src"))

from sb_audio_decode  import load_audio
from sb_audio_onsets  import analyse, mixdown_to_mono
from sb_audio_filters import drum_band


def main():
    mp3_path = os.path.join(REPO, "scenes",
                            "ES_Our Last Stand - FormantX.mp3")
    if not os.path.exists(mp3_path):
        print("test MP3 missing: {}".format(mp3_path))
        return 1

    t0 = time.monotonic()
    d = load_audio(mp3_path)
    print("decoded {:.2f}s of audio in {:.2f}s; sr={} ch={}".format(
        d.duration_s, time.monotonic() - t0, d.sample_rate, d.n_channels))

    t0 = time.monotonic()
    mono = mixdown_to_mono(d)
    print("mono in {:.2f}s; samples={}".format(
        time.monotonic() - t0, len(mono)))

    t0 = time.monotonic()
    db = drum_band(mono, d.sample_rate)
    print("drum_band built in {:.2f}s".format(time.monotonic() - t0))

    t0 = time.monotonic()
    onsets, peaks, grid, elapsed = analyse(d, mono=mono, peak_signal=db)
    print("analyse: {} onsets, {} prominent peaks, elapsed={:.2f}s "
          "(analyse() reported {:.2f}s)".format(
              len(onsets), len(peaks), time.monotonic() - t0, elapsed))

    if grid is not None:
        period, phase, conf = grid
        bpm = 60.0 * d.sample_rate / period if period else 0.0
        print("grid: period={} af  phase={} af  conf={:.2f}  ~{:.1f} BPM".format(
            period, phase, conf, bpm))
    else:
        print("grid: none (autocorrelation peak too weak)")

    if onsets:
        first = [round(x / d.sample_rate, 3) for x in onsets[:8]]
        last  = [round(x / d.sample_rate, 3) for x in onsets[-4:]]
        print("first onsets (s): {}".format(first))
        print("last  onsets (s): {}".format(last))
    if peaks:
        first_pk = [round(x / d.sample_rate, 3) for x in peaks[:10]]
        print("first prominent peaks (s): {}".format(first_pk))
        # Sanity: leading silence (first 0.5s) ideally has no onsets.
        n_in_first_half_sec = sum(1 for af in onsets
                                  if af < d.sample_rate // 2)
        print("onsets in first 0.5s: {} (expect 0-2 for a clean intro)"
              .format(n_in_first_half_sec))
    return 0


if __name__ == "__main__":
    sys.exit(main())

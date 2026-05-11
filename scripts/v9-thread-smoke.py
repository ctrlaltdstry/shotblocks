"""Confirm threaded `analyse_audio()` is no slower than direct
in-process call. Reproduces the same call shape the canvas uses:
worker thread runs analyse(), main thread polls + sleeps.
"""

import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "src"))

from sb_audio_decode import load_audio
from sb_audio_onsets import analyse


def main():
    mp3_path = os.path.join(REPO, "scenes",
                            "ES_Our Last Stand - FormantX.mp3")
    if not os.path.exists(mp3_path):
        print("test MP3 missing")
        return 1
    d = load_audio(mp3_path)
    print("decoded {:.2f}s sr={}".format(d.duration_s, d.sample_rate))

    # Direct (synchronous) baseline.
    t0 = time.monotonic()
    onsets, peaks, grid, _e = analyse(d)
    direct = time.monotonic() - t0
    print("direct: {:.2f}s, {} onsets / {} peaks".format(
        direct, len(onsets), len(peaks)))

    # Threaded with main-thread polling. Mirrors the canvas pattern.
    result = {"ok": False}
    def worker():
        result["onsets"], result["peaks"], result["grid"], _ = analyse(d)
        result["ok"] = True

    t0 = time.monotonic()
    t = threading.Thread(target=worker)
    t.start()
    while not result["ok"]:
        time.sleep(0.016)   # 60 fps poll, like the canvas
    threaded = time.monotonic() - t0
    print("threaded (60 fps poll): {:.2f}s".format(threaded))

    # Same with a 100 ms (10 fps) poll.
    result.clear(); result["ok"] = False
    t0 = time.monotonic()
    t = threading.Thread(target=worker)
    t.start()
    while not result["ok"]:
        time.sleep(0.1)
    slow = time.monotonic() - t0
    print("threaded (10 fps poll): {:.2f}s".format(slow))


if __name__ == "__main__":
    sys.exit(main())

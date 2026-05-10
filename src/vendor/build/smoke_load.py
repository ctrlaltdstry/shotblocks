"""Smoke test: load minimp3.dll and verify symbols are wired correctly.
Run with stock Python — this doesn't need C4D. Decodes nothing real;
confirms the DLL is loadable, the ctypes signatures match, the error
paths fire, and the dispatcher routes by extension."""

import os
import sys

# Add src/ to path so we can import our modules.
sys.path.insert(0, os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..")))

from sb_audio_decode_mp3 import _dll_path, is_available, load_error, load_mp3
from sb_audio_decode import (
    AudioDecodeError,
    is_wav_path,
    is_audio_path,
    load_audio,
)

print("dll path     :", _dll_path())
print("dll exists   :", os.path.exists(_dll_path()))
print("is_available :", is_available())
print("load_error   :", load_error())
print()

# Path-classification dispatcher.
print("is_wav_path('foo.wav')   ->", is_wav_path("foo.wav"))
print("is_wav_path('foo.mp3')   ->", is_wav_path("foo.mp3"))
print("is_audio_path('foo.wav') ->", is_audio_path("foo.wav"))
print("is_audio_path('foo.mp3') ->", is_audio_path("foo.mp3"))
print("is_audio_path('foo.png') ->", is_audio_path("foo.png"))
print()

# Error paths through load_mp3.
this_file = os.path.abspath(__file__)
try:
    load_mp3(this_file)
    print("ERROR: should have raised on non-MP3")
except AudioDecodeError as e:
    print("non-mp3 mp3 error OK :", e)

try:
    load_mp3(r"C:\nope\does-not-exist.mp3")
    print("ERROR: should have raised on missing")
except AudioDecodeError as e:
    print("missing mp3 error OK :", e)

# Error paths through load_audio (dispatcher).
try:
    load_audio(r"C:\nope\does-not-exist.flac")
    print("ERROR: should have raised on unsupported ext")
except AudioDecodeError as e:
    print("unsupported ext OK   :", e)

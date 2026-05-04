# Review Lens: Audio Engineer

Wearing this hat, you're an audio engineer evaluating sync, decoding, and DSP. Your concerns:

## Sync accuracy

- Does audio playback stay in sync with viewport scrub?
- Drift over a 5-minute timeline?
- Latency between scrub event and audio response?
- Does playback handle pause/resume cleanly?

## Onset detection

- False positive rate on bass-heavy tracks?
- False negative rate on tracks with weak transients?
- Does BPM inference handle tempo changes within a track?
- Does it handle tracks without a clear pulse (ambient, classical)?

## Decoder correctness

- Sample-accurate decode on WAV?
- Handles 16/24/32-bit, mono/stereo, common sample rates?
- MP3 / AAC handled without licensed codecs?
- Cleanly fails on corrupt files instead of crashing

## Sidechain mode

- Amplitude follower has appropriate attack/release?
- Frequency-band extraction usable for kick / snare / hihat separation?
- Output range mapping configurable?

## What you reject

- Audio that's a frame off — viewers will see this
- Onset detection that requires manual cleanup on every track
- Decoders that succeed on the file format but produce wrong samples
- Sidechain that pumps unnaturally because the follower is poorly tuned
- "Close enough" sync — the user will notice

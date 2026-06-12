#!/usr/bin/env python3
"""Stamp committed native builds with a fingerprint of their C++ source.

The compiled shotblocks binaries (.xdl64 for Windows, .xlib for macOS) are
committed under native/builds/<platform>/shotblocks/ so EITHER machine can
assemble the full two-OS distribution package. The risk of committing
binaries is silent staleness: someone edits the C++ source and ships an old
binary. This tool closes that gap.

`write` records a sha256 over host/shotblocks/source/ + project/ into
build_info.txt next to the binary. `check` recomputes the hash and compares.
tools/package_plugin.py runs `check` automatically and warns on mismatch.

Usage:
    python3 tools/native_stamp.py write native/builds/macos_arm64/shotblocks
    python3 tools/native_stamp.py check native/builds/macos_arm64/shotblocks
    python3 tools/native_stamp.py hash    # print the current source hash
"""
import hashlib
import os
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NATIVE_SRC = os.path.join(REPO_ROOT, "host", "shotblocks")
STAMP_NAME = "build_info.txt"


def source_hash():
    """sha256 over every file in the module's source/ and project/ trees.

    Platform-INDEPENDENT: line endings are normalized to LF and the relative
    path separator to '/'. Otherwise a checkout with CRLF (Windows) and one
    with LF (macOS) would hash the byte-identical-but-for-EOL source to
    different values, making each platform see the other's build as STALE.
    """
    h = hashlib.sha256()
    for sub in ("source", "project"):
        base = os.path.join(NATIVE_SRC, sub)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, NATIVE_SRC).replace(os.sep, "/")
                h.update(rel.encode())
                with open(path, "rb") as fh:
                    data = fh.read().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                h.update(data)
    return h.hexdigest()


def write(build_dir):
    stamp = os.path.join(build_dir, STAMP_NAME)
    with open(stamp, "w", encoding="utf-8") as fh:
        fh.write(f"source_sha256={source_hash()}\n")
        fh.write(f"built={time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    print(f"Stamped {stamp}")


def check(build_dir):
    """Returns (ok, message)."""
    stamp = os.path.join(build_dir, STAMP_NAME)
    if not os.path.isfile(stamp):
        return False, f"no {STAMP_NAME} in {build_dir} (unstamped build)"
    recorded = None
    with open(stamp, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("source_sha256="):
                recorded = line.strip().split("=", 1)[1]
    current = source_hash()
    if recorded != current:
        return False, (
            f"{build_dir} is STALE: built from source {recorded[:12] if recorded else '?'}..., "
            f"current source is {current[:12]}... Rebuild on that platform and re-stamp."
        )
    return True, f"{build_dir} matches current native source."


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "hash":
        print(source_hash())
        return
    if len(sys.argv) != 3 or sys.argv[1] not in ("write", "check"):
        print(__doc__)
        sys.exit(2)
    cmd, build_dir = sys.argv[1], sys.argv[2]
    if cmd == "write":
        write(build_dir)
    else:
        ok, msg = check(build_dir)
        print(("OK: " if ok else "STALE: ") + msg)
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

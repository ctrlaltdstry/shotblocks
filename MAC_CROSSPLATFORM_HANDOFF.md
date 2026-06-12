# ShotBlocks — macOS support + cross-platform release handoff

This is a recipe for making a Cinema 4D plugin build, run, and ship on **both
Windows and macOS** — and for cutting a two-OS release package from **either**
machine. It generalizes exactly what was done for the sibling "Cubit" plugin
(`ctrlaltdstry/cubit`); references to Cubit's files are pointers to copy from.

Read this whole doc first, then work top-to-bottom. Where it says "verify by
reading the code," do that — don't assume.

---

## 0. The mental model (why a Windows-only plugin breaks on Mac)

A C4D plugin can break on macOS for THREE independent reasons. Fix each:

1. **Native binaries are platform-specific.** A compiled C++ module
   (`.xdl64` on Windows) and any vendored native Python wheels (numpy/scipy
   with `.dll`/`.pyd`) **cannot load on macOS**. Mac needs its own
   `.xlib` build and its own `.dylib`/`darwin.so` wheels. Symptom of the
   wheel problem: `AttributeError: module 'os' has no attribute
   'add_dll_directory'` (a Windows-only call inside a Windows numpy).

2. **The `.res` resource parser is stricter on macOS.** Two gotchas that pass
   on Windows but make C4D **silently drop the whole object description on Mac
   → an EMPTY Attribute Manager** (geometry/logic still runs, only the AM is
   blank):
   - **Non-ASCII bytes** (em-dashes `—`, arrows `→`, curly quotes) even inside
     `//` comments in a `.res` file. Make every `.res`/`.str`/`.h` pure ASCII.
   - **A `CUSTOMGUI` referencing a custom-GUI plugin that isn't registered on
     Mac** (i.e. a native C++ custom GUI that only had a Windows build). If
     ShotBlocks' `.res` uses any `CUSTOMGUI <CustomName>`, that custom GUI's
     native module MUST be built for Mac too, or the AM goes empty.

3. **Path/URL code that assumes Windows.** e.g. building a `file://` URL as
   `"file:///" + path` works on Windows (`C:/...`) but produces a malformed
   four-slash URI on macOS (path already starts with `/`), and leaves spaces
   unescaped. Use `pathlib.Path(p).as_uri()` instead. Audit any
   `os.add_dll_directory`, `\\`-path handling, `%APPDATA%`, registry, or
   `"file:///"` string-building in the Python.

---

## 1. First: scope ShotBlocks (do this before building anything)

Run these and record the answers — they decide how much of this applies:

- **Does the Python side import numpy/scipy (or any native wheel)?**
  `grep -rn "import numpy\|import scipy" src/ --include=*.py --include=*.pyp`
  ShotBlocks has `src/vendor/` — inspect what's in it. If the vendored deps
  are **pure-Python** (no compiled `.pyd`/`.so`), they're portable and need NO
  per-platform split. If any are native wheels, do the vendor split (§3).
- **Does the `.res` use any `CUSTOMGUI <CustomName>`** that maps to the native
  `host/shotblocks` C++ module? `grep -rn "CUSTOMGUI" src/res/`. If yes, the
  Mac AM depends on a Mac build of that module (§4). If the `.res` only uses
  built-in CUSTOMGUIs (REALSLIDER, STATICTEXT, etc.), the native module may be
  optional for the AM.
- **Is the native C++ module's source platform-agnostic?**
  `grep -rnE "#include <windows|_WIN32|HWND|__declspec" host/shotblocks/source`
  Cubit's was clean (compiled on Mac with zero source changes except 5
  `static` qualifiers clang wanted). ShotBlocks may differ — note any
  Windows-only code.
- **Non-ASCII in resources?**
  `grep -rlP "[^\x00-\x7F]" src/res/` (or wherever the `.res`/`.str` live).

---

## 2. The target layout (what "done" looks like)

```
repo/
  src/ (or host plugin python)        # the .pyp + python, platform-portable
  src/vendor/win_amd64/               # native wheels per platform (if any)
  src/vendor/macos_arm64/             #   (skip if deps are pure-python)
  host/shotblocks/source/, project/   # the native C++ module source
  native/builds/win64/shotblocks/     # COMMITTED compiled .xdl64 + build_info.txt
  native/builds/macos_arm64/shotblocks/ # COMMITTED compiled .xlib + build_info.txt
  tools/
    package_plugin.py                 # cross-platform packager (the key tool)
    native_stamp.py                   # staleness guard for committed binaries
    vendor_deps.py                    # fetch all-platform wheels from one machine
    build_native_mac.sh               # macOS native build (Ninja, no Xcode)
```

Key idea: **commit the compiled native binaries** (one per OS) under
`native/builds/<platform>/`, so the cross-platform packager can assemble a
full Windows+Mac bundle from EITHER machine. A `build_info.txt` stamp (a hash
of the C++ source) guards against shipping a stale binary after the source
changes. `vendor/` (re-fetchable wheels) is **gitignored**; the committed
binaries are NOT.

---

## 3. Vendored Python deps (only if ShotBlocks ships native wheels)

If the deps are pure-Python, skip this. Otherwise mirror Cubit's
`tools/vendor_deps.py`: it downloads PyPI wheels for ALL platforms from any
machine (pip can fetch foreign-platform wheels), into `vendor/<platform>/`.

Cross-download commands (run on either OS; pin to C4D 2026's CPython 3.11):
```bash
# Windows wheels (works from a Mac):
python3 -m pip download --only-binary=:all: \
  --platform win_amd64 --python-version 3.11 --implementation cp --abi cp311 \
  --dest .wheels_win <pkg>==<ver> ...
# macOS arm64 wheels (works from Windows):
python3 -m pip download --only-binary=:all: \
  --platform macosx_12_0_arm64 --python-version 3.11 --implementation cp --abi cp311 \
  --dest .wheels_mac <pkg>==<ver> ...
# then unzip each .whl into vendor/win_amd64/ and vendor/macos_arm64/.
```
Runtime picker: copy Cubit's `_vendor_platform_subdir()` +
`ensure_brick_on_path()` logic from `BrickGen/plugin_bootstrap.py` into
ShotBlocks' bootstrap — it picks `vendor/<os+arch>` at import, with a flat
fallback. Add `vendor/` to `.gitignore`.

---

## 4. Build the native C++ module for macOS

Only needed if ShotBlocks has a native module whose custom GUI (or behavior)
the Mac side requires. This is the trickiest part. The full, tested recipe is
in Cubit's `tools/build_native_mac.sh` + `MAC_BUILD_HANDOFF.md` — copy and
adapt (change module name `bricklibrary.inline_gui` → `shotblocks`, paths).

**Prereqs on the Mac — NEITHER needs a download/sign-in:**
- **Xcode Command Line Tools** (`xcode-select --install`). Full Xcode is NOT
  required — use CMake's **"Ninja Multi-Config"** generator, not the SDK's
  `macos_universal_xcode` preset.
- **The macOS C4D 2026 C++ SDK ships inside the app**:
  `/Applications/Maxon Cinema 4D 2026/sdk.zip` (matches the installed build).
  Unzip to `~/Dev/c4d_sdk_2026`.
- Portable **cmake (>=3.30) + ninja** from official binaries into `~/Dev/tools`
  (no Homebrew).

**Register the module** in the SDK extract's `custom_paths.txt`:
```
MODULE /Users/<you>/path/to/SHOTBLOCKS/host/shotblocks
```

**Configure + build (the framework-flags trick is essential):**
```bash
cd ~/Dev/c4d_sdk_2026
FW="-framework CoreFoundation -framework Foundation -framework CoreServices \
-framework AppKit -framework CoreGraphics -framework IOKit -framework Security \
-framework SystemConfiguration"
cmake -S . -B _build_ninja -G "Ninja Multi-Config" -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_SHARED_LINKER_FLAGS="$FW" -DCMAKE_MODULE_LINKER_FLAGS="$FW"
cmake --build _build_ninja --config Release
```
Output: `_build_ninja/bin/Release/plugins/shotblocks/shotblocks.xlib` (arm64
Mach-O, ad-hoc linker-signed — fine for local loading; distribution to other
Macs may want Developer ID + notarization).

**Three build-error fixes that were needed for Cubit (clang is stricter than
MSVC) — expect similar:**
1. **SDK cmake bug under Ninja:** `cmake/sdk_compiler_helper.cmake` passes
   `"-Xarch_x86_64 -msse4.2"` as ONE quoted arg in the non-Xcode branch →
   clang errors "no such file or directory." Split into separate args:
   `"$<$<COMPILE_LANGUAGE:CXX>:-Xarch_x86_64;${MAXON_COMPILE_OPTIONS_MACOS_X64_ISA}>"`.
   (Patch the SDK extract; re-apply if you re-unzip sdk.zip.)
2. **`-Werror,-Wmissing-prototypes`:** file-local functions need `static`
   (MSVC has no such warning). Add `static` to any free function the linker
   complains about; commit the source change (Windows still builds fine).
3. **Undefined CoreFoundation/AppKit symbols at link:** solved by the `$FW`
   linker flags above.

**Commit the built binary + stamp it** (so Windows can package it too):
```bash
cd <repo>
rm -rf native/builds/macos_arm64/shotblocks
mkdir -p native/builds/macos_arm64/shotblocks
cp -R _build_ninja/.../plugins/shotblocks native/builds/macos_arm64/
python3 tools/native_stamp.py write native/builds/macos_arm64/shotblocks
```

---

## 5. The packager + staleness guard (copy from Cubit)

- **`tools/native_stamp.py`** — `write`/`check`/`hash` a sha256 of the native
  module's `source/`+`project/`. IMPORTANT: Cubit's version **normalizes line
  endings (CRLF→LF) and path separators (→ '/')** before hashing, so a Windows
  (CRLF) checkout and a Mac (LF) checkout of identical source produce the SAME
  hash. Copy that normalization — without it each OS falsely flags the other's
  build as stale. Point `NATIVE_SRC` at `host/shotblocks`.
- **`tools/package_plugin.py`** — builds
  `dist/ShotBlocks <version>/{MacOS,Windows}/ShotBlocks/` from committed
  binaries + vendor + the python plugin, and runs `native_stamp check`,
  warning loudly if a binary is stale (= rebuild needed on that OS). Note: the
  INNER folder is plain `ShotBlocks` (drops into `plugins/ShotBlocks/`); the
  OUTER dir + zip carry the version. Version comes from the latest git tag.

After copying, adapt the constants: plugin name, native module name/path,
vendor packages (or remove vendor handling if pure-python), and the
`.pyp`/source dir names to ShotBlocks' layout.

---

## 6. Fix the macOS-specific code gotchas

- **`.res`/`.str`/`.h` → pure ASCII.** Find offenders:
  `grep -rlP "[^\x00-\x7F]" <res-dir>` then replace `—`→`-`, `→`→`->`, curly
  quotes → straight. (This alone fixed a blank-AM bug for Cubit.)
- **`file://` and path code → `pathlib.Path(p).as_uri()`** anywhere the python
  builds a local URL (e.g. an "Open Manual/Docs" button). ShotBlocks has a web
  UI — audit how it loads local files into the webview for the same Windows
  path assumptions.
- **Any `os.add_dll_directory`, `\\` path joins, `%APPDATA%`, registry reads**
  → make cross-platform or guard with `sys.platform`.

---

## 7. Cut a cross-platform release (from EITHER Windows or Mac)

Once both native binaries are committed under `native/builds/` and vendor (if
any) is fetched locally:
```bash
python3 tools/vendor_deps.py            # ensure both-platform wheels present (if used)
python3 tools/package_plugin.py --zip   # builds dist/ShotBlocks <version>.zip (both OSes)
# verify: the zip has MacOS/ShotBlocks/ and Windows/ShotBlocks/, each with its
# native binary + vendor; no "STALE" warnings printed.
git tag -a vX.Y.Z -m "..." && git push origin main --tags
gh release create vX.Y.Z "dist/ShotBlocks X.Y.Z.zip" --title "..." --notes-file notes.md
```
You only need to rebuild a native binary again when `host/shotblocks/source`
changes — the stamp check tells you which OS is stale. Everything else
(python, vendored wheels) is producible from one machine.

---

## 8. Test checklist (the things only a real Mac can confirm)

On an Apple Silicon Mac, install the `MacOS/ShotBlocks` build and verify:
1. Plugin loads, no `add_dll_directory`/import errors in the C4D console.
2. The object/tag **Attribute Manager populates** (not empty) — this is the
   custom-GUI + ASCII-`.res` check.
3. Any native custom GUI renders and works.
4. The web UI / local-file links open (the `file://`/path fix).
5. Core functionality runs.

Maxon caveat: C4D's embedded Python on Mac is "not fully identical" to vanilla
CPython, so native wheels MUST be smoke-tested on a real Mac — cross-download
alone can't prove they load.

---

## Reference files to copy from the Cubit repo (`ctrlaltdstry/cubit`)
- `tools/package_plugin.py`, `tools/native_stamp.py`, `tools/vendor_deps.py`,
  `tools/build_native_mac.sh`
- `MAC_BUILD_HANDOFF.md` (the macOS native-build deep dive)
- `BrickGen/plugin_bootstrap.py` — `_vendor_platform_subdir()`,
  `ensure_brick_on_path()`, and the `as_uri()` manual-link fix
- `native/builds/<platform>/.../build_info.txt` — the stamp format
- `.gitignore` — the `vendor/` ignore + `.vendor_wheels*` entries

# `src/vendor/`

Bundled binary dependencies. Files here ship with the plugin via
`scripts/deploy.ps1` (which mirrors all of `src/` to the C4D plugins
folder).

## `minimp3.dll`

MP3 decoder. Loaded from `sb_audio_decode_mp3.py` via `ctypes`.

- **Source:** https://github.com/lieff/minimp3
- **Pinned revision:** `afb604c06bc8beb145fecd42c0ceb5bda8795144`
- **License:** CC0 1.0 Universal — see `minimp3_LICENSE.txt` (verbatim copy from the repo at the same revision).
- **Architecture:** x64 Windows.
- **Built with:** MSVC 2022 Build Tools (cl.exe 19.44.x), `/MT` static CRT — no msvcr*.dll runtime dependency.

### Layout under `src/vendor/`

```
minimp3.dll           -- the only file the plugin loads at runtime
minimp3_LICENSE.txt   -- CC0 dedication, ships with distribution
README.md             -- this file
build/                -- not deployed; rebuild source kept under version control
    minimp3.h
    minimp3_ex.h
    minimp3_shim.c    -- thin C wrapper exposing sb_mp3_decode_file / sb_mp3_free
    smoke_load.py     -- standalone load + error-path test, no C4D needed
```

### Rebuilding `minimp3.dll`

From a Developer Command Prompt (or after running `vcvars64.bat`):

```
cd src\vendor\build
cl /nologo /LD /O2 /MT /W3 minimp3_shim.c /link /OUT:..\minimp3.dll /IMPLIB:minimp3.lib
del minimp3.exp minimp3.lib minimp3_shim.obj
```

If you don't have a Developer Prompt, the wrapper script we use during
development is roughly:

```powershell
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$build  = "$PSScriptRoot\build"
& cmd /c "`"$vcvars`" >nul && cd /d `"$build`" && cl /nologo /LD /O2 /MT /W3 minimp3_shim.c /link /OUT:..\minimp3.dll /IMPLIB:minimp3.lib"
```

### Smoke-testing the DLL outside C4D

```
python src\vendor\build\smoke_load.py
```

Should print `is_available : True`, `load_error : None`, and exercise
two error paths (non-MP3 file, missing file). Non-zero output usually
means either:
1. The DLL is missing — the build above didn't run, or its output went to the wrong directory.
2. The DLL is wrong-arch — `python` and the DLL must both be x64. Stock CPython on Windows is always x64; check the DLL with `dumpbin /headers minimp3.dll`.

### Adding new vendor binaries

Each must be:
- MIT/BSD/Apache/CC0/PD compatible with redistribution under MIT (the project license).
- Accompanied by a verbatim license file (e.g. `<libname>_LICENSE.txt`).
- Documented in this README with source URL, pinned revision, and rebuild command.

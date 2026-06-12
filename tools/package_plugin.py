#!/usr/bin/env python3
"""Build the Shotblocks distribution package for Windows + macOS.

Layout:

    dist/Shotblocks <version>/
        MacOS/
            shotblocks/             <- drop into the C4D plugins folder (Mac)
                shotblocks.pyp, sb_*.py, res/
                shotblocks.xlib     (mac native build)
                web/                (built web bundle: dist/index.html)
                docs/               (bundled user manual)
        Windows/
            shotblocks/             <- drop into the C4D plugins folder (Windows)
                ... same, with shotblocks.xdl64 + vendor/ (minimp3.dll)

    dist/Shotblocks <version>.zip   (with --zip)

Version defaults to the latest git tag (v1.1.0 -> "1.1.0"); override with
--version. Native binaries come from the committed native/builds/<platform>/
trees (stamped by tools/native_stamp.py — the packager warns loudly when a
binary is stale or missing). The web bundle comes from
host/shotblocks/web/dist (run `npm run build` there first) with the host
machine's installed plugin as fallback.

Typical use:
    python3 tools/package_plugin.py --zip                 # both platforms
    python3 tools/package_plugin.py --platform mac --zip  # mac half only
"""
import argparse
import os
import shutil
import subprocess
import sys
from glob import glob

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NATIVE_NAME = "shotblocks"
NATIVE_BIN = {"mac": "shotblocks.xlib", "win": "shotblocks.xdl64"}

DIR_FILTERS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".git"}
FILE_FILTERS = (".pyc", ".pyo", ".log", ".tmp", ".bak", ".pdb")


def latest_git_tag():
    try:
        tag = subprocess.check_output(
            ["git", "describe", "--tags", "--abbrev=0"],
            cwd=REPO_ROOT, text=True,
        ).strip()
        return tag.lstrip("v")
    except Exception:
        return None


def first_existing(paths):
    for p in paths:
        if p and os.path.isdir(p):
            return p
    return None


def installed_plugin_dirs():
    """Installed shotblocks plugin folders, used as fallback artifact sources."""
    if sys.platform == "darwin":
        pattern = os.path.expanduser(
            "~/Library/Preferences/Maxon/Maxon Cinema 4D 2026*/plugins/shotblocks"
        )
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        pattern = os.path.join(appdata, "Maxon", "Maxon Cinema 4D 2026*", "plugins", "shotblocks")
    else:
        return []
    return sorted(glob(pattern), key=os.path.getmtime, reverse=True)


def native_candidates(os_key):
    # Committed builds in the repo come first: they let EITHER machine package
    # both platforms. native_stamp.py guards them against source drift.
    builds = os.path.join(REPO_ROOT, "native", "builds")
    if os_key == "mac":
        return [
            os.environ.get("SB_NATIVE_MAC_SOURCE"),
            os.path.join(builds, "macos_arm64", NATIVE_NAME),
            os.path.expanduser(
                "~/Dev/c4d_sdk_2026/_build_ninja/bin/Release/plugins/" + NATIVE_NAME),
        ]
    return [
        os.environ.get("SB_NATIVE_WIN_SOURCE"),
        os.path.join(builds, "win64", NATIVE_NAME),
        "C:/Dev/c4d_sdk_2026/build-win64/bin/Release/plugins/" + NATIVE_NAME,
    ]


def web_candidates():
    cands = [
        os.environ.get("SB_WEB_SOURCE"),
        os.path.join(REPO_ROOT, "host", "shotblocks", "web", "dist"),
    ]
    for plug in installed_plugin_dirs():
        cands.append(os.path.join(plug, "web"))
    return cands


def strip_dev_content(root):
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        for d in list(dirnames):
            if d in DIR_FILTERS:
                shutil.rmtree(os.path.join(dirpath, d))
                dirnames.remove(d)
        for f in filenames:
            if f.endswith(FILE_FILTERS):
                os.remove(os.path.join(dirpath, f))


def build_platform(os_key, os_folder, package_root, warnings):
    plugin_dir = os.path.join(package_root, os_folder, "shotblocks")
    os.makedirs(os.path.dirname(plugin_dir), exist_ok=True)

    # Python plugin: src/ minus the vendor rebuild sources. The vendored
    # minimp3.dll is Windows-only (and currently unused by the Python
    # side) — the Mac half ships without vendor/.
    def ignore_src(dirpath, names):
        drop = set()
        rel = os.path.relpath(dirpath, os.path.join(REPO_ROOT, "src"))
        if rel == "vendor":
            drop.add("build")
            if os_key == "mac":
                drop.update(n for n in names if n != "minimp3_LICENSE.txt")
        return drop

    shutil.copytree(os.path.join(REPO_ROOT, "src"), plugin_dir, ignore=ignore_src)

    # Bundled user manual (docs/index.html, opened via open-manual).
    docs = os.path.join(REPO_ROOT, "host", "shotblocks", "docs")
    if os.path.isdir(docs):
        shutil.copytree(docs, os.path.join(plugin_dir, "docs"))

    # Built web bundle (vite single-file dist). REQUIRED for the timeline UI.
    web = first_existing(web_candidates())
    if web and os.path.isfile(os.path.join(web, "index.html")):
        shutil.copytree(web, os.path.join(plugin_dir, "web"))
        # The url-override is a dev affordance only — never ship it.
        ov = os.path.join(plugin_dir, "web", "url-override.txt")
        if os.path.isfile(ov):
            os.remove(ov)
        print(f"  [{os_folder}] web/ <- {web}")
    else:
        warnings.append(
            f"{os_folder}: no built web bundle found — the timeline UI will "
            f"be blank. Run `npm run build` in host/shotblocks/web first."
        )

    # Native module binary, next to the .pyp (mirrors scripts/deploy.ps1).
    native = first_existing(native_candidates(os_key))
    bin_name = NATIVE_BIN[os_key]
    if native and os.path.isfile(os.path.join(native, bin_name)):
        shutil.copy2(os.path.join(native, bin_name), os.path.join(plugin_dir, bin_name))
        print(f"  [{os_folder}] {bin_name} <- {native}")
        # Staleness guard for stamped (repo-committed) builds.
        if os.path.isfile(os.path.join(native, "build_info.txt")):
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import native_stamp
            ok, msg = native_stamp.check(native)
            if not ok:
                warnings.append(f"{os_folder}: {msg}")
    else:
        if os_key == "mac":
            hint = ("run tools/build_native_mac.sh (also refreshes "
                    "native/builds/macos_arm64), or set SB_NATIVE_MAC_SOURCE")
        else:
            hint = ("on the Windows machine: build host/shotblocks, copy the "
                    "built folder to native/builds/win64/shotblocks/, stamp it "
                    "with `python tools/native_stamp.py write "
                    "native/builds/win64/shotblocks`, and commit")
        warnings.append(
            f"{os_folder}: native {bin_name} not found — the timeline plugin "
            f"will not load. To fix: {hint}."
        )

    strip_dev_content(plugin_dir)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="package version (default: latest git tag)")
    ap.add_argument("--platform", choices=("all", "mac", "win"), default="all")
    ap.add_argument("--zip", action="store_true",
                    help="also write dist/Shotblocks <version>.zip")
    args = ap.parse_args()

    version = args.version or latest_git_tag()
    if not version:
        ap.error("no git tag found; pass --version")

    # The OUTER dir + zip are versioned (so the download is clearly labeled),
    # but the INNER plugin folder is plain "shotblocks" so it drops straight
    # into the C4D plugins folder as plugins/shotblocks/.
    name = f"Shotblocks {version}"
    dist = os.path.join(REPO_ROOT, "dist")
    package_root = os.path.join(dist, name)
    if os.path.isdir(package_root):
        shutil.rmtree(package_root)
    os.makedirs(package_root, exist_ok=True)

    targets = {"mac": ("mac", "MacOS"), "win": ("win", "Windows")}
    selected = ("mac", "win") if args.platform == "all" else (args.platform,)

    warnings = []
    for key in selected:
        os_key, os_folder = targets[key]
        print(f"Packaging {os_folder}/shotblocks ...")
        build_platform(os_key, os_folder, package_root, warnings)

    if args.zip:
        zip_base = os.path.join(dist, name)
        if os.path.isfile(zip_base + ".zip"):
            os.remove(zip_base + ".zip")
        shutil.make_archive(zip_base, "zip", root_dir=dist, base_dir=name)
        print(f"Wrote zip: {zip_base}.zip")

    print(f"Wrote package: {package_root}")
    if warnings:
        print("\nWARNINGS:")
        for w in warnings:
            print(f"  ! {w}")
        sys.exit(1)


if __name__ == "__main__":
    main()

"""Font discovery for the typeset tool.

Scans the app's bundled ``fonts/`` folder plus the OS font directories,
extracts family/style names and Cyrillic coverage with fontTools, and keeps
a per-file disk cache (keyed by mtime) so rescans are cheap. Falls back to
the legacy six-family list when fontTools is unavailable.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
from pathlib import Path

log = logging.getLogger("mangacleaner")

BUNDLED_DIR = Path(__file__).resolve().parents[2] / "fonts"
FONT_EXTS = {".ttf", ".otf", ".ttc"}
CACHE_FILE = Path.home() / ".cache" / "mangacleaner" / "fontcache.json"

_lock = threading.Lock()
_registry: list[dict] | None = None


def _os_font_dirs() -> list[Path]:
    if sys.platform == "win32":
        windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
        local = os.environ.get("LOCALAPPDATA")
        dirs = [windir / "Fonts"]
        if local:
            dirs.append(Path(local) / "Microsoft" / "Windows" / "Fonts")
        return dirs
    if sys.platform == "darwin":
        return [Path("/System/Library/Fonts"), Path("/Library/Fonts"),
                Path.home() / "Library" / "Fonts"]
    return [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"),
            Path.home() / ".fonts", Path.home() / ".local" / "share" / "fonts"]


def _probe(path: Path) -> dict | None:
    """family/style/cyrillic for one font file, or None if unparsable."""
    from fontTools.ttLib import TTFont
    try:
        kwargs = {"fontNumber": 0} if path.suffix.lower() == ".ttc" else {}
        f = TTFont(str(path), lazy=True, **kwargs)
        name = f["name"]
        family = (name.getDebugName(16) or name.getDebugName(1) or path.stem)
        style = (name.getDebugName(17) or name.getDebugName(2) or "Regular")
        cmap = f.getBestCmap() or {}
        cyr = 0x0410 in cmap and 0x044F in cmap
        f.close()
        return {"family": family.strip(), "style": style.strip(),
                "supportsCyrillic": bool(cyr)}
    except Exception:
        return None


def _load_cache() -> dict:
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cache(cache: dict) -> None:
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(cache), encoding="utf-8")
    except OSError:
        pass


def _legacy_fonts() -> list[dict]:
    from .typeset import FONT_FILES
    out = []
    for fam, (regular, _bold) in FONT_FILES.items():
        for d in _os_font_dirs():
            p = d / regular
            if p.is_file():
                out.append({"family": fam.capitalize(), "style": "Regular",
                            "source": "system", "path": str(p),
                            "supportsCyrillic": True})
                break
    return out


def _scan() -> list[dict]:
    try:
        import fontTools
    except ImportError:
        log.warning("fontTools not installed — using the legacy font list "
                    "(pip install fonttools for the full picker).")
        return _legacy_fonts()

    cache = _load_cache()
    fresh: dict = {}
    found: list[dict] = []
    sources = [("bundled", BUNDLED_DIR)] + [("system", d) for d in _os_font_dirs()]
    seen: set[str] = set()
    for source, root in sources:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.suffix.lower() not in FONT_EXTS or not path.is_file():
                continue
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            entry = cache.get(key)
            if not entry or entry.get("mtime") != mtime:
                meta = _probe(path)
                if meta is None:
                    fresh[key] = {"mtime": mtime, "bad": True}
                    continue
                entry = {"mtime": mtime, **meta}
            if entry.get("bad"):
                fresh[key] = entry
                continue
            fresh[key] = entry
            found.append({"family": entry["family"], "style": entry["style"],
                          "source": source, "path": key,
                          "supportsCyrillic": entry["supportsCyrillic"]})
    _save_cache(fresh)
    found.sort(key=lambda f: (f["source"] != "bundled",
                              f["family"].lower(), f["style"].lower()))
    for i, f in enumerate(found):
        f["id"] = i
    return found


def list_fonts(refresh: bool = False) -> list[dict]:
    global _registry
    with _lock:
        if _registry is None or refresh:
            _registry = _scan()
            log.info("Font scan: %d fonts", len(_registry))
        return _registry


def get_font_path(font_id: int) -> Path:
    """Resolve a registry id to its file — only paths from the scan are
    served, never arbitrary ones."""
    fonts = list_fonts()
    if 0 <= font_id < len(fonts):
        return Path(fonts[font_id]["path"])
    raise KeyError(font_id)

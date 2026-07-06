from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from ..core import SUPPORTED_EXTS, load_image, save_image
from ..core.pipeline import clean_page, detect_mask
from ..core.typeset import render_texts

log = logging.getLogger("mangacleaner")

PROJECTS_ROOT = Path(os.environ.get(
    "MANGACLEANER_PROJECTS_DIR",
    Path(__file__).resolve().parents[2] / "projects"))
_LEGACY_ROOT = Path.home() / "Documents" / "MangaCleanerStudio"


def migrate_legacy_projects() -> None:
    """One-time move of projects from Documents/MangaCleanerStudio into the
    app's own projects/ folder, where users can find and manage them."""
    if not _LEGACY_ROOT.is_dir() or _LEGACY_ROOT == PROJECTS_ROOT:
        return
    for d in list(_LEGACY_ROOT.iterdir()):
        if not (d / "project.json").is_file():
            continue
        dest = PROJECTS_ROOT / d.name
        if dest.exists():
            continue
        PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(d), str(dest))
            log.info("Migrated project '%s' to %s", d.name, dest)
        except OSError as e:
            log.warning("Could not migrate project '%s': %s", d.name, e)

(ST_PENDING, ST_MASKED, ST_PROCESSING, ST_DONE, ST_EDITED, ST_SKIPPED,
 ST_ERROR) = ("pending", "masked", "processing", "done", "edited", "skipped",
              "error")


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def sanitize_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip().rstrip(".")
    return name[:60]


def imwrite_u(path: Path, img: np.ndarray) -> None:
    ok, buf = cv2.imencode(path.suffix or ".png", img)
    if not ok:
        raise IOError(f"encode failed: {path}")
    data = buf.tobytes()
    for attempt in range(5):
        try:
            path.write_bytes(data)
            return
        except OSError as e:
            err = e
            time.sleep(0.2 * (attempt + 1))
    raise err


def imread_gray_u(path: Path) -> np.ndarray | None:
    try:
        buf = np.frombuffer(path.read_bytes(), np.uint8)
        return cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    except (OSError, ValueError):
        return None


@dataclass
class Page:
    name: str
    src: Path
    mask: Path | None = None
    mask_source: str = "none"
    result: Path | None = None
    status: str = ST_PENDING
    error: str | None = None
    version: int = 0

    def to_dict(self, index: int) -> dict:
        return {"index": index, "name": self.name, "status": self.status,
                "error": self.error, "hasResult": self.result is not None,
                "hasMask": self.mask is not None,
                "maskSource": self.mask_source, "version": self.version}


@dataclass
class Job:
    total: int = 0
    done: int = 0
    errors: int = 0
    current: str = ""
    running: bool = False
    cancel: bool = False


class Project:
    def __init__(self) -> None:
        self.name: str | None = None
        self.project_dir: Path | None = None
        self.src_dir: Path | None = None
        self.last_page: int = 0
        self.pages: list[Page] = []
        self.job = Job()
        self._job_thread: threading.Thread | None = None
        self._mutate = threading.Lock()
        migrate_legacy_projects()

    def close(self) -> None:
        self.name = None
        self.project_dir = None
        self.src_dir = None
        self.last_page = 0
        self.pages = []
        self.job = Job()

    @property
    def workdir(self) -> Path | None:
        return self.project_dir

    @staticmethod
    def list_projects() -> list[dict]:
        out = []
        if not PROJECTS_ROOT.is_dir():
            return out
        for d in PROJECTS_ROOT.iterdir():
            meta = d / "project.json"
            if not meta.is_file():
                continue
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
                out.append({"name": data.get("name", d.name),
                            "pages": len(data.get("pages", [])),
                            "modified": meta.stat().st_mtime})
            except (OSError, json.JSONDecodeError):
                continue
        out.sort(key=lambda p: -p["modified"])
        return out

    @staticmethod
    def delete_project(name: str) -> None:
        d = PROJECTS_ROOT / sanitize_name(name)
        if not (d / "project.json").is_file():
            raise ValueError("project_not_found")
        shutil.rmtree(d)

    @staticmethod
    def project_cover(name: str, width: int = 220) -> Path:
        """Cached thumbnail of a project's first page for the projects list."""
        d = PROJECTS_ROOT / sanitize_name(name)
        meta = d / "project.json"
        if not meta.is_file():
            raise ValueError("project_not_found")
        cover = d / "thumbs" / "cover.jpg"
        if cover.is_file():
            return cover
        data = json.loads(meta.read_text(encoding="utf-8"))
        pages = data.get("pages") or []
        if not pages:
            raise ValueError("no_pages")
        src = Path(pages[0]["src"])
        if not src.is_file():
            src = d / "sources" / pages[0]["name"]
        if not src.is_file():
            raise ValueError("no_pages")
        img = load_image(src)
        h, w = img.shape[:2]
        img = cv2.resize(img, (width, max(1, int(h * width / w))),
                         interpolation=cv2.INTER_AREA)
        img = img[:min(img.shape[0], int(width * 1.4))]
        cover.parent.mkdir(parents=True, exist_ok=True)
        imwrite_u(cover, img)
        return cover

    def add_pages(self, paths: list[Path]) -> int:
        """Copy new images into an open project; duplicates (by name) are
        skipped. Page indices shift after the natural re-sort, so every
        version is bumped to invalidate index-keyed thumbnails."""
        if not self.project_dir:
            raise ValueError("no_project")
        existing = {p.name for p in self.pages}
        added = 0
        for p in paths:
            if p.suffix.lower() not in SUPPORTED_EXTS or p.name in existing:
                continue
            dst = self.project_dir / "sources" / p.name
            if p.resolve() != dst.resolve():
                shutil.copy2(p, dst)
            self.pages.append(Page(name=dst.name, src=dst))
            existing.add(dst.name)
            added += 1
        if added:
            self.pages.sort(key=lambda pg: natural_key(pg.name))
            for pg in self.pages:
                pg.version += 1
            (self.project_dir / "thumbs" / "cover.jpg").unlink(missing_ok=True)
            self.save()
        return added

    def _init_dirs(self) -> None:
        for sub in ("sources", "masks", "results", "texts", "output", "thumbs"):
            (self.project_dir / sub).mkdir(parents=True, exist_ok=True)

    def create(self, name: str, folder: Path | None = None,
               uploads: list[Path] | None = None) -> int:
        name = sanitize_name(name)
        if not name:
            raise ValueError("bad_name")
        project_dir = PROJECTS_ROOT / name
        if (project_dir / "project.json").is_file():
            raise ValueError("project_exists")

        if folder is not None:
            paths = [p for p in folder.iterdir()
                     if p.suffix.lower() in SUPPORTED_EXTS
                     and not p.stem.endswith(("_clean", "_mask"))]
            src_dir = folder
        else:
            paths = list(uploads or [])
            src_dir = None
        if not paths:
            raise ValueError("no_images")

        self.name = name
        self.project_dir = project_dir
        self._init_dirs()
        if src_dir is None:
            stored = []
            for p in paths:
                dst = self.project_dir / "sources" / p.name
                if p.resolve() != dst.resolve():
                    shutil.copy2(p, dst)
                stored.append(dst)
            paths = stored

        paths.sort(key=lambda p: natural_key(p.name))
        self.src_dir = src_dir
        self.last_page = 0
        self.pages = [Page(name=p.name, src=p) for p in paths]
        self.job = Job()
        self.save()
        return len(paths)

    def open(self, name: str) -> int:
        project_dir = PROJECTS_ROOT / sanitize_name(name)
        meta_path = project_dir / "project.json"
        if not meta_path.is_file():
            raise ValueError("project_not_found")
        data = json.loads(meta_path.read_text(encoding="utf-8"))

        self.name = data["name"]
        self.project_dir = project_dir
        self._init_dirs()
        self.src_dir = Path(data["srcDir"]) if data.get("srcDir") else None
        self.last_page = int(data.get("lastPage", 0))
        self.pages = []
        for p in data.get("pages", []):
            src = Path(p["src"])
            if not src.is_file():
                alt = project_dir / "sources" / p["name"]
                if alt.is_file():
                    src = alt
            page = Page(name=p["name"], src=src,
                        mask_source=p.get("maskSource", "none"),
                        status=p.get("status", ST_PENDING),
                        error=p.get("error"),
                        version=int(p.get("version", 0)))
            mask = project_dir / "masks" / f"{Path(page.name).stem}.png"
            result = project_dir / "results" / page.name
            page.mask = mask if mask.is_file() else None
            page.result = result if result.is_file() else None
            if page.mask is None:
                page.mask_source = "none"
            if page.result is None and page.status in (ST_DONE, ST_EDITED,
                                                       ST_PROCESSING):
                page.status = ST_MASKED if page.mask is not None else ST_PENDING
            if not src.is_file():
                page.status = ST_ERROR
                page.error = "source_missing"
            self.pages.append(page)
        self.job = Job()
        self.last_page = min(self.last_page, max(0, len(self.pages) - 1))
        return len(self.pages)

    def save(self) -> None:
        if not self.project_dir:
            return
        data = {
            "name": self.name,
            "srcDir": str(self.src_dir) if self.src_dir else None,
            "lastPage": self.last_page,
            "saved": time.time(),
            "pages": [{"name": p.name, "src": str(p.src), "status": p.status,
                       "maskSource": p.mask_source, "error": p.error,
                       "version": p.version} for p in self.pages],
        }
        payload = json.dumps(data, ensure_ascii=False, indent=1)
        tmp = self.project_dir / "project.json.tmp"
        for attempt in range(5):
            try:
                tmp.write_text(payload, encoding="utf-8")
                tmp.replace(self.project_dir / "project.json")
                return
            except OSError as e:
                err = e
                time.sleep(0.2 * (attempt + 1))
        log.warning("project.json save failed (will retry on next change): %s", err)

    def set_last_page(self, index: int) -> None:
        self.last_page = max(0, min(index, len(self.pages) - 1))
        self.save()

    def suggested_output(self) -> str:
        return str(self.project_dir / "output") if self.project_dir else ""

    def state(self) -> dict:
        return {
            "name": self.name,
            "projectDir": str(self.project_dir) if self.project_dir else None,
            "srcDir": str(self.src_dir) if self.src_dir else None,
            "lastPage": self.last_page,
            "suggestedOutput": self.suggested_output(),
            "pages": [p.to_dict(i) for i, p in enumerate(self.pages)],
        }

    def _mask_path(self, page: Page) -> Path:
        return self.project_dir / "masks" / f"{Path(page.name).stem}.png"

    def _write_mask(self, page: Page, mask, source: str) -> None:
        if mask is None:
            shape = load_image(page.src).shape[:2]
            mask = np.zeros(shape, np.uint8)
        imwrite_u(self._mask_path(page), mask)
        page.mask = self._mask_path(page)
        page.mask_source = source
        page.version += 1

    def _stored_mask(self, page: Page):
        if page.mask_source != "none" and page.mask and page.mask.is_file():
            return imread_gray_u(page.mask)
        return None

    def save_mask(self, index: int, mask) -> Page:
        page = self.pages[index]
        if mask is not None:
            img = load_image(page.src)
            if mask.shape != img.shape[:2]:
                mask = cv2.resize(mask, (img.shape[1], img.shape[0]),
                                  interpolation=cv2.INTER_NEAREST)
        self._write_mask(page, mask, "user")
        if page.status in (ST_PENDING, ST_SKIPPED):
            page.status = ST_MASKED
        self.save()
        return page

    def detect_one(self, page: Page, settings: dict) -> None:
        img = load_image(page.src)
        mask = detect_mask(img,
                           detect=settings.get("detect", "both"),
                           detector=settings.get("detector", "auto"),
                           dilate=int(settings.get("dilate", 6)),
                           device=settings.get("device", "auto"))
        self._write_mask(page, mask, "auto")
        page.error = None

    def _texts_path(self, page: Page) -> Path:
        return self.project_dir / "texts" / f"{Path(page.name).stem}.json"

    def get_texts(self, index: int) -> list[dict]:
        path = self._texts_path(self.pages[index])
        if not path.is_file():
            return []
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []

    def set_texts(self, index: int, items: list[dict]) -> None:
        path = self._texts_path(self.pages[index])
        if items:
            path.write_text(json.dumps(items, ensure_ascii=False),
                            encoding="utf-8")
        elif path.is_file():
            path.unlink()

    def _result_path(self, page: Page) -> Path:
        return self.project_dir / "results" / page.name

    def current_canvas(self, page: Page) -> np.ndarray:
        if page.result and page.result.is_file():
            return load_image(page.result)
        return load_image(page.src)

    def set_result(self, index: int, img_bgr: np.ndarray) -> Page:
        page = self.pages[index]
        base = load_image(page.src)
        if img_bgr.shape[:2] != base.shape[:2]:
            img_bgr = cv2.resize(img_bgr, (base.shape[1], base.shape[0]),
                                 interpolation=cv2.INTER_LANCZOS4)
        save_image(img_bgr, self._result_path(page))
        page.result = self._result_path(page)
        page.status = ST_EDITED
        page.error = None
        page.version += 1
        self.save()
        return page

    def heal(self, index: int, mask: np.ndarray, settings: dict | None = None) -> Page:
        page = self.pages[index]
        settings = settings or {}
        img = self.current_canvas(page)
        if mask.shape != img.shape[:2]:
            mask = cv2.resize(mask, (img.shape[1], img.shape[0]),
                              interpolation=cv2.INTER_NEAREST)
        healed = clean_page(img, mask,
                            model=settings.get("model", "lama"),
                            feather=0,
                            device=settings.get("device", "auto"))
        save_image(healed, self._result_path(page))
        page.result = self._result_path(page)
        page.status = ST_EDITED
        page.version += 1
        self.save()
        return page

    def _run_one(self, page: Page, settings: dict, mask=None) -> None:
        img = load_image(page.src)
        explicit = mask is not None
        if not explicit:
            mask = self._stored_mask(page)
        if mask is None:
            mask = detect_mask(img,
                               detect=settings.get("detect", "both"),
                               detector=settings.get("detector", "auto"),
                               dilate=int(settings.get("dilate", 6)),
                               device=settings.get("device", "auto"))
            self._write_mask(page, mask, "auto")
        elif mask.shape != img.shape[:2]:
            mask = cv2.resize(mask, (img.shape[1], img.shape[0]),
                              interpolation=cv2.INTER_NEAREST)
        if explicit:
            self._write_mask(page, mask, "user")

        if mask.max() == 0:
            result = img
        else:
            result = clean_page(img, mask,
                                model=settings.get("model", "lama"),
                                feather=int(settings.get("feather", 3)),
                                device=settings.get("device", "auto"))
        save_image(result, self._result_path(page))
        page.result = self._result_path(page)
        page.error = None
        page.version += 1

    def clean_single(self, index: int, settings: dict, mask=None) -> Page:
        page = self.pages[index]
        with self._mutate:
            page.status = ST_PROCESSING
        try:
            self._run_one(page, settings, mask=mask)
            page.status = ST_EDITED if (mask is not None
                                        or page.mask_source == "user") else ST_DONE
        except Exception as e:
            page.status = ST_ERROR
            page.error = str(e)
            raise
        finally:
            self.save()
        return page

    def start_batch(self, settings: dict, force: bool, mode: str = "clean") -> int:
        if self.job.running:
            if self._job_thread is not None and self._job_thread.is_alive():
                raise RuntimeError("job_running")
            log.warning("stale batch job detected — resetting")
            self.job = Job()
        if mode == "detect":
            todo = [p for p in self.pages if p.mask_source != "user"
                    and (force or p.status in (ST_PENDING, ST_ERROR))]
        else:
            todo = [p for p in self.pages
                    if force or p.status in (ST_PENDING, ST_MASKED, ST_ERROR)]
        self.job = Job(total=len(todo), running=len(todo) > 0)
        if not todo:
            return 0

        def worker() -> None:
            try:
                for page in todo:
                    if self.job.cancel:
                        break
                    self.job.current = page.name
                    page.status = ST_PROCESSING
                    try:
                        if mode == "detect":
                            self.detect_one(page, settings)
                            page.status = ST_MASKED
                        else:
                            self._run_one(page, settings)
                            page.status = ST_EDITED if page.mask_source == "user" else ST_DONE
                    except Exception as e:
                        page.status = ST_ERROR
                        page.error = str(e)
                        self.job.errors += 1
                    self.job.done += 1
                    self.save()
            except Exception:
                log.exception("batch worker crashed")
            finally:
                for page in todo:
                    if page.status == ST_PROCESSING:
                        page.status = ST_PENDING
                self.job.running = False
                self.job.current = ""
                self.save()

        self._job_thread = threading.Thread(target=worker, daemon=True)
        self._job_thread.start()
        return len(todo)

    def revert(self, index: int) -> Page:
        page = self.pages[index]
        page.result = None
        page.mask = None
        page.mask_source = "none"
        page.status = ST_SKIPPED
        page.error = None
        page.version += 1
        self.save()
        return page

    def export(self, out_dir: Path | None = None) -> dict:
        if not self.pages:
            raise ValueError("no_project")
        out_dir = out_dir or (self.project_dir / "output")
        out_dir.mkdir(parents=True, exist_ok=True)
        cleaned = kept = typeset = 0
        for i, page in enumerate(self.pages):
            dst = out_dir / page.name
            texts = self.get_texts(i)
            if texts:
                img = render_texts(self.current_canvas(page), texts)
                save_image(img, dst)
                typeset += 1
                cleaned += 1 if page.result else 0
                kept += 0 if page.result else 1
            elif page.result and page.result.is_file():
                shutil.copy2(page.result, dst)
                cleaned += 1
            else:
                shutil.copy2(page.src, dst)
                kept += 1
        zip_path = self.project_dir / "chapter_cleaned.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for page in self.pages:
                zf.write(out_dir / page.name, page.name)
        return {"cleaned": cleaned, "kept": kept, "typeset": typeset,
                "outDir": str(out_dir), "zip": str(zip_path)}

    def thumbnail(self, index: int, width: int = 180) -> Path:
        page = self.pages[index]
        src = page.result if (page.result and page.result.is_file()) else page.src
        thumb_dir = self.project_dir / "thumbs"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        thumb = thumb_dir / f"{index}_{page.version}.jpg"
        if not thumb.is_file():
            for old in thumb_dir.glob(f"{index}_*.jpg"):
                old.unlink(missing_ok=True)
            img = load_image(src)
            h, w = img.shape[:2]
            scale = width / w
            img = cv2.resize(img, (width, max(1, int(h * scale))),
                             interpolation=cv2.INTER_AREA)
            imwrite_u(thumb, img)
        return thumb

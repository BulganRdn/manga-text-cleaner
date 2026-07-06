from __future__ import annotations

import base64
import logging
import tempfile
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..core import load_image
from ..core.pipeline import detect_mask, get_meta
from .. import __version__
from .project import Project, sanitize_name

log = logging.getLogger("mangacleaner")

app = FastAPI(title="Manga Text Cleaner Studio", version=__version__)
project = Project()

STATIC_DIR = Path(__file__).parent / "static"


class CreateProjectBody(BaseModel):
    name: str
    path: str | None = None


class Settings(BaseModel):
    detect: str = "both"
    detector: str = "auto"
    model: str = "lama"
    device: str = "auto"
    dilate: int = 6
    feather: int = 3


class ProcessBody(BaseModel):
    settings: Settings = Settings()
    force: bool = False
    mode: str = "clean"


class CleanBody(BaseModel):
    settings: Settings = Settings()
    mask: str | None = None


class MaskBody(BaseModel):
    mask: str | None = None


class ImageBody(BaseModel):
    image: str


class TextsBody(BaseModel):
    items: list[dict] = []


class StateBody(BaseModel):
    lastPage: int


class ExportBody(BaseModel):
    outDir: str | None = None


def _page_or_404(index: int):
    if index < 0 or index >= len(project.pages):
        raise HTTPException(404, "page_not_found")
    return project.pages[index]


def _decode_data_url(data_url: str, flags: int) -> np.ndarray:
    try:
        b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
        buf = np.frombuffer(base64.b64decode(b64), np.uint8)
        img = cv2.imdecode(buf, flags)
        if img is None:
            raise ValueError("decode failed")
        return img
    except Exception as e:
        raise HTTPException(400, f"bad_image: {e}")


def _decode_mask(data_url: str) -> np.ndarray:
    img = _decode_data_url(data_url, cv2.IMREAD_UNCHANGED)
    if img.ndim == 3 and img.shape[2] == 4 and img[:, :, 3].max() > 0 \
            and img[:, :, 3].min() < 255:
        chan = img[:, :, 3]
    elif img.ndim == 3:
        chan = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)
    else:
        chan = img
    return ((chan > 127).astype(np.uint8)) * 255


@app.get("/api/meta")
def meta():
    return {"version": __version__, **get_meta()}


@app.get("/api/projects")
def list_projects():
    return {"projects": Project.list_projects()}


@app.post("/api/projects")
def create_project(body: CreateProjectBody):
    if not body.path:
        raise HTTPException(400, "folder_required")
    folder = Path(body.path.strip().strip('"'))
    if not folder.is_dir():
        raise HTTPException(400, "folder_not_found")
    try:
        project.create(body.name, folder=folder)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return project.state()


@app.post("/api/projects/upload")
async def create_project_upload(name: str = Form(...),
                                files: list[UploadFile] = File(...)):
    updir = Path(tempfile.mkdtemp(prefix="manga_upload_"))
    saved = []
    for f in files:
        fname = Path(f.filename or "page.png").name
        if Path(fname).suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        dst = updir / fname
        dst.write_bytes(await f.read())
        saved.append(dst)
    try:
        project.create(name, uploads=saved)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return project.state()


@app.post("/api/projects/{name}/open")
def open_project(name: str):
    try:
        project.open(name)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return project.state()


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    is_open = project.name == sanitize_name(name)
    if is_open and project.job.running:
        raise HTTPException(409, "job_running")
    try:
        Project.delete_project(name)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except OSError as e:
        raise HTTPException(500, f"delete_failed: {e}")
    if is_open:
        project.close()
    return {"ok": True}


@app.get("/api/projects/{name}/cover")
def project_cover(name: str):
    try:
        return FileResponse(Project.project_cover(name))
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/api/project/pages/upload")
async def add_pages_upload(files: list[UploadFile] = File(...)):
    if not project.pages:
        raise HTTPException(400, "no_project")
    updir = Path(tempfile.mkdtemp(prefix="manga_addpages_"))
    saved = []
    for f in files:
        fname = Path(f.filename or "page.png").name
        if Path(fname).suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        dst = updir / fname
        dst.write_bytes(await f.read())
        saved.append(dst)
    try:
        added = project.add_pages(saved)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {**project.state(), "added": added}


@app.get("/api/project")
def get_project():
    return project.state()


@app.post("/api/project/state")
def set_state(body: StateBody):
    if project.pages:
        project.set_last_page(body.lastPage)
    return {"ok": True}


@app.get("/api/pages/{index}/original")
def page_original(index: int):
    return FileResponse(_page_or_404(index).src)


@app.get("/api/pages/{index}/result")
def page_result(index: int):
    page = _page_or_404(index)
    if not page.result or not page.result.is_file():
        raise HTTPException(404, "no_result")
    return FileResponse(page.result)


@app.get("/api/pages/{index}/mask")
def page_mask(index: int):
    page = _page_or_404(index)
    if not page.mask or not page.mask.is_file():
        raise HTTPException(404, "no_mask")
    return FileResponse(page.mask)


@app.get("/api/pages/{index}/thumb")
def page_thumb(index: int):
    _page_or_404(index)
    return FileResponse(project.thumbnail(index))


@app.post("/api/pages/{index}/detect")
def page_detect(index: int, body: CleanBody):
    page = _page_or_404(index)
    img = load_image(page.src)
    s = body.settings
    mask = detect_mask(img, detect=s.detect, detector=s.detector, dilate=s.dilate,
                       device=s.device)
    n = cv2.connectedComponents((mask > 0).astype(np.uint8))[0] - 1
    ok, buf = cv2.imencode(".png", mask)
    return {"mask": "data:image/png;base64," + base64.b64encode(buf).decode(),
            "regions": int(n)}


@app.post("/api/pages/{index}/mask")
def page_save_mask(index: int, body: MaskBody):
    _page_or_404(index)
    mask = _decode_mask(body.mask) if body.mask else None
    return project.save_mask(index, mask).to_dict(index)


@app.post("/api/pages/{index}/clean")
def page_clean(index: int, body: CleanBody):
    page = _page_or_404(index)
    mask = _decode_mask(body.mask) if body.mask else None
    try:
        project.clean_single(index, body.settings.model_dump(), mask=mask)
    except Exception as e:
        raise HTTPException(500, str(e))
    return page.to_dict(index)


@app.post("/api/pages/{index}/result")
def page_set_result(index: int, body: ImageBody):
    _page_or_404(index)
    img = _decode_data_url(body.image, cv2.IMREAD_COLOR)
    return project.set_result(index, img).to_dict(index)


@app.post("/api/pages/{index}/heal")
def page_heal(index: int, body: CleanBody):
    _page_or_404(index)
    if not body.mask:
        raise HTTPException(400, "mask_required")
    mask = _decode_mask(body.mask)
    return project.heal(index, mask, body.settings.model_dump()).to_dict(index)


@app.get("/api/pages/{index}/texts")
def page_get_texts(index: int):
    _page_or_404(index)
    return {"items": project.get_texts(index)}


@app.post("/api/pages/{index}/texts")
def page_set_texts(index: int, body: TextsBody):
    _page_or_404(index)
    project.set_texts(index, body.items)
    return {"ok": True, "count": len(body.items)}


@app.post("/api/pages/{index}/revert")
def page_revert(index: int):
    _page_or_404(index)
    return project.revert(index).to_dict(index)


@app.post("/api/process")
def process_all(body: ProcessBody):
    if not project.pages:
        raise HTTPException(400, "no_project")
    if body.mode not in ("clean", "detect"):
        raise HTTPException(400, "bad_mode")
    try:
        count = project.start_batch(body.settings.model_dump(), body.force,
                                    mode=body.mode)
    except RuntimeError:
        raise HTTPException(409, "job_running")
    return {"queued": count}


@app.get("/api/job")
def job_status():
    j = project.job
    return {"running": j.running, "total": j.total, "done": j.done,
            "errors": j.errors, "current": j.current,
            "pages": [p.to_dict(i) for i, p in enumerate(project.pages)]}


@app.post("/api/job/cancel")
def job_cancel():
    project.job.cancel = True
    return {"ok": True}


@app.post("/api/export")
def export(body: ExportBody):
    out = Path(body.outDir.strip().strip('"')) if (body.outDir
                                                   and body.outDir.strip()) else None
    try:
        return project.export(out)
    except ValueError:
        raise HTTPException(400, "no_project")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/export/zip")
def export_zip():
    if not project.project_dir:
        raise HTTPException(404, "no_zip")
    zip_path = project.project_dir / "chapter_cleaned.zip"
    if not zip_path.is_file():
        raise HTTPException(404, "no_zip")
    return FileResponse(zip_path, filename="chapter_cleaned.zip")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

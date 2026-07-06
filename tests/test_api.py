from __future__ import annotations

import base64
import shutil
import sys
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2
import numpy as np
from fastapi.testclient import TestClient

from mangacleaner.server import app as app_module
from mangacleaner.server.project import PROJECTS_ROOT

client = TestClient(app_module.app)
SAMPLE = Path(__file__).resolve().parents[1] / "examples" / "sample_1.jpg"

OPENCV = {"detect": "both", "detector": "opencv", "model": "opencv",
          "dilate": 6, "feather": 3}
PROJ = f"apitest-{uuid.uuid4().hex[:8]}"


def wait_job() -> dict:
    for _ in range(240):
        j = client.get("/api/job").json()
        if not j["running"]:
            return j
        time.sleep(0.25)
    raise TimeoutError("batch job did not finish")


def make_chapter(n: int = 3) -> Path:
    d = Path(tempfile.mkdtemp(prefix="api_chapter_"))
    im = cv2.imread(str(SAMPLE))
    for name in [f"page{i}.png" for i in (2, 10, 1)][:n]:
        cv2.imwrite(str(d / name), im)
    return d


def data_url_of(mask: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", mask)
    return "data:image/png;base64," + base64.b64encode(buf).decode()


def main() -> None:
    chapter = make_chapter()
    try:
        run_tests(chapter)
    finally:
        shutil.rmtree(chapter, ignore_errors=True)
        shutil.rmtree(PROJECTS_ROOT / PROJ, ignore_errors=True)


def run_tests(chapter: Path) -> None:
    r = client.get("/api/meta")
    assert r.status_code == 200 and "device" in r.json(), r.text
    assert "cuda_available" in r.json(), r.text
    assert "Manga Cleaner Studio" in client.get("/").text
    print("meta + index:", r.json())

    r = client.post("/api/projects", json={"name": PROJ, "path": str(chapter)})
    assert r.status_code == 200, r.text
    st = r.json()
    names = [p["name"] for p in st["pages"]]
    assert names == ["page1.png", "page2.png", "page10.png"], names
    assert st["name"] == PROJ
    assert (PROJECTS_ROOT / PROJ / "project.json").is_file()
    print("create project + natural sort: OK")

    r = client.post("/api/projects", json={"name": PROJ, "path": str(chapter)})
    assert r.status_code == 400 and r.json()["detail"] == "project_exists"
    r = client.post("/api/projects", json={"name": "x" + PROJ,
                                           "path": "Z:/definitely/missing"})
    assert r.status_code == 400 and r.json()["detail"] == "folder_not_found"
    print("error handling: OK")

    projects = client.get("/api/projects").json()["projects"]
    assert any(p["name"] == PROJ for p in projects)
    print("project list: OK")

    r = client.post("/api/process", json={"settings": OPENCV, "force": False,
                                          "mode": "detect"})
    assert r.json()["queued"] == 3, r.text
    j = wait_job()
    assert j["errors"] == 0 and {p["status"] for p in j["pages"]} == {"masked"}, j
    print("detect-all: OK")

    im = cv2.imread(str(SAMPLE))
    user_mask = np.zeros(im.shape[:2], np.uint8)
    user_mask[560:660, 200:600] = 255
    r = client.post("/api/pages/0/mask", json={"mask": data_url_of(user_mask)})
    assert r.json()["maskSource"] == "user", r.text
    print("user mask save: OK")

    client.post("/api/project/state", json={"lastPage": 2})

    r = client.post("/api/process", json={"settings": OPENCV, "force": False,
                                          "mode": "clean"})
    assert r.json()["queued"] == 3
    j = wait_job()
    statuses = {p["name"]: p["status"] for p in j["pages"]}
    assert statuses["page1.png"] == "edited" and statuses["page2.png"] == "done", statuses
    print("bulk clean: OK")

    r = client.post(f"/api/projects/{PROJ}/open")
    assert r.status_code == 200, r.text
    st = r.json()
    assert st["lastPage"] == 2, st["lastPage"]
    statuses = {p["name"]: p["status"] for p in st["pages"]}
    assert statuses["page1.png"] == "edited" and statuses["page10.png"] == "done", statuses
    assert all(p["hasMask"] and p["hasResult"] for p in st["pages"])
    assert st["pages"][0]["maskSource"] == "user"
    print("project persistence (reopen): OK")

    fixed = np.full_like(im, 200)
    r = client.post("/api/pages/1/result", json={"image": data_url_of(fixed)})
    assert r.status_code == 200 and r.json()["status"] == "edited", r.text
    out = client.get("/api/pages/1/result").content
    dec = cv2.imdecode(np.frombuffer(out, np.uint8), cv2.IMREAD_COLOR)
    assert abs(int(dec[50, 50, 0]) - 200) <= 2
    print("result repair upload: OK")

    heal_mask = np.zeros(im.shape[:2], np.uint8)
    heal_mask[100:140, 100:180] = 255
    r = client.post("/api/pages/1/heal", json={"mask": data_url_of(heal_mask)})
    assert r.status_code == 200 and r.json()["status"] == "edited", r.text
    print("spot heal: OK")

    items = [{"x": 280, "y": 170, "text": "Сайн уу!\nЮу байна?", "size": 26,
              "color": "#000000", "stroke": 2, "strokeColor": "#ffffff",
              "font": "arial", "bold": True}]
    r = client.post("/api/pages/0/texts", json={"items": items})
    assert r.json()["count"] == 1
    got = client.get("/api/pages/0/texts").json()["items"]
    assert got[0]["text"].startswith("Сайн"), got
    print("texts save/load: OK")

    r = client.post("/api/export", json={})
    body = r.json()
    assert r.status_code == 200, r.text
    assert body["typeset"] == 1 and body["cleaned"] + body["kept"] == 3, body
    out_dir = Path(body["outDir"])
    assert out_dir == PROJECTS_ROOT / PROJ / "output"
    exported = cv2.imdecode(
        np.frombuffer((out_dir / "page1.png").read_bytes(), np.uint8),
        cv2.IMREAD_COLOR)
    region = exported[150:190, 220:340]
    assert (region < 100).any(), "typeset text not rendered in export"
    r = client.get("/api/export/zip")
    zip_tmp = Path(tempfile.mktemp(suffix=".zip"))
    zip_tmp.write_bytes(r.content)
    assert len(zipfile.ZipFile(zip_tmp).namelist()) == 3
    zip_tmp.unlink()
    print("export + typeset burn-in + zip: OK")

    r = client.post("/api/pages/2/revert")
    assert r.json()["status"] == "skipped"
    print("revert: OK")

    ok, buf = cv2.imencode(".png", np.full((400, 300, 3), 255, np.uint8))
    r = client.post("/api/project/pages/upload",
                    files=[("files", ("page5.png", buf.tobytes(), "image/png"))])
    assert r.status_code == 200, r.text
    st = r.json()
    names = [p["name"] for p in st["pages"]]
    assert st["added"] == 1 and names == ["page1.png", "page2.png",
                                          "page5.png", "page10.png"], st
    r = client.post("/api/project/pages/upload",
                    files=[("files", ("page5.png", buf.tobytes(), "image/png"))])
    assert r.json()["added"] == 0, "duplicate name should be skipped"
    print("add pages to open project: OK")

    r = client.get(f"/api/projects/{PROJ}/cover")
    assert r.status_code == 200 and len(r.content) > 500, r.status_code
    print("project cover: OK")

    from mangacleaner.core.typeset import render_texts
    canvas = np.full((300, 300, 3), 255, np.uint8)
    out = render_texts(canvas, [{"x": 150, "y": 150, "text": "IIIIIIII",
                                 "size": 40, "rotation": 90,
                                 "color": "#000000", "stroke": 0}])
    ys, xs = np.where(cv2.cvtColor(out, cv2.COLOR_BGR2GRAY) < 100)
    assert len(ys) and ys.ptp() > xs.ptp(), "rotated text should render vertically"
    print("rotated typeset burn-in: OK")

    r = client.get("/api/fonts")
    assert r.status_code == 200, r.text
    fonts = r.json()["fonts"]
    assert fonts and all("family" in f and "path" in f and "supportsCyrillic" in f
                         for f in fonts), fonts[:2]
    fid = fonts[0]["id"]
    r = client.get(f"/api/fonts/{fid}/file")
    assert r.status_code == 200 and len(r.content) > 1000
    assert client.get("/api/fonts/999999/file").status_code == 404
    print(f"font list + file serving: OK ({len(fonts)} fonts)")

    bundled = Path(__file__).resolve().parents[1] / "fonts" / "_apitest_font.ttf"
    ttf = next(f for f in fonts if f["path"].lower().endswith(".ttf")
               and f["supportsCyrillic"])
    shutil.copy2(ttf["path"], bundled)
    try:
        fonts2 = client.post("/api/fonts/refresh").json()["fonts"]
        mine = [f for f in fonts2 if Path(f["path"]) == bundled.resolve()]
        assert mine and mine[0]["source"] == "bundled", mine
        canvas = np.full((200, 400, 3), 255, np.uint8)
        out = render_texts(canvas, [{"x": 200, "y": 100, "text": "Тест",
                                     "size": 48, "color": "#000000",
                                     "fontPath": str(bundled)}])
        dark = (cv2.cvtColor(out, cv2.COLOR_BGR2GRAY) < 100).sum()
        assert dark > 50, f"fontPath typeset drew nothing ({dark} px)"
    finally:
        bundled.unlink(missing_ok=True)
        client.post("/api/fonts/refresh")
    print("bundled fonts/ + fontPath typeset: OK")

    r = client.delete(f"/api/projects/{PROJ}")
    assert r.status_code == 200 and r.json()["ok"] is True, r.text
    assert not (PROJECTS_ROOT / PROJ).exists()
    assert client.get("/api/project").json()["pages"] == [], \
        "open project should be closed after deletion"
    assert client.delete(f"/api/projects/{PROJ}").status_code == 404
    print("delete project (incl. currently open): OK")

    print("\nALL API TESTS PASSED")


if __name__ == "__main__":
    main()

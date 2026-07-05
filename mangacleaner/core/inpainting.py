from __future__ import annotations

import logging

import cv2
import numpy as np
from PIL import Image

log = logging.getLogger("mangacleaner")


class OpenCVInpainter:
    name = "opencv"

    def __call__(self, img_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
        return cv2.inpaint(img_bgr, mask, 5, cv2.INPAINT_TELEA)


class LamaInpainter:
    name = "lama"

    def __init__(self, device: str):
        self.device = device
        self.backend = None
        try:
            import torch
            from simple_lama_inpainting import SimpleLama
            self._model = SimpleLama(device=torch.device(device))
            self.backend = "simple-lama"
            return
        except ImportError:
            pass
        from iopaint.model_manager import ModelManager
        from iopaint.schema import HDStrategy, InpaintRequest
        self._request = InpaintRequest(hd_strategy=HDStrategy.ORIGINAL)
        self._model = ModelManager(name="lama", device=device)
        self.backend = "iopaint"

    def __call__(self, img_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
        h, w = img_bgr.shape[:2]
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        if self.backend == "simple-lama":
            out = self._model(Image.fromarray(rgb), Image.fromarray(mask))
            out = cv2.cvtColor(np.array(out.convert("RGB")), cv2.COLOR_RGB2BGR)
        else:
            out = self._model(rgb, mask, self._request)
            out = np.clip(out, 0, 255).astype(np.uint8)
        return out[:h, :w]


def _merge_rects(rects: list[list[int]]) -> list[list[int]]:
    """Merge overlapping xyxy rects until stable."""
    merged = True
    while merged:
        merged = False
        out: list[list[int]] = []
        for r in rects:
            for o in out:
                if r[0] < o[2] and r[2] > o[0] and r[1] < o[3] and r[3] > o[1]:
                    o[0] = min(o[0], r[0])
                    o[1] = min(o[1], r[1])
                    o[2] = max(o[2], r[2])
                    o[3] = max(o[3], r[3])
                    merged = True
                    break
            else:
                out.append(r)
        rects = out
    return rects


def inpaint_regions(inpainter, img_bgr: np.ndarray, mask: np.ndarray,
                    margin: int = 96, min_size: int = 256,
                    max_coverage: float = 0.5) -> np.ndarray:
    """Run the inpainter on padded crops around mask regions, not the whole
    page — cost then scales with the text area instead of the page size.

    Pixels outside the mask are returned unchanged, so downstream blending
    sees the same picture as with a full-page pass.
    """
    h, w = mask.shape[:2]
    n, _, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    if n <= 1:
        return img_bgr.copy()
    rects = []
    for i in range(1, n):
        x, y, bw, bh = (int(v) for v in stats[i, :4])
        px = max(margin, (min_size - bw) // 2)
        py = max(margin, (min_size - bh) // 2)
        rects.append([max(x - px, 0), max(y - py, 0),
                      min(x + bw + px, w), min(y + bh + py, h)])
    rects = _merge_rects(rects)
    if sum((x2 - x1) * (y2 - y1) for x1, y1, x2, y2 in rects) > max_coverage * h * w:
        return inpainter(img_bgr, mask)
    out = img_bgr.copy()
    for x1, y1, x2, y2 in rects:
        out[y1:y2, x1:x2] = inpainter(
            np.ascontiguousarray(img_bgr[y1:y2, x1:x2]),
            np.ascontiguousarray(mask[y1:y2, x1:x2]))
    return out


def lama_available() -> bool:
    for mod in ("simple_lama_inpainting", "iopaint"):
        try:
            __import__(mod)
            return True
        except ImportError:
            continue
    return False


def pick_device(requested: str = "auto") -> str:
    if requested != "auto":
        return requested
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def build_inpainter(model: str, device: str):
    if model == "lama":
        try:
            inp = LamaInpainter(device)
            log.info("Inpainting: LaMa (%s, %s)", inp.backend, device)
            return inp
        except ImportError:
            log.warning("No LaMa backend found (install simple-lama-inpainting "
                        "or iopaint) — using OpenCV Telea fallback.")
        except Exception as e:
            log.warning("LaMa failed to load (%s) — using OpenCV Telea fallback.", e)
    log.info("Inpainting: OpenCV Telea (CPU)")
    return OpenCVInpainter()

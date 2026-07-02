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

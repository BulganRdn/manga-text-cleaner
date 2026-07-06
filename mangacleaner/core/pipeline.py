from __future__ import annotations

import threading

import cv2
import numpy as np

from .detection import build_detector, comictextdetector_available
from .inpainting import build_inpainter, inpaint_regions, lama_available, pick_device
from .postprocess import feather_blend, preserve_white_balloons, refine_mask

_lock = threading.Lock()
_detectors: dict[str, object] = {}
_inpainters: dict[str, object] = {}


def _get_detector(kind: str, device: str):
    key = f"{kind}:{device}"
    if key not in _detectors:
        _detectors[key] = build_detector(kind, device)
    return _detectors[key]


def _get_inpainter(model: str, device: str):
    key = f"{model}:{device}"
    if key not in _inpainters:
        _inpainters[key] = build_inpainter(model, device)
    return _inpainters[key]


DETECT_MAX_SIDE = 2400


def detect_mask(img_bgr: np.ndarray, *, detect: str = "both",
                detector: str = "auto", dilate: int = 6,
                device: str = "auto") -> np.ndarray:
    device = pick_device(device)
    h, w = img_bgr.shape[:2]
    scale = max(h, w) / DETECT_MAX_SIDE
    with _lock:
        det = _get_detector(detector, device)
        downscale = scale > 1 and det.name != "comictextdetector"
        small = img_bgr
        if downscale:
            small = cv2.resize(img_bgr, (round(w / scale), round(h / scale)),
                               interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        mask = det.detect(small, gray, detect)
    if downscale:
        mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
        dilate = max(dilate, int(round(dilate * min(scale, 2))))
    return refine_mask(mask, dilate)


def clean_page(img_bgr: np.ndarray, mask: np.ndarray, *, model: str = "lama",
               feather: int = 3, device: str = "auto") -> np.ndarray:
    device = pick_device(device)
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    with _lock:
        result = inpaint_regions(_get_inpainter(model, device), img_bgr, mask)
    result = preserve_white_balloons(result, mask, img_bgr, gray)
    return feather_blend(img_bgr, result, mask, feather)


def active_backends(device: str = "auto") -> dict:
    device = pick_device(device)
    det = _get_detector("auto", device)
    inp = _get_inpainter("lama", device)
    return {"detector": det.name, "inpainter": getattr(inp, "backend", None) or inp.name}


def get_meta() -> dict:
    cuda_available = False
    try:
        import torch
        cuda_available = torch.cuda.is_available()
    except ImportError:
        pass
    return {
        "device": pick_device("auto"),
        "cuda_available": cuda_available,
        "lama": lama_available(),
        "ctd": comictextdetector_available(),
    }

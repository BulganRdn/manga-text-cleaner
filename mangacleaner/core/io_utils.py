from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def load_image(path: Path | str) -> np.ndarray:
    with Image.open(path) as im:
        im = im.convert("RGB")
        return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def save_image(img: np.ndarray, path: Path | str) -> None:
    path = Path(path)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    ext = path.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        pil.save(path, quality=95, subsampling=0)
    elif ext == ".webp":
        pil.save(path, quality=95, method=6)
    else:
        pil.save(path)

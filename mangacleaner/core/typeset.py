from __future__ import annotations

import logging

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

log = logging.getLogger("mangacleaner")

FONT_FILES = {
    "arial": ("arial.ttf", "arialbd.ttf"),
    "comic": ("comic.ttf", "comicbd.ttf"),
    "verdana": ("verdana.ttf", "verdanab.ttf"),
    "times": ("times.ttf", "timesbd.ttf"),
    "impact": ("impact.ttf", "impact.ttf"),
    "tahoma": ("tahoma.ttf", "tahomabd.ttf"),
}

_font_cache: dict[tuple, ImageFont.FreeTypeFont] = {}


def _get_font(family: str, size: int, bold: bool) -> ImageFont.FreeTypeFont:
    key = (family, size, bold)
    if key in _font_cache:
        return _font_cache[key]
    regular, bold_file = FONT_FILES.get(family, FONT_FILES["arial"])
    candidates = [bold_file, regular] if bold else [regular, bold_file]
    font = None
    for name in candidates:
        try:
            font = ImageFont.truetype(name, size)
            break
        except OSError:
            continue
    if font is None:
        log.warning("font %s not found — using PIL default", family)
        font = ImageFont.load_default()
    _font_cache[key] = font
    return font


def render_texts(img_bgr: np.ndarray, items: list[dict]) -> np.ndarray:
    if not items:
        return img_bgr
    pil = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil)
    for it in items:
        text = str(it.get("text", "")).strip()
        if not text:
            continue
        size = max(6, int(it.get("size", 24)))
        font = _get_font(str(it.get("font", "arial")), size,
                         bool(it.get("bold", True)))
        stroke = max(0, int(it.get("stroke", 0)))
        draw.multiline_text(
            (float(it.get("x", 0)), float(it.get("y", 0))),
            text, font=font,
            fill=str(it.get("color", "#000000")),
            stroke_width=stroke,
            stroke_fill=str(it.get("strokeColor", "#ffffff")),
            anchor="mm", align="center",
            spacing=int(size * 0.25))
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

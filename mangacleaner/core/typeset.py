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


def _get_font(family: str, size: int, bold: bool,
              path: str | None = None) -> ImageFont.FreeTypeFont:
    key = (path or family, size, bold)
    if key in _font_cache:
        return _font_cache[key]
    font = None
    if path:
        try:
            font = ImageFont.truetype(path, size)
        except OSError:
            log.warning("font file %s not found — falling back to %s",
                        path, family)
    if font is None:
        regular, bold_file = FONT_FILES.get(family, FONT_FILES["arial"])
        candidates = [bold_file, regular] if bold else [regular, bold_file]
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
        path = it.get("fontPath") or None
        font = _get_font(str(it.get("font", "arial")), size,
                         bool(it.get("bold", True)) and not path,
                         path=path)
        stroke = max(0, int(it.get("stroke", 0)))
        kwargs = dict(font=font,
                      fill=str(it.get("color", "#000000")),
                      stroke_width=stroke,
                      stroke_fill=str(it.get("strokeColor", "#ffffff")),
                      anchor="mm", align="center",
                      spacing=int(size * 0.25))
        x, y = float(it.get("x", 0)), float(it.get("y", 0))
        rotation = float(it.get("rotation", 0) or 0)
        if abs(rotation) < 0.05:
            draw.multiline_text((x, y), text, **kwargs)
            continue
        bbox = draw.multiline_textbbox((0, 0), text, font=font,
                                       stroke_width=stroke, anchor="mm",
                                       align="center",
                                       spacing=int(size * 0.25))
        lw = int(bbox[2] - bbox[0]) + 2 * stroke + 8
        lh = int(bbox[3] - bbox[1]) + 2 * stroke + 8
        layer = Image.new("RGBA", (lw, lh), (0, 0, 0, 0))
        ImageDraw.Draw(layer).multiline_text((lw / 2, lh / 2), text, **kwargs)
        layer = layer.rotate(-rotation, expand=True, resample=Image.BICUBIC)
        pil.paste(layer, (round(x - layer.width / 2),
                          round(y - layer.height / 2)), layer)
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)

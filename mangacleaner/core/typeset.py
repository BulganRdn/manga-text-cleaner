from __future__ import annotations

import logging
import math

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
        lines = it.get("lines")
        if isinstance(lines, list) and lines:
            text = "\n".join(str(ln) for ln in lines).strip()
        else:
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
        sx = max(0.05, float(it.get("scaleX", 1) or 1))
        sy = max(0.05, float(it.get("scaleY", 1) or 1))
        skew = float(it.get("skew", 0) or 0)
        gradient = bool(it.get("gradient")) and it.get("color2")
        plain = (abs(rotation) < 0.05 and abs(skew) < 0.05
                 and abs(sx - 1) < 0.005 and abs(sy - 1) < 0.005 and not gradient)
        if plain:
            draw.multiline_text((x, y), text, **kwargs)
            continue
        layer = _text_layer(draw, text, size, gradient,
                            str(it.get("color2", "#ffffff")), **kwargs)
        if abs(sx - 1) >= 0.005 or abs(sy - 1) >= 0.005:
            layer = layer.resize((max(1, round(layer.width * sx)),
                                  max(1, round(layer.height * sy))),
                                 Image.LANCZOS)
        if abs(skew) >= 0.05:
            layer = _shear(layer, skew)
        if abs(rotation) >= 0.05:
            layer = layer.rotate(-rotation, expand=True, resample=Image.BICUBIC)
        pil.paste(layer, (round(x - layer.width / 2),
                          round(y - layer.height / 2)), layer)
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _text_layer(measure: ImageDraw.ImageDraw, text: str, size: int,
                gradient, color2: str, **kwargs) -> Image.Image:
    """Text block on a transparent layer, centered, with optional vertical
    gradient fill (stroke stays solid, matching the preview)."""
    font = kwargs["font"]
    stroke = kwargs["stroke_width"]
    spacing = kwargs["spacing"]
    bbox = measure.multiline_textbbox((0, 0), text, font=font,
                                      stroke_width=stroke, anchor="mm",
                                      align="center", spacing=spacing)
    hw = max(abs(bbox[0]), abs(bbox[2])) + stroke + 4
    hh = max(abs(bbox[1]), abs(bbox[3])) + stroke + 4
    lw = int(math.ceil(hw)) * 2
    lh = int(math.ceil(hh)) * 2
    layer = Image.new("RGBA", (lw, lh), (0, 0, 0, 0))
    ImageDraw.Draw(layer).multiline_text((lw / 2, lh / 2), text, **kwargs)
    if not gradient:
        return layer

    mask = Image.new("L", (lw, lh), 0)
    mk = dict(kwargs, fill=255)
    mk.update(stroke_width=0, stroke_fill=None)
    ImageDraw.Draw(mask).multiline_text((lw / 2, lh / 2), text, **mk)
    n_lines = text.count("\n") + 1
    block_h = max(1.0, n_lines * size * 1.25)
    yy = np.arange(lh, dtype=np.float32)
    a = np.clip((yy - (lh / 2 - block_h / 2)) / block_h, 0, 1)[:, None]
    c1 = np.array(_hex_rgb(str(kwargs["fill"])), np.float32)
    c2 = np.array(_hex_rgb(color2), np.float32)
    grad = (c1[None, None] * (1 - a[..., None]) + c2[None, None] * a[..., None])
    rgba = np.zeros((lh, lw, 4), np.uint8)
    rgba[..., :3] = np.broadcast_to(grad, (lh, lw, 3)).astype(np.uint8)
    rgba[..., 3] = np.array(mask, np.uint8)
    return Image.alpha_composite(layer, Image.fromarray(rgba))


def _hex_rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    try:
        return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    except ValueError:
        return 0, 0, 0


def _shear(layer: Image.Image, skew_deg: float) -> Image.Image:
    """Horizontal shear about the layer center (x' = x + tan(skew)*y),
    expanded so nothing is clipped — the forward map the preview uses."""
    tan = math.tan(math.radians(skew_deg))
    w0, h0 = layer.size
    w2 = int(math.ceil(w0 + abs(tan) * h0))
    in_cx, in_cy = w0 / 2, h0 / 2
    out_cx, out_cy = w2 / 2, h0 / 2
    coeffs = (1, -tan, -out_cx + tan * out_cy + in_cx,
              0, 1, in_cy - out_cy)
    return layer.transform((w2, h0), Image.AFFINE, coeffs,
                           resample=Image.BICUBIC)

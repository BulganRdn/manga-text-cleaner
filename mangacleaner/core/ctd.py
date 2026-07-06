"""Self-contained inference wrapper for the comic-text-detector ONNX weights.

Loads the publicly released ``comictextdetector.pt.onnx`` model (published by
the manga-image-translator project, tag ``beta-0.2.1``) and reimplements the
inference glue — letterbox, YOLOv5-style NMS, DBNet-style decoding, mask
refinement — from scratch. The upstream dmMaze/comic-text-detector code is
GPL-3.0; only the public weights are downloaded and loaded here, no upstream
code is vendored.
"""
from __future__ import annotations

import logging
import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger("mangacleaner")

WEIGHTS_FILENAME = "comictextdetector.pt.onnx"
WEIGHTS_URL = ("https://github.com/zyddnys/manga-image-translator/"
               "releases/download/beta-0.2.1/" + WEIGHTS_FILENAME)
INPUT_SIZE = 1024


def _candidate_paths() -> list[Path]:
    paths = []
    env = os.environ.get("MANGACLEANER_CTD_MODEL")
    if env:
        paths.append(Path(env))
    paths.append(Path(__file__).resolve().parents[2] / "models" / WEIGHTS_FILENAME)
    paths.append(Path.home() / ".cache" / "mangacleaner" / WEIGHTS_FILENAME)
    return paths


def find_weights() -> Path | None:
    for p in _candidate_paths():
        if p.is_file():
            return p
    return None


def download_weights() -> Path:
    dest = Path.home() / ".cache" / "mangacleaner" / WEIGHTS_FILENAME
    dest.parent.mkdir(parents=True, exist_ok=True)
    log.info("Downloading comic-text-detector weights (~90 MB) — one-time...")
    tmp = dest.with_suffix(".part")
    urllib.request.urlretrieve(WEIGHTS_URL, tmp)
    tmp.replace(dest)
    log.info("Weights saved to %s", dest)
    return dest


def ensure_weights(auto_download: bool = False) -> Path:
    found = find_weights()
    if found is not None:
        return found
    if auto_download:
        return download_weights()
    searched = ", ".join(str(p) for p in _candidate_paths())
    raise FileNotFoundError(
        f"{WEIGHTS_FILENAME} not found (searched: {searched}); "
        f"download it from {WEIGHTS_URL}")


def _overlaps_any(rects: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """True per row of `rects` (xyxy) that intersects at least one of `boxes`."""
    ix = (np.minimum(rects[:, None, 2], boxes[None, :, 2])
          > np.maximum(rects[:, None, 0], boxes[None, :, 0]))
    iy = (np.minimum(rects[:, None, 3], boxes[None, :, 3])
          > np.maximum(rects[:, None, 1], boxes[None, :, 1]))
    return (ix & iy).any(axis=1)


def letterbox(img_bgr: np.ndarray, size: int = INPUT_SIZE):
    """Scale the longest side to `size`, pad bottom/right to a square canvas.

    Returns (canvas, scale, (new_w, new_h)); original coords = padded / scale.
    """
    h, w = img_bgr.shape[:2]
    scale = size / max(h, w)
    nw, nh = min(round(w * scale), size), min(round(h * scale), size)
    interp = cv2.INTER_LINEAR if scale > 1 else cv2.INTER_AREA
    resized = cv2.resize(img_bgr, (nw, nh), interpolation=interp)
    canvas = np.full((size, size, 3), 114, np.uint8)
    canvas[:nh, :nw] = resized
    return canvas, scale, (nw, nh)


class CTDModel:
    """comictextdetector.pt.onnx in, (boxes, mask) out.

    The final mask is the segmentation output constrained to regions the
    model itself confirmed as text (YOLO block boxes + DBNet line regions),
    which is what suppresses "large light art blob" false positives.
    """

    SINGLE_PASS_ASPECT = 2.0

    def __init__(self, weights: str | Path, device: str = "cpu",
                 conf_thresh: float = 0.4, nms_thresh: float = 0.35,
                 mask_thresh: float = 0.3, line_thresh: float = 0.6):
        self.conf_thresh = conf_thresh
        self.nms_thresh = nms_thresh
        self.mask_thresh = mask_thresh
        self.line_thresh = line_thresh
        self._session = None
        self._net = None
        try:
            import onnxruntime as ort
            providers = ["CPUExecutionProvider"]
            if device == "cuda" and "CUDAExecutionProvider" in ort.get_available_providers():
                providers.insert(0, "CUDAExecutionProvider")
            opts = ort.SessionOptions()
            opts.add_session_config_entry("session.set_denormal_as_zero", "1")
            opts.intra_op_num_threads = min(8, os.cpu_count() or 8)
            try:
                self._session = ort.InferenceSession(str(weights), opts,
                                                     providers=providers)
            except Exception:
                if providers == ["CPUExecutionProvider"]:
                    raise
                self._session = ort.InferenceSession(
                    str(weights), opts, providers=["CPUExecutionProvider"])
            self.backend = "onnxruntime"
        except ImportError:
            self._net = cv2.dnn.readNetFromONNX(str(weights))
            self.backend = "opencv-dnn"

    def _forward(self, blob: np.ndarray):
        if self._session is not None:
            name = self._session.get_inputs()[0].name
            outs = self._session.run(None, {name: blob})
        else:
            self._net.setInput(blob)
            outs = self._net.forward(self._net.getUnconnectedOutLayersNames())
        blk = seg = det = None
        for o in outs:
            if o.ndim == 3:
                blk = o
            elif o.ndim == 4 and o.shape[1] == 1:
                seg = o
            elif o.ndim == 4 and o.shape[1] == 2:
                det = o
        if blk is None or seg is None or det is None:
            raise RuntimeError(f"unexpected model outputs: {[o.shape for o in outs]}")
        return blk, seg, det

    def _decode_boxes(self, blk: np.ndarray) -> np.ndarray:
        """YOLOv5-style filtering + NMS -> (N, 4) xyxy in letterbox coords."""
        empty = np.zeros((0, 4), np.float32)
        pred = blk[0]
        pred = pred[pred[:, 4] > self.conf_thresh]
        if not len(pred):
            return empty
        scores = pred[:, 4] * pred[:, 5:].max(axis=1)
        pred, scores = pred[scores > self.conf_thresh], scores[scores > self.conf_thresh]
        if not len(pred):
            return empty
        tl = pred[:, :2] - pred[:, 2:4] / 2
        rects = np.concatenate([tl, pred[:, 2:4]], axis=1).astype(np.float32)
        idx = cv2.dnn.NMSBoxes(rects, scores.astype(np.float32),
                               self.conf_thresh, self.nms_thresh)
        if len(idx) == 0:
            return empty
        idx = np.asarray(idx).reshape(-1)
        return np.concatenate([tl, tl + pred[:, 2:4]], axis=1)[idx]

    def _line_boxes(self, det: np.ndarray):
        """DBNet-style decode: threshold the lines map, one scored box per
        region -> (boxes xyxy, mean probability, elongation)."""
        prob = det[0, 0]
        binary = (prob > self.mask_thresh).astype(np.uint8)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes, scores, aspects = [], [], []
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            if w * h < 16:
                continue
            sub = np.zeros((h, w), np.uint8)
            cv2.drawContours(sub, [c], -1, 1, -1, offset=(-x, -y))
            scores.append(float(prob[y:y + h, x:x + w][sub > 0].mean()))
            aspects.append(max(w, h) / min(w, h))
            m = max(2, min(w, h) // 2)
            boxes.append((x - m, y - m, x + w + m, y + h + m))
        return (np.array(boxes, np.float32).reshape(-1, 4),
                np.array(scores, np.float32), np.array(aspects, np.float32))

    def _infer(self, img_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """One letterboxed forward pass -> (boxes, mask) in image coords."""
        h, w = img_bgr.shape[:2]
        padded, scale, (nw, nh) = letterbox(img_bgr)
        rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)
        blob = rgb.transpose(2, 0, 1)[np.newaxis].astype(np.float32) / 255.0
        blk, seg, det = self._forward(blob)

        boxes = self._decode_boxes(blk)
        binary = ((seg[0, 0] > self.mask_thresh) * 255).astype(np.uint8)

        lines, scores, aspects = self._line_boxes(det)
        if len(lines):
            confirmed = (scores >= self.line_thresh) & (aspects >= 3.0)
            if len(boxes):
                confirmed |= _overlaps_any(lines, boxes)
            lines = lines[confirmed]
        size = binary.shape[0]
        allowed = np.zeros_like(binary)
        margin = 4
        for x1, y1, x2, y2 in np.concatenate([boxes, lines]):
            x1 = max(int(x1) - margin, 0)
            y1 = max(int(y1) - margin, 0)
            x2 = min(int(x2) + margin, size)
            y2 = min(int(y2) + margin, size)
            allowed[y1:y2, x1:x2] = 255
        binary[allowed == 0] = 0

        mask = cv2.resize(binary[:nh, :nw], (w, h), interpolation=cv2.INTER_NEAREST)
        if len(boxes):
            boxes = boxes / scale
            boxes[:, 0::2] = boxes[:, 0::2].clip(0, w - 1)
            boxes[:, 1::2] = boxes[:, 1::2].clip(0, h - 1)
        return boxes.astype(np.int32), mask

    def detect(self, img_bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Image in -> (boxes, mask), both in original image coordinates.

        boxes: (N, 4) int32 xyxy text-block boxes; mask: uint8 {0, 255}.
        Pages up to SINGLE_PASS_ASPECT get one forward pass; long webtoon
        strips are scanned in overlapping square windows (near-blank windows
        are skipped) and the results stitched back together.
        """
        h, w = img_bgr.shape[:2]
        if max(h, w) <= self.SINGLE_PASS_ASPECT * min(h, w):
            return self._infer(img_bgr)

        vertical = h >= w
        long_side, short = (h, w) if vertical else (w, h)
        win = int(self.SINGLE_PASS_ASPECT * short)
        stride = max(1, int(win * 0.875))
        mask = np.zeros((h, w), np.uint8)
        all_boxes = [np.zeros((0, 4), np.int32)]
        start = 0
        while True:
            end = min(start + win, long_side)
            start = max(0, end - win)
            tile = img_bgr[start:end] if vertical else img_bgr[:, start:end]
            if tile.std() > 4:
                boxes, m = self._infer(tile)
                if vertical:
                    np.maximum(mask[start:end], m, out=mask[start:end])
                    boxes[:, 1::2] += start
                else:
                    np.maximum(mask[:, start:end], m, out=mask[:, start:end])
                    boxes[:, 0::2] += start
                all_boxes.append(boxes)
            if end >= long_side:
                break
            start += stride
        return np.concatenate(all_boxes), mask

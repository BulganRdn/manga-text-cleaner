from __future__ import annotations

import logging

import cv2
import numpy as np

log = logging.getLogger("mangacleaner")


class OpenCVTextDetector:
    name = "opencv"

    def _find_blob_masks(self, bw: np.ndarray) -> list[np.ndarray]:
        h, w = bw.shape
        img_area = h * w
        bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        masks = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < 0.003 * img_area or area > 0.5 * img_area:
                continue
            hull = cv2.convexHull(c)
            hull_area = cv2.contourArea(hull)
            if hull_area <= 0 or area / hull_area < 0.70:
                continue
            perimeter = cv2.arcLength(c, True)
            if perimeter * perimeter / max(area, 1) > 45:
                continue
            m = np.zeros((h, w), np.uint8)
            cv2.drawContours(m, [c], -1, 255, -1)
            masks.append(m)
        return masks

    def find_balloon_masks(self, gray: np.ndarray) -> list[np.ndarray]:
        _, bw = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY)
        return self._find_blob_masks(bw)

    def find_dark_balloon_masks(self, gray: np.ndarray) -> list[np.ndarray]:
        _, bw = cv2.threshold(gray, 45, 255, cv2.THRESH_BINARY_INV)
        return self._find_blob_masks(bw)

    def _text_inside(self, gray, balloons, text_sel) -> np.ndarray:
        mask = np.zeros_like(gray)
        for b in balloons:
            inner = cv2.erode(b, np.ones((9, 9), np.uint8))
            text = (text_sel(gray) & (inner > 0)).astype(np.uint8) * 255
            n, labels, stats, _ = cv2.connectedComponentsWithStats(text, 8)
            for i in range(1, n):
                if stats[i, cv2.CC_STAT_AREA] >= 4:
                    mask[labels == i] = 255
        return mask

    def balloon_text_mask(self, gray: np.ndarray, balloons: list[np.ndarray]) -> np.ndarray:
        return self._text_inside(gray, balloons, lambda g: g < 170)

    def dark_balloon_text_mask(self, gray: np.ndarray, balloons: list[np.ndarray]) -> np.ndarray:
        return self._text_inside(gray, balloons, lambda g: g > 150)

    def _sfx_from_binary(self, gray: np.ndarray, binary: np.ndarray,
                         dark_surround: bool = False) -> np.ndarray:
        h, w = gray.shape
        img_area = h * w
        n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
        letters = np.zeros((h, w), np.uint8)
        ring_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        found = False
        for i in range(1, n):
            x, y, cw, ch, area = stats[i]
            if area < 40 or area > 0.05 * img_area:
                continue
            if ch < 12 or ch > 0.35 * h or cw > 0.5 * w:
                continue
            aspect = cw / max(ch, 1)
            if not (0.08 <= aspect <= 8.0):
                continue
            if area / (cw * ch) < 0.15:
                continue
            if min(cw, ch) > 24:
                sub = (labels[y:y + ch, x:x + cw] == i).astype(np.uint8)
                stroke = 2.0 * cv2.distanceTransform(sub, cv2.DIST_L2, 3).max()
                if stroke > 0.75 * cw and stroke > 0.75 * ch:
                    continue
            if dark_surround:
                comp = (labels == i).astype(np.uint8) * 255
                ring = cv2.dilate(comp, ring_k) & ~comp
                ring_vals = gray[ring > 0]
                if ring_vals.size < 20 or np.mean(ring_vals) > 110:
                    continue
            letters[labels == i] = 255
            found = True

        if not found:
            return letters

        clustered = cv2.morphologyEx(letters, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
        cn, clabels = cv2.connectedComponents(clustered, 8)
        keep = np.zeros((h, w), np.uint8)
        for ci in range(1, cn):
            cluster = clabels == ci
            members = np.unique(labels[cluster & (letters > 0)])
            if len(members) >= 2:
                keep[cluster & (letters > 0)] = 255
            elif len(members) == 1:
                m = members[0]
                mw, mh = stats[m, cv2.CC_STAT_WIDTH], stats[m, cv2.CC_STAT_HEIGHT]
                if mw / max(mh, 1) >= 1.8:
                    keep[labels == m] = 255
        return keep

    def sfx_text_mask(self, gray: np.ndarray, exclude: np.ndarray) -> np.ndarray:
        dark = ((gray < 110) & (exclude == 0)).astype(np.uint8) * 255
        return self._sfx_from_binary(gray, dark)

    def inverted_sfx_text_mask(self, gray: np.ndarray, exclude: np.ndarray) -> np.ndarray:
        bright = ((gray > 200) & (exclude == 0)).astype(np.uint8) * 255
        return self._sfx_from_binary(gray, bright, dark_surround=True)

    def detect(self, img_bgr: np.ndarray, gray: np.ndarray, mode: str) -> np.ndarray:
        balloon_union = np.zeros_like(gray)
        balloon_text = np.zeros_like(gray)
        for candidates, text_sel in (
                (self.find_balloon_masks(gray), lambda g: g < 170),
                (self.find_dark_balloon_masks(gray), lambda g: g > 150)):
            for b in candidates:
                tm = self._text_inside(gray, [b], text_sel)
                glyphs = cv2.connectedComponents((tm > 0).astype(np.uint8), 8)[0] - 1
                if glyphs >= 3 and cv2.countNonZero(tm) >= 30:
                    balloon_union |= b
                    balloon_text |= tm

        mask = np.zeros_like(gray)
        if mode in ("both", "balloon"):
            mask |= balloon_text
        if mode in ("both", "sfx"):
            mask |= self.sfx_text_mask(gray, balloon_union)
            mask |= self.inverted_sfx_text_mask(gray, balloon_union)
        return mask


class CraftTextDetector:
    name = "craft"

    def __init__(self, device: str):
        from craft_text_detector import Craft
        self._craft = Craft(output_dir=None, crop_type="poly", cuda=(device == "cuda"))
        self._fallback = OpenCVTextDetector()

    def detect(self, img_bgr: np.ndarray, gray: np.ndarray, mode: str) -> np.ndarray:
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        pred = self._craft.detect_text(rgb)
        boxes = pred.get("boxes", [])

        balloon_union = np.zeros_like(gray)
        for b in self._fallback.find_balloon_masks(gray):
            balloon_union |= b

        mask = np.zeros_like(gray)
        for box in boxes:
            poly = np.asarray(box, dtype=np.int32).reshape(-1, 2)
            cx = int(np.clip(poly[:, 0].mean(), 0, gray.shape[1] - 1))
            cy = int(np.clip(poly[:, 1].mean(), 0, gray.shape[0] - 1))
            in_balloon = balloon_union[cy, cx] > 0
            if mode == "balloon" and not in_balloon:
                continue
            if mode == "sfx" and in_balloon:
                continue
            cv2.fillPoly(mask, [poly], 255)
        return mask


def craft_available() -> bool:
    try:
        import craft_text_detector  # noqa: F401
        return True
    except ImportError:
        return False


def build_detector(kind: str, device: str):
    if kind in ("auto", "craft"):
        try:
            det = CraftTextDetector(device)
            log.info("Text detector: CRAFT (deep learning)")
            return det
        except ImportError:
            msg = "craft-text-detector is not installed"
        except Exception as e:
            msg = f"CRAFT failed to load ({e})"
        if kind == "craft":
            raise RuntimeError(msg + " — run `pip install craft-text-detector`.")
        log.warning("%s — falling back to the OpenCV heuristic detector.", msg)
    log.info("Text detector: OpenCV heuristic")
    return OpenCVTextDetector()

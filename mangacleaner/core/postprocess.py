from __future__ import annotations

import cv2
import numpy as np


def refine_mask(mask: np.ndarray, dilate_px: int) -> np.ndarray:
    if dilate_px <= 0:
        return mask
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate_px + 1, 2 * dilate_px + 1))
    return cv2.dilate(mask, k)


def preserve_white_balloons(result: np.ndarray, mask: np.ndarray,
                            original: np.ndarray, gray: np.ndarray) -> np.ndarray:
    out = result.copy()
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    ring_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))
    for i in range(1, n):
        comp = (labels == i).astype(np.uint8) * 255
        ring = cv2.dilate(comp, ring_k) & ~comp & ~mask
        ring_vals = gray[ring > 0]
        if ring_vals.size < 50:
            continue
        if np.median(ring_vals) >= 245 and np.percentile(ring_vals, 10) >= 225:
            color = np.median(original[ring > 0], axis=0)
            out[comp > 0] = color
    return out


def feather_blend(original: np.ndarray, inpainted: np.ndarray,
                  mask: np.ndarray, feather_px: int) -> np.ndarray:
    if feather_px <= 0:
        alpha = (mask > 0).astype(np.float32)
    else:
        k = 2 * feather_px + 1
        alpha = cv2.GaussianBlur((mask > 0).astype(np.float32), (k, k), 0)
        alpha = np.maximum(alpha, (mask > 0).astype(np.float32))
    alpha = alpha[..., None]
    return (original.astype(np.float32) * (1 - alpha)
            + inpainted.astype(np.float32) * alpha).astype(np.uint8)

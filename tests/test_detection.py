from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2
import numpy as np

from mangacleaner.core.detection import OpenCVTextDetector

det = OpenCVTextDetector()
FONT = cv2.FONT_HERSHEY_SIMPLEX


def coverage(mask: np.ndarray, text_region: np.ndarray) -> float:
    text = text_region > 0
    if not text.any():
        return 0.0
    return float((mask[text] > 0).sum()) / float(text.sum())


def run(img: np.ndarray, mode: str = "both") -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    bgr = img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return det.detect(bgr, gray, mode)


def main() -> None:
    img = np.full((800, 600), 255, np.uint8)
    img[::7, ::7] = 120
    text_layer = np.zeros_like(img)
    cv2.putText(text_layer, "BOOM!!", (100, 400), FONT, 2.6, 255, 14)
    img[text_layer > 0] = 0
    mask = run(img)
    cov = coverage(mask, text_layer)
    assert cov > 0.85, f"dark SFX coverage {cov:.2f}"
    print(f"dark SFX on light bg: OK ({cov:.0%})")

    img = np.zeros((800, 600), np.uint8)
    text_layer = np.zeros_like(img)
    cv2.putText(text_layer, "CRASH", (90, 380), FONT, 2.6, 255, 14)
    img[text_layer > 0] = 255
    mask = run(img)
    cov = coverage(mask, text_layer)
    assert cov > 0.85, f"inverted SFX coverage {cov:.2f}"
    print(f"white SFX on black bg: OK ({cov:.0%})")

    img = np.full((800, 600), 255, np.uint8)
    cv2.rectangle(img, (100, 100), (500, 260), 0, -1)
    text_layer = np.zeros_like(img)
    cv2.putText(text_layer, "LATER...", (140, 200), FONT, 1.6, 255, 8)
    img[text_layer > 0] = 255
    mask = run(img, "balloon")
    cov = coverage(mask, text_layer)
    assert cov > 0.85, f"dark-balloon text coverage {cov:.2f}"
    box_only = np.zeros_like(img)
    cv2.rectangle(box_only, (105, 105), (495, 255), 255, -1)
    box_masked = (mask[(box_only > 0) & (text_layer == 0)] > 0).mean()
    assert box_masked < 0.35, f"dark box over-masked ({box_masked:.0%})"
    print(f"white text in black box: OK ({cov:.0%}, box spill {box_masked:.0%})")

    sample = Path(__file__).resolve().parents[1] / "examples" / "sample_1.jpg"
    img = cv2.imread(str(sample))
    mask = run(img)
    assert mask.max() > 0
    n = cv2.connectedComponents((mask > 0).astype(np.uint8))[0] - 1
    assert n >= 3, f"sample page regions {n}"
    print(f"sample page regression: OK ({n} regions)")

    img = np.full((800, 600), 255, np.uint8)
    img[::7, ::7] = 120
    cv2.circle(img, (150, 200), 45, 0, -1)
    cv2.circle(img, (280, 200), 45, 0, -1)
    cv2.rectangle(img, (350, 400), (470, 500), 0, -1)
    pts = np.array([[150, 600], [220, 700], [80, 700]])
    cv2.fillPoly(img, [pts], 0)
    mask = run(img)
    shape_masked = (mask > 0).sum() / ((img < 110).sum() + 1)
    assert shape_masked < 0.05, f"filled shapes masked as text ({shape_masked:.0%})"
    print(f"filled shapes ignored: OK ({shape_masked:.0%} spill)")

    text_layer = np.zeros_like(img)
    cv2.putText(text_layer, "BAM!", (330, 120), FONT, 2.2, 255, 12)
    img[text_layer > 0] = 0
    mask = run(img)
    cov = coverage(mask, text_layer)
    assert cov > 0.85, f"text near shapes coverage {cov:.2f}"
    print(f"text near shapes still detected: OK ({cov:.0%})")

    img = np.full((800, 600), 255, np.uint8)
    mask = run(img)
    assert mask.max() == 0, "false positives on a blank page"
    img = np.zeros((800, 600), np.uint8)
    mask = run(img)
    assert mask.max() == 0, "false positives on a black page"
    print("blank pages produce empty masks: OK")

    print("\nALL DETECTION TESTS PASSED")


if __name__ == "__main__":
    main()

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


def art_blob_page() -> tuple[np.ndarray, np.ndarray]:
    """A page whose only content is a large light convex art region (think
    skin/sky/clothing) with sparse dark details inside — no text at all."""
    img = np.full((800, 600), 200, np.uint8)
    cv2.circle(img, (300, 300), 180, 255, -1)
    for cx, cy in ((240, 260), (360, 260), (250, 340), (300, 350), (350, 340)):
        cv2.circle(img, (cx, cy), 6, 60, -1)
    blob = np.zeros_like(img)
    cv2.circle(blob, (300, 300), 180, 255, -1)
    return img, blob


def ctd_tests() -> None:
    from mangacleaner.core.ctd import find_weights

    if find_weights() is None:
        print("comic-text-detector: SKIPPED (weights not downloaded)")
        return
    from mangacleaner.core.detection import ComicTextDetector

    try:
        ctd = ComicTextDetector("cpu")
    except Exception as e:
        print(f"comic-text-detector: SKIPPED ({e})")
        return

    gray, blob = art_blob_page()
    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    heur_spill = (det.detect(bgr, gray, "both")[blob > 0] > 0).mean()
    assert heur_spill > 0, "premise broken: heuristic no longer false-positives here"
    ctd_spill = (ctd.detect(bgr, gray, "both")[blob > 0] > 0).mean()
    assert ctd_spill < 0.01, f"ctd flagged the art blob ({ctd_spill:.1%})"
    print(f"ctd excludes light art blob: OK "
          f"(heuristic spill {heur_spill:.1%} -> ctd {ctd_spill:.1%})")

    examples = Path(__file__).resolve().parents[1] / "examples"
    img = cv2.imread(str(examples / "sample_1.jpg"))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = ctd.detect(img, gray, "both")
    assert (mask[:200] > 0).any(), "ctd missed the dialogue text on the sample page"
    face_spill = (mask[600:] > 0).mean()
    assert face_spill < 0.005, f"ctd masked the character art ({face_spill:.1%})"
    print(f"ctd sample page: OK (text found, art spill {face_spill:.2%})")

    strip = np.vstack([cv2.imread(str(examples / f"sample_{i}.jpg"))
                       for i in (1, 2, 3)])
    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
    mask = ctd.detect(strip, gray, "both")
    for band, name in (((0, 300), "page 1"), ((1900, 2100), "page 2"),
                       ((2600, 2900), "page 3")):
        assert (mask[band[0]:band[1]] > 0).any(), f"tall strip: missed text on {name}"
    print("ctd tall strip: OK (text found on all three stacked pages)")


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

    ctd_tests()

    print("\nALL DETECTION TESTS PASSED")


if __name__ == "__main__":
    main()

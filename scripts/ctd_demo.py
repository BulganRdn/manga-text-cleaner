#!/usr/bin/env python3
"""Standalone comic-text-detector sanity check.

Loads the onnx weights (downloading them on first run), runs detection on one
page, and writes ``<name>_ctd_boxes.png`` (block boxes drawn on the page) and
``<name>_ctd_mask.png`` (the refined text mask) next to it for visual review.

    python scripts/ctd_demo.py                       # examples/sample_1.jpg
    python scripts/ctd_demo.py --input page.png --output out/
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2

from mangacleaner.core.ctd import CTDModel, ensure_weights

logging.basicConfig(level=logging.INFO, format="[%(levelname).1s] %(message)s")


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", default=str(repo / "examples" / "sample_1.jpg"))
    ap.add_argument("--output", default=None, help="output folder (default: next to input)")
    ap.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    ap.add_argument("--conf", type=float, default=0.4, help="box confidence threshold")
    ap.add_argument("--mask-thresh", type=float, default=0.3, help="mask pixel threshold")
    args = ap.parse_args()

    path = Path(args.input)
    img = cv2.imread(str(path))
    if img is None:
        sys.exit(f"cannot read {path}")

    model = CTDModel(ensure_weights(auto_download=True), device=args.device,
                     conf_thresh=args.conf, mask_thresh=args.mask_thresh)
    print(f"backend: {model.backend}")
    boxes, mask = model.detect(img)
    print(f"{len(boxes)} text blocks, mask covers "
          f"{(mask > 0).mean():.1%} of {img.shape[1]}x{img.shape[0]} page")

    vis = img.copy()
    for x1, y1, x2, y2 in boxes:
        cv2.rectangle(vis, (x1, y1), (x2, y2), (0, 0, 255), 3)
    vis[mask > 0] = (vis[mask > 0] // 2) + (0, 0, 127)

    out_dir = Path(args.output) if args.output else path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    boxes_path = out_dir / f"{path.stem}_ctd_boxes.png"
    mask_path = out_dir / f"{path.stem}_ctd_mask.png"
    cv2.imwrite(str(boxes_path), vis)
    cv2.imwrite(str(mask_path), mask)
    print(f"wrote {boxes_path}\nwrote {mask_path}")


if __name__ == "__main__":
    main()

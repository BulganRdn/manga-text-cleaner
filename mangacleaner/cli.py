#!/usr/bin/env python3
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import cv2
from tqdm import tqdm

from .core import SUPPORTED_EXTS, clean_page, detect_mask, load_image, save_image

for _stream in (sys.stdout, sys.stderr):
    if _stream and _stream.encoding and _stream.encoding.lower() not in ("utf-8", "utf8"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

logging.basicConfig(level=logging.INFO, format="[%(levelname).1s] %(message)s")


def find_manual_mask(img_path: Path, args) -> Path | None:
    candidates = []
    if args.mask:
        candidates.append(Path(args.mask))
    mask_dir = Path(args.mask_dir) if args.mask_dir else img_path.parent
    candidates.append(mask_dir / f"{img_path.stem}_mask.png")
    for cand in candidates:
        if cand.is_file():
            return cand
    return None


def process_image(path: Path, out_dir: Path, args) -> str:
    img = load_image(path)

    manual = find_manual_mask(path, args) if (args.mask or args.mask_dir or args.auto_mask) else None
    if manual is not None:
        mask = cv2.cvtColor(load_image(manual), cv2.COLOR_BGR2GRAY)
        mask = ((mask > 127).astype("uint8")) * 255
        if mask.shape != img.shape[:2]:
            mask = cv2.resize(mask, (img.shape[1], img.shape[0]),
                              interpolation=cv2.INTER_NEAREST)
    else:
        mask = detect_mask(img, detect=args.detect, detector=args.detector,
                           dilate=args.dilate, device=args.device)

    if args.save_mask or args.mask_only:
        mask_path = out_dir / f"{path.stem}_mask.png"
        cv2.imwrite(str(mask_path), mask)
        if args.mask_only:
            return f"mask -> {mask_path.name}"

    out_path = out_dir / f"{path.stem}_clean{path.suffix}"
    if mask.max() == 0:
        save_image(img, out_path)
        return "no text found (copied unchanged)"

    result = clean_page(img, mask, model=args.model, feather=args.feather,
                        device=args.device)
    save_image(result, out_path)
    return f"OK -> {out_path.name}"


def collect_inputs(input_path: Path, batch: bool) -> list[Path]:
    if input_path.is_file():
        if input_path.suffix.lower() not in SUPPORTED_EXTS:
            sys.exit(f"[x] Unsupported format: {input_path.suffix} "
                     f"(supported: {', '.join(sorted(SUPPORTED_EXTS))})")
        return [input_path]
    if input_path.is_dir():
        files = sorted(p for p in input_path.iterdir()
                       if p.suffix.lower() in SUPPORTED_EXTS
                       and not p.stem.endswith(("_clean", "_mask")))
        if not files:
            sys.exit(f"[x] No images found in {input_path}.")
        if not batch and len(files) > 1:
            print(f"[i] Input is a folder — processing all {len(files)} images.")
        return files
    sys.exit(f"[x] Input not found: {input_path}")


def main() -> None:
    ap = argparse.ArgumentParser(
        prog="manga-cleaner",
        description="Remove text from manga/manhwa pages and restore the artwork.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument("--input", required=True, help="image file or folder")
    ap.add_argument("--output", default=None, help="output folder (default: next to input)")
    ap.add_argument("--model", choices=["lama", "opencv"], default="lama",
                    help="inpainting model (auto-falls back to opencv)")
    ap.add_argument("--batch", action="store_true", help="process every image in the folder")
    ap.add_argument("--detect", choices=["both", "balloon", "sfx"], default="both",
                    help="what to remove")
    ap.add_argument("--detector", choices=["auto", "craft", "opencv"], default="auto",
                    help="text detector")
    ap.add_argument("--mask", default=None, help="hand-edited mask image (single input)")
    ap.add_argument("--mask-dir", default=None,
                    help="folder searched for <name>_mask.png files in batch mode")
    ap.add_argument("--auto-mask", action="store_true",
                    help="auto-pick <name>_mask.png next to each input")
    ap.add_argument("--save-mask", action="store_true",
                    help="save the detected mask as PNG (for manual editing)")
    ap.add_argument("--mask-only", action="store_true",
                    help="only export masks, skip inpainting")
    ap.add_argument("--dilate", type=int, default=6, help="mask dilation (px)")
    ap.add_argument("--feather", type=int, default=3, help="edge feathering (px)")
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    args = ap.parse_args()

    input_path = Path(args.input)
    files = collect_inputs(input_path, args.batch)

    out_dir = Path(args.output) if args.output else (
        input_path.parent if input_path.is_file() else input_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    failed = 0
    for f in tqdm(files, desc="Processing", unit="page"):
        try:
            status = process_image(f, out_dir, args)
            tqdm.write(f"  {f.name}: {status}")
        except Exception as e:
            failed += 1
            tqdm.write(f"  [x] {f.name}: error — {e}")

    done = len(files) - failed
    print(f"\n[OK] Finished: {done}/{len(files)} succeeded. Output: {out_dir}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

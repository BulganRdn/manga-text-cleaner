# Manga Cleaner Studio

Remove text from manga / manhwa pages — speech-balloon dialogue, SFX, captions —
and restore the artwork underneath (screentones, lines, colors).
Automatic detection + inpainting with a full **Photoshop-style manual
touch-up workflow**. Everything runs **locally**: nothing is ever uploaded.

![Manga Cleaner Studio UI](examples/studio-ui.jpg)

*Studio view during a real project: mask review with red overlay, per-page status tracking, and editing tools with shortcuts visible.*

![Before / After](examples/comparison.png)

*Real manhwa page from [`examples/`](examples) — light SFX text on a dark
starfield, fully removed with the screentone/gradient background intact.
More before/after pairs: [`sample_1`](examples/sample_1.jpg) →
[`sample_1_clean`](examples/sample_1_clean.jpg),
[`sample_2`](examples/sample_2.jpg) →
[`sample_2_clean`](examples/sample_2_clean.jpg).*

**UI languages:** English (default) · Монгол — switch at runtime from the top bar.

---

## Quick start

```bash
pip install -r requirements.txt
python run.py                       # browser app: opens http://127.0.0.1:8420
```

**Desktop app** (native window, native folder pickers — no browser needed):

```bash
pip install pywebview
python desktop.py
```

For **best inpainting quality**, add LaMa (strongly recommended):

```bash
pip install torch simple-lama-inpainting
# GPU build of torch (optional): pip install torch --index-url https://download.pytorch.org/whl/cu121
```

For **best text detection** on manga/manhwa, use the built-in
comic-text-detector backend — no extra install needed, the weights (~90 MB)
download automatically on first use:

```bash
python main.py --input page.png --detector comictextdetector
# pip install onnxruntime   # optional: slightly faster inference
```

Missing backends are handled gracefully — the app tells you what is missing
and falls back to the built-in OpenCV pipeline instead of crashing.

### Text detectors

| `--detector` | What it is | When to use |
|---|---|---|
| `comictextdetector` | [comic-text-detector](https://github.com/dmMaze/comic-text-detector) — YOLOv5 text blocks + DBNet segmentation, trained on ~13k manga/comic pages | **Best choice.** Learned text-vs-art semantics: does not mis-flag large light art regions (skin, sky, clothing) the way the heuristic can |
| `opencv` | Built-in heuristic (balloons = large convex light regions with dark pixels inside; SFX = clustered letter shapes) | No downloads, instant, fully offline; fine for clean scans with standard balloons |
| `auto` (default) | comic-text-detector if its weights are already downloaded, else the heuristic | Default |

The comic-text-detector weights are published by the
[manga-image-translator](https://github.com/zyddnys/manga-image-translator)
project (GPL-3.0). Only the public `.onnx` weights are downloaded (to
`~/.cache/mangacleaner/`, or set `MANGACLEANER_CTD_MODEL`); the inference
wrapper in [`mangacleaner/core/ctd.py`](mangacleaner/core/ctd.py) is original
code, so no GPL code is vendored.

**Performance:** detection takes a few seconds per page on CPU (measured on
a 12-core laptop: ~3 s via `onnxruntime`, ~4–7 s via the OpenCV-DNN fallback
used when onnxruntime isn't installed). The wrapper flushes denormal floats
in onnxruntime sessions — these weights produce denormal-range activations
that otherwise make pages take *minutes*. LaMa inpainting runs on crops
around the text regions (~2 s per page on the same laptop vs 8–10 s for a
full-page pass; tall webtoon strips benefit far more, and the first page of
a session adds a few seconds of model warm-up).

**Long pages:** webtoon strips are scanned automatically in overlapping
windows (near-blank stretches are skipped), so small text is found even on
10k-pixel-tall images instead of being crushed into one 1024px square.

**If some text is still missed**, lower the thresholds via environment
variables before starting the app:

| Variable | Default | Meaning |
|---|---|---|
| `MANGACLEANER_CTD_CONF` | `0.4` | text-block confidence — try `0.3` to catch more, at some risk of extra regions |
| `MANGACLEANER_CTD_MASK_THRESH` | `0.3` | mask pixel threshold — lower = thicker mask around glyphs |
| `MANGACLEANER_CTD_LINE_THRESH` | `0.6` | acceptance of text lines the block detector missed |

## The Studio workflow

Work is organized into **projects**: name a chapter and everything — masks,
results, typeset text, and the page you were on — is stored under the app's
own `projects/<name>/` folder (visible in your file manager, so a project is
also just a folder you can back up or delete by hand; projects from the old
`Documents/MangaCleanerStudio` location are migrated automatically) and
restored when you reopen it.

1. **Create / open a project** — name it and point it at a chapter folder
   (or drag-and-drop files; they are copied into the project). Pages sort
   naturally (`page2` < `page10`). The projects list shows everything you've
   worked on with cover thumbnails — one click continues exactly where you
   left off, the trash button deletes a project (Photoshop-style), and you
   can **add more pages to an open project** any time (the `+` button above
   the page list, or drop files onto it).
2. **Detect masks** — masks are generated for the whole chapter *without*
   inpainting, so you review what will be removed (red overlay) before
   anything is touched. Detection covers dark text on light backgrounds,
   **light text on dark backgrounds**, white balloons, dark balloons /
   caption boxes — and ignores plain filled shapes (circles, boxes, art
   blobs) via stroke-width analysis.
3. **Review & fix masks** — flip through pages with the **◀ ▶ arrow keys**
   (ignored mid-stroke and inside dialogs — you can't fall off a page by
   accident). Every edit is **auto-saved when you switch pages** and restored
   when you come back; your masks are never overwritten by re-detection.
4. **Process all** — every page is inpainted using its reviewed mask;
   live progress, per-page status dots, a failing page never stops the batch.
5. **Repair & typeset** (per page):
   * **Mask tools** — brush `B` / eraser `E` / rectangle `R` / polygon `L`
     (click corner points around an area, click the first point or press
     Enter to close; right-click starts an erasing polygon); red overlay
     with opacity control; right-click erases
   * **Paint `P`** — draw directly on the page; **Alt+click picks a color**
     from the artwork (eyedropper)
   * **Restore `O`** — brush the *original* pixels back wherever inpainting
     damaged the art
   * **Spot heal `J`** — paint over a flaw and it is re-inpainted instantly
   * **Text `T`** — double-click to place a translation where the original
     text was: font / size / color / outline; drag to move, drag the corner
     square to resize, drag the top knob to rotate smoothly (Shift snaps to
     15°), `Del` deletes; stored per page and **burned into the exported
     files** (rotation included)
   * **Undo / redo across mask, paint, and text edits** (Ctrl+Z / Ctrl+Y)
6. **Export** — original filenames into the project's `output/` folder (or
   any folder you pick), translations rendered in, plus a ZIP download.

### Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `◀` `▶` (or `,` `.`) | previous / next page | `D` | auto-detect page |
| `B` / `E` / `R` / `L` / `H` | brush / eraser / rect / polygon / pan | `Enter` | clean page (or close polygon) |
| `P` / `O` / `J` / `T` | paint / restore / heal / text | `M` | toggle mask |
| `C` (hold) | compare with original | `Shift+R` | revert to original |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo | `[` / `]` | brush size |
| `Alt+click` | eyedropper (paint tool) | `+` `−` `0` `1` | zoom / fit / 100% |

## CLI (automation / scripting)

```bash
python main.py --input page.png                       # single page
python main.py --input chapter/ --batch --output out/ # whole folder
python main.py --input page.png --model opencv        # CPU-fast fallback
python main.py --input page.png --mask-only           # export mask for hand editing
python main.py --input page.png --mask page_mask.png  # clean with a hand-made mask
```

Run `python main.py --help` for all options (`--detect balloon|sfx|both`,
`--dilate`, `--feather`, `--device`, …). The comic-text-detector thresholds
are also available as flags — `--ctd-conf 0.3` catches more text,
`--ctd-mask-thresh` / `--ctd-line-thresh` fine-tune the mask (equivalent to
the `MANGACLEANER_CTD_*` environment variables). Installed as a package it
is also available as the `manga-cleaner` command.

## Project structure

```
manga-text-cleaner/
├── run.py                     # Studio launcher (browser)
├── desktop.py                 # Studio launcher (native window, pywebview)
├── main.py                    # CLI entry point
├── pyproject.toml             # package metadata (pip install -e .)
├── requirements.txt
├── mangacleaner/
│   ├── cli.py                 # command-line interface
│   ├── core/                  # UI-agnostic image pipeline
│   │   ├── io_utils.py        #   unicode/webp-safe read & write
│   │   ├── detection.py       #   OpenCV heuristics + comic-text-detector backend
│   │   ├── ctd.py             #   self-contained comic-text-detector onnx wrapper
│   │   ├── inpainting.py      #   LaMa (simple-lama / IOPaint) + Telea fallback
│   │   ├── postprocess.py     #   dilate, feather, white-balloon preservation
│   │   ├── typeset.py         #   render translations onto exported pages
│   │   └── pipeline.py        #   cached models, thread-safe entry points
│   └── server/
│       ├── app.py             # FastAPI REST API
│       ├── project.py         # named projects (persistence), batch job, export
│       └── static/            # SPA: index.html, app.js, editor.js, i18n.js, style.css
├── scripts/
│   └── ctd_demo.py            # standalone comic-text-detector sanity check
├── tests/
│   ├── test_api.py            # end-to-end API tests (projects, batch, export)
│   └── test_detection.py      # detector unit tests
└── examples/                  # real manga/manhwa pages + before/after output
```

## How it works

detection → mask refinement → inpainting → post-processing:

1. **Detect** — comic-text-detector (manga-trained, see table above) or
   built-in heuristics: balloons are large convex white regions (dark
   pixels inside = text); SFX are clustered letter-shaped dark components
   outside balloons.
2. **Refine** — morphological dilation so no text edge survives, then the
   mask is handed to the editor for optional manual correction.
3. **Inpaint** — LaMa (GPU/CPU) or OpenCV Telea, run only on padded crops
   around the masked regions, so cost scales with the amount of text rather
   than the page size (a full-page pass is used only when text covers most
   of the page).
4. **Post-process** — near-white surroundings are flood-filled flat white
   (balloons stay pure white, never gray); mask edges are feathered;
   **pixels outside the mask are never modified**.

## Testing

```bash
python tests/test_detection.py   # detector unit tests (dark/light text, shapes, blanks;
                                 # comic-text-detector cases run when weights are present)
python tests/test_api.py         # end-to-end API suite (projects, batch, export)
python scripts/ctd_demo.py       # visual check: draws ctd boxes + mask for one page
```

## Known limitations

- The heuristic SFX detector can miss stylized SFX drawn over dense art —
  that is exactly what the manual brush workflow is for.
- OpenCV Telea inpainting smears screentones; install LaMa for quality.

## License

[MIT](LICENSE). The optional comic-text-detector weights are published by the
GPL-3.0 [manga-image-translator](https://github.com/zyddnys/manga-image-translator)
project and are downloaded at runtime by the user — they are not part of this
repository (see the note in the detector section above).
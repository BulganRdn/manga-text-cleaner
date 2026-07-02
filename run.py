#!/usr/bin/env python3
from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser

for _stream in (sys.stdout, sys.stderr):
    if _stream and _stream.encoding and _stream.encoding.lower() not in ("utf-8", "utf8"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

logging.basicConfig(level=logging.INFO, format="[%(levelname).1s] %(message)s")


def main() -> None:
    ap = argparse.ArgumentParser(description="Manga Cleaner Studio")
    ap.add_argument("--port", type=int, default=8420)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    try:
        import uvicorn
    except ImportError:
        sys.exit("uvicorn is not installed — run: pip install -r requirements.txt")

    from mangacleaner.server.app import app

    url = f"http://{args.host}:{args.port}"
    print(f"\n  Manga Cleaner Studio  →  {url}\n")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import logging
import socket
import sys
import threading
import time
import urllib.request

for _stream in (sys.stdout, sys.stderr):
    if _stream and _stream.encoding and _stream.encoding.lower() not in ("utf-8", "utf8"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

logging.basicConfig(level=logging.INFO, format="[%(levelname).1s] %(message)s")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class NativeApi:
    """pywebview exposes every public method to JS — keep internals underscored."""

    def __init__(self) -> None:
        self._window = None

    def _pick(self) -> str | None:
        import webview
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        return result[0] if result else None

    def pick_folder(self):
        return self._pick()

    def pick_output_folder(self):
        return self._pick()


def main() -> None:
    ap = argparse.ArgumentParser(description="Manga Cleaner Studio (desktop)")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()

    try:
        import webview
    except ImportError:
        sys.exit("pywebview is not installed — run: pip install pywebview\n"
                 "(or use the browser version: python run.py)")
    try:
        import uvicorn
    except ImportError:
        sys.exit("uvicorn is not installed — run: pip install -r requirements.txt")

    from mangacleaner.server.app import app

    port = args.port or free_port()
    url = f"http://127.0.0.1:{port}"

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()

    for _ in range(100):
        try:
            urllib.request.urlopen(url + "/api/meta", timeout=0.5)
            break
        except Exception:
            time.sleep(0.1)

    api = NativeApi()
    window = webview.create_window(
        "Manga Cleaner Studio", url,
        width=1440, height=900, min_size=(1000, 640),
        background_color="#131519", js_api=api, confirm_close=True,
        zoomable=False)
    api._window = window
    webview.start()


if __name__ == "__main__":
    main()

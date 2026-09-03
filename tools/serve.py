# -*- coding: utf-8 -*-
"""Start the loopback server before opening the browser, preserving the data origin."""
import functools
import http.server
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = 'http://localhost:8642/'  # Keep the existing IndexedDB/localStorage origin.

def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8642), handler)
    except OSError as exc:
        print('Cannot start the workbench on port 8642:', exc)
        print('If the workbench is already running, refresh its existing browser tab.')
        return 1
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print('Workbench ready:', URL)
    print('Keep this window open. Press Ctrl+C to stop.')
    webbrowser.open(URL)
    try:
        thread.join()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
    return 0

if __name__ == '__main__':
    raise SystemExit(main())

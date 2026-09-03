# -*- coding: utf-8 -*-
"""Start the loopback server before opening the browser, preserving the data origin."""
import argparse
import functools
import http.server
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8642

def options():
    parser = argparse.ArgumentParser(description='Run the research reading workbench on loopback.')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help='loopback port (default: 8642)')
    parser.add_argument('--no-browser', action='store_true', help='do not open the default browser')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    return args

def main():
    args = options()
    url = f'http://localhost:{args.port}/'
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as exc:
        print(f'Cannot start the workbench on port {args.port}:', exc)
        print('If the workbench is already running, refresh its existing browser tab.')
        return 1
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print('Workbench ready:', url)
    if args.port != DEFAULT_PORT:
        print('Note: a different port uses a separate browser data origin.')
    print('Keep this window open. Press Ctrl+C to stop.')
    if not args.no_browser:
        webbrowser.open(url)
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

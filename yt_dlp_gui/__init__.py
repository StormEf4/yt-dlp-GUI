"""A simple graphical app for downloading audio with yt-dlp"""

import argparse
import contextlib
import sys
import webbrowser

from .server import make_server, watch_idle


def _say(msg):
    sys.stdout.write(msg + '\n')
    sys.stdout.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(prog='yt-dlp-gui', description='Download audio from YouTube and other sites')
    parser.add_argument('--port', type=int, default=0, help='port to listen on (default: any free port)')
    parser.add_argument('--no-browser', action='store_true', help='do not open the app automatically')
    parser.add_argument('--browser', action='store_true',
                        help='open in the web browser even if pywebview is installed')
    args = parser.parse_args(argv)

    httpd, app = make_server(args.port)
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'

    webview = None
    if not (args.browser or args.no_browser):
        with contextlib.suppress(ImportError):
            import webview

    if webview:
        # Native window: the server runs in the background and the app exits when the window is closed
        import threading
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        webview.create_window('yt-dlp Audio', url, width=980, height=780, min_size=(420, 560))
        webview.start()
        return

    _say(f'yt-dlp Audio is running at {url}')
    _say('Close the browser tab or press Ctrl+C to quit')
    if not args.no_browser:
        webbrowser.open(url)
        watch_idle(httpd, app)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

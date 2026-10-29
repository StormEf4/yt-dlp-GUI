"""YouTubevert by StormEf4: a simple app for downloading audio and video from YouTube with yt-dlp"""

import argparse
import contextlib
import json
import os
import sys
import threading
import webbrowser

FROZEN = getattr(sys, 'frozen', False)


def _prepare_frozen():
    # The Windows app is built without a console, so there is nowhere to print to
    for name in ('stdout', 'stderr'):
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, 'w', encoding='utf-8'))
    # FFmpeg and Deno are bundled next to the app's files; yt-dlp finds them through PATH
    bundled = os.path.join(getattr(sys, '_MEIPASS', os.path.dirname(sys.executable)), 'bin')
    if os.path.isdir(bundled):
        os.environ['PATH'] = os.pathsep.join(filter(None, (bundled, os.environ.get('PATH'))))


if FROZEN:
    _prepare_frozen()

from .server import make_server, watch_idle


def _say(msg):
    sys.stdout.write(msg + '\n')
    sys.stdout.flush()


def _open_window(httpd, url):
    """Show the app in its own window (needs pywebview). Returns False if that isn't possible"""
    try:
        import webview
    except ImportError:
        return False
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        webview.create_window('YouTubevert by StormEf4', url, width=980, height=800, min_size=(420, 560),
                              background_color='#0f0c15')
        webview.start(gui='edgechromium' if os.name == 'nt' else None)
    except Exception:
        httpd.shutdown()
        return False
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(prog='yt-dlp-gui', description='YouTubevert by StormEf4: download audio and video from YouTube')
    parser.add_argument('--port', type=int, default=0, help='port to listen on (default: any free port)')
    parser.add_argument('--no-browser', action='store_true', help='do not open the app automatically')
    parser.add_argument('--browser', action='store_true',
                        help='open in the web browser even if pywebview is installed')
    parser.add_argument('--self-test', metavar='FILE', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    httpd, app = make_server(args.port)
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'

    if args.self_test:
        # Used by the build to check that the bundled tools are found
        with open(args.self_test, 'w', encoding='utf-8') as f:
            json.dump({k: v for k, v in app.state().items() if k != 'jobs'}, f, indent=2)
        httpd.server_close()
        return

    if not (args.browser or args.no_browser) and _open_window(httpd, url):
        httpd.server_close()
        return

    _say(f'YouTubevert is running at {url}')
    _say('Close the browser tab or press Ctrl+C to quit')
    if not args.no_browser:
        webbrowser.open(url)
        watch_idle(httpd, app)
    with contextlib.suppress(KeyboardInterrupt):
        httpd.serve_forever()
    httpd.server_close()

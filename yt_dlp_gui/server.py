"""Local HTTP server that serves the GUI and its JSON API (bound to 127.0.0.1 only)"""

import http.server
import json
import mimetypes
import os
import re
import secrets
import string
import subprocess
import sys
import threading
import time
import urllib.parse

from yt_dlp.dependencies import mutagen
from yt_dlp.version import __version__ as ytdlp_version

from .jobs import AUDIO_FORMATS, BLOCKED_BROWSERS, VIDEO_FORMATS, BROWSERS, JobManager, format_time, parse_time, probe, ffmpeg_available, youtube_missing
from .settings import Settings

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
URL_RE = re.compile(r'https?://\S+')


def _drives():
    return [f'{c}:\\' for c in string.ascii_uppercase if os.path.isdir(f'{c}:\\')]


def browse(path):
    """List the sub-directories of `path`. An empty path on Windows lists the drives"""
    if not path:
        if os.name == 'nt':
            return {'path': '', 'parent': None, 'dirs': [{'name': d, 'path': d} for d in _drives()]}
        path = os.path.abspath(os.sep)
    path = os.path.abspath(os.path.expanduser(path))
    parent = os.path.dirname(path)
    if parent == path:
        parent = '' if os.name == 'nt' else None
    dirs = []
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_dir() and not entry.name.startswith('.'):
                        dirs.append({'name': entry.name, 'path': entry.path})
                except OSError:
                    pass
    except OSError as e:
        return {'path': path, 'parent': parent, 'dirs': [], 'error': e.strerror or str(e)}
    dirs.sort(key=lambda d: d['name'].lower())
    return {'path': path, 'parent': parent, 'dirs': dirs}


def places():
    home = os.path.expanduser('~')
    result = [{'name': 'Home', 'path': home}]
    for name in ('Music', 'Downloads', 'Desktop', 'Documents'):
        path = os.path.join(home, name)
        if os.path.isdir(path):
            result.append({'name': name, 'path': path})
    return result


def reveal(path):
    """Show a file (or open a folder) in the system file manager"""
    if os.name == 'nt':
        if os.path.isfile(path):
            subprocess.Popen(['explorer', '/select,', path])
        else:
            os.startfile(path)
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', '-R', path] if os.path.isfile(path) else ['open', path])
    else:
        subprocess.Popen(['xdg-open', path if os.path.isdir(path) else os.path.dirname(path)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class App:
    def __init__(self, settings_path=None):
        self.token = secrets.token_urlsafe(24)
        self.settings = Settings(settings_path)
        self.jobs = JobManager()
        self.ffmpeg = ffmpeg_available()
        self.youtube_missing = youtube_missing()
        self.last_seen = time.monotonic()
        self.goodbye_at = None

    def state(self):
        return {
            'jobs': self.jobs.list(),
            'settings': self.settings.values,
            'ffmpeg': self.ffmpeg,
            'youtube_missing': self.youtube_missing,
            'browsers': [{'id': k, 'label': v, 'blocked': k in BLOCKED_BROWSERS} for k, v in BROWSERS.items()],
            'version': ytdlp_version,
            'formats': [
                {'id': k, 'label': label, 'lossless': lossless, 'cover': cover}
                for k, (label, lossless, cover) in AUDIO_FORMATS.items()],
            'video_formats': [
                {'id': k, 'label': label, 'description': desc, 'cover': cover}
                for k, (label, desc, cover, _) in VIDEO_FORMATS.items()],
            'mutagen': bool(mutagen),
            'busy': self.jobs.busy,
        }


class Handler(http.server.BaseHTTPRequestHandler):
    app: App
    server_version = 'youtubevert'

    def log_message(self, format, *args):
        pass

    # --- helpers ---

    def _send(self, code, body=b'', content_type='application/json', headers=None):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _json(self, data, code=200):
        self._send(code, json.dumps(data).encode())

    def _error(self, message, code=400):
        self._json({'error': message}, code)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(min(length, 1 << 20)))
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def _host_ok(self):
        # Guards against DNS rebinding: only accept requests addressed to the loopback host
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
        return host in ('127.0.0.1', 'localhost')

    def _authorized(self, query):
        token = self.headers.get('X-Token') or (query.get('token') or [''])[0]
        return secrets.compare_digest(token, self.app.token)

    def _route(self, method):
        if not self._host_ok():
            return self._error('Forbidden', 403)
        url = urllib.parse.urlsplit(self.path)
        path, query = url.path, urllib.parse.parse_qs(url.query)

        if method == 'GET' and path in ('/', '/index.html'):
            return self._index()
        if method == 'GET' and path.startswith('/static/'):
            return self._static(path.removeprefix('/static/'))
        if not path.startswith('/api/'):
            return self._error('Not found', 404)
        if not self._authorized(query):
            return self._error('Forbidden', 403)

        self.app.last_seen = time.monotonic()
        self.app.goodbye_at = None
        endpoint = f'{method} {path.removeprefix("/api")}'
        m = re.fullmatch(r'(\w+) /jobs/(\d+)(/cancel)?', endpoint)
        if m:
            job = self.app.jobs.get(int(m.group(2)))
            if not job:
                return self._error('No such download', 404)
            if m.group(1) == 'POST' and m.group(3):
                job.cancel()
                return self._json(job.to_dict())
            if m.group(1) == 'DELETE' and not m.group(3):
                self.app.jobs.remove(job.id)
                return self._json({'ok': True})
            return self._error('Not found', 404)

        handler = {
            'GET /state': self._state,
            'POST /jobs': self._add_jobs,
            'POST /jobs/clear': self._clear,
            'POST /settings': self._settings,
            'GET /browse': lambda: self._json({**browse((query.get('path') or [''])[0]), 'places': places()}),
            'POST /reveal': self._reveal,
            'GET /info': lambda: self._info((query.get('url') or [''])[0]),
            'POST /bye': self._bye,
        }.get(endpoint)
        if not handler:
            return self._error('Not found', 404)
        return handler()

    # --- pages ---

    def _index(self):
        with open(os.path.join(STATIC_DIR, 'index.html'), encoding='utf-8') as f:
            html = f.read().replace('{{TOKEN}}', self.app.token)
        self._send(200, html.encode(), 'text/html; charset=utf-8', {
            'Content-Security-Policy': (
                "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self' https://www.youtube.com https://s.ytimg.com; "
                "frame-src https://www.youtube-nocookie.com https://www.youtube.com; "
                "connect-src 'self'; frame-ancestors 'none'"),
            # YouTube's embedded player refuses to play without a referrer
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        })

    def _static(self, name):
        if not re.fullmatch(r'[\w-]+\.(css|js|svg|png)', name):
            return self._error('Not found', 404)
        try:
            with open(os.path.join(STATIC_DIR, name), 'rb') as f:
                body = f.read()
        except OSError:
            return self._error('Not found', 404)
        content_type = mimetypes.guess_type(name)[0] or 'application/octet-stream'
        if content_type.startswith('text/') or name.endswith('.js'):
            content_type += '; charset=utf-8'
        self._send(200, body, content_type)

    # --- API ---

    def _state(self):
        self._json(self.app.state())

    def _add_jobs(self):
        body = self._body()
        urls = list(dict.fromkeys(URL_RE.findall(str(body.get('url') or ''))))
        if not urls:
            return self._error('That doesn\'t look like a link. Paste a YouTube link starting with https://')
        if not self.app.ffmpeg:
            return self._error('FFmpeg was not found. It is needed to convert downloads')
        mode = body.get('mode') if body.get('mode') in ('audio', 'video') else 'audio'
        options = self.app.settings.for_mode(mode)
        for key, label in (('start', 'Start'), ('end', 'End')):
            try:
                options[key] = parse_time(body.get(key))
            except ValueError:
                return self._error(f'{label} time should look like 1:30 (minutes:seconds) or 1:02:30')
        if options['end'] is not None and options['end'] <= (options['start'] or 0):
            return self._error(f'The end time must be after the start time ({format_time(options["start"] or 0)})')
        if not os.path.isdir(options['outdir']):
            try:
                os.makedirs(options['outdir'], exist_ok=True)
            except OSError:
                return self._error('The output folder does not exist. Choose another one')
        jobs = [self.app.jobs.add(url, options).to_dict() for url in urls]
        self._json({'jobs': jobs})

    def _info(self, text):
        urls = URL_RE.findall(text)
        if len(urls) != 1:
            return self._error('Paste one YouTube link to trim it' if not urls else 'Trim works on one link at a time')
        try:
            self._json(probe(urls[0], self.app.settings.values['browser']))
        except ValueError as e:
            self._error(str(e))

    def _clear(self):
        mode = self._body().get('mode')
        self.app.jobs.clear_finished(mode if mode in ('audio', 'video') else None)
        self._json({'ok': True})

    def _settings(self):
        rejected = self.app.settings.update(self._body())
        if rejected:
            return self._json({'error': 'Invalid setting: ' + ', '.join(rejected), 'settings': self.app.settings.values}, 400)
        self._json({'settings': self.app.settings.values})

    def _reveal(self):
        path = str(self._body().get('path') or '')
        # Only reveal what this app created or the chosen output folder
        allowed = self.app.jobs.known_files() | {self.app.settings.values[k] for k in ('outdir', 'video_outdir')}
        if path not in allowed:
            return self._error('Not allowed', 403)
        if not os.path.exists(path):
            return self._error('That file no longer exists', 404)
        try:
            reveal(path)
        except OSError as e:
            return self._error(f'Could not open the file manager: {e}', 500)
        self._json({'ok': True})

    def _bye(self):
        # The page was closed. Shut down shortly unless it reconnects (eg: a page reload)
        self.app.goodbye_at = time.monotonic()
        self._json({'ok': True})

    def do_GET(self):
        self._route('GET')

    def do_HEAD(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def do_DELETE(self):
        self._route('DELETE')


def make_server(port=0, settings_path=None):
    app = App(settings_path)
    handler = type('BoundHandler', (Handler,), {'app': app})
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    httpd.daemon_threads = True
    return httpd, app


def watch_idle(httpd, app, grace=5, idle_timeout=15 * 60):
    """Stop the server once the page is closed (or abandoned) and no download is running"""
    def run():
        while True:
            time.sleep(1)
            if app.jobs.busy:
                continue
            now = time.monotonic()
            if (app.goodbye_at and now - app.goodbye_at > grace) or now - app.last_seen > idle_timeout:
                httpd.shutdown()
                return
    threading.Thread(target=run, daemon=True).start()


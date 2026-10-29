"""Download jobs: each job turns one URL (video or playlist) into audio files"""

import itertools
import os
import queue
import re
import sys
import threading
import time

import yt_dlp
from yt_dlp.cookies import CHROMIUM_BASED_BROWSERS, SUPPORTED_BROWSERS
from yt_dlp.dependencies import mutagen, yt_dlp_ejs
from yt_dlp.postprocessor.ffmpeg import FFmpegPostProcessor
from yt_dlp.utils import DownloadCancelled

AUDIO_FORMATS = {
    # id: (label, lossless, cover art supported)
    'mp3': ('MP3', False, True),
    'm4a': ('M4A', False, True),
    'opus': ('Opus', False, bool(mutagen)),
    'flac': ('FLAC', True, bool(mutagen)),
    'wav': ('WAV', True, False),
}
QUALITIES = ('0', '320K', '256K', '192K', '128K')
# Browsers whose YouTube login can be borrowed to get past "confirm you're not a bot"
BROWSERS = {k: v for k, v in {
    'chrome': 'Chrome', 'firefox': 'Firefox', 'edge': 'Edge', 'brave': 'Brave', 'safari': 'Safari',
    'opera': 'Opera', 'vivaldi': 'Vivaldi', 'chromium': 'Chromium', 'whale': 'Whale',
}.items() if k in SUPPORTED_BROWSERS and (k != 'safari' or sys.platform == 'darwin')}
# On Windows, Chromium-based browsers encrypt their logins so that only the browser itself can read them
# Ref: https://github.com/yt-dlp/yt-dlp/issues/10927
BLOCKED_BROWSERS = CHROMIUM_BASED_BROWSERS & BROWSERS.keys() if os.name == 'nt' else set()
SIGN_IN_HINT = (
    'choose Firefox under "YouTube sign-in" (you must be logged in to YouTube there)' if os.name == 'nt'
    else 'choose a browser you\'re logged in to YouTube with under "YouTube sign-in"')

SINGLE_OUTTMPL = '%(title)s.%(ext)s'
PLAYLIST_OUTTMPL = os.path.join('%(playlist_title,playlist_id)s', '%(playlist_index)02d - %(title)s.%(ext)s')

_ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')
_TIME_RE = re.compile(r'(?:(?:(\d+):)?(\d+):)?(\d+(?:[.,]\d+)?)')


def parse_time(text):
    """'90', '1:30', '1:02:03' or '1:30.5' -> seconds. Empty -> None. Raises ValueError if invalid"""
    text = str(text or '').strip()
    if not text:
        return None
    m = _TIME_RE.fullmatch(text)
    if not m:
        raise ValueError(text)
    h, mins, sec = m.groups()
    if (h is not None and int(mins) >= 60) or (mins is not None and float(sec.replace(',', '.')) >= 60):
        raise ValueError(text)
    return int(h or 0) * 3600 + int(mins or 0) * 60 + float(sec.replace(',', '.'))


def format_time(seconds, sep=':'):
    """Seconds -> '1:30' or '1:02:03' (with sep=None: '1m30s', '1h02m03s' for use in file names)"""
    whole = int(seconds)
    h, m, s = whole // 3600, whole % 3600 // 60, whole % 60
    frac = f'{seconds - whole:.1f}'[1:] if seconds - whole >= 0.05 else ''
    if sep is None:
        return f'{h}h{m:02d}m{s:02d}{frac}s' if h else f'{m}m{s:02d}{frac}s'
    return f'{h}:{m:02d}:{s:02d}{frac}' if h else f'{m}:{s:02d}{frac}'


def ffmpeg_available():
    try:
        return FFmpegPostProcessor().available
    except Exception:
        return False


def youtube_missing():
    """YouTube needs a JavaScript runtime (Deno) and the yt-dlp-ejs scripts. Returns what is missing"""
    missing = []
    try:
        with yt_dlp.YoutubeDL({**yt_dlp.parse_options(['--ignore-config']).ydl_opts, 'quiet': True}) as ydl:
            if not any(rt is not None and rt.info is not None for rt in ydl._js_runtimes.values()):
                missing.append('deno')
    except Exception:
        pass  # Don't warn if unsure
    if not yt_dlp_ejs:
        missing.append('yt-dlp-ejs')
    return missing


_FRIENDLY_ERRORS = (
    (r'confirm you.re not a bot|Sign in to confirm',
     f'YouTube wants to check you\'re not a bot. To get past this, {SIGN_IN_HINT} and try again.'),
    (r'(?i)decrypt with DPAPI|could not copy chrome cookie',
     ('That browser keeps its YouTube login locked, so this app can\'t use it. Set "YouTube sign-in" to '
      '"Not needed", or use Firefox.')),
    (r'(?i)could not find \w+ cookies database|could not find firefox',
     ('That browser doesn\'t seem to be installed or has never been opened. Set "YouTube sign-in" to '
      '"Not needed", or pick a different browser.')),
    (r'(?i)cookies? (database|from browser)|load cookies',
     ('Couldn\'t read your YouTube login from that browser. Close the browser completely and try again, '
      'or set "YouTube sign-in" to "Not needed".')),
    (r'Private video', 'This video is private.'),
    (r'(?i)members.only|join this channel', 'This video is only for channel members.'),
    (r'(?i)confirm your age|age.restricted|inappropriate for some users',
     f'This video is age-restricted. To download it, {SIGN_IN_HINT} and try again.'),
    (r'(?i)premieres in|live event will begin', 'This video hasn\'t premiered yet.'),
    (r'(?i)video unavailable|this video is unavailable|is not available|has been removed',
     'This video is unavailable. It may have been removed or blocked in your country.'),
    (r'Unsupported URL|is not a valid URL', 'That link doesn\'t point to a YouTube video or playlist.'),
    (r'HTTP Error 403',
     ('YouTube refused the download (error 403). Wait a minute and try again. If it keeps happening, '
      f'{SIGN_IN_HINT}.')),
    (r'(?i)unable to download (webpage|api)|urlopen error|timed out|getaddrinfo|Network is unreachable',
     'Couldn\'t reach YouTube. Check your internet connection and try again.'),
)


def friendly_error(msg):
    msg = _ANSI_RE.sub('', str(msg)).removeprefix('ERROR: ').strip()
    for pattern, friendly in _FRIENDLY_ERRORS:
        if re.search(pattern, msg):
            return friendly
    return msg


def _best_storyboard(info, duration):
    """The sharpest storyboard (sprite sheets of evenly spaced frames) YouTube offers, for the trim timeline"""
    boards = [
        f for f in info.get('formats') or []
        if f.get('format_note') == 'storyboard' and f.get('fragments') and f.get('rows') and f.get('columns')]
    if not boards or not duration:
        return None
    sb = max(boards, key=lambda f: (f.get('width') or 0) * (f.get('height') or 0))
    return {
        'urls': [frag['url'] for frag in sb['fragments']],
        'width': sb['width'],
        'height': sb['height'],
        'columns': sb['columns'],
        'rows': sb['rows'],
        'count': max(1, round((sb.get('fps') or 0) * duration)),
    }


def probe(url, browser=''):
    """Look up a single video (without downloading it) for the trim panel"""
    args = ['--ignore-config', '--no-playlist']
    if browser:
        args += ['--cookies-from-browser', browser]
    errors = []
    logger = type('_ProbeLogger', (), {
        'debug': lambda self, msg: None, 'info': lambda self, msg: None,
        'warning': lambda self, msg: None, 'error': lambda self, msg: errors.append(msg)})()
    try:
        with yt_dlp.YoutubeDL({**yt_dlp.parse_options(args).ydl_opts, 'quiet': True, 'logger': logger}) as ydl:
            info = ydl.extract_info(url, download=False, process=False)
    except Exception as e:
        raise ValueError(friendly_error(errors[-1] if errors else e))
    if not info:
        raise ValueError(friendly_error(errors[-1]) if errors else 'Nothing found at this link')
    if info.get('_type') in ('playlist', 'multi_video'):
        raise ValueError('Trimming works on a single video. Paste the link of one video from the playlist.')
    duration = info.get('duration')
    if not duration or info.get('is_live'):
        raise ValueError('This video can\'t be trimmed because its length is unknown (live streams can\'t be trimmed).')
    return {
        'id': info.get('id'),
        'title': info.get('title'),
        'uploader': info.get('uploader') or info.get('channel'),
        'duration': duration,
        'thumbnail': _best_thumbnail(info),
        'embed': info.get('extractor_key') == 'Youtube' and info.get('playable_in_embed') is not False,
        'storyboard': _best_storyboard(info, duration),
    }


class JobCancelled(DownloadCancelled):
    msg = 'Cancelled'


class _Logger:
    def __init__(self, job):
        self.job = job

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        self.job.add_error(msg)


def _best_thumbnail(info):
    if info.get('thumbnail'):
        return info['thumbnail']
    thumbs = [t for t in info.get('thumbnails') or [] if t.get('url')]
    return thumbs[-1]['url'] if thumbs else None


class Job:
    _ids = itertools.count(1)

    def __init__(self, url, options):
        self.id = next(self._ids)
        self.url = url
        self.options = options
        self.created = time.time()
        self.status = 'queued'  # queued, fetching, downloading, converting, done, error, cancelled
        self.stage = 'Waiting in queue'
        self.title = None
        self.uploader = None
        self.thumbnail = None
        self.duration = None
        self.is_playlist = False
        self.playlist_index = None
        self.playlist_count = None
        self.item_title = None
        self.progress = 0.0
        self.speed = None
        self.eta = None
        self.total_bytes = None
        self.files = []
        self.errors = []
        self.error_detail = None
        self._cancel = threading.Event()

    def add_error(self, msg):
        self.error_detail = _ANSI_RE.sub('', str(msg)).removeprefix('ERROR: ').strip()
        self.errors.append(friendly_error(msg))

    def cancel(self):
        self._cancel.set()
        if self.status == 'queued':
            self.status, self.stage = 'cancelled', 'Cancelled'

    @property
    def finished(self):
        return self.status in ('done', 'error', 'cancelled')

    def to_dict(self):
        return {
            'id': self.id,
            'url': self.url,
            'status': self.status,
            'stage': self.stage,
            'title': self.title,
            'uploader': self.uploader,
            'thumbnail': self.thumbnail,
            'duration': self.duration,
            'is_playlist': self.is_playlist,
            'playlist_index': self.playlist_index,
            'playlist_count': self.playlist_count,
            'item_title': self.item_title,
            'progress': self.progress,
            'speed': self.speed,
            'eta': self.eta,
            'total_bytes': self.total_bytes,
            'format': self.options['format'],
            'section': self.section_label,
            'files': self.files,
            'error': self.errors[-1] if self.errors else None,
            'error_detail': self.error_detail,
            'error_count': len(self.errors),
        }

    @property
    def section_label(self):
        start, end = self.options.get('start'), self.options.get('end')
        if start is None and end is None:
            return None
        return f'{format_time(start or 0)} – {"end" if end is None else format_time(end)}'

    def _outtmpl(self, tmpl):
        start, end = self.options.get('start'), self.options.get('end')
        if start is None and end is None:
            return tmpl
        # Name clips after their section so they don't overwrite a full download of the same video
        suffix = f' ({format_time(start or 0, None)}-{"end" if end is None else format_time(end, None)})'
        return tmpl.replace('.%(ext)s', f'{suffix}.%(ext)s')

    def _check_cancel(self):
        if self._cancel.is_set():
            raise JobCancelled

    def _update_item(self, info):
        if not self.is_playlist:
            return
        self.playlist_index = info.get('playlist_index') or self.playlist_index
        self.playlist_count = info.get('n_entries') or info.get('playlist_count') or self.playlist_count
        self.item_title = info.get('title') or self.item_title
        self.thumbnail = _best_thumbnail(info) or self.thumbnail

    def _overall(self, item_progress):
        if self.is_playlist and self.playlist_count and self.playlist_index:
            return min(1.0, (self.playlist_index - 1 + item_progress) / self.playlist_count)
        return item_progress

    def _progress_hook(self, d):
        self._check_cancel()
        self._update_item(d.get('info_dict') or {})
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            if total:
                frac = d.get('downloaded_bytes', 0) / total
            elif d.get('fragment_count'):
                frac = (d.get('fragment_index') or 0) / d['fragment_count']
            else:
                frac = 0
            self.status, self.stage = 'downloading', 'Downloading'
            self.progress = self._overall(min(frac, 1.0) * 0.9)
            self.speed, self.eta, self.total_bytes = d.get('speed'), d.get('eta'), total
        elif d['status'] == 'finished':
            self.progress = self._overall(0.9)
            self.speed = self.eta = None

    def _postprocessor_hook(self, d):
        self._check_cancel()
        if d['status'] != 'started':
            return
        self._update_item(d.get('info_dict') or {})
        stage = {
            'ExtractAudio': f'Converting to {AUDIO_FORMATS[self.options["format"]][0]}',
            'Metadata': 'Adding tags',
            'EmbedThumbnail': 'Adding cover art',
        }.get(d.get('postprocessor'))
        if stage:
            self.status, self.stage = 'converting', stage
            self.speed = self.eta = None

    def _post_hook(self, filename):
        self.files.append(os.path.abspath(filename))

    def _ydl_opts(self):
        o = self.options
        args = ['--ignore-config', '-x', '--audio-format', o['format'], '-P', o['outdir'],
                '-o', self._outtmpl(SINGLE_OUTTMPL)]
        if o.get('start') is not None or o.get('end') is not None:
            # Only download (and convert) the chosen part of the video
            args += ['--download-sections', f'*{o.get("start") or 0}-{"inf" if o.get("end") is None else o["end"]}']
        if not AUDIO_FORMATS[o['format']][1]:
            args += ['--audio-quality', o['quality']]
        if o['metadata']:
            args.append('--embed-metadata')
        if o['thumbnail'] and AUDIO_FORMATS[o['format']][2]:
            args.append('--embed-thumbnail')
        args.append('--yes-playlist' if o['playlist'] else '--no-playlist')
        if o['browser']:
            args += ['--cookies-from-browser', o['browser']]
        opts = yt_dlp.parse_options(args).ydl_opts
        opts.update({
            'quiet': True,
            'no_warnings': True,
            'noprogress': True,
            'logger': _Logger(self),
            'progress_hooks': [self._progress_hook],
            'postprocessor_hooks': [self._postprocessor_hook],
            'post_hooks': [self._post_hook],
        })
        return opts

    def run(self):
        if self._cancel.is_set():
            return
        self.status, self.stage = 'fetching', 'Fetching info'
        try:
            with yt_dlp.YoutubeDL(self._ydl_opts()) as ydl:
                info = ydl.extract_info(self.url, download=False, process=False)
                self._check_cancel()
                if not info:
                    raise yt_dlp.utils.DownloadError(self.errors[-1] if self.errors else 'Nothing found at this link')
                self.is_playlist = info.get('_type') in ('playlist', 'multi_video')
                self.title = info.get('title') or info.get('id') or self.url
                self.uploader = info.get('uploader') or info.get('channel')
                self.thumbnail = _best_thumbnail(info)
                self.duration = info.get('duration')
                self.playlist_count = info.get('playlist_count')
                start = self.options.get('start')
                if not self.is_playlist and start and self.duration and start >= self.duration:
                    raise yt_dlp.utils.DownloadError(
                        f'The start time ({format_time(start)}) is after the end of the video ({format_time(self.duration)}).')
                if self.is_playlist:
                    ydl.params['outtmpl']['default'] = self._outtmpl(PLAYLIST_OUTTMPL)
                self.status, self.stage = 'downloading', 'Starting download'
                ydl.process_ie_result(info, download=True)
            self._check_cancel()
        except JobCancelled:
            self.status, self.stage = 'cancelled', 'Cancelled'
        except Exception as e:
            if self._cancel.is_set():
                self.status, self.stage = 'cancelled', 'Cancelled'
                return
            if not self.errors:
                self.add_error(e)
            self.status, self.stage = 'error', 'Failed'
        else:
            if self.files:
                self.status, self.progress = 'done', 1.0
                failed = len(self.errors)
                self.stage = f'{len(self.files)} saved, {failed} failed' if failed else 'Done'
            else:
                self.status, self.stage = 'error', 'Failed'
                if not self.errors:
                    self.errors.append('Nothing was downloaded')
        finally:
            self.speed = self.eta = None


class JobManager:
    def __init__(self, workers=2):
        self.jobs = {}
        self._queue = queue.Queue()
        self._lock = threading.Lock()
        for _ in range(workers):
            threading.Thread(target=self._worker, daemon=True).start()

    def _worker(self):
        while True:
            job = self._queue.get()
            try:
                job.run()
            finally:
                self._queue.task_done()

    def add(self, url, options):
        job = Job(url, options)
        with self._lock:
            self.jobs[job.id] = job
        self._queue.put(job)
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)

    def list(self):
        with self._lock:
            return [job.to_dict() for job in self.jobs.values()]

    def clear_finished(self):
        with self._lock:
            self.jobs = {k: v for k, v in self.jobs.items() if not v.finished}

    def remove(self, job_id):
        with self._lock:
            job = self.jobs.get(job_id)
            if job and job.finished:
                del self.jobs[job_id]

    @property
    def busy(self):
        return any(not job.finished for job in list(self.jobs.values()))

    def known_files(self):
        return {f for job in list(self.jobs.values()) for f in job.files}

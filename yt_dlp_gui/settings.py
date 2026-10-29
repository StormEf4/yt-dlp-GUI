import json
import os

from .jobs import AUDIO_FORMATS, BLOCKED_BROWSERS, BROWSERS, QUALITIES, VIDEO_FORMATS, VIDEO_QUALITIES


def _config_dir():
    if os.name == 'nt':
        base = os.getenv('APPDATA') or os.path.expanduser('~')
    else:
        base = os.getenv('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    return os.path.join(base, 'yt-dlp-gui')


def default_outdir(kind='Music'):
    home = os.path.expanduser('~')
    for name in (kind, 'Downloads'):
        path = os.path.join(home, name)
        if os.path.isdir(path):
            return path
    return home


DEFAULTS = {
    'outdir': None,
    'format': 'mp3',
    'quality': '0',
    'thumbnail': True,
    'metadata': True,
    'playlist': False,
    'browser': '',
    'video_outdir': None,
    'video_format': 'mp4',
    'video_quality': '1080',
    'video_thumbnail': True,
    'video_metadata': True,
    'video_playlist': False,
}

VALIDATORS = {
    'outdir': lambda v: isinstance(v, str) and os.path.isdir(v),
    'format': lambda v: v in AUDIO_FORMATS,
    'quality': lambda v: v in QUALITIES,
    'thumbnail': lambda v: isinstance(v, bool),
    'metadata': lambda v: isinstance(v, bool),
    'playlist': lambda v: isinstance(v, bool),
    'browser': lambda v: v == '' or (v in BROWSERS and v not in BLOCKED_BROWSERS),
    'video_outdir': lambda v: isinstance(v, str) and os.path.isdir(v),
    'video_format': lambda v: v in VIDEO_FORMATS,
    'video_quality': lambda v: v in VIDEO_QUALITIES,
    'video_thumbnail': lambda v: isinstance(v, bool),
    'video_metadata': lambda v: isinstance(v, bool),
    'video_playlist': lambda v: isinstance(v, bool),
}

# The settings each tab uses when adding a download
MODE_KEYS = {
    'audio': {k: k for k in ('outdir', 'format', 'quality', 'thumbnail', 'metadata', 'playlist')},
    'video': {k: f'video_{k}' for k in ('outdir', 'format', 'quality', 'thumbnail', 'metadata', 'playlist')},
}


class Settings:
    def __init__(self, path=None):
        self.path = path or os.path.join(_config_dir(), 'settings.json')
        self.values = {**DEFAULTS, 'outdir': default_outdir(), 'video_outdir': default_outdir('Videos')}
        try:
            with open(self.path, encoding='utf-8') as f:
                self.update(json.load(f), save=False)
        except (OSError, ValueError, AttributeError):
            pass

    def update(self, new, save=True):
        """Apply valid values from `new`; returns the keys that were rejected"""
        rejected = []
        for key, value in new.items():
            if key not in VALIDATORS:
                continue
            if VALIDATORS[key](value):
                self.values[key] = value
            else:
                rejected.append(key)
        if save:
            self.save()
        return rejected

    def for_mode(self, mode):
        """Download options for the "audio" or "video" tab"""
        return {'mode': mode, 'browser': self.values['browser'],
                **{k: self.values[key] for k, key in MODE_KEYS[mode].items()}}

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump(self.values, f, indent=2)
        except OSError:
            pass

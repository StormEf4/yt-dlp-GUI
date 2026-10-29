import json
import os

from .jobs import AUDIO_FORMATS, BROWSERS, QUALITIES


def _config_dir():
    if os.name == 'nt':
        base = os.getenv('APPDATA') or os.path.expanduser('~')
    else:
        base = os.getenv('XDG_CONFIG_HOME') or os.path.expanduser('~/.config')
    return os.path.join(base, 'yt-dlp-gui')


def default_outdir():
    home = os.path.expanduser('~')
    for name in ('Music', 'Downloads'):
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
}

VALIDATORS = {
    'outdir': lambda v: isinstance(v, str) and os.path.isdir(v),
    'format': lambda v: v in AUDIO_FORMATS,
    'quality': lambda v: v in QUALITIES,
    'thumbnail': lambda v: isinstance(v, bool),
    'metadata': lambda v: isinstance(v, bool),
    'playlist': lambda v: isinstance(v, bool),
    'browser': lambda v: v == '' or v in BROWSERS,
}


class Settings:
    def __init__(self, path=None):
        self.path = path or os.path.join(_config_dir(), 'settings.json')
        self.values = {**DEFAULTS, 'outdir': default_outdir()}
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

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump(self.values, f, indent=2)
        except OSError:
            pass

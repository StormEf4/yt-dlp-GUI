#!/usr/bin/env python3

"""Build "yt-dlp Audio" into a single double-clickable app with FFmpeg and Deno inside

Usage: python bundle/gui_exe.py --ffmpeg PATH/TO/ffmpeg[.exe] [--deno PATH/TO/deno[.exe]] [extra PyInstaller options]
Needs: pyinstaller, pywebview, pillow and yt-dlp's default dependencies (incl. yt-dlp-ejs, mutagen, deno)
"""

# Allow direct execution
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import argparse
import shutil

from PyInstaller.__main__ import run as run_pyinstaller

NAME = 'yt-dlp-Audio'
STAGE = os.path.join('build', 'gui')


def find_deno():
    try:
        import deno
        return deno.find_deno_bin()
    except Exception:
        return shutil.which('deno')


def make_icon(path):
    """Draw the app icon (gradient tile with equalizer bars), matching yt_dlp_gui/static/icon.svg"""
    from PIL import Image, ImageDraw

    size = 256
    start, mid, end = (0xff, 0x4f, 0x7b), (0xff, 0x7a, 0x5c), (0xff, 0xa9, 0x4d)

    def colour(t):
        a, b, t = (start, mid, t / 0.55) if t < 0.55 else (mid, end, (t - 0.55) / 0.45)
        return tuple(round(x + (y - x) * t) for x, y in zip(a, b, strict=True))

    gradient = Image.new('RGB', (size, size))
    gradient.putdata([colour((x + y) / (2 * (size - 1))) for y in range(size) for x in range(size)])
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=64, fill=255)
    icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    for x, y, h in ((64, 108, 56), (100, 68, 136), (136, 92, 88), (172, 116, 44)):
        draw.rounded_rectangle((x, y, x + 24, y + h), radius=12, fill='white')
    icon.save(path, sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ffmpeg', required=True, help='path to the ffmpeg executable to bundle')
    parser.add_argument('--deno', default=find_deno(), help='path to the deno executable to bundle')
    args, extra = parser.parse_known_args()

    if not args.deno or not os.path.isfile(args.deno):
        parser.error('Deno was not found. Install it with "pip install deno" or pass --deno')
    if not os.path.isfile(args.ffmpeg):
        parser.error(f'{args.ffmpeg} does not exist')

    bin_dir = os.path.join(STAGE, 'bin')
    shutil.rmtree(STAGE, ignore_errors=True)
    os.makedirs(bin_dir)
    for exe in (args.ffmpeg, args.deno):
        shutil.copy2(exe, bin_dir)
    icon = os.path.abspath(os.path.join(STAGE, 'icon.ico'))
    make_icon(icon)

    opts = [
        f'--name={NAME}',
        '--onefile',
        '--windowed',
        f'--icon={icon}',
        '--noconfirm',
        f'--workpath={os.path.join(STAGE, "work")}',
        f'--specpath={STAGE}',
        '--additional-hooks-dir=yt_dlp/__pyinstaller',
        f'--add-data={os.path.abspath("yt_dlp_gui/static")}{os.pathsep}yt_dlp_gui/static',
        f'--add-data={os.path.abspath("THIRD_PARTY_LICENSES.txt")}{os.pathsep}.',
        f'--add-binary={os.path.abspath(bin_dir)}{os.pathsep}bin',
        '--collect-submodules=webview',
        # Same exclusions as the yt-dlp executable (see bundle/pyinstaller.py)
        '--exclude-module=setuptools',
        '--exclude-module=packaging',
        '--exclude-module=pkg_resources',
        '--exclude-module=tkinter',
        *extra,
        'yt_dlp_gui/__main__.py',
    ]
    print(f'Running PyInstaller with {opts}')
    run_pyinstaller(opts)


if __name__ == '__main__':
    main()

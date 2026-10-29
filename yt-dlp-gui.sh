#!/usr/bin/env sh
exec "${PYTHON:-python3}" "$(dirname "$(realpath "$0")")/yt_dlp_gui/__main__.py" "$@"

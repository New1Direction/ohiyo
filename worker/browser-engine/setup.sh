#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# Deliberately no crawl4ai-setup, playwright install, browser launch or download.

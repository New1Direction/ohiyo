#!/usr/bin/env python3
"""Stamps the links to site.css and site.js in every page of ohiyo.gg with a hash of the file.

Browsers keep the stylesheet and the script for ten minutes. With a plain `site.css` link, a
page fetched right after a release could be drawn with the stylesheet from before it, and a
new page with old styles is a broken page. A link such as `site.css?v=3f9a1c20b7` changes
whenever the file does, so a new page always asks for the new file.

Run this after changing site/site.css or site/site.js:

    python3 scripts/site-version.py           # rewrite the links
    python3 scripts/site-version.py --check   # exit 1 if a page is out of step
"""
import hashlib
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
# The attribute each file is linked with, and the file.
LINKS = (("href", "site.css"), ("src", "site.js"))


def version(name: str) -> str:
    return hashlib.sha256((SITE / name).read_bytes()).hexdigest()[:10]


def stamped(html: str) -> str:
    for attribute, name in LINKS:
        pattern = re.compile(rf'{attribute}="{re.escape(name)}(?:\?v=[0-9a-f]+)?"')
        html = pattern.sub(f'{attribute}="{name}?v={version(name)}"', html)
    return html


def main() -> None:
    stale = []
    for page in sorted(SITE.glob("*.html")):
        html = page.read_text()
        fresh = stamped(html)
        if fresh == html:
            continue
        stale.append(page.name)
        if "--check" not in sys.argv:
            page.write_text(fresh)
    if "--check" in sys.argv:
        if stale:
            raise SystemExit(f"out of step: {', '.join(stale)}. Run python3 scripts/site-version.py")
        print("stylesheet and script links are in step")
        return
    print(f"stamped {len(stale)} page(s): site.css?v={version('site.css')}, site.js?v={version('site.js')}")


if __name__ == "__main__":
    main()

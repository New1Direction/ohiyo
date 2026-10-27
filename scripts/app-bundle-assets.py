#!/usr/bin/env python3
"""Validate the same-origin Vite JS/CSS graph; print reachable asset paths.

HTML can link CSS directly or leave it in Vite's JS dependency map. Only files
under /assets/ are eligible, including redirect targets; never follow remote URLs.
Uses only Python's standard library (also available on the reliability runner).
"""
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener


def main():
    app_url, html_file = sys.argv[1:]
    origin = urlsplit(app_url)
    base = f"{origin.scheme}://{origin.netloc}/"
    asset_path = re.compile(r"/assets/[A-Za-z0-9_-]+\.(?:js|css)$")
    entries = []

    def eligible(url):
        parts = urlsplit(url)
        return (parts.scheme, parts.netloc) == (origin.scheme, origin.netloc) and bool(
            asset_path.fullmatch(parts.path)
        ) and not parts.query and not parts.fragment

    def resolve(reference, parent):
        # Vite's preload map uses root-relative-to-base "assets/X.js" strings,
        # while imports use "./X.js" relative to the importing chunk.
        url = urljoin(base if reference.startswith("assets/") else parent, reference)
        return url if eligible(url) else None

    class HTMLAssets(HTMLParser):
        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            ref = attrs.get("src") if tag == "script" else attrs.get("href") if tag == "link" else None
            if ref:
                url = resolve(ref, app_url)
                if url:
                    entries.append(url)

    class AssetRedirects(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if not eligible(newurl):
                raise ValueError("asset redirected outside same-origin /assets/")
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    with open(html_file) as page:
        HTMLAssets().feed(page.read())
    if not any(re.fullmatch(r"/assets/index-[A-Za-z0-9_-]+\.js", urlsplit(url).path) for url in entries):
        raise ValueError("app bundle missing index JS asset in HTML")

    opener = build_opener(AssetRedirects())
    pending = list(dict.fromkeys(entries))
    seen = set()
    # Vite emits quoted imports and quoted preload-map entries. Do not extract
    # unquoted substrings of external URLs or arbitrary paths from bundle text.
    references = re.compile(r"[\"'`]([^\"'`\s<>]+\.(?:js|css))[\"'`]")
    while pending:
        url = pending.pop(0)
        if url in seen:
            continue
        if len(seen) >= 512:
            raise ValueError("app asset graph exceeds 512 files")
        seen.add(url)
        try:
            with opener.open(url, timeout=20) as response:
                mime = response.headers.get_content_type()
                extension = urlsplit(url).path.rsplit(".", 1)[1]
                allowed = {"text/css"} if extension == "css" else {"application/javascript", "text/javascript", "application/x-javascript"}
                if mime not in allowed:
                    raise ValueError(f"expected {extension}, got {mime} (possible HTML fallback)")
                body = response.read(20 * 1024 * 1024 + 1)
                if not body or len(body) > 20 * 1024 * 1024:
                    raise ValueError("empty or oversized asset")
        except Exception as error:
            raise ValueError(f"app-asset:{urlsplit(url).path.lstrip('/')} unavailable: {error}") from error
        if extension == "js":
            for reference in references.findall(body.decode("utf-8")):
                dependency = resolve(reference, url)
                if dependency and dependency not in seen:
                    pending.append(dependency)

    if not any(urlsplit(url).path.endswith(".css") for url in seen):
        raise ValueError("app bundle missing CSS assets in HTML and JS dependency graph")
    # Keep HTML entries ahead of dependency chunks for deploy's entry-JS marker.
    for url in sorted(seen, key=lambda url: (url not in entries, url)):
        print(urlsplit(url).path.lstrip("/"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        sys.exit(1)

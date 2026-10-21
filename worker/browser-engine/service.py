"""Single-scope, attach-only browser processor. Never dispatches model actions."""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import sys
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlsplit, urljoin

from aiohttp import web
from playwright.async_api import async_playwright
from bs4 import BeautifulSoup
from crawl4ai.content_filter_strategy import BM25ContentFilter, PruningContentFilterLXML
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
from schemas import extract_hotel

REQUEST_LIMIT = 64 * 1024
HTML_LIMIT = 2 * 1024 * 1024
MARKDOWN_LIMIT = 30_000
PNG_LIMIT = 3_000_000
JSON_LIMIT = 7_000_000
TIMEOUT = 30
BINDING = ("account", "workspace_id", "computer_id", "generation")
IDENTITY = ("account", "workspace_id", "task_id", "root_goal_id", "request_id")
HOTEL_QUERY = "price, room, cancellation, address, rating"


def hotel_markdown(html, url):
    """Local pruning + query selection; never fall back to the original page."""
    soup = BeautifulSoup(html, "lxml")
    for node in soup.select("nav, header, footer, aside, script, style, form, [role='navigation'], [role='banner'], [role='contentinfo']"):
        node.decompose()
    blocks = PruningContentFilterLXML(threshold=0.3, threshold_type="dynamic").filter_content(str(soup))
    pruned = "<html><body>" + "\n".join(blocks) + "</body></html>"
    # crawl4ai 0.9.5 whitespace-tokenizes BM25 queries: commas otherwise become
    # part of the tokens. Preserve the configured query, normalize its separators.
    selected = BM25ContentFilter(user_query=HOTEL_QUERY.replace(",", " "), bm25_threshold=0.1).filter_content(pruned)
    strategy = "pruning_bm25" if selected else "pruning"
    if selected:
        context = BeautifulSoup(pruned, "lxml")
        # Keep short headings/addresses and the preceding label/value block.
        # Numeric prices and unlabeled addresses may not match the query itself.
        anchors = context.select("h1, address, [itemprop='address']")
        for fragment in selected:
            part = BeautifulSoup(fragment, "lxml").body.find()
            if part:
                match = context.find(lambda tag: tag.name == part.name and tag.get_text(" ", strip=True) == part.get_text(" ", strip=True))
                if match:
                    previous = match.find_previous_sibling()
                    if previous:
                        anchors.append(previous)
        selected.extend(str(tag) for tag in anchors if len(tag.get_text(" ", strip=True)) <= 512)
        filtered = "\n".join(dict.fromkeys(selected))
    else:
        # BM25 has weak/zero scores on tiny pages. Pruned content remains usable;
        # an empty prune remains empty, never silently resurrects boilerplate.
        filtered = pruned
    markdown = bounded(DefaultMarkdownGenerator(options={"ignore_images": True}).generate_markdown(
        input_html=filtered, base_url=url, citations=False).raw_markdown, MARKDOWN_LIMIT)
    if markdown.startswith(("Error converting HTML to markdown:", "Error in markdown generation:")):
        raise ValueError("filtered markdown generation failed")
    return markdown, {"strategy": strategy, "query": HOTEL_QUERY,
                      "html_bytes": len(html.encode()), "markdown_bytes": len(markdown.encode())}


def https_url(value):
    if not isinstance(value, str) or any(c.isspace() for c in value) or "\\" in value:
        raise ValueError("invalid HTTPS URL")
    p = urlsplit(value)
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.fragment:
        raise ValueError("exact HTTPS URL required (no credentials or fragment)")
    _ = p.port
    return value


def origin(value):
    p = urlsplit(https_url(value))
    return f"https://{p.hostname.lower()}" + (f":{p.port}" if p.port not in (None, 443) else "")


def cdp_url(value):
    p = urlsplit(value)
    try:
        loopback = p.hostname == "localhost" or ipaddress.ip_address(p.hostname).is_loopback
    except ValueError:
        loopback = False
    if not loopback or p.scheme not in ("http", "https", "ws", "wss") or p.username or p.password or p.fragment:
        raise ValueError("CDP must be a private loopback endpoint")
    return value


def bounded(value, limit):
    if len(value.encode() if isinstance(value, str) else value) > limit:
        raise ValueError("size limit exceeded")
    return value


class Engine:
    def __init__(self, scope, endpoint):
        self.scope = scope
        self.endpoint = cdp_url(endpoint)
        if set(scope) != set(BINDING) | {"approved_urls", "read_only_urls", "egress_origins"}:
            raise ValueError("scope fields mismatch")
        if any(not isinstance(scope[k], str) or not scope[k] for k in BINDING[:3]) or type(scope["generation"]) is not int or scope["generation"] < 1:
            raise ValueError("invalid binding types")
        for key in ("approved_urls", "read_only_urls", "egress_origins"):
            if not isinstance(scope[key], list) or (key != "read_only_urls" and not scope[key]):
                raise ValueError("nonempty scope lists required")
            for url in scope[key]:
                https_url(url)
        if not set(scope["read_only_urls"]) <= set(scope["approved_urls"]):
            raise ValueError("read-only URLs must be approved")
        self.origins = {origin(url) for url in scope["egress_origins"]}
        if any(url != origin(url) for url in scope["egress_origins"]):
            raise ValueError("egress_origins must be canonical HTTPS origins")
        if any(origin(url) not in self.origins for url in scope["approved_urls"]):
            raise ValueError("approved URL outside egress origins")
        self.page = self.context = self.pw = None
        self.records = {}
        self.cached_bytes = 0
        self.active = None
        self.ready = False
        self.tab_id = "engine"

    async def start(self):
        if os.environ.get("BURROW_BROWSER_EGRESS_ENFORCED") != "1":
            raise ValueError("operator-enforced egress required")
        self.pw = await async_playwright().start()
        # Never enter a Browser context manager: it would close the shared browser.
        browser = await self.pw.chromium.connect_over_cdp(self.endpoint, timeout=10000)
        if not browser.contexts:
            raise ValueError("existing Chrome context required")
        self.context = browser.contexts[0]
        if self.context.service_workers:
            raise ValueError("existing service workers unsupported; use a dedicated profile")
        await self.context.route("**/*", self.route)
        await self.context.route_web_socket("**/*", self.websocket)
        self.page = await self.context.new_page()
        self.page.set_default_timeout(10000)
        self.ready = True

    async def route(self, route):
        request = route.request
        try:
            allowed = origin(request.url) in self.origins and request.method in ("GET", "HEAD")
            if request.is_navigation_request():
                allowed = allowed and request.url in self.scope["approved_urls"]
            if allowed:
                # Do not let continue_ silently follow redirects outside routing.
                response = await route.fetch(max_redirects=0, max_retries=0, timeout=10000)
                try:
                    if 300 <= response.status < 400:
                        destination = urljoin(request.url, response.headers.get("location", ""))
                        self.check_url(destination)
                        # Conservative: reject even approved redirects. The host may
                        # explicitly navigate to the approved destination instead.
                        await route.abort("blockedbyclient")
                        return
                    payload = bounded(await response.body(), HTML_LIMIT)
                    await route.fulfill(response=response, body=payload)
                finally:
                    await response.dispose()
                return
        except Exception:
            pass
        await route.abort("blockedbyclient")

    async def websocket(self, socket):
        # WebSockets use ws/wss, not HTTPS: unsupported and always denied.
        await socket.close(code=1008, reason="WebSockets disabled")

    async def stop(self):
        self.ready = False
        if self.active:
            self.active.cancel()
            await asyncio.gather(self.active, return_exceptions=True)
        if self.page:
            await self.page.close()
        if self.context:
            await self.context.unroute("**/*", self.route)
        if self.pw:
            await self.pw.stop()  # disconnect transport only; never browser.close()

    def validate(self, body):
        if set(body) != {"allocation", "identity", "action"}:
            raise ValueError("invalid envelope")
        allocation, identity, action = body["allocation"], body["identity"], body["action"]
        if json.dumps(allocation, sort_keys=True) != json.dumps({k: self.scope[k] for k in BINDING}, sort_keys=True):
            raise ValueError("allocation mismatch")
        if set(identity) != set(IDENTITY) or any(not isinstance(v, str) or not re.fullmatch(r"[a-zA-Z0-9:_-]{1,160}", v) for v in identity.values()):
            raise ValueError("invalid identity")
        if any(identity[k] != self.scope[k] for k in ("account", "workspace_id")):
            raise ValueError("identity scope mismatch")
        if set(action) != {"operation", "args", "replay_class"} or action["replay_class"] not in ("read_only", "non_idempotent_effect"):
            raise ValueError("invalid action")
        op, args = action["operation"], action["args"]
        if not isinstance(args, dict):
            raise ValueError("args must be an object")
        allowed = {"browser.navigate": {"url", "tab_id"}, "browser.read": {"tab_id"}, "browser.tabs": set(), "screenshot": {"surface", "target"}}
        if op not in allowed or set(args) - allowed[op]:
            raise ValueError("unsupported operation or args")
        if "tab_id" in args and args["tab_id"] != self.tab_id:
            raise ValueError("not an engine-owned tab")
        if op == "browser.navigate":
            self.check_url(args.get("url"))
            if action["replay_class"] == "read_only" and args["url"] not in self.scope["read_only_urls"]:
                raise ValueError("navigation lacks an explicit known-safe grant")
        elif action["replay_class"] != "read_only":
            raise ValueError("observation must be read_only")
        if op == "screenshot" and (args.get("surface") != "browser" or args.get("target", self.tab_id) != self.tab_id):
            raise ValueError("invalid screenshot target")
        return tuple(identity[k] for k in IDENTITY)

    def check_url(self, url):
        https_url(url)
        if url not in self.scope["approved_urls"]:
            raise ValueError("URL not approved for research access")

    async def execute(self, body):
        key = self.validate(body)
        terms = json.dumps(body, sort_keys=True, separators=(",", ":"))
        if key in self.records:
            record = self.records[key]
            if terms != record["terms"]:
                raise ValueError("identity terms mismatch")
            if record["state"] != "completed":
                raise ValueError("unresolved or interrupted identity; never redispatched")
            return record["output"]
        if not self.ready or self.active:
            raise ValueError("engine unavailable or busy")
        if len(self.records) >= 1024 or self.cached_bytes >= 32 * 1024 * 1024:
            raise ValueError("identity capacity reached; restart with new generation")
        record = self.records[key] = {"terms": terms, "state": "in_flight", "done": asyncio.Event()}
        task = asyncio.create_task(self.perform(body))
        self.active = task
        try:
            output = await asyncio.wait_for(task, TIMEOUT)
            encoded = bounded(json.dumps(output), JSON_LIMIT)
            self.cached_bytes += len(encoded.encode())
            record.update(state="completed", output=output)
            return output
        except BaseException:
            record["state"] = "not_completed"
            # Cancelled Playwright awaits do not necessarily stop Chrome loading.
            # Close only our tab and fail readiness until the service is replaced.
            self.ready = False
            if self.page:
                try:
                    await asyncio.wait_for(self.page.close(), 5)
                except Exception:
                    pass
            raise
        finally:
            self.active = None
            record["done"].set()

    async def cancel(self, body):
        if set(body) != {"allocation", "identity"}:
            raise ValueError("invalid cancellation envelope")
        key = self.validate({**body, "action": {"operation": "browser.tabs", "args": {}, "replay_class": "read_only"}})
        record = self.records.get(key)
        if not record:
            raise ValueError("unknown identity")
        if record["state"] == "in_flight" and self.active:
            task = self.active
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await record["done"].wait()
            if record["state"] != "completed":
                record["state"] = "not_completed"
        return {"completed": record["state"] == "completed", "state": record["state"], "rollback": False}

    async def perform(self, body):
        op, args = body["action"]["operation"], body["action"]["args"]
        if op == "browser.tabs":
            return {"tabs": [{"tab_id": self.tab_id}], "artifacts": [], "advisory": True}
        if op == "browser.navigate":
            response = await self.page.goto(args["url"], wait_until="domcontentloaded", timeout=15000)
            if response is not None and response.status >= 400:
                return {"failure": {"code": "http_status", "status": response.status}, "artifacts": [], "advisory": True}
        url = self.page.url
        self.check_url(url)
        fetched_at = datetime.now(timezone.utc).isoformat()

        def artifact(kind, media_type, value, binary=False):
            raw = value if binary else value.encode()
            return {"kind": kind, "media_type": media_type,
                    ("base64" if binary else "content"): base64.b64encode(raw).decode() if binary else value,
                    "source_url": url, "fetched_at": fetched_at, "identity": dict(body["identity"]),
                    "sha256": hashlib.sha256(raw).hexdigest()}

        if op == "screenshot":
            png = bounded(await self.page.screenshot(type="png", full_page=False, timeout=10000), PNG_LIMIT)
            self.check_url(self.page.url)
            if self.page.url != url:
                raise ValueError("page changed during screenshot")
            return {"url": url, "source_url": url, "fetched_at": fetched_at,
                    "artifacts": [artifact("screenshot", "image/png", png, True)], "advisory": True}
        html = bounded(await self.page.content(), HTML_LIMIT)
        title = bounded(await self.page.title(), 4096)
        if self.page.url != url:
            raise ValueError("page changed during capture")
        # Pure local processors; never instantiate AsyncWebCrawler or LLM strategies.
        markdown, filtering = hotel_markdown(html, url)
        hotel, extraction = extract_hotel(url, html, fetched_at)
        if extraction["path"] == "llm_required":
            domain = urlsplit(url).hostname.lower()
            extraction["fallback_domain"] = domain
            # Private per-allocation logs; never log URLs/queries, HTML or tokens.
            print(json.dumps({"event": "hotel_schema_fallback", "domain": domain,
                              **body["identity"]}), file=sys.stderr, flush=True)
        hotel_json = bounded(json.dumps(hotel, ensure_ascii=False), MARKDOWN_LIMIT)
        return {"url": url, "source_url": url, "fetched_at": fetched_at, "title": title,
                "markdown": markdown, "filtering": filtering, "hotel": hotel, "extraction": extraction, "tab_id": self.tab_id,
                "artifacts": [artifact("markdown", "text/markdown", markdown), artifact("json", "application/json", hotel_json)],
                "advisory": True}


def create_app(engine, token):
    @web.middleware
    async def auth(request, handler):
        if not hmac.compare_digest(request.headers.get("Authorization", "").encode(), ("Bearer " + token).encode()):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            return await handler(request)
        except asyncio.CancelledError:
            return web.json_response({"error": "interrupted; completion uncertain; no rollback"}, status=409)
        except (ValueError, TypeError, KeyError):
            return web.json_response({"error": "invalid, unresolved, or out-of-policy request"}, status=400)
        except Exception:
            return web.json_response({"error": "operation failed; completion uncertain; no rollback"}, status=503)

    app = web.Application(middlewares=[auth], client_max_size=REQUEST_LIMIT)

    async def status(request):
        connected = engine.ready and engine.page is not None and not engine.page.is_closed() and engine.context is not None and engine.context.browser.is_connected()
        return web.json_response({"state": "ready" if connected else "unavailable",
                                  "crawl4ai_version": version("crawl4ai"),
                                  "binding": {k: engine.scope[k] for k in BINDING},
                                  "busy": engine.active is not None})

    async def execute(request):
        return web.json_response(await engine.execute(await request.json()))

    async def cancel(request):
        return web.json_response(await engine.cancel(await request.json()))

    app.router.add_get("/status", status)
    app.router.add_get("/health", status)
    app.router.add_post("/execute", execute)
    app.router.add_post("/cancel", cancel)

    async def startup(app):
        try:
            await engine.start()
        except Exception:
            await engine.stop()
            raise

    async def cleanup(app):
        await engine.stop()

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    return app


if __name__ == "__main__":
    token_file = Path(os.environ["BURROW_BROWSER_TOKEN_FILE"])
    if token_file.stat().st_mode & 0o077:
        raise ValueError("token file must be private (0600)")
    token = token_file.read_text().strip()
    if len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
        raise ValueError("token must contain at least 32 ASCII non-whitespace characters")
    scope = json.loads(Path(os.environ["BURROW_BROWSER_SCOPE_FILE"]).read_text())
    engine = Engine(scope, os.environ["BURROW_BROWSER_CDP_URL"])
    web.run_app(create_app(engine, token), host="127.0.0.1", port=int(os.environ.get("BURROW_BROWSER_PORT", "8765")), access_log=None)

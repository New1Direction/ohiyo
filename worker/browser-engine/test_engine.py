import asyncio
import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from aiohttp.test_utils import TestClient, TestServer
from service import Engine, create_app, bounded, cdp_url, hotel_markdown, HOTEL_QUERY, HTML_LIMIT
from control import BrowserControl, PrivateControl
from proxy import tunnel
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

URL = "https://hotels.example/shibuya"
SCOPE = dict(account="a", workspace_id="w", computer_id="c", generation=1,
             approved_urls=[URL], read_only_urls=[URL], egress_origins=["https://hotels.example"])


def request(op="browser.navigate", args=None):
    return {"allocation": {k: SCOPE[k] for k in ("account", "workspace_id", "computer_id", "generation")},
            "identity": dict(account="a", workspace_id="w", task_id="t", root_goal_id="g", request_id="r"),
            "action": dict(operation=op, args=args if args is not None else {"url": URL}, replay_class="read_only")}


def engine(fixture="css"):
    e = Engine(copy.deepcopy(SCOPE), "http://127.0.0.1:9222")
    e.ready = True
    e.context = SimpleNamespace(browser=SimpleNamespace(is_connected=lambda: True))
    e.page = SimpleNamespace(url=URL, is_closed=lambda: False, goto=AsyncMock(return_value=None), title=AsyncMock(return_value="Fictional hotel"),
                             content=AsyncMock(return_value=Path(f"fixtures/{fixture}.html").read_text()),
                             screenshot=AsyncMock(return_value=b"\x89PNG\r\n\x1a\n"), close=AsyncMock())
    return e


class Operations(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_injects_private_credentials_without_forwarding_headers_or_denial_bodies(self):
        seen = []
        async def gateway(reader, writer):
            header = await reader.readuntil(b"\r\n\r\n")
            seen.append(header)
            if b"denied.example" in header:
                writer.write(b"HTTP/1.1 403 Forbidden\r\n\r\nsecret-denial-body")
            else:
                writer.write(b"HTTP/1.1 200 OK\r\n\r\n")
                await writer.drain()
                writer.write(await reader.readexactly(4))
            await writer.drain()
            writer.close()
        with tempfile.TemporaryDirectory() as directory:
            credentials = Path(directory) / "egress.json"
            upstream = await asyncio.start_server(gateway, "127.0.0.1", 0)
            credentials.write_text(json.dumps({"HTTPS_PROXY": f"http://orb:runtime-secret@127.0.0.1:{upstream.sockets[0].getsockname()[1]}"}))
            adapter = await asyncio.start_server(lambda r, w: tunnel(r, w, credentials), "127.0.0.1", 0, limit=16384)
            async def connect(line, payload=b""):
                reader, writer = await asyncio.open_connection("127.0.0.1", adapter.sockets[0].getsockname()[1])
                writer.write(line + b"\r\nProxy-Authorization: hostile\r\n\r\n" + payload)
                await writer.drain()
                result = await asyncio.wait_for(reader.read(), 2)
                writer.close(); await writer.wait_closed()
                return result
            try:
                reply = await connect(b"CONNECT allowed.example:443 HTTP/1.1", b"ping")
                self.assertTrue(reply.endswith(b"ping"))
                self.assertIn(b"200", reply)
                self.assertIn(b"Proxy-Authorization: Basic ", seen[0])
                self.assertNotIn(b"hostile", seen[0])
                for line in (b"CONNECT denied.example:443 HTTP/1.1", b"CONNECT allowed.example:80 HTTP/1.1", b"GET http://allowed.example/ HTTP/1.1"):
                    reply = await connect(line)
                    self.assertIn(b"502", reply)
                    self.assertNotIn(b"secret", reply)
                self.assertEqual(len(seen), 2)
                credentials.unlink()
                self.assertIn(b"502", await connect(b"CONNECT allowed.example:443 HTTP/1.1"))
                self.assertEqual(len(seen), 2)
            finally:
                adapter.close(); upstream.close()
                await adapter.wait_closed(); await upstream.wait_closed()

    async def test_private_takeover_suppresses_reads_and_replays_across_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "control.sqlite")
            e = engine()
            e.control = BrowserControl(e, path)
            e.page.keyboard = SimpleNamespace(insert_text=AsyncMock(), press=AsyncMock())
            base = request()
            def command(action, request_id="session-one", session="session-one", **extra):
                return {"allocation": base["allocation"], "identity": {**base["identity"], "request_id": request_id},
                        "command": {"action": action, "session_id": session, **extra}}
            self.assertEqual((await e.control.call(command("status", session=None)))["phase"], "agent")
            await e.execute(base)
            self.assertEqual((await e.control.call(command("take_over")))["phase"], "human")
            self.assertEqual((await e.control.call(command("status")))["phase"], "human")
            for op, args in (("browser.read", {}), ("screenshot", {"surface": "browser"}), ("browser.tabs", {})):
                with self.assertRaises(PrivateControl):
                    await e.execute(request(op, args))
            with self.assertRaises(PrivateControl):
                await e.execute(base)  # cached observations are fenced too
            typing = command("input", "type-one", input={"kind": "text", "text": "private-password-never-recorded"})
            await e.control.call(typing)
            with self.assertRaises(ValueError):
                await e.control.call(typing)
            self.assertIn("png", await e.control.call(command("frame")))
            foreign = command("frame"); foreign["identity"]["task_id"] = "other"
            with self.assertRaises(ValueError):
                await e.control.call(foreign)
            e.control.db.close()
            e.control = BrowserControl(e, path)
            with self.assertRaises(PrivateControl):
                await e.execute(request("browser.read", {}))
            with self.assertRaises(ValueError):
                await e.control.call(typing)
            self.assertEqual((await e.control.call(command("give_back")))["phase"], "agent")
            self.assertEqual((await e.control.call(command("give_back")))["phase"], "agent")
            self.assertEqual((await e.control.call(command("status")))["phase"], "agent")
            with self.assertRaises(ValueError):
                await e.control.call(command("frame"))
            with self.assertRaises(ValueError):
                await e.control.call(command("take_over"))
            await e.control.call(command("take_over", "session-two", "session-two"))
            await e.control.call(command("give_back", "return-two", "session-two"))
            e.control.db.close(); e.control = BrowserControl(e, path)
            with self.assertRaises(ValueError):
                await e.control.call(command("take_over"))  # older than the most recent session
            self.assertIn("markdown", await e.execute({**base, "identity": {**base["identity"], "request_id": "new-observation"}}))
            e.control.db.close()
            self.assertNotIn(b"private-password-never-recorded", Path(path).read_bytes())

    async def test_private_tab_reattaches_then_recovers_blank_without_replaying_navigation(self):
        e = engine(); e.control = BrowserControl(e, ":memory:")
        existing, fresh = object(), object()
        e.context.pages = [existing]
        e.context.new_page = AsyncMock(return_value=fresh)
        async def session(page):
            return SimpleNamespace(send=AsyncMock(return_value={"targetInfo": {"targetId": "saved" if page is existing else "fresh"}}), detach=AsyncMock())
        e.context.new_cdp_session = session
        e.control.db.execute("INSERT INTO target VALUES('saved')")
        e.control.db.execute("INSERT INTO control VALUES(1,'session','owner','human')")
        self.assertIs(await e.control.attach_page(), existing)
        e.context.new_page.assert_not_awaited()
        e.context.pages = []
        self.assertIs(await e.control.attach_page(), fresh)
        self.assertTrue(e.control.private())
        e.page.goto.assert_not_awaited()
        e.control.db.close()

    async def test_takeover_drains_inflight_read_without_releasing_result_or_closing_tab(self):
        e = engine(); e.control = BrowserControl(e, ":memory:")
        entered, finish = asyncio.Event(), asyncio.Event()
        original = e.perform
        async def held(body):
            entered.set(); await finish.wait(); return await original(body)
        e.perform = held
        reading = asyncio.create_task(e.execute(request()))
        await entered.wait()
        takeover = asyncio.create_task(e.control.call({"allocation": request()["allocation"], "identity": request()["identity"],
                                                       "command": {"action": "take_over", "session_id": "takeover"}}))
        await asyncio.sleep(0)
        finish.set()
        with self.assertRaises(PrivateControl):
            await reading
        self.assertEqual((await takeover)["phase"], "human")
        e.page.close.assert_not_awaited()
        e.control.db.close()

    async def test_filtered_markdown_keeps_facts_not_boilerplate(self):
        e = engine("unknown")
        hotel = e.page.content.return_value
        noise = "<nav>" + "<a href='/menu'>Menu newsletter rewards account</a>" * 100 + "</nav>"
        noise += "<footer>" + "Footer copyright tracking preferences " * 100 + "</footer>"
        html = hotel.replace("<main>", noise + "<main>")
        e.page.content.return_value = html
        output = await e.execute(request())
        text = output["markdown"]
        for fact in ("Shibuya Cloud", "3 Invented Square", "16,000", "Twin rooms", "Cancellation"):
            self.assertIn(fact, text)
        for noise in ("Menu newsletter", "Footer copyright"):
            self.assertNotIn(noise, text)
        raw = DefaultMarkdownGenerator().generate_markdown(input_html=html, base_url=URL, citations=False).raw_markdown
        self.assertLess(len(text.encode()), len(raw.encode()) // 5)
        self.assertEqual(output["filtering"]["query"], HOTEL_QUERY)
        self.assertEqual(output["artifacts"][0]["content"], text)
        tiny, metadata = hotel_markdown("<body><p>3 Short Lane, Tokyo</p></body>", URL)
        self.assertIn("3 Short Lane", tiny)
        self.assertEqual(metadata["strategy"], "pruning")
        empty, _ = hotel_markdown("<body><nav>Menu only</nav></body>", URL)
        self.assertEqual(empty.strip(), "")

    async def test_standard_microdata_layouts_and_ambiguous_rates(self):
        for kind in ("Hotel", "LodgingBusiness"):
            html = f'''<main itemscope itemtype="https://schema.org/{kind}">
              <h1 itemprop="name">Example {kind}</h1><address itemprop="address">17 Example Road, Tokyo</address>
              <meta itemprop="priceCurrency" content="JPY"><meta itemprop="price" content="18340">
              <span itemprop="ratingValue">8.6</span><meta itemprop="latitude" content="35.65">
              <meta itemprop="longitude" content="139.72"></main>'''
            e = engine(); e.page.content.return_value = html
            output = await e.execute(request())
            self.assertEqual(output["extraction"], {"path": "css", "schema_id": f"schema-org-{kind.lower()}-v1"})
            self.assertEqual(output["hotel"]["name"], f"Example {kind}")
            self.assertEqual(output["hotel"]["address"], "17 Example Road, Tokyo")
            self.assertEqual(output["hotel"]["displayed_price"], "18340")
            self.assertEqual(output["hotel"]["currency"], "JPY")
            self.assertEqual(output["hotel"]["rating"], 8.6)
            self.assertEqual(output["hotel"]["coords"], {"lat": 35.65, "lng": 139.72})
            e = engine(); e.page.content.return_value = html.replace("</main>", '<meta itemprop="price" content="24000"></main>')
            self.assertIsNone((await e.execute(request()))["hotel"]["displayed_price"])
            e = engine(); e.page.content.return_value = html + html
            self.assertEqual((await e.execute(request()))["extraction"]["path"], "llm_required")

    async def test_fallback_domain_log_is_scoped_without_page_contents(self):
        e = engine("unknown")
        log = io.StringIO()
        with redirect_stderr(log):
            output = await e.execute(request())
            await e.execute(request())  # committed duplicate must not count twice
        self.assertEqual(output["extraction"]["fallback_domain"], "hotels.example")
        entries = [json.loads(line) for line in log.getvalue().splitlines()]
        self.assertEqual(entries, [{"event": "hotel_schema_fallback", "domain": "hotels.example", **request()["identity"]}])

    async def test_real_processors_three_fixtures(self):
        for fixture, path in (("css", "css"), ("xpath", "xpath"), ("unknown", "llm_required")):
            with self.subTest(fixture=fixture):
                output = await engine(fixture).execute(request())
                self.assertEqual(output["extraction"]["path"], path)
                self.assertIn("Shibuya", output["markdown"])
                self.assertEqual(output["hotel"]["source_url"], URL)
                self.assertTrue(output["hotel"]["advisory"])
                if path != "llm_required":
                    self.assertIn("Shibuya", output["hotel"]["name"])
                    self.assertEqual(output["hotel"]["currency"], "JPY")
                    self.assertEqual(output["hotel"]["displayed_price"], "18,500 per night" if fixture == "css" else "22,000 per night")
                    self.assertEqual(output["hotel"]["rating"], 8.7 if fixture == "css" else 9.1)
                    self.assertEqual(output["hotel"]["address"], "1 Fiction Lane, Shibuya, Tokyo" if fixture == "css" else "2 Imaginary Walk, Shibuya, Tokyo")
                else:
                    self.assertIsNone(output["hotel"]["name"])
                self.assertEqual(output["artifacts"][0]["identity"], request()["identity"])

    async def test_duplicate_returns_cached_without_navigation(self):
        e = engine()
        first = await e.execute(request())
        self.assertEqual(first, await e.execute(request()))
        e.page.goto.assert_awaited_once()
        changed = request("browser.read", {})
        with self.assertRaises(ValueError):
            await e.execute(changed)

    async def test_navigation_replay_grants_and_acknowledged_failure(self):
        e = engine()
        e.scope["read_only_urls"] = []
        with self.assertRaises(ValueError):
            await e.execute(request())
        e.page.goto.assert_not_awaited()
        effect = request()
        effect["action"]["replay_class"] = "non_idempotent_effect"
        e.page.goto.return_value = SimpleNamespace(status=404)
        output = await e.execute(effect)
        self.assertEqual(output["failure"], {"code": "http_status", "status": 404})
        self.assertTrue(e.ready)
        self.assertEqual(output["artifacts"], [])

    async def test_read_and_screenshot_do_not_navigate(self):
        for op, args in (("browser.read", {}), ("screenshot", {"surface": "browser"})):
            e = engine()
            output = await e.execute(request(op, args))
            e.page.goto.assert_not_awaited()
            self.assertEqual(output["source_url"], URL)

    async def test_out_of_policy_before_navigation(self):
        for url in ("http://hotels.example/shibuya", "https://evil.example/", URL + "?x=1", "file:///etc/passwd", "javascript:alert(1)"):
            e = engine()
            with self.assertRaises(ValueError):
                await e.execute(request(args={"url": url}))
            e.page.goto.assert_not_awaited()

    async def test_scope_and_unsupported_actions(self):
        for mutate in (lambda b: b["identity"].update(account="other"),
                       lambda b: b["allocation"].update(generation=2),
                       lambda b: b["action"].update(operation="browser.click"),
                       lambda b: b["action"]["args"].update(cdp_url="http://localhost:1"),
                       lambda b: b["action"]["args"].update(tab_id="shared")):
            b = request()
            mutate(b)
            with self.assertRaises(ValueError):
                await engine().execute(b)

    async def test_failure_never_redispatched(self):
        e = engine()
        e.page.goto.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            await e.execute(request())
        with self.assertRaises(ValueError):
            await e.execute(request())
        e.page.goto.assert_awaited_once()

    async def test_operation_timeout_closes_only_owned_tab(self):
        e = engine()

        async def waiting(*args, **kwargs):
            await asyncio.Event().wait()

        e.page.goto.side_effect = waiting
        with patch("service.TIMEOUT", 0.01):
            with self.assertRaises(TimeoutError):
                await e.execute(request())
        self.assertFalse(e.ready)
        e.page.close.assert_awaited_once()
        with self.assertRaises(ValueError):
            await e.execute(request())

    async def test_tabs_does_not_expose_shared_context(self):
        e = engine()
        self.assertEqual((await e.execute(request("browser.tabs", {})))["tabs"], [{"tab_id": "engine"}])
        e.page.goto.assert_not_awaited()
        e.page.content.assert_not_awaited()

    async def test_exact_identity_cancel_and_unresolved(self):
        e = engine()
        entered = asyncio.Event()

        async def waiting(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        e.page.goto.side_effect = waiting
        task = asyncio.create_task(e.execute(request()))
        await entered.wait()
        with self.assertRaises(ValueError):
            await e.execute(request())
        cancel = {k: v for k, v in request().items() if k != "action"}
        wrong = copy.deepcopy(cancel)
        wrong["identity"]["request_id"] = "other"
        with self.assertRaises(ValueError):
            await e.cancel(wrong)
        result = await e.cancel(cancel)
        self.assertFalse(result["completed"])
        self.assertFalse(result["rollback"])
        with self.assertRaises(asyncio.CancelledError):
            await task
        with self.assertRaises(ValueError):
            await e.execute(request())
        e.page.goto.assert_awaited_once()

    async def test_cancel_completed(self):
        e = engine()
        await e.execute(request())
        self.assertTrue((await e.cancel({k: v for k, v in request().items() if k != "action"}))["completed"])

    async def test_size_limit(self):
        e = engine()
        e.page.content.return_value = "x" * (HTML_LIMIT + 1)
        with self.assertRaises(ValueError):
            await e.execute(request("browser.read", {}))
        with self.assertRaises(ValueError):
            bounded(b"abcd", 3)

    async def test_routing_policy(self):
        e = engine()
        for url, method, navigation, allowed in ((URL, "GET", True, True),
                ("https://hotels.example/style.css", "GET", False, True),
                ("https://hotels.example/other", "GET", True, False),
                (URL, "POST", False, False), ("https://evil.example/x", "GET", False, False),
                ("data:text/plain,hi", "GET", False, False), ("wss://hotels.example/x", "GET", False, False)):
            route = SimpleNamespace(request=SimpleNamespace(url=url, method=method, is_navigation_request=lambda: navigation),
                                    abort=AsyncMock(), fulfill=AsyncMock(), fetch=AsyncMock())
            route.fetch.return_value = SimpleNamespace(status=200, headers={}, body=AsyncMock(return_value=b"ok"), dispose=AsyncMock())
            await e.route(route)
            self.assertEqual(route.fulfill.await_count, int(allowed))
            self.assertEqual(route.abort.await_count, int(not allowed))
        socket = SimpleNamespace(close=AsyncMock())
        await e.websocket(socket)
        socket.close.assert_awaited_once()

    async def test_redirect_never_followed(self):
        e = engine()
        route = SimpleNamespace(request=SimpleNamespace(url=URL, method="GET", is_navigation_request=lambda: True),
                                abort=AsyncMock(), fulfill=AsyncMock(), fetch=AsyncMock())
        route.fetch.return_value = SimpleNamespace(status=302, headers={"location": "https://evil.example/"}, dispose=AsyncMock())
        await e.route(route)
        route.abort.assert_awaited_once()
        route.fetch.assert_awaited_once_with(max_redirects=0, max_retries=0, timeout=10000)

    async def test_private_human_login_uses_native_navigation_only_on_allowed_origins(self):
        e = engine(); e.control = BrowserControl(e, ":memory:")
        e.control.db.execute("INSERT INTO control VALUES(1,'session','owner','human')")
        for url, allowed in (("https://hotels.example/login", True), ("https://evil.example/login", False), ("http://hotels.example/login", False)):
            route = SimpleNamespace(request=SimpleNamespace(url=url, method="POST", is_navigation_request=lambda: True),
                                    abort=AsyncMock(), continue_=AsyncMock(), fetch=AsyncMock())
            await e.route(route)
            self.assertEqual(route.continue_.await_count, int(allowed))
            self.assertEqual(route.abort.await_count, int(not allowed))
            route.fetch.assert_not_awaited()
        e.control.db.close()

    async def test_mocked_cdp_attach_only(self):
        e = engine()
        context = SimpleNamespace(service_workers=[], route=AsyncMock(), route_web_socket=AsyncMock(),
                                  new_page=AsyncMock(return_value=MagicMock()), unroute=AsyncMock())
        browser = SimpleNamespace(contexts=[context], close=AsyncMock())
        pw = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)), stop=AsyncMock())
        manager = SimpleNamespace(start=AsyncMock(return_value=pw))
        with patch("service.async_playwright", return_value=manager), patch.dict(os.environ, BURROW_BROWSER_EGRESS_ENFORCED="1"):
            await e.start()
        context.new_page.assert_awaited_once()
        e.page.close = AsyncMock()
        await e.stop()
        browser.close.assert_not_awaited()
        pw.stop.assert_awaited_once()

    async def test_no_context_fails(self):
        e = engine()
        manager = SimpleNamespace(start=AsyncMock(return_value=SimpleNamespace(chromium=SimpleNamespace(
            connect_over_cdp=AsyncMock(return_value=SimpleNamespace(contexts=[]))))))
        with patch("service.async_playwright", return_value=manager), patch.dict(os.environ, BURROW_BROWSER_EGRESS_ENFORCED="1"):
            with self.assertRaises(ValueError):
                await e.start()

    async def test_egress_readiness_gate(self):
        with patch.dict(os.environ, BURROW_BROWSER_EGRESS_ENFORCED="0"):
            with self.assertRaises(ValueError):
                await engine().start()

    async def test_cdp_nonloopback_rejected(self):
        for url in ("http://10.0.0.1:9222", "https://example.com", "file:///tmp/socket"):
            with self.assertRaises(ValueError):
                cdp_url(url)

    async def test_auth_all_routes_and_request_cap(self):
        e = engine()
        e.start = AsyncMock()
        e.stop = AsyncMock()
        client = TestClient(TestServer(create_app(e, "secret")))
        await client.start_server()
        try:
            for path in ("/health", "/status", "/execute", "/cancel", "/missing"):
                response = await client.get(path)
                self.assertEqual(response.status, 401)
            headers = {"Authorization": "Bearer secret"}
            status = await client.get("/status", headers=headers)
            self.assertEqual(status.status, 200)
            descriptor = await status.json()
            self.assertEqual(descriptor["state"], "ready")
            self.assertEqual(descriptor["crawl4ai_version"], "0.9.5")
            self.assertEqual(descriptor["binding"], request()["allocation"])
            response = await client.post("/execute", json=request(), headers=headers)
            self.assertEqual(response.status, 200)
            response = await client.post("/execute", data="x" * 70000, headers=headers)
            self.assertNotEqual(response.status, 200)
            e.context.browser.is_connected = lambda: False
            self.assertEqual((await (await client.get("/status", headers=headers)).json())["state"], "unavailable")
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()

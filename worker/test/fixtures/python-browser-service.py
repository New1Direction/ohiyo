"""Demo-only RPC transport: real Engine/processors, saved HTML, mocked Chrome.
No network, browser process or model. Not an ImOrb transport implementation.
"""
import asyncio
import base64
import json
import sys
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "browser-engine"
sys.path.insert(0, str(ROOT))
from service import Engine, BINDING

URLS = ["https://hotels.example/" + name for name in ("css", "xpath", "unknown")]
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQAAAABJRU5ErkJggg==")


class Page:
    url = URLS[0]

    async def goto(self, url, **kwargs):
        if url not in URLS:
            raise ValueError("not a fixture URL")
        self.url = url

    async def content(self):
        return (ROOT / "fixtures" / (self.url.split("/")[-1] + ".html")).read_text()

    async def title(self):
        return "Fictional Shibuya fixture"

    async def screenshot(self, **kwargs):
        return PNG

    async def close(self):
        pass


async def main():
    engine = None
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = json.loads(line)
        try:
            body = request["body"]
            if engine is None:
                scope = {k: body["allocation"][k] for k in BINDING}
                engine = Engine({**scope, "approved_urls": URLS, "read_only_urls": URLS,
                                 "egress_origins": ["https://hotels.example"]}, "http://127.0.0.1:9222")
                engine.page, engine.ready = Page(), True
            if request["endpoint"] == "/status":
                output = {"state": "ready" if engine.ready else "unavailable", "crawl4ai_version": version("crawl4ai"),
                          "binding": {k: engine.scope[k] for k in BINDING}}
            elif request["endpoint"] == "/execute":
                output = await engine.execute(body)
            elif request["endpoint"] == "/cancel":
                output = await engine.cancel(body)
            else:
                raise ValueError("unsupported fixture endpoint")
            reply = {"id": request["id"], "ok": True, "data": output}
        except Exception as error:
            reply = {"id": request["id"], "ok": False, "data": {"error": type(error).__name__}}
        print("BURROW_FIXTURE " + json.dumps(reply), flush=True)


asyncio.run(main())

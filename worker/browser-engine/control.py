"""Private human control, never a model tool or an evidence producer.

The authenticated host relays each request; session IDs are not credentials.
Durable fencing survives service restart. Closing a client never gives control
back automatically. Only a matching explicit Give Back releases observation.
"""
import asyncio
import base64
import json
import math
import re
import sqlite3


class PrivateControl(ValueError):
    pass


class BrowserControl:
    def __init__(self, engine, path):
        self.engine = engine
        self.lock = asyncio.Lock()
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS binding(body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1), session TEXT NOT NULL, owner TEXT NOT NULL, phase TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS returned_sessions(session TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS target(id TEXT NOT NULL);
        """)
        binding = json.dumps({k: engine.scope[k] for k in ("account", "workspace_id", "computer_id", "generation")}, sort_keys=True)
        saved = self.db.execute("SELECT body FROM binding").fetchone()
        if saved and saved[0] != binding:
            raise ValueError("private browser binding mismatch")
        if not saved:
            self.db.execute("INSERT INTO binding VALUES(?)", (binding,))

    def state(self):
        row = self.db.execute("SELECT session,owner,phase FROM control WHERE id=1").fetchone()
        return dict(zip(("session", "owner", "phase"), row)) if row else None

    def private(self):
        state = self.state()
        return state is not None and state["phase"] != "agent"

    def require_agent(self):
        if self.private():
            raise PrivateControl("private human control")

    async def attach_page(self):
        # Reattach exactly our CDP target, never select an arbitrary logged-in tab.
        saved = self.db.execute("SELECT id FROM target").fetchone()
        for page in self.engine.context.pages if saved else []:
            session = await self.engine.context.new_cdp_session(page)
            try:
                target = (await session.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
            finally:
                await session.detach()
            if target == saved[0]:
                return page
        # Chromium restart changes CDP target identities. Keep the private fence
        # and profile, but start blank rather than guessing a restored tab or
        # replaying a potentially one-time navigation. Give Back is still explicit.
        page = await self.engine.context.new_page()
        session = await self.engine.context.new_cdp_session(page)
        try:
            target = (await session.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
        finally:
            await session.detach()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("DELETE FROM target")
            self.db.execute("INSERT INTO target VALUES(?)", (target,))
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        return page

    async def call(self, body):
        if set(body) != {"allocation", "identity", "command"}:
            raise ValueError("invalid private envelope")
        identity = body["identity"]
        self.engine.validate({"allocation": body["allocation"], "identity": identity,
                              "action": {"operation": "browser.tabs", "args": {}, "replay_class": "read_only"}})
        command = body["command"]
        if set(command) - {"action", "session_id", "input"}:
            raise ValueError("invalid private command")
        session = command.get("session_id")
        action = command.get("action")
        if (action != "status" or session is not None) and (not isinstance(session, str) or not re.fullmatch(r"[a-zA-Z0-9:_-]{1,160}", session)):
            raise ValueError("invalid session identity")
        owner = json.dumps([identity[k] for k in ("account", "workspace_id", "task_id", "root_goal_id")])
        async with self.lock:
            current = self.state()
            if action == "status":
                if not self.engine.ready or not self.engine.context.browser.is_connected() or self.engine.page.is_closed():
                    raise ValueError("browser unavailable")
                if session is not None and (not current or current["session"] != session or current["owner"] != owner):
                    raise ValueError("private session mismatch")
                return {"session_id": current["session"] if current and current["owner"] == owner else None,
                        "generation": self.engine.scope["generation"], "phase": current["phase"] if current else "agent"}
            if action == "take_over":
                if self.db.execute("SELECT 1 FROM returned_sessions WHERE session=?", (session,)).fetchone():
                    raise ValueError("session already returned")
                if current and current["session"] == session and current["owner"] == owner:
                    if current["phase"] == "agent":
                        raise ValueError("session already returned")
                elif current and current["phase"] != "agent":
                    raise ValueError("another private session exists")
                else:
                    self.db.execute("INSERT OR REPLACE INTO control VALUES(1,?,?,'taking_over')", (session, owner))
                # Fence first, then drain. No credentials are entered until the
                # caller receives human control. A failed drain stays private.
                if self.engine.active:
                    await asyncio.wait_for(asyncio.shield(self.engine.active), 35)
                if not self.engine.ready or not self.engine.context.browser.is_connected() or self.engine.page.is_closed():
                    raise ValueError("browser unavailable")
                self.db.execute("UPDATE control SET phase='human' WHERE id=1")
            elif not current or current["session"] != session or current["owner"] != owner:
                raise ValueError("private session mismatch")
            elif action == "give_back":
                # Input and captures share this lock; no pending input can cross
                # the acknowledged handback. Replays cannot reopen the session.
                # Retire before release; a crash between these commits stays fenced.
                self.db.execute("INSERT OR IGNORE INTO returned_sessions VALUES(?)", (session,))
                self.db.execute("UPDATE control SET phase='agent' WHERE id=1")
            elif current["phase"] != "human":
                raise ValueError("human control unavailable")
            elif action == "frame":
                png = await self.engine.page.screenshot(type="png", full_page=False, timeout=10000)
                if len(png) > 3_000_000:
                    raise ValueError("frame too large")
                return {"session_id": session, "generation": self.engine.scope["generation"], "phase": "human",
                        "png": base64.b64encode(png).decode()}
            elif action == "input":
                value = command.get("input", {})
                kind = value.get("kind")
                allowed = {"click": {"kind", "x", "y"}, "text": {"kind", "text"},
                           "key": {"kind", "key"}, "scroll": {"kind", "x", "y"}}
                if kind not in allowed or set(value) != allowed[kind]:
                    raise ValueError("invalid input")
                if kind in ("click", "scroll") and any(type(value[k]) not in (int, float) or not math.isfinite(value[k]) or abs(value[k]) > 16384 for k in ("x", "y")):
                    raise ValueError("invalid input coordinates")
                if kind == "text" and (not isinstance(value["text"], str) or not 0 < len(value["text"]) <= 2000):
                    raise ValueError("invalid text input")
                if kind == "key" and value["key"] not in ("Tab", "Shift+Tab", "Enter", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"):
                    raise ValueError("invalid key")
                # Record only an opaque identity, never typed credentials or
                # a guessable password hash. Lost acknowledgement never replays.
                if self.db.execute("SELECT 1 FROM inputs WHERE id=?", (identity["request_id"],)).fetchone():
                    raise ValueError("input already dispatched; inspect the page")
                self.db.execute("INSERT INTO inputs VALUES(?)", (identity["request_id"],))
                try:
                    if kind == "click":
                        await self.engine.page.mouse.click(value["x"], value["y"])
                    elif kind == "text":
                        await self.engine.page.keyboard.insert_text(value["text"])
                    elif kind == "key":
                        await self.engine.page.keyboard.press(value["key"])
                    else:
                        await self.engine.page.mouse.wheel(value["x"], value["y"])
                except BaseException:
                    self.db.execute("UPDATE control SET phase='input_uncertain' WHERE id=1")
                    raise
            else:
                raise ValueError("unknown private command")
            return {"session_id": session, "generation": self.engine.scope["generation"], "phase": self.state()["phase"]}

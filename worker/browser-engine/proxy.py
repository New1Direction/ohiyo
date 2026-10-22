"""Loopback CONNECT adapter. Runtime credentials never enter Chrome's argv.

The ImOrb gateway still authenticates the allocation, pins public DNS, checks
grants and revokes active tunnels. This adapter is not a replacement policy.
"""
import asyncio
import base64
import json
import re
from pathlib import Path
from urllib.parse import urlsplit, unquote


async def tunnel(reader, writer, credentials=Path("/orb/state/runtime/egress.json")):
    upstream = None
    pumps = []
    connected = False
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        method, authority, version = head.split(b"\r\n", 1)[0].decode("ascii").split(" ")
        if method != "CONNECT" or version != "HTTP/1.1" or not re.fullmatch(r"[A-Za-z0-9.-]+:443", authority):
            raise ValueError("CONNECT HTTPS only")
        # Re-read on every tunnel: revoked/rotated credentials are not cached.
        config = json.loads(credentials.read_text())
        proxy = urlsplit(config["HTTPS_PROXY"])
        if proxy.scheme != "http" or not proxy.hostname or not proxy.port or not proxy.username or not proxy.password or proxy.path or proxy.query or proxy.fragment:
            raise ValueError("runtime proxy unavailable")
        token = base64.b64encode(f"{unquote(proxy.username)}:{unquote(proxy.password)}".encode()).decode()
        upstream_reader, upstream = await asyncio.wait_for(asyncio.open_connection(proxy.hostname, proxy.port, limit=16384), 10)
        upstream.write(f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: Basic {token}\r\n\r\n".encode())
        await upstream.drain()
        response = await asyncio.wait_for(upstream_reader.readuntil(b"\r\n\r\n"), 10)
        if response.split(b"\r\n", 1)[0].split(b" ")[1] != b"200":
            raise ValueError("upstream denied")
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
        connected = True

        async def pump(source, target):
            while chunk := await source.read(65536):
                target.write(chunk)
                await target.drain()
        pumps = [asyncio.create_task(pump(reader, upstream)), asyncio.create_task(pump(upstream_reader, writer))]
        await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
    except Exception:
        # Never echo upstream bodies, credentials or exceptions to clients/logs.
        if not connected and not writer.is_closing():
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    finally:
        for task in pumps:
            task.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)
        if upstream:
            upstream.close()
        writer.close()


async def main():
    server = await asyncio.start_server(tunnel, "127.0.0.1", 8766, limit=16384)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

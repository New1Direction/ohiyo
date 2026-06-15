# LiveKit SFU — scalable voice/video for Kikkacord

Kikkacord ships with peer-to-peer WebRTC voice that works great for small calls
(~4-5 people) but degrades as everyone connects to everyone. LiveKit replaces the
mesh with a **selective forwarding unit (SFU)**: each client sends its media once to
LiveKit, which forwards it — so large rooms stay cheap and reliable.

This path is **optional and additive**. With LiveKit disabled, the built-in P2P mesh
is unchanged. The two never run at once; the client picks one engine.

## Run it

```bash
# 1. Generate a key/secret pair and put it in livekit.yaml `keys:` (and the server env)
docker run --rm livekit/livekit-server generate-keys

# 2. Edit livekit.yaml — set the keys and, for real networks, the public node IP
# 3. Start it
LIVEKIT_NODE_IP=<public-ip> docker compose -f infra/livekit/docker-compose.yml up -d
```

Then on the **server** (`server/.env`):

```
LIVEKIT_ENABLED=true
LIVEKIT_URL=wss://<your-host>:7880        # returned to the client; wss in prod
LIVEKIT_API_KEY=devkey                    # the key from livekit.yaml
LIVEKIT_API_SECRET=<the secret>           # the value from livekit.yaml
```

And build the **client** with `VITE_LIVEKIT_ENABLED=true` (or let it read
`GET /livekit/config` at runtime).

## How it fits together

- **Server** mints a room-scoped join token: `POST /channels/{channel_id}/livekit-token`
  (membership-checked). The token is a standard LiveKit HS256 JWT — room = channel id,
  identity = user id — signed with the API secret. No LiveKit SDK on the server.
- **Client** calls that endpoint, then `room.connect(url, token)` via `livekit-client`.
  The `useWebRTCLiveKit` hook maps LiveKit room events onto the same shape the call UI
  already consumes, so `CallOverlay` is unchanged.
- **Config discovery**: `GET /livekit/config` returns `{ enabled, url }` so the client
  knows whether SFU mode is available.

## Verify

1. `curl -s localhost:7880` should respond (LiveKit is up).
2. With server + client flags on, join a voice channel with 6+ people — confirm one
   connection per client (SFU), and audio/video/screen-share all work.
3. Flip `LIVEKIT_ENABLED=false` and confirm the P2P mesh still works unchanged.
4. A non-member must get `403` from the token endpoint.

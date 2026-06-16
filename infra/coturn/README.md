# Ohiyo TURN (coturn)

Production NAT traversal. STUN alone fails for ~10–20% of users behind symmetric
NATs; TURN relays their media so calls connect anywhere. The Ohiyo server
mints short-lived TURN credentials at `GET /api/v1/ice-servers` using the same
secret coturn is configured with — no per-user accounts on the TURN server.

## Setup (5 steps)

1. **Generate a secret:** `openssl rand -hex 32`. Put the value in this directory's
   `.env` as `TURN_SECRET=…` **and** in the Ohiyo server's environment as
   `TURN_SECRET=…` — they must be **byte-identical**.
2. **Edit `turnserver.conf`:** set `external-ip` (your public IP) and `realm`; drop
   TLS certs into `./certs/` as `fullchain.pem` + `privkey.pem`.
3. **Open the firewall:** UDP/TCP `3478`, TCP `5349`, and UDP `49152-65535`.
4. **Start it:** `docker compose up -d coturn`. Verify with a
   [Trickle ICE test page](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
   using a credential from `/api/v1/ice-servers` — you should see a `relay` candidate.
5. **Point the app at it:** on the Ohiyo server set
   `TURN_URLS=turn:turn.yourdomain:3478?transport=udp,turns:turn.yourdomain:5349?transport=tcp`
   and restart. Hit `GET /api/v1/ice-servers` — confirm a TURN entry whose
   `username` is `"<expiry>:<userid>"` and `credential` is a 28-char base64 string
   ending in `=`.

## Verifying a credential

The credential the server returns must equal coturn's own computation:

```bash
printf '%s' '<expiry>:<userid>' | openssl dgst -sha1 -hmac '<TURN_SECRET>' -binary | openssl base64
```

If it doesn't match, coturn returns 401 and the browser shows only a generic ICE
failure. Common causes: url-safe base64 instead of standard, SHA-256 instead of
SHA-1, or a trailing newline in `TURN_SECRET`. The server's
`rest_credential_matches_known_vector` unit test guards the algorithm.

## `.env` (do NOT commit)

```
TURN_SECRET=<same value the Ohiyo server uses>
TURN_REALM=turn.yourdomain
TURN_EXTERNAL_IP=203.0.113.10
```

# Ohiyo Push & Mobile Runbook

Ohiyo push notifications are **content-free by design**. The push relay may learn a device endpoint/token, recipient id, platform, delivery attempt status, and delivery time. It must not receive message text, filenames, channel names, server names, invite codes, or E2E keys.

## Shipped pieces

- PWA manifest: `client/public/manifest.webmanifest`
- Service worker: `client/public/sw.js`
- Client settings: Settings → Notifications
- Device registry endpoints:
  - `GET /api/v1/push/config`
  - `GET /api/v1/push/devices`
  - `PUT /api/v1/push/devices`
  - `DELETE /api/v1/push/devices/{id}`
- Content-free relay endpoint:
  - `POST /api/v1/push/relay/content-free`
  - Auth: `Authorization: Bearer $OHIYO_PUSH_RELAY_SECRET`
- Dispatch endpoint:
  - `POST /api/v1/push/dispatch`
  - Auth: `Authorization: Bearer $OHIYO_PUSH_RELAY_SECRET`
- Background dispatcher:
  - Enable with `OHIYO_PUSH_DISPATCH_ENABLED=1`.
  - Runs from the existing server sweeper loop.
- Message sends enqueue content-free `push_deliveries` rows for offline recipients with registered devices.
- Dispatch retries transient provider failures with backoff and disables expired/invalid device tokens.

## Queue lifecycle

`push_deliveries` stores only metadata:

- `user_id`
- `device_id`
- `kind` (`message` or `test`)
- `status` (`queued`, `delivered`, `failed`, `skipped`)
- attempt timestamps/error class

It does **not** store message content, channel names, server names, filenames, invite links, or keys.

Retry behavior:

- Max attempts: 5.
- Backoff: ~30s, 2m, 10m, then 30m.
- Delivered/failed/skipped rows older than 30 days are garbage-collected.
- Invalid tokens/endpoints disable the matching `push_devices` row.

## Web/PWA push setup

1. Generate VAPID keys:

```bash
openssl ecparam -genkey -name prime256v1 -out vapid-private.pem
openssl ec -in vapid-private.pem -pubout -outform DER | tail -c 65 | base64 | tr '/+' '_-' | tr -d '\n='
```

2. Set deploy secrets on the relay/control-plane host:

```bash
OHIYO_WEB_PUSH_PUBLIC_KEY=<base64url public key for the browser>
OHIYO_WEB_PUSH_PRIVATE_KEY_PEM="$(cat vapid-private.pem)"
OHIYO_WEB_PUSH_SUBJECT=mailto:security@ohiyo.gg
OHIYO_PUSH_RELAY_SECRET=<long random shared secret>
OHIYO_PUSH_DISPATCH_ENABLED=1
```

`OHIYO_WEB_PUSH_PRIVATE_KEY` is also accepted for PEM content if your secret manager cannot use the `_PEM` name.

3. Payload shape remains generic:

```json
{ "title": "Ohiyo", "body": "You have new activity.", "data": { "kind": "message" } }
```

## APNs setup

1. Enroll the Apple Developer account for the shipping organization.
2. Create an App ID with Push Notifications enabled.
3. Create an APNs Auth Key (`.p8`) and record Key ID + Team ID.
4. Register iOS device tokens via `PUT /api/v1/push/devices` with `platform: "apns"`.
5. Set secrets:

```bash
OHIYO_APNS_KEY_ID=<Apple key id>
OHIYO_APNS_TEAM_ID=<Apple team id>
OHIYO_APNS_TOPIC=<bundle id, e.g. gg.ohiyo.app>
OHIYO_APNS_PRIVATE_KEY_P8="$(cat AuthKey_XXXXXX.p8)"
OHIYO_APNS_SANDBOX=0   # set 1 for sandbox tokens
OHIYO_PUSH_RELAY_SECRET=<long random shared secret>
OHIYO_PUSH_DISPATCH_ENABLED=1
```

APNs payloads are content-free:

```json
{
  "aps": {
    "alert": { "title": "Ohiyo", "body": "You have new activity." },
    "sound": "default",
    "thread-id": "ohiyo"
  },
  "kind": "message"
}
```

## FCM setup

1. Create a Firebase project for the shipping app.
2. Add Android package / app signing config.
3. Register Android tokens via `PUT /api/v1/push/devices` with `platform: "fcm"`.
4. Set secrets:

```bash
OHIYO_FCM_SERVICE_ACCOUNT_JSON='<service-account-json>'
# or:
OHIYO_FCM_SERVICE_ACCOUNT_FILE=/run/secrets/firebase-service-account.json
OHIYO_PUSH_RELAY_SECRET=<long random shared secret>
OHIYO_PUSH_DISPATCH_ENABLED=1
```

FCM payloads are content-free:

```json
{
  "message": {
    "token": "<device-token>",
    "notification": { "title": "Ohiyo", "body": "You have new activity." },
    "data": { "kind": "message" }
  }
}
```

## Privacy checklist before enabling dispatch

- [x] Push payload contains no plaintext content.
- [x] No channel/server/user display names in payload.
- [x] Relay logs/status errors avoid endpoint/token values.
- [x] Device list is owner-scoped.
- [x] Disable/delete device works.
- [x] Invalid APNs/FCM/Web Push endpoints disable the device row.
- [x] Self-hosters can leave dispatch disabled or run their own relay.

## Smoke checks

```bash
curl -fsS https://ohiyo.fly.dev/api/v1/push/config | jq .privacy_note

curl -X POST https://ohiyo.fly.dev/api/v1/push/dispatch \
  -H "Authorization: Bearer $OHIYO_PUSH_RELAY_SECRET"
```

Expected dispatch response shape:

```json
{
  "attempted": 0,
  "delivered": 0,
  "retried": 0,
  "failed": 0,
  "disabled_devices": 0,
  "skipped_missing_device": 0,
  "skipped_missing_provider": 0
}
```

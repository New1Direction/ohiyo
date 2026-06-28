# Ohiyo Push & Mobile Runbook

Ohiyo push notifications are **content-free by design**. The push relay may learn a device endpoint/token, recipient id, and delivery time. It must not receive message text, filenames, channel names, invite codes, or E2E keys.

## Current shipped pieces

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
- Message sends enqueue content-free `push_deliveries` rows for offline recipients with registered devices.

## Web/PWA push setup

1. Generate VAPID keys with your preferred web-push tooling.
2. Set on the relay/control-plane host:
   - `OHIYO_WEB_PUSH_PUBLIC_KEY`
   - private VAPID key / sender identity for the dispatcher once implemented
3. Keep the client copy honest: if `OHIYO_WEB_PUSH_PUBLIC_KEY` is absent, the app offers local notifications only.
4. Dispatch only a generic payload, for example:

```json
{ "title": "Ohiyo", "body": "You have a new message." }
```

Do not put channel names, usernames, message text, file names, or server names in push payloads.

## APNs if native iOS arrives

1. Enroll the Apple Developer account for the shipping organization.
2. Create an App ID with Push Notifications enabled.
3. Create an APNs Auth Key (`.p8`) and record Key ID + Team ID.
4. Store credentials as deploy secrets, never in the repo.
5. Register iOS device tokens via `PUT /api/v1/push/devices` with `platform: "apns"`.
6. Send content-free APNs payloads only:

```json
{
  "aps": {
    "alert": { "title": "Ohiyo", "body": "You have a new message." },
    "sound": "default",
    "thread-id": "ohiyo"
  }
}
```

## FCM if native Android arrives

1. Create a Firebase project for the shipping app.
2. Add Android package / app signing config.
3. Store the service account JSON as a deploy secret.
4. Register Android tokens via `PUT /api/v1/push/devices` with `platform: "fcm"`.
5. Send generic notification/data only:

```json
{
  "token": "<device-token>",
  "notification": { "title": "Ohiyo", "body": "You have a new message." },
  "data": { "kind": "message" }
}
```

## Privacy checklist before enabling any dispatcher

- [ ] Push payload contains no plaintext content.
- [ ] No channel/server/user display names in payload.
- [ ] Relay logs redact endpoints/tokens.
- [ ] Device list is owner-scoped.
- [ ] Disable/delete device works.
- [ ] Self-hosters can leave relay unset or run their own relay.

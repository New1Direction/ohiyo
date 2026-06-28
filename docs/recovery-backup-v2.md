# Recovery backup v2 design notes

Ohiyo recovery backup v2 is deliberately **keys-only by default** and **recovery-secret-gated**. This document records the non-obvious constraints so future refactors do not accidentally undo the privacy properties.

## What ships now

- A v2 encrypted recovery blob for personal key backup.
- A public coverage manifest with only blinded handles and coarse backup metadata.
- v1 restore compatibility.
- No plaintext-cache export in new backups.
- First-class undecryptable-message states.

## Load-bearing constraints

### The manifest blind key is derived from the recovery code

Room ids and sender-key ids are not high entropy. The server issued room ids and can often guess epoch/key-id ranges. Therefore this would be decorative, not protective:

```txt
room_blind = HMAC(server_known_key, room_id)
```

A curious server could enumerate known room ids and de-blind the manifest.

v2 instead derives the blind key client-side from the recovery code and salt. The blind key is never uploaded or stored server-side. Consequence: a fresh device cannot classify coverage from account auth alone. Coverage classification is available after the user enters the recovery code.

### No clear room ids, key ids, or per-room timestamps in the public manifest

The coverage manifest is the most privacy-sensitive part of recovery backup. Clear room ids would reveal the membership graph. Per-room `message_time_min/max` would reveal an activity timeline. We only need membership tests, so the manifest stores opaque HMAC handles and coarse backup-level timestamps.

### Snapshot format is shaped for future continuous backup

Today v2 writes a snapshot. The format still uses per-entry records with `source_device_id`, timestamps, namespace, and blinded coverage handles so future continuous backup can merge/replace entries without migrating a flat blob.

There is intentionally no top-level `device_id`: a continuous backup can receive entries from multiple devices, so device provenance belongs per entry.

### New backups exclude decrypted plaintext cache

`kc:e2e-pt:` is decrypted message plaintext cache. Storing it server-side, even encrypted under a user-held recovery code, changes the threat model from “server never stores plaintext” to “server stores user-encrypted plaintext backups.” New backups exclude it by default.

Restore still accepts `kc:e2e-pt:` for legacy v1 backups so existing users are not stranded. Re-running backup overwrites the single server-stored backup row with a v2 keys-only blob.

### No retry button on terminal undecryptable messages

Some messages are unrecoverable by construction: forward secrecy may have deleted the key before it was backed up. A retry button in that state trains users to retry cryptographic impossibility and turns a privacy guarantee into a support ticket.

The UI may offer recovery before coverage is known. After a recovery attempt still fails, it renders a terminal explanation with no fake retry loop.

## Deferred restore-read obligation

Restore-read must consume the v2 manifest instead of permanently leaving all failed decrypts in the generic “open recovery” state.

The target states are:

1. **Checking / recovery-code needed** — coverage cannot be checked until the user enters the recovery code because the blind key is recovery-derived.
2. **Recoverable** — manifest check says the needed key appears covered; show restore action.
3. **Not covered / gone** — manifest check proves the key is absent; no restore CTA.
4. **Restored but still unreadable** — manifest promised coverage, restore ran, decrypt still failed; show terminal explanation and optional report/learn-more affordance.

The restore preview should be built from the manifest after recovery-code entry: backup updated time, entry count, approximate covered room/key counts, and any version warnings.

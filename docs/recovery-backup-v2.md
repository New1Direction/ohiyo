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

## Restore-read manifest consumption

Restore-read consumes the v2 manifest after the user enters their recovery code. This is intentional: coverage cannot be checked from account auth alone because the blind key is recovery-derived.

Current states:

1. **Recovery-code needed** — before code entry, failed decrypts can only offer Personal recovery because the client cannot classify coverage yet.
2. **Covered in preview** — the restore preview checks locally recorded missing group sender-key ids against the manifest and reports how many appear covered.
3. **Not covered / gone** — preview persists not-covered results; after reload, those messages render without a restore button.
4. **Restored but still unreadable** — manifest promised coverage or coverage was unknown, restore ran, decrypt still failed; show terminal explanation and no fake retry loop.

Coverage preview keeps a durable per-home/per-user local ledger and scans recent accessible channels before preview, so group sender-key classification survives browser restarts and covers recently unseen messages.

Signal 1:1 Double Ratchet messages now get a stronger preview when the recent ciphertext is still accessible: after the user enters the recovery code, the client decrypts the backup into memory, clones the backed-up Signal store, and attempts Signal decrypts against the clone only. This classifies messages as:

- `signal_restorable` — cloned ratchet state likely decrypts this ciphertext after restore.
- `signal_missing_session` — backup lacks the sender/device ratchet session.
- `signal_not_addressed` — ciphertext was not addressed to the backed-up user/device id.
- `signal_corrupt` — ciphertext/session state is malformed or incompatible.
- `unavailable` — durable inventory knows a Signal message existed, but recent ciphertext was not available for clone-preview.

The clone-preview must never run against the live Signal store because a successful Double Ratchet decrypt advances state. The live store is mutated only when the user explicitly restores keys.

Restore preview also reports partial restore material counts: total entries, importable entries, ignored unsupported entries, Signal ratchet sessions, group sender keys, and legacy plaintext-cache entries. Wrong-code/tamper/corrupt backup failures use honest error copy instead of pretending all failures are just mistyped recovery codes.

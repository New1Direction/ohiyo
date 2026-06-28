# Ohiyo real-device call + screen-share smoke test

This is the launch-gate test for Ohiyo calls. Automated e2e covers signaling,
WebRTC seams, camera toggles, screen-share late join, and UI states. This manual
smoke proves the OS/browser/hardware path: real mic, real speakers, real camera,
real screen picker, and real network behavior.

## Required setup

- Two physical devices on the same network, or one laptop + one phone/second laptop.
- Chrome/Edge desktop preferred for the sharer. Safari/Firefox can be secondary checks.
- Use headphones on at least one side to avoid echo during mic checks.
- App reachable from both devices.

## Local dev start

Terminal 1:

```bash
cd server
cargo run
```

Terminal 2:

```bash
cd client
npm run dev -- --host 0.0.0.0
```

Open Device A and Device B to the LAN URL printed by Vite, usually:

```text
http://YOUR_LAN_IP:1420
```

If using a deployed build instead, use the production URL and skip the local
commands.

## Test accounts

- Device A: create account `call_a_<date>` / display `Ada`
- Device B: create account `call_b_<date>` / display `Ben`
- A creates a space.
- A opens Invite, copies the invite link.
- B opens the invite link and joins the same space.

## Pass/fail matrix

| # | Step | Expected result | Pass |
|---|------|-----------------|------|
| 1 | A joins General voice | A sees cozy Solo voice card, no giant empty slab | ☐ |
| 2 | Before B joins | B sees Ada listed under the voice channel with a live count | ☐ |
| 3 | B joins same voice room | Both see 2-person Voice room and each other's names | ☐ |
| 4 | Mic A→B | B clearly hears A within ~1s | ☐ |
| 5 | Mic B→A | A clearly hears B within ~1s | ☐ |
| 6 | A mutes | B sees A muted quickly; B no longer hears A | ☐ |
| 7 | A unmutes | B sees unmuted; B hears A again | ☐ |
| 8 | A turns camera on | Both switch to Video room; B sees A camera | ☐ |
| 9 | A turns camera off | Both return to voice/media state cleanly | ☐ |
| 10 | A starts screen share using Sharp/default | Screen picker opens; B sees A's screen sharply | ☐ |
| 11 | Text-detail check | B can read small browser/app text from A's shared screen | ☐ |
| 12 | Motion check | A scrolls/moves window; B sees smooth enough motion | ☐ |
| 13 | Late join while sharing | B leaves call, A keeps sharing, B rejoins and sees active share | ☐ |
| 14 | Stop sharing | Both return to Voice room, no frozen screen tile | ☐ |
| 15 | Output picker | If browser supports it, changing output device routes audio correctly | ☐ |
| 16 | Minimize/open | Minimized call card works and reopens without breaking media | ☐ |
| 17 | Leave cleanup | A leaves; B returns to Solo voice; no ghost participant | ☐ |

## Screen-share quality bar

This is a launch-driving feature. Mark as fail if:

- Text is blurry at normal zoom on the viewer side.
- Late joiner does not receive the existing share.
- Screen share falls back to a tiny cropped tile.
- Stopping share leaves a frozen/stale frame.
- Starting share breaks mic audio.
- Browser permissions copy feels scary or confusing.

## Notes to capture

Record these during the test:

```text
Date/time:
Build/commit:
Device A OS/browser:
Device B OS/browser:
Network:
Mic A→B pass/fail:
Mic B→A pass/fail:
Camera pass/fail:
Screen share readability pass/fail:
Late join pass/fail:
Output picker pass/fail/unsupported:
Issues observed:
Screenshots/video captured:
Final verdict: PASS / FAIL
```

## Current automated baseline

As of commit `b60aaaf`, automated validation passed:

- Client typecheck/lint/unit
- Server cargo fmt/check/test
- `e2e/23-call-smoke.test.mjs` locally and against production
- Production voice roster smoke: B sees Ada in voice before joining

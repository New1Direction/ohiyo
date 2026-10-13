# What we can and can't say

Every outreach message, call and doc in this program uses these lines. Each one is
backed by a public source; link the source when a prospect asks. If the code and this
page disagree, the code wins and this page gets fixed (the same rule as the
[threat model](https://ohiyo.gg/threat-model.html)).

Sources: [README](../../../README.md) ("Highlights", "Known limits of the encryption"),
[SECURITY.md](../../../SECURITY.md), the [privacy policy](https://ohiyo.gg/privacy.html),
the [threat model](https://ohiyo.gg/threat-model.html),
[`LAUNCH-STATUS.md`](../../../LAUNCH-STATUS.md),
[`docs/discord-template-migration.md`](../../discord-template-migration.md) and
[`docs/server-pack-export.md`](../../server-pack-export.md). Checked 2026-10-13.

## Say this

**Privacy**

- "Turn on the lock in a DM or a group chat and messages are encrypted on your device
  before they're sent. For those conversations our server stores only ciphertext."
- "The lock is opt-in. New DMs start unencrypted."
- "**Channels inside a space are not end-to-end encrypted.** On the hosted service our
  server can read them, the same as most chat apps. Polls and watch-party links aren't
  encrypted either."
- "Group-chat encryption is experimental. It's our own design, and a message sent while
  someone was offline can be missed."
- "One-to-one encryption uses the Signal Protocol through a community TypeScript port.
  Nothing has had an external audit yet."
- "Even with the lock on, the server still sees metadata: who's in which space, who talks
  to whom, when, message sizes, IP addresses, and who joins a voice room."
- "Ohiyo isn't anonymous. If you need anonymity or protection for sources, use a tool
  built for that, like SimpleX or Signal." (The threat model says the same.)
- "If you don't want to trust us with your channels, run your own server. Then the
  channels are readable only by whoever runs that box: you."
- "Sign-up is a username and a password. No email, no phone number."
- "No ads, no trackers on the site, no telemetry in the app, no paid features."

**Product**

- "Paste a Discord server template link and Ohiyo rebuilds your categories, channels,
  roles, colors and custom emoji, then shows you which rooms are private before you
  invite anyone." Template import **does not bring message history**.
- "It runs in the browser on a computer or a phone. There are desktop apps for Mac (a
  beta Apple hasn't verified yet) and Linux. No Windows app yet, but the browser works
  there. No native phone apps; the phone uses the browser, with notifications through
  Web Push."
- "Voice and video connect people directly. That's great for small rooms. On the hosted
  beta, plan on rooms of about five people; bigger rooms need a server you run with the
  optional LiveKit add-on, which is newer and less tested."
- "It's open source under the AGPL. You can read it, run it, and change it."
- "Self-hosting is one server program and one database file." Setup guide:
  [`DEPLOY.md`](../../../DEPLOY.md).
- "It's a public beta. Things will break, and in this program we fix them with you."

**Leaving**

- "If you run your own server, you have the database file and the uploads, and the
  Server Pack export packages them with checksums." (Server Pack only works on a home
  where the owner owns every space, so it's for your own server, not the shared hosted
  beta.)
- "On the shared hosted beta there's no button that exports a space yet. If owning a copy
  of your data matters to you, self-host from day one, and we'll help."
- "Moving from the hosted beta to your own server later means rebuilding the layout from
  a template. Messages from the hosted beta don't come along today."

## Never say this

| Don't say | Why | Say instead |
|---|---|---|
| "End-to-end encrypted chat" / "fully encrypted" / "we can't read your messages" (without saying which) | Channels aren't E2EE; the lock is opt-in | "Locked DMs and group chats: we can't read them. Channels: we can." |
| "Signal-grade" / "as secure as Signal" | Community port, own group scheme, no audit | "Uses the Signal Protocol for one-to-one chats; no external audit yet" |
| "Anonymous" / "metadata-free" / "untraceable" | The threat model says the opposite | "Reduces some leaks; isn't anonymous" |
| "Safe for activists / journalists / sources" | Out of scope in the threat model | Refer them to SimpleX or Signal |
| "HIPAA / GDPR-compliant" / "compliant with anything" | No compliance programme exists | Don't offer it for regulated data |
| "Instant Servers" / "we'll host your server" / "always-on for $8" | Not running on the hosted service; the paid plan isn't sold (`LAUNCH-STATUS.md`) | "Hosted beta at app.ohiyo.gg, or your own server" |
| "We'll import your whole Discord history" | History import is operator-only and not promised (see README, owner decision 3) | "We import your layout. History is a maybe; we'll tell you before migration day" |
| "One-click export" on the hosted beta | Server Pack needs a dedicated home | "Self-host if you need an export" |
| "Works for big voice events" | Peer-to-peer mesh, no SFU on hosted | "Small rooms on the hosted beta" |
| "Uptime guarantee" / "SLA" | None exists | "Public beta; status at ohiyo.gg/status.html" |
| "Discord can read your messages; we can't" | True for locked chats only, and it attacks a product people chose | Talk about what Ohiyo does, and let them compare |

## One sentence to watch for in the terms

The [Terms](https://ohiyo.gg/terms.html) say "Because Ohiyo is end-to-end encrypted for
private message content, the hosted server generally cannot read message plaintext."
That is true only of locked DMs and group chats. Don't quote that sentence on its own
to a prospect. Quote the README's limits instead.

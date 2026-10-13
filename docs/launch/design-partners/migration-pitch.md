# The migration pitch

What we say when a community asks "why would we move?" It's short on purpose, and it
never runs Discord down. People chose Discord for good reasons; we only need to show
what Ohiyo does differently, and be straight about what it can't do yet.

## The core pitch (60 seconds)

> "Ohiyo is group chat that feels like Discord: spaces, channels, roles, voice rooms,
> screen sharing, threads, events. The difference is who it belongs to.
>
> It's open source, there are no ads and no paid features, and you can run it on your
> own box: one server program and one database file. If you'd rather not run anything,
> use our hosted beta.
>
> DMs and group chats have a lock. Turn it on and those messages are encrypted on your
> device before they're sent, so the server only stores ciphertext. Channels in a space
> aren't encrypted, so on our hosted beta we could read them. That's exactly why the
> self-host option is there.
>
> Moving is less work than you'd think. Paste a Discord server template link, and
> Ohiyo rebuilds your categories, channels, roles, colors and emoji and shows you which
> rooms are private before anyone joins. It doesn't bring the message history.
>
> As a founding partner you'd move one real part of your community for 90 days. We do
> the migration with you, Discord stays as a fallback, and it costs nothing."

## The three things that move people

Lead with whichever one they raised in qualification.

1. **"It's yours."** Self-host it and the database file is on your hardware, under your
   rules. Open source under the AGPL means nobody can take a hosted fork closed. No
   account needs an email or a phone number.
2. **"Nothing is paywalled."** Custom emoji, themes, GIF avatars and screen share
   aren't upsells. There's no per-person subscription to argue about.
3. **"Private where it counts."** Turn on the lock for the DM or small group chat where
   the sensitive stuff happens. Disappearing messages, safety numbers, Privacy Mode (no
   typing, presence or read signals), and two-factor sign-in are in the app today.

## By audience

**Hackerspaces and makerspaces**

> "Your members already run servers in the back room. Ohiyo is one container and a
> SQLite file you can put on the same box, with webhooks so your door bot or CI can post
> into a channel. Members' private chats can be locked; the space's channels stay on
> hardware you control."

**Linux and BSD user groups**

> "It's AGPL, the server is Rust, the client is React and Tauri, and there's a Linux
> desktop app (AppImage, .deb, .rpm). Your group can read, run and patch it. Voice in the
> Linux app isn't reliable yet, so use the browser for calls for now."

**CTF and security clubs**

> "You'll want to poke at it. Do: run your own instance, and report what you find
> privately through GitHub's vulnerability reporting (please don't test against our
> hosted service). For team comms, lock the DMs and group chats where you share
> solutions. Don't treat channels as secret: they aren't end-to-end encrypted."

**Digital-rights local groups**

> "We publish exactly what the server can and can't see, in the threat model. It's built
> for organizers who want something better than Discord for day-to-day coordination. It
> isn't built for anyone whose safety depends on anonymity; for that, we'll point you to
> SimpleX or Signal ourselves."

**Self-hosted open-source projects**

> "Your users already run your software on their own boxes; your community chat can
> live the same way. Import your Discord layout from a template in a minute, keep your
> roles, and give your users a support space that isn't on a platform that might change
> the rules next year."

**Small private game groups**

> "Voice, screen share and watch parties with friends, without anyone needing Nitro.
> Rooms of up to about five people work well on our hosted beta. For bigger raid nights,
> run your own server with the optional LiveKit add-on. It's the newer, less-tested
> path, so we'd set it up and test it with you."

## Objections, and honest answers

| They say | We say |
|---|---|
| "Everyone's already on Discord." | "Keep it. Move one channel or one weekly thing for 90 days and see if people stick. If they don't, you've lost nothing." |
| "Is it end-to-end encrypted?" | "DMs and group chats, when you turn the lock on. Channels, no. Here's the threat model." |
| "Can you read our channels?" | "On the hosted beta, yes, the server can, like most chat apps. On your own server, only whoever runs it can." |
| "Is it as secure as Signal?" | "No. One-to-one chats use the Signal Protocol through a community port, the group scheme is our own and experimental, and nothing's been audited yet." |
| "What about our message history?" | "Templates bring the layout, not messages. History import is something the maintainers would have to run; we'll tell you before migration day whether we can." |
| "Is there a phone app?" | "Not a native one. It runs in the phone's browser, with notifications through Web Push." |
| "Will voice hold up?" | "Calls connect people directly, which is great for small rooms. On the hosted beta, plan on about five people per room." |
| "What happens if you disappear?" | "The code is AGPL. If you self-host, nothing changes for you if we stop. On the hosted beta, that's a real risk; self-hosting removes it." |
| "Can we export?" | "On your own server, yes: you have the database, and Server Pack packages it. On the shared hosted beta there's no export button yet." |
| "What does it cost?" | "Nothing. The hosted beta is free and every feature is free. Running your own is free." |
| "What's the catch?" | "It's a beta, and we need your feedback to make it good. That's the trade." |

## What not to pitch

- Instant Servers or the paid plan. They aren't running on the hosted service.
- Anything on the "Never say this" list in [`claims.md`](claims.md).

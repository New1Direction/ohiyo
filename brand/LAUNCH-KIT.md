# Ohiyo — Launch Kit

Copy-paste social posts + AI-generation prompts for launching **Ohiyo**.
Voice rules in [`VOICE.md`](VOICE.md): warm in the chrome, dead-straight about the
stakes. Mascot: **Kikka**, a coral chinchilla. Never lean on the Ohio meme — lead with
"oh, hi" and the privacy.

---

## 0. Brand kit (paste this into any image/video tool first, for consistency)

> **Ohiyo** — a cozy, self-hostable, end-to-end-encrypted group chat. Mascot: **Kikka**,
> a small round chinchilla with soft coral-grey fur, big dark friendly eyes, tiny round
> ears. **Palette:** warm dusk — near-black brown `#171311`, coral/persimmon `#ff7a4d`,
> amber `#e0992f`, cream `#f5ece4`. **Mood:** dawn warmth + quiet safety — *a cozy room
> with a steel door.* Lantern/sunrise light, soft film grain, shallow depth of field,
> inviting, never cold or corporate.

---

## 1. Social posts

### X / Twitter — launch thread
1. **oh, hi. 👋**
   Today we're launching **Ohiyo** — the group chat that *can't* read your messages.
   Everything you love about Discord. End-to-end encrypted. Free. Self-hostable. 🧵
2. Discord keeps every message in plaintext on its servers. Ohiyo seals yours on your
   device first — so even our own servers only ever see ciphertext. Not "trust us"
   private. *Can't-read-it* private.
3. And it's the whole thing, not a teaser: servers, channels, DMs, voice, video, 4K
   screen-share, roles, polls, events. The stuff Discord charges Nitro for is just… how
   Ohiyo works. $0. Forever.
4. It's one Rust binary + a tiny native app. `git clone`, deploy to a $5 box, and you
   own your community — code, server, and conversations. No ads. No tracking. No exit
   tax.
5. Built in the open and built to be attacked: Signal-Protocol crypto (no hand-rolled
   anything), hard CI gates, real integration tests proving a removed member can't read
   the next message.
6. Kikka the chinchilla kept you a seat. 🐭
   → **ohiyo.gg** · self-host: github.com/New1Direction/ohiyo

### X — standalone one-liners
- "your group chat shouldn't be readable by the company that hosts it. oh, hi — meet Ohiyo. 🐭🔒"
- "we made a Discord that can't snitch."
- "good morning. nobody's reading over your shoulder. ☕ → ohiyo.gg"
- "the things Discord charges $9.99/mo for are just how Ohiyo works. for $0. forever."
- "self-hostable, end-to-end encrypted, and the mascot is a chinchilla. what more do you want."

### X — Instant Servers (the one-tap hook)
- "launch your own end-to-end-encrypted server in one tap. we host it, we can't read it, and you can leave with everything — for less than a Discord Nitro. 🐭"
- "one Nitro = a fancier avatar, for you. the same money on Ohiyo = an always-on encrypted server for your whole crew. and cost-per-person only drops as you grow."
- "it's Minecraft Realms for your group chat — one tap, we run it — except Realms can read your world, and we genuinely *can't* read your messages."
- "don't trust us to host it? export everything and move it to your own box in one click. or self-host from day one for $0. the door's always open. 🔒"

### Reddit — r/selfhosted & r/privacy
> **Title:** Ohiyo — a self-hostable, end-to-end-encrypted Discord alternative (Rust + Tauri, free & open)
>
> Hey all — I've been building **Ohiyo**, a community chat that does the Discord things
> (servers, channels, DMs, voice/video, 4K screen-share, roles, polls) but with
> **Signal-Protocol E2E encryption on by default** — the server only ever relays
> ciphertext.
>
> It's one Rust (axum) binary + SQLite + a Tauri desktop app. Deploys to a single small
> box (Docker/Fly), no external services required. No ads, no tracking, no paywall —
> everything Discord gates behind Nitro is just included.
>
> Honest status: text E2E (DMs + groups) is proven by integration tests; encrypted
> voice is implemented but I'm still hardening the live-SFU path. Self-host guide + code:
> github.com/New1Direction/ohiyo. Would love feedback from this crowd specifically.

### Hacker News — Show HN
> **Show HN: Ohiyo – a self-hostable, end-to-end-encrypted Discord alternative**
>
> Ohiyo is a community chat (servers/channels/DMs/voice/video/screen-share) where the
> server is designed to be blind to message content — Signal Protocol for DMs and
> groups, epoch-based rekeying so a removed member can't read future messages. Rust
> backend (axum + SQLite), React + Tauri client, single-binary self-host. Free, open.
> No hand-rolled crypto. Happy to go deep on the group-rekey design in the comments.

### Product Hunt
- **Tagline:** The group chat that can't read your messages.
- **First comment:** oh, hi 👋 — I built Ohiyo because group chat became where we live
  online, and we handed all of it to companies that read it and paywall the good parts.
  Ohiyo is everything you love about Discord, end-to-end encrypted, free, and yours to
  host. Kikka the chinchilla says hi. Would love your honest take.

### TikTok / Reels — hook scripts (3)
1. *(close-up, cozy lamplit desk, phone glowing)* "POV: your group chat literally can't
   read your messages." → quick montage of servers/voice/screenshare → "free. open.
   yours. oh, hi. 🐭"
2. "Discord charges you monthly to decorate a house you don't own." *(beat)* "so we built
   one you do." → self-host in 3 taps → "ohiyo.gg"
3. *(Kikka animation waves)* "good morning ☀️ here's a chat app that forgets what it
   doesn't need and can't read what it keeps." → disappearing messages demo → "Ohiyo."

### LinkedIn — founder post
> We kept treating "private messaging" and "fun community chat" as a trade-off. Signal is
> private but spartan; Discord is delightful but reads everything and paywalls the rest.
>
> Ohiyo is the refusal to choose: Signal-grade end-to-end encryption *and* the full warm
> Discord-style experience — voice, video, screen-share, roles — free and self-hostable.
> The server can't read your messages by design, not by promise.
>
> Built in Rust, shipped as a tiny native app, hardened with real tests. oh, hi. 👋

---

## 2. AI-generation prompts

> Paste the **Brand kit (§0)** first wherever the tool allows a style/reference, so Kikka
> and the palette stay consistent across every asset.

### 🎬 Veo 3 (video — loves detailed scenes + audio cues)
**Hero loop (8s):**
> Cinematic close-up, golden-hour interior at dawn. A cozy, dimly lit room — soft coral
> and amber light through a window, warm film grain, shallow depth of field. A small
> fluffy coral-grey chinchilla with big dark eyes sits on a wooden desk beside a softly
> glowing phone. It looks up at the lens and gives a gentle little wave. Camera slowly
> pushes in. **Audio:** warm ambient morning hum, a soft chime + gentle "click" as a
> message seals. On-screen text fades in: "oh, hi." 24fps, intimate, inviting.

**The "steel door" concept (8s):**
> A warm, lamplit living room full of soft pillows and string lights — laughter audible
> faintly. Slow dolly back reveals the cozy room sits behind a single heavy brushed-steel
> vault door, slightly ajar, warm light glowing through the gap. Coral accent lighting.
> **Audio:** cozy room tone, then a soft, reassuring deep "thunk" as the door seals.
> Text: "warm inside. sealed shut." Cinematic, premium, calm.

### ✨ Grok Imagine (image + image-to-video — concise, stylized)
- **Still → animate:** "Cozy 3D-render chinchilla mascot, soft coral-grey fur, big
  friendly eyes, waving hello, sitting on a glowing phone, warm dusk lighting, coral and
  amber palette, dark cozy background, Pixar-soft, inviting." → animate the wave + a slow
  light bloom.
- **Poster:** "Warm minimalist app hero, near-black `#171311` background, a single coral
  chinchilla logo glowing, big rounded wordmark 'oHiYo' with the 'Hi' in coral, soft
  grain, premium, cozy-secure."

### 🖼️ Midjourney / Flux (stills)
- `cozy coral chinchilla mascot, big dark eyes, soft fur, waving, sitting beside a glowing phone at dawn, warm dusk palette #171311 #ff7a4d #e0992f, soft film grain, shallow depth of field, intimate product hero, premium --ar 16:9 --style raw`
- `flat-lay of a warm encrypted "home" — a tiny glowing house made of soft light with a small steel keyhole door, coral and amber, dark cozy background, editorial, minimal --ar 1:1`

### 🍌 Nano Banana / Gemini (image edit — best for mascot consistency)
> Use a reference image of Kikka. "Keep this exact chinchilla character and palette.
> Place Kikka peeking out from behind a softly glowing speech bubble that says 'oh, hi'.
> Warm dusk lighting, coral accent, cozy dark background." (Great for generating a
> consistent set: Kikka waving / sleeping / on a call / holding a tiny lock.)

### 🔤 Ideogram (best at legible text-in-image — wordmark posters)
> "Bold rounded playful logotype 'oHiYo' (Animal-Crossing style), the 'Hi' in coral
> `#ff7a4d`, rest cream, on a warm near-black `#171311` background with soft grain, a
> small coral chinchilla beside it, tagline below: 'the encrypted home for your people'."

### 🎥 Sora / Runway (alt video)
> "Warm cinematic montage: a phone screen showing cozy group chats, then the message
> visibly wraps in a soft coral shield of light before flying off; cut to a chinchilla
> waving good morning; warm dusk grade, soft grain, gentle motion. 10s."

### 📋 Launch trailer storyboard (~15–20s)
1. Black → soft coral dawn glow. Text: *"your conversations…"*
2. Quick warm montage: a server, a voice call, a screen-share, a reaction. Text: *"…all of them."*
3. A message types, then visibly **seals** in coral light. Text: *"sealed before they leave your device."*
4. Pull back to the cozy-room-behind-a-steel-door. Text: *"a warm place that can't read you."*
5. Kikka waves. Wordmark **oHiYo** blooms in. Text: *"oh, hi. · ohiyo.gg · free & open."*
> Audio throughout: warm ambient morning pad, one gentle seal-chime, a soft final "thunk."

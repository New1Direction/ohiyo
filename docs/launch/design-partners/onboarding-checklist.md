# Onboarding checklist

From a signed-up partner to their day-90 review. "We" is the maintainer running the
partnership; "they" is the partner's contact. Copy this into the private tracker for
each partner and tick it off there.

## Week −2: kickoff (30-minute call)

- [ ] Confirm the scope: which part of the community moves, and the migration date.
- [ ] Confirm where it runs: **hosted beta** (app.ohiyo.gg) or **their own server**.
- [ ] Say the three limits again, out loud: channels aren't end-to-end encrypted; it
      isn't anonymous; no native phone apps. Link the
      [threat model](https://ohiyo.gg/threat-model.html).
- [ ] Say what's not coming along: message history (unless we've confirmed a history
      import), and, on the hosted beta, any later export of their messages.
- [ ] Agree how members will hear about it, in the partner's own words, sent by the
      partner. We don't message their members.
- [ ] Create the shared partner space on Ohiyo with the contact, and say the reply
      target (2 business days).
- [ ] Ask for a Discord **server template** link for the source server (Server
      Settings → Server Template in Discord). It carries no messages or members.
- [ ] Note the baseline numbers from [`success-metrics.md`](success-metrics.md#baseline-at-kickoff).

## Week −1: dry run

**Everyone**

- [ ] Import the template into a **test space** together. Go through the import report:
      roles needing review, overwrites that were applied, partly applied or not
      supported, and any parked assets.
- [ ] Fix roles and private-room visibility in the test space, then delete it.
- [ ] Decide which channels hold sensitive talk. Plan to move that talk into **locked
      group chats**, because channels can't be locked.
- [ ] Check the partner's members on Windows or phones know to use the browser.

**Hosted beta only**

- [ ] Ask the operator to raise `OHIYO_REGISTER_LIMIT_PER_HOUR` for migration day, or
      plan sign-up in waves. The default is 10 new accounts an hour per address, and a
      group signing up from one venue or campus network shares one address.
- [ ] Check https://ohiyo.gg/status.html the day before.

**Self-hosted only** (pair with their admin; follow [`DEPLOY.md`](../../../DEPLOY.md))

- [ ] Server runs from `server/Dockerfile` with a volume for `/data`.
- [ ] `JWT_SECRET` and `PUBLIC_BASE_URL` set (the server won't start in release without
      them). `OHIYO_TOTP_KEY` set too, so rotating `JWT_SECRET` later doesn't break
      authenticator codes.
- [ ] Backups on: Litestream (`LITESTREAM_REPLICA_URL`, see
      [`infra/litestream/README.md`](../../../infra/litestream/README.md)) or the host's
      volume snapshots. **Do one test restore.** Losing `/data` is unrecoverable.
- [ ] TURN for calls across the internet (Cloudflare Realtime TURN or
      [`infra/coturn/`](../../../infra/coturn/)). Test a call between two different
      home networks.
- [ ] If they want rooms bigger than about five people: LiveKit from
      [`infra/livekit/`](../../../infra/livekit/), tested with a real multi-person call
      before migration day.
- [ ] `TRUSTED_PROXY_HOPS` set if there's a reverse proxy in front (otherwise every
      client shares one rate-limit bucket).
- [ ] `OHIYO_OPERATOR_USER_IDS` set to their admin's user id if they'll run Discord
      imports or other operator actions.
- [ ] `OHIYO_SERVER_PACK_EXPORT=1` if they want the Server Pack export, and one test
      export downloaded (see [`docs/server-pack-export.md`](../../server-pack-export.md)).
- [ ] The web app (or desktop app) points at their server, and two people can sign up,
      chat and call.

## Migration day

- [ ] Run the template import into the real space (in-app **Import Discord**, or
      `scripts/migrate-discord-template.mjs` from
      [`docs/discord-template-migration.md`](../../discord-template-migration.md)).
- [ ] Re-check roles and private rooms in the import report **before** inviting anyone.
- [ ] Admins sign up first, turn on **two-factor sign-in**, and save their recovery
      codes. There's no email on accounts, so a forgotten password can't be reset by
      email.
- [ ] Create the invite link. The partner posts it to their members, with this note:
  - Sign-up is a username and password. Save the password in a password manager.
  - Turn on two-factor sign-in under Settings → Account.
  - One Ohiyo account per browser profile: use a separate profile for a second account.
  - Turn on the lock in DMs and group chats you want private, and compare safety
    numbers for the ones that matter.
  - Turn on notifications when the browser asks.
- [ ] Pin a "Where we are now" message in the Discord channel that moved, pointing to the
      Ohiyo invite.
- [ ] We stay in the partner channel for the first two hours.

## Days 1–14

- [ ] Day 1: check in. Anyone stuck signing up? Calls working?
- [ ] Day 3: first round of bugs triaged; anything blocking chat or calls is being
      worked on.
- [ ] Day 7: quick message: what's annoying people? Log it.
- [ ] Day 14: count who joined (see [`success-metrics.md`](success-metrics.md)).

## Day 30: check-in call

- [ ] Collect the day-30 numbers.
- [ ] Top three requests written up as GitHub issues (with consent, in their words, not
      naming the community unless they want it named).
- [ ] Ask the "how disappointed" question (see success metrics).
- [ ] Is the scope right? Grow it, keep it, or shrink it.
- [ ] If happy, the referral ask (template in
      [`outreach-templates.md`](outreach-templates.md#referral-ask-day-30-only-to-a-partner-whos-happy)).

## Days 31–89

- [ ] Monthly 30-minute feedback call (optional for them).
- [ ] Tell them what we decided on each of their issues, and why.

## Day 90: review

- [ ] Collect the day-90 numbers and the exit survey.
- [ ] Their choice: **stay**, **move** to their own server (layout rebuilt from a
      template; messages from the hosted beta don't come along), or **leave**.
- [ ] If leaving: the 15-minute exit call. What would have had to be true to stay?
- [ ] If they agreed to founding credit in writing, add them to the list.
- [ ] Delete the partner's notes from the private tracker that we no longer need.

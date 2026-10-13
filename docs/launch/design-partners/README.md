# Ohiyo founding design-partner program

_Drafted 2026-10-13. Status: **not started.** Nobody has been contacted. Nothing here is
sent until the owner signs off on the decisions in "Before the first message" below._

A small, hands-on cohort of real communities that move part of their Discord life to
Ohiyo for 90 days. The maintainers do the migration with them, fix what breaks, and
learn what a community needs before Ohiyo opens up more widely.

This folder is sales and launch material. It changes no product code. In particular it
is **separate from the paid Instant Servers work** (`GO-LIVE.md` §3b,
`docs/hosted-community-cost-model.md`): the program sells nothing, takes no payment and
sets no price. Partners run on the free hosted beta at app.ohiyo.gg or on their own
server.

| File | What it's for |
|---|---|
| [`offer.md`](offer.md) | The founding offer: what partners get, what we ask, what we won't do |
| [`claims.md`](claims.md) | What we may say about privacy and features, and what we must never say. **Read before writing anything to a prospect.** |
| [`prospects.md`](prospects.md) | Community types that fit, publicly identifiable examples, and their public contact routes |
| [`qualification.md`](qualification.md) | The qualification call script and scoring |
| [`migration-pitch.md`](migration-pitch.md) | The migration pitch, by audience, with the honest trade-offs |
| [`outreach-templates.md`](outreach-templates.md) | First message, follow-up, reply, decline and referral templates |
| [`onboarding-checklist.md`](onboarding-checklist.md) | Week-by-week onboarding, from kickoff to the day-90 review |
| [`success-metrics.md`](success-metrics.md) | What we measure, how, without telemetry, and what counts as success |

## The program in one paragraph

Up to **8 communities** of roughly 10–300 people who chat on Discord today and want a
group chat they control. For 90 days each one gets the maintainers' hands-on help:
importing their Discord layout from a server template, choosing between the hosted
beta and self-hosting (with setup help), a private channel with the maintainers, fixes
put first in line, and a monthly feedback call. In return they move at least one real,
active part of their community to Ohiyo for the 90 days, keep a Discord fallback, and
tell us honestly what doesn't work. No payment, no exclusivity, no NDA.

## Who it's for, in one line each

- **Fits:** hackerspaces, Linux/BSD user groups, campus CTF and security clubs,
  digital-rights local groups, self-hosted open-source project communities, small private
  game groups, tech co-ops. See [`prospects.md`](prospects.md).
- **Doesn't fit, and we say so:** anyone who needs anonymity, source protection, or
  end-to-end encrypted *channels*; regulated data (health, legal, student records);
  big voice events on the hosted beta; communities whose members are mostly on phones and
  need native apps. See [`qualification.md`](qualification.md#stop-signals).

## Before the first message (owner decisions)

These are open. The templates use `{{…}}` placeholders where an answer is needed.

1. **A reply address.** Ohiyo has no public contact address today (the site and
   `SECURITY.md` route everything through GitHub, and public issues are wrong for a
   community deciding where to move). Set up a dedicated inbox, for example a
   `partners@` address on ohiyo.gg, and put it in `{{PARTNER_INBOX}}`.
2. **Who sends, and their hours.** One named maintainer (`{{SENDER_NAME}}`) and a
   weekly time budget. The offer promises a reply within **2 business days** in the
   partner channel; cut that if the time isn't there.
3. **Discord history import.** Importing message history uses the managed bot or a
   Discrawl archive, which only operators named in `OHIYO_OPERATOR_USER_IDS` can run,
   and only where it's switched on. Decide whether the maintainers will run it for
   partners. Until then the offer promises **layout import only** (server templates,
   which any signed-in user can run).
4. **Sign-up limit on launch day.** `OHIYO_REGISTER_LIMIT_PER_HOUR` defaults to 10 new
   accounts an hour per address. A hackerspace or campus signing up together from one
   network will hit it. Raise it on the hosted service before a partner's migration day,
   or have them sign up in waves (see the onboarding checklist).
5. **Founding credit wording.** Whether partners can be listed publicly (only with their
   written consent) and where.
6. **Instant Servers.** Out of scope on purpose. If the owner later wants a founding rate
   for the paid plan, offer it separately once the plan is actually sold; nothing in this
   program promises a price, a discount, or a date.

## Ground rules for everyone working the program

- **Don't contact anyone until the owner says go.** Then one message per community,
  through the public organizational route listed in `prospects.md`, and at most one
  follow-up.
- **Organizational contacts only.** Use contact forms, published generic addresses
  (info@, contact@, board@), public forums, or GitHub Discussions. Don't look up, store
  or use individuals' personal email addresses, phone numbers or social accounts. If a
  person gives you their own contact details in a reply, use them for that conversation
  only, and keep them out of this repository.
- **Don't join a prospect's Discord to pitch.** Pitching in someone else's community
  chat is spam, even when the invite is public.
- **Every claim comes from [`claims.md`](claims.md).** If a prospect asks something not
  covered there, the answer is "let me check" and a link to the code, the README or the
  threat model, never a guess.
- **Track prospects outside the repo.** `prospects.md` lists public information only.
  Notes from conversations (who said what, internal details of a community) go in a
  private tracker, not in git.

# Outreach templates

Rules before using any of these:

- **Nothing goes out until the owner approves** the decisions in the
  [README](README.md#before-the-first-message-owner-decisions).
- Send through the community's **public organizational route** from
  [`prospects.md`](prospects.md): a contact form, a published generic address, a public
  forum's "introductions" or "off-topic" category if their rules allow it, or GitHub
  Discussions. Never a DM to an individual, and never a pitch inside their Discord.
- **One first message and at most one follow-up**, 7–10 days apart. No reply means no.
- Personalize the bracketed line from their own public site. If you can't write one true,
  specific sentence about them, don't send.
- Keep the privacy wording exactly as written. It comes from [`claims.md`](claims.md).

Placeholders: `{{COMMUNITY}}`, `{{SPECIFIC}}` (one true sentence about them),
`{{SENDER_NAME}}`, `{{PARTNER_INBOX}}`.

## First message (email or contact form)

**Subject:** A free, hands-on trial of an open-source Discord alternative for {{COMMUNITY}}

> Hi {{COMMUNITY}} folks,
>
> I'm {{SENDER_NAME}}, one of the maintainers of Ohiyo (https://ohiyo.gg), an open-source
> (AGPL) group chat with spaces, channels, roles, voice rooms and screen sharing. You can
> use our hosted beta or run it on your own server.
>
> {{SPECIFIC}} That's why I'm writing: we're looking for up to eight communities to be
> founding design partners for 90 days.
>
> What that means: you move one real part of your community (a project channel, a
> working group, game night) to Ohiyo. We import your Discord layout with you from a
> server template, help you self-host if you want to, and fix what breaks first. Discord
> stays as your fallback. It's free, and there's nothing to sign.
>
> To be upfront about privacy: DMs and group chats can be end-to-end encrypted when you
> turn the lock on, but channels in a space are not, so on our hosted beta our server
> can read them. It's also not anonymous. The details are here:
> https://ohiyo.gg/threat-model.html
>
> If that sounds worth 25 minutes, reply to {{PARTNER_INBOX}} and we'll find a time. If
> not, no need to reply, and I won't send more than one reminder.
>
> Thanks for what you do,
> {{SENDER_NAME}}
> https://github.com/New1Direction/ohiyo

## Short version (public forum post or GitHub Discussion)

Only where the community's rules allow project announcements or offers. Post once.

> **Free 90-day migration help for a few open-source communities**
>
> Hi all, I maintain Ohiyo (https://ohiyo.gg), an AGPL group chat that works like
> Discord (spaces, channels, roles, voice, screen share) and can be self-hosted. We're
> looking for a handful of communities to try it for 90 days with hands-on help: we
> import your Discord layout from a template, help you host it if you'd like, and fix
> what breaks. Free, Discord stays as a fallback.
>
> Honest limits: only DMs and group chats can be end-to-end encrypted (with the lock on),
> channels can't, and it isn't anonymous: https://ohiyo.gg/threat-model.html
>
> If {{COMMUNITY}} is curious, {{PARTNER_INBOX}} reaches me. Mods, feel free to remove
> this if it's off-topic.

## Follow-up (7–10 days later, once)

**Subject:** Re: A free, hands-on trial of an open-source Discord alternative for {{COMMUNITY}}

> Hi again, just bumping this once in case it got buried. If a 90-day trial with
> hands-on migration help would be useful to {{COMMUNITY}}, {{PARTNER_INBOX}} reaches me.
> If the timing's wrong, no reply needed and I won't write again.
>
> {{SENDER_NAME}}

## Reply: they're interested

> Thanks! A 25-minute call is the easiest next step. I'll tell you exactly what Ohiyo
> does and doesn't do, you tell me how {{COMMUNITY}} talks today, and we'll both decide
> if it's a fit. Here are three times: {{TIMES}}. Or send me a few that suit you.
>
> If you want to look around first: https://app.ohiyo.gg (sign-up is a username and
> password) and the self-host guide at
> https://github.com/New1Direction/ohiyo/blob/main/DEPLOY.md

## Reply: summary after a good qualification call

**Subject:** {{COMMUNITY}} × Ohiyo: what we agreed

> Thanks for the call. Here's what we talked about, so you can take it to {{DECIDER}}:
>
> - **What you'd move:** {{SCOPE}} for 90 days, from {{MIGRATION_DATE}}. Discord stays.
> - **Where it runs:** {{HOSTED_OR_SELF_HOSTED}}.
> - **What we do:** import your layout from a Discord server template with you, check
>   roles and private rooms before anyone's invited, {{SELF_HOST_HELP}}, a private
>   channel with the maintainers (reply within 2 business days), and your bugs first.
> - **What you do:** a kickoff, a day-30 and a day-90 call; bug reports; member and
>   activity counts at day 30 and 90 (counts only, never content).
> - **What to know:** channels aren't end-to-end encrypted; only locked DMs and group chats
>   are. No native phone apps (the browser works). Voice rooms on the hosted beta work
>   best under about five people. Message history {{HISTORY_STATUS}}.
>
> Full offer: https://github.com/New1Direction/ohiyo/blob/main/docs/launch/design-partners/offer.md
>
> Reply "yes" and I'll send the kickoff invite.

## Decline: not a fit yet

> Thanks for being so open about how {{COMMUNITY}} works. I don't think Ohiyo is the right
> home for you yet, because {{REASON}}, and I'd rather say so now than have it let you down
> in week three.
>
> {{IF_SAFETY: For what you described, I'd look at SimpleX (https://simplex.chat) or
> Signal (https://signal.org). They're built for exactly that.}}
>
> If you'd like, I'll write once when {{BLOCKER}} changes. Otherwise, thanks again, and
> good luck with everything.

## Referral ask (day 30, only to a partner who's happy)

> Glad it's working. If there's another community you think would fit (similar size,
> text-first, keen on owning their chat), would you be willing to pass on our first
> message to them? Please don't share anyone's contact details with us. Just forward it,
> and they can reach out if they're interested.

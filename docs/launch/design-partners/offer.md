# The founding offer

Short version for a prospect:

> Move one real part of your community to Ohiyo for 90 days. We do the migration with
> you, help you self-host if you want to, answer in a private channel within two
> business days, and put your bugs first in line. It's free, you keep Discord as a
> fallback, and you can stop whenever you like.

## Cohort

- **Size:** up to 8 communities in the first cohort. Fewer is fine; more than 8 is more
  than two volunteer maintainers can support well.
- **Length:** 90 days from each partner's migration day.
- **Start:** rolling, once the owner decisions in the [README](README.md#before-the-first-message-owner-decisions)
  are made. Target the first migration day no earlier than two weeks after the first
  yes, so there's time for the kickoff and a dry run.
- **Cost:** none. The program takes no payment and sets no price for anything.

## What a founding partner gets

1. **A done-with-you migration.** A 45-minute call where we import your layout from a
   Discord server template together, then go through the import report: roles that need
   review, channel permission overwrites that were applied or couldn't be, and which
   rooms are private. You invite members only after that check.
2. **Your choice of home, with help either way.**
   - *Hosted beta* at app.ohiyo.gg: nothing to run. Channels are readable by the hosted
     server, as with most chat apps.
   - *Your own server*: we pair with your admin on a deploy from
     [`DEPLOY.md`](../../../DEPLOY.md) (a container, one database file, a volume), including
     backups and a TURN relay for calls, and check it with you before migration day.
3. **A private partner channel** in a space shared with the maintainers. We reply within
   **2 business days** (it's a volunteer project; we'll say so if that slips).
4. **Fixes first in line.** Bugs you report get triaged before others. A bug that stops
   your community from chatting or calling gets worked on the same or next business day.
   We'll tell you plainly when something is a limit, not a bug.
5. **A say in the roadmap.** A 30-minute feedback call each month. Your top three
   requests are written up as public GitHub issues (in your words, with your consent and
   without naming your community unless you want it named), and we tell you what we
   decided and why.
6. **Founding credit, only if you want it.** With your written permission, your
   community's name on a founding-communities list. No logo, quote or case study without
   a separate yes.

### What's a maybe, and we'll tell you before migration day

- **Discord message history.** Template import brings the layout, not messages.
  Importing history needs the maintainers to run an operator-only import. We'll confirm
  whether we can do it for you before your migration day, not after.

## What we ask of a founding partner

1. **One real, active part of your community on Ohiyo for 90 days.** A working group, a
   project channel, game nights, the board's chat: something people actually use each
   week. Moving everything isn't required.
2. **A named contact.** One person (by role; we don't need personal details beyond how
   they choose to reach us) who can make decisions and relay feedback.
3. **Three conversations.** Kickoff, a day-30 check-in, and a day-90 review, each about
   30 minutes. The monthly feedback calls are optional extras.
4. **Bug reports.** In the partner channel or on GitHub, as they happen.
5. **Counts, not content.** At day 30 and day 90, the numbers in
   [`success-metrics.md`](success-metrics.md): members, active members, rough message
   volume. On your own server we give you the query; on the hosted beta we compute the
   same counts only if you say yes. We never look at content for this.
6. **An honest goodbye, if it comes to that.** If you go back to Discord, a 15-minute
   call about why. That's the most useful thing you can give us.

## What we won't do

- Charge you, or turn this into a trial that ends in a bill.
- Ask for exclusivity. Keep Discord running alongside for as long as you want.
- Ask for an NDA, a logo or a testimonial as a condition.
- Read your channels for research. (On the hosted beta the server *can* read channels;
  if that's not acceptable for your group, self-host.)
- Join your community's other chats, or contact your members directly.
- Promise anything the product doesn't do today. See [`claims.md`](claims.md).

## When the program ends

At day 90 each partner picks one:

- **Stay** on the hosted beta, or on their own server, with the normal level of support.
- **Move** from the hosted beta to their own server. We help set it up and rebuild the
  layout from a template. Messages don't come along: there's no tool today that copies
  one space out of the shared hosted beta, so say this at kickoff, not at day 90.
- **Leave**, after the exit call. If they self-hosted, their data is already theirs.

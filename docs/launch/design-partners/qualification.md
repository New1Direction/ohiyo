# Qualification call

A 25-minute video or voice call with the community's contact, after they've replied yes
to the first message. The goal is a clear yes or no for **both** sides. Saying "Ohiyo
isn't right for you yet" early is a good outcome: a partner who leaves at week 3 costs
more than one who never starts.

Keep notes in the private tracker, not in this repo. Don't record the call unless they
agree first.

## Before the call (5 minutes)

- Re-read their public site: what they do, how big they look, where they chat today.
- Re-read [`claims.md`](claims.md).
- Have the [threat model](https://ohiyo.gg/threat-model.html) open to share.

## Script

**1. Open (2 min)**

> "Thanks for making time. I'll be quick: I want to understand how your community talks
> today, tell you honestly what Ohiyo does and doesn't do, and then we'll both decide
> whether a 90-day trial makes sense. It's completely fine if the answer is no."

**2. Their community (8 min)**

Ask, and listen. Score each answer in the table below.

1. "Roughly how many people are in your Discord, and how many are active in a normal
   week?"
2. "What do you use it for? Which channels would you miss most?"
3. "How much do you use voice? How many people are in a room on a busy night?"
4. "What made you open our message? What's bothering you about where you are now?"
5. "Who decides where the community chats? Is that you, a board, a vote?"
6. "Does anyone on your side run servers? Would you want to host this yourselves?"
7. "How do your members mostly join: computer, phone, both? Any Windows-only crowd?"
8. "Is there anything in your chats that's sensitive: health, legal, members under 18,
   people who'd be at risk if they were identified?"

**3. Honest fit (8 min)**

Say all of this, every time, even if they seem keen:

> "Three things up front. First, the lock: DMs and group chats can be end-to-end
> encrypted when you turn it on, but **channels in a space are not**. On our hosted beta
> our server can read channels, like most chat apps. If you run your own server, it's
> your box that can read them, not us.
>
> Second, it's not anonymous. The server still sees who's in a space, who talks to whom
> and when. If anyone in your group needs real anonymity, SimpleX or Signal are the
> right tools, and we'll say that to their face.
>
> Third, it's a beta. No native phone apps yet, voice rooms on the hosted beta are best
> under about five people, and we bring over your Discord layout, not your message
> history, unless we confirm otherwise before you move."

Then ask: **"Knowing that, is it still worth trying?"**

**4. The offer (4 min)**

Walk through [`offer.md`](offer.md): what they get, the ask (one real part of the
community for 90 days, Discord stays as a fallback), and that it's free with no strings.

**5. Close (3 min)**

- If it's a fit: "I'll send a short written summary and two migration-day options. You
  take it to whoever decides." Agree the next step and date.
- If it's not: say why, plainly, and offer to keep them posted on the specific thing
  that blocked it (for example native apps or bigger voice rooms) if they want.

## Scoring

Score each row 0, 1 or 2. **Any stop signal ends it**, whatever the score.

| | 0 | 1 | 2 |
|---|---|---|---|
| **Size** | Under 10, or over 1,000 members | 300–1,000, or under 10 active a week | 10–300 members, 10+ active a week |
| **Pain** | Happy where they are | Vague unease | A named problem: data control, platform risk, ads/upsells, wanting to self-host |
| **Decision-maker** | Unclear who decides | Decider known, not on the call | On the call, or a board meeting already booked |
| **Technical capacity** | Nobody technical | Comfortable with settings and roles | Someone who can run a container and read logs |
| **Usage fit** | Voice-first with big rooms, or phone-only | Mixed | Text-first, or small voice rooms; computers or phone browsers |
| **Privacy expectations** | Expects E2EE channels or anonymity | Unsure until explained, then OK | Understands the channel/lock split and is fine with it |
| **Feedback willingness** | Won't do calls | One call | Kickoff, day 30, day 90, and bug reports |

- **11–14:** strong fit. Offer a migration date.
- **8–10:** fit with care. Name the weak rows in the summary and agree how to handle them
  (for example: self-host to get LiveKit for bigger rooms).
- **Under 8:** not now. Decline kindly (template in
  [`outreach-templates.md`](outreach-templates.md#decline-not-a-fit-yet)).

## Stop signals

End the qualification, kindly, if any of these is true:

- They need **anonymity**, source protection, or safety from a well-resourced adversary
  (activist or journalist security, people at risk if identified). Refer them to SimpleX
  or Signal.
- They need **channels** (not just DMs and group chats) to be end-to-end encrypted.
- They'd put **regulated data** in it: health records, legal case files, student
  records, payment data. Ohiyo has no compliance programme.
- The community is **for children**, or most members are under 18. A beta with no
  dedicated child-safety tooling isn't the right home.
- They need **native iOS or Android apps**, or a native Windows app, for most members.
- They run **regular voice events with more than five people** and won't self-host.
- They can't keep Discord as a **fallback** during the 90 days.
- They want an **SLA**, invoices, or a contract.

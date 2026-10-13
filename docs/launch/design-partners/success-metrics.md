# Success metrics

Ohiyo has no telemetry, and this program doesn't add any. Every number below comes from
one of three places, and we say which:

- **Self-report**: the partner tells us.
- **Count query**: aggregate counts from the partner's database. On their own server,
  their admin runs the query below and sends us the output. On the hosted beta, an
  operator runs the same query **only for that partner's space and only with the
  partner's written yes**. Counts only: the query never selects message content, names
  or ids.
- **Our records**: bugs, issues and response times in the partner channel and on GitHub.

## Program goals (first cohort)

| Goal | Target | Source |
|---|---|---|
| Partners who start (migration day happens) | 5 of up to 8 | Our records |
| Partners still active on Ohiyo at day 90 | 3 or more | Count query |
| Partners who'd be "very disappointed" to lose Ohiyo at day 90 | 40% or more of active partners | Self-report |
| Partners who refer another community | 2 or more | Our records |
| Partners who misunderstood what's encrypted | **0** | Day-30 check (below) |

The last row matters most. A partner who thinks their channels are end-to-end encrypted
is a failure of this program, however well everything else went.

## Per-partner measures

### Baseline at kickoff

Self-report, from the partner's Discord (or wherever they are now):

- Members in the part of the community that's moving.
- Roughly how many post in a normal week.
- Roughly how many messages a week (an order of magnitude is enough: 10s, 100s, 1,000s).
- How often voice is used, and the typical room size.

### Activation (days 0–14)

| Measure | Healthy | Source |
|---|---|---|
| Time from kickoff to migration day | ≤ 21 days | Our records |
| Template import done without hand fixes beyond the review | Yes | Our records |
| Share of invited members who joined by day 14 | ≥ 60% | Count query vs. baseline |
| Members who couldn't sign up or get in | 0 left stuck by day 3 | Self-report |

### Engagement (day 30 and day 90)

| Measure | Healthy | Source |
|---|---|---|
| Weekly posters on Ohiyo ÷ weekly posters at baseline | ≥ 50% at day 30, ≥ 70% at day 90 | Count query vs. baseline |
| Messages per week, compared with baseline | Same order of magnitude | Count query vs. baseline |
| Voice used in the last two weeks (if they used voice before) | Yes | Self-report |
| The moved part still runs mainly on Ohiyo, not back on Discord | Yes | Self-report |

### Quality (whole 90 days)

| Measure | Healthy | Source |
|---|---|---|
| First reply in the partner channel | ≤ 2 business days, every time | Our records |
| Bugs that stopped chat or calls, open more than 5 business days | 0 | GitHub |
| Calls that failed to connect, as the partner saw it | "Rare" at day 30 | Self-report |
| Partner requests turned into public issues with a decision | All of the top three | GitHub |

### Privacy understanding (day 30)

Ask the contact, and two members they choose, three questions. They pass if all three
are right.

1. "If you post in a channel in your space, can the server that runs Ohiyo read it?"
   (Yes. On the hosted beta that's us; on their own server, whoever runs it.)
2. "When is a DM end-to-end encrypted?" (Only once someone turns on the lock.)
3. "Does Ohiyo hide who is in your space, or who talks to whom?" (No.)

Anyone who gets one wrong: explain it again, then check whether the in-app wording or
our onboarding message caused the confusion, and file an issue if so.

## Day-90 survey (self-report, 5 questions)

1. "How would you feel if you could no longer use Ohiyo?" Very disappointed / Somewhat
   disappointed / Not disappointed.
2. "What's the main thing Ohiyo does better than what you used before?"
3. "What's the one thing that nearly made you leave?"
4. "Will you keep using it after the program?" Stay / Move to our own server / Leave.
5. "Would you recommend it to a community like yours?" Yes / Not yet / No, and why.

## Count query

For a partner's own server. It reads only counts and the space's name. Run it with the
`sqlite3` command-line tool against a **copy** of the database, never the live file:

```bash
sqlite3 ohiyo-copy.db < docs/launch/design-partners/partner-counts.sql
```

The query is in [`partner-counts.sql`](partner-counts.sql). It prints, per space:
members, members who joined in the last 14 days, people who posted in channels in the
last 7 days, and channel messages in the last 7 days. DMs and group chats aren't
counted at all: they aren't part of any space, and they're none of our business.
Webhook accounts aren't counted as people.

On the hosted beta, the operator adds `WHERE s.id = '<the partner's space id>'` above
the `ORDER BY` line, so the output covers that one space and nothing else.

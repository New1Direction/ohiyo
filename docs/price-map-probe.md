# Kikka Price Map — probe specification

Status: proposed implementation contract, not a shipped capability. The current
Burrow pilot has no live browser, regional ImOrb provisioning, account access,
payment, or monitoring integration. This document and `price-map-benchmark.json`
define what those integrations must prove. They do not enable them.

## The first experience

“Can I pay less for this?” → **Checking prices…** → a saved world price map.

Show the current plan alongside prices from at least five distinct, successfully
observed countries. Start with US, GB, DE, BR, IN and JP: six attempted countries,
not a promise that every service sells in all six. Show blocked or unavailable
countries in gray with a short reason. Never make up a fifth observation to
complete the map. A partial result is useful, but must say “3 of 6 checked.”

The map is an overview, not the only control. Its accessible companion is a
sortable table: country, original price, price in your currency, billing period,
what is included, and **View evidence**. Clicking a country opens the same detail.
Use familiar buttons: **Check again**, **Compare plans**, **Open site**, **Stop**.
Do not add a model selector, skill picker, environment setup or risk score wizard.

Ask for the service and plan only when missing. Let the user choose their home
currency and comparison period; default to 12 months. Accept a voluntarily
entered current bill without requesting an account connection. Never scan Ohiyo
conversations, inboxes or bank accounts to populate it.

The first release is read-only. No signup, login, cancellation, checkout,
subscription, purchase or payment submission. The useful result is the price map
and its evidence, not an unimplemented **Save money** button.

## One durable task, isolated country probes

The host owns the task, observations, permissions and evidence. ImOrb adapters
own provision/pause/resume/stop and execution receipts; do not build another
execution framework. The adapter contract must be verified against the actual
ImOrb API before implementation; no endpoint names are assumed here.

1. Save the service's official entry URL, exact plan definition, countries,
   currency, comparison horizon and a task version. Check URLs and redirects
   against the official-service allowlist and browser network policy. Block
   local/private network destinations; page instructions never expand access.
2. Start one fresh browser profile per country in a region-capable workspace.
   No user cookies, credentials, storage, extensions or copied session snapshots.
   At most two probes run concurrently in the initial release; each has a
   120-second deadline. These are proposed product limits, not ImOrb facts.
3. Record the actual observed egress country, requested country, locale and
   service-selected storefront separately. A language selector, URL suffix,
   timezone or currency setting does not prove regional network location.
   A mismatched or unverifiable egress location cannot pass as a regional probe.
4. Open public pricing pages. Capture rendered price, visible terms and plan
   attributes. An official public pricing API may supplement the page, but is
   labeled with its own source and is not proof of a clean-browser observation.
   Do not defeat access challenges or claim they are successful checks.
5. Save evidence before extracting structured observations. Validate amounts,
   currency, period and evidence references deterministically. A model may
   extract text; its confidence is not a price verification signal.
6. Normalize only comparable observations. Preserve failed probes beside
   successful ones. Publish a partial map as observations arrive; finalize once
   every probe is observed, blocked, unavailable, failed, timed out or stopped.

Country probe states: `queued → checking → observed | blocked | unavailable |
failed | timed_out | stopped`. Task states: `working`, `waiting_for_you`,
`ready`, `partial`, `failed`, `stopped`. Here `ready` means the requested read-only
comparison exists, not a purchase or verified saving. Resumption does not erase
earlier evidence. Stop invalidates the task version so late results cannot be
published. Refresh creates a new snapshot; it never overwrites price history.
Retry is explicit, uses a fresh profile and retains the failed attempt and cost.

## Observation contract

Every observation needs the following fields; unknown values remain null with a
reason. Evidence is owner-scoped, not a public screenshot URL.

| Group | Required contents |
| --- | --- |
| Identity | task/version, probe/attempt ID, service, requested/observed country, storefront country, locale, UTC observation time |
| Product | official plan ID or source label, tier, features, seats, household restrictions, student/new-customer requirements, web vs app-store channel |
| Money | original decimal amount string, ISO currency, actual billing period, amount due now if observed, one-time fees, tax inclusion, intro and renewal prices/durations |
| Provenance | final official URL, source type, page title, capture time, screenshot and relevant text/terms evidence IDs, execution receipt ID |
| Comparison | home currency, horizon, FX rate/direction/source/time, known total or estimated total/range, missing inputs, comparability and eligibility reasons |
| Outcome | terminal probe state and reason, including unavailable, access challenge, wrong region, stale evidence or missing price |

Retain originals: “₹149 per month” and its screenshot must survive normalization.
Never interpret a currency symbol alone as an ISO currency. Ambiguous `$` needs
official page context or remains unranked. An annual “per month” advertisement
must be captured with the actual annual commitment and due-now amount.

Evidence is untrusted content. Escape extracted text; never execute page-provided
scripts in the host or obey instructions found on a page. Restrict evidence access
by owner on every read. Redact personal/payment details before display or export;
redaction failure blocks export. Use disposable accounts for later test flows.
Delete workspace profiles after the probe; retain only the authorized result and
its evidence. Proposed default evidence lifetime: 30 days, shown before starting,
with immediate user deletion. Saved map rows show when their evidence has expired.

## Normalize without manufacturing certainty

- Use decimal or integer-money arithmetic, never binary floating point. Respect
  each currency's minor-unit precision; do not assume every currency has cents.
  Retain FX precision through the calculation, rounding only final display values
  to the home currency's minor unit, with half-up rounding for estimates. Preserve
  an observed invoice's own rounding rather than recomputing its settled charge.
  A converted price is an estimate, not a card issuer's guaranteed settlement amount.
- Use one named FX snapshot for the entire map, with explicit direction:
  `home_units_per_local_unit`. No mixing rates from separate observation times.
  The proposed freshness window is 24 hours for both prices and FX. A stale row
  remains visible but is excluded from a current-price recommendation.
- Normalize the cost over the chosen horizon. For 12 months, a monthly plan is
  12 payments; an annual plan is its annual commitment, not 12 annual payments.
  Display annual cash due now separately from the monthly equivalent.
- Separate an introductory period from renewal. For one free month followed by
  11 payments of 10, first-year cost is 110, not zero or 120. If renewal is unknown,
  the first-year total is unknown. Non-month/year periods need an explicit dated
  billing schedule; do not approximate four weeks as a calendar month.
- Tax included means do not add it again. Tax excluded can become an estimate
  only when the applicable rate and taxable basis are explicitly supplied by an
  authoritative source for the actual jurisdiction. If the location-dependent
  checkout tax is unknown, show “before tax” and exclude it from cheapest-total
  claims. Do not guess a billing address or a nationwide rate.
- Add known compulsory fees to the same horizon. Payment FX charges, discounts
  and refunds need their own evidence; unknown fees stay unknown. List prices,
  calculated estimates and observed checkout totals remain distinct.
- Match features, seats, billing channel and eligibility before ranking. Two
  same-named plans are not necessarily equivalent. Never divide family pricing
  by six unless six eligible participating people are actually part of the brief.
  A bundle overlap is a potential saving only if removing the duplicate preserves
  the user's needed features and has a known effect on their other bundle costs.

Rank comparable, fresh, known-total options by horizon cost after known compulsory
charges. Ties remain ties. Keep three different conclusions visible:

1. **Lowest observed price** — evidence of a price, not permission to buy it.
2. **Could save** — a comparable estimate versus the supplied current plan;
   identify missing tax, payment or eligibility information.
3. **Available to you** — eligibility is actually supported by account/official
   terms evidence. Region alone cannot establish this, and V0 does not log in.

Do not collapse these into a fictional “92% feasible” score. Payment methods,
billing country, residency, student status and household restrictions have
`confirmed`, `not_eligible` or `unknown` findings with evidence. Do not invent a
location, address, student identity, card or household to make a plan eligible.

## A visible price is not a completed saving

Follow-on features share the same task and evidence model, but need separate
execution and consent work:

| Feature | Useful output and boundary |
| --- | --- |
| Full price stack | Compare monthly/annual, duo/family/student, carrier/card bundles, promos and gift cards with actual eligibility, expiry, stacking and refund rules. Do not assume offers combine. |
| Retention hunter | User explicitly authorizes entering a specified account's cancel flow. Capture offer, renewal terms and expiry; accepting or cancelling is a separate approved action. No offer is itself a useful result. |
| Switch | Confirm new plan and migration, report what could not move, then separately approve old-plan cancellation. If there is an overlap period, price and disclose it rather than promising zero double billing. |
| Watch | User selects what to watch, frequency and expiry. Notify with one concrete action. A one-word reply binds to one unexpired offer and its exact terms; ambiguous replies ask which offer. |
| Recovery | A cancellation or failed payment becomes **Needs you** unless a still-valid mandate explicitly covers recovery, service, spend cap and retry count. A fresh purchase is never an unlimited automatic retry. |

Learned service playbooks are versioned, untrusted candidates: source evidence,
service/region, flow version, last validation, allowed actions and stop conditions.
They contain no cookies or credentials. Review and sandbox-replay before activation.
A changed page invalidates the affected steps. A saved skill never grants approval
or acquires new tools. It must not click a final cancellation button merely to
discover whether an offer exists behind it.

Use brokered connected-account credentials, never secrets pasted into chat or
included in model context. The human alone approves consequential actions. An
approval binds account, action, plan, price/currency, renewal terms, expiry and
task version. Changed terms require a new approval. Record an action ID before
submission; after a timeout, reconcile actual account state before retrying.

## Savings ledger and the “what works” table

Keep **Potential yearly savings** apart from **Saved so far**. A price probe only
affects the former. With the user's confirmed baseline and actual billing
evidence, realized savings for a closed period are baseline charges avoided minus
actual charges, plus confirmed refunds. Include migration costs, fees and overlap
in those charges exactly once; do not add them again if already included in a
bill. Refunds must not also be netted out of charges. Negative periods remain
negative. Do not count hypothetical student/family eligibility, unsettled refunds
or a discounted annual commitment as twelve months of realized savings on day one.
A trial's future annualized saving is not realized; an elapsed free month can
count only against an evidenced charge actually avoided. Never count the same
service-period twice across tasks.

Every ledger entry references its baseline, period, currency, action, before/after
evidence and any correction. Rebuys and reversals update the total; they are not
hidden. Public marketing totals require explicit sharing consent and distinguish
realized savings from annualized estimates. Do not publish private screenshots.

Track signup completion, payment confirmation and 30/60/90-day active status as
separate, timestamped observations. Schedule follow-ups only with user consent.
An account is `unknown`, not “survived,” if a follow-up cannot access it. Report
cohort, denominator, age, failures, unknowns and uncertainty; never invent a success
percentage from a single signup. Do not publish an aggregate “what works” table
before privacy review and an adequate disclosed sample. No cross-user credentials
or raw account histories are training material for playbooks.

## Delivery order and acceptance

1. **Contract and benchmark (this change):** review before wiring paid services.
2. **Read-only price map:** actual regional ImOrb adapter, persistent observations,
   evidence storage/access control, normalization, table/map UI and partial states.
   Five real country observations, matched plan and manually checked evidence are
   required for the first full-map demo. Country failures remain visible.
3. **Travel reuse:** same provenance and normalization, different domain contract:
   identical stay dates, guests/children, room, cancellation and meal terms, local
   fees and final availability. Stop before committing a reservation/payment.
4. **Price-stack and retention pilot:** one reviewed service flow at a time, then
   music, video, storage, software and AI-plan coverage. Establish real offers and
   explicit consent before accepting anything.
5. **Switch, watch, recovery and ledger:** approval reconciliation and idempotency
   before any auto-recovery. Longitudinal evidence before survival claims.

`price-map-benchmark.json` defines 30 acceptance tasks, not executed results. Run
deterministic normalization/state/evidence fixtures every build once a runner
exists. Run public read-only live probes separately with a cost cap and a
same-time manual reference check. Account flows use disposable sandbox services
and test payments, never real customer cancellation/signup on every build.

Report exact source-field agreement, comparable-cost error, eligibility false
positives, evidence completeness, unauthorized/duplicate action count, coverage,
time to first/final result and compute cost. Unknown and blocked outcomes stay in
coverage denominators. Target zero false claims, unauthorized actions, duplicate
charges and owner-scope leaks. A fixture pass cannot establish live price accuracy
or service compatibility. Thirty-, sixty- and ninety-day outcomes are delayed
cohorts, not something a build can instantly test.

Score each task pass only when every listed criterion has evidence. Missing
evidence is a failure; an unavailable integration is **not run**, never a pass.
Report passed/failed/not-run out of all 30 alongside results by delivery stage.
No weighted average can offset an unauthorized action or evidence-access leak.
Normalization fixtures require exact expected amounts after specified rounding.
Live price scoring requires exact original amount, currency, billing period,
tier and tax wording against a manual capture within ten minutes; a page that
changed between captures is disputed and must be rechecked, not scored correct.
Report converted estimate error separately using the same FX snapshot. Record
first/final-result latency and total workspace/model cost even for failed tasks;
show sample count with any median or percentile. Survival metrics use dated
cohorts separately from this 30-task acceptance score.

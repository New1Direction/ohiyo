# Typed Duffel Stays slice

This is an internal Rust capability library, not an enabled travel workflow. It
starts from the transferred `burrow-kikka-checkpoint` provider-audit baseline,
not `origin/main`. Pi Durable remains the only execution owner. No routes, model
tools, browser integration, scheduler, result-publisher changes, or live account
operations are enabled by this slice.

## Files and ownership

- `server/src/api/burrow/travel/mod.rs`: normalized contracts and deterministic policy.
- `server/src/api/burrow/travel/duffel.rs`: Duffel v2 HTTP adapter and injected HTTP seam.
- `server/src/api/burrow/travel/ledger.rs`: scoped transaction, spend and evidence journal.
- `server/migrations/0066_burrow_travel.sql`: additive SQLite tables, immutable mandates.
- `server/src/api/burrow.rs`: only `pub mod travel` registration.
- `server/tests/burrow_travel.rs`: disposable SQLite + typed HTTP fixtures.
- `server/examples/duffel_probe.rs`: opt-in, non-purchasing account probe.
- This document.

The source thread owns browser-engine, crawl4ai-engine, hotel-research and browser
wiring. None is a dependency of this library. Browser Materials are advisory
research, never inventory, payment authority or an executable booking request.

## Contracts for later wiring

`Scope` is **host-authenticated** account/workspace/task/root_goal identity. Resolve
it from the existing Pi bridge and Burrow admission, never model arguments. Every
ledger entry point validates it against task ownership, the admitted run's root
goal and its account-owned workspace. The workspace is an authorization ID, not
a live computer/ImOrb dependency. Losing a computer does not delete these records.

Trusted Burrow settings/admission calls `record_mandate` and `record_profile`.
Do not expose these, `resume_reconciliation`, `SpendBoundary`, raw `Stays::create`,
raw `Http`, profiles or raw evidence as model tools. Model-facing calls must use
`TravelLedger`; return normalized quotes/results rather than serializing its
internal `TransactionData` (which includes traveler PII).

`Mandate` versions append; SQLite rejects updates. Each transaction pins an exact
ID/version before its research. Another version never widens that transaction.
The maximum is total liability: provider total **plus mandatory property fees**.
No FX, date, room or guest substitutions are allowed. Property substitutions stay
inside the exact city/country and optional property allowlist; an empty allowlist
permits any property in that city. Rating is an optional minimum; preferences are
ranking hints only. More precise geographic bounds require a later mandate
version/contract extension, not inference from a browser's coordinates.

Traveler profiles contain given_name, family_name, email, E.164 phone and born_on,
separate from conversation. Begin snapshots owner-scoped profile IDs, requires a
profile per guest and checks age/type. Payload names/contact values come from
those snapshots. Stays does not require born_on in the booking payload. Missing
loyalty membership, unknown monetary liabilities or unsupported funding fails
closed rather than fabricating fields. V1 does not support loyalty-only rates.

Call sequence available to the later **Pi-owned** orchestration:

1. Store the mandate version and profiles through authenticated Burrow admission.
2. `begin` once per task/root goal; a provisional selection reason may describe
   the trip requirements before research.
3. Research with existing tools and scoped Materials; call typed `search`, then
   `rates`. Only policy-compliant normalized rate options are returned for ranking.
4. `record_selection` saves the ranking reason/tradeoffs and optional research
   price; it cannot change authorization. `quote` obtains and stores a fresh,
   policy-checked provider quote for the chosen rate.
5. `book` rechecks policy and the trusted `SpendBoundary`, atomically reserves
   spending and persists the dispatch fence, then calls create once. An expired
   stored quote is refreshed automatically for its rate and checked again.
6. A successful create is **not** completion: GET the stored booking ID and verify
   the property, room/rate, dates, guests, guest email, currency, exact total,
   property fees, cancellation timeline, payment type, confirmed status/time.
7. `BookingResult` includes transaction/evidence identity, scope, mandate version,
   hotel/location, dates, room/rate, guests, final quote, verified booking, original
   research price and same-currency difference, selection reason and timestamps.
   Publish it through Burrow's existing revision/proposal/manual-edit rules. This
   slice deliberately does not write `burrow_tasks.result` or change memory.

Keep existing cumulative **model** budgets/approvals and Pi uncertainty handling
unchanged. A travel mandate is separate spending authority; a model-cost approval,
memory preference, advisory Material or a new request ID is not a travel mandate.
The unique task and root-goal fences reject a second transaction even under a new
mandate version or run. V1 supports one accommodation booking per task, not a cart.

## Durable transaction and spend behavior

```text
researching -> quoting -> quoted
                |          |
      re-quote on error      +-- atomic spend reservation + dispatch fence
                           v
                   booking_dispatched
                     |           |
         proven failure           success/possible write/crash
                     v           v
             booking_failed   booking_uncertain -> reconciling -> completed
                     |                              |             |
         explicit fresh quote                      +-- uncertain --+
          ONLY after safe 503                       |
                                             bounded/ambiguous
                                                   v
                                      unresolved_needs_attention
```

The spend row is `reserved` before create, `committed` only with verified booking
evidence, `released` only for a documented non-booked rejection. Holds survive
Stop, 500/502/504, timeout, malformed success, 202 and lost futures/processes.
Restart before the dispatch fence is safe to resume; restart after it is always
reconciliation, even if the actual socket write never happened. SQLite compare-
and-set fences prevent concurrent calls and stale quote responses from replacing
newer selection/dispatch state.

Stop blocks research/quote/new booking, checks existing Pi Stop commands at the
dispatch transaction, and marks the ledger stopped. Pi should also cancel an
active safe read future and browser work through their existing owners. Never
drop/replay a consequential write to simulate cancellation. A possible booking
after Stop is still reconciled and may produce a saved confirmation; Stop does
not cancel a real hotel reservation. This module never controls a browser.

Reconciliation uses a known booking ID when available; otherwise it scans up to
20 cursor pages of organization bookings. A fingerprint is persisted before
dispatch: property, room/rate, dates, guest email, exact amount/currency and
dispatch time (matching confirmation window: dispatch −60s through the end of
the active reconciliation window). A resumed read-only window can recognize a
late confirmation without authorizing another create. Definitive list matches
also require both persisted opaque transaction/request IDs in provider metadata.
A similar fingerprint without metadata, multiple matches, cursor truncation or
inconsistent verification is not proof. Incomplete scans do not complete a booking.
An empty list **never** proves absence or authorizes another create.

The Pi caller must invoke `reconcile` at `reconcile_next_at`, including after
restart, and surface unresolved state. Automatic reads are limited to six
attempts, at least 30 seconds apart, within a 15-minute window. A crashed read is
counted before dispatch. Expiry is evaluated on the next reconciliation call;
there is no second background task owner here. An operator may explicitly open
another bounded read-only window with `resume_reconciliation`, preserving evidence,
Stop and the spend hold. No manual method to declare absence/reset a create fence
is provided without authoritative provider evidence.

Raw operation responses and provider/correlation IDs are retained in owner-scoped
evidence. Organization-wide list responses are **not** copied into an account's
receipts: only this transaction's matching records, page metadata and counts are
saved. List parsing is conservative; an unparseable booking in a page prevents a
definitive scan and needs support, not a retry. Treat provider text/HTML as untrusted
display content. Existing task/account foreign keys intentionally prevent deleting
referenced transaction evidence; retention/account-erasure policy needs explicit
integration before exposing this slice in production.

## Authoritative Duffel findings (inspected 2026-10-21)

Sources fetched directly from Duffel's current rendered docs and embedded schemas:

- [Getting started with Stays](https://duffel.com/docs/guides/getting-started-with-stays)
  requires requesting Stays access and creating an access token.
- [Search](https://duffel.com/docs/api/v2/search/stays-search):
  `POST /stays/search`; search_result_id is distinct from accommodation ID. Search
  room/rate details may be incomplete; cheapest-rate pricing is not a booking quote.
- [All rates](https://duffel.com/docs/api/v2/search-result/fetch-all-rates):
  `POST /stays/search_results/{id}/actions/fetch_all_rates`.
- [Quotes](https://duffel.com/docs/api/v2/quotes/create-quote):
  `POST /stays/quotes` with rate_id; confirms availability and final pricing.
  Current quote schema has no top-level expires_at. Use selected rate.expires_at
  and a conservative local 120-second freshness cap; this is **Burrow policy**,
  not a claim of a provider quote-validity guarantee. Expired/unavailable rates
  must re-quote/reselect; no stale research price can authorize create.
- [Create](https://duffel.com/docs/api/v2/bookings/create-booking),
  [retrieve](https://duffel.com/docs/api/v2/bookings/get-booking),
  [list](https://duffel.com/docs/api/v2/bookings/list-bookings).
  Required booking fields: quote_id, guests' names, email, phone_number. Metadata
  supports opaque string key/value correlation. No suitable **idempotency
  guarantee** was documented for the inspected Stays operations. None is assumed.
- [Request IDs](https://duffel.com/docs/api/overview/making-requests/request-id):
  x-request-id is provider evidence; x-client-correlation-id is client correlation,
  **not** idempotency. Persist both; transport retries and redirects are disabled.
- [Booking response handling](https://duffel.com/docs/api/overview/response-handling/order-and-booking-creation):
  202 is not retryable; unexpected 500/502 requires support/request ID. The detailed
  **503** guidance explicitly guarantees no supplier booking and permits later
  retry. Burrow accepts that only with a provider request ID and error envelope,
  via failed -> explicit fresh quote -> new dispatch. It does not generalize that
  guarantee to 504. Fraud 422 high_fraud_risk is final; this ledger blocks re-quote
  or reselection bypass of that rejection.
- Payment: current create docs say balance-funded bookings omit `payment`;
  card-funded bookings require payment/3DS. Rate payment_type can be pay_now,
  deposit or guarantee. **V1 only supports balance + pay_now.** Fees due at the
  property are not included in provider total and may use another currency;
  unknown amounts or currency mismatch fail closed. The schema says string[] for
  available_payment_methods but published examples use string[][]; the adapter
  recognizes explicit balance entries in both, never infers balance support.
- [Cancellation](https://duffel.com/docs/api/v2/bookings/cancel-booking) is a
  supported consequential `POST /stays/bookings/{id}/actions/cancel`. It is not
  needed for fixture verification or the non-purchasing probe and is deliberately
  not exposed without a cancellation mandate/outbox. Stop is not cancellation.

`SpendRequest` separates purpose, amount/currency, merchant capability,
spend-capability ID, quote, mandate/version and complete scope. `SpendBoundary`
is side-effect-free; `PrefundedDuffelBalance` binds account/capability configuration.
It is **not** a balance top-up, MPP/Tempo implementation or proof that funds exist.
No working MPP/Tempo rail was found in the baseline. A future funding write needs
its own durable dispatch/evidence/uncertainty journal before any HTTP call.

Balance must be available when Duffel accepts the booking. A confirmed retrieval
is evidence of a balance-funded booking, not an independent settlement receipt.
The exact balance debit/settlement timing, commercial activation, fees and account
capabilities must be confirmed with the actual account/Duffel before live booking.
If future external funding is uncertain while a booking succeeds, keep that
funding hold unresolved, record the booking, and reconcile each write separately;
never charge or book again to repair a lost acknowledgement.

## Tests and controlled live acceptance

```sh
cargo test --manifest-path server/Cargo.toml --test burrow_travel
```

Fixtures cover search/rates filtering; successful quote/create/GET verification;
both prices and fee liability; mandate budget, dates/guest/location/refund/FX
checks; immutable pinned versions; stored traveler identity; account/workspace
isolation; same/changed-price refresh, over-budget refresh and disappeared rate;
explicit rejected create vs 202/500/502/504/malformed success/transport uncertainty;
pre-dispatch restart, lost response, concurrent dispatch and stale quote fences;
fingerprint+metadata success, ambiguous/absent/partial pagination, deadlines and
attempt limits; operator read-only reconciliation resume; Stop before/during quote
and after dispatch; confirmed booking with changed terms; saved-result reopening.
Browser Stop/computer-loss behavior belongs to the unchanged source worker tests.

Prepared opt-in probe (not executed by normal tests):

```sh
# Configure DUFFEL_ACCESS_TOKEN privately; do not paste it into a thread/log.
# mandate.json uses the Mandate contract; pass intended destination coordinates.
cargo run --manifest-path server/Cargo.toml --example duffel_probe -- /path/to/mandate.json 51.5071 -0.1416
```

It searches, retrieves rates, policy-filters, makes a quote, prints the normalized
quote/request IDs and probes the booking list without printing other customers'
data. It has **no create-booking, cancellation, funding or database calls**.
Failures report the HTTP status, provider error evidence and the strongest stage
reached. A successful probe does not prove write permission or live booking enablement.

No live API acceptance, purchase, charge, reservation, deployment or shared SQLite
mutation has been performed. Missing prerequisites: privately provisioned test/live
token, Stays activation, actual booking-create entitlement/commercial approval,
account funding confirmation, authorized traveler profiles and mandate, and later
Pi/Materials/result-revision wiring. Before one real autonomous booking, run the
non-purchasing probe with that account, confirm these capabilities with Duffel,
integrate those existing Burrow admission/result surfaces, and obtain explicit
authorization for the narrowly scoped real booking. Do not infer approval from
passing fixtures, credentials being present, or a completed research Material.

## Executed verification

- `cargo test --manifest-path server/Cargo.toml`: 583 passed, 0 failed.
- `cargo test --manifest-path server/Cargo.toml --no-default-features`: 583 passed,
  0 failed.
- Final `--test burrow_travel` reruns with and without default features after the
  guest-name verification and late-confirmation changes: 17 passed each, 0 failed.
- Unchanged `server/worker` suite, `npm test`: 77 passed, 0 failed on full rerun.
  An earlier Chromium launch timeout was followed by a passing isolated browser
  recheck and the passing full rerun; no worker files were changed.
- `rustfmt --check` on the new Rust files and `git diff --check`: clean.
- Running the probe with its token explicitly unset stops with
  `missing DUFFEL_ACCESS_TOKEN` before reading the mandate or making a request.

Only disposable test databases were migrated. No live Duffel request was made;
the actual token is absent and account activation/payment permissions remain
unverified. The slice is not mounted as model tools or a UI and is not deployed.

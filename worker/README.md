# Kikka task worker

One actual Pi Durable agent loop, behind Burrow's existing runtime boundary.
No second agent loop runs inside its optional computer. The legacy ImOrb task
bridge remains separate; Pi can now attach an ImOrb resource through the
[versioned ComputerProvider contract](COMPUTERS.md). Browser/desktop engines
remain unavailable until installed and explicitly authorized.

## Project knowledge pilot (API-first)

See [architecture mapping and API contract](../docs/burrow-thinkrail.md).
`allow_project_knowledge: true` in the server's agent approval adds exactly
`read_project_spec` and `propose_project_change` to a non-travel project run.
It is immutable and off by default, including for previously saved runs. Coding
may explicitly add these two tools; approval/test/install are never model tools.
Proposals enter the existing durable event stream under the Pi tool task ID;
server reconciliation binds them to the authenticated task's account/project.
The approved spec is part of current explicit context, refreshed at admission and
human follow-up, not live-resynchronized into an in-flight model call.

The private host-only `skill_test` command validates guidance JSON in a fixed
Node child process. **This optional operation requires Node 26+**; older workers
fail closed without changing the existing Pi runtime's minimum version. It has
an empty environment, no filesystem/network/child-process permissions, a 32 MiB
V8 heap limit, a three-second deadline and a 1 KiB output cap. These are defense
in depth for a fixed validator, not a security boundary for executing hostile JS:
candidate instructions are parsed as text and are NEVER evaluated. Tests check
structure and actual permission denial, not skill usefulness or model behavior.
No package fetch, model call, skill activation or tool change occurs. The server
requires human approval then a separate explicit one-shot test request. Lost
acknowledgements cannot retry; rollback revokes the candidate, not past effects.

## Repository coding pilot

Burrow's **Code repository** action saves `coding: true` intent on an ordinary
document task. It does not start a model or grant shell access. An explicit agent
approval must additionally bind `coding: true`, an owned `computer_workspace`,
the selected model route and the existing cumulative budget. Coding defaults to
the general role. It cannot be combined with comparison, travel or routine tasks.
Saved coding intent survives reload and cannot silently downgrade to research.

The same Pi loop exposes only computer open/reconnect/action tools for coding.
It can inspect and edit files, execute commands, run tests and obtain a Git diff.
Research tasks cannot execute shell commands, even if their computer has a shell
grant. ComputerProvider still authorizes every action and journals it before
dispatch. Nonzero command exits are completed receipts **with failed exit codes**,
not successes or transport failures. Lost acknowledgements remain uncertain and
fence later effects; changing the action ID does not authorize a retry.

Enable `computer.coding.enabled: true` in the private worker configuration and
add `"shell"` to the chosen workspace's `features`, plus `"shell": true` to its
grant. The machine must have Bun, Git and the repository's toolchain installed by
the operator. Shell and file tools share `/orb/state/burrow-computer/files`; put
the disposable repository checkout there. A saved workspace name is **not** proof
of provisioning, repository contents or a ready engine. The new engine runs a
fixed helper via ImOrb resource exec, never commands on the application host and
never a second coding agent inside the computer.

This is a trusted-operator pilot, not a hardened multi-tenant shell service.
Shell authority covers the entire disposable container; the working directory
is not a filesystem sandbox. Provision no personal files, host sockets or secrets
inside it. Child commands get an explicit minimal environment, not model/provider
credentials. Existing upstream isolation and egress policy must enforce network
boundaries; the prompt's no-push/no-deploy instruction is not a network firewall.
Commands have a 45-second deadline, no interactive stdin, and a 64 KiB combined
stdout/stderr cap. Receipts retain argv, exit code, timeout and truncation flags.
Process-group termination is attempted on timeout/completion; Stop fences new
work but cannot prove a disconnected remote process stopped or undo edits.
Background services and durable process handles are not implemented.

Validation uses the actual Pi journal and fixed shell/file helpers with a
scripted model and disposable resource transport: a real Git fixture is read,
its regression check fails, the code is fixed, the same checks pass, and the diff
is returned. Recovery makes no new model calls. This proves plumbing, not model
coding quality, actual container isolation or parity with another coding agent.
No live model, production computer, push or deployment is implied.

## Admitted travel tasks

Trusted admission may include `travel: {workspace_id, mandate_id, mandate_version}`.
IDs are nonempty scope identifiers (letters, digits, `:`, `_`, `-`, at most 160
characters); version is a positive safe integer. Malformed travel admission or
missing trusted transport fails start/recovery rather than falling back to web
research. Travel needs no ComputerProvider, even with a workspace ID.

Configure private `KIKKA_TRAVEL_URL` and `KIKKA_WORKER_TOKEN` (at least 32
characters). Only HTTP `127.0.0.1` at `/api/v1/burrow/internal/travel`, without
URL credentials, query or fragment, is accepted. POST uses bearer authentication,
no redirects or cookies, a 10-second timeout and the Pi tool abort signal.
Embedders may inject `travelTransport(request, {signal} = {})` into KikkaWorker.

Travel exposes only `travel_research {}`, `travel_select {rate_id, reason}`,
`travel_book {}`, `travel_reconcile {}` and `travel_status {}`. Extra arguments
are rejected; identity, mandate/profile, price and funding cannot be supplied by
the model. Requests contain exactly `{owner, task, root_goal, workspace_id,
request_id, operation, args}`. Scope comes from stored admission; tool request IDs
are `pi-` plus SHA-256 of the durable Pi tool task ID. Mandate/version remain in
trusted admission; the backend resolves and fences its admitted mandate by scope.

The backend owns durable research/selection caches and booking dispatch fences:
book reentry must read/reconcile committed dispatch state, never blindly create
again. Authoritative JSON snapshots (`stage`, `reason`, `comparison` with
`options`/`context`, `transaction_id`, `result`, `terminal`, `mode: 'fixture'`,
plus display fields) pass through without adding traveler data. Lost transport
acknowledgement returns nonterminal `stage: 'unknown'`, `acknowledgement_lost:
true` and the same request ID, never invented success or cancellation.

Stop locally fences new travel work, sends `operation: 'stop', args: {}` under
the stable task-scoped request ID `stop`, calls any existing computer stop, then
aborts Pi. `Cancelled` describes the Pi task only: activity explicitly disclaims
external cancellation/rollback, including when stop acknowledgement is lost.
The backend must independently fence Stop. No second task/model owner or change
to ComputerProvider 1.1.0 is introduced; the existing spending gate remains active.

## Runtime decision and recovery contract

Pinned/tested: `@earendil-works/pi-durable`, `pi-ai`, and `chord` **1.3.0**;
`playwright-core` **1.60.0**. The lockfile pins transitive packages. Node must be
at least 22.19.0; local verification used Node 26.10.0 and installed Chromium.

Reviewed the published README (persist/resume, busy conversations, tools, abort,
compaction, models and SQLite examples), types and generation/compaction tasks;
also reviewed [upstream durable examples and source](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable).
This is not the Pi coding CLI or a replacement agent loop.

**Stock recovery is incompatible with Burrow's spending rule.** A persisted
generation `request` or compaction `summarize` checkpoint can dispatch again after
restart, even with retries disabled. Generation hooks alone do not cover
compaction or reliably stop execution when a hook throws.

Smallest adaptation: decorate public `HarnessOptions.models`, below Pi's loop.
Before any provider call, commit a maximum-cost reservation and dispatch intent
to a separate FULL-synchronous SQLite journal. Key it by Pi task/kind/checkpoint
attempt. Save the acknowledged response before returning it to Pi. Recovery may
reuse that response only if its request fingerprint matches. Otherwise pause.
An interrupted call retains its reservation and blocks all new paid work; neither
Stop, resume, retries nor follow-ups clear it. There is deliberately no public
"assume uncharged" or manual retry endpoint. Operator investigation is required.
A conservative fingerprint mismatch (including rebuilt compaction timestamps)
can require review even when no extra charge occurred.

`npm test` includes actual SIGKILL/reopen tests. With a simulated provider,
stock Pi made 1 → 2 calls; the guarded worker stayed at 2 after an interrupted
second call, retained the first browser receipt, and reported Needs you. These
are fault-fixture results, **not live provider billing evidence**.

## Ownership and state

- Burrow authenticates users, authorizes ownership/permissions, admits spending,
  owns customer statuses, saved results, history and the control outbox.
- Pi owns each task's conversation/execution SQLite records. The worker has one
  root conversation per Burrow task, no cross-task model context or memory.
- Runtime identity hashes owner + task + root goal. Pi `requestId` reconciles
  admission and instructions. A directory-level SQLite lease prevents two worker
  schedulers sharing the same files. Admission pins model policy and page URLs.
- Burrow reconciles run/root/target identities and imports sequence-numbered
  events. Unknown admission/control acknowledgements remain paused, not replayed.
- Follow-ups use the same conversation and cumulative budget. Successful new
  results replace the existing document and archive its previous version (up to
  30). Safe reads may retry after a crash; completed tool receipts are reused.
- Stop blocks new work first. Stopping remains until Pi acknowledges cancellation;
  Stopped is not rollback and does not undo a charge already dispatched.

For revisions after a completed answer, Pi's public `beforeRequest` hook projects
older page text to 1,800 characters per receipt. The preceding answer, source
URLs, capture times and evidence IDs remain available; original journals, full
receipts and screenshots are unchanged. Each shortened excerpt states its limit:
missing excerpt content does not establish that a price or offer is absent.
This reduces revision input size; it does not guarantee an upstream quota fit.

Only the configured `KIKKA_USER_ID` can start the single-account pilot. Explicit
`KIKKA_USER_ID=*` enables owner-isolated multi-account Pi operation. Other
authenticated accounts cannot read/control another account's tasks or fetch its screenshots. The private
worker service is not an end-user API: it trusts Burrow and requires a service
token. Do not expose it to browsers or other tenants.

## Public browser boundary

The only tool, `read_public_page`, accepts an **exact operator-approved HTTPS
URL**. DNS is checked and pinned at the actual TLS connection; every redirect
must also be approved and public. Private, loopback, metadata and reserved IP
ranges are denied. Fetches have size, redirect and time limits.

Chromium renders a frozen HTML response at its original URL. JavaScript, all
subresources/network, service workers, downloads, navigation and ambient account
state are blocked. Every read has a fresh isolated browser context; task receipts
and screenshots live under that task's private directory. Page text is explicitly
untrusted data. It cannot add tools, URLs or permissions. No arbitrary JavaScript
evaluation, input, clicks, host-shell tool, sign-in, messages or purchases exist.

This is **regional-page inspection**, not country-located browsers. Dynamic
content, styles or prices may be unavailable. Screenshots capture the initial
viewport, not the entire page; extracted text is bounded to 30,000 characters.
Receipts include source/requested URLs, capture time, text, title, PNG digest,
verification type and limitations. Do not infer checkout/payment eligibility,
tax inclusion or conversion rates from missing evidence. No API is called by
merely saving a task. No watch, takeover or long-term memory is implemented.

This is capability isolation, not a hardened multi-tenant OS sandbox. Run the
worker as a private, minimally privileged service; its process owns the model
key. Worker files are plaintext, not end-to-end encrypted. Account deletion does
not automatically purge these independent files: operators must coordinate
retention/deletion with Burrow. Back up both databases together; do not edit them
while a scheduler is running.

## Role routing (optional, development opt-in)

This follows Amp's [public routing contract](https://ampcode.com/docs/customize/model-routing),
not its private backend: roles select canonical catalog models; the first active
matching personal connection wins, then the ordered Ohiyo-funded connections.
No matching route means no dispatch. A failed connection never falls back.
Ohiyo funding means the operator supplies that connection's credential; this
change does not provision provider credit, charge customers or connect Amp's own
subscriptions. No Amp credentials or internal traces were copied.

The four roles are `general`, `research`, `review` and `summary`. A research task
uses its selected role for generation and tools. Explicit Pi compaction uses
`summary` through the **same** durable spending gate. Selecting `review` does
not launch an extra reviewer. There is still one Pi agent loop.

Operators copy `routing.example.json` to a reviewed private configuration. Add
catalog entries with verified tool support, input/output limits and conservative
upper USD-per-million rates. The example's rates are illustrative configuration,
not a fresh upstream price check. API keys use operator-approved public HTTPS
**OpenAI Chat Completions** endpoints. Account-scoped subscription connections
also use Pi's native Anthropic and ChatGPT Codex Responses adapters; see
[subscription setup and limits](../docs/burrow.md#subscription-connections-and-native-pi-execution).
Arbitrary native API-key endpoints, Gemini and cloud identity are not implemented. General
OpenRouter routing is deliberately unavailable: the earlier pinned free campaign
still requires its original ledger, eligibility checks and privacy confirmation.
OpenCode remains blocked and its anonymous transport is unchanged.

Server configuration, in addition to the Pi service settings below:

```text
KIKKA_ROUTING_CONFIG=<absolute path to reviewed routing JSON>
KIKKA_CONNECTION_KEY=<dedicated stable encryption secret, at least 32 characters>
KIKKA_DEFAULT_API_KEY=<explicit operator credential named by config keyEnv>
```

`keyEnv` is the only source of a funded connection's key. The server never scans
for other provider credentials. Leave `KIKKA_USER_ID` restricted to the authorized
test account unless deliberately opening multi-account operation. Restart the
server after operator configuration changes. Existing startup migrations add
the routing tables; do not run them against shared databases without approval.

Worker configuration:

```text
KIKKA_MODEL_ROUTING=1
KIKKA_ROUTING_ACCESS_URL=http://127.0.0.1:<Burrow API port>/api/v1/burrow/internal/model-access
KIKKA_WORKER_TOKEN=<same private server/worker service token>
KIKKA_WORKER_DIRECTORY=<private persistent directory>
KIKKA_WORKER_CONFIG=<reviewed research JSON with exact approvedUrls>
KIKKA_WORKER_PORT=3102
```

Routed mode needs no ambient `OPENAI_API_KEY`. The worker obtains an explicitly
authorized key for the pinned owner/task/root/role/connection from the private
loopback API immediately before dispatch. It sends that key only to the pinned
HTTPS endpoint, with DNS pinned to public addresses; redirects are forbidden.
Keys never enter admissions, Pi conversations, evidence or model traces. BYOK
is encrypted at rest under `KIKKA_CONNECTION_KEY`, write-only in settings, and
blank edits preserve it. Transport errors that echo the key are redacted.

Keep an existing campaign's `campaignPath` in the reviewed worker configuration
when changing routes or restarting. The original free campaign keeps every
historical attempt at its original path; fixtures use separate disposable state.
Changing a provider is not authorization to reset that campaign or spend money.

To try once a legitimate model route and its budget are authorized: start the
configured private worker and API, open the existing client at `/burrow`, sign
in, and open **Model settings**. Assign role models, optionally add a personal
connection from an approved template, and save. Saving settings makes no model
call. Create a public-research task, review its provider/payer, role and spending
cap, then **Allow & start**. Use **Ask for a revision** on the saved comparison;
**Previous versions** keeps its predecessor. Expand **Pinned model routes** and
**Model requests & usage** to inspect the actual selection and receipts.
The existing preview has not been switched to a live provider by this work.

Mappings use one rule per line: `#` comments, start/end `*` wildcards, leading
`-` exclusions and last matching line wins. Exact includes may use
`canonical/model -> provider-model`. No match excludes the model. Empty personal
mappings inherit the template; empty template mappings include the catalog.
Priority zero runs first; moving a personal connection shifts the others.
Unknown models require operator-reviewed catalog metadata; users cannot override
prices or point credentials at arbitrary hosts. Personal aliases to another
catalog provider-model ID use that target's limits and rates, never the cheaper
canonical name's rates. Other aliases must be explicitly approved in the
operator's template mapping with corresponding conservative catalog rates;
unpriced arbitrary targets are rejected. Operator rates must bound the prices
at every approved endpoint, including its approved aliases.

Approval pins all role routes and their revisions. A stale provider/payer
preview is rejected before starting. Role/settings edits affect new tasks, not
already approved routes. Credential rotation, deactivation or deletion pauses
existing work rather than switching its payer/provider. Operator configuration
revisions are conservative: even an unrelated config edit may require review.
Rotating the private worker token invalidates funded credential revisions;
rotating the BYOK encryption key without re-encryption makes saved keys unusable.

Each call reserves its full input window plus capped output, at the pinned upper
rates. All roles, compaction and revisions consume the same task budget, without
refunds. Unknown outcomes keep their reservation and pause; no automatic retry or
paid fallback exists. Persisted usage identifies role, connection, model, payer,
tokens, retained reservation and **SDK-estimated** cost. Missing usage/cost stays
unavailable, not zero. Estimates are not provider invoices or customer billing.
Provider-side spend limits remain necessary; fleet-wide funding quotas and rate
change detection are not implemented. Accounts cannot read another account's
settings, task controls, usage, events or evidence.

### Routing verification (fixtures, not live inference)

`npm test` covers actual Pi adapter tool calls, research versus summary selection,
aliases/payers, shared budget exhaustion, revocation, Stop during key resolution,
key redaction, redirect/retransmission rejection, revision and restart. Rust HTTP
tests cover encryption, ownership, precedence, stale approval and usage persistence;
client tests cover write-only editing and never dispatch inference from settings.

`test/fixtures/routing-stack.mjs` supports disposable full-stack UI testing with
real Pi, the real credential API and real public Chromium, but **synthetic model
responses** and dummy keys only. It requires `KIKKA_WORKER_DIRECTORY`,
`KIKKA_WORKER_TOKEN` and `KIKKA_ROUTING_ACCESS_URL`. Never use it for customers.
The executed UI scenario saved a result, revised it while retaining version 1,
and restarted both API and worker: inference calls stayed **3 → 3**, with the
same task/runtime, evidence and usage. A second account received 404 for its
task, controls and evidence. These results do not prove live model compatibility,
research quality or provider billing. No paid or OpenRouter inference ran.

## Legacy single-model setup

From `worker/`, `npm ci --ignore-scripts`. Install Chromium separately and set
`KIKKA_CHROMIUM` to its executable, or use the orb's installed agent-browser
Chromium. Keep worker state outside the checkout in a private 0700 directory.

Worker environment (secrets via secure environment configuration, never chat or
tracked files):

```text
OPENAI_API_KEY=<private provider credential>
KIKKA_WORKER_TOKEN=<private random service token, at least 32 characters>
KIKKA_WORKER_DIRECTORY=<absolute private persistent directory>
KIKKA_WORKER_CONFIG=<absolute path to reviewed research.example.json copy>
KIKKA_WORKER_PORT=3102
KIKKA_CHROMIUM=<installed Chromium executable, optional in an orb>
```

Run `npm start` as a supervised private service. It binds 127.0.0.1 only.
On Burrow's server, set:

```text
KIKKA_RUNTIME=pi
KIKKA_WORKER_URL=http://127.0.0.1:3102/command
KIKKA_WORKER_TOKEN=<same private service token>
KIKKA_USER_ID=<authorized existing Ohiyo account id>
```

Restart the server after configuring it. `/burrow` then offers **Research public
pages** next to the existing Continue action. Existing creations and Ohiyo remain
separate. Approve each task and its original 1–50 US-cent model cap in the UI.
Do not enable paid acceptance without an explicitly authorized budget.

The initial provider is deliberately narrow: official OpenAI `gpt-4o-mini`,
SSE, nonreasoning, at most 4096 output tokens, zero SDK/durable retries and no
automatic/background/deferred compaction. Explicit compaction still crosses the
same gate. No paid tools exist. Each request reserves the full 128k input window
plus output cap at configured upper rates: **21,658 microUSD** with the example
policy. Reservations never refund based on SDK usage. A 25-cent task allows at
most 11 such reservations, including revisions; a one-cent task makes zero calls.
These conservative reservations are not actual cost reporting. Operators must
verify the upstream rates and maintain provider-side spend caps: the static
catalog cannot detect an unannounced provider price change. Compute/storage are
outside the model budget. A fleet-wide monetary cap is not implemented.

## Verification and live acceptance

```sh
npm test
# Free, real public pages/Chromium, no model:
node scripts/probe-public.mjs /absolute/private-or-review-output-directory
```

The probe uses Spotify's US, UK, Germany, India and Brazil official pages.
`verification: regional-page-only` is intentional. It does not fulfill the
real-model acceptance criterion. `test/fixtures/public-stack.mjs` runs the actual
worker with a simulated provider and the real browser for disposable full-stack
UI checks. Its results explicitly identify themselves as fixtures; it requires
`KIKKA_WORKER_DIRECTORY`, `KIKKA_WORKER_TOKEN` and optionally the port. A
`hold-browser` file in that directory pauses the second free read for repeatable
restart/steering tests. Never use that entry point for customer work.

**Paid inference remains unauthorized.** The separate Groq Free-plan acceptance
below used genuine inference, not the fixture provider. It does not establish
general research quality, upstream invoice correctness or live-model resistance
to prompt injection. Fault tests are not live billing evidence. No changes have
been pushed or deployed.

## OpenCode free development probe — blocked

On 2026-10-20 the live `/inference/v1/models` catalog listed
`glm-5.3-flash-free`. The [model documentation](https://opencode.ai/v2/docs/console/models)
listed it as temporarily free, with provider zero retention and no model training.
The [inference documentation](https://opencode.ai/v2/docs/console/api/inference/)
said free chat models could be called without Authorization.

The actual unauthenticated POST to
`https://opencode.ai/inference/openai/v1/chat/completions` returned:

```text
403: {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}
```

Stopped after **one model request, zero browser operations**. No model/tool
round trip, comparison, annual revision or live successful-checkpoint restart
was completed. No credentials, OpenCode CLI, impersonation headers, alternate
model/provider or paid fallback were used. Reopening the failed task preserves
Needs you without another request. The response and public-only prompt are in
`.amp/in/artifacts/kikka-opencode/live-probe-rejected.json`; catalog/policy references
are in `provider-check.json`. These are failure evidence, not research results.

The retained experimental `opencode-free.mjs` adapter uses the installed Pi
Chat Completions implementation inside the existing worker/gate. A transport
rebuilds every HTTP request with only Content-Type and Accept, discarding the
SDK's required non-secret sentinel key and all ambient/caller credentials.
It pins the exact model/endpoint, refuses redirects and retransmission, and
allows no paid tools. A persistent `campaign.sqlite` in the worker directory
limits the whole campaign to **30 model attempts and 60 browser operations**,
including probes, follow-ups, compaction and safe-read retries. Failed attempts
consume slots. Cached completed requests/receipts consume no additional slots;
uncertain model attempts are never replayed. Keep this ledger with the task
databases across restarts; deleting it starts a different campaign and is not
authorized by these limits.

Transport-fixture tests prove Pi tool-call parsing, actual tool-result delivery,
completed-response reuse, rejection without SDK/durable retry, and both cap
boundaries across reopen. Existing SIGKILL, Stop, monetary-budget and restricted
Chromium tests still run. **Fixture results do not prove live model compatibility.**

The free route is **not enabled in the server launcher or preview** after this
failed preflight. Existing layout, saved results, authentication and service
configuration are unchanged. Opening `/burrow` still opens the existing pilot,
not a working live free-research route. Resuming this milestone needs an explicitly
authorized, usable direct-inference route; do not substitute the OpenCode CLI
or personal subscription credentials automatically.

## OpenRouter free campaign — historical selection, not the active route

The following records the earlier selection and its privacy gate. No OpenRouter
inference ran. The operator subsequently chose a dedicated Groq Free-plan route;
that change preserved this campaign ledger and did not authorize paid inference.

Selected and pinned on 2026-10-20: `xingchen-agi/xing4.0-29b-a4b:free`,
provider tag `phala`, endpoint name
`Phala | xingchen-agi/xing4.0-29b-a4b-20261015:free`. The direct API is
`https://openrouter.ai/api/v1/chat/completions`. Both the model catalog and the
endpoint report prompt/completion pricing `0`. The endpoint supports `tools`,
`tool_choice: auto`, and `max_tokens`; it does not support required/named tool
choice, which this adapter does not request. It is in OpenRouter's published
ZDR endpoint list and has no implicit prompt caching.

The published Phala policy metadata reports no training, prompt retention,
publication or safety retention. OpenRouter says it does not retain prompts
unless prompt logging is opted into. RedPill's linked policy says TEE-production
prompts and outputs are not retained, but permits six-month IP/header logs.
**Prompt/output ZDR is not zero retention of connection/account metadata.**
Burrow does not verify TEE attestation or assert end-to-end encryption through
OpenRouter. Public catalog evidence and policy references are saved in
`.amp/in/artifacts/kikka-openrouter/provider-check.json`.

`openrouter-free.mjs` uses the installed Pi Chat Completions adapter, not another
agent loop. Its separate transport accepts only an explicitly supplied dedicated
test key and sends its Authorization header only to that exact HTTPS endpoint.
It refuses redirects and retransmissions and discards ambient headers. The
OpenCode anonymous transport is unchanged. Provider errors are redacted before
entering Pi or the trace journal if they echo the dedicated key.

Every request pins `provider.only` and `order` to `phala`, disables fallbacks,
requires supported parameters, enforces `zdr: true`, `data_collection: deny`, and
zero maximum prompt/completion/request/image prices. There are no model lists,
routers, presets, plugins, hosted search tools or paid auxiliary services. Only
the existing restricted `read_public_page` function can be offered as a tool.
Fresh public metadata is checked before each new inference attempt; changing
price, endpoint, tool support or data policy denies dispatch. Saved acknowledged
responses replay without a new provider call or metadata dependency.

OpenRouter workers must receive the **original** `campaignPath`. The pilot's
existing ledger is `/home/user/.local/state/burrow-kikka-free-2026-10-20/campaign.sqlite`.
Missing/empty ledgers fail closed; switching providers does not create a fresh
allowance. The selected route is pinned in this same ledger. At this checkpoint, counts were
**1 model attempt / 0 browser operations**, including the rejected OpenCode
request; at most **29 / 60** remained. Its original error and recovery exports
are preserved, with hashes recorded in `kikka-openrouter/campaign-before.json`.

The dedicated test key was supplied through server-side secret configuration as
`BURROW_OPENROUTER_TEST_KEY`; it has not been used for inference. Do not inspect or reuse other credentials. The
runtime receives it explicitly as `openRouterKey`; it is never part of the
policy, conversation, browser capability, frontend or saved request trace.
Before using it, the operator must confirm that this key's OpenRouter
workspace has **Input & Output Logging**, **OpenRouter Use of Inputs/Outputs**,
and observability exports disabled (or this key explicitly excluded).
The runtime refuses startup without explicit `gatewayPrivacyConfirmed: true`;
this records operator confirmation, not a claim of API-based account verification.
Per-request `provider.zdr` alone does not disable those account opt-ins.
The transport separately sends `X-OpenRouter-Cache: false` to disable gateway
response caching, which is also not disabled by request-level ZDR.
See [logging](https://openrouter.ai/docs/guides/features/input-output-logging),
[data collection](https://openrouter.ai/docs/guides/privacy/data-collection), and
[response caching](https://openrouter.ai/docs/guides/features/response-caching).
No OpenRouter inference has run yet. Actual token usage and upstream cost
receipts are therefore unavailable; catalog price `0` is not an observed receipt.

`npm test` includes transport-fixture coverage of
the installed Pi tool round trip, original counters, cap denial after request
30, acknowledged-response reuse, explicit 403 denial without retry, credential
redaction, and routing/privacy rejection. These are **fixtures, not live model
acceptance**. The original browser/SIGKILL/Stop tests also pass.

This route was not used for the smoke test or later acceptance. The existing
development preview remains separate from the private Groq acceptance stack.
No push or deployment is authorized.

## Groq Free-plan live acceptance — 2026-10-20

The operator supplied a dedicated server-side key and confirmed its account was
on the Free plan with Zero Data Retention enabled for Chat Completions. This is
operator attestation, not independent account-settings or invoice verification.
The reviewed route is `https://api.groq.com/openai/v1/chat/completions`, model
`openai/gpt-oss-120b`, with 4,096 maximum output tokens. All four roles use this
one personal connection, approved Free-plan rates of zero, and a zero-cent task
cap. The paid catalog rates are not zero; paid service and fallback remain
unauthorized. Selection, policy references and qualifications are recorded in
`.amp/in/artifacts/kikka-live/groq-selection.json`. No key is in that export.

The private orb stack used the actual Burrow UI, Rust API, installed Pi Durable
worker, real Groq inference and restricted Chromium captures of Spotify's US,
UK, Germany, India and Brazil pages. One live task saved three results: a US
page answer, a five-country monthly comparison, then an annual-billing revision.
The latter labels 12-times-monthly estimates separately from unknown annual
offers; both earlier results remain in history. Prices and plan names were
checked independently against captured text, not model-generated expectations.

The first five-country task's oversized revision returned HTTP 413 and remains
paused, with its original result and reservation untouched. A separate run read
the US page twice and was stopped with six captured receipts retained. Neither
run was reset or replayed to manufacture a successful result. The revision
projection above was exercised on the completed live task. The acceptance
launcher additionally limited new page excerpts to 3,500 characters, retained
full captures separately, and paced calls 70 seconds apart for Free-plan quotas;
these are test conditions, not a production throughput measurement.

Restarting both private API and worker preserved result/history hashes, all five
evidence PNG hashes, usage and request records. Owner-authenticated evidence
downloads matched the saved hashes. Original uncertain work stayed paused,
stopped work stayed stopped, and campaign counts remained **23 model attempts /
16 browser operations**, including the rejected OpenCode attempt, within the
original **30 / 60** caps. Identical numeric JSON approvals returned the same
run; changed spending, price, payer or endpoint returned 409. A different
account received 404 for task, controls and evidence and 401 from the private
credential resolver with a well-formed request. See `checkpoint-before.json`,
`checkpoint-after.json`, `approval-live.json`, `isolation-final.json` and the
comparison exports in the same artifact directory.

This is one bounded live acceptance campaign, not a reliability benchmark,
production deployment, multi-tenant sandbox validation, regional checkout test,
or evidence of actual annual offers. Paid reservations, crash interruption and
provider-denial edge cases remain covered separately by disposable fault tests.

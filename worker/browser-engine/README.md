# Attach-only browser engine

Private Python sidecar and JS adapter behind the existing ComputerProvider
**1.1.0** host. Pi Durable remains the sole task/model loop. No booking, payment,
clicks, typing, caller JavaScript, browser launch, new context, or shared-browser
shutdown. The canonical contract is imported unchanged.

## Setup and operation

Python 3.11+; run `sh setup.sh` here. This installs pinned crawl4ai 0.9.5,
aiohttp and Playwright libraries, **not** Chromium or another browser stack.
Do not run `crawl4ai-setup` or `playwright install`. The operator must provision
an already-running loopback Chrome CDP endpoint and its existing first context.
The engine creates one tab in that context, preserving its cookies/profile.

Private environment configuration:

* `BURROW_BROWSER_TOKEN_FILE`: private 0600 file, >=32-character random ASCII
  bearer token; every endpoint, including health/status and unknown routes,
  authenticates. Do not put the token in action arguments.
* `BURROW_BROWSER_SCOPE_FILE`: private operator-controlled JSON; exact fields:
  `account`, `workspace_id`, `computer_id` (nonempty strings), `generation`
  (positive integer), `approved_urls`, `read_only_urls`, `egress_origins`.
* `BURROW_BROWSER_CDP_URL`: fixed private configuration such as
  `http://127.0.0.1:9222`; only loopback http(s)/ws(s), never action input.
* `BURROW_BROWSER_EGRESS_ENFORCED=1`: mandatory operator attestation that
  upstream network policy restricts the existing Chrome **and sidecar** to
  the approved HTTPS origins. Without it startup/readiness fails closed.
* `BURROW_BROWSER_PORT`: optional loopback HTTP port, default 8765.

Example scope (fictional domain):

```json
{"account":"a","workspace_id":"w","computer_id":"c","generation":1,
 "approved_urls":["https://hotels.example/shibuya"],
 "read_only_urls":["https://hotels.example/shibuya"],
 "egress_origins":["https://hotels.example"]}
```

Install this directory at `/opt/burrow-browser` in the ImOrb; run `sh setup.sh`
there. The host/provisioner supplies allocation-specific private files at
`/run/burrow-browser/token` and `/run/burrow-browser/scope.json`. The token must
be readable by both the service and the existing ImOrb exec user, not by model
tools. Run `sh run.sh` under the ImOrb's existing supervisor, with CDP and egress
configuration. It stays in the foreground. No server is started by setup
(tests use a temporary in-process HTTP test listener). Do not expose the CDP
endpoint or sidecar publicly. Scope/token files and supervisor config are not
supplied here because they contain allocation-specific private values.

Enable `computer.browser.enabled: true` in the existing private worker config;
grant only the reported browser features and exact task URLs. `server.mjs`
constructs `Crawl4aiEngine({transport: backend})` inside the existing
`ImOrbComputerBackend`. Its fixed Bun relay injects the service token internally;
neither endpoint selection nor credentials are model arguments. Production uses
loopback port 8765; the optional port override is for standalone service tests.
Binding/version mismatches omit all browser capabilities. Ambiguous health
transport errors propagate, never turn into a false `ComputerNotDispatched`.

## HTTP integration

All requests: `Authorization: Bearer <token>`. JSON response bodies are direct
outputs, not ComputerProvider envelopes; the JS host owns dispatch/error
classification and the unchanged public contract.

* `GET /status` (also `/health`): `{state,busy,crawl4ai_version,binding}`.
  State checks the actual CDP connection and owned tab, not just process startup.
* `POST /execute`: `{allocation,identity,action}`. Allocation is exactly the
  four bound fields; identity is exactly `{account,workspace_id,task_id,
  root_goal_id,request_id}`. Action is exactly `{operation,args,replay_class}`;
  navigation defaults to `non_idempotent_effect`. `read_only` navigation also
  requires the exact `read_only_urls` grant, checked independently by Burrow and
  the service. All navigated/read URLs require `approved_urls`. No URL
  normalization, fragments, or wildcard matching.
* `browser.navigate`, args `{url,tab_id?}`: one goto, then capture.
* `browser.read`, args `{tab_id?}`: capture current page without navigation.
* `browser.tabs`, args `{}`: only `[{tab_id:"engine"}]`, never shared tabs.
* `screenshot`, args `{surface:"browser",target?}`: current viewport PNG,
  no navigation; optional target must be `"engine"`. All optional tab IDs
  must also be `"engine"`.
* `POST /cancel`: `{allocation,identity}` exactly matches an existing request.
  Returns `{completed,state,rollback:false}`. Unknown identities reject.

Navigate/read return URL/source URL/time/title/markdown/typed hotel/extraction
and inline markdown + JSON artifacts. Screenshots return URL/source URL/time
and PNG artifact. Artifacts carry exact identity, timestamp, and SHA-256 of
unencoded bytes. All observations are advisory, not availability/price promises.
Missing scalar fields/coords are null; lists are empty; displayed price is
verbatim text, rating is a number (0–10), coordinates use `{lat,lng}`.
Registry list fields use semicolon-separated source text. Layout markers are
not trust signals: page content remains untrusted evidence.

`schemas.py` chooses CSS, then XPath, using direct local crawl4ai extractors.
Markdown first removes navigation/footer chrome, applies `PruningContentFilterLXML`,
then `BM25ContentFilter` with the query **price, room, cancellation, address, rating**.
Commas are normalized before BM25 because 0.9.5 tokenizes on whitespace. Short
headings/addresses and adjacent label/value blocks are retained. On short pages
with no positive BM25 scores, only pruned content is used, never the original
unfiltered page. An empty prune remains empty. `DefaultMarkdownGenerator` converts
only these selected HTML blocks; output includes filtering strategy and byte counts.
No `AsyncWebCrawler` lifecycle is used (v0.9.5
starts its browser even for raw input). Unknown layouts return `llm_required`
and evidence for the **existing Pi loop** to interpret; this service never
invokes a model. Three fictional Shibuya fixtures exercise all paths.

## Research operations and Materials

These names describe compositions of the **existing** contract, not new engine
operations or a parallel interface:

| Research action | Canonical operation | Replay class |
| --- | --- | --- |
| `fetch_page(url)` | `browser.navigate({url})` returns markdown, final URL and timestamp | Non-idempotent by default; read-only only with a known-safe host grant |
| `extract_hotel(url)` | Same navigation/capture returns normalized hotel JSON; unknown layouts return `llm_required` | Same navigation rule |
| Current-page extraction/read | `browser.read({tab_id?})` | Read-only |
| Current-page screenshot | `screenshot({surface:"browser",target?})` | Read-only |
| Screenshot of URL | Navigate, then screenshot with its own request ID | Each step keeps its own class |
| `batch_fetch(urls)` | Host `batchFetch()` calls separate navigations with durable per-URL IDs | Each URL keeps its class; uncertainty stops effects |

Pi's `research_hotels` tool composes batches plus screenshots. Acknowledged HTTP
errors produce per-URL `failed` results and do not prevent other pages. An
uncertain effect instead stops the batch and reports pending URLs. Cancellation
returns completed/uncertain results plus pending URLs; it never promises rollback.

When no CSS/XPath schema matches, Pi interprets the saved markdown in its normal
next budgeted generation and calls `save_hotel_research`. That tool accepts only
an unknown-layout Material from the same task, validates typed fields and adds
host-owned source/time/advisory metadata. It cannot overwrite a schema result or
assert a booking price. There is no hidden LLM extraction call in the ImOrb.
The schema set covers the two saved example layouts plus standard schema.org
`Hotel` and `LodgingBusiness` microdata (visible fields or `content` attributes).
Standard layouts require one entity, a name and address. Multiple rates without
an explicit price range remain unknown rather than selecting a random rate.
This is fixture-tested standards support, not live-qualified OTA coverage.

Unknown layouts emit a private structured stderr event `hotel_schema_fallback`
with domain and all five identity fields, never full URLs, HTML or credentials.
Their Material extraction metadata also includes `fallback_domain`. Cached
duplicates do not log another fallback. No production traffic exists yet to rank
real domains; no fabricated Booking/Expedia selectors are installed. Query each
owned task journal below and aggregate its counts by domain, then capture/review
fixtures for the highest-frequency domains before adding site-specific schemas:

```sql
SELECT json_extract(data,'$.extraction.fallback_domain') AS domain,
       count(*) AS actions
FROM events
WHERE type='material' AND json_extract(data,'$.identity.account') = :owner
  AND json_extract(data,'$.kind') = 'markdown'
  AND json_extract(data,'$.extraction.path') = 'llm_required'
GROUP BY domain ORDER BY actions DESC;
```

`KikkaWorker` owns artifact storage: task-local evidence receipts/files and atomic
`material`/`evidence` events in its existing SQLite journal. The existing Rust
agent bridge persists these events and checks task ownership when returning them;
PNG bytes use its existing evidence route. No new storage service, schema migration
or Materials UI is introduced. Replayed committed captures republish the same
Material IDs, not fresh browser actions. Every Material carries all five identity
fields, source URL, fetched time and `advisory:true`. Compare research only; the
transaction path must use fresh Duffel quotes and the separate spend ledger.
Pi's batch result returns filtered markdown once per page and small Material
references, not repeated page bodies in each receipt. Full Material contents
remain available in Burrow; fallback extraction still resolves its saved ID.

**Additive proposal, not implemented:** a future `browser.extract` capability and
`browser.extract({tab_id?,schema_id:"hotel_v1"})` operation, read-only on the
current page, returning this normalized extraction contract. URL-based extraction
would still compose navigation separately. It needs provider-owner approval and
a contract minor version (deferred to 1.2.0); 1.1.0 does not advertise it. Batch stays host composition.

## Fail-closed limits and operational constraints

* One concurrent operation. Duplicate completed identities return cached
  output; mismatched terms, in-flight, failed and cancelled identities reject
  without redispatch. Live-process journal retains up to 1024 identities and
  approximately 32 MiB cached output (one output may cross that threshold).
  No durable dedup: replacement must use a **new generation**; host owns
  restart recovery and must never retry uncertain actions automatically.
* Cancellation/errors close only the engine-owned tab and fail readiness;
  replace the service/allocation before more work. This stops local work but
  cannot undo network requests or establish that Chrome aborted before an
  effect. Never maps an interruption to `ComputerNotDispatched`.
* Request 64 KiB; HTML and each fetched resource 2 MiB; markdown/hotel JSON
  30,000 bytes each; PNG 3,000,000 bytes; serialized output 7,000,000 bytes;
  title 4 KiB. Browser/resource
  bodies are capped **after buffering**; upstream must enforce response-size
  and process memory/CPU budgets too. Operation timeout 30 s, goto 15 s,
  browser/resource calls 10 s, failure tab-close 5 s. Local bounded HTML
  processors are synchronous; hostile CPU-heavy HTML requires supervisor
  CPU/wall-time enforcement. No retries, model calls, or redispatch.
* HTTP/subresource requests use explicit allowlisted HTTPS origins and
  GET/HEAD only; document/frame navigation additionally requires exact URLs.
  **All HTTP redirects are conservatively rejected**, including approved
  redirects, to avoid Playwright redirect-routing gaps. Host may explicitly
  navigate to an approved destination. WebSockets are always rejected.
  Unsupported protocols are denied wherever interception is available.
* Browser interception alone is NOT a network sandbox (existing sockets,
  service workers, non-network schemes, browser internals, DNS rebinding).
  Existing service workers cause startup rejection. Use an exclusive,
  single-account existing context/profile, no other automation/extensions,
  and upstream egress policy before attachment; pre-existing traffic cannot
  be retroactively intercepted. Context routing affects other shared tabs;
  only engine-owned tab data is returned. Never attach another account's
  profile. WebSocket routing has no removal API; disconnect/replacement is
  required to reset it. Shared browser itself is never closed.
* An authenticated 400 means invalid/policy/unresolved; 409 interruption;
  503 operational failure. Errors intentionally omit page/secret details and
  never assert rollback or nondispatch. Host must classify conservatively.

## Verification

From this directory:

```sh
sh setup.sh
.venv/bin/python -m unittest -v test_engine
.venv/bin/python -m pip check
```

Tests use mocked CDP/page objects but **real installed crawl4ai 0.9.5** markdown,
CSS and XPath processors on saved fixtures. They do not launch or install a
browser, attach to a live shared orb, or prove operator network isolation.

Executed on 2026-10-21: Python suite **22 passed**, `pip check` passed; full worker
`npm test` **82 passed, 0 failed/skipped**. From `worker/`, reproduce the real Pi
fixture demo with actual Python engine/processors (no public network/model):

```sh
BURROW_BROWSER_REAL_PROCESSORS=1 node --test --test-name-pattern='Pi fixture demo' test/crawl4ai-engine.test.mjs
```

Result: **1 passed**; three fictional Shibuya pages, CSS/XPath/Pi fallback,
three screenshot artifacts and ten Materials total; simulated transport loss,
reconnect and worker reopen preserve the same Pi task and cumulative ledger.
Screenshot bytes and model responses are explicitly fixtures, not live captures
or a live-model quality evaluation. An optional `BURROW_BROWSER_DEMO_PATH` writes
the run/receipt/Material JSON for inspection.

The boilerplate-heavy saved-page check reduced markdown from **10,141 to 140
bytes (98.62%)**, retaining the hotel name, address, literal price, room and
cancellation text. This is a synthetic fixture measurement, not a live-site claim.

### Local ImOrb host and real provider qualification

The earlier orbd/Docker blocker is resolved in this disposable orb. Built
`/tmp/burrow-imorb-source` at pinned revision
`15762f1c0e8d29504ed18fff390be60b6b60ded2` with
`CARGO_TARGET_DIR=/tmp/imorb-qualification-target cargo build --locked --bin orbd`.
Docker **29.9.1** runs under the supervised `imorb-qualification-docker` service;
`imorb-qualification-portals` and `imorb-qualification-egress` are also supervised.
Private host state is `/tmp/imorb-qualification-home`; no public portal is exposed.
This is qualification setup, not a deployment or a committed production provisioner.

Use absolute binary `/tmp/imorb-qualification-target/debug/orbd`, transport command
`['env','PATH=/tmp/imorb-qualification-bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin',binary]`
and `dockerCommand:['/usr/bin/sudo','-n','/usr/bin/docker']`. The PATH wrapper uses
sudo for the private Docker socket; no socket permissions/group membership were
weakened. Existing unrelated services were not changed.

Real provider run: one actual Pi Durable task provisioned an ImOrb, wrote/read
files, survived real `host stop`/reconnect, read the committed file, and continued
after a deliberately discarded acknowledgement of another real file write.
The uncertain effect stayed fenced under a new request ID; observation confirmed
the file was not overwritten. Worker close/reopen retained the completed task.
Account/workspace attachment checks rejected foreign identities, releasing a peer
task retained the shared computer, and advancing the idle clock released the
actual container. Ten supported acceptance checks passed. Live view and external
replacement-state reattachment remain explicitly unsupported, not counted as passes.
Model responses were deterministic fixtures; the Pi runtime, orbd transport and
Docker file operations were real. Evidence: `.amp/in/artifacts/imorb-provider-live-qualification.json`.

**Browser live qualification is blocked, not passed.** The base provisioner lacks
Python/Chrome. A separate disposable allocation was bootstrapped with Python
**3.13.5**, Chromium **155.0.8059.79**, sandbox helper, this sidecar and all pinned
dependencies; `pip check` passed. Private scope/token files were installed and
the temporary package-install egress grant was revoked. Normal Chromium launched
through ImOrb's service manager then aborted with namespace `EPERM`;
`unshare -Ur true` independently failed. No `--no-sandbox`, privileged mode or
security-policy relaxation was attempted. No sidecar or live browser demo ran.

Required ImOrb/provisioner work, without changing ComputerProvider 1.1.0:

* A tested browser sandbox profile that permits Chromium's required namespaces
  without broad privileged mode or disabling its sandbox. Select it at computer
  provisioning, e.g. `create({sandbox_profile:"chromium-tested-v1"})`.
* Exact HTTPS-origin grants, e.g. `egress.grant({origins:["https://www.tokyuhotels.co.jp"],match:"exact",ttl_seconds:1800})`.
  Pinned `egress.rs::allowed` instead authorizes exact **or suffix** hosts.
* Host-owned browser proxy credential injection, e.g. a private credential handle
  consumed by the browser connector. The audited gateway requires runtime Basic
  credentials; Chromium's proxy address flag alone does not supply them. Never
  pass raw credentials to Pi or place them in a service command.
* Private authenticated/exec health probes, e.g. `readiness:{exec:["bun","/opt/burrow-browser/health.mjs"]}`
  with credentials read locally. Pinned `orbservices.rs::probe` instead sends an
  unauthenticated HTTP request to the container IP; it cannot qualify loopback
  CDP or this authenticated loopback sidecar.

These are resource/integration proposals, not implemented APIs. The sidecar's
`BURROW_BROWSER_EGRESS_ENFORCED=1` attestation was deliberately **not** set.
The blocked bootstrap allocation was released through ComputerProvider; no owned
qualification containers remain. Host Docker/egress/portal services remain up.
Evidence: `.amp/in/artifacts/imorb-browser-bootstrap.json`.

Next travel-comparison integration: consume these owner-scoped JSON Materials
with source IDs/timestamps, prefer the `pi_llm` revision over its `llm_required`
placeholder, and keep all displayed prices advisory. Resolve the chosen hotel
against Duffel inventory and obtain a fresh typed quote before mandate/spend checks.

## Files in this browser slice

```text
worker/src/crawl4ai-engine.mjs
worker/src/hotel-research.mjs
worker/src/runtime.mjs
worker/src/server.mjs
worker/test/crawl4ai-engine.test.mjs
worker/test/fixtures/browser-service.mjs
worker/test/fixtures/python-browser-service.mjs
worker/test/fixtures/python-browser-service.py
worker/browser-engine/.gitignore
worker/browser-engine/README.md
worker/browser-engine/requirements.txt
worker/browser-engine/setup.sh
worker/browser-engine/run.sh
worker/browser-engine/relay.mjs
worker/browser-engine/service.py
worker/browser-engine/schemas.py
worker/browser-engine/test_engine.py
worker/browser-engine/fixtures/css.html
worker/browser-engine/fixtures/xpath.html
worker/browser-engine/fixtures/unknown.html
```

The ComputerProvider audit is committed separately from this browser slice.

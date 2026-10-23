# Burrow pilot

Open `/burrow` in the existing browser client. `/` remains Ohiyo. Burrow is an
explicit experimental surface, not a change to Ohiyo chat or encryption.

Prompt composers use Enter to send and Shift+Enter for a new line. Ctrl/⌘ Enter
also sends. IME composition and repeated Enter key events never send; empty, busy or
disconnected prompts cannot bypass the disabled submit button. Saved-document
editors keep normal multiline input and explicit Save actions.

## Backgrounds

The small coloured dot beside Motion cycles nine looks: Ember, Neural bloom,
Rainbow terrain, Dot mandala, Particle orbit, ASCII orbit, Paper dither swirl,
Paper dotted aurora, and Quiet (no backdrop). The choice stays in this browser's
local storage; it is not account data. Enter and Space also activate the dot.
Motion pauses animation, reduced-motion users get still frames, and hidden tabs
and open tasks stop the animation loops. Backgrounds never capture clicks or
change a task. The abstract patterns are decoration, not live AI activity.

The small colour ring beside the pattern dot cycles Original, Peach, Mint, Blue,
Lilac and Rose on each click (or Enter/Space), without a menu. Colour stays
independent of the pattern and is remembered locally. Palettes apply to the
background, sidebar, inputs, buttons and generated-page accents together; error
and success colours keep their meaning. Original restores the page's own theme.
A soft colour pulse expands from the button as the palette changes. It never
blocks input. Paused/reduced motion and browsers without Web Animations switch
without a pulse. Repeated taps restart the pulse and apply every colour step.
Changing colour never replaces a draft or resets page progress.

The original canvas sketches take visual inspiration from the
[Teknium demo collection](https://webdev.teknium.io/). The two Paper looks use
[@paper-design/shaders](https://shaders.paper.design), pinned to 0.0.82 and loaded
only when selected. They require WebGL2; unavailable WebGL falls back to orbital
dots. No remote textures or scripts are fetched. Paper's Apache-2.0 license and
NOTICE ship under `/licenses/paper-shaders/`.

## Kikka’s presence and voice

Kikka’s reply shows actual work, unsaved edits that need you, and paused changes.
The small presence indicator follows those states; it does not infer emotions or
claim she is listening. Reduced-motion preferences disable its animation.

**Read aloud** is optional and off until clicked for each reply. It only reads
Kikka’s visible reply, not the whole tracker or draft. The browser must report an
on-device English voice (`localService: true`); remote and unspecified voices are
never a fallback. Without one, the reply stays readable and the button explains
why voice is unavailable. No microphone, camera, or screen capture is requested.

**Stop talking**, Escape, or typing stops speech without changing the task or
discarding text. New replies, revision changes, leaving the task, and hiding the
tab also cancel playback. A stopped voice never automatically restarts. This is
read-aloud presentation, not conversational voice input or background speech.

## Make an interactive page

The home screen now starts with an open request and three explicitly labelled
ready-made examples: an ideal spring experiment with a three-question check,
a harbour mystery with four endings, and a web-request journey with empty/fresh
DNS-cache scenarios. Examples work without a configured service and are never
presented as newly generated work. Previously saved pages still open unchanged.

New requests create owner-scoped **creations** and open a full-width conversation
with the composer at the bottom. **Preview** toggles the page beside the
conversation on wide screens, or switches panes on smaller screens. Existing
pages open with their preview visible. Hiding either pane preserves the unsent
draft and temporary preview progress; leaving the creation or replacing its page
still resets preview progress.

**Make it** approves one generation attempt; **Send** approves one revision.
The destination and possible cost are disclosed beside the composer. The service
receives only the original request, current page and latest instruction, not
Ohiyo conversations or other tasks. Saving a request alone makes no service call.

This uses `@json-render/core` and `@json-render/react`: the model composes a
declarative page from 15 trusted React controls and layouts, not a fixed template.
Supported parts include quizzes with scoring, branching stories, checklists,
tables, charts, figures, cards and expandable explanations. `SpringLab` and
`RequestJourney` are fixed, subject-specific controls with empty props, not
general-purpose simulation engines. They make no network/model calls; the spring
shows ideal static equilibrium, and the request journey is not a live trace.
Their preview state is temporary, like quiz answers. No model-authored
HTML, JavaScript, expressions, network actions, remote images or events execute.
React escapes text. Both client and server validate the shared strict schema,
connected layout, answer indices, story targets and table dimensions. Pages cap
at 80 parts, depth 12 and 64 KiB of response text. To change the catalog, edit
`client/src/burrow/catalog.ts` and run `bun scripts/burrow-catalog.ts` from the
repository root. A contract test catches schema drift.

Pages appear after generation completes; this is not token-by-token streaming.
Natural-language revisions keep the last page usable while work runs. Invalid
responses and failed attempts preserve it. **Stop** prevents late completion
from replacing it, but does not guarantee cancellation of upstream billing.
**Undo** restores the last saved page without another service call; the last
30 successful revisions are retained. Version checks reject stale changes.

The page definition and conversation survive reloads. Quiz answers, story
position and checklist ticks are temporary preview state, not persisted user
data. The preview states this explicitly. **Checks** reports structural
validation only, not fact-checking, live research or proof of every interaction.
Nothing is published, sent, booked or purchased. General application generation,
free-form scripts, live browsing and external integrations are not enabled.

## Task-specific craft

Creations now use a bounded selection call before drafting. The selector receives
only the original request, latest instruction and current page title/description.
It chooses one of four reviewed identifiers, not a filesystem path or internet
skill. Generation receives the common `designing-burrow-pages` skill and, when
applicable, `teaching-from-material`, `comparing-real-options` or
`crafting-interactive-stories`. These are original, version-controlled `SKILL.md`
files in `.agents/skills/`, embedded at compile time. Editing one requires a
server rebuild/restart. Skills do not run scripts, install dependencies, fetch
references or expand permissions. There is no keyword router or user-facing
skill picker. Malformed or unsupported selections fail without changing the page.

Each skill gives a concrete workflow, examples of good and bad choices, missing
information rules, and a task-specific self-review. Self-review is guidance, not
an independent quality verdict. The original structural validator still runs.
Stop during selection prevents the subsequent generation call; Stop after that
call starts still cannot guarantee upstream cancellation or prevent its charge.

Research used these public sources for workflow ideas; their text and scripts
are not vendored into these original skills:

- [Anthropic frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design): subject-specific composition and critique.
- [Anthropic skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator): evidence-backed grading and blind baseline comparisons.
- [Vercel agent-skills](https://github.com/vercel-labs/agent-skills): focused rules with meaningful incorrect/correct examples.
- [Superpowers verification-before-completion](https://github.com/obra/superpowers/tree/main/skills/verification-before-completion): separate claims from observed evidence.

Do not assume a public GitHub file is licensed for reuse. In particular, the
reviewed Anthropic document skills have restrictive per-directory licenses.
Check each license before importing code, prompts or assets; do not bulk-install
unknown skills or their bundled servers into the production runtime.

### Project authoring skills

The project also includes pinned source repositories for **Anatomy**, **Archify**,
**Learn Anything**, **Emil Kowalski's skills** and **Impeccable**, with discoverable
entry points in `.agents/skills/`. See the [authoring skill guide](../.agents/skills/README.md)
for setup, upstream licenses and side-effect restrictions. Impeccable is used in
guidance-only mode; no engine, hooks or telemetry are enabled.

These help developers build and review examples and components. They do not add
runtime skill identifiers or enable arbitrary generated HTML/scripts. Installing
them alone does not change bundled examples. The new spring bench, web-request
journey and practice questions apply their authoring guidance in trusted controls
and example JSON. No upstream renderer code is bundled in these components.
The production router still uses only the four skills above. Other rich figures
need a reviewed component or an explicitly designed isolated renderer before
they can be offered inside a creation. Server Survival is a learning-design
reference, not a bundled game or dependency.

### Output-quality evaluation is separate from tests

`docs/burrow-skill-evals.json` contains six review cases with discriminating
criteria: hard constraints, real cost comparisons, plausible learning mistakes,
story consequences, routing negatives and missing live evidence. These cases
are not fed to generation. They are a starting evaluation set, not an executed
benchmark, an untouched holdout or evidence of improved output quality.

Before claiming improvement, generate paired old/new outputs for identical
inputs with the same provider/model/settings and available controls. Freeze the
baseline prompt and skill revision. Save raw output, validation failures, API
usage and elapsed time, including selection overhead. Randomize A/B presentation
and have a reviewer judge the rendered pages without knowing the variant.
Grade each criterion with concrete evidence; use tie or both-fail where warranted.
Compare task usefulness and grounding separately from schema validity and style.
Keep new, unseen requests for a final evaluation rather than repeatedly tuning
against the same six cases. Review routing separately, including follow-ups that
change the purpose of a page. The local service fixture tests protocol behavior,
not the quality of the configured model's selection, prose or decisions.

## Previously saved everyday pages

The earlier **Split a bill** and **Pack for a trip** pages create
real, editable, account-owned pages immediately, without a connected service,
model call, or payment. They use forms and deterministic rules, not free-form
chat editing. Changes require saving; leaving with unsaved edits prompts first.
Saved pages survive reloads, with revision checks to reject conflicting saves.

**Split a bill** supports 2–12 people and up to 50 costs. Choose who paid and who
shared each cost. Each cost is divided equally among the selected people; extra
cents go to earlier people in the list. Amounts are decimal strings, calculated
as integer cents, from 0.01 to 1,000,000 per cost. USD, EUR and GBP are supported
as labels, not currency conversion. The saved result shows suggested payments
and each person's paid amount and share. Editing hides the old summary until
**Work out the split** saves a new calculation. **Copy the split** copies the
summary; nobody is contacted and no money moves.

**Pack for a trip** supports 1–30 nights, a manually chosen weather type, and
swimming, walking, going out and international travel. This is a starting list,
not a forecast or a guarantee of travel requirements. Clothing quantities cap
at seven days, with a laundry reminder. Save trip changes to rebuild the list.
Personal additions stay; generated items stay checked only if their name and
quantity are unchanged. Changed quantities need checking again. Up to 100 items
are supported, with quantities from 1 to 99. Both pages have the server-storage
privacy limits described below.

## Living launch tracker

The legacy `kind: "tracker"` API creates an account-owned, interactive launch
page immediately, without a model,
paid call, or connected account. The checklist is a starter template, not a
researched plan. Owners, dates, notes, risks and real costs are yours to fill in.
Field edits use **Save changes**; steering suggestions save immediately.

This first version uses bounded local commands, not general natural-language
reasoning. Supported phrases (case-insensitive, with optional final punctuation):

- Add supplier costs and a risk section
- Actually make the costs monthly
- Use cards instead / Use a table
- Make it simpler / Show all details
- Add one more column
- Stop / Continue
- Undo that
- Make a second version

Unknown requests leave the page unchanged and explain the boundary. **Stop**
pauses subsequent page changes; it is not cancellation of a background agent.
Each change is a short atomic edit. The command box stays editable while a save
is pending, but the next change can only be submitted after the save completes.

Monthly steering reclassifies existing amounts as monthly; it does not divide
one-time costs or invent amortization. Money is stored in integer USD cents.
Unknown amounts remain blank; totals include known amounts only. Simpler views
hide details without deleting them. Copies are independent. Undo retains the
last 30 edits and always advances the revision, so stale clients cannot overwrite
newer work. Account deletion removes pages and their undo history.

**What did you check?** is computed on the server from the saved page: changed
sections, title/date validation, progress, separate monthly/one-time totals, and
missing owners/dates/amounts. It does not assert launch readiness, external
research, or verification of user-entered facts. Pages are rendered with React,
not generated HTML or scripts. They share the server-storage privacy limits below.

## What works

- Meet Kikka without connecting GitHub or any other service.
- Sign in or register on the configured Ohiyo backend, including two-factor sign-in.
  Burrow uses a separate tab-scoped session; reopening a closed tab may require sign-in.
- Save independent task requests to the server. Saving does not invoke a model.
- Approve one writing attempt for one task, with the destination service disclosed.
- Start other tasks or leave the page while approved work runs on the server.
- Reopen tasks and edit saved drafts. Concurrent edits use revision checks rather
  than silently overwriting each other.

The writing states are **Waiting for you**, **Working**, **Draft ready**, and
**Needs attention**. A generated answer is not a verified outcome and is never
labelled Done. This writing path has no browser tools, sending, watches, schedules
or automatic conversation memory. The separate research path below adds a
restricted public-page browser, not account actions.

## Kikka public research with Pi Durable

The existing runtime bridge can now select a private Pi worker with
`KIKKA_RUNTIME=pi`. The normal Burrow UI offers **Research public pages**, explicit
spending consent, task-specific steering, Stop, saved evidence screenshots and
follow-up revisions with previous versions. Existing creations, saved tasks,
layout and the separate Ohiyo privacy boundary are retained. No GitHub connection
or repository is required. Research uses **Working**, **Needs you**, **Stopping**,
**Stopped** and **Ready**; Ready is not independent verification.

Burrow owns authentication, task ownership, permissions, statuses and results.
The actual `@earendil-works/pi-durable@1.3.0` owns conversation/execution records.
One agent loop gets one tool: read an exact approved public HTTPS page and save
isolated screenshot/text evidence. No shell, coding agent, login or purchases.
Regional-page inspection is not geographic browser verification.

Stock Pi recovery can repeat a dispatched model request. The worker's spending
gate commits reservations/intent before dispatch, saves acknowledgements and
pauses unknown outcomes instead of repeating them. Compaction and follow-ups use
the same original task budget. No SDK patch or nested ImOrb loop is used.

See [worker setup, recovery evidence and limitations](../worker/README.md).
The worker is a trusted single-account pilot, disabled by default. A private
Groq Free-plan campaign exercised genuine inference through this UI: a saved
five-country comparison, annual revision with both earlier versions retained,
completed-checkpoint restart, Stop and account isolation. Free-plan/ZDR settings
were operator-attested, not independently verified. See the worker guide for
the quota failure, retained pause and test conditions. Paid inference remains
unauthorized; synthetic fault tests are separate from that live evidence.

### Return to saved research

Research keeps the conversation beside its saved result, with persistent Brief,
Scope, work limit and Stop controls. Narrow windows switch between Conversation
and Result. Sources contains captured screenshots; Activity contains actual
worker activity and usage. Nothing starts merely by opening a task.

**Pick up here** restores a reading position in the same tab and sign-in. If a
new final result arrived, it opens **What changed?** instead. The marker contains
only run/event IDs, pane selection and scroll offsets; it is not cross-device
history. **What changed?** compares exact saved text and preserves the displayed
proposal if polling discovers a newer version. Reopen the review before deciding
on a newer proposal. The displayed work limit is not a purchase budget.

Manual edits stay current until **Use this revision** explicitly replaces them.
**Keep my edits** dismisses the proposal without starting work or raising the
budget. Earlier results remain in Previous versions and worker records. Saved
choices show their scope, source task and update time, with Edit and Forget.
Unsaved result edits, memory corrections, notes and follow-up instructions warn
before leaving.

Stop can be requested even after an instruction's delivery becomes uncertain.
An uncertain Stop retry uses the same request ID. **Stopping** is not **Stopped**:
the latter requires the worker's terminal acknowledgement, and saved work stays
available. Stop is not a rollback of work already performed.

### Durable research workspace

**Research workspace** saves a comparison task even without a connected worker.
The task reopens in research mode independently of worker availability. Brief,
Compare and Decision are views of saved application records, not regenerated
pages. Execution status, scope, allowance and Stop remain outside those views.

- **Brief** saves versioned requirements and a separate item budget, plus questions,
  answers and resolved state. Saving never dispatches research. Once a Pi run has
  finished successfully, **Allow research update** sends the exact saved brief
  through the existing follow-up path, under the original goal and allowance.
  In-flight work keeps its original basis; save changes now and request the update
  after it finishes. Free-form steering has an unrecorded requirements basis.
- **Compare** keeps claim-level quotes, original URLs, capture times and unknowns.
  Filter by name or shortlist and change name/research order without changing data.
  Candidate notes and shortlist flags use application-generated IDs. Reconciliation
  matches only an unambiguous normalized name and exact source URL set; changed,
  duplicate or source-less identities become new candidates. Earlier notes remain
  available, including for options absent from the selected comparison.
- **Decision** saves a candidate, rationale, accepted tradeoffs and uncertainty
  against an immutable comparison and its original brief. Later briefs or research
  prompt reconsideration without rewriting the decision. Saving is not purchasing.

`GET/POST /burrow/tasks/{id}/research` is owner-scoped and has a workspace version
independent of task/execution versions. Stale writes return 409; the UI retains the
draft and requires review of the latest records before another save. Comparison
snapshots survive bounded event views and edited documents. Legacy results without
an admitted revision stay unattributed. A late lower-revision result cannot replace
a newer attributed one; unversioned results can be explicitly opened from history.
Existing manually edited documents remain available separately from source evidence.

The initial pilot retains at most 200 briefs, 100 questions, 200 decisions and 201
comparisons per workspace, rejecting rather than evicting history at the limit.
Text limits are UTF-8 bytes: 6,000 for a revised brief, 500 for the item budget,
200 for question labels, and 4,000 per note, answer or decision field.

Automated coverage uses public HTTP APIs, real SQLite/Pi journals and fixture
model/browser responses. These checks cover isolation, stale edits, candidate
identity, revision fencing, Stop/publication races and recovery without allowance
reset. They do **not** qualify the new workspace as a live research pilot. That gate
still needs an approved model/URL allowance and the fresh-account workflow with
actual research, logout/reopen, requirement changes and worker interruption.

## Proposed shopping direction — not implemented capabilities

Kikka's shopping promise is to find the best **purchasable** option, explain the
real savings and carry the job through to a confirmed order or an explicit
failure. This belongs to the optional Burrow experience; Ohiyo's private chats
remain separate and are not shopping context. Burrow retains task ownership,
authorization, budgets and history; Pi Durable remains the execution baseline.
Optional ImOrb isolation can expand execution without replacing that baseline.

Coverage should not depend on every merchant publishing an integration. Prefer
an authorized API or connector when suitable, simple HTTP for static pages,
Lightpanda where its DOM/JavaScript support is sufficient, and a full browser for
interaction, compatibility and genuine screenshots. Bound technical fallbacks;
an access denial is not permission to bypass controls or purchase restrictions.
Tools such as REA, printingpress and CLIanything are candidates to evaluate for
capability, safety, license and compatibility, not installed or trusted features.

The connector-learning loop is **browse → learn → build → verify → reuse**.
Observe only authorized browser traffic for permitted operations. Request and
response captures describe observed behavior, not hidden backend logic or extra
permissions. `mitmproxy2swagger` may draft a specification, but a connector still
needs redacted fixtures, contract checks and permitted-browser verification.
Never share captured credentials, personal data or authentication state with
connector code. Detect stale adapters and return to an authorized browser flow
or a user handoff; do not blindly repeat a transaction.

Regional research needs genuinely isolated sessions and verified network exits,
not merely a regional URL or a changed locale. Record requested and verified
region separately, plus verification time, language, timezone and currency.
Unknown exits remain unknown. Parallel workers share evidence and the root
budget, not cookies or credentials. Intentional session continuity is explicit.

Useful comparisons include subscription features and renewal prices; rare
parts, collectibles, clothing sizes and unavailable inventory; distributor
quantity, stock, lead time and delivery eligibility; and hotels/rentals with
matching dates, occupancy, fees and cancellation terms. Cross-border totals
include item price, shipping, duties, taxes, dated exchange-rate evidence,
warranty and returns. Keep unknown costs explicit; a low sticker price or an
unverified account/region does not establish that the user can buy the offer.

One session-management dashboard should show account, requested/verified region,
login status, task and cost, with reconnect, pause, revoke and delete controls.
Cookies, local storage, browser profiles and credentials are isolated by owner
and session. Share connector implementations, never authenticated profiles.

Before checkout, show the actual seller, item/variant, quantity, delivery
eligibility, currency, final total and material restrictions. Owner confirmation
or signing must bind that exact checkout and expire when its terms change; the
Helper cannot approve itself. Record the order confirmation or explicit failure.
An uncertain purchase pauses for investigation instead of being retried, even
after a restart. Research permission does not authorize paid infrastructure,
additional inference spending, account changes or purchases.

Delivery should proceed separately: broaden read-only shopping evidence first;
then verify regional/session isolation and management; then learn and validate
connectors; finally add owner-approved checkout with uncertain-order recovery.
The current five-page public-research pilot implements none of global regional
provisioning, learned merchant connectors, logged-in shopping or purchasing.

## Alternative ImOrb runtime bridge

The earlier ImOrb target remains a trusted single-account integration, disabled
by default; the Pi worker above does not run inside it.
It adds a durable admission/control outbox and saved ImOrb activity to the existing
Burrow task; it does not replace tasks. The creation editor does not invoke it.
This alternate target does not install Pi, browser tools, cross-task memory or
account connectors in ImOrb.

Source review found that [Pi sessions](https://github.com/earendil-works/pi/blob/fdce48eb404ec014adaf2ac10a3a53bc6b1740c2/packages/coding-agent/docs/sdk.md)
persist conversation history, not exactly-once execution. Its independent durable
harness is not layered on top of ImOrb. [ImOrb's current CLI](https://github.com/New1Direction/ImOrb/blob/15762f1c0e8d29504ed18fff390be60b6b60ded2/src/main.rs)
has local start/status/watch/control operations, not an authenticated tenant API.
Run creation has no native idempotency key; `root_goal_id` is correlation only.
The bridge therefore never repeats an uncertain start, even if that means asking
for operator help. It does not claim exactly-once third-party execution.

Configure all six `KIKKA_*` variables in `server/.env.example`. Use a private
operator-owned ImOrb home and an already-managed, dedicated Orb with supervised
`agentd`; the bridge does not provision or sleep machines. It calls the pinned
local binary with argument arrays, not a shell. The operator's `KIKKA_VERIFY`
command is trusted configuration, never supplied by an API caller. Credentials
stay with ImOrb. The binary inherits the server's environment, so this trusted
pilot is not a process-security boundary; do not run an untrusted executable.

Only `KIKKA_USER_ID` can admit/control work. Each request needs explicit approval
and a cumulative model-cost limit of 1–50 US cents; ImOrb enforces that limit,
including its lost-call reservations. Compute, storage and external charges are
not covered. Existing global/per-account admission limits and daily attempts
still apply. Continuation keeps the original run and budgets; it cannot add money.
This pilot serializes execution through one dedicated Orb. Independent tasks can
queue, but parallel computers and a fleet-wide monetary budget are not implemented.

API contract (authenticated owner only):

- Create an existing-format document task with `POST /api/v1/burrow/tasks`.
- `POST /api/v1/burrow/tasks/{id}/agent` with
  `{"version":0,"allow_agent":true,"max_cost_cents":25}` durably admits work.
  Replaying the same task version/terms returns the same admission. Changed terms
  conflict. No generation call or external process occurs on the request path.
- `GET /api/v1/burrow/tasks/{id}/agent` returns the saved task, attachment, last
  100 activity events, up to 200 control records and previous results. `connected` identifies a
  matching configured target, not a live health check. `last_seq` is the latest
  successfully imported event, not proof that compute is currently awake.
- `POST /api/v1/burrow/tasks/{id}/agent/control` accepts `version`, `request_id`,
  `action` and optional `message`. Actions: `steer`, `stop`, `resume`, `continue`.
  Steering/continuation require a nonblank message; continuation additionally
  requires `allow_spending:true`. Request IDs are idempotent within one attachment;
  reusing an ID for different content conflicts. Use the latest saved task version.

The reconciler starts on server boot and checks pending work every two seconds.
An idle bridge performs only a local database check; it does not run a model or
wake a computer. A saved runtime ID is reattached after restart. Journal sequence
IDs deduplicate replayed events. Queued work is safe to submit; a process crash
after a start/control intent but before its acknowledgement becomes **Waiting for
you**, with no automatic replay. Ordinary status/watch failures retry reads only.
Stop discards unsent instructions, requests runtime cancellation and waits for the
reported terminal state. It is not rollback or guaranteed tool termination.

Paused/approval-waiting runs remain attached and become **Waiting for you**. The
bridge cannot approve runtime actions or replace a lost model request. Ordinary
resume cannot bypass ImOrb's unresolved-call checks. The reviewed pilot requires
an operator to investigate ambiguous admission/control outcomes; there is no public
“assume it failed and try again” endpoint. Do not enable it for customers until a
human-authenticated resolution and approval experience exists.

Completed runtime work updates the same saved document from its `final_message`
event, while the previous result remains available during revisions. Runtime
completion maps to **Draft ready**, not independently verified **Done**. Activity
includes proof/receipt references when ImOrb emits them, but the bridge does not
import screenshots, verify receipt/bundle digests or make evidence portable.
Raw activity is private diagnostic data, not the intended default user interface.

Account deletion refuses while a run is queued, attached or uncertain, so it cannot
orphan live work. Finished bridge records cascade on deletion; ImOrb's independent
host journals/workspace files require operator retention/deletion handling. All
Burrow records remain owner-scoped plaintext, not E2E-encrypted memory.

**Known capability gap:** this adapter deliberately uses ImOrb's existing restricted
`investigate` mode. That mode expects a code-investigation report and independent
reproduction, not arbitrary consumer tasks. General Kikka/Pi tools, per-task
workspaces, browser/region provisioning, scoped memory and rendered result/proof
integration still need implementation. Do not present this pilot as the five-country
price-map acceptance test. The scripted comparison in tests is transport data,
not a claim that current ImOrb can perform that research.

`cargo test --test burrow_agent --test burrow --test delete_account` covers HTTP
admission/replay, owner isolation, reopening SQLite with fresh service state,
steering/continuation, preserved results/activity, process interruption during
submission, uncertain model/control outcomes, Stop and account-deletion guards.
The CLI fixture has no real model, browser or payments: these tests establish
adapter behavior, not live Pi/ImOrb recovery, model billing or regional accuracy.

## Enable writing

The client uses its normal `VITE_SERVER_URL`. Configure all four server variables:

```text
BURROW_COMPLETIONS_URL=<HTTPS OpenAI-compatible chat-completions URL>
BURROW_MODEL=<supported model identifier>
BURROW_API_KEY=<server-side secret>
BURROW_USER_IDS=<comma-separated approved Ohiyo account ids>
```

Without these, requests remain saved and the UI says writing is not connected.
Configuration is read at startup. Do not put a provider key in the browser or a
tracked file. Use a provider supporting `max_tokens` and text completion responses
with `choices[0].message.content` and `finish_reason: "stop"`.

Limits are 200 saved tasks per account, 3 active tasks per account, 8 active tasks
globally, and 10 attempts per account in a rolling 24 hours. Writing makes one
call requesting at most 2,048 output tokens. A creation attempt can make two
calls: up to 128 output tokens for skill selection and 4,096 for generation.
Both calls use the disclosed service and model. Together they share one
90-second attempt deadline and one admission; retries are never automatic.
Failed and interrupted attempts count. **These are request limits, not monetary budgets.** Configure a
provider-side spending limit before enabling accounts.

## Privacy and recovery

Burrow stores requests and results as plaintext on the Ohiyo backend, scoped to
their authenticated owner. They are not end-to-end encrypted. Account deletion
cascades to these records. Writing shares only the approved task request and a
fixed Kikka instruction. Creations additionally share the current page and the
latest change request. No Ohiyo chat messages, keys, other tasks or account
identity are included. Provider retention policies still apply. Output is
displayed as escaped text or trusted React components, not executable HTML.

The writing path is a single-process pilot. Tasks survive page reloads and browser disconnects.
On server restart, previously working writing tasks become **Needs attention**, with an
explicit warning that an uncertain request may have incurred a charge. They are
never automatically resubmitted. Attached research tasks instead reconcile with
their independent durable worker; unknown paid outcomes still pause for review.

## Verification

`cargo test --test burrow` in `server/` exercises local tracker creation, live edits,
accurate cost totals, unknown amounts, undo, independent copies, stop/continue,
owner isolation, concurrent revision conflicts, and invalid/unsupported changes.
It also exercises exact bill settlements with asymmetric sharing and remainder
cents, invalid costs, packing rules and changed quantities, personal additions,
and saved-page ownership and revision checks through the authenticated HTTP API.
It also exercises the real authenticated writing HTTP stack
with a local writing-service fixture: independent tasks, consent, owner isolation,
saved edits, stale revision rejection, failed/truncated/empty responses, restart
recovery, and durable attempt limits. It makes no paid model calls and does not
establish the quality of a live model's writing.

Creation coverage includes consent, owner isolation, revisions, stale clients,
undo, stop versus late completion, unsupported components/events, invalid answers
and cyclic layouts. `node --experimental-strip-types --test test/generatedPage.test.ts`
in `client/` exercises actual quiz scoring, story navigation and checkbox controls,
plain-text escaping, invalid specs and shared schema consistency.

## Subscription connections and native Pi execution

Open **Connections + → Add connection**. Sign into your own Claude or ChatGPT
account, choose a model, and select **Use for new research**. This explicitly
sets the four roles for new tasks. Existing tasks retain their approved routes;
sign-in alone never selects a model or starts work. API keys remain available
under **Advanced**.

The worker uses the installed Pi AI package's native OAuth and inference
adapters, not a second agent loop or tokens extracted from CLI profiles. No
Claude Code/Codex binary is needed. Custom launchers must call `workerServer`
**before** `worker.recover()` so recovered tasks have account access configured.
Old CLI-pilot sign-ins are not imported; reconnect through the new flow.

**Claude:** complete sign-in on the returned provider page, then enter its
completion code in Burrow if prompted—never in a chat message. **ChatGPT:** open
OpenAI's page and enter the displayed one-time code there. Device-code login may
need enabling in ChatGPT security settings. Burrow never asks for the account
password. Connecting and checking status perform no inference.

OAuth credentials are account-scoped and AES-256-GCM encrypted in
`subscription-accounts/accounts.sqlite`, using a key derived from the stable
private worker token. Keep that token and directory private; never mount them
into task workspaces or expose them through previews. Refreshes serialize per
owner. A completed rotating refresh is persisted even if Stop arrives, but the
cancelled task cannot begin inference. Disconnect removes local credentials and
blocks subsequent requests; it is not a provider-wide logout or token revocation.
Sign-in revisions stay pinned to task approvals, so reconnecting cannot silently
reactivate an old task. Interrupted logins are not automatically restarted.

Subscription requests use the same durable gate, server-owned approval check,
Stop handling and uncertain-response protection as API requests. Each task has
a cumulative **20-request cap**, including follow-ups and summaries; restarting
does not reset it. Usage records preserve tokens with `costSource: subscription`
and unknown charges—not a fabricated zero bill. This is **not a dollar cap or a
guaranteed output-token cap**. Provider allowance and account billing settings
still apply; Burrow neither enables extra usage nor falls back to paid API keys.

Deterministic tests exercise native provider wire formats, encrypted storage,
account separation, restart/revision, revocation, Stop and request limits. They
are not live provider acceptance. Actual plan eligibility and a successful live
research task still require the user's own provider sign-in. Compatibility does
not establish permission to publicly host a subscription service: Anthropic's
previously documented third-party approval requirement and OpenAI's registration
and hosting requirements remain separate from this local implementation. See the
[Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview).
No Amp credentials or private implementation are used. References:
[Amp model routing](https://ampcode.com/docs/customize/model-routing),
[Amp's Claude plan announcement](https://ampcode.com/news/use-your-claude-plan),
[Codex authentication](https://developers.openai.com/codex/auth),
and [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart).

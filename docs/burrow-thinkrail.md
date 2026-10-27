# ThinkRail → Burrow: reuse boundaries and first slice

Investigated 2026-10-25 against ThinkRail
[`d299f20`](https://github.com/JetBrains/thinkrail/commit/d299f20d2ba014f382ddbcc9b49f2aa63fada132).
Source/spec inspection, not an executed ThinkRail product evaluation.

**Decision: reuse architectural ideas, not its host or agent runtime.** Ohiyo
remains private, AI-optional chat. Burrow remains a separate opt-in workspace;
no chat messages, encryption keys or implicit personal-memory extraction enter
this feature. Pi Durable 1.3.0 remains the model/task/journal owner, with the
existing cumulative spending gate, zero automatic retries and uncertainty fences.
No upstream code, prompts, packages or telemetry were imported. ThinkRail's root
license is Apache-2.0; any later code import still needs a pinned license/NOTICE
review and dependency audit, not blanket installation of the repository.

## Capability map

| ThinkRail capability / evidence | Burrow before this slice | Reuse / decision |
| --- | --- | --- |
| [Spec graph](https://github.com/JetBrains/thinkrail/tree/d299f20d2ba014f382ddbcc9b49f2aa63fada132/packages/spec-graph): frontmatter `id`/`type`, typed edges (`parent`, `depends-on`, etc.), derived read index, validation and seven `spec_*` tools. `spec_update` writes metadata directly; prose uses ordinary filesystem tools. | Explicit account/project memories, immutable declarative routine versions, task history/search and saved requirements. No project spec store or graph. | Adopt durable project intent and a shared read model; replace direct writes with proposals. First slice: one versioned text spec per project, not a graph parser, repo scan or arbitrary path access. Add nodes/edges only when navigation needs them. |
| [Extensions](https://github.com/JetBrains/thinkrail/blob/d299f20d2ba014f382ddbcc9b49f2aa63fada132/thinkrail-extensions/SPEC.md): separate server/web entrypoints, static registries, explicit host-owned lifecycle seams. Visualize is registered; more extension wrappers are planned. | Trusted json-render controls, four compile-time authoring skills, Pi Durable extensions and explicit computer capability grants. | Keep the static tool registry and host ownership. Proposed skills are inert guidance-only JSON, never downloaded extensions. No dynamic loader or self-modifying registry. A new UI renderer must remain reviewed/trusted code. |
| [Workspaces](https://github.com/JetBrains/thinkrail/blob/d299f20d2ba014f382ddbcc9b49f2aa63fada132/packages/server/src/workspaces/SPEC.md): branch/cwd isolation with managed git worktrees; explicit project-folder and external-worktree exceptions. | Account-owned tasks/projects and explicitly provisioned replaceable ComputerProvider resources; shell/file grants and receipts. | Keep account authorization plus disposable computer isolation. A git worktree is branch isolation, NOT a hostile-code, network or multi-tenant security sandbox. Do not replace resource grants with a project path. |
| [Reviews](https://github.com/JetBrains/thinkrail/blob/d299f20d2ba014f382ddbcc9b49f2aa63fada132/packages/server/src/reviews/SPEC.md): anchored comments, pinned base identities, per-file review sessions, structured context packages. | Activity/evidence receipts, comparisons with attributed revisions, manual result acceptance, requirements revisions, travel mandates. | Adopt immutable before/after evidence and stale-base rejection. This slice exposes current/base/proposed text, history, decisions and test reports through authenticated APIs and the parent-facing project review UI. No Monaco editor, line anchors or review chat. |
| [Delegation](https://github.com/JetBrains/thinkrail/blob/d299f20d2ba014f382ddbcc9b49f2aa63fada132/packages/pi-delegation/SPEC.md), [subagents](https://github.com/JetBrains/thinkrail/blob/d299f20d2ba014f382ddbcc9b49f2aa63fada132/packages/pi-subagents/SPEC.md), [DAGs](https://github.com/JetBrains/thinkrail/blob/d299f20d2ba014f382ddbcc9b49f2aa63fada132/packages/pi-dag/SPEC.md): controlled children, FIFO slots, turn caps, lineage, curated tools; resource-owned durable DAGs with human release gates. DAG package is not bundled into ThinkRail. | One Pi Durable conversation/task with durable control outbox and budget ledger; no general child-agent surface. | Do not introduce a second scheduler/session store. Future delegation must inherit account/project, budget, cancellation and reduced capabilities through Pi Durable. `pi-delegation`/`pi-dag` use Pi Coding Agent sessions and are not drop-in Durable extensions. No delegation added here. |

The inspected spec-graph and DAG manifests are private workspace packages at
version 0.0.0 in this revision. Documentation's portability/publication intent
does not establish that these exact packages are available or compatible on npm.

## Implemented independent slice

SQLite migration `0071_burrow_project_specs.sql` owns account/project spec
revisions and immutable spec/skill proposal content. Project identity follows
Burrow's existing exact project-name scope, not a new shared repository identity.
All tasks of the same account/project see the same knowledge. Other accounts,
even with the same project name, cannot read or decide it. Projects/specs remain
server-side Burrow data, not Ohiyo end-to-end encrypted chat data.

Kikka gets the approved spec in the existing explicit context packet on admitted
work/follow-up. Dedicated read/propose tools require a separate
`allow_project_knowledge: true` agent admission; it defaults false and cannot be
silently changed on replay. Travel never gains these tools. Existing admitted
runs stay unchanged. Approval tools and worker tokens are never given to Kikka.
Spec text, skill instructions and tool output are untrusted data, not authority.

The model can propose full replacement spec text or a skill JSON string with
exactly `{name,description,instructions}`. No scripts, dependencies, hooks,
package identifiers, executable expressions, network endpoints or tool fields
are recognized. Text may discuss code, but it is never evaluated as code.
Pi tool IDs deduplicate durable proposal events; server reconciliation binds
scope from the run/task, not model arguments. Replayed events never reset an
already reviewed/revoked proposal. Cap: 20 proposals/run, 200 proposals/project,
8,000 bytes/proposal; candidate fields have smaller byte limits. The 200 limit
includes reviewed proposals: this pilot stops rather than deleting audit data.

Spec approval atomically compares the proposed base with the latest revision
and appends a revision. Conflicting decisions return 409. Rollback is allowed
only while that approval is the latest spec write: it appends the old content
as a NEW revision, preserving history and preventing older rollback from erasing
later work. Rolling back the first spec restores empty content, not revision 0.

Skill approval authorizes eligibility for testing ONLY. A separate human test
action commits `testing` before contacting the private worker. The worker runs
a fixed structural validator in a restricted Node 26+ subprocess with empty
environment, denied filesystem/network/process access, deadline/output/heap
limits and live permission-denial probes. No candidate code or model executes.
Results explicitly say **structural-only**, not useful, safe against prompt
injection, or behaviorally verified. Approval/testing NEVER installs or activates
a skill, updates a prompt/tool registry, fetches packages, or spends model budget.
Node's permission model is defense in depth for this fixed validator, not an OS
sandbox for adversarial executable plugins; those remain unsupported.

Each candidate gets one test attempt. Failed/lost acknowledgements become
`test_failed`; a server crash after admission leaves `testing`, with no automatic
retry after recovery. Human rollback revokes either state. Late acknowledgements
cannot undo revocation. Submit a new, separately reviewed candidate for another
attempt; no unbounded retry loop exists.

### Authenticated API

All paths below are under `/api/v1/burrow/tasks/{owned_task_id}` and require the
ordinary account Bearer token. The task must have a project.

- `GET /specs`: `{spec:{project,revision,content},history,proposals}`; history and
  immutable proposal base revisions provide the before/after review data.
- `POST /proposals`: `{kind:"spec"|"skill",base_revision,content}` → pending ID.
- `POST /proposals/{id}`: `{action:"approve"|"reject"|"test"|"rollback"}`.
  Only pending candidates can approve/reject. Only approved skills can test;
  rollback revokes approved/testing/tested/failed skills. There is no install action.
- Existing `POST /agent` additionally accepts `allow_project_knowledge`; ordinary
  `allow_agent`, spending/model approvals and any computer grants still apply.

Human save/review/rollback do not need a configured model or worker. Testing
needs the private Pi worker and Node 26+; older workers fail closed.
Context refresh occurs on explicit follow-up, not inside an in-flight model turn;
rollback cannot erase already-dispatched prompts, model charges or external effects.

## Browser review slice

In Burrow, describe the presentation, enter or select a saved project name and
choose **Send**. The project is optional (defaults to Personal); saving does not
start a model. One conversation contains the saved material, suggested changes
and guidance-only helper cards. **Project plan** opens the persistent plan on
demand, not a separate Plan/Draft screen. Full comparisons and past decisions are available
on demand; runtime IDs, raw sandbox reports and internal revision bases are not
presented as user content. A parent can write
a plan without AI; saving an edit makes a proposal and approval is separate.
**Undo approval** requires confirmation and preserves revision history. Stale
approvals are blocked; ambiguous action outcomes require an explicit read-only
refresh. The UI never automatically repeats a decision or test.

**Allow & start chat** uses the existing Pi Durable admission, model disclosure,
spending limits, stop/follow-up and protected manual edits. The proposal-tool
checkbox is off by default and its admission remains immutable. The approved
plan is already part of saved context; the checkbox adds the read/propose tools,
not access to Ohiyo chats. No skill approval/test/install tool enters the agent.
Materials in this slice are text slide outlines and speaker notes, not generated
PowerPoint files. Markdown slide headings get a local, navigable inline preview;
Read all and Edit preserve the entire original document, including introductions
and sources. Other documents remain readable without a slide wrapper. Navigation
never calls a model or changes saved text. Facts, age suitability and sources still require human review.
The focused writing view reuses the existing runtime controls, without the
research studio's region/tax caveats, activity logs or model role picker. Saved
choices can be reviewed before AI consent. Textarea values remain the exact
user document; no heuristic stripping or rewriting of saved content is applied.
The model prompt asks for document content, not runtime/approval receipts.

Helper **Allow a check** and **Check helper** are separate actions.
A passing structural check does not verify model behavior or teaching quality.
There is no install or activation action, including after a passing test.
Project data remains account-owned server data, not end-to-end encrypted chat.

### Conversation UI references

Read-only source inspection of the supplied repositories (no installers run):

- [Transitions.dev](https://github.com/Jakubantalik/transitions.dev/tree/6a7d68260d624eb66661cc3af17e0989476f48ae): compact reveals and immediate interaction feedback, with reduced-motion alternatives. Its generated-UI wireframes and agent-log demos are not real model progress; do not expose fabricated generation steps. Source licensing distinguishes tooling from transition-library redistribution.
- [Libraries.dev](https://github.com/Jakubantalik/Libraries.dev/tree/ea001e3469e810e8a3e42df072cdb61e4a10c5ef): composable visual effects preserve the underlying control semantics. Keep that separation, without replacing Kikka's mascot or installing seven effects packages. Model assets and Pro content have separate licenses from the MIT library code.
- [metal-fx](https://github.com/Jakubantalik/metal-fx/tree/be1bf89c63056521a4e8224f368768314c9006f7): MIT WebGL chrome for controls, not a generated-UI system. A permanent render loop is unnecessary for a parent writing messages. Borrow restrained control contrast, not a GPU effect dependency.

No upstream code was copied. The existing Zod/json-render trusted catalog renders
pages inline in creation chats, selected through **Interactive page** beside the
new-chat composer. This replaces the split preview, not the runtime or page API;
it does not automatically convert an existing document chat into a page or grant
page generation access to project-spec tools. No new JEV/Typesafe API,
credential, runtime, executable UI or silently expanded model tools were added.
This pass simplifies the existing Pi-backed document conversation; it does not
claim one model can now generate arbitrary executable interfaces.

## Understand-Anything: useful reference, not a runtime dependency

Inspected 2026-10-26 at
[`e24fcf6`](https://github.com/Egonex-AI/Understand-Anything/commit/e24fcf6d371bcfa529bc110bacb1bb43de1b8d33).
This was read-only source inspection, not a run or security audit of its agents.
Nothing from the repository was installed or imported into Ohiyo.

- Its [graph contract](https://github.com/Egonex-AI/Understand-Anything/blob/e24fcf6d371bcfa529bc110bacb1bb43de1b8d33/understand-anything-plugin/packages/core/src/types.ts)
  supports code, knowledge and design graphs, summaries, typed links, provenance
  locations and ordered tours. Useful for developer onboarding and a possible
  future source/claim learning map. This describes material; it does not replace
  project requirements, human approval or append-only spec history.
- [Tree-sitter extraction](https://github.com/Egonex-AI/Understand-Anything/blob/e24fcf6d371bcfa529bc110bacb1bb43de1b8d33/understand-anything-plugin/packages/core/src/plugins/tree-sitter-plugin.ts),
  fuzzy search and precomputed-vector search are separable ideas for navigating
  a large codebase. Parent presentation drafting does not need a repository scan
  or embedding pipeline. A future adoption needs explicit source selection,
  privacy/cost consent and stale-index handling, not access to private chat.
- Its [automatic-update hook](https://github.com/Egonex-AI/Understand-Anything/blob/e24fcf6d371bcfa529bc110bacb1bb43de1b8d33/understand-anything-plugin/hooks/post-tool-use-auto-update.mjs)
  injects agent instructions after commit-like commands when `autoUpdate` is
  enabled. Do not adopt this hook or its multi-agent pipeline in Burrow: all
  execution must remain under Pi Durable's existing budget and consent gates.
  Advertised Pi Agent installation support is not evidence of Pi Durable
  compatibility or account/workspace isolation.
- Root license is MIT. Any later code reuse needs a pinned dependency review and
  preserved copyright/license notices. Recommendation now: borrow the navigation
  and guided-tour concepts if a real need emerges, not the installer or runtime.

## Verification and next decisions

`server/tests/burrow_specs.rs` exercises authenticated HTTP, real SQLite reopen,
cross-account/project permission failures, stale edits/rollback, replay and an
actual server → Pi worker → human approval → restricted subprocess test path.
Only inference is scripted; no live provider or production resource is used.
`worker/test/project-knowledge.test.mjs` checks actual Pi tools/journals across
reopen, absent approval/install tools, explicit admission and sandbox denials.
Server CI uses Node 26 to exercise the sandbox success path; the general worker
runtime still supports Node 22.19+ with this optional operation unavailable.

`client/test/projectReview.test.ts` covers stale approval, confirmed/cancelled
undo, separation of approval/testing and fail-closed uncertain outcomes.
`e2e/project-review.test.mjs` runs the real browser/HTTP/SQLite/Pi/sandbox path
with scripted inference, project reuse/reload, separate tool consent, rejection,
rollback, cross-account permissions and mobile overflow checks. See the E2E
README for the explicitly isolated fixture stack; no live-model quality claim.

Future decisions, not hidden implementations: explicit per-task activation of a
tested guidance version; graph node/edge schema and import/export; audit
retention beyond this pilot's cap.
Executable third-party plugins or delegation require separate threat models and
approval contracts. None is necessary to use the spec/proposal APIs now.

## Classroom review, export and optional evaluation

Migration `0072_burrow_presentations.sql` adds append-only, account-owned review
history bound to the exact saved material version. **Review & download** stays
inside the document/page conversation. Audience, claim-to-source links, titles
and supporting excerpts persist independently of AI. School-use approval needs
checked sources and three explicit human attestations: factual review, age
suitability and school use. Edits, proposed revisions and withdrawal prevent
export under the old approval; restoring identical text does not restore consent.
Withdrawal preserves history and cannot recall previously downloaded copies.

Export rechecks ownership and approval in one database read transaction, then
generates an OOXML `.pptx` locally with pinned MIT `pptxgenjs` 4.0.1. No model,
remote images, source fetching, macros or generated code is needed. It preserves
outline order, introductions, speaker notes, Unicode, citations and audience;
long bodies paginate. Supported catalog pages become semantic static slides:
tables and charts retain supplied values, quizzes retain all questions with
answers/explanations in notes, and stories retain every scene and branch target.
This is not a screenshot or interactive export. Fixed SpringLab/RequestJourney
activities fail closed instead of silently disappearing from a downloaded deck.

Optional AI review requires a separate unchecked consent and a displayed model,
funding route and configurable 0–50 US-cent limit. Zero permits genuinely free
routes only. Existing Pi Durable admission and spending reservations remain the
authority; the full model context/output reserve can exceed a small chosen limit,
in which case no inference occurs. Subscription billing is not offered here
because Burrow cannot enforce its dollar cap. Operator-approved prices must be
valid upper bounds; reservations are not a provider invoice or billing guarantee.

One immutable allowance exists per material version, not per HTTP attempt.
The reviewer receives only the saved material, audience and numbered sources:
no private Ohiyo chat, personal memories, project tools, browser or computer.
The durable spending gate allows one model dispatch, including for free routes,
and fences uncertain outcomes. No follow-up, retry, paid fallback or budget/tool
escalation is allowed; Stop remains available. Failure does not renew the
allowance. Reports stay inside their parent review, cannot be manually replaced,
and never change content or approve school use. Human sign-off and AI consent
are independent: withdrawal does not cancel an already-requested model review.

Verification includes real ZIP/XML export assertions in
`client/test/presentation.test.ts`, authenticated persistence/permissions/stale
approval/rollback/budget tests in `server/tests/burrow_presentation.rs`, real Pi
journal and gate tests, and the extended browser fixture against development and
production-preview builds. The browser downloads and opens the actual PPTX ZIP,
checks citations/notes, and exercises consent, approval and withdrawal. Only
inference is scripted; no live-model spending or quality evaluation was performed.
No native Microsoft PowerPoint/Keynote rendering was checked in the orb. Source
links are human-supplied and never automatically verified; these surfaces aid
review, not certify factual accuracy, age suitability or school compliance.

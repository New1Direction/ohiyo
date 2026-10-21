# Kikka computers: contract 1.1.0

Pi Durable remains the only task owner. `ComputerProvider` allocates resources,
authorizes actions and journals receipts; it does not call models. ImOrb is a
replaceable resource. Browser/desktop engines, booking and payment are not
implemented by this slice. No nanocodex dependency was added.

## Existing bridge and available ImOrb access

`server/src/api/burrow/agent.rs` selects either the private Pi HTTP worker or
`orbd host agent`. That older CLI branch submits/manages an ImOrb agent run;
it cannot serve as Pi's computer. It remains unchanged for existing work.
Computer admissions require the Pi branch and use a separate resource adapter.

Inspected ImOrb source: revision `15762f1c0e8d29504ed18fff390be60b6b60ded2`,
especially `src/main.rs`, `src/host.rs`, `src/portal.rs` and
`docs/security-limitations.md`.

| Access | Existing support and this adapter's use |
| --- | --- |
| CLI | `host create/list/start/wake/destroy/exec`; never `host agent` or `host submit`. Resource names satisfy upstream's 32-character limit. |
| HTTP/API | Service portals and egress proxy, not an authenticated remote provisioning API. |
| WebRTC/session | No short-lived account-scoped interactive desktop session endpoint found. Portal bearer tokens are unsuitable for `live_view`. |
| Files | Fixed Bun helper through `host exec`, bounded UTF-8 text read/write and ensure-directory; no arbitrary host paths or general binary transfer. |
| Browser/desktop | No CDP, crawl4ai or LCU engine installed here. Their capabilities are absent, not simulated. |
| Persistence | `/orb/state` is a host bind mount retained by stop/start. `destroy` deletes it; there is no supported create/replace option to reattach independent scoped workspace/profile storage. |

The adapter additionally checks namespace-owned Docker containers during cleanup:
upstream `destroy` ignores Docker removal errors before deleting its registry.
Registry disappearance alone is not release proof. Leftovers remain discoverable;
failed removal stays unavailable and is retried, never reported released.

## Canonical interface and replay

Import `COMPUTER_CONTRACT_VERSION`, validators, operations and
`ComputerNotDispatched` from `src/computer-contract.mjs`. Version 1.1.0 supersedes
the first locally committed 1.0.0 contract by defining proven non-dispatch.
Engine adapters must not maintain a parallel interface.

Every call has `{ account, workspace_id, task_id, root_goal_id, request_id }`.
Burrow derives identity from the authenticated owner and pinned admission; Pi's
durable tool task ID supplies the action ID. Models cannot choose either.

Public methods:

```js
open(identity)
status(identity) // provisioning | ready | unavailable | reconnecting | replacing | released
capabilities(identity)
reconnect(identity)
replace(identity)
release(identity, { workspace: false })
execute(identity, { operation, args, replay_class, invariant }, { signal })
stop(identity)
live_view(identity, { mode: 'read_only' })
```

`capabilities` returns version, concrete features, `{ workspace, profile }`
persistence guarantees and limitations. Operations include browser navigate/read/
tabs, screenshot, files, optional shell and reserved desktop operations. A grant
and an available engine are both required. Screenshot engines advertise
`screenshot` plus `browser.screenshot` or `desktop.screenshot`.

| Replay class | Crash/acknowledgement-loss handling |
| --- | --- |
| `read_only` | May retry. Navigation qualifies only for an exact operator-reviewed safe URL. |
| `idempotent_effect` | Only `files.ensure_directory` with tested `mkdir_exists_v1` is admitted. May retry that invariant. |
| `non_idempotent_effect` | Unknown outcome fences all subsequent workspace effects, even with a new request ID, restart or replacement. Read observations remain possible. |

The FULL-synchronous SQLite journal commits identity, fingerprint, replay class,
resource generation and dispatch timestamp before execution. Completed exact-input
receipts replay without external dispatch. A backend may throw the actual
`ComputerNotDispatched` class only with positive proof execution never dispatched
(for example, an executable could not spawn). JSON, error names, nonzero exits,
timeouts and cancellation cannot establish this proof. Lost acknowledgements
remain uncertain. There is no model-callable uncertainty override; trustworthy
effect-specific reconciliation is still required before clearing a fence.

Grant snapshots are host-owned and checked again after waiting in a workspace
queue. The launcher rereads `computer.grants` from its private config for each
check; atomic file replacement is recommended. Removing/narrowing a grant blocks
queued dispatch without restarting Pi. Invalid policy fails closed.

## Allocation, cleanup and persistence

Default allocation is one computer per account/workspace, shared by task
references and serialized actions. Releasing one task cannot release another
task's computer. Workspace release explicitly stops/releases all references.
Stop blocks queued actions and bounds cancellation acknowledgement; it does not
claim rollback or that a disconnected remote effect physically stopped.

The worker reconciles at startup and every 30 seconds, cleans only its own
namespace, releases revoked/unused/idle allocations and retries failed cleanup.
Default idle timeout is 15 minutes; health checks do not extend it. Finishing a
task does not release other workspace references. Explicit cleanup uses the
authenticated computer endpoint, including after Stop. If the host itself is
down, cleanup cannot run until it recovers. Keep the same worker directory and
private `ORBD_HOME`: moving either is a migration, not a safe way to reset state.

**Replacement persistence is unavailable in the inspected ImOrb.** Both flags
are false; reconnect can retain the same machine's files, but replacement is
clean and requires reauthentication. Pi task records, budgets, action receipts
and uncertainty fences remain outside the computer. Do not treat an environment
snapshot as a backup of authenticated browser state. One local SQLite owner
lease is enforced; multiple hosts with independent ledgers are not supported.

## Operator setup and API

On a disposable Docker-capable execution host, build the inspected ImOrb revision
and initialize its host resources using upstream instructions. Provide a small,
reviewed committed bootstrap repository; its setup executes during provisioning.
Do not point customer computers at this product repository or a repository with
secrets. This slice does not install Ubuntu/X11/ChatGPT/LCU: those belong to the
desktop engine provisioning work, and upstream currently hardcodes Debian.

Add this optional object to the worker's existing private configuration:

```json
{
  "computer": {
    "binary": "/opt/imorb/orbd",
    "home": "/var/lib/burrow/imorb",
    "repo": "/opt/burrow/computer-bootstrap",
    "size": "small",
    "idleMs": 900000,
    "grants": [{
      "account": "OWNER_ID",
      "workspace_id": "WORKSPACE_ID",
      "features": ["files.read", "files.write", "files.ensure_directory"]
    }]
  }
}
```

Create scope with authenticated `POST /api/v1/burrow/computer-workspaces`
`{"name":"Research"}`. This saves authorization, not a computer. Add its ID to
the operator grant and the existing agent admission as `computer_workspace`.
Admission pins it; changed approval terms are rejected. Lifecycle/receipt/view
requests go to `POST /api/v1/burrow/tasks/{id}/computer` with
`{"action":"status","request_id":"inspect-1"}`. Supported actions are status,
capabilities, open, reconnect, replace, release, release_workspace, receipt and
live_view. Task/workspace ownership is checked before forwarding to the worker.

`live_view` is host-only: session ID, HTTPS access URL, expiry no more than five
minutes away and read-only/interactive mode. Bearer URLs never enter Pi tools or
task journals. An installed service must enforce scope, expiry and mode; descriptor
validation alone cannot provide that enforcement. Base ImOrb reports unavailable.

## Engine handoff and validation

CDP/crawl4ai and LCU authors should import **1.1.0**, then implement the backend
subset `status(allocation)`, `execute(allocation, identity, action, {signal})`,
`cancel(allocation, identity)` and optional `live_view(allocation, identity, options)`.
Host code supplies engines through `ImOrbComputerBackend({ ..., engines })`;
the launcher intentionally does not load model-selected plugin paths. Use its
fixed-argv `run(['exec', computer_id, ...], options)` transport. No task submission,
model loop, booking or payment. Probe actual app/engine versions in status and
omit unavailable features. Engine errors must preserve dispatch uncertainty.
Request any additive contract change here, not in a parallel interface.

Before a live browser demo, the host needs a browser engine, scoped upstream
egress grants/proxy, and approved navigation policy. Before LCU testing it also
needs a supported custom-image/bootstrap path. External scoped-state reattachment
and an expiring view-session service remain missing upstream integration pieces.

Executed verification on 2026-10-21:

- `npm test`: 74 passed, zero failed/skipped. Fake contract acceptance, real Pi
  tools/reopen/Stop, transport/file-helper fixtures, revoked queued grants,
  lost acknowledgements, actual SIGKILL, cleanup leftovers, isolation and existing
  model budgets/routing/memory/results tests.
- `cargo test --test burrow_agent --test burrow --test burrow_context --test delete_account --no-default-features`:
  24 passed. Disposable databases only; no shared migration or deployment.
- Fixture demo: `node --test --test-name-pattern='real Pi task uses canonical' test/computer-runtime.test.mjs`.
  Real Pi loop, synthetic model and computer; navigates a fixture page, loses the
  computer, reconnects, requests a fixture screenshot, writes a file, completes
  and reopens the same durable task without new model calls. Not a live ImOrb.
- Live ImOrb/browser demo **not executed**: this orb has no `orbd` executable or
  Docker daemon/socket (`docker info` cannot connect). No real browser screenshot,
  desktop boot, authenticated profile reattachment or live-view claim is made.

## ComputerProvider 1.1.0 verification follow-up

The contract remains unchanged. Production `ComputerNotDispatched` sites in
`src/imorb-computer.mjs` (line numbers at this follow-up):

| Site | Exact condition establishing pre-dispatch | Regression coverage |
| --- | --- | --- |
| 28 | Combined signal is already aborted, before calling `spawn`. | Pre-aborted call creates no fixture home; the same command without cancellation initializes it. |
| 37–38 | Child `error`, no `spawn` event, no PID, and code is `ENOENT`, `EACCES` or `ENOEXEC`. No provider executable ran; queued local stdin is not remote dispatch. | Actual missing and non-executable files reject with this class; non-executable marker stays absent. A spawned nonzero exit instead leaves the effect uncertain. |
| 150 | No eligible engine after discovery, and no ambiguous discovery error. Engines are absent, explicitly not ready, lack the operation/surface, or threw the actual pre-dispatch class. No engine action was dispatched. | Absent/unavailable/unsupported/pre-dispatch cases are distinguished from timeout, reset, version mismatch and unknown engine state. |

The last site previously swallowed all health errors and incorrectly asserted
non-dispatch. Ambiguous health failures now throw an ordinary error, preserving
uncertainty for non-idempotent effects. Unknown engine states are rejected rather
than interpreted as acknowledged unavailability. Delegated execution errors are
not reclassified. Timeout, abort after spawn, EOF/nonzero exit, lost acknowledgement
and unknown process errors never become `ComputerNotDispatched`.

Tests also inject this class in `test/computer-provider.test.mjs:141`, before
external work, and construct it in `test/imorb-computer.test.mjs:119` for the
preflight case. The name-only lookalike at provider test line 147 is deliberately
an ordinary error after an effect; it cannot authorize replay.

The post-write timeout regression uses a real subprocess and the actual file
helper: the receiver records the request bytes and commits the file before the
timeout fires. The receipt is `uncertain`, not `unavailable`; worker restart and
reconnect preserve it, and both the original and a new action ID are prevented
from overwriting the file. This is transport-fixture evidence, not a live ImOrb.

Follow-up verification on 2026-10-21:

| Working directory | Command | Result |
| --- | --- | --- |
| `server` | `cargo test -j 2` | 566 passed, 0 failed, 0 ignored, 0 filtered; doc-tests completed with 0 tests. |
| `server` | `cargo test --no-default-features -j 2` | 566 passed, 0 failed, 0 ignored, 0 filtered; doc-tests completed with 0 tests. |
| `worker` | `npm test` | 77 passed, 0 failed, 0 cancelled, 0 skipped. |

Both Cargo commands used `CARGO_PROFILE_DEV_DEBUG=0`,
`CARGO_PROFILE_TEST_DEBUG=0` and `CARGO_INCREMENTAL=0`. An initial build exhausted
disk before tests started; `cargo clean` removed generated build cache and both
complete suites then exited successfully. No test selection or skipping was used.

**Live 12-point ImOrb qualification was not run.** `command -v orbd` finds no
executable. `/usr/bin/docker` exists, but `docker info` cannot connect to
`unix:///var/run/docker.sock`: that socket does not exist. A host with the pinned
`orbd` and an accessible Docker daemon is required; fixtures are not a substitute.

### Missing ImOrb-side APIs

These are proposed upstream resource APIs, **not changes to ComputerProvider**.

1. **Scoped state reattachment — does not block the narrow typed-Duffel travel
   demo; blocks replacement session-continuity qualification.** The inspected
   ImOrb mounts its own state at `/orb/state`; destroy removes that state.
   Create/replace cannot attach an independently retained browser profile and
   workspace. Suggested resource API:

   ```text
   create({request_id, account, workspace_id,
     state:{workspace_volume_id, profile_volume_id, attachment_generation}})
     -> {computer_id, attachment_generation, persistence:{workspace:true,profile:true}}
   release({computer_id, retain_state:true})
   delete_state({account, workspace_id, workspace_volume_id, profile_volume_id})
   ```

   The provisioner must check account/workspace ownership, enforce exclusive
   attachment and generation fencing, and retain state independently of machine
   deletion. Replacement must reattach the same IDs. Explicit authorized state
   deletion is separate from resource cleanup. Until then, replacement is clean,
   re-authentication may be needed, and Pi state alone survives.

2. **Scoped expiring live-view sessions — does not block the narrow autonomous
   typed-Duffel travel demo; blocks Take Over qualification.** Existing portal
   HTTP/WebSocket routing uses a static per-orb token, not a short-lived,
   mode-restricted session. Suggested resource API:

   ```text
   POST /computers/{computer_id}/view-sessions
     {request_id, account, workspace_id, mode:"read_only"|"interactive", ttl_seconds:300}
     -> {session_id, access_url, expires_at, mode}
   DELETE /computers/{computer_id}/view-sessions/{session_id}
   ```

   Authenticate the Burrow host and enforce owner scope, expiry, revocation and
   mode on every connection, including WebSocket upgrades and existing sessions.
   Credentials go only to the authenticated client, never to Pi or action logs.

Neither API substitutes for the separate browser engine, scoped network grants
and navigation policy. Research can use existing tools without either API;
booking/payment stay on typed Duffel/spend paths. This does not claim that a
travel demo or real computer qualification has passed.

## Changed files for this slice

```text
server/migrations/0064_burrow_computers.sql
server/src/api/burrow.rs
server/src/api/burrow/agent.rs
server/src/api/burrow/computer.rs
server/src/api/mod.rs
server/tests/burrow_agent.rs
worker/COMPUTERS.md
worker/README.md
worker/src/computer-contract.mjs
worker/src/computer-provider.mjs
worker/src/imorb-computer.mjs
worker/src/imorb-files.mjs
worker/src/runtime.mjs
worker/src/server.mjs
worker/test/computer-contract.test.mjs
worker/test/computer-provider.test.mjs
worker/test/computer-runtime.test.mjs
worker/test/fixtures/fake-computer.mjs
worker/test/fixtures/imorb-resource-cli.mjs
worker/test/imorb-computer.test.mjs
```

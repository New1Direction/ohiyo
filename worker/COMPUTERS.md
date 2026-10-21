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

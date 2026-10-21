import { createHash } from 'node:crypto';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { freePolicy, unauthenticatedTransport } from './opencode-free.mjs';
import { openRouterPolicy, openRouterPayload, openRouterTransport, verifyOpenRouterSelection,
  providerRestrictions, selectedEndpoint } from './openrouter-free.mjs';
import { routeModel, routedPayload, routedTransport, subscriptionTransport } from './routing.mjs';
import { subscriptionProvider } from './subscription-oauth.mjs';

const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

// One gate per task. No caller, including compaction, gets the underlying Models.
export function spendingGate({ db, models, identity, budgetMicros, policy, blocked, activity, stopped, campaign, runId,
  openRouterKey, verifyRoute = verifyOpenRouterSelection, routing, role, admission, resolveCredential,
  inferenceTransport, subscriptionAccounts, gatewayPrivacyConfirmed = false }) {
  db.exec(`CREATE TABLE IF NOT EXISTS paid_requests (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, reservation INTEGER NOT NULL,
    phase TEXT NOT NULL, response TEXT
  ); CREATE TABLE IF NOT EXISTS model_usage (
    id TEXT PRIMARY KEY, entry TEXT NOT NULL
  )`);
  const router = canonical(policy) === canonical(openRouterPolicy);
  const free = router || canonical(policy) === canonical(freePolicy);
  const requestKind = free || routing ? 'model' : 'paid';
  if (free && !campaign) throw new Error('The free development route requires a persistent campaign cap.');
  if (free || routing) db.exec('CREATE TABLE IF NOT EXISTS model_trace (id TEXT PRIMARY KEY, captured_at TEXT, request TEXT, response TEXT)');
  const uncertain = () => db.prepare("SELECT count(*) n FROM paid_requests WHERE phase='dispatching'").get().n > 0;
  const reserved = () => db.prepare('SELECT coalesce(sum(reservation),0) n FROM paid_requests').get().n;
  function deny(message) { blocked(message); throw new Error(message); }
  async function invoke(model, context, options = {}) {
    if (stopped()) deny('No new requests are authorized for this task.');
    if (uncertain()) deny(`Needs you: a ${requestKind} request has an unknown outcome. It will not be repeated.`);
    const id = await identity();
    // Inspection yields to controls; recheck before the synchronous reservation/dispatch.
    if (stopped()) deny('No new requests are authorized for this task.');
    if (uncertain()) deny(`Needs you: a ${requestKind} request has an unknown outcome. It will not be repeated.`);
    if (!id) deny('Needs you: the durable request identity could not be established.');
    let route, selectedRole, selectedPolicy = policy;
    if (routing) {
      if (model.provider !== `burrow-${role}` || model.id !== routing[role].canonicalModel) deny('Needs you: an unapproved model was requested.');
      selectedRole = id.startsWith('pi.compaction:') ? 'summary' : role;
      route = routing[selectedRole];
      model = routeModel(selectedRole, route);
      selectedPolicy = route;
    } else if (model.provider !== policy.provider || model.id !== policy.modelId || model.reasoning
      || model.api !== (free ? 'openai-completions' : 'openai-responses')
      || model.baseUrl !== (router ? 'https://openrouter.ai/api/v1'
        : free ? 'https://opencode.ai/inference/openai/v1' : 'https://api.openai.com/v1')) {
      deny('Needs you: this model is outside the approved spending policy.');
    }
    const fingerprint = createHash('sha256').update(canonical({ model: model.id, context, policy,
      ...(route ? { route, role: selectedRole } : {}) })).digest('hex');
    const subscription = subscriptionProvider(route);
    const saved = db.prepare('SELECT * FROM paid_requests WHERE id=?').get(id);
    if (saved) {
      if (saved.fingerprint !== fingerprint || saved.phase !== 'complete') deny('Needs you: recovered request does not match its saved acknowledgement.');
      return JSON.parse(saved.response);
    }
    if (subscription && db.prepare('SELECT count(*) n FROM paid_requests').get().n >= 20) {
      deny('Needs you: this task reached its 20-request limit. Revisions and summaries share this limit.');
    }
    // Reserve the full context window and capped output at operator-approved upper rates.
    // Reservations are NEVER refunded from untrusted/missing SDK usage reports.
    const inputRate = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite);
    if (!Number.isFinite(inputRate) || !Number.isFinite(model.cost.output)
      || inputRate > selectedPolicy.inputUsdPerMillion || model.cost.output > selectedPolicy.outputUsdPerMillion
      || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
      || (!subscription && model.compat?.supportsMaxOutputTokens === false)) deny('Needs you: a bounded model price/output contract is required.');
    const reservation = Math.ceil(model.contextWindow * selectedPolicy.inputUsdPerMillion
      + selectedPolicy.maxOutputTokens * selectedPolicy.outputUsdPerMillion);
    if (!Number.isSafeInteger(reservation) || (free ? reservation !== 0 : routing ? reservation < 0 : reservation <= 0) || reserved() + reservation > budgetMicros) {
      deny('Needs you: the approved model budget is exhausted.');
    }
    let eligibility, key, subscriptionAuth;
    if (router || route?.endpoint === 'https://openrouter.ai/api/v1/chat/completions') {
      if (routing && (!campaign || !gatewayPrivacyConfirmed)) deny('Needs you: the original campaign and gateway privacy confirmation are required.');
      try {
        if (routing) campaign.pin({ policy: openRouterPolicy, endpoint: selectedEndpoint, restrictions: providerRestrictions });
        eligibility = await verifyRoute();
      } catch { deny('Needs you: the pinned free route no longer meets its eligibility requirements.'); }
      if (stopped()) deny('No new requests are authorized for this task.');
      if (uncertain()) deny('Needs you: a model request has an unknown outcome. It will not be repeated.');
    }
    if (routing) {
      try {
        key = await resolveCredential({ owner: admission.owner, task: admission.task, root_goal: admission.root_goal,
          role: selectedRole, connectionId: route.connectionId });
        if (subscription) {
          subscriptionAuth = await subscriptionAccounts.auth(admission.owner, route, options.signal);
          key = subscriptionAuth.apiKey;
          subscriptionTransport(route, inferenceTransport);
        } else routedTransport(route, key, inferenceTransport);
      } catch { deny('Needs you: the saved model connection is no longer authorized. No fallback was attempted.'); }
      if (stopped()) deny('No new requests are authorized for this task.');
      if (uncertain()) deny('Needs you: a model request has an unknown outcome. It will not be repeated.');
    }
    if (reserved() + reservation > budgetMicros) deny('Needs you: the approved model budget is exhausted.');
    try { campaign?.admit('model', `${runId}:${id}`); } catch (error) { deny(error.message); }
    // Synchronous SQLite FULL commit completes before the first provider operation.
    const usageEntry = route ? { id, role: selectedRole, canonicalModel: model.id, providerModelId: route.providerModelId,
      connectionId: route.connectionId, fundedBy: route.fundedBy, reservationMicros: reservation,
      status: 'dispatching', usage: null, reportedCostMicros: null, costSource: subscription ? 'subscription' : 'sdk-estimate' } : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("INSERT INTO paid_requests VALUES(?,?,?,'dispatching',NULL)").run(id, fingerprint, reservation);
      if (usageEntry) db.prepare('INSERT INTO model_usage VALUES(?,?)').run(id, JSON.stringify(usageEntry));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (free || routing) db.prepare('INSERT INTO model_trace VALUES(?,?,?,NULL)').run(id, new Date().toISOString(),
      canonical({ model: model.id, context, ...(route ? { route, role: selectedRole } : {}),
        ...(eligibility ? { endpoint: selectedEndpoint, restrictions: providerRestrictions, eligibility } : {}) }));
    activity('Reading and comparing the saved information…');
    let response;
    try {
      response = await models.completeSimple(model, context, {
        ...options, maxTokens: selectedPolicy.maxOutputTokens, maxRetries: 0,
        transport: 'sse', deferred: false, cacheRetention: 'none', timeoutMs: 60000,
        ...(subscription ? { ...subscriptionAuth, env: {}, headers: subscriptionAuth.headers ?? {},
          fetch: subscriptionTransport(route, inferenceTransport), onPayload: undefined, onResponse: undefined } : routing ? { apiKey: 'managed-by-burrow', env: {}, headers: {},
          transformHeaders: () => ({}), fetch: routedTransport(route, key, inferenceTransport),
          onPayload: payload => routedPayload(route, payload), onResponse: undefined } : free ? { apiKey: 'not-a-credential', env: {}, headers: {},
          transformHeaders: () => ({}), fetch: router ? openRouterTransport(openRouterKey) : unauthenticatedTransport(),
          onPayload: router ? openRouterPayload : payload => ({ ...payload, thinking: { type: 'disabled' } }), onResponse: undefined } : {}),
      });
    } catch {
      deny(`Needs you: a ${requestKind} request has an unknown outcome. It will not be repeated.`);
    }
    // An upstream error may echo credentials; never persist or return that echo.
    if (router || routing) response = JSON.parse(JSON.stringify(response).replaceAll(key ?? openRouterKey, '[redacted]'));
    if (free || routing) db.prepare('UPDATE model_trace SET response=? WHERE id=?').run(JSON.stringify(response), id);
    if (response.stopReason === 'error' || response.stopReason === 'aborted' || response.stopReason === 'deferred') {
      deny(`Needs you: a ${requestKind} request did not return a usable acknowledgement. Its reservation is retained.`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE paid_requests SET phase='complete',response=? WHERE id=?").run(JSON.stringify(response), id);
      if (usageEntry) {
        const usage = response.usage;
        const known = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(n => Number.isFinite(n) && n > 0);
        const cost = usage?.cost?.total;
        Object.assign(usageEntry, { status: 'complete', usage: known ? usage : null,
          reportedCostMicros: !subscription && known && Number.isFinite(cost) && cost >= 0 ? Math.ceil(cost * 1_000_000) : null });
        db.prepare('UPDATE model_usage SET entry=? WHERE id=?').run(JSON.stringify(usageEntry), id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return response;
  }
  function stream(model, context, options) {
    const output = new AssistantMessageEventStream();
    void invoke(model, context, options).then(message => {
      output.push({ type: 'done', reason: message.stopReason, message });
      output.end(message);
    }).catch(error => {
      const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error', errorMessage: error.message, timestamp: Date.now() };
      output.push({ type: 'error', reason: 'error', error: message }); output.end(message);
    });
    return output;
  }
  const forbidden = () => { throw new Error('This paid operation is not approved.'); };
  return {
    uncertain, reserved, usage: () => db.prepare('SELECT entry FROM model_usage ORDER BY rowid').all().map(row => JSON.parse(row.entry)),
    models: new Proxy(models, { get(target, key) {
      if (key === 'streamSimple' || key === 'stream') return stream;
      if (key === 'completeSimple' || key === 'complete') return (m, c, o) => stream(m, c, o).result();
      if (['generateImages', 'classify', 'streamDeferred', 'fetchDeferred', 'cancelDeferred'].includes(key)) return forbidden;
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }),
  };
}

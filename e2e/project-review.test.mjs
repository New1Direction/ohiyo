// Real browser -> HTTP -> SQLite -> Pi Durable -> restricted validator.
// Only inference is scripted. Run against a disposable server configured with
// worker/test/fixtures/project-worker.mjs <state-dir> school, Node 26+, and
// KIKKA_USER_ID=*. Explicit opt-in prevents accidentally using a live model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import JSZip from '../client/node_modules/jszip/lib/index.js';
import { launchBrowser, ORIGIN, PASS, uniq, shot } from './harness.mjs';
if (process.env.KIKKA_PROJECT_FIXTURE !== '1') { console.log('SKIP project review: requires the disposable school fixture stack and KIKKA_PROJECT_FIXTURE=1.'); process.exit(0); }
const API = process.env.KIKKA_API ?? 'http://localhost:3000/api/v1';
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = []; page.on('pageerror', e => errors.push(e.message));
async function decideClick(button, action) {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/proposals/') && r.request().method() === 'POST' && r.request().postDataJSON().action === action),
    button.click(),
  ]);
  assert.equal(response.status(), 200);
}
async function call(path, token, body) {
  return fetch(`${API}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const id = uniq();
try {
  const owner = await (await call('/auth/register', null, { username: `parent_${id}`, password: PASS })).json();
  assert.ok(owner.token, JSON.stringify(owner));
  const routing = await (await call('/burrow/model-routing', owner.token)).json();
  for (const role of ['general', 'research', 'review', 'summary']) {
    assert.equal(routing.preview?.[role]?.connectionId, 'school-fixture', 'refuse a non-fixture model route');
    assert.equal(routing.preview[role].endpoint, 'https://example.com/v1/chat/completions');
    assert.equal(routing.preview[role].providerModelId, 'school');
  }
  await page.goto(`${ORIGIN}/burrow`);
  await page.evaluate(({ API, token }) => sessionStorage.setItem(`burrow:session:${API}`, token), { API, token: owner.token });
  await page.reload();
  await page.getByLabel('New task for Kikka').fill('Help me create a water cycle presentation for a year 5 class.');
  await page.getByLabel('Create or select a project').fill(`School ${id}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Project plan', { exact: true }).click();
  await page.getByRole('heading', { name: 'Your project plan', exact: true }).waitFor();
  const task = new URL(page.url()).searchParams.get('task'); assert.ok(task);
  const reviewPath = `/burrow/tasks/${task}`;
  const saved = page.getByRole('region', { name: 'Saved project plan', exact: true });
  const read = async () => (await call(`${reviewPath}/specs`, owner.token)).json();
  assert.equal((await call(`${reviewPath}/agent`, owner.token)).status, 404, 'saving must not start AI');
  await page.getByRole('button', { name: 'Write a plan', exact: true }).click();
  const plan = 'Six slides for year 5 about the water cycle. Short sentences. No student names or photos.';
  await page.waitForFunction(() => document.activeElement?.id === 'project-plan-draft');
  await page.getByLabel('Your proposed plan').fill(plan);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('button', { name: 'Use this plan', exact: true }).waitFor();
  assert.equal((await read()).spec.content, '', 'proposal is not an approval');
  assert.match(await saved.innerText(), /Start with a plan/);
  await decideClick(page.getByRole('button', { name: 'Use this plan', exact: true }), 'approve');
  assert.equal((await read()).spec.revision, 1);
  await page.reload();
  await page.getByText('Project plan', { exact: true }).click();
  await saved.getByText(plan, { exact: true }).waitFor();
  await shot(page, 'project-plan');
  await page.getByText('Project plan', { exact: true }).click();
  const consent = page.getByRole('checkbox', { name: /Let Kikka suggest/ });
  assert.equal(await consent.isChecked(), false, 'new tools require explicit consent');
  assert.equal(await page.getByLabel('Message Kikka', { exact: true }).isDisabled(), true);
  assert.doesNotMatch(await page.locator('.project-writing').innerText(), /Pi Durable|Regional page|tax details|SQLITE|sandbox|runtime_id/);
  await shot(page, 'project-draft-permission');
  await consent.check();
  const [startRequest] = await Promise.all([
    page.waitForRequest(r => r.url().endsWith(`${reviewPath}/agent`) && r.method() === 'POST'),
    page.getByRole('button', { name: 'Allow & start chat', exact: true }).click(),
  ]);
  assert.equal(startRequest.postDataJSON().allow_project_knowledge, true);
  await page.getByRole('button', { name: 'Next slide', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole('button', { name: 'Draft', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Plan', exact: true }).count(), 0);
  assert.match(await page.locator('.burrow-result').innerText(), /Slide 1: The water cycle/);
  assert.doesNotMatch(await page.locator('.burrow-result').innerText(), /proposal|installed|scripted|runtime/i);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('button', { name: 'Next slide', exact: true }).scrollIntoViewIfNeeded();
  const nextSlideBox = await page.getByRole('button', { name: 'Next slide', exact: true }).boundingBox();
  assert.ok(nextSlideBox);
  assert.equal(await page.evaluate(({ x, y, width, height }) => document.elementFromPoint(x + width / 2, y + height / 2)?.closest('button')?.getAttribute('aria-label'), nextSlideBox), 'Next slide', 'composer must never cover slide controls');
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await page.getByRole('heading', { name: 'Slide 2: Evaporation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Read all', exact: true }).click();
  await page.getByRole('heading', { name: 'Slide 6: Sources', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Slide view', exact: true }).click();
  await page.getByRole('button', { name: 'Previous slide', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'project-draft');
  // Classroom review is a separate, human-owned decision. Saving and reading
  // sources never authorize a model, and AI suggestions never approve export.
  const presentation = () => call(`${reviewPath}/presentation`, owner.token).then(r => r.json());
  const reviewPanel = page.getByLabel('Presentation review and download', { exact: true });
  assert.equal((await call(`${reviewPath}/presentation/export`, owner.token)).status, 409);
  await reviewPanel.locator(':scope > summary').click();
  await reviewPanel.getByLabel('Age or school year', { exact: true }).fill('Year 5 · ages 9–10');
  await reviewPanel.getByRole('button', { name: 'Add source', exact: true }).click();
  await reviewPanel.getByLabel('Claim or slide', { exact: true }).fill('Slide 2: the sun warms water, causing evaporation.');
  await reviewPanel.getByLabel('Source title', { exact: true }).fill('USGS · The water cycle');
  await reviewPanel.getByLabel('Source web address', { exact: true }).fill('https://www.usgs.gov/special-topics/water-science-school/science/water-cycle');
  await reviewPanel.getByLabel('Supporting excerpt', { exact: true }).fill('The sun provides energy that drives the water cycle.');
  assert.equal(await reviewPanel.getByRole('button', { name: 'Approve for school use', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await reviewPanel.isVisible(), false, 'material edits cannot approve an unfinished version');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await reviewPanel.getByLabel('Supporting excerpt').inputValue(), 'The sun provides energy that drives the water cycle.', 'opening the material editor cannot discard unsaved citations');
  await reviewPanel.getByRole('checkbox', { name: /I read this source/ }).check();
  await reviewPanel.getByRole('button', { name: 'Save review notes', exact: true }).click();
  await reviewPanel.getByText('Sources and audience saved. School use is not approved.', { exact: true }).waitFor();
  assert.equal((await presentation()).evaluation, null, 'saving sources never starts AI');
  await page.reload();
  await reviewPanel.locator(':scope > summary').click();
  assert.equal(await reviewPanel.getByLabel('Age or school year').inputValue(), 'Year 5 · ages 9–10');
  assert.match(await reviewPanel.getByLabel('Supporting excerpt').inputValue(), /sun provides energy/);
  await reviewPanel.getByText('Ask AI for a second opinion · optional', { exact: true }).click();
  const allowReview = reviewPanel.getByRole('button', { name: 'Allow one AI review', exact: true });
  await allowReview.waitFor();
  assert.equal(await allowReview.isDisabled(), true);
  await reviewPanel.getByLabel('AI review limit (US cents)').fill('0');
  await reviewPanel.getByRole('checkbox', { name: /Share this saved material/ }).check();
  await reviewPanel.getByLabel('AI review limit (US cents)').fill('1');
  assert.equal(await reviewPanel.getByRole('checkbox', { name: /Share this saved material/ }).isChecked(), false, 'a changed budget invalidates consent');
  await reviewPanel.getByLabel('AI review limit (US cents)').fill('0');
  await reviewPanel.getByRole('checkbox', { name: /Share this saved material/ }).check();
  await shot(page, 'presentation-consent');
  const [evaluationRequest] = await Promise.all([
    page.waitForRequest(r => r.url().endsWith('/presentation/evaluate') && r.method() === 'POST'), allowReview.click(),
  ]);
  assert.equal(evaluationRequest.postDataJSON().max_cost_cents, 0);
  await reviewPanel.getByText(/One AI review requested/).waitFor();
  let evaluated;
  for (let attempt = 0; attempt < 30; attempt++) {
    evaluated = await presentation();
    if (evaluated.evaluation?.state === 'draft_ready') break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(evaluated.evaluation.state, 'draft_ready', JSON.stringify(evaluated));
  assert.equal(evaluated.approved, false);
  assert.match(evaluated.evaluation.result, /source \[1\]/);
  await reviewPanel.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await reviewPanel.getByText('AI suggestions · not a fact check', { exact: true }).waitFor();
  assert.equal(await reviewPanel.getByRole('button', { name: 'Download PowerPoint', exact: true }).count(), 0);
  assert.equal((await call(`${reviewPath}/presentation/evaluate`, owner.token, evaluationRequest.postDataJSON())).status, 409, 'replay cannot reset the request or budget');
  const report = await (await call(`/burrow/tasks/${evaluated.evaluation.id}/agent`, owner.token)).json();
  assert.equal(report.agent.project_knowledge, false);
  assert.equal(report.commands.length, 0);
  assert.equal(report.agent.max_cost_cents, 0);
  for (const label of [/I checked the factual claims/, /I checked the language/, /I approve this saved version/]) await reviewPanel.getByRole('checkbox', { name: label }).check();
  await reviewPanel.getByRole('button', { name: 'Approve for school use', exact: true }).click();
  const downloadButton = reviewPanel.getByRole('button', { name: 'Download PowerPoint', exact: true });
  await downloadButton.waitFor();
  await downloadButton.scrollIntoViewIfNeeded();
  await shot(page, 'presentation-approved');
  const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
  assert.equal(download.suggestedFilename(), 'presentation.pptx');
  const zip = await JSZip.loadAsync(readFileSync(await download.path()));
  const slidePaths = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  assert.equal(slidePaths.length, 7, 'six outline slides plus an attested source');
  const exportedText = (await Promise.all(slidePaths.map(p => zip.file(p).async('string')))).join('');
  assert.match(exportedText, /Evaporation/); assert.match(exportedText, /USGS/); assert.match(exportedText, /sun provides energy/);
  assert.match(await zip.file('ppt/notesSlides/notesSlide2.xml').async('string'), /puddle drying/);
  await reviewPanel.getByRole('button', { name: 'Withdraw approval', exact: true }).click();
  assert.equal((await presentation()).approved, true, 'opening confirmation never withdraws');
  await reviewPanel.getByRole('button', { name: 'Keep approval', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await downloadButton.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot(page, 'presentation-approved-narrow');
  await page.setViewportSize({ width: 1280, height: 900 });
  await reviewPanel.getByRole('button', { name: 'Withdraw approval', exact: true }).click();
  await reviewPanel.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  await reviewPanel.getByText(/School-use approval withdrawn/).waitFor();
  assert.equal((await call(`${reviewPath}/presentation/export`, owner.token)).status, 409);
  assert.equal((await presentation()).history.at(-1).status, 'withdrawn');
  assert.equal((await presentation()).evaluation.id, evaluated.evaluation.id, 'withdrawal does not reset AI consent or its allowance');
  await reviewPanel.locator(':scope > summary').click();
  // Editing retains exactly the saved material, never status or permission copy.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const draft = page.getByLabel('Edit material');
  assert.doesNotMatch(await draft.inputValue(), /proposal|installed|scripted|runtime/i);
  const manual = '## My classroom introduction\nAsk: Where does rain come from?';
  await draft.fill(manual);
  await page.getByText('Project plan', { exact: true }).click();
  await page.getByText('Project plan', { exact: true }).click();
  assert.equal(await draft.inputValue(), manual, 'opening project details preserves unsaved edits');
  await page.getByRole('button', { name: 'Save edits', exact: true }).click();
  await page.getByRole('heading', { name: 'My classroom introduction', exact: true }).waitFor();
  await page.getByLabel('Message Kikka', { exact: true }).fill('Add a short class question.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Review revision', exact: true }).waitFor({ timeout: 30000 });
  assert.match(await page.getByRole('region', { name: 'Saved material', exact: true }).innerText(), /My classroom introduction/);
  await page.getByRole('button', { name: 'Review revision', exact: true }).click();
  await page.getByRole('button', { name: 'Keep my edits', exact: true }).click();
  await page.getByText('Kept your edited result. No work was started.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'My classroom introduction', exact: true }).waitFor();
  await page.getByText('Your earlier messages', { exact: true }).click();
  await page.getByText('Add a short class question.', { exact: true }).waitFor();
  await page.getByText('Project plan', { exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Project plan', { exact: true }).click();
  await page.getByRole('button', { name: 'Allow a check', exact: true }).waitFor();
  await shot(page, 'project-proposals');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Allow a check', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot(page, 'project-mobile-review');
  await page.setViewportSize({ width: 1280, height: 900 });
  let snapshot = await read();
  const skill = snapshot.proposals.find(p => p.kind === 'skill'); assert.ok(skill, 'real Pi must propose a skill');
  assert.equal((await call(`${reviewPath}/proposals/${encodeURIComponent(skill.id)}`, owner.token, { action: 'test' })).status, 409, 'testing before approval forbidden');
  await decideClick(page.getByRole('button', { name: 'Allow a check', exact: true }), 'approve');
  await page.getByRole('button', { name: 'Check helper', exact: true }).waitFor();
  assert.equal((await read()).proposals.find(p => p.id === skill.id).status, 'approved', 'approval must not run a test');
  await decideClick(page.getByRole('button', { name: 'Check helper', exact: true }), 'test');
  await page.getByText(/Format check passed/).waitFor();
  assert.equal((await read()).proposals.find(p => p.id === skill.id).status, 'tested');
  assert.equal(await page.getByRole('button', { name: 'Check helper', exact: true }).count(), 0);
  await shot(page, 'project-skill-tested');
  const skillCard = page.getByRole('region', { name: 'Suggested helper', exact: true });
  await skillCard.getByRole('button', { name: 'Undo approval', exact: true }).click();
  await decideClick(skillCard.getByRole('button', { name: 'Confirm undo', exact: true }), 'rollback');
  assert.equal((await read()).proposals.find(p => p.id === skill.id).status, 'rolled_back');
  assert.equal((await call(`${reviewPath}/proposals/${encodeURIComponent(skill.id)}`, owner.token, { action: 'test' })).status, 409);
  const proposed = snapshot.proposals.find(p => p.kind === 'spec' && p.status === 'pending'); assert.ok(proposed);
  const proposalCard = page.locator('.project-proposal').filter({ has: page.getByText(proposed.content, { exact: true }) });
  await decideClick(proposalCard.getByRole('button', { name: 'Use this plan', exact: true }), 'approve');
  assert.equal((await read()).spec.revision, 2);
  await page.getByText('Previous decisions', { exact: true }).click();
  await proposalCard.getByRole('button', { name: 'Undo approval', exact: true }).click();
  await decideClick(proposalCard.getByRole('button', { name: 'Confirm undo', exact: true }), 'rollback');
  snapshot = await read(); assert.equal(snapshot.spec.content, plan); assert.equal(snapshot.history.length, 3);
  await page.getByText('Project plan', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit plan', exact: true }).click();
  await page.getByLabel('Your proposed plan').fill('Unwanted change: twenty slides.');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await decideClick(page.getByRole('button', { name: 'Decline', exact: true }), 'reject');
  assert.equal((await read()).spec.content, plan);
  // Account ownership is enforced by the real API, not button visibility.
  const other = await (await call('/auth/register', null, { username: `other_${id}`, password: PASS })).json();
  for (const [path, body] of [[`${reviewPath}/specs`], [`${reviewPath}/presentation`], [`${reviewPath}/presentation/export`], [`${reviewPath}/proposals`, { kind: 'spec', base_revision: 3, content: 'Foreign edit' }], [`${reviewPath}/proposals/${encodeURIComponent(proposed.id)}`, { action: 'rollback' }]]) {
    assert.equal((await call(path, other.token, body)).status, 404);
  }
  assert.equal((await call(`${reviewPath}/specs`, null)).status, 401);
  assert.equal((await call(`${reviewPath}/presentation/export`, null)).status, 401);
  const foreign = await (await call('/burrow/tasks', other.token, { request: 'Other school', project: `School ${id}` })).json();
  assert.equal((await (await call(`/burrow/tasks/${foreign.id}/specs`, other.token)).json()).spec.revision, 0);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  assert.equal(await page.locator('#burrow-projects option').getAttribute('value'), `School ${id}`);
  await page.getByLabel('New task for Kikka').fill('Create a handout for the same class.');
  await page.getByLabel('Create or select a project').fill(`School ${id}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Project plan', { exact: true }).click();
  await saved.getByText(plan, { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile page must not overflow horizontally');
  await shot(page, 'project-mobile');
  // Chromium touch emulation, not a claim about a physical Android/iOS device.
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  try {
    await touch.goto(page.url());
    await touch.evaluate(({ API, token }) => sessionStorage.setItem(`burrow:session:${API}`, token), { API, token: owner.token });
    await touch.reload();
    assert.equal(await touch.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    const optional = touch.getByRole('checkbox', { name: /Let Kikka suggest/ });
    assert.equal(await optional.isChecked(), false);
    await optional.tap(); assert.equal(await optional.isChecked(), true);
    await touch.getByText('Project plan', { exact: true }).tap();
    await touch.getByRole('button', { name: 'Edit plan', exact: true }).tap();
    await touch.waitForFunction(() => document.activeElement?.id === 'project-plan-draft');
    assert.equal(await touch.getByLabel('Your proposed plan').inputValue(), plan);
    await touch.getByRole('button', { name: 'Cancel', exact: true }).tap();
    assert.equal((await call(`/burrow/tasks/${new URL(page.url()).searchParams.get('task')}/agent`, owner.token)).status, 404, 'touching optional permission never starts AI');
  } finally { await touch.close(); }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  // New chat focuses the composer on the next animation frame. Wait for that
  // focus handoff before editing a different field (Playwright fill uses keys).
  await page.waitForFunction(() => document.activeElement?.id === 'burrow-request');
  await page.getByLabel('Create or select a project').fill('');
  await page.getByLabel('New task for Kikka').fill('Help me plan a class activity.');
  await page.getByLabel('New task for Kikka').press('Enter');
  await page.getByRole('region', { name: 'Chat permission', exact: true }).waitFor();
  const personalId = new URL(page.url()).searchParams.get('task');
  assert.equal((await call(`/burrow/tasks/${personalId}/agent`, owner.token)).status, 404, 'Enter saves without starting AI');
  assert.equal((await (await call(`/burrow/tasks/${personalId}/specs`, owner.token)).json()).spec.project, 'Personal', 'no project name is required');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('combobox', { name: 'Reply type', exact: true }).selectOption('page');
  await page.getByLabel('Create or select a project').fill(`School ${id}`);
  await page.getByLabel('New task for Kikka').fill('Make an interactive water cycle lesson.');
  await page.getByLabel('New task for Kikka').press('Enter');
  await page.getByRole('region', { name: 'Page permission', exact: true }).waitFor();
  const pageId = new URL(page.url()).searchParams.get('task');
  const pageTask = (await (await call('/burrow', owner.token)).json()).tasks.find(t => t.id === pageId);
  assert.equal(pageTask.format, 'creation');
  assert.equal(pageTask.project, `School ${id}`);
  assert.equal(pageTask.state, 'waiting');
  assert.equal(JSON.parse(pageTask.result).page, null, 'choosing a page never starts generation');
  assert.equal((await call(`/burrow/tasks/${pageId}/run`, owner.token, { version: pageTask.version, allow_generation: false })).status, 400);
  assert.equal((await call(`/burrow/tasks/${pageId}/run`, other.token, { version: pageTask.version, allow_generation: true })).status, 404);
  await shot(page, 'inline-page-permission');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByText('More ways to work', { exact: true }).click();
  await page.getByRole('button', { name: /Behind the address bar/ }).click();
  await page.getByRole('button', { name: 'Next step →', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'A name, not a destination yet', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next step →', exact: true }).click();
  await page.getByRole('heading', { name: 'Turn the name into an IP address', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Preview', exact: true }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Ask Kikka for a change', exact: true }).count(), 1);
  await page.getByRole('textbox', { name: 'Ask Kikka for a change', exact: true }).fill('Keep this classroom example.');
  await page.getByText('About this page', { exact: true }).click();
  await page.getByRole('heading', { name: 'Turn the name into an IP address', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Ask Kikka for a change', exact: true }).inputValue(), 'Keep this classroom example.');
  await page.getByText('About this page', { exact: true }).click();
  await page.getByRole('heading', { name: 'Turn the name into an IP address', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, 'inline-page');
  await page.setViewportSize({ width: 390, height: 844 });
  const nextStep = page.getByRole('button', { name: 'Next step →', exact: true });
  await nextStep.scrollIntoViewIfNeeded();
  const stepBox = await nextStep.boundingBox(); assert.ok(stepBox);
  assert.equal(await page.evaluate(({ x, y, width, height }) => document.elementFromPoint(x + width / 2, y + height / 2)?.closest('button')?.textContent, stepBox), await nextStep.textContent(), 'inline controls must not be covered by the composer');
  await nextStep.focus(); await nextStep.press('Enter');
  await page.getByRole('heading', { name: 'Make a secure connection', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot(page, 'inline-page-narrow');
  await page.getByRole('textbox', { name: 'Ask Kikka for a change', exact: true }).fill('');
  await page.reload();
  await page.getByRole('heading', { name: 'What happens after Enter?', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'A name, not a destination yet', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Ask Kikka for a change', exact: true }).count(), 1, 'saved page reloads in chat; local play progress resets');
  assert.deepEqual(errors, []);
  console.log('PASS: project chat, citations, separate one-response AI consent, immutable budget, human school-use sign-off, real PPTX download fidelity, withdrawal, persistence, protected edits, sandbox, rollback, account isolation, keyboard and Chromium touch; no installs or activations.');
} catch (error) {
  await shot(page, 'project-review-failure'); throw error;
} finally { await browser.close(); }

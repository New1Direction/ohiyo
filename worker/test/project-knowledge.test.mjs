import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { KikkaWorker } from '../src/runtime.mjs';
import { testSkill } from '../src/skill-sandbox.mjs';

const policy = { provider: 'openai', modelId: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, maxOutputTokens: 4096 };
const usage = { input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (content, stopReason = 'stop') => ({ role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-4o-mini', timestamp: Date.now(), content, stopReason, usage });
async function settled(worker,id) {
  for (let n=0;n<300;n++) {
    if ((await worker.status(id)).state==='Completed') return;
    await new Promise(r=>setTimeout(r,10));
  }
  throw new Error(`Pi did not settle: ${JSON.stringify(await worker.status(id))}`);
}
test('Pi reads scoped specs, journals proposals once across reopen, and never acquires approval tools', async t => {
  const directory=await mkdtemp(join(tmpdir(),'burrow-specs-'));
  let calls=0;
  const packet='Project spec revision 7: Preserve private chat and Pi Durable.';
  const worker=new KikkaWorker({ directory,policy,approvedUrls:[],modelsFactory:()=>{
    const m=createModels();m.setProvider(openaiProvider());
    m.completeSimple=async(_model,input)=>{
      calls++;
      const tools=getCurrentTools(input.messages).map(t=>t.name);
      assert.ok(!tools.some(t=>/approve|install|skill_test|shell/.test(t)));
      const results=input.messages.filter(m=>m.role==='toolResult');
      if (!tools.includes('read_project_spec')) return answer([{type:'text',text:'No project tools authorized.'}]);
      if (!results.length) return answer([{type:'toolCall',id:'read-spec',name:'read_project_spec',arguments:{}}],'toolUse');
      assert.ok(JSON.stringify(results[0]).includes(packet));
      if (results.length===1) return answer([{type:'toolCall',id:'propose-spec',name:'propose_project_change',arguments:{kind:'spec',base_revision:7,content:'Preserve private chat; no automatic installation.'}}],'toolUse');
      return answer([{type:'text',text:'Pending human review, not applied.'}]);
    };return m;
  }});
  t.after(async()=>{await worker.close();await rm(directory,{recursive:true,force:true});});
  const base={owner:'alice',task:'project',root_goal:'root',goal:'Propose intent edits',max_cost_cents:25,burrow_context:packet};
  const id=await worker.start({...base,project_knowledge:true});
  await settled(worker,id);
  const proposals=(await worker.events(id)).filter(e=>e.type==='project_proposal');
  assert.equal(proposals.length,1);
  assert.equal(proposals[0].data.proposal.base_revision,7);
  const before=calls;
  await worker.close();await worker.recover();
  assert.equal(calls,before);
  assert.deepEqual((await worker.events(id)).filter(e=>e.type==='project_proposal'),proposals);
  const unapproved=await worker.start({...base,task:'without-tools',root_goal:'without-tools'});
  await settled(worker,unapproved);
  assert.equal((await worker.events(unapproved)).filter(e=>e.type==='project_proposal').length,0);
});

test('guidance sandbox checks boundaries without evaluating candidate code or permitting tool manifests', async () => {
  const content=JSON.stringify({name:'Evidence',description:'Show sources',instructions:'process.exit(77); import("node:fs").then(fs=>fs.writeFileSync("owned","bad"));'});
  if (Number(process.versions.node.split('.')[0])<26) {
    await assert.rejects(testSkill(content),/Node 26/);return;
  }
  assert.deepEqual(await testSkill(content),{passed:true,scope:'structural-only',installed:false});
  for(const candidate of ['null','{bad',JSON.stringify({name:'bad',description:'bad',instructions:'bad',tools:['shell']}),JSON.stringify({name:'bad',description:'bad',instructions:'x'.repeat(6001)})]) {
    await assert.rejects(testSkill(candidate),/Sandbox checks failed/);
  }
  await assert.rejects(testSkill('x'.repeat(8001)),/Invalid skill/);
});

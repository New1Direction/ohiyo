// Real worker/Pi/sandbox; deterministic inference only, no provider or browser IO.
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { KikkaWorker } from '../../src/runtime.mjs';
import { workerServer } from '../../src/server.mjs';
import { routedModels } from '../../src/routing.mjs';
const school = process.argv[3] === 'school';
const worker=new KikkaWorker({ directory:process.argv[2],approvedUrls:[],
  routingEnabled: school, resolveCredential: async () => 'fixture-not-a-real-provider-key',
  inferenceTransport: async () => { throw new Error('Fixture forbids network inference.'); },
  policy:{provider:'openai',modelId:'gpt-4o-mini',inputUsdPerMillion:0.15,outputUsdPerMillion:0.6,maxOutputTokens:4096},
  modelsFactory:(_policy,routing)=>{
    const models=school ? routedModels(routing) : createModels();
    if (!school) models.setProvider(openaiProvider());
    models.completeSimple=async(_model,input)=>{
      const results=input.messages.filter(m=>m.role==='toolResult');
      if (school && !input.tools?.length && JSON.stringify(input).includes('source-grounded private practice draft')) {
        const packet = input.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'text').map(p => { try { return JSON.parse(p.text); } catch { return null; } }).find(p => p?.material && p?.objective);
        if (!packet || !packet.material.includes('The sun warms water.')) throw new Error('Expected selected water-cycle material, not project memory.');
        return { role:'assistant',api:_model.api,provider:_model.provider,model:_model.id,timestamp:Date.now(),
          content:[{type:'text',text:JSON.stringify({objective:packet.objective,
            explanation:{text:'Water moves through a repeating cycle. Warming turns some liquid into vapour; cooling forms tiny drops.',quote:'Water vapour cools and forms tiny drops in clouds.'},
            worked_example:{text:'Think of a lake after rain: water collects there, and later some can return to the air as vapour.',quote:'Water collects in rivers, lakes and oceans. The cycle continues.'},
            questions:[
              {question:'A puddle gets smaller on a sunny day. Where can some of its water go?',options:['It stops existing.','Into the air as water vapour.','Only into clouds as solid ice.'],answer:1,explanation:'Warming can turn liquid water into vapour. Smaller does not mean the water stopped existing.',quote:'The sun warms water. Some water turns into water vapour.'},
              {question:'Water vapour in the air cools. Which change helps form a cloud?',options:['It forms tiny liquid drops.','It becomes warmer liquid in a river.','It permanently disappears.'],answer:0,explanation:'Cooling water vapour forms tiny drops in clouds; warming and disappearing are different claims.',quote:'Water vapour cools and forms tiny drops in clouds.'},
              {question:'Rain has collected in a lake. What can happen as the cycle continues?',options:['The water cycle must stop.','All water must stay liquid forever.','Some water can later become vapour again.'],answer:2,explanation:'Collected water can take part in evaporation again; collecting is not the end of the cycle.',quote:'Water collects in rivers, lakes and oceans. The cycle continues.'}
            ]})}],stopReason:'stop',usage:{input:20,output:20,cacheRead:0,cacheWrite:0,totalTokens:40,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
      }
      if (school && !input.tools?.length && JSON.stringify(input).includes('source support')) return {
        role:'assistant',api:_model.api,provider:_model.provider,model:_model.id,timestamp:Date.now(),
        content:[{type:'text',text:'Factual concerns: check evaporation against source [1]. Source support: the supplied excerpt supports the claim, but I have not opened the source. Age suitability: short sentences suit Year 5. Clarity: add a class question. This is advisory, not school-use approval.'}],stopReason:'stop',
        usage:{input:20,output:20,cacheRead:0,cacheWrite:0,totalTokens:40,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
      };
      if (school && !JSON.stringify(input).includes('Six slides')) throw new Error('Expected approved school plan in model context.');
      const base = school ? 1 : 0;
      const steps=[['read_project_spec',{}],['propose_project_change',{kind:'spec',base_revision:base,content:school ? 'Six slides for year 5 about the water cycle. Add speaker notes and a sources slide. No student names or photos.' : 'Private chat. Optional AI. Keep Pi Durable.'}],
        ['propose_project_change',{kind:'skill',base_revision:base,content:JSON.stringify({name:'Cite sources',description:'Ground every claim',instructions:'Cite evidence; mark unsupported facts unknown.'})}]];
      return {role:'assistant',api:_model.api,provider:_model.provider,model:_model.id,timestamp:Date.now(),
        content:results.length<steps.length?[{type:'toolCall',id:`step-${results.length}`,name:steps[results.length][0],arguments:steps[results.length][1]}]:[{type:'text',text:school ? '## Slide 1: The water cycle\nWater moves between the land, air and oceans.\n\n**Speaker notes:** Ask the class where rain comes from.\n\n## Slide 2: Evaporation\nThe sun warms water. Some water turns into water vapour.\n\n**Speaker notes:** Think of a puddle drying after a sunny day.\n\n## Slide 3: Condensation\nWater vapour cools and forms tiny drops in clouds.\n\n## Slide 4: Rain and snow\nWater falls from clouds as rain or snow.\n\n## Slide 5: Back to the start\nWater collects in rivers, lakes and oceans. The cycle continues.\n\n**Class question:** What might happen to a puddle on a warm day?\n\n## Slide 6: Sources\nAdd teacher-approved sources and check the facts before presenting.' : 'Proposals await human review. Nothing installed.'}],
        stopReason:results.length<steps.length?'toolUse':'stop',
        usage:{input:20,output:20,cacheRead:0,cacheWrite:0,totalTokens:40,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    };return models;
  }});
const server=workerServer(worker,'fixture-token-not-a-secret-000000000');
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,sandbox:Number(process.versions.node.split('.')[0])>=26})));
process.once('SIGTERM',async()=>{server.close();await worker.close();process.exit(0);});

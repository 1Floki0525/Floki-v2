'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');

const APP_ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(APP_ROOT, 'backend', 'floki-local-api.cjs');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-chat-local-fixture-'));
  write(path.join(root, 'src/chat/floki-chat.cjs'), `'use strict'; module.exports={createRuntime(){return {fixture:true}}};\n`);
  write(path.join(root, 'src/chat/floki-live-chat-interface.cjs'), `'use strict'; module.exports={startKnowledgeAutoload(){return {ok:true,fixture:true}},async handleTypedText(_runtime,text,options={}){const events=[['request_accepted',0],['cached_vision_ready',3],['memory_context_ready',7],['model_dispatched',10],['first_response_chunk',15],['first_safe_public_text',20],['final_model_output',35],['schema_valid',36],['broca_ready',37],['response_completed',40]].map(([event,elapsed_ms])=>({event,trace_id:'trace-fixture',turn_id:'turn-fixture',wall_clock_timestamp:new Date().toISOString(),elapsed_ms,elapsed_from_previous_ms:4})); for(const event of events){options.on_latency_event?.(event);} const reply='Fixture reply: '+text; options.on_public_text?.({text:reply}); return {ok:true,reply,trace_id:'trace-fixture',latency_events:events};}};\n`);
  write(path.join(root, 'src/chat/chat-mode-status.cjs'), `'use strict'; module.exports={buildChatModeStatus(){return {ok:true,qwen_cognition:{model:'fixture-model'},lifecycle_status:{state:'awake',is_asleep:false}}}};\n`);
  write(path.join(root, 'src/chat/floki-lifecycle-status.cjs'), `'use strict'; module.exports={buildFlokiLifecycleStatus(){return {state:'awake',is_awake:true,is_asleep:false,is_dreaming:false,is_rem_dreaming:false,current_rem_cycle_number:null,last_transition_at:new Date().toISOString(),sleep_cycle_scheduler_running:true}}};\n`);
  write(path.join(root, 'src/chat/dream-status.cjs'), `'use strict'; const path=require('node:path'); module.exports={buildDreamStatus(){return {current_time_utc:new Date().toISOString(),dream_index_file:path.join(process.env.FLOKI_PROJECT_ROOT,'dream-index.jsonl'),latest_dream_title:null}}};\n`);
  write(path.join(root, 'src/vision/chat-webcam-vision-service.cjs'), `'use strict'; module.exports={readChatWebcamVisionStatus(){return {active:true,ready_for_chat:true,measured_capture_fps:40,last_frame_timestamp:new Date().toISOString(),service_heartbeat:new Date().toISOString(),last_fatal_error:null,last_vlm_error:null}},readLatestPrivateObservation(){return {available:true,fresh:true,stale:false,observation_age_ms:1000,latest_private_observation_timestamp:new Date().toISOString(),source:'webcam',sight_scope:'maker_world_external',observation_summary:'A fixture room is visible.',unavailable_reason:null}}};\n`);
  write(path.join(root, 'src/util/fs-safe.cjs'), `'use strict'; const path=require('node:path'); module.exports={statePath(...parts){return path.join(process.env.FLOKI_PROJECT_ROOT,'state/floki',...parts)}};\n`);
  write(path.join(root, 'src/config/floki-config.cjs'), `'use strict'; module.exports={getPathConfig(){return {chat_runtime_root:'state/floki/chat/runtime'}}};\n`);
  write(path.join(root, 'state/floki/affect.json'), JSON.stringify({updated_at:new Date().toISOString(),core:{valence:0.2,arousal:0.4,dominance:0.3},emotions:{trust:0.8,curiosity:0.7,hope:0.6,fear:0.1,frustration:0.1,attachment:0.5,uncertainty:0.2},mood:{label:'curious'},regulation:{sleep_pressure:0.2}}));
  write(path.join(root, 'state/floki/chat/runtime/chat-mode-loop.pid'), String(process.pid));
  write(path.join(root, 'dream-index.jsonl'), '');
  return root;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('backend exited early with code ' + child.exitCode);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return response.json();
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('backend fixture did not become healthy');
}

async function wsChat(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('websocket chat timed out')); }, 10000);
    socket.on('open', () => socket.send(JSON.stringify({type:'chat.send',data:{requestId:'request-fixture',text:'hello'}})));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'chat.error') {
        clearTimeout(timer); socket.close(); reject(new Error(message.data.error));
      }
      if (message.type === 'chat.complete' && message.data.requestId === 'request-fixture') {
        clearTimeout(timer); socket.close(); resolve(message.data);
      }
    });
    socket.on('error', reject);
  });
}

async function run() {
  const root = fixtureRoot();
  const port = 17700 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [BACKEND], {
    cwd: APP_ROOT,
    env: {...process.env,FLOKI_PROJECT_ROOT:root,FLOKI_CHAT_LOCAL_PORT:String(port),NODE_ENV:'test',FLOKI_CHAT_LOCAL_ALLOW_TEST_NODE:'1'},
    stdio: ['ignore','pipe','pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const health = await waitForHealth(base, child);
    assert.equal(health.marker, 'FLOKI_V2_CHAT_LOCAL_API_HEALTH_PASS');
    const routes = ['/api/status','/api/vision/frame','/api/vision/observation','/api/emotions','/api/sleep','/api/services','/api/dreams/timeline','/api/neural/events'];
    for (const route of routes) {
      const response = await fetch(base + route);
      assert.equal(response.ok, true, route + ' must succeed');
      await response.json();
    }
    const frame = await (await fetch(base + '/api/vision/frame')).json();
    assert.equal(frame.rawFrameAvailable, false);
    assert.equal(frame.objects.length, 0);
    const chat = await wsChat(`ws://127.0.0.1:${port}/ws`);
    assert.equal(chat.content, 'Fixture reply: hello');
    assert.equal(chat.traceId, 'trace-fixture');
    assert.ok(chat.latency.totalResponseTime >= 40);
    const source = fs.readFileSync(BACKEND, 'utf8').toLowerCase();
    assert.equal(source.includes(['base','44'].join('')), false);
    assert.equal(source.includes(['mock','adapter'].join('')), false);
    console.log(JSON.stringify({ok:true,marker:'FLOKI_V2_CHAT_LOCAL_INTEGRATION_PASS',rest_routes:routes.length,websocket_chat:true,raw_frame_fabricated:false,node:process.version}, null, 2));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(root, {recursive:true,force:true});
  }
  if (stderr.trim()) process.stderr.write(stderr);
}

run().catch((error) => {
  console.error(JSON.stringify({ok:false,marker:'FLOKI_V2_CHAT_LOCAL_INTEGRATION_FAIL',error:error.message}, null, 2));
  process.exit(1);
});

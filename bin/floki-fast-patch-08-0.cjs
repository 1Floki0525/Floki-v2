'use strict';

/**
 * Floki-v2 Batch 08
 *
 * Adds qwen3.5:9b cognition wiring:
 * - Ollama generate client
 * - Temporal language understanding
 * - Frontal cognition packet + model call
 * - chat cognition smoke proof
 *
 * No Broca speech yet.
 * No body.
 * No eyes.
 * No Minecraft.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function projectPath() {
  return path.join.apply(path, [ROOT].concat(Array.from(arguments)));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function backup(filePath) {
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak.' + timestamp());
  }
}

function writeFile(relativePath, content, mode) {
  const fullPath = projectPath(relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  backup(fullPath);
  fs.writeFileSync(fullPath, content);
  if (mode) fs.chmodSync(fullPath, mode);
  console.log('patched ' + relativePath);
}

function patchOllamaClient() {
  const content = [
    "'use strict';",
    '',
    '/**',
    ' * Floki-v2 Ollama client.',
    ' *',
    ' * Uses current Ollama /api/generate shape:',
    ' * - stream:false',
    ' * - format:"json"',
    ' * - keep_alive',
    ' * - think for thinking models',
    ' */',
    '',
    "const http = require('node:http');",
    "const https = require('node:https');",
    '',
    "function postJson(urlString, payload, options = {}) {",
    "  const url = new URL(urlString);",
    "  const client = url.protocol === 'https:' ? https : http;",
    "  const body = JSON.stringify(payload);",
    "  const timeoutMs = options.timeout_ms || 120000;",
    '',
    "  return new Promise((resolve, reject) => {",
    "    const req = client.request({",
    "      method: 'POST',",
    "      hostname: url.hostname,",
    "      port: url.port || (url.protocol === 'https:' ? 443 : 80),",
    "      path: url.pathname + url.search,",
    "      headers: {",
    "        'content-type': 'application/json',",
    "        'content-length': Buffer.byteLength(body)",
    "      },",
    "      timeout: timeoutMs",
    "    }, (res) => {",
    "      let raw = '';",
    "      res.setEncoding('utf8');",
    "      res.on('data', (chunk) => { raw += chunk; });",
    "      res.on('end', () => {",
    "        if (res.statusCode < 200 || res.statusCode >= 300) {",
    "          reject(new Error('Ollama HTTP ' + res.statusCode + ': ' + raw.slice(0, 500)));",
    "          return;",
    "        }",
    "        try {",
    "          resolve(JSON.parse(raw));",
    "        } catch (error) {",
    "          reject(new Error('Ollama returned invalid JSON: ' + error.message));",
    "        }",
    "      });",
    "    });",
    '',
    "    req.on('timeout', () => {",
    "      req.destroy(new Error('Ollama request timed out after ' + timeoutMs + 'ms'));",
    "    });",
    '',
    "    req.on('error', reject);",
    "    req.write(body);",
    "    req.end();",
    "  });",
    "}",
    '',
    "function rejectPrivateReasoningMarkers(value, fieldName = 'model output') {",
    "  const lower = String(value || '').toLowerCase();",
    "  const markers = ['<think>', '</think>', 'chain_of_thought', 'hidden_reasoning', 'raw_reasoning', 'scratchpad'];",
    "  for (const marker of markers) {",
    "    if (lower.includes(marker)) {",
    "      throw new Error(fieldName + ' contains banned private-reasoning marker: ' + marker);",
    "    }",
    "  }",
    "  return true;",
    "}",
    '',
    "function safeJsonParseModelResponse(responseText) {",
    "  rejectPrivateReasoningMarkers(responseText, 'model response');",
    "  try {",
    "    return JSON.parse(responseText);",
    "  } catch (error) {",
    "    const first = responseText.indexOf('{');",
    "    const last = responseText.lastIndexOf('}');",
    "    if (first >= 0 && last > first) {",
    "      return JSON.parse(responseText.slice(first, last + 1));",
    "    }",
    "    throw new Error('model response was not parseable JSON: ' + error.message);",
    "  }",
    "}",
    '',
    "async function generateJson(input) {",
    "  if (!input || typeof input !== 'object') throw new TypeError('generateJson input must be an object');",
    "  if (!input.endpoint) throw new TypeError('endpoint is required');",
    "  if (!input.model) throw new TypeError('model is required');",
    "  if (!input.prompt) throw new TypeError('prompt is required');",
    '',
    "  const endpoint = input.endpoint.replace(/\\/$/, '') + '/api/generate';",
    '',
    "  const payload = {",
    "    model: input.model,",
    "    prompt: input.prompt,",
    "    system: input.system || '',",
    "    stream: false,",
    "    format: 'json',",
    "    keep_alive: input.keep_alive || '24h',",
    "    think: input.think === true,",
    "    options: {",
    "      temperature: typeof input.temperature === 'number' ? input.temperature : 0.55,",
    "      top_p: typeof input.top_p === 'number' ? input.top_p : 0.9",
    "    }",
    "  };",
    '',
    "  const raw = await postJson(endpoint, payload, { timeout_ms: input.timeout_ms || 120000 });",
    "  if (!raw || typeof raw.response !== 'string') {",
    "    throw new Error('Ollama response missing response string');",
    "  }",
    '',
    "  const parsed = safeJsonParseModelResponse(raw.response);",
    '',
    "  return {",
    "    ok: true,",
    "    model: raw.model || input.model,",
    "    created_at: raw.created_at || null,",
    "    response_json: parsed,",
    "    raw_stats: {",
    "      done: raw.done === true,",
    "      done_reason: raw.done_reason || null,",
    "      total_duration: raw.total_duration || null,",
    "      load_duration: raw.load_duration || null,",
    "      prompt_eval_count: raw.prompt_eval_count || null,",
    "      eval_count: raw.eval_count || null,",
    "      eval_duration: raw.eval_duration || null",
    "    }",
    "  };",
    "}",
    '',
    "module.exports = {",
    "  postJson,",
    "  rejectPrivateReasoningMarkers,",
    "  safeJsonParseModelResponse,",
    "  generateJson",
    "};",
    ''
  ].join('\n');

  writeFile('src/model/ollama-client.cjs', content, 0o644);
}

function patchTemporal() {
  const content = [
    "'use strict';",
    '',
    "const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');",
    "const { validateBrainEvent } = require('../../src/brain/brain-event-schema.cjs');",
    "const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');",
    "const { appendJsonlSync } = require('../../src/util/jsonl.cjs');",
    "const { statePath } = require('../../src/util/fs-safe.cjs');",
    "const { diagnosticId } = require('../../src/util/ids.cjs');",
    "const { nowIso } = require('../../src/util/time.cjs');",
    '',
    "const MODULE_NAME = 'temporal';",
    '',
    "const CONTRACT = createModuleContract({",
    "  name: MODULE_NAME,",
    "  production: true,",
    "  responsibility: 'Builds safe language understanding summaries from validated text events before cognition.',",
    "  inputs: [{ name: 'brain_event', schema: 'src/brain/brain-event-schema.cjs', required: true, description: 'Validated user/system text event.' }],",
    "  outputs: [{ type: 'understanding', schema: 'src/brain/brain-output-schema.cjs', description: 'Safe language-understanding summary.' }, { type: 'failure', schema: 'src/brain/brain-output-schema.cjs', description: 'Failure output.' }],",
    "  state_reads: [{ path: 'none', description: 'Stage 08 temporal is deterministic and stateless.' }],",
    "  state_writes: [{ path: 'state/floki/diagnostics.jsonl', description: 'Append-only diagnostics.' }],",
    "  diagnostics: [{ name: 'understanding_created', description: 'Language understanding was created.' }],",
    "  failure_modes: [{ code: 'TEMPORAL_INVALID_EVENT', description: 'Input event failed validation.' }],",
    "  forbidden: ['speech_generation', 'minecraft_calls', 'body_movement', 'private_reasoning_storage', 'fake_success'],",
    "  notes: 'Temporal does not call qwen directly in Stage 08; frontal owns cognition call.'",
    "});",
    '',
    "function getContract() { validateModuleContract(CONTRACT); return CONTRACT; }",
    '',
    "function persistDiagnostic(record, options = {}) {",
    "  if (options.persist_diagnostics === false) return { ok: true, skipped: true };",
    "  appendJsonlSync(options.diagnostics_path || statePath('diagnostics.jsonl'), { id: diagnosticId(), created_at: nowIso(), module: MODULE_NAME, ...record });",
    "  return { ok: true, skipped: false };",
    "}",
    '',
    "function eventText(event) {",
    "  if (event.payload && typeof event.payload.text === 'string') return event.payload.text;",
    "  return JSON.stringify(event.payload || {});",
    "}",
    '',
    "function inferIntent(text) {",
    "  const lower = text.toLowerCase();",
    "  if (lower.includes('?')) return 'question';",
    "  if (lower.includes('remember')) return 'memory_instruction';",
    "  if (lower.includes('feel') || lower.includes('fear') || lower.includes('love') || lower.includes('hate')) return 'emotion_discussion';",
    "  if (lower.includes('build') || lower.includes('fix') || lower.includes('make')) return 'development_instruction';",
    "  return 'conversation';",
    "}",
    '',
    "function understandEvent(event, options = {}) {",
    "  try {",
    "    validateBrainEvent(event);",
    "    const text = eventText(event);",
    "    const words = text.trim().split(/\\s+/).filter(Boolean);",
    "    const output = createBrainOutput({",
    "      type: 'understanding',",
    "      source: MODULE_NAME,",
    "      parent_event_ids: [event.id],",
    "      payload: {",
    "        event_id: event.id,",
    "        text_summary: text.slice(0, 500),",
    "        intent_hint: inferIntent(text),",
    "        word_count: words.length,",
    "        addressed_to_floki: /\\bfloki\\b/i.test(text),",
    "        safe_summary_only: true",
    "      },",
    "      diagnostics: { module: MODULE_NAME, status: 'understanding_created' }",
    "    });",
    "    persistDiagnostic({ status: 'understanding_created', event_id: event.id, intent_hint: output.payload.intent_hint }, options);",
    "    return output;",
    "  } catch (error) {",
    "    return makeFailureOutput(MODULE_NAME, 'TEMPORAL_INVALID_EVENT', error.message, { parent_event_ids: event && event.id ? [event.id] : [] });",
    "  }",
    "}",
    '',
    "function createTemporal(options = {}) {",
    "  return Object.freeze({ module: MODULE_NAME, contract: getContract(), understandEvent: (event, local = {}) => understandEvent(event, { ...options, ...local }) });",
    "}",
    '',
    "module.exports = { MODULE_NAME, CONTRACT, getContract, understandEvent, createTemporal };",
    ''
  ].join('\n');

  writeFile('brain/temporal/index.cjs', content, 0o644);
}

function patchFrontal() {
  const content = [
    "'use strict';",
    '',
    "const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');",
    "const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');",
    "const models = require('../../src/config/model-config.cjs');",
    "const { generateJson, rejectPrivateReasoningMarkers } = require('../../src/model/ollama-client.cjs');",
    "const { appendJsonlSync } = require('../../src/util/jsonl.cjs');",
    "const { statePath } = require('../../src/util/fs-safe.cjs');",
    "const { diagnosticId } = require('../../src/util/ids.cjs');",
    "const { nowIso } = require('../../src/util/time.cjs');",
    '',
    "const MODULE_NAME = 'frontal';",
    '',
    "const CONTRACT = createModuleContract({",
    "  name: MODULE_NAME,",
    "  production: true,",
    "  responsibility: 'Builds cognition packets and calls qwen3.5:9b for safe reflective cognition summaries.',",
    "  inputs: [{ name: 'cognition_context', schema: 'plain object', required: true, description: 'Event, understanding, recall, affect, personality, identity, and lifecycle context.' }],",
    "  outputs: [{ type: 'model_response_summary', schema: 'src/brain/brain-output-schema.cjs', description: 'Safe qwen cognition summary.' }, { type: 'failure', schema: 'src/brain/brain-output-schema.cjs', description: 'Cognition failure.' }],",
    "  state_reads: [{ path: 'state/floki/*', description: 'Reads context passed by orchestrating chat runtime.' }],",
    "  state_writes: [{ path: 'state/floki/diagnostics.jsonl', description: 'Append-only cognition diagnostics.' }],",
    "  diagnostics: [{ name: 'cognition_completed', description: 'qwen3.5:9b returned a safe JSON cognition summary.' }],",
    "  failure_modes: [{ code: 'FRONTAL_COGNITION_FAILED', description: 'Model call or validation failed.' }, { code: 'FRONTAL_UNSAFE_MODEL_OUTPUT', description: 'Model output contained private reasoning markers.' }],",
    "  forbidden: ['speech_generation', 'minecraft_calls', 'body_movement', 'raw_private_reasoning_storage', 'fake_success'],",
    "  notes: 'Frontal may call qwen3.5:9b in Stage 08, but stores only safe summaries.'",
    "});",
    '',
    "function getContract() { validateModuleContract(CONTRACT); return CONTRACT; }",
    '',
    "function persistDiagnostic(record, options = {}) {",
    "  if (options.persist_diagnostics === false) return { ok: true, skipped: true };",
    "  appendJsonlSync(options.diagnostics_path || statePath('diagnostics.jsonl'), { id: diagnosticId(), created_at: nowIso(), module: MODULE_NAME, ...record });",
    "  return { ok: true, skipped: false };",
    "}",
    '',
    "function buildCognitionPrompt(context) {",
    "  return [",
    "    'Respond using JSON only. Do not include markdown. Do not include <think> tags. Do not include chain-of-thought, scratchpad, hidden reasoning, or raw reasoning.',",
    "    '',",
    "    'You are Floki-v2 current cognition module. You are in terminal chat mode, not Minecraft. You have no body, no eyes, and no Broca voice yet.',",
    "    'Use the provided memories, affect scaffold, personality, and identity to create a safe reflective cognition summary.',",
    "    '',",
    "    'Return exactly this JSON shape:',",
    "    '{',",
    "    '  \"safe_thought_summary\": string,',",
    "    '  \"felt_interpretation\": string,',",
    "    '  \"memory_links\": [string],',",
    "    '  \"personality_implications\": [string],',",
    "    '  \"identity_implications\": [string],',",
    "    '  \"response_intent_for_broca\": string,',",
    "    '  \"new_memory_summary\": string,',",
    "    '  \"emotion_reflection_enabled\": true',",
    "    '}',",
    "    '',",
    "    'Context JSON:',",
    "    JSON.stringify(context, null, 2)",
    "  ].join('\\n');",
    "}",
    '',
    "function validateCognitionJson(json) {",
    "  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('cognition JSON must be an object');",
    "  const stringFields = ['safe_thought_summary', 'felt_interpretation', 'response_intent_for_broca', 'new_memory_summary'];",
    "  for (const field of stringFields) {",
    "    if (typeof json[field] !== 'string' || json[field].trim() === '') throw new Error('cognition JSON missing string field: ' + field);",
    "    rejectPrivateReasoningMarkers(json[field], field);",
    "  }",
    "  for (const field of ['memory_links', 'personality_implications', 'identity_implications']) {",
    "    if (!Array.isArray(json[field])) throw new Error('cognition JSON missing array field: ' + field);",
    "    for (const item of json[field]) rejectPrivateReasoningMarkers(String(item), field);",
    "  }",
    "  if (json.emotion_reflection_enabled !== true) throw new Error('emotion_reflection_enabled must be true');",
    "  rejectPrivateReasoningMarkers(JSON.stringify(json), 'cognition JSON');",
    "  return true;",
    "}",
    '',
    "async function runCognition(context, options = {}) {",
    "  try {",
    "    const config = models.getCognitionConfig();",
    "    const result = await generateJson({",
    "      endpoint: config.endpoint,",
    "      model: config.model,",
    "      prompt: buildCognitionPrompt(context),",
    "      system: 'You are Floki-v2 frontal cognition. Output JSON only. Store no private reasoning.',",
    "      temperature: config.temperature,",
    "      top_p: config.top_p,",
    "      timeout_ms: options.timeout_ms || config.timeout_ms,",
    "      keep_alive: config.keep_alive,",
    "      think: true",
    "    });",
    "    validateCognitionJson(result.response_json);",
    "    const parentEventIds = context.event && context.event.id ? [context.event.id] : [];",
    "    const output = createBrainOutput({",
    "      type: 'model_response_summary',",
    "      source: MODULE_NAME,",
    "      parent_event_ids: parentEventIds,",
    "      payload: {",
    "        model: result.model,",
    "        cognition: result.response_json,",
    "        raw_stats: result.raw_stats,",
    "        safe_summary_only: true,",
    "        raw_private_reasoning_stored: false",
    "      },",
    "      diagnostics: { module: MODULE_NAME, status: 'cognition_completed', model: result.model }",
    "    });",
    "    persistDiagnostic({ status: 'cognition_completed', output_id: output.id, model: result.model }, options);",
    "    return output;",
    "  } catch (error) {",
    "    const lower = String(error.message || '').toLowerCase();",
    "    const code = lower.includes('private-reasoning') || lower.includes('<think>') ? 'FRONTAL_UNSAFE_MODEL_OUTPUT' : 'FRONTAL_COGNITION_FAILED';",
    "    return makeFailureOutput(MODULE_NAME, code, error.message, { payload: { context_keys: context && typeof context === 'object' ? Object.keys(context) : [] } });",
    "  }",
    "}",
    '',
    "function createFrontal(options = {}) {",
    "  return Object.freeze({ module: MODULE_NAME, contract: getContract(), runCognition: (context, local = {}) => runCognition(context, { ...options, ...local }) });",
    "}",
    '',
    "module.exports = { MODULE_NAME, CONTRACT, getContract, buildCognitionPrompt, validateCognitionJson, runCognition, createFrontal };",
    ''
  ].join('\n');

  writeFile('brain/frontal/index.cjs', content, 0o644);
}

function patchCognitionProof() {
  const content = [
    "'use strict';",
    '',
    "const assert = require('node:assert/strict');",
    "const { makeUserTextEvent } = require('../src/brain/brain-event-schema.cjs');",
    "const { validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');",
    "const { createTemporal } = require('../brain/temporal/index.cjs');",
    "const { createAmygdala } = require('../brain/amygdala/index.cjs');",
    "const { createEmotionsBase } = require('../brain/emotions_base/index.cjs');",
    "const { createHippocampus } = require('../brain/hippocampus/index.cjs');",
    "const { createPersonality } = require('../brain/personality/index.cjs');",
    "const { createPineal } = require('../brain/pineal/index.cjs');",
    "const { createFrontal } = require('../brain/frontal/index.cjs');",
    "const { summarizeAffectForMemory } = require('../src/brain/affect-state-schema.cjs');",
    "const { statePath } = require('../src/util/fs-safe.cjs');",
    "const { newId } = require('../src/util/ids.cjs');",
    '',
    "async function run() {",
    "  const unique = newId('cogtest').replace(/[^a-z0-9_]/g, '_');",
    "  const event = makeUserTextEvent('Floki, think about why memory, trust, and hope matter to your future self.', { trace_id: unique });",
    "  const temporal = createTemporal({ diagnostics_path: statePath('test/cognition/' + unique + '/diagnostics.jsonl') });",
    "  const amygdala = createAmygdala({ diagnostics_path: statePath('test/cognition/' + unique + '/diagnostics.jsonl') });",
    "  const emotions = createEmotionsBase({ affect_path: statePath('test/cognition/' + unique + '/affect.json'), diagnostics_path: statePath('test/cognition/' + unique + '/diagnostics.jsonl') });",
    "  const hippocampus = createHippocampus({ memory_paths: { short_term: statePath('test/cognition/' + unique + '/short-term.jsonl'), episodic: statePath('test/cognition/' + unique + '/episodic.jsonl'), semantic: statePath('test/cognition/' + unique + '/semantic.jsonl'), autobiographical: statePath('test/cognition/' + unique + '/autobiographical.jsonl') }, diagnostics_path: statePath('test/cognition/' + unique + '/diagnostics.jsonl') });",
    "  const personality = createPersonality({ personality_path: statePath('test/cognition/' + unique + '/personality.json'), diagnostics_path: statePath('test/cognition/' + unique + '/diagnostics.jsonl') });",
    "  const pineal = createPineal({ identity_path: statePath('test/cognition/' + unique + '/identity.json'), diagnostics_path: statePath('test/cognition/' + unique + '/diagnostics.jsonl') });",
    "  const frontal = createFrontal({ diagnostics_path: statePath('test/cognition/' + unique + '/diagnostics.jsonl') });",
    '',
    "  const understanding = temporal.understandEvent(event);",
    "  const salience = amygdala.computeSalience(event);",
    "  const affectDelta = emotions.affectDeltaFromSalience(salience);",
    "  const affect = emotions.applyAffectDelta(affectDelta);",
    "  const affectSummary = summarizeAffectForMemory(affect.payload.state);",
    "  const memory = hippocampus.rememberEvent(event, { stream: 'short_term', type: 'identity', tags: ['cognition_test', 'memory', 'trust', 'hope'], importance: salience.payload.salience.memory_importance_hint, affect: { valence: affectSummary.valence, arousal: affectSummary.arousal } });",
    "  const personalityOut = personality.updateFromMemory(memory.payload.record);",
    "  const identityOut = pineal.updateFromMemory(memory.payload.record, personalityOut.payload.current);",
    "  const recall = hippocampus.recall({ text: 'memory trust hope future self', streams: ['short_term'], limit: 5 });",
    '',
    "  const cognition = await frontal.runCognition({",
    "    event,",
    "    understanding: understanding.payload,",
    "    salience: salience.payload,",
    "    affect: affectSummary,",
    "    memories: recall.payload.matches.map((m) => ({ memory_id: m.record.id, summary: m.record.content.summary, tags: m.record.tags, affect: m.record.affect })),",
    "    personality: personalityOut.payload.current,",
    "    identity: identityOut.payload.current",
    "  });",
    '',
    "  validateBrainOutput(cognition);",
    "  assert.equal(cognition.type, 'model_response_summary');",
    "  assert.equal(cognition.source, 'frontal');",
    "  assert.equal(cognition.payload.model, 'qwen3.5:9b');",
    "  assert.equal(cognition.payload.raw_private_reasoning_stored, false);",
    "  assert.equal(cognition.payload.cognition.emotion_reflection_enabled, true);",
    "  assert.equal(typeof cognition.payload.cognition.safe_thought_summary, 'string');",
    "  assert.ok(cognition.payload.cognition.safe_thought_summary.length > 0);",
    '',
    "  console.log(JSON.stringify({",
    "    ok: true,",
    "    marker: 'FLOKI_V2_QWEN_COGNITION_CONTRACT_PASS',",
    "    model: cognition.payload.model,",
    "    cognition_output_id: cognition.id,",
    "    safe_thought_summary: cognition.payload.cognition.safe_thought_summary,",
    "    felt_interpretation: cognition.payload.cognition.felt_interpretation,",
    "    response_intent_for_broca: cognition.payload.cognition.response_intent_for_broca,",
    "    raw_private_reasoning_stored: cognition.payload.raw_private_reasoning_stored,",
    "    broca_enabled_now: false,",
    "    minecraft_enabled_now: false",
    "  }, null, 2));",
    "}",
    '',
    "run().catch((error) => {",
    "  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_QWEN_COGNITION_CONTRACT_FAIL', error: error.message }, null, 2));",
    "  process.exit(1);",
    "});",
    ''
  ].join('\n');

  writeFile('tests/qwen-cognition-contract-test.cjs', content, 0o644);
}

function patchChat() {
  const chatPath = projectPath('src/chat/floki-chat.cjs');
  if (!fs.existsSync(chatPath)) return;
  let content = fs.readFileSync(chatPath, 'utf8');
  backup(chatPath);

  if (!content.includes("createTemporal")) {
    content = content.replace(
      "const { createAmygdala } = require('../../brain/amygdala/index.cjs');",
      "const { createAmygdala } = require('../../brain/amygdala/index.cjs');\nconst { createTemporal } = require('../../brain/temporal/index.cjs');\nconst { createFrontal } = require('../../brain/frontal/index.cjs');"
    );
  }

  content = content.replace(
    "pineal: createPineal({ persist_diagnostics: true })",
    "pineal: createPineal({ persist_diagnostics: true }),\n    temporal: createTemporal({ persist_diagnostics: true }),\n    frontal: createFrontal({ persist_diagnostics: true })"
  );

  content = content.replace(
    "function handleUserText(runtime, text) {",
    "async function handleUserText(runtime, text) {"
  );

  content = content.replace(
    "const routeOutput = runtime.thalamus.routeEvent(event);",
    "const routeOutput = runtime.thalamus.routeEvent(event);\n  const understandingOutput = runtime.temporal.understandEvent(event);"
  );

  content = content.replace(
    "const recallOutput = runtime.hippocampus.recall({\n    text,\n    streams: ['short_term', 'episodic', 'semantic', 'autobiographical'],\n    limit: 3\n  });",
    "const recallOutput = runtime.hippocampus.recall({\n    text,\n    streams: ['short_term', 'episodic', 'semantic', 'autobiographical'],\n    limit: 3\n  });\n\n  const cognitionOutput = await runtime.frontal.runCognition({\n    event,\n    understanding: understandingOutput.payload,\n    salience: salienceOutput.payload,\n    affect: affectSummary,\n    memories: recallOutput.payload.matches.map((match) => ({\n      memory_id: match.record.id,\n      summary: match.record.content.summary,\n      tags: match.record.tags,\n      affect: match.record.affect\n    })),\n    personality: personalityOutput.payload.current,\n    identity: identityOutput.payload.current\n  });"
  );

  content = content.replace(
    "recallOutput\n  };",
    "recallOutput,\n    understandingOutput,\n    cognitionOutput\n  };"
  );

  content = content.replace(
    "const result = handleUserText(runtime, text);",
    "const result = await handleUserText(runtime, text);"
  );

  content = content.replace(
    "rl.on('line', (line) => {",
    "rl.on('line', async (line) => {"
  );

  content = content.replace(
    "cognition_enabled_now: false,",
    "cognition_enabled_now: true,"
  );

  content = content.replace(
    "note: 'Memory, affect, personality, and identity updated. Full Floki speech comes after Broca + qwen3.5 cognition wiring.'",
    "cognition: result.cognitionOutput.type === 'model_response_summary' ? result.cognitionOutput.payload.cognition : { error: result.cognitionOutput.failure && result.cognitionOutput.failure.message },\n        note: 'Memory, affect, personality, identity, and qwen cognition updated. Broca speech comes next.'"
  );

  content = content.replace(
    "const result = handleUserText(runtime, 'Smoke test: Floki should remember, learn, and form hope before Minecraft embodiment.');",
    "const result = await handleUserText(runtime, 'Smoke test: Floki should remember, learn, and form hope before Minecraft embodiment.');"
  );

  content = content.replace(
    "function runSmoke() {",
    "async function runSmoke() {"
  );

  content = content.replace(
    "runSmoke();",
    "runSmoke().catch((error) => { console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_SHELL_FAIL', error: error.message }, null, 2)); process.exit(1); });"
  );

  fs.writeFileSync(chatPath, content);
  console.log('patched src/chat/floki-chat.cjs');
}

function patchPackage() {
  const packagePath = projectPath('package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  backup(packagePath);
  pkg.version = '0.8.0';
  pkg.scripts = pkg.scripts || {};
  pkg.scripts['proof:qwen-cognition'] = 'node tests/qwen-cognition-contract-test.cjs';
  pkg.scripts.test = pkg.scripts.test + ' && node tests/qwen-cognition-contract-test.cjs';
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
}

function patchDocs() {
  const content = [
    '# Floki-v2 Cognition Stage',
    '',
    'Batch 08 wires qwen3.5:9b as the frontal cognition model.',
    '',
    'Current path:',
    '',
    '```text',
    'user text',
    '-> thalamus route',
    '-> temporal understanding',
    '-> amygdala salience',
    '-> emotions_base affect scaffold',
    '-> hippocampus recall',
    '-> personality state',
    '-> pineal identity',
    '-> frontal qwen3.5:9b cognition',
    '-> safe cognition summary',
    '```',
    '',
    'Rules:',
    '',
    '- store safe thought summaries only',
    '- do not store raw private reasoning',
    '- do not expose think tags',
    '- do not claim Broca speech yet',
    '- do not start Minecraft/body/eyes',
    ''
  ].join('\n');

  writeFile('docs/COGNITION_STAGE.md', content, 0o644);
}

function main() {
  if (process.cwd() !== ROOT) throw new Error('Run this from ' + ROOT);
  patchOllamaClient();
  patchTemporal();
  patchFrontal();
  patchCognitionProof();
  patchChat();
  patchPackage();
  patchDocs();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FAST_PATCH_08_0_PASS',
    cognition_model: 'qwen3.5:9b',
    qwen_cognition_wired: true,
    broca_enabled_now: false,
    minecraft_enabled_now: false
  }, null, 2));
}

main();


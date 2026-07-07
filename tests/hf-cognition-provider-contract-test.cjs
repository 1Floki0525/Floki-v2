"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const frontal = fs.readFileSync(path.join(root, "brain/frontal/index.cjs"), "utf8");
assert.match(frontal, /src\/model\/cognition-client\.cjs/);
assert.match(frontal, /provider:\s*config\.provider/);

const hfServer = fs.readFileSync(path.join(root, "src/model/hf_cognition_server.py"), "utf8");
assert.match(hfServer, /TextIteratorStreamer/);
assert.match(hfServer, /FLOKI_HF_COGNITION_MODEL_WARMED/);
assert.match(hfServer, /application\/x-ndjson/);

const service = fs.readFileSync(path.join(root, "bin/floki-hf-cognition-service.sh"), "utf8");
assert.match(service, /FLOKI_HF_COGNITION_SERVICE_WARM_PASS/);
assert.match(service, /hf_cognition_server\.py/);

const runtime = fs.readFileSync(path.join(root, "bin/floki-runtime.sh"), "utf8");
assert.match(runtime, /floki-hf-cognition-service\.sh"\s+start/);
assert.match(runtime, /floki-hf-cognition-service\.sh"\s+stop/);

for (const rel of ["config/chat.config.yaml", "config/chat.config.yaml.temp"]) {
  const yaml = fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(yaml, /models:\n\s+cognition:\n\s+provider:\s+huggingface/);
  assert.doesNotMatch(yaml, /model:\s*floki-qwen3\.5/);
  assert.match(yaml, /endpoint_default:\s+http:\/\/127\.0\.0\.1:11436/);
}


// FLOKI_HF_MULTIMODAL_PROVIDER_SOURCE_ASSERTS_V2
assert.match(hfServer, /AutoProcessor/);
assert.match(hfServer, /AutoModelForMultimodalLM/);
assert.match(hfServer, /AutoModelForCausalLM/);
assert.match(hfServer, /MULTIMODAL_ENABLED/);
assert.match(hfServer, /MULTIMODAL_LOADED/);
assert.match(hfServer, /FALLBACK_REASON/);
assert.match(hfServer, /decode_data_url_image/);
assert.match(hfServer, /data:image\//);
assert.match(hfServer, /apply_chat_template/);
assert.match(hfServer, /processor\.decode/);
assert.match(hfServer, /"multimodal_enabled"/);
assert.match(hfServer, /"multimodal_loaded"/);
assert.match(hfServer, /"load_kind"/);
assert.match(hfServer, /AutoProcessor\.from_pretrained\(MODEL_ID,\s*trust_remote_code=True\)/);
assert.match(hfServer, /AutoModelForMultimodalLM\.from_pretrained\(MODEL_ID,\s*\*\*kwargs\)/);
assert.match(hfServer, /AutoModelForCausalLM\.from_pretrained\(MODEL_ID,\s*\*\*kwargs\)/);
assert.match(hfServer, /chat_template_kwargs/);
assert.match(hfServer, /enable_thinking/);
assert.match(hfServer, /strip_visible_thinking/);
assert.match(hfServer, /apply_processor_chat_template/);
assert.doesNotMatch(hfServer, /Qwen\/Qwen|qwen3-vl|qwen3\.5:|localhost:11434|127\.0\.0\.1:11434|Omen/i);


console.log(JSON.stringify({
  ok: true,
  marker: "FLOKI_HF_COGNITION_PROVIDER_CONTRACT_PASS"
}, null, 2));


// Qwen3.5 cognition must remain thinking-enabled by default.
// Vision disables thinking per request; the HF server must not globally force
// enable_thinking=false for every cognition/RSI/self-improvement call.
assert.equal(
  hfServer.includes('kwargs["enable_thinking"] = env_flag("FLOKI_HF_ENABLE_THINKING", False)'),
  false,
  'HF cognition server must not default all callers to non-thinking mode'
);
assert.match(
  hfServer,
  /kwargs\["enable_thinking"\]\s*=\s*env_flag\("FLOKI_HF_ENABLE_THINKING",\s*True\)/,
  'HF cognition server must default cognition thinking to true unless caller opts out'
);

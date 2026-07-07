#!/usr/bin/env bash
set -Eeuo pipefail

# FLOKI_HF_EXISTING_MAX_MEMORY_FROM_YAML_V1
FLOKI_HF_SERVICE_PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOKI_HF_SERVICE_NODE_RUN="${NODE_RUN:-$FLOKI_HF_SERVICE_PROJECT/bin/floki-node24-run.sh}"

if [ -x "$FLOKI_HF_SERVICE_NODE_RUN" ] && [ -f "$FLOKI_HF_SERVICE_PROJECT/config/chat.config.yaml" ]; then
  FLOKI_HF_YAML_ENV="$(
    cd "$FLOKI_HF_SERVICE_PROJECT"
    bash "$FLOKI_HF_SERVICE_NODE_RUN" node - <<'NODE'
'use strict';
const { loadYamlFile } = require('./src/config/yaml-lite.cjs');
const raw = loadYamlFile('config/chat.config.yaml');
const hf = raw && raw.models && raw.models.cognition && raw.models.cognition.hf || {};

const gpuIndex = hf.gpu_index;
const gpuMaxMemory = hf.gpu_max_memory || (
  Number.isFinite(Number(hf.gpu_memory_limit_gib))
    ? String(Number(hf.gpu_memory_limit_gib)) + 'GiB'
    : ''
);
const cpuMaxMemory = hf.cpu_max_memory || '';

if (gpuIndex !== undefined && gpuIndex !== null && String(gpuIndex) !== '') {
  console.log('GPU_INDEX=' + JSON.stringify(String(gpuIndex)));
}
if (gpuMaxMemory) {
  console.log('GPU_MAX_MEMORY=' + JSON.stringify(String(gpuMaxMemory)));
}
if (cpuMaxMemory) {
  console.log('CPU_MAX_MEMORY=' + JSON.stringify(String(cpuMaxMemory)));
}
NODE
  )"
  if [ -n "$FLOKI_HF_YAML_ENV" ]; then
    eval "$FLOKI_HF_YAML_ENV"
  fi
fi

export GPU_INDEX GPU_MAX_MEMORY CPU_MAX_MEMORY


ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"
RUNTIME_ROOT="$ROOT/state/floki/chat/runtime"
PID_FILE="$RUNTIME_ROOT/hf-cognition-service.pid"
LOG_FILE="$RUNTIME_ROOT/hf-cognition-service.log"
mkdir -p "$RUNTIME_ROOT"
HF_PYTHON="${FLOKI_HF_COGNITION_PYTHON:-/media/binary-god/1tb-ssd/Floki-v2/state/floki/python-envs/hf-cognition/bin/python}"
if [ ! -x "$HF_PYTHON" ]; then
  printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_PYTHON_ENV_MISSING" "python=$HF_PYTHON" >&2
  exit 2
fi
export PYTHONNOUSERSITE="${PYTHONNOUSERSITE:-1}"

resolve_config_json() {
  bash "$NODE_RUN" node <<'NODE'
'use strict';
const { getCognitionConfig } = require('./src/config/model-config.cjs');
const cfg = getCognitionConfig('chat');
if (cfg.provider !== 'huggingface') {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: 'cognition provider is not huggingface', provider: cfg.provider }));
  process.exit(0);
}
const url = new URL(cfg.endpoint);
const hf = cfg.hf;
if (!hf || typeof hf !== 'object') {
  console.log(JSON.stringify({ ok: false, skipped: false, reason: 'models.cognition.hf runtime block is missing from YAML' }));
  process.exit(0);
}
console.log(JSON.stringify({
  ok: true,
  provider: cfg.provider,
  model: cfg.model,
  endpoint: cfg.endpoint,
  host: url.hostname || url.hostname,
  port: Number(url.port),
  timeout_ms: cfg.timeout_ms,
  device: hf.device,
  load_in_4bit: hf.load_in_4bit,
  dtype: hf.dtype,
  gpu_index: hf.gpu_index,
  gpu_max_memory: hf.gpu_max_memory,
  cpu_max_memory: hf.cpu_max_memory,
  max_new_tokens: hf.max_new_tokens,
  repetition_penalty: hf.repetition_penalty,
  warmup_attempts: hf.warmup_attempts,
  tokenizers_parallelism: hf.tokenizers_parallelism,
  multimodal_enabled: hf.multimodal_enabled !== false
}));
NODE
}

json_value() {
  local key="$1"
  local json="$2"
  bash "$NODE_RUN" node - "$key" "$json" <<'NODE'
'use strict';
const key = process.argv[2];
const obj = JSON.parse(process.argv[3]);
const value = obj[key];
if (value === undefined || value === null || value === '') process.exit(7);
console.log(value);
NODE
}

health_check() {
  local host="$1"
  local port="$2"
  bash "$NODE_RUN" node - "$host" "$port" <<'NODE' >/dev/null 2>&1
'use strict';
const host = process.argv[2];
const port = Number(process.argv[3]);
fetch('http://' + host + ':' + port + '/health', { signal: AbortSignal.timeout(1500) })
  .then((res) => res.json())
  .then((body) => process.exit(body && body.ok === true && body.warmed === true ? 0 : 1))
  .catch(() => process.exit(1));
NODE
}

print_health() {
  local host="$1"
  local port="$2"
  bash "$NODE_RUN" node - "$host" "$port" <<'NODE' || true
'use strict';
const host = process.argv[2];
const port = Number(process.argv[3]);
fetch('http://' + host + ':' + port + '/health', { signal: AbortSignal.timeout(2500) })
  .then((res) => res.text())
  .then((text) => console.log(text))
  .catch((error) => console.log(JSON.stringify({ ok: false, marker: 'FLOKI_HF_COGNITION_HEALTH_ERROR', error: error.message })));
NODE
}


# FLOKI_HF_VISION_GENERATE_CAP_EXPORTS_V1
FLOKI_HF_VISION_GENERATE_MAX_NEW_TOKENS="$(
  bash "$NODE_RUN" node - <<'NODE'
'use strict';
const { loadYamlFile } = require('./src/config/yaml-lite.cjs');
const raw = loadYamlFile('config/chat.config.yaml');
const value = raw.models && raw.models.vision && raw.models.vision.generate_max_new_tokens;
process.stdout.write(String(Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 64));
NODE
)"
FLOKI_HF_VISION_STARTUP_PROBE_MAX_NEW_TOKENS="$(
  bash "$NODE_RUN" node - <<'NODE'
'use strict';
const { loadYamlFile } = require('./src/config/yaml-lite.cjs');
const raw = loadYamlFile('config/chat.config.yaml');
const value = raw.models && raw.models.vision && raw.models.vision.startup_probe_max_new_tokens;
process.stdout.write(String(Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 32));
NODE
)"
export FLOKI_HF_VISION_GENERATE_MAX_NEW_TOKENS
export FLOKI_HF_VISION_STARTUP_PROBE_MAX_NEW_TOKENS



# FLOKI_HF_REAL_GENERATION_WARMUP_REQUIRED_V1
floki_hf_real_generation_warmup() {
  bash "$NODE_RUN" node - <<'NODE'
'use strict';

const http = require('node:http');

const endpoint = process.env.FLOKI_HF_COGNITION_ENDPOINT || 'http://127.0.0.1:11436';
const deadline = Date.now() + Number(process.env.FLOKI_HF_REAL_WARMUP_TIMEOUT_MS || 900000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJson(url, payload, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({
        ok: res.statusCode === 200,
        status: res.statusCode,
        body: data.slice(0, 1200)
      }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (error) => resolve({
      ok: false,
      error: String(error && error.message || error)
    }));
    req.write(body);
    req.end();
  });
}

function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({
        ok: res.statusCode === 200,
        status: res.statusCode,
        body: data.slice(0, 1200)
      }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (error) => resolve({
      ok: false,
      error: String(error && error.message || error)
    }));
  });
}

(async () => {
  const tagsUrl = endpoint.replace(/\/+$/, '') + '/api/tags';
  const chatUrl = endpoint.replace(/\/+$/, '') + '/api/chat';
  let last = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;

    const tags = await getJson(tagsUrl, 10000);
    if (!tags.ok) {
      last = { phase: 'tags', tags };
      console.log(JSON.stringify({ marker: 'FLOKI_HF_REAL_WARMUP_WAIT', attempts, last }));
      await sleep(3000);
      continue;
    }

    const chat = await postJson(chatUrl, {
      model: 'yaml-selected-local-hf-model',
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are Floki local HF warmup. Reply with exactly: warm.'
        },
        {
          role: 'user',
          content: 'Run one real GPU generation warmup now.'
        }
      ],
      options: {
        max_new_tokens: 8,
        num_predict: 8,
        temperature: 0
      }
    }, 180000);

    last = { phase: 'chat', tags, chat };

    if (chat.ok && /warm|message|response|done/i.test(String(chat.body || ''))) {
      console.log(JSON.stringify({
        marker: 'FLOKI_HF_REAL_GENERATION_WARMUP_PASS',
        attempts,
        endpoint,
        chat
      }, null, 2));
      return;
    }

    console.log(JSON.stringify({ marker: 'FLOKI_HF_REAL_WARMUP_WAIT', attempts, last }));
    await sleep(3000);
  }

  console.error(JSON.stringify({
    marker: 'FLOKI_HF_REAL_GENERATION_WARMUP_TIMEOUT',
    endpoint,
    last
  }, null, 2));
  process.exit(1);
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
NODE
}


case "${1:-status}" in
  start)
    CONFIG_JSON="$(resolve_config_json)"
    if echo "$CONFIG_JSON" | grep -q '"skipped":true'; then
      printf '%s\n' "$CONFIG_JSON"
      exit 0
    fi

    MODEL="$(json_value model "$CONFIG_JSON")"
    HOST="$(json_value host "$CONFIG_JSON")"
    PORT="$(json_value port "$CONFIG_JSON")"

    if [ -z "$MODEL" ] || [ -z "$HOST" ] || [ -z "$PORT" ]; then
      printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_CONFIG_ERROR" "model=$MODEL" "host=$HOST" "port=$PORT" >&2
      exit 2
    fi

    if health_check "$HOST" "$PORT"; then
      printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_ALREADY_WARM" "endpoint=http://$HOST:$PORT" "model=$MODEL"
      print_health "$HOST" "$PORT"
      exit 0
    fi

    if [ -s "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
      printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_START_WAITING_EXISTING" "pid=$(cat "$PID_FILE")" "endpoint=http://$HOST:$PORT" "log_file=$LOG_FILE"
    else
      rm -f "$PID_FILE"
      : > "$LOG_FILE"
      # Every HF runtime value below is YAML-authoritative (models.cognition.hf
      # in config/chat.config.yaml). Nothing about the local Qwen3.5 4B server
      # is hardcoded here.
      DEVICE="$(json_value device "$CONFIG_JSON")"
      LOAD_4BIT="$(json_value load_in_4bit "$CONFIG_JSON")"
      DTYPE="$(json_value dtype "$CONFIG_JSON")"
      GPU_INDEX="$(json_value gpu_index "$CONFIG_JSON")"
      GPU_MAX_MEMORY="$(json_value gpu_max_memory "$CONFIG_JSON")"
      CPU_MAX_MEMORY="$(json_value cpu_max_memory "$CONFIG_JSON")"
      MAX_NEW_TOKENS="$(json_value max_new_tokens "$CONFIG_JSON")"
      REPETITION_PENALTY="$(json_value repetition_penalty "$CONFIG_JSON")"
      TOKENIZERS_PARALLELISM_CFG="$(json_value tokenizers_parallelism "$CONFIG_JSON")"
      MULTIMODAL_ENABLED="$(json_value multimodal_enabled "$CONFIG_JSON")"
      export FLOKI_HF_COGNITION_MODEL="$MODEL"
      export FLOKI_HF_COGNITION_HOST="$HOST"
      export FLOKI_HF_COGNITION_PORT="$PORT"
      export FLOKI_HF_COGNITION_DEVICE="$DEVICE"
      export FLOKI_HF_COGNITION_4BIT="$LOAD_4BIT"
      export FLOKI_HF_COGNITION_DTYPE="$DTYPE"
      export FLOKI_HF_COGNITION_GPU_INDEX="$GPU_INDEX"
      export FLOKI_HF_COGNITION_GPU_MAX_MEMORY="$GPU_MAX_MEMORY"
      export FLOKI_HF_COGNITION_CPU_MAX_MEMORY="$CPU_MAX_MEMORY"
      export FLOKI_HF_COGNITION_MAX_NEW_TOKENS="$MAX_NEW_TOKENS"
      export FLOKI_HF_COGNITION_REPETITION_PENALTY="$REPETITION_PENALTY"
      export TOKENIZERS_PARALLELISM="$TOKENIZERS_PARALLELISM_CFG"
      export FLOKI_HF_COGNITION_MULTIMODAL_ENABLED="$MULTIMODAL_ENABLED"
      nohup "$HF_PYTHON" "$ROOT/src/model/hf_cognition_server.py" >> "$LOG_FILE" 2>&1 &
      echo "$!" > "$PID_FILE"
      printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_STARTING" "pid=$(cat "$PID_FILE")" "endpoint=http://$HOST:$PORT" "model=${FLOKI_HF_COGNITION_MODEL}" "log_file=$LOG_FILE"
    fi

    attempts=0
    WARMUP_ATTEMPTS="$(json_value warmup_attempts "$CONFIG_JSON")"
    while [ "$attempts" -lt "$WARMUP_ATTEMPTS" ]; do
      if health_check "$HOST" "$PORT"; then
        printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_WARM_PASS" "endpoint=http://$HOST:$PORT" "pid=$(cat "$PID_FILE" 2>/dev/null || true)" "log_file=$LOG_FILE"
        print_health "$HOST" "$PORT"
        exit 0
      fi
      if [ -s "$PID_FILE" ] && ! kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
        printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_START_FAIL" "reason=process_exited" "log_file=$LOG_FILE"
        tail -120 "$LOG_FILE" || true
        exit 1
      fi
      sleep 1
      attempts=$((attempts + 1))
    done

    printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_START_FAIL" "reason=warmup_timeout" "log_file=$LOG_FILE"
    tail -120 "$LOG_FILE" || true
    exit 1
    ;;

  stop)
    if [ -s "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
      kill "$(cat "$PID_FILE")" || true
      for _ in $(seq 1 30); do
        if ! kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
          rm -f "$PID_FILE"
          printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_STOP_PASS"
          exit 0
        fi
        sleep 0.5
      done
      kill -9 "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
      rm -f "$PID_FILE"
      printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_STOP_PASS" "forced=true"
      exit 0
    fi
    rm -f "$PID_FILE"
    printf '%s\n' "FLOKI_HF_COGNITION_SERVICE_ALREADY_STOPPED"
    ;;

  status)
    CONFIG_JSON="$(resolve_config_json)"
    if echo "$CONFIG_JSON" | grep -q '"skipped":true'; then
      printf '%s\n' "$CONFIG_JSON"
      exit 0
    fi
    HOST="$(json_value host "$CONFIG_JSON")"
    PORT="$(json_value port "$CONFIG_JSON")"
    print_health "$HOST" "$PORT"
    ;;

  *)
    echo "usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac

# FLOKI_HF_REAL_GENERATION_WARMUP_CALL_V1
if [ "${1:-start}" = "start" ]; then
  floki_hf_real_generation_warmup
fi

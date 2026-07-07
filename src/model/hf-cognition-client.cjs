"use strict";

const { performance } = require("node:perf_hooks");
const {
  abortError,
  postJson,
  postJsonStream,
  safeJsonParseModelResponse,
  validateJsonSchemaShape,
  cloneJson,
  statsFromEnvelope
} = require("./ollama-client.cjs");

function buildGeneratePayload(input) {
  if (!input || typeof input !== "object") throw new TypeError("generateJson input must be an object");
  if (!input.model) throw new TypeError("model is required");
  if (!input.prompt) throw new TypeError("prompt is required");
  const options = {
    temperature: typeof input.temperature === "number" ? input.temperature : 0.55,
    top_p: typeof input.top_p === "number" ? input.top_p : 0.9
  };
  if (typeof input.num_predict === "number") options.num_predict = input.num_predict;
  return {
    model: input.model,
    prompt: input.prompt,
    system: input.system || "",
    stream: input.stream === true,
    format: input.format_schema ? cloneJson(input.format_schema) : (input.format || "json"),
    keep_alive: input.keep_alive || "24h",
    think: input.think === true,
    options
  };
}

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") throw new TypeError("endpoint is required");
  if (endpoint.startsWith("container://")) {
    throw new Error("HF cognition endpoint must be a warmed host HTTP endpoint, not " + endpoint);
  }
  return endpoint.replace(/\/$/, "") + "/api/generate";
}

async function generateJson(input) {
  const endpoint = normalizeEndpoint(input.endpoint);
  const payload = buildGeneratePayload({ ...input, stream: false });
  const raw = await (input.post_json || postJson)(endpoint, payload, {
    timeout_ms: input.timeout_ms || 300000,
    signal: input.signal
  });
  if (!raw || typeof raw.response !== "string") throw new Error("HF cognition response missing response string");
  const parsed = safeJsonParseModelResponse(raw.response);
  if (input.response_schema) validateJsonSchemaShape(parsed, input.response_schema, "response");
  return {
    ok: true,
    provider: "huggingface",
    model: raw.model || input.model,
    created_at: raw.created_at || null,
    response_json: parsed,
    response_text: raw.response,
    raw_stats: {
      ...statsFromEnvelope(raw, input, { streaming: false, first_chunk_ms: null, final_output_ms: null }),
      provider: "huggingface"
    }
  };
}

async function generateJsonStream(input) {
  if (input.signal && input.signal.aborted) throw abortError();
  const endpoint = normalizeEndpoint(input.endpoint);
  const payload = buildGeneratePayload({ ...input, stream: true });
  const startedAt = performance.now();
  let firstChunkMs = null;
  let outputText = "";
  let finalEnvelope = null;
  let envelopeCount = 0;
  await (input.post_json_stream || postJsonStream)(endpoint, payload, {
    timeout_ms: input.timeout_ms || 300000,
    signal: input.signal,
    on_record(envelope) {
      envelopeCount += 1;
      if (typeof envelope.response === "string" && envelope.response.length > 0) {
        if (firstChunkMs === null) {
          firstChunkMs = performance.now() - startedAt;
          if (typeof input.on_first_chunk === "function") {
            input.on_first_chunk(Object.freeze({ elapsed_ms: firstChunkMs, envelope_index: envelopeCount }));
          }
        }
        outputText += envelope.response;
        if (typeof input.on_response_fragment === "function") {
          input.on_response_fragment(Object.freeze({
            fragment: envelope.response,
            accumulated_length: outputText.length,
            envelope_index: envelopeCount
          }));
        }
      }
      if (envelope.done === true) finalEnvelope = envelope;
    }
  });
  if (input.signal && input.signal.aborted) throw abortError();
  if (!finalEnvelope || finalEnvelope.done !== true) {
    const error = new Error("HF cognition streaming response ended without a final done envelope");
    error.code = "HF_STREAM_MISSING_DONE";
    throw error;
  }
  const parsed = safeJsonParseModelResponse(outputText);
  if (input.response_schema) validateJsonSchemaShape(parsed, input.response_schema, "response");
  return {
    ok: true,
    provider: "huggingface",
    model: finalEnvelope.model || input.model,
    created_at: finalEnvelope.created_at || null,
    response_json: parsed,
    response_text: outputText,
    raw_stats: {
      ...statsFromEnvelope(finalEnvelope, input, {
        streaming: true,
        first_chunk_ms: firstChunkMs,
        final_output_ms: performance.now() - startedAt,
        ndjson_envelope_count: envelopeCount
      }),
      provider: "huggingface"
    }
  };
}

module.exports = { generateJson, generateJsonStream };

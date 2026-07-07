"use strict";

const ollama = require("./ollama-client.cjs");
const hf = require("./hf-cognition-client.cjs");

function providerOf(input) {
  return String(input && input.provider ? input.provider : "ollama").trim().toLowerCase();
}

function selected(input) {
  const provider = providerOf(input);
  if (provider === "huggingface" || provider === "hf") return hf;
  if (provider === "ollama") return ollama;
  throw new Error("unsupported cognition provider: " + provider);
}

async function generateJson(input) {
  return selected(input).generateJson(input);
}

async function generateJsonStream(input) {
  return selected(input).generateJsonStream(input);
}

module.exports = { generateJson, generateJsonStream, providerOf };

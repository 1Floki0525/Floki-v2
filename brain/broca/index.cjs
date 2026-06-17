'use strict';

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { makeSpeechOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');

const MODULE_NAME = 'broca';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Turns safe cognition summaries into user-facing Floki speech. Broca is the only module allowed to speak.',
  inputs: [
    {
      name: 'cognition_output',
      schema: 'model_response_summary brain output from frontal',
      required: true,
      description: 'Safe qwen cognition output.'
    }
  ],
  outputs: [
    {
      type: 'speech',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'User-facing speech output.'
    },
    {
      type: 'failure',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Speech failure output.'
    }
  ],
  state_reads: [
    { path: 'none', description: 'Broca only speaks from supplied context in Batch 09.' }
  ],
  state_writes: [
    { path: 'state/floki/diagnostics.jsonl', description: 'Append-only speech diagnostics.' }
  ],
  diagnostics: [
    { name: 'speech_created', description: 'Broca created user-facing speech.' },
    { name: 'speech_blocked', description: 'Broca refused unsafe or false speech.' }
  ],
  failure_modes: [
    { code: 'BROCA_INVALID_COGNITION', description: 'Input was not a safe frontal cognition output.' },
    { code: 'BROCA_UNSAFE_SPEECH', description: 'Candidate speech contained banned private reasoning or false embodiment claims.' }
  ],
  forbidden: [
    'private_reasoning_storage',
    'minecraft_claims_before_game_stage',
    'body_claims_before_body_stage',
    'vision_claims_before_eyes_stage',
    'fake_success'
  ],
  notes: 'Broca may produce user-facing speech. Other modules must not.'
});

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function persistDiagnostic(record, options = {}) {
  if (options.persist_diagnostics === false) {
    return { ok: true, skipped: true };
  }

  appendJsonlSync(options.diagnostics_path || statePath('diagnostics.jsonl'), {
    id: diagnosticId(),
    created_at: nowIso(),
    module: MODULE_NAME,
    ...record
  });

  return { ok: true, skipped: false };
}

function rejectUnsafeSpeech(text) {
  const lower = String(text || '').toLowerCase();
  const banned = [
    '<think>',
    '</think>',
    'chain_of_thought',
    'hidden_reasoning',
    'raw_reasoning',
    'scratchpad'
  ];

  for (const marker of banned) {
    if (lower.includes(marker)) {
      throw new Error('speech contains banned private-reasoning marker: ' + marker);
    }
  }

  const falseEmbodimentClaims = [
    'i can see you',
    'i see you',
    'i am in minecraft',
    'i am inside minecraft',
    'i moved',
    'i walked',
    'i mined',
    'i placed a block',
    'my webcam sees',
    'my eyes see'
  ];

  for (const phrase of falseEmbodimentClaims) {
    if (lower.includes(phrase)) {
      throw new Error('speech contains false embodiment claim before body/eyes/game stage: ' + phrase);
    }
  }

  return true;
}

function cleanSpeechText(text) {
  let cleaned = String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/^"+|"+$/g, '').trim();

  if (!cleaned) {
    cleaned = 'I am here. My cognition is active, and my speech layer is forming now.';
  }

  if (cleaned.length > 900) {
    cleaned = cleaned.slice(0, 897).trimEnd() + '...';
  }

  rejectUnsafeSpeech(cleaned);
  return cleaned;
}

function extractCognition(cognitionOutput) {
  if (!cognitionOutput || cognitionOutput.type !== 'model_response_summary') {
    throw new Error('Broca requires a model_response_summary output from frontal');
  }

  if (!cognitionOutput.payload || !cognitionOutput.payload.cognition) {
    throw new Error('cognition output missing payload.cognition');
  }

  const cognition = cognitionOutput.payload.cognition;

  return {
    model: cognitionOutput.payload.model || 'unknown',
    safe_thought_summary: cognition.safe_thought_summary || '',
    felt_interpretation: cognition.felt_interpretation || '',
    response_intent_for_broca: cognition.response_intent_for_broca || '',
    raw_private_reasoning_stored: cognitionOutput.payload.raw_private_reasoning_stored === true
  };
}

function composeSpeech(cognitionOutput, context = {}) {
  const cognition = extractCognition(cognitionOutput);

  if (cognition.raw_private_reasoning_stored) {
    throw new Error('Broca refuses cognition output that stored raw private reasoning');
  }

  const primary = cognition.response_intent_for_broca || cognition.safe_thought_summary;
  const felt = cognition.felt_interpretation;

  let text = primary;

  if (felt && felt.length > 0 && !primary.toLowerCase().includes('feel')) {
    text = primary + ' I feel this as ' + felt.charAt(0).toLowerCase() + felt.slice(1);
  }

  if (context.include_chat_truth === true) {
    text += ' I am answering from chat-mode cognition, memory, and emotion context.';
  }

  return cleanSpeechText(text);
}

function speakFromCognition(cognitionOutput, context = {}, options = {}) {
  try {
    const text = composeSpeech(cognitionOutput, context);

    const output = makeSpeechOutput(text, {
      parent_event_ids: Array.isArray(context.parent_event_ids) ? context.parent_event_ids : [],
      parent_output_ids: cognitionOutput && cognitionOutput.id ? [cognitionOutput.id] : [],
      tone: context.tone || 'plain',
      audience: context.audience || 'user',
      diagnostics: {
        module: MODULE_NAME,
        status: 'speech_created',
        model_source: cognitionOutput && cognitionOutput.payload ? cognitionOutput.payload.model : null,
        broca_enabled_now: true,
        chat_mode_only: true
      }
    });

    persistDiagnostic({
      status: 'speech_created',
      output_id: output.id,
      parent_cognition_output_id: cognitionOutput.id
    }, options);

    return output;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const code = message.toLowerCase().includes('unsafe') || message.toLowerCase().includes('false embodiment') || message.toLowerCase().includes('private')
      ? 'BROCA_UNSAFE_SPEECH'
      : 'BROCA_INVALID_COGNITION';

    persistDiagnostic({
      status: 'speech_blocked',
      code,
      message: message.slice(0, 1000)
    }, options);

    return makeFailureOutput(MODULE_NAME, code, message, {
      parent_event_ids: Array.isArray(context.parent_event_ids) ? context.parent_event_ids : [],
      parent_output_ids: cognitionOutput && cognitionOutput.id ? [cognitionOutput.id] : []
    });
  }
}

function createBroca(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    speakFromCognition: function(cognitionOutput, context = {}, local = {}) {
      return speakFromCognition(cognitionOutput, context, { ...options, ...local });
    }
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  getContract,
  rejectUnsafeSpeech,
  cleanSpeechText,
  extractCognition,
  composeSpeech,
  speakFromCognition,
  createBroca
};

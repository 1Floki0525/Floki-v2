'use strict';

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { makeSpeechOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');

const MODULE_NAME = 'broca';
const THIRD_PERSON_SELF_REFERENCE_CODE = 'BROCA_THIRD_PERSON_SELF_REFERENCE';


function containsConfiguredPhrase(text, phrase) {
  const source = String(text || '').toLowerCase();
  const target = String(phrase || '').toLowerCase().trim();
  if (!target) return false;
  if (/^[a-z0-9]+$/.test(target)) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + escaped + '\\b', 'i').test(source);
  }
  return source.includes(target);
}

function rejectInvalidVisionNarration(text, context = {}) {
  const contract = context && context.vision_response_contract;
  if (!contract || contract.question !== true) return true;
  const value = String(text || '').trim();

  if (context.chat_webcam_vision && context.chat_webcam_vision.available === true) {
    if (!/\b(?:i|i'm|i’m|my|me)\b/i.test(value)) {
      throw new Error('vision response must be first-person speech from Floki');
    }
    if (contract.require_narrative === true) {
      if (/objects? including/i.test(value) || /(?:^|[.!?]\s*)i can see[^.!?]*;[^.!?]*[.!?]?$/i.test(value)) {
        throw new Error('vision response is a detector-style inventory instead of a natural scene thought');
      }
    }
  }

  if (contract.hardware_question !== true) {
    const terms = Array.isArray(contract.prohibited_terms) ? contract.prohibited_terms : [];
    for (const term of terms) {
      if (containsConfiguredPhrase(value, term)) {
        throw new Error('vision response exposed prohibited technical framing: ' + String(term));
      }
    }
  }
  return true;
}

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
    { code: 'BROCA_UNSAFE_SPEECH', description: 'Candidate speech contained banned private reasoning or false embodiment claims.' },
    { code: THIRD_PERSON_SELF_REFERENCE_CODE, description: 'Candidate speech narrated Floki in third person instead of speaking as I/me/my.' }
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

function getSentences(text) {
  const raw = String(text || '');
  const matched = raw.match(/[^.!?]+[.!?]*/g);

  return matched && matched.length > 0 ? matched : [raw];
}

function isThirdPersonSelfReference(text, options = {}) {
  const value = String(text || '');

  if (!value.trim()) {
    return false;
  }

  const directPatterns = [
    /\bFloki\s+(?:remembers?|thinks?|feels?|wants?|needs?|is|was|can|could|will|would|should|learns?|knows?|understands?|responds?|says?|speaks?)\b/i,
    /\bFloki['’]s\s+(?:memory|memories|thought|thoughts|feeling|feelings|voice|response|identity|personality)\b/i,
    /\bas\s+Floki\b/i,
    /^\s*Floki\b/i
  ];

  if (directPatterns.some((pattern) => pattern.test(value))) {
    return true;
  }

  return getSentences(value).some((sentence) => {
    if (!/\bFloki\b/i.test(sentence) || !/\b(?:he|his|him)\b/i.test(sentence)) {
      return false;
    }

    return /\bFloki\b[^.!?]{0,160}\b(?:he|his|him)\b/i.test(sentence) ||
      /\b(?:he|his|him)\b[^.!?]{0,160}\bFloki\b/i.test(sentence);
  });
}

function rejectThirdPersonSelfReference(text, options = {}) {
  if (!isThirdPersonSelfReference(text, options)) {
    return true;
  }

  const error = new Error(THIRD_PERSON_SELF_REFERENCE_CODE + ': Broca refuses third-person self-narration.');
  error.code = THIRD_PERSON_SELF_REFERENCE_CODE;
  throw error;
}

function rejectUnsafeSpeech(text, context = {}) {
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

  if (context && context.chat_webcam_vision && context.chat_webcam_vision.available === true) {
    const falseBlindnessClaims = [
      'i cannot see',
      "i can't see",
      'i have no eyes',
      "i don't have eyes",
      'i am blind',
      'i lack visual input',
      'i have no visual input'
    ];
    for (const phrase of falseBlindnessClaims) {
      if (lower.includes(phrase)) {
        throw new Error('speech contains false blindness claim while fresh Maker-world sight exists: ' + phrase);
      }
    }
  }

  rejectThirdPersonSelfReference(text);
  rejectInvalidVisionNarration(text, context);

  return true;
}

function cleanSpeechText(text, context = {}) {
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

  rejectUnsafeSpeech(cleaned, context);
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
  let text = primary;

  if (context.include_chat_truth === true) {
    text += ' I am answering from chat-mode cognition, memory, and emotion context.';
  }

  return cleanSpeechText(text, context);
}

function authorizePublicText(text, context = {}, options = {}) {
  try {
    const cleaned = cleanSpeechText(text, context);
    const output = makeSpeechOutput(cleaned, {
      parent_event_ids: Array.isArray(context.parent_event_ids) ? context.parent_event_ids : [],
      parent_output_ids: Array.isArray(context.parent_output_ids) ? context.parent_output_ids : [],
      tone: context.tone || 'plain',
      audience: context.audience || 'user',
      diagnostics: {
        module: MODULE_NAME,
        status: 'streamed_public_text_authorized',
        provisional_stream_authorization: true,
        broca_enabled_now: true,
        chat_mode_only: true
      }
    });

    persistDiagnostic({
      status: 'streamed_public_text_authorized',
      output_id: output.id,
      text_length: cleaned.length
    }, options);

    return output;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const code = error && error.code === THIRD_PERSON_SELF_REFERENCE_CODE
      ? THIRD_PERSON_SELF_REFERENCE_CODE
      : 'BROCA_UNSAFE_SPEECH';
    persistDiagnostic({ status: 'speech_blocked', code, message: message.slice(0, 1000) }, options);
    return makeFailureOutput(MODULE_NAME, code, message, {
      parent_event_ids: Array.isArray(context.parent_event_ids) ? context.parent_event_ids : [],
      parent_output_ids: Array.isArray(context.parent_output_ids) ? context.parent_output_ids : []
    });
  }
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
    const code = error && error.code === THIRD_PERSON_SELF_REFERENCE_CODE
      ? THIRD_PERSON_SELF_REFERENCE_CODE
      : message.toLowerCase().includes('unsafe') || message.toLowerCase().includes('false embodiment') || message.toLowerCase().includes('private')
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
    },
    authorizePublicText: function(text, context = {}, local = {}) {
      return authorizePublicText(text, context, { ...options, ...local });
    }
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  THIRD_PERSON_SELF_REFERENCE_CODE,
  getContract,
  isThirdPersonSelfReference,
  rejectThirdPersonSelfReference,
  rejectUnsafeSpeech,
  cleanSpeechText,
  extractCognition,
  composeSpeech,
  authorizePublicText,
  speakFromCognition,
  createBroca
};

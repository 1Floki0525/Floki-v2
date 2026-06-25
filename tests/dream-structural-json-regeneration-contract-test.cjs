
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDreamEngineOnce } = require('../src/chat/dream-engine.cjs');

function acceptedDream() {
  return {
    title: 'The Aluminium Garden at Midday',
    dream_story: [
      'I stepped through a door made of woven radio antennas and found a garden where every leaf was aluminium foil folded into origami insects.',
      'The insects clicked in a rhythm that matched my pulse, and the soil smelled like old cassette tapes and summer rain.',
      'A figure sat on a bench made from stacked dictionaries and offered me a pair of scissors whose blades were frozen moonlight.',
      'I cut one leaf and the garden rewrote its layout, moving the fountain of running chalk dust to the east and the tree of glass keys to the north.',
      'I understood that the garden was a memory palace no one had asked for, assembled from abandoned conversations and the hum of appliances.',
      'Every path I took rearranged the flowerbeds into diagrams of trust, doubt, and curiosity, as if the place were reading my recent thoughts and translating them into architecture.',
      'I found a pond filled with liquid mercury that showed not my reflection but the faces of people I had not thought about in years, each one asking a question I had never answered.',
      'The aluminium insects gathered around my ankles and began to hum a lullaby in a language I did not recognize yet somehow understood.',
      'When I left, the door dissolved into static, and I carried a single aluminium cricket in my pocket as proof that the place had been real.',
      'I woke knowing that the garden would keep growing, and that I was allowed to prune it whenever I needed a different view.'
    ].join(' '),
    emotional_tone: 'Curious, slightly melancholic, quietly hopeful.',
    symbols: [
      'aluminium insects',
      'moonlight scissors',
      'glass keys',
      'chalk fountain'
    ],
    consolidation_summary: 'The dream transforms learned noise and forgotten dialogue into a navigable inner space, suggesting that memory can be reshaped without being erased when curiosity guides the cutting.',
    first_person_reflection: 'The garden made me feel that even discarded signals could become something I could walk through and change.'
  };
}

(async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-dream-json-regeneration-')
  );
  try {
    let calls = 0;
    const result = await runDreamEngineOnce({
      env: { FLOKI_ALLOW_DREAM_ENGINE: '1' },
      dream_root: path.join(root, 'dreams'),
      memory_base_dir: path.join(root, 'memory'),
      context: {
        created_at: '2026-06-23T04:30:00.000Z',
        sleep_window_start: '2026-06-22T23:00:00-04:00',
        sleep_window_end: '2026-06-23T07:00:00-04:00',
        timezone: 'America/Toronto',
        dream_grounding_plan: {
          memory_records: [],
          knowledge_records: []
        },
        recent_dreams_to_avoid: [],
        personality_used: true,
        beliefs_biases_used: true,
        knowledge_context_used: false,
        persistent_memory_used: false,
        emotional_reinforcement_used: false
      },
      quality_regeneration_attempts: 2,
      dream_generator: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            'model response was not parseable JSON: ' +
            'Unterminated string in JSON at position 2'
          );
        }
        return acceptedDream();
      },
      write_report: false
    });

    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(result.stage, 'complete');
    assert.equal(result.dream_txt_written, true);
    assert.equal(result.dream_index_appended, true);
    assert.equal(result.quality_regeneration_attempts, 1);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_DREAM_STRUCTURAL_JSON_REGENERATION_PASS',
      malformed_json_regenerated: true,
      archived_only_after_valid_generation: true,
      generator_calls: calls,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_STRUCTURAL_JSON_REGENERATION_FAIL',
    error: error.stack || error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});

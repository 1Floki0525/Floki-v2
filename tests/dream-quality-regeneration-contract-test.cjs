'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { runDreamEngineOnce } = require('../src/chat/dream-engine.cjs');
const { reconcileDreamArchive } = require('../src/chat/dream-archive.cjs');

function originalDream() {
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
    symbols: ['aluminium insects', 'moonlight scissors', 'glass keys', 'chalk fountain'],
    consolidation_summary: 'The dream transforms learned noise and forgotten dialogue into a navigable inner space, suggesting that memory can be reshaped without being erased when curiosity guides the cutting.',
    first_person_reflection: 'The garden made me feel that even discarded signals could become something I could walk through and change.'
  };
}

function duplicateDream() {
  return {
    title: 'The Glass River',
    dream_story: [
      'I walked beside a glass river under a silver sky.',
      'The water was so clear that I could see every stone on the riverbed, each one shaped like a word I had almost spoken the day before.',
      'A boat drifted past with no passenger, but its oars moved as though guided by an invisible current of memory.',
      'I reached down to touch the surface and my reflection split into three versions of myself: one afraid, one hopeful, and one already asleep elsewhere.',
      'The hopeful version handed me a coin made of cooled starlight and told me to pay the ferry whenever I was ready to cross.',
      'I woke before I decided, but the coin stayed warm in my palm long after the river faded.'
    ].join(' '),
    emotional_tone: 'Wistful, reflective, hopeful.',
    symbols: ['glass river', 'silver sky', 'memory stones', 'starlight coin'],
    consolidation_summary: 'The dream returns to a familiar symbolic landscape, repeating the river and sky motifs from a recent remembered dream without introducing a materially new situation.',
    first_person_reflection: 'I keep returning to the water because it feels safe, but safety is not the same as a new dream.'
  };
}

async function run() {
  const unique = newId('dream_quality_regen').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/dream-quality-regen/' + unique);
  const dreamRoot = path.join(baseDir, 'dreams');
  const memoryBase = path.join(baseDir, 'memory');
  ensureDirSync(dreamRoot);
  ensureDirSync(memoryBase);

  const recent = [{
    title: 'The Glass River',
    story_opening: 'I walked beside a glass river under a silver sky.',
    symbols: ['glass river', 'silver sky']
  }];

  const baseContext = {
    created_at: new Date('2026-06-23T04:30:00.000Z').toISOString(),
    sleep_window_start: '2026-06-22T23:00:00-04:00',
    sleep_window_end: '2026-06-23T07:00:00-04:00',
    timezone: 'America/Toronto',
    dream_grounding_plan: { memory_records: [], knowledge_records: [] },
    recent_dreams_to_avoid: recent,
    personality_used: true,
    beliefs_biases_used: true,
    knowledge_context_used: false,
    persistent_memory_used: false,
    emotional_reinforcement_used: false
  };

  const rejected = await runDreamEngineOnce({
    env: { FLOKI_ALLOW_DREAM_ENGINE: '1' },
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    context: baseContext,
    dream_generator: () => duplicateDream(),
    quality_regeneration_attempts: 2,
    write_report: false
  });

  assert.equal(rejected.ok, false, 'duplicate dream must not pass quality');
  assert.equal(rejected.regeneration_needed, true, 'duplicate dream must trigger regeneration status');
  assert.equal(rejected.stage, 'regenerating', 'rejected draft must enter regenerating stage');
  assert.equal(rejected.dream_txt_written, false, 'rejected draft must not be written');
  assert.equal(rejected.dream_index_appended, false, 'rejected draft must not be indexed');
  assert.ok(Array.isArray(rejected.diagnostics), 'diagnostics must be preserved');
  assert.ok(rejected.diagnostics.length >= 1, 'at least one rejected attempt must be recorded');

  const reconciled = reconcileDreamArchive({ dream_root: dreamRoot });
  assert.equal(reconciled.archive_count, 0, 'rejected drafts must not appear in archive');

  const plans = rejected.diagnostics.map((entry) => entry.novelty_plan).filter(Boolean);
  assert.ok(plans.length >= 2, 'multiple novelty attempts must be planned');
  const distinctOpenings = new Set(plans.map((plan) => plan.opening_situation));
  assert.ok(distinctOpenings.size >= 2, 'each retry must select a materially different novelty plan');

  const accepted = await runDreamEngineOnce({
    env: { FLOKI_ALLOW_DREAM_ENGINE: '1' },
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    context: baseContext,
    dream_generator: () => originalDream(),
    write_report: false
  });

  assert.equal(accepted.ok, true, 'original dream must pass quality');
  assert.equal(accepted.stage, 'complete', 'accepted dream must reach complete stage');
  assert.equal(accepted.dream_txt_written, true, 'accepted dream must be written');
  assert.equal(accepted.dream_index_appended, true, 'accepted dream must be indexed');

  const archive = reconcileDreamArchive({ dream_root: dreamRoot });
  assert.equal(archive.archive_count, 1, 'exactly one dream must be indexed');
  assert.equal(archive.duplicates, 0, 'no duplicate index entries allowed');

  fs.rmSync(baseDir, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_QUALITY_REGENERATION_CONTRACT_PASS',
    rejected_draft_not_indexed: true,
    rejection_enters_regenerating_stage: true,
    different_novelty_plan_on_retry: true,
    successful_dream_indexed_exactly_once: true,
    diagnostics_preserved: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_QUALITY_REGENERATION_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});

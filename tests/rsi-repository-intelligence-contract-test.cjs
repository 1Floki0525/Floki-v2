'use strict';

// Contract: the repository-intelligence layer builds a real, bounded map of the
// repository and its 12 tools return bounded, structured results with
// continuation offsets. Exercises real production functions (no mocks).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ri = require('../src/self-improvement/repo-intelligence.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();
const intel = ri.createRepoIntelligence({ config });

// --- map build ---
const map = intel.rebuild();
assert.equal(map.marker, 'FLOKI_V2_REPO_INTELLIGENCE_MAP');
assert.ok(map.counts.files > 100, 'should index a real repository');
assert.ok(map.counts.definitions > 100, 'should extract real symbol definitions');
assert.ok(map.counts.tests > 50, 'should detect the test corpus');
assert.ok(map.runtime_entry_points.includes('src/runtime/chat-local-runtime.cjs'), 'runtime entry point present');

// persisted under the configured (gitignored) index root
assert.ok(fs.existsSync(ri.mapPath(config)), 'map persisted to disk');

// --- get_repository_map is bounded with continuation offset ---
const summary = intel.tools.get_repository_map({});
assert.equal(summary.marker, 'FLOKI_V2_REPO_INTELLIGENCE_MAP_SUMMARY');
assert.ok(summary.returned <= config.repo_intelligence_map_summary_max_files, 'summary respects max files');
if (summary.total_files > summary.returned) {
  assert.equal(typeof summary.next_offset, 'number', 'continuation offset provided when truncated');
  const page2 = intel.tools.get_repository_map({ offset: summary.next_offset });
  assert.ok(page2.returned >= 0, 'second page reads');
}

// --- inspect_symbol resolves a real export ---
const sym = intel.tools.inspect_symbol('createSelfImprovementApi');
assert.ok(sym.definition_count >= 1, 'finds the api factory definition');
assert.equal(sym.definitions[0].file, 'src/self-improvement/api.cjs');

// --- find_references / find_callers bounded ---
const refs = intel.tools.find_references('loadSelfImprovementConfig');
assert.ok(refs.count > 1, 'references found across files');
assert.ok(refs.count <= config.repo_intelligence_reference_result_limit, 'references bounded');
const callers = intel.tools.find_callers('loadSelfImprovementConfig');
assert.ok(callers.count >= 1, 'callers found');

// --- find_config_transport_path traces template + loader + consumers ---
const transport = intel.tools.find_config_transport_path('max_pending_review_candidates');
assert.ok(transport.transport.template, 'config key located in public template');
assert.ok(transport.transport.loader, 'config key located in loader whitelist');
assert.equal(transport.complete, true, 'transport considered complete');

// --- find_relevant_tests + find_runtime_owner ---
const tests = intel.tools.find_relevant_tests('src/self-improvement/worker.cjs');
assert.ok(tests.count >= 1, 'relevant tests found for worker.cjs');
const owner = intel.tools.find_runtime_owner('src/self-improvement/api.cjs');
assert.ok(owner.importers.length >= 1, 'importers of api.cjs found');

// --- read_file_range bounded with continuation ---
const range = intel.tools.read_file_range('src/self-improvement/worker.cjs', { start: 1, lines: 50 });
assert.equal(range.marker, 'FLOKI_V2_REPO_INTELLIGENCE_FILE_RANGE');
assert.ok(range.end_line - range.start_line + 1 <= config.repo_intelligence_read_range_max_lines, 'line bound enforced');
assert.ok(range.content.length <= config.repo_intelligence_read_range_max_chars, 'char bound enforced');
if (range.total_lines > range.end_line) assert.equal(typeof range.next_offset, 'number', 'continuation offset present');

// range read must refuse path traversal
assert.throws(() => intel.tools.read_file_range('../../../etc/passwd', {}), /escaped|not found/);

// --- read_log_window bounded ---
const tmpLog = path.join(require('node:os').tmpdir(), 'ri-log-' + process.pid + '.log');
fs.writeFileSync(tmpLog, Array.from({ length: 5000 }, (_, i) => 'line ' + i).join('\n'));
const win = intel.tools.read_log_window(tmpLog, { lines: 50 });
assert.ok(win.returned_lines <= config.repo_intelligence_log_window_max_lines, 'log window bounded');
assert.ok(win.content.length <= config.repo_intelligence_log_window_max_chars, 'log window char bound');
fs.rmSync(tmpLog);

// --- read_git_diff bounded + char cap ---
const diff = intel.tools.read_git_diff({ stat: true });
assert.equal(diff.marker, 'FLOKI_V2_REPO_INTELLIGENCE_GIT_DIFF');
assert.ok(diff.diff.length <= config.repo_intelligence_git_diff_max_chars, 'git diff char bound');

// --- candidate / denial history tools are bounded ---
const hist = intel.tools.get_candidate_history({});
assert.ok(hist.count <= config.repo_intelligence_candidate_history_limit, 'candidate history bounded');
const denials = intel.tools.get_denial_requirements({});
assert.ok(denials.count <= config.repo_intelligence_denial_history_limit, 'denial history bounded');
const dup = intel.tools.compare_to_denial({ objective: 'totally unrelated objective string xyz' });
assert.equal(dup.marker, 'FLOKI_V2_REPO_INTELLIGENCE_DENIAL_COMPARE');

// --- all 12 tools exist ---
for (const name of ri.TOOL_NAMES) {
  assert.equal(typeof intel.tools[name], 'function', 'tool exists: ' + name);
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_REPOSITORY_INTELLIGENCE_PASS',
  files_indexed: map.counts.files,
  definitions: map.counts.definitions,
  tool_count: ri.TOOL_NAMES.length,
  bounded_outputs: true,
  continuation_offsets: true,
  path_traversal_blocked: true
}, null, 2));

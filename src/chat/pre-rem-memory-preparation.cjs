
'use strict';

const { getKnowledgeConfig } = require('../config/floki-config.cjs');
const { runConfiguredKnowledgeAutoload } = require('./knowledge-autoload.cjs');
const { runKnowledgeMemoryConsolidation } = require('./knowledge-memory-consolidation.cjs');

async function runPreRemMemoryPreparation(options = {}) {
  const config = getKnowledgeConfig('chat');
  if (config.sleep_consolidation_enabled !== true) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_PRE_REM_MEMORY_PREPARATION_DISABLED',
      preparation_run_now: false,
      hippocampus_consolidation: null,
      autoload: null,
      consolidation: null,
      source_count: 0,
      chunk_count: 0,
      memories_written: 0,
      short_term_memories_promoted: 0,
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  const autoloadRunner = options.knowledge_autoload_runner ||
    runConfiguredKnowledgeAutoload;
  const consolidationRunner = options.knowledge_memory_consolidation_runner ||
    runKnowledgeMemoryConsolidation;
  const hippocampusRunner = options.hippocampus_consolidation_runner;

  const hippocampusConsolidation = typeof hippocampusRunner === 'function'
    ? await Promise.resolve(hippocampusRunner())
    : null;

  const autoload = await Promise.resolve(autoloadRunner({
    ...options,
    force: true
  }));
  if (!autoload || autoload.ok !== true) {
    throw new Error(
      'knowledge autoload failed before REM: ' +
      String(autoload && (autoload.reason || autoload.marker) || 'unknown failure')
    );
  }

  const consolidation = await Promise.resolve(consolidationRunner({
    ...options,
    report_file: options.knowledge_consolidation_report_file || options.report_file
  }));
  if (!consolidation || consolidation.ok !== true) {
    throw new Error(
      'knowledge memory consolidation failed before REM: ' +
      String(consolidation && (consolidation.reason || consolidation.marker) || 'unknown failure')
    );
  }

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_PRE_REM_MEMORY_PREPARATION_PASS',
    preparation_run_now: true,
    hippocampus_consolidation: hippocampusConsolidation,
    autoload,
    consolidation,
    source_count: Number(autoload.source_count || 0),
    chunk_count: Number(autoload.chunk_count || 0),
    scanned_file_count: Number(autoload.scanned_file_count || 0),
    unchanged_source_count: Number(autoload.unchanged_source_count || 0),
    memories_written: Number(consolidation.memories_written || 0),
    short_term_memories_promoted: Number(
      consolidation.short_term_memories_promoted || 0
    ),
    chat_mode_only: true,
    game_mode_started: false
  });
}

module.exports = {
  runPreRemMemoryPreparation
};

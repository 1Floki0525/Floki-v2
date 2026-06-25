
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getPathConfig, getKnowledgeConfig } = require('../config/floki-config.cjs');
const {
  getKnowledgePaths,
  listIngestibleFiles,
  sourceMetadataFromPath,
  runKnowledgeIngestionOnce
} = require('./knowledge-ingestion.cjs');

function nowEpochSeconds(options = {}) {
  if (Number.isFinite(Number(options.now_epoch_seconds))) {
    return Number(options.now_epoch_seconds);
  }
  return Math.floor(Date.now() / 1000);
}

function configuredAutoloadPaths(options = {}) {
  const pathConfig = getPathConfig('chat');
  const knowledgeConfig = getKnowledgeConfig('chat');
  const runtimeDir = path.resolve(options.runtime_dir || pathConfig.chat_runtime_root);
  const explicitYoutubeRoot =
    typeof options.youtube_root === 'string' &&
    options.youtube_root.trim() !== '' &&
    !(typeof options.text_root === 'string' && options.text_root.trim() !== '');
  const textRoot = path.resolve(
    options.text_root ||
    options.youtube_root ||
    pathConfig.text_root
  );
  const youtubeRoot = path.resolve(
    options.youtube_root ||
    pathConfig.youtube_transcript_root
  );

  return Object.freeze({
    text_root: textRoot,
    youtube_root: youtubeRoot,
    explicit_youtube_root: explicitYoutubeRoot,
    runtime_dir: runtimeDir,
    stamp_file: path.resolve(
      options.stamp_file ||
      path.join(runtimeDir, 'knowledge-autoload.last-run')
    ),
    knowledge_root: path.resolve(
      options.knowledge_root ||
      getKnowledgePaths(options).root
    ),
    config: knowledgeConfig
  });
}

function readStamp(file) {
  try {
    const value = Number(String(fs.readFileSync(file, 'utf8')).trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (_error) {
    return 0;
  }
}

function writeStamp(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + String(process.pid);
  fs.writeFileSync(temp, String(value) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

function sourceGroupsForFiles(files, options = {}) {
  const groups = new Set();
  for (const filePath of files) {
    const metadata = sourceMetadataFromPath(filePath, options);
    const key = metadata.channel_folder || metadata.source_collection;
    if (key) groups.add(key);
  }
  return groups;
}

function runConfiguredKnowledgeAutoload(options = {}) {
  const resolved = configuredAutoloadPaths(options);
  const config = resolved.config;
  const common = {
    text_root: resolved.text_root,
    youtube_root: resolved.youtube_root,
    knowledge_root: resolved.knowledge_root,
    chat_mode_only: true,
    game_mode_started: false
  };

  if (config.autoload_enabled !== true) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_DISABLED',
      autoload_run_now: false,
      channel_count: 0,
      source_count: 0,
      chunk_count: 0,
      duplicate_chunk_count: 0,
      unchanged_source_count: 0,
      scanned_file_count: 0,
      ...common
    });
  }

  if (!fs.existsSync(resolved.text_root)) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_NO_CORPUS',
      autoload_run_now: false,
      channel_count: 0,
      source_count: 0,
      chunk_count: 0,
      duplicate_chunk_count: 0,
      unchanged_source_count: 0,
      scanned_file_count: 0,
      ...common
    });
  }

  const listed = listIngestibleFiles(resolved.text_root, {
    max_files: Number(config.max_files)
  });
  const metadataOptions = {
    text_root: resolved.text_root,
    youtube_root: resolved.youtube_root,
    collection_root_is_source_parent: resolved.explicit_youtube_root
  };
  const sourceGroups = sourceGroupsForFiles(listed.supported_files, metadataOptions);
  const now = nowEpochSeconds(options);
  const lastRun = readStamp(resolved.stamp_file);
  const indexExists = fs.existsSync(path.join(resolved.knowledge_root, 'index.json'));
  const minSeconds = Math.max(0, Number(config.autoload_min_seconds));

  if (options.force !== true && indexExists && lastRun > 0 && now - lastRun < minSeconds) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_RECENTLY_RAN',
      autoload_run_now: false,
      age_seconds: now - lastRun,
      channel_count: sourceGroups.size,
      source_count: 0,
      chunk_count: 0,
      duplicate_chunk_count: 0,
      unchanged_source_count: 0,
      scanned_file_count: listed.supported_files.length,
      ...common
    });
  }

  if (listed.supported_files.length === 0) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_NO_CORPUS',
      autoload_run_now: false,
      channel_count: 0,
      source_count: 0,
      chunk_count: 0,
      duplicate_chunk_count: 0,
      unchanged_source_count: 0,
      scanned_file_count: 0,
      ...common
    });
  }

  const ingestionEnvName = String(config.ingestion_enabled_env || '').trim();
  if (!ingestionEnvName) {
    throw new Error('knowledge.ingestion_enabled_env must be configured');
  }

  const status = runKnowledgeIngestionOnce({
    ...options,
    env: {
      ...(options.env || process.env),
      [ingestionEnvName]: '1'
    },
    input_path: resolved.text_root,
    text_root: resolved.text_root,
    youtube_root: resolved.youtube_root,
    collection_root_is_source_parent: resolved.explicit_youtube_root,
    knowledge_root: resolved.knowledge_root,
    max_files: Number(config.max_files),
    target_chars: Number(config.target_chunk_chars),
    max_chars: Number(config.max_chunk_chars),
    write_report: options.write_report !== false
  });

  if (!status || status.ok !== true) {
    const error = new Error(
      'knowledge autoload failed: ' +
      String(status && (status.reason || status.marker) || 'unknown failure')
    );
    error.status = status || null;
    throw error;
  }

  writeStamp(resolved.stamp_file, now);
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_PASS',
    autoload_run_now: true,
    channel_count: sourceGroups.size,
    source_count: Number(status.source_count || 0),
    chunk_count: Number(status.chunk_count || 0),
    duplicate_chunk_count: Number(status.duplicate_chunk_count || 0),
    unchanged_source_count: Number(status.unchanged_source_count || 0),
    scanned_file_count: Number(status.scanned_file_count || 0),
    index: status.index || null,
    results: Object.freeze([status]),
    ...common
  });
}

module.exports = {
  configuredAutoloadPaths,
  sourceGroupsForFiles,
  runConfiguredKnowledgeAutoload
};

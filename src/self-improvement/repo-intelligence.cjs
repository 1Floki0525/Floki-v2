'use strict';

// Codex-style repository-intelligence layer for the RSI harness.
//
// Builds a persistent, bounded map of the repository (file tree, symbols,
// imports/exports, references, config transport paths, runtime entry points,
// test-to-source relationships, protected/generated paths, recent changes,
// candidate/denial history) and exposes concise, bounded tools the
// role-separated agent contexts use to investigate the codebase.
//
// Every tool result is bounded and structured. Large files and logs support
// range reads with continuation offsets. All limits originate in chat YAML and
// flow through src/self-improvement/config.cjs (no hardcoded operational values).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadSelfImprovementConfig } = require('./config.cjs');
const store = require('./store.cjs');

const DEFINITION_PATTERNS = Object.freeze([
  { kind: 'function', re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/ },
  { kind: 'function', re: /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/ },
  { kind: 'const', re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/ },
  { kind: 'class', re: /^\s*class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'react-component', re: /^\s*(?:export\s+)?(?:default\s+)?function\s+([A-Z][\w$]*)\s*\(/ }
]);

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function matchesPrefixList(relPath, prefixes) {
  return prefixes.some((prefix) => {
    if (prefix.endsWith('/')) return relPath === prefix.slice(0, -1) || relPath.startsWith(prefix);
    return relPath === prefix || relPath.startsWith(prefix + '/');
  });
}

function matchesExcluded(relPath, excludePatterns) {
  return excludePatterns.some((pattern) => {
    if (pattern.endsWith('/')) return relPath.includes(pattern) || relPath.startsWith(pattern.slice(0, -1) + '/');
    if (pattern.startsWith('.') && !pattern.includes('/')) return relPath.endsWith(pattern); // extension match
    return relPath.includes(pattern);
  });
}

function languageFor(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case '.cjs':
    case '.mjs':
    case '.js':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.py':
      return 'python';
    case '.sh':
      return 'shell';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    case '.yaml':
    case '.temp':
      return 'yaml';
    default:
      return 'other';
  }
}

function extractExports(lines) {
  const exported = new Set();
  for (const line of lines) {
    let m = line.match(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (m) exported.add(m[1]);
    m = line.match(/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (m) exported.add(m[1]);
    m = line.match(/export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) exported.add(m[1]);
    m = line.match(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/);
    if (m) exported.add(m[1]);
  }
  // Inline object export: module.exports = { a, b, c }
  const joined = lines.join('\n');
  const objExport = joined.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
  if (objExport) {
    for (const part of objExport[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exported.add(name);
    }
  }
  return Array.from(exported);
}

function extractImports(lines) {
  const imports = new Set();
  for (const line of lines) {
    let m = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) imports.add(m[1]);
    m = line.match(/import\s+[^'"]*from\s+['"]([^'"]+)['"]/);
    if (m) imports.add(m[1]);
    m = line.match(/import\s+['"]([^'"]+)['"]/);
    if (m) imports.add(m[1]);
  }
  return Array.from(imports);
}

function extractDefinitions(lines, limitPerFile) {
  const defs = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const pattern of DEFINITION_PATTERNS) {
      const m = lines[i].match(pattern.re);
      if (m) {
        defs.push({ name: m[1], kind: pattern.kind, line: i + 1 });
        if (defs.length >= limitPerFile) return defs;
        break;
      }
    }
  }
  return defs;
}

function walkFiles(rootDir, scanRoots, excludePatterns, scanExtensions, maxFiles, maxFileBytes) {
  const collected = [];
  const stack = scanRoots
    .map((rel) => ({ abs: path.join(rootDir, rel), rel }))
    .filter((entry) => fs.existsSync(entry.abs));

  while (stack.length > 0 && collected.length < maxFiles) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current.abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = fs.readdirSync(current.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const childRel = toPosix(path.join(current.rel, entry.name));
        const probe = entry.isDirectory() ? childRel + '/' : childRel;
        if (matchesExcluded(probe, excludePatterns)) continue;
        stack.push({ abs: path.join(current.abs, entry.name), rel: childRel });
      }
      continue;
    }
    if (!stat.isFile()) continue;
    const relPath = current.rel;
    if (matchesExcluded(relPath, excludePatterns)) continue;
    const ext = path.extname(relPath).toLowerCase();
    const dottedTemp = relPath.endsWith('.yaml.temp');
    if (!scanExtensions.includes(ext) && !dottedTemp) continue;
    if (stat.size > maxFileBytes) {
      collected.push({ rel: relPath, size: stat.size, oversize: true });
      continue;
    }
    collected.push({ rel: relPath, size: stat.size, oversize: false });
  }
  return collected;
}

function buildRepositoryMap(config = loadSelfImprovementConfig()) {
  const rootDir = config.project_root;
  const scanRoots = splitPipeList(config.repo_intelligence_scan_roots);
  const scanExtensions = splitPipeList(config.repo_intelligence_scan_extensions);
  const excludePatterns = splitPipeList(config.repo_intelligence_exclude_patterns);
  const protectedPrefixes = splitPipeList(config.repo_intelligence_protected_path_prefixes);
  const generatedPrefixes = splitPipeList(config.repo_intelligence_generated_path_prefixes);
  const entryPoints = splitPipeList(config.repo_intelligence_runtime_entry_points);
  const symbolLimitPerFile = clampNumber(config.repo_intelligence_symbol_result_limit, 60, 1, 2000);

  const fileList = walkFiles(
    rootDir,
    scanRoots,
    excludePatterns,
    scanExtensions,
    clampNumber(config.repo_intelligence_max_files, 6000, 1, 100000),
    clampNumber(config.repo_intelligence_max_file_bytes, 1048576, 1024, 1024 * 1024 * 64)
  );

  const files = {};
  // Null-prototype maps: symbol names are arbitrary source-derived strings and
  // may collide with Object.prototype keys (constructor, toString, __proto__).
  // A plain {} would make lookups return inherited members instead of arrays.
  const definitionIndex = Object.create(null); // name -> [{file, line, kind}]
  const exportIndex = Object.create(null); // name -> [file]
  let totalDefinitions = 0;

  for (const entry of fileList) {
    const relPath = entry.rel;
    const language = languageFor(relPath);
    const record = {
      path: relPath,
      size: entry.size,
      language,
      protected: matchesPrefixList(relPath, protectedPrefixes),
      generated: matchesPrefixList(relPath, generatedPrefixes),
      runtime_entry_point: entryPoints.includes(relPath),
      is_test: relPath.startsWith('tests/') || /(\.test\.|-test\.|-contract\.|-contract-test\.)/.test(relPath),
      oversize: Boolean(entry.oversize)
    };

    if (!entry.oversize && (language === 'javascript' || language === 'jsx' || language === 'typescript' || language === 'tsx')) {
      let content;
      try {
        content = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
      } catch {
        content = '';
      }
      const lines = content.split('\n');
      record.line_count = lines.length;
      record.exports = extractExports(lines);
      record.imports = extractImports(lines);
      const defs = extractDefinitions(lines, symbolLimitPerFile);
      record.definitions = defs;
      totalDefinitions += defs.length;
      for (const def of defs) {
        if (!definitionIndex[def.name]) definitionIndex[def.name] = [];
        definitionIndex[def.name].push({ file: relPath, line: def.line, kind: def.kind });
      }
      for (const name of record.exports) {
        if (!exportIndex[name]) exportIndex[name] = [];
        exportIndex[name].push(relPath);
      }
    } else {
      try {
        record.line_count = entry.oversize ? null : fs.readFileSync(path.join(rootDir, relPath), 'utf8').split('\n').length;
      } catch {
        record.line_count = null;
      }
    }
    files[relPath] = record;
  }

  // Test-to-source relationships: a test that requires a relative source module.
  const testToSource = {};
  for (const relPath of Object.keys(files)) {
    const record = files[relPath];
    if (!record.is_test || !record.imports) continue;
    const targets = [];
    for (const imp of record.imports) {
      if (!imp.startsWith('.')) continue;
      const resolved = toPosix(path.normalize(path.join(path.dirname(relPath), imp)));
      targets.push(resolved.replace(/\.cjs$|\.js$/, ''));
    }
    if (targets.length > 0) testToSource[relPath] = targets;
  }

  const map = {
    marker: 'FLOKI_V2_REPO_INTELLIGENCE_MAP',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    project_root: rootDir,
    scan_roots: scanRoots,
    counts: {
      files: Object.keys(files).length,
      definitions: totalDefinitions,
      tests: Object.values(files).filter((f) => f.is_test).length,
      protected: Object.values(files).filter((f) => f.protected).length
    },
    runtime_entry_points: entryPoints.filter((p) => files[p]),
    files,
    definition_index: definitionIndex,
    export_index: exportIndex,
    test_to_source: testToSource
  };

  persistMap(map, config);
  return map;
}

function mapPath(config) {
  return path.join(
    config.repo_intelligence_index_root.startsWith('/')
      ? config.repo_intelligence_index_root
      : path.resolve(config.project_root, config.repo_intelligence_index_root),
    config.repo_intelligence_map_file_name
  );
}

function persistMap(map, config) {
  const target = mapPath(config);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map), 'utf8');
  fs.renameSync(tmp, target);
}

function loadPersistedMap(config) {
  const target = mapPath(config);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function grepReferences(rootDir, files, symbol, limit, callersOnly) {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    throw new Error('invalid symbol name for reference search');
  }
  const results = [];
  const wordRe = new RegExp('\\b' + symbol.replace(/[$]/g, '\\$&') + '\\b' + (callersOnly ? '\\s*\\(' : ''));
  for (const relPath of Object.keys(files)) {
    if (files[relPath].oversize) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (wordRe.test(lines[i])) {
        results.push({ file: relPath, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (results.length >= limit) return { results, truncated: true };
      }
    }
  }
  return { results, truncated: false };
}

function createRepoIntelligence(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  let map = options.map || loadPersistedMap(config);

  function ensureMap(forceRebuild) {
    if (forceRebuild || !map) map = buildRepositoryMap(config);
    return map;
  }

  function get_repository_map(opts = {}) {
    const current = ensureMap(opts.rebuild === true);
    const maxFiles = clampNumber(config.repo_intelligence_map_summary_max_files, 400, 1, 5000);
    const offset = clampNumber(opts.offset, 0, 0, 1000000);
    const allPaths = Object.keys(current.files).sort();
    const slice = allPaths.slice(offset, offset + maxFiles);
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_MAP_SUMMARY',
      generated_at: current.generated_at,
      counts: current.counts,
      runtime_entry_points: current.runtime_entry_points,
      scan_roots: current.scan_roots,
      files: slice.map((p) => ({
        path: p,
        language: current.files[p].language,
        line_count: current.files[p].line_count,
        is_test: current.files[p].is_test,
        protected: current.files[p].protected,
        generated: current.files[p].generated,
        exports: (current.files[p].exports || []).slice(0, 12),
        definition_count: (current.files[p].definitions || []).length
      })),
      returned: slice.length,
      total_files: allPaths.length,
      next_offset: offset + slice.length < allPaths.length ? offset + slice.length : null
    };
  }

  function inspect_symbol(name) {
    const current = ensureMap(false);
    const limit = clampNumber(config.repo_intelligence_symbol_result_limit, 60, 1, 2000);
    const defs = (current.definition_index[name] || []).slice(0, limit);
    const exportedFrom = current.export_index[name] || [];
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_SYMBOL',
      symbol: name,
      definition_count: (current.definition_index[name] || []).length,
      definitions: defs,
      exported_from: exportedFrom,
      truncated: (current.definition_index[name] || []).length > defs.length
    };
  }

  function find_references(name) {
    const current = ensureMap(false);
    const limit = clampNumber(config.repo_intelligence_reference_result_limit, 80, 1, 5000);
    const { results, truncated } = grepReferences(config.project_root, current.files, name, limit, false);
    return { marker: 'FLOKI_V2_REPO_INTELLIGENCE_REFERENCES', symbol: name, count: results.length, references: results, truncated };
  }

  function find_callers(name) {
    const current = ensureMap(false);
    const limit = clampNumber(config.repo_intelligence_reference_result_limit, 80, 1, 5000);
    const { results, truncated } = grepReferences(config.project_root, current.files, name, limit, true);
    return { marker: 'FLOKI_V2_REPO_INTELLIGENCE_CALLERS', symbol: name, count: results.length, callers: results, truncated };
  }

  function find_config_transport_path(key) {
    const current = ensureMap(false);
    if (typeof key !== 'string' || !/^[A-Za-z_][\w]*$/.test(key)) {
      throw new Error('config key must be an identifier');
    }
    const templateFile = config.repo_intelligence_config_template_file;
    const loaderFile = config.repo_intelligence_config_loader_file;
    const namespace = config.repo_intelligence_config_transport_namespace;
    const transport = { template: null, loader: null, consumers: [] };

    const templateAbs = path.resolve(config.project_root, templateFile);
    if (fs.existsSync(templateAbs)) {
      const lines = fs.readFileSync(templateAbs, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (new RegExp('^\\s*' + key + '\\s*:').test(lines[i])) {
          transport.template = { file: templateFile, line: i + 1, text: lines[i].trim().slice(0, 200) };
          break;
        }
      }
    }
    const loaderAbs = path.resolve(config.project_root, loaderFile);
    if (fs.existsSync(loaderAbs)) {
      const lines = fs.readFileSync(loaderAbs, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes("'" + key + "'")) {
          transport.loader = { file: loaderFile, line: i + 1, text: lines[i].trim().slice(0, 200) };
          break;
        }
      }
    }
    const limit = clampNumber(config.repo_intelligence_reference_result_limit, 80, 1, 5000);
    for (const relPath of Object.keys(current.files)) {
      if (current.files[relPath].oversize) continue;
      if (relPath === templateFile || relPath === loaderFile) continue;
      let content;
      try {
        content = fs.readFileSync(path.join(config.project_root, relPath), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes('.' + key) || lines[i].includes("'" + key + "'") || lines[i].includes('"' + key + '"')) {
          transport.consumers.push({ file: relPath, line: i + 1, text: lines[i].trim().slice(0, 200) });
          break;
        }
      }
      if (transport.consumers.length >= limit) break;
    }
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_CONFIG_TRANSPORT',
      key,
      namespace,
      transport,
      complete: Boolean(transport.template && transport.loader)
    };
  }

  function find_relevant_tests(target) {
    const current = ensureMap(false);
    const limit = clampNumber(config.repo_intelligence_reference_result_limit, 80, 1, 5000);
    const normalized = String(target).replace(/\.cjs$|\.js$/, '');
    const baseName = path.basename(normalized);
    const matches = [];
    for (const [testPath, targets] of Object.entries(current.test_to_source)) {
      if (targets.some((t) => t === normalized || t.endsWith('/' + baseName) || t.includes(baseName))) {
        matches.push({ test: testPath, targets });
        if (matches.length >= limit) break;
      }
    }
    // Also match tests whose filename references the target name.
    if (matches.length < limit) {
      for (const relPath of Object.keys(current.files)) {
        if (!current.files[relPath].is_test) continue;
        if (matches.some((m) => m.test === relPath)) continue;
        if (relPath.toLowerCase().includes(baseName.toLowerCase())) {
          matches.push({ test: relPath, targets: [] });
          if (matches.length >= limit) break;
        }
      }
    }
    return { marker: 'FLOKI_V2_REPO_INTELLIGENCE_RELEVANT_TESTS', target: normalized, count: matches.length, tests: matches };
  }

  function find_runtime_owner(targetPath) {
    const current = ensureMap(false);
    const normalized = toPosix(String(targetPath)).replace(/^\.\//, '');
    const owners = [];
    const baseName = path.basename(normalized).replace(/\.cjs$|\.js$/, '');
    for (const entryPoint of current.runtime_entry_points) {
      const rec = current.files[entryPoint];
      if (rec && rec.imports && rec.imports.some((imp) => imp.includes(baseName))) {
        owners.push({ entry_point: entryPoint, relation: 'direct_import' });
      }
    }
    // Reverse reachability: any file that imports the target.
    const limit = clampNumber(config.repo_intelligence_reference_result_limit, 80, 1, 5000);
    const importers = [];
    for (const relPath of Object.keys(current.files)) {
      const rec = current.files[relPath];
      if (!rec.imports) continue;
      if (rec.imports.some((imp) => imp.includes(baseName))) {
        importers.push(relPath);
        if (importers.length >= limit) break;
      }
    }
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_RUNTIME_OWNER',
      target: normalized,
      runtime_entry_points: current.runtime_entry_points,
      owners,
      importers
    };
  }

  function read_file_range(relPath, opts = {}) {
    const current = ensureMap(false);
    const normalized = toPosix(String(relPath)).replace(/^\.\//, '');
    const abs = path.resolve(config.project_root, normalized);
    if (!abs.startsWith(config.project_root + path.sep) && abs !== config.project_root) {
      throw new Error('read_file_range path escaped the project root');
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error('file not found: ' + normalized);
    }
    const start = clampNumber(opts.start, 1, 1, 100000000);
    const defaultLines = clampNumber(config.repo_intelligence_read_range_default_lines, 200, 1, 100000);
    const maxLines = clampNumber(config.repo_intelligence_read_range_max_lines, 400, 1, 100000);
    const requested = clampNumber(opts.lines, defaultLines, 1, maxLines);
    const maxChars = clampNumber(config.repo_intelligence_read_range_max_chars, 24000, 256, 1024 * 1024);
    const allLines = fs.readFileSync(abs, 'utf8').split('\n');
    const total = allLines.length;
    const startIdx = Math.min(start - 1, total);
    let endIdx = Math.min(startIdx + requested, total);
    let slice = allLines.slice(startIdx, endIdx).join('\n');
    let charTruncated = false;
    if (slice.length > maxChars) {
      slice = slice.slice(0, maxChars);
      charTruncated = true;
      // recompute endIdx to the last complete line we returned
      endIdx = startIdx + slice.split('\n').length;
    }
    const record = current.files[normalized] || null;
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_FILE_RANGE',
      path: normalized,
      start_line: startIdx + 1,
      end_line: endIdx,
      total_lines: total,
      protected: record ? record.protected : matchesPrefixList(normalized, splitPipeList(config.repo_intelligence_protected_path_prefixes)),
      char_truncated: charTruncated,
      content: slice,
      next_offset: endIdx < total ? endIdx + 1 : null
    };
  }

  function read_log_window(logPath, opts = {}) {
    const abs = path.isAbsolute(logPath) ? logPath : path.resolve(config.project_root, logPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error('log not found: ' + logPath);
    }
    const maxLines = clampNumber(config.repo_intelligence_log_window_max_lines, 400, 1, 100000);
    const defaultLines = clampNumber(config.repo_intelligence_log_window_default_lines, 120, 1, 100000);
    const requested = clampNumber(opts.lines, defaultLines, 1, maxLines);
    const maxChars = clampNumber(config.repo_intelligence_log_window_max_chars, 24000, 256, 1024 * 1024);
    const allLines = fs.readFileSync(abs, 'utf8').split('\n');
    const total = allLines.length;
    const from = opts.from === 'head' ? 0 : Math.max(0, total - requested);
    let slice = allLines.slice(from, from + requested).join('\n');
    let charTruncated = false;
    if (slice.length > maxChars) {
      slice = slice.slice(slice.length - maxChars);
      charTruncated = true;
    }
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_LOG_WINDOW',
      path: logPath,
      total_lines: total,
      from_line: from + 1,
      returned_lines: Math.min(requested, total - from),
      char_truncated: charTruncated,
      content: slice
    };
  }

  function read_git_diff(opts = {}) {
    const maxChars = clampNumber(config.repo_intelligence_git_diff_max_chars, 60000, 256, 1024 * 1024 * 8);
    const args = ['-C', config.project_root, 'diff'];
    if (opts.staged === true) args.push('--staged');
    if (opts.stat === true) args.push('--stat');
    if (typeof opts.pathspec === 'string' && opts.pathspec.trim()) {
      args.push('--', opts.pathspec.trim());
    }
    let output = '';
    let ok = true;
    let error = null;
    try {
      output = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
    } catch (err) {
      ok = false;
      error = err && err.message ? err.message.slice(0, 500) : String(err);
      output = err && err.stdout ? String(err.stdout) : '';
    }
    let truncated = false;
    if (output.length > maxChars) {
      output = output.slice(0, maxChars);
      truncated = true;
    }
    return { marker: 'FLOKI_V2_REPO_INTELLIGENCE_GIT_DIFF', ok, error, truncated, diff: output };
  }

  function readCandidateHistory(limit) {
    let candidates = [];
    try {
      candidates = store.listCandidates(config) || [];
    } catch {
      candidates = [];
    }
    return candidates
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        status: c.status,
        objective: c.objective ? String(c.objective).slice(0, 240) : null,
        kind: c.kind || c.candidate_type || 'code_patch',
        created_at: c.created_at || null,
        risk_level: c.risk_level || null
      }));
  }

  function get_candidate_history(opts = {}) {
    const limit = clampNumber(
      opts.limit,
      config.repo_intelligence_candidate_history_limit,
      1,
      config.repo_intelligence_candidate_history_limit
    );
    const all = readCandidateHistory(config.repo_intelligence_candidate_history_limit);
    return { marker: 'FLOKI_V2_REPO_INTELLIGENCE_CANDIDATE_HISTORY', count: all.length, candidates: all.slice(0, limit) };
  }

  function compare_candidate_patch(idA, idB) {
    let a = null;
    let b = null;
    try {
      a = store.readCandidate(idA, config);
    } catch {
      a = null;
    }
    try {
      b = store.readCandidate(idB, config);
    } catch {
      b = null;
    }
    const summarize = (cand) => {
      if (!cand) return null;
      const manifest = cand.manifest || cand;
      return {
        id: manifest.id,
        status: manifest.status,
        changed_files: manifest.changed_files || manifest.verified_changed_files || [],
        patch_sha256: manifest.patch_sha256 || null,
        diff_chars: typeof cand.changes_diff === 'string' ? cand.changes_diff.length : null
      };
    };
    const sa = summarize(a);
    const sb = summarize(b);
    let overlap = [];
    if (sa && sb) {
      const setB = new Set(sb.changed_files);
      overlap = (sa.changed_files || []).filter((f) => setB.has(f));
    }
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_PATCH_COMPARE',
      a: sa,
      b: sb,
      identical_patch: Boolean(sa && sb && sa.patch_sha256 && sa.patch_sha256 === sb.patch_sha256),
      overlapping_files: overlap
    };
  }

  function readDenialHistory(limit) {
    let candidates = [];
    try {
      candidates = store.listCandidates(config) || [];
    } catch {
      candidates = [];
    }
    return candidates
      .filter((c) => c.status === 'denied')
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        objective: c.objective ? String(c.objective).slice(0, 240) : null,
        denial_reason: c.denial_reason || c.deny_reason || null,
        patch_sha256: c.patch_sha256 || null,
        created_at: c.created_at || null
      }));
  }

  function get_denial_requirements(opts = {}) {
    const limit = clampNumber(
      opts.limit,
      config.repo_intelligence_denial_history_limit,
      1,
      config.repo_intelligence_denial_history_limit
    );
    const all = readDenialHistory(config.repo_intelligence_denial_history_limit);
    return { marker: 'FLOKI_V2_REPO_INTELLIGENCE_DENIAL_REQUIREMENTS', count: all.length, denials: all.slice(0, limit) };
  }

  function compare_to_denial(input) {
    const denials = readDenialHistory(config.repo_intelligence_denial_history_limit);
    const sha = typeof input === 'object' && input ? input.patch_sha256 : null;
    const objective = typeof input === 'object' && input ? String(input.objective || '') : String(input || '');
    const matches = [];
    for (const denial of denials) {
      let score = 0;
      const reasons = [];
      if (sha && denial.patch_sha256 && sha === denial.patch_sha256) {
        score += 100;
        reasons.push('identical_patch_sha256');
      }
      if (objective && denial.objective) {
        const a = new Set(objective.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        const b = new Set(denial.objective.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        let shared = 0;
        for (const w of a) if (b.has(w)) shared += 1;
        if (shared >= 3) {
          score += shared;
          reasons.push('objective_overlap:' + shared);
        }
      }
      if (score > 0) matches.push({ denial, score, reasons });
    }
    matches.sort((x, y) => y.score - x.score);
    return {
      marker: 'FLOKI_V2_REPO_INTELLIGENCE_DENIAL_COMPARE',
      is_unchanged_duplicate: matches.some((m) => m.reasons.includes('identical_patch_sha256')),
      match_count: matches.length,
      matches: matches.slice(0, 10)
    };
  }

  const tools = Object.freeze({
    get_repository_map,
    inspect_symbol,
    find_references,
    find_callers,
    find_config_transport_path,
    find_relevant_tests,
    find_runtime_owner,
    read_file_range,
    read_log_window,
    read_git_diff,
    compare_candidate_patch,
    compare_to_denial,
    get_candidate_history,
    get_denial_requirements
  });

  return Object.freeze({
    config,
    rebuild: () => ensureMap(true),
    getMap: () => ensureMap(false),
    tools
  });
}

const TOOL_NAMES = Object.freeze([
  'get_repository_map',
  'inspect_symbol',
  'find_references',
  'find_callers',
  'find_config_transport_path',
  'find_relevant_tests',
  'find_runtime_owner',
  'read_file_range',
  'read_log_window',
  'read_git_diff',
  'compare_candidate_patch',
  'compare_to_denial'
]);

module.exports = {
  buildRepositoryMap,
  loadPersistedMap,
  createRepoIntelligence,
  splitPipeList,
  mapPath,
  TOOL_NAMES
};

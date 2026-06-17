'use strict';

/**
 * Tiny YAML reader for Floki config files.
 *
 * Supported subset:
 * - nested maps by two-space indentation
 * - scalar strings, numbers, booleans, null
 * - comments and blank lines
 *
 * This is intentionally not a general YAML parser.
 */

const fs = require('node:fs');

function stripComment(line) {
  const index = line.indexOf(' #');
  if (index >= 0) return line.slice(0, index);
  return line;
}

function parseScalar(value) {
  const raw = String(value || '').trim();

  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;

  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  return raw;
}

function countIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function parseYaml(text) {
  if (typeof text !== 'string') {
    throw new TypeError('YAML text must be a string');
  }

  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = text.split(/\r?\n/);

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const original = lines[lineNumber];
    const withoutComment = stripComment(original);
    const trimmed = withoutComment.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith('- ')) {
      throw new Error('yaml-lite does not support arrays; use maps only near line ' + (lineNumber + 1));
    }

    const indent = countIndent(withoutComment);

    if (indent % 2 !== 0) {
      throw new Error('YAML indentation must use multiples of two spaces near line ' + (lineNumber + 1));
    }

    const match = trimmed.match(/^([^:]+):(.*)$/);
    if (!match) {
      throw new Error('Invalid YAML line ' + (lineNumber + 1) + ': ' + original);
    }

    const key = match[1].trim();
    const rest = match[2];

    if (!key) {
      throw new Error('Empty YAML key near line ' + (lineNumber + 1));
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;

    if (rest.trim() === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

function loadYamlFile(filePath) {
  return parseYaml(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  parseScalar,
  parseYaml,
  loadYamlFile
};

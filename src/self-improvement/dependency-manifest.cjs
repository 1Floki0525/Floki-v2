'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Returns true when package.json declares installable dependencies or
// workspaces, i.e. a populated node_modules is expected. Returns false for a
// manifest with no installable packages — a valid EMPTY dependency tree that
// may legitimately produce no node_modules and must still be treated as a
// successful dependency cache rather than a failed install.
//
// Extracted verbatim from containers/self-improvement/agent.cjs so the agent and
// its contract tests exercise the same predicate.
function dependencyManifestRequiresNodeModules(projectDir) {
  const packageFile = path.join(projectDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  } catch (error) {
    throw new Error(
      'dependency manifest is unreadable: ' +
      packageFile + ': ' + error.message
    );
  }

  for (const key of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies'
  ]) {
    const value = manifest[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      return true;
    }
  }

  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces) && workspaces.length > 0) return true;
  if (
    workspaces &&
    typeof workspaces === 'object' &&
    Array.isArray(workspaces.packages) &&
    workspaces.packages.length > 0
  ) {
    return true;
  }
  return false;
}

module.exports = { dependencyManifestRequiresNodeModules };

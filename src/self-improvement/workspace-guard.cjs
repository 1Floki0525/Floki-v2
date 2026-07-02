'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Real-path containment for the RSI sandbox workspace.
//
// A candidate path is inside the workspace only if its fully resolved real path
// equals the workspace real root or sits beneath it. Comparing resolved real
// paths (not the symlinked workspace path) lets valid project files through when
// /workspace passes through a symlink, while still rejecting escapes through a
// symlink that resolves outside the workspace.
//
// Extracted from containers/self-improvement/agent.cjs so the agent and its
// contract tests exercise the same containment check.
function isRealPathInsideRoot(rootReal, candidateReal) {
  const root = String(rootReal || '');
  const candidate = String(candidateReal || '');
  if (root.length === 0) return false;
  return candidate === root || candidate.startsWith(root + path.sep);
}

function assertRealPathInsideRoot(rootReal, absolutePath, label) {
  const real = fs.realpathSync.native(absolutePath);
  if (!isRealPathInsideRoot(rootReal, real)) {
    throw new Error(
      String(label || 'path') + ' escapes workspace through symlink or resolved path'
    );
  }
  return real;
}

module.exports = { isRealPathInsideRoot, assertRealPathInsideRoot };

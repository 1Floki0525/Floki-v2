'use strict';

// Role-separated agent contexts for the RSI harness.
//
// Each autonomous phase runs in a clean, role-specific context with its own
// phase-specific model parameters and a tool allowlist. Only the implementer
// role may write to the isolated source workspace, and the writer lock forbids
// concurrent writers. All role definitions originate in chat YAML and flow
// through src/self-improvement/config.cjs (no hardcoded role policy).

const { loadSelfImprovementConfig } = require('./config.cjs');

// Tools that mutate the isolated source workspace. Governed by one-writer.
const WRITE_TOOLS = Object.freeze(['write_file', 'apply_patch']);

const ROLE_KEYS = Object.freeze([
  'self_reflector',
  'goal_selector',
  'researcher',
  'repo_investigator',
  'implementer',
  'verifier',
  'critic',
  'memory_curator'
]);

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('role config ' + label + ' must be a finite number');
  }
  return value;
}

function buildRole(name, config, baseModel) {
  const prefix = 'role_' + name + '_';
  const tools = splitPipeList(config[prefix + 'tools']);
  if (tools.length === 0) {
    throw new Error('role ' + name + ' has an empty tool allowlist');
  }
  const canWrite = config[prefix + 'can_write'];
  if (typeof canWrite !== 'boolean') {
    throw new Error('role ' + name + ' can_write must be boolean');
  }
  // A non-writer role must not be granted any workspace-mutation tool.
  if (!canWrite) {
    for (const tool of tools) {
      if (WRITE_TOOLS.includes(tool)) {
        throw new Error('non-writer role ' + name + ' may not list write tool ' + tool);
      }
    }
  }
  return Object.freeze({
    name,
    can_write: canWrite,
    context_budget_chars: requireNumber(config[prefix + 'context_budget_chars'], prefix + 'context_budget_chars'),
    tools: Object.freeze(tools),
    model: Object.freeze({
      provider: baseModel.provider,
      name: baseModel.name,
      endpoint: baseModel.endpoint,
      keep_alive: baseModel.keep_alive,
      timeout_ms: baseModel.timeout_ms,
      temperature: requireNumber(config[prefix + 'temperature'], prefix + 'temperature'),
      top_p: requireNumber(config[prefix + 'top_p'], prefix + 'top_p')
    })
  });
}

function loadRoles(config = loadSelfImprovementConfig()) {
  const sequence = splitPipeList(config.role_sequence);
  if (sequence.length === 0) {
    throw new Error('role_sequence is empty');
  }
  for (const name of sequence) {
    if (!ROLE_KEYS.includes(name)) {
      throw new Error('unknown role in role_sequence: ' + name);
    }
  }
  for (const name of ROLE_KEYS) {
    if (!sequence.includes(name)) {
      throw new Error('role_sequence is missing required role: ' + name);
    }
  }

  const baseModel = config.model;
  const roles = {};
  let writerRole = null;
  for (const name of sequence) {
    const role = buildRole(name, config, baseModel);
    roles[name] = role;
    if (role.can_write) {
      if (writerRole) {
        throw new Error('more than one role may write: ' + writerRole + ' and ' + name);
      }
      writerRole = name;
    }
  }
  if (!writerRole) {
    throw new Error('exactly one role must be allowed to write; none configured');
  }

  return Object.freeze({
    sequence: Object.freeze([...sequence]),
    roles: Object.freeze(roles),
    writer_role: writerRole
  });
}

function getRole(name, registry) {
  const reg = registry || loadRoles();
  const role = reg.roles[name];
  if (!role) throw new Error('unknown role: ' + name);
  return role;
}

function roleHasTool(role, toolName) {
  return role.tools.includes(toolName);
}

function assertToolAllowed(roleName, toolName, registry) {
  const reg = registry || loadRoles();
  const role = getRole(roleName, reg);
  if (!roleHasTool(role, toolName)) {
    throw new Error('role ' + roleName + ' is not allowed to use tool ' + toolName);
  }
  if (WRITE_TOOLS.includes(toolName) && !role.can_write) {
    throw new Error('role ' + roleName + ' may not perform workspace writes');
  }
  return true;
}

// One-writer enforcement: only the writer role may hold the lock, and only one
// holder may exist at a time. The lock guards all workspace-mutation tools.
function createWriterLock(registry) {
  const reg = registry || loadRoles();
  let holder = null;

  return Object.freeze({
    acquire(roleName) {
      const role = getRole(roleName, reg);
      if (!role.can_write) {
        throw new Error('role ' + roleName + ' may not acquire the workspace writer lock');
      }
      if (holder && holder !== roleName) {
        throw new Error('workspace writer lock already held by ' + holder);
      }
      holder = roleName;
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        if (holder === roleName) holder = null;
      };
    },
    assertCanWrite(roleName, toolName) {
      const role = getRole(roleName, reg);
      if (WRITE_TOOLS.includes(toolName) && !role.can_write) {
        throw new Error('role ' + roleName + ' may not use write tool ' + toolName);
      }
      if (WRITE_TOOLS.includes(toolName) && holder !== roleName) {
        throw new Error('role ' + roleName + ' must hold the writer lock to use ' + toolName);
      }
      return true;
    },
    holder() {
      return holder;
    }
  });
}

function buildRoleContext(roleName, registry) {
  const reg = registry || loadRoles();
  const role = getRole(roleName, reg);
  return Object.freeze({
    role: role.name,
    can_write: role.can_write,
    model: role.model,
    tools: role.tools,
    context_budget_chars: role.context_budget_chars,
    is_writer: reg.writer_role === role.name
  });
}

module.exports = {
  WRITE_TOOLS,
  ROLE_KEYS,
  loadRoles,
  getRole,
  roleHasTool,
  assertToolAllowed,
  createWriterLock,
  buildRoleContext,
  splitPipeList
};

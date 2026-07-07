'use strict';

// Repository-local progressive skill system for the RSI harness.
//
// Skills live under config/rsi-skills/<id>/SKILL.md and are indexed by
// config/rsi-skills/manifest.json. A skill loads only when its triggers match
// the active task signals, so a role context receives focused instructions
// instead of every skill at once. All limits originate in chat YAML.

const fs = require('node:fs');
const path = require('node:path');

const { loadSelfImprovementConfig } = require('./config.cjs');

function skillsRoot(config) {
  return config.skills_root.startsWith('/')
    ? config.skills_root
    : path.resolve(config.project_root, config.skills_root);
}

function loadManifest(config = loadSelfImprovementConfig()) {
  const manifestPath = path.join(skillsRoot(config), config.skills_manifest_file_name);
  if (!fs.existsSync(manifestPath)) {
    throw new Error('RSI skills manifest missing: ' + manifestPath);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !Array.isArray(manifest.skills)) {
    throw new Error('RSI skills manifest is malformed (no skills array)');
  }
  return manifest;
}

function validateManifest(config = loadSelfImprovementConfig()) {
  const manifest = loadManifest(config);
  const root = skillsRoot(config);
  const seen = new Set();
  const problems = [];
  for (const skill of manifest.skills) {
    if (!skill.id || typeof skill.id !== 'string') {
      problems.push('skill with missing id');
      continue;
    }
    if (seen.has(skill.id)) problems.push('duplicate skill id: ' + skill.id);
    seen.add(skill.id);
    if (!Array.isArray(skill.triggers) || skill.triggers.length === 0) {
      problems.push(skill.id + ': empty triggers');
    }
    const instructionFile = skill.instruction_file || (skill.id + '/' + config.skills_instruction_file_name);
    const abs = path.join(root, instructionFile);
    if (!fs.existsSync(abs)) problems.push(skill.id + ': missing instruction file ' + instructionFile);
  }
  return Object.freeze({ ok: problems.length === 0, count: manifest.skills.length, problems });
}

function listSkills(config = loadSelfImprovementConfig()) {
  return loadManifest(config).skills.map((s) =>
    Object.freeze({
      id: s.id,
      name: s.name,
      description: s.description,
      triggers: Object.freeze([...(s.triggers || [])]),
      references: Object.freeze([...(s.references || [])])
    })
  );
}

function normalizeSignals(signals) {
  if (Array.isArray(signals)) return signals.join(' ');
  if (signals && typeof signals === 'object') {
    return Object.values(signals).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
  }
  return String(signals || '');
}

function scoreSkill(skill, haystack) {
  let score = 0;
  const matched = [];
  for (const trigger of skill.triggers || []) {
    const needle = String(trigger).toLowerCase();
    if (!needle) continue;
    if (haystack.includes(needle)) {
      score += 1;
      matched.push(trigger);
    }
  }
  return { score, matched };
}

// Progressive selection: returns at most skills_max_active skills whose match
// score meets skills_match_score_threshold, highest score first.
function selectSkills(signals, config = loadSelfImprovementConfig()) {
  const manifest = loadManifest(config);
  const haystack = normalizeSignals(signals).toLowerCase();
  const threshold = config.skills_match_score_threshold;
  const maxActive = config.skills_max_active;
  const scored = [];
  for (const skill of manifest.skills) {
    const { score, matched } = scoreSkill(skill, haystack);
    if (score >= threshold) {
      scored.push({ id: skill.id, name: skill.name, score, matched });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return Object.freeze({
    marker: 'FLOKI_V2_RSI_SKILLS_SELECTION',
    threshold,
    max_active: maxActive,
    selected: Object.freeze(scored.slice(0, maxActive)),
    considered: manifest.skills.length
  });
}

function loadSkillInstructions(skillId, config = loadSelfImprovementConfig()) {
  const manifest = loadManifest(config);
  const skill = manifest.skills.find((s) => s.id === skillId);
  if (!skill) throw new Error('unknown skill: ' + skillId);
  const instructionFile = skill.instruction_file || (skill.id + '/' + config.skills_instruction_file_name);
  const abs = path.join(skillsRoot(config), instructionFile);
  if (!fs.existsSync(abs)) throw new Error('skill instruction file missing: ' + abs);
  let content = fs.readFileSync(abs, 'utf8');
  let truncated = false;
  const max = config.skills_instruction_max_chars;
  if (content.length > max) {
    content = content.slice(0, max);
    truncated = true;
  }
  return Object.freeze({
    id: skill.id,
    name: skill.name,
    references: Object.freeze([...(skill.references || [])]),
    truncated,
    instructions: content
  });
}

// Convenience: select then load instructions for the active skills, bounded.
function loadActiveSkills(signals, config = loadSelfImprovementConfig()) {
  const selection = selectSkills(signals, config);
  return Object.freeze({
    ...selection,
    skills: Object.freeze(selection.selected.map((s) => loadSkillInstructions(s.id, config)))
  });
}

module.exports = {
  loadManifest,
  validateManifest,
  listSkills,
  selectSkills,
  loadSkillInstructions,
  loadActiveSkills,
  skillsRoot
};

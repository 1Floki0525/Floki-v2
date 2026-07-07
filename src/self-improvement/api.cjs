'use strict';

const { loadSelfImprovementConfig } = require('./config.cjs');
const {
  ensureApprovalToken,
  listCandidates,
  readCandidate,
  readStatus
} = require('./store.cjs');
const {
  abortActiveRun,
  approveCandidate,
  denyCandidate,
  pause,
  resume,
  runNow
} = require('./promotion.cjs');
const { stopActiveRunProcess } = require('./sandbox.cjs');
const { buildSelfImprovementUiStatus } = require('./ui-status.cjs');
const { assertApprovalToken, appendAudit } = require('./store.cjs');

function createSelfImprovementApi() {
  const config = loadSelfImprovementConfig();
  ensureApprovalToken(config);

  return Object.freeze({
    status() {
      return buildSelfImprovementUiStatus({ config });
    },
    listCandidates() {
      return listCandidates(config);
    },
    readCandidate(id) {
      return readCandidate(id, config);
    },
    approve(id, token) {
      return approveCandidate(id, token, config);
    },
    deny(id, token, reason) {
      return denyCandidate(id, token, reason, config);
    },
    pause(token) {
      return pause(token, config);
    },
    resume(token) {
      return resume(token, config);
    },
    runNow(token, objective, kind) {
      return runNow(token, objective, kind, config);
    },
    async abort(token, reason, kind) {
      return abortActiveRun(
        token,
        reason,
        kind,
        config
      );
    },
    preempt(reason) {
      return stopActiveRunProcess(reason, config);
    }
  });
}

module.exports = {
  createSelfImprovementApi
};

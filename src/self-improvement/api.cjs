'use strict';

const { loadSelfImprovementConfig } = require('./config.cjs');
const {
  ensureApprovalToken,
  listCandidates,
  readCandidate,
  readStatus
} = require('./store.cjs');
const {
  approveCandidate,
  denyCandidate,
  pause,
  resume,
  runNow
} = require('./promotion.cjs');
const { stopCurrentContainer } = require('./sandbox.cjs');
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
    abort(token, reason, kind) {
      assertApprovalToken(token, config);
      const runKind = String(kind || 'code');
      const abortReason = String(reason || ('maker_abort_' + runKind));
      const requested = stopCurrentContainer(abortReason, config);
      appendAudit('maker_abort_requested', {
        run_kind: runKind,
        reason: abortReason,
        requested
      }, config);
      return Object.freeze({
        ok: true,
        verified: true,
        abort_requested: requested === true,
        run_kind: runKind,
        reason: abortReason
      });
    },
    preempt(reason) {
      return stopCurrentContainer(reason, config);
    }
  });
}

module.exports = {
  createSelfImprovementApi
};

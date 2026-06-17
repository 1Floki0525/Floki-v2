'use strict';

/**
 * Floki-v2 runtime CLI helper.
 *
 * Used by shell proof scripts so the scripts do not need heredocs.
 */

const runtime = require('./runtime-config.cjs');

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main(argv) {
  const command = argv[2];

  try {
    if (command === 'validate-node') {
      const versionText = argv[3] || process.version;
      printJson(runtime.validateNodeRuntime(versionText));
      return;
    }

    if (command === 'validate-java') {
      const javaVersionText = argv.slice(3).join('\n');

      if (!javaVersionText.trim()) {
        throw new Error('validate-java requires java -version text as arguments');
      }

      printJson(runtime.validateJavaRuntime(javaVersionText));
      return;
    }

    if (command === 'print-policy') {
      runtime.validateRuntimeConfig();
      printJson({
        ok: true,
        marker: 'FLOKI_V2_RUNTIME_POLICY_CONFIG_OK',
        node_minimum_major: runtime.RUNTIME_CONFIG.node.minimum_major,
        node_preferred_lts_major: runtime.RUNTIME_CONFIG.node.preferred_lts_major,
        java_target_major: runtime.RUNTIME_CONFIG.java.target_major,
        future_papermc_target: runtime.RUNTIME_CONFIG.papermc.future_target_server_version,
        papermc_enabled_now: runtime.RUNTIME_CONFIG.papermc.enabled_in_current_stage,
        bridge_enabled_now: runtime.RUNTIME_CONFIG.papermc.wire_bridge_in_current_stage
      });
      return;
    }

    throw new Error(`unknown runtime-cli command: ${command || '(none)'}`);
  } catch (error) {
    fail(error);
  }
}

main(process.argv);

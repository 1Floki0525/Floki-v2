#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

for test_file in tests/self-improvement-*.cjs; do
  case "$test_file" in
    tests/self-improvement-run-now-immediate-contract-test.cjs)
      echo "Skipping host-only RSI contract in sandbox: $test_file"
      continue
      ;;
  esac
  node "$test_file"
done

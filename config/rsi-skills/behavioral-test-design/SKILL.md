# Behavioral test design

Design a focused test that executes real production logic and asserts behavior change.

## When to use
You need a focused test proving a real behavior change (not a count/enum/type-only assertion).

## Pattern (house style)
- `'use strict'`, require `node:assert/strict`, exercise the real exported production function, print a JSON marker object on success, exit non-zero on failure.
- Use deterministic boundary doubles only for unavailable external hardware/services; still execute the real control logic, exact commands, state transitions, cleanup, and failure propagation.

## Rules
- No weakened assertions, deleted tests, or fake pass markers.
- The test must fail before the fix and pass after.

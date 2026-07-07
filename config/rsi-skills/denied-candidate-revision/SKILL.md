# Denied candidate revision

Revise a denied RSI candidate so it satisfies the denial requirements and its eval.

## When to use
A prior candidate was denied and you are forming a new goal in the same area.

## Steps
1. `get_denial_requirements` and `compare_to_denial({objective, patch_sha256})`.
2. If `is_unchanged_duplicate` is true, the controller will reject — change the approach materially.
3. Address the specific denial reason; satisfy any denial-derived regression eval.

## Rules
- An unchanged duplicate of denied work is not a valid goal.
- Every actionable denial should have produced a regression eval; your revision must pass it.

# React layout repair

Fix RSI UI layout so the page is fixed to the viewport with bounded scrolling panels.

## When to use
The RSI page scrolls as a whole, controls/terminal disappear, or panels grow unbounded.

## Steps
1. Keep the page fixed to the viewport; use independent bounded scrolling panels (overflow-y auto with a max height).
2. Keep top controls and the terminal always visible.
3. Bound any streaming/terminal React state (cap array length) to avoid unbounded growth.

## Rules
- Do not use window.prompt / window.confirm — use real in-app confirmation controls.

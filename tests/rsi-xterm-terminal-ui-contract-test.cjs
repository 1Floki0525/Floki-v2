'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const json = (relative) => JSON.parse(text(relative));

// Contract added 2026-07-05: the RSI terminal renders the proven raw PTY byte
// transport through a genuine read-only xterm renderer instead of the old
// sanitized <pre> viewer. The invariants below pin the dependency versions,
// the live mount in RSILab, the raw-byte path (base64 -> Uint8Array ->
// terminal.write, no sanitization), the read-only guarantee, open/fit/dispose
// lifecycle, the fixed bounded terminal body, cursor continuity, bounded
// replay, and the Load Older / Follow Output controls.

// --- Official xterm dependencies pinned exactly in the app (never the root).
const REQUIRED_XTERM_VERSION = '6.0.0';
const REQUIRED_FIT_VERSION = '0.11.0';

const appPackage = json('apps/floki-neural-interface/package.json');
assert.equal(
  appPackage.dependencies['@xterm/xterm'],
  REQUIRED_XTERM_VERSION,
  'app package.json must pin @xterm/xterm exactly'
);
assert.equal(
  appPackage.dependencies['@xterm/addon-fit'],
  REQUIRED_FIT_VERSION,
  'app package.json must pin @xterm/addon-fit exactly'
);

const appLock = json('apps/floki-neural-interface/package-lock.json');
const lockRootDeps = appLock.packages[''].dependencies;
assert.equal(lockRootDeps['@xterm/xterm'], REQUIRED_XTERM_VERSION, 'lockfile root must pin @xterm/xterm');
assert.equal(lockRootDeps['@xterm/addon-fit'], REQUIRED_FIT_VERSION, 'lockfile root must pin @xterm/addon-fit');
assert.equal(
  appLock.packages['node_modules/@xterm/xterm'].version,
  REQUIRED_XTERM_VERSION,
  'lockfile must resolve @xterm/xterm ' + REQUIRED_XTERM_VERSION
);
assert.equal(
  appLock.packages['node_modules/@xterm/addon-fit'].version,
  REQUIRED_FIT_VERSION,
  'lockfile must resolve @xterm/addon-fit ' + REQUIRED_FIT_VERSION
);

const rootPackage = json('package.json');
assert.equal(
  (rootPackage.dependencies || {})['@xterm/xterm'],
  undefined,
  'xterm belongs to the app, not the repository root'
);
assert.equal(
  (rootPackage.devDependencies || {})['@xterm/xterm'],
  undefined,
  'xterm belongs to the app, not the repository root'
);

// --- The dedicated read-only renderer component.
const COMPONENT_PATH = 'apps/floki-neural-interface/src/components/rsi/ReadOnlyXtermTerminal.jsx';
assert.ok(
  fs.existsSync(path.join(ROOT, COMPONENT_PATH)),
  'ReadOnlyXtermTerminal component must exist at ' + COMPONENT_PATH
);
const component = text(COMPONENT_PATH);

assert.match(component, /import \{ Terminal \} from '@xterm\/xterm'/, 'must use the official xterm Terminal');
assert.match(component, /import \{ FitAddon \} from '@xterm\/addon-fit'/, 'must use the official FitAddon');
assert.ok(
  component.includes("import '@xterm/xterm/css/xterm.css'"),
  'official xterm CSS must be imported'
);
assert.match(component, /new Terminal\(/, 'a real xterm Terminal must be instantiated');
assert.ok(component.includes('disableStdin: true'), 'terminal must be read-only (disableStdin: true)');
assert.match(component, /term\.open\(node\)/, 'Terminal.open must attach xterm to the mounted host');
assert.match(
  component,
  /clientWidth <= 0 \|\| node\.clientHeight <= 0/,
  'Terminal.open must wait for measurable nonzero host dimensions'
);
assert.match(component, /loadAddon\(fitAddon\)/, 'FitAddon must be loaded into the terminal');
assert.match(component, /fitAddon\.fit\(\)/, 'FitAddon must actually fit the terminal to its panel');
assert.match(component, /document\.fonts/, 'fit must be refreshed when document fonts settle');
assert.match(component, /new ResizeObserver\(/, 'a ResizeObserver must drive refits');
assert.match(component, /observer\.disconnect\(\)/, 'the ResizeObserver must be disposed on unmount');
assert.match(component, /fitAddon\.dispose\(\)/, 'the FitAddon must be disposed on unmount');
assert.match(component, /term\.dispose\(\)/, 'the Terminal must be disposed on unmount');
assert.match(component, /cancelAnimationFrame\(/, 'pending fit frames must be cancelled on unmount');
assert.match(component, /\.write\(chunk\.bytes/, 'raw chunk bytes must be written to xterm');
assert.match(component, /scrollToBottom\(\)/, 'Follow Output must return to the newest output');
assert.ok(component.includes('rsi-xterm-host'), 'the xterm host must carry the scoped layout class');
assert.doesNotMatch(component, /\.onData\(/, 'no keyboard/paste input may be wired into the terminal');
assert.match(component, /attachCustomKeyEventHandler/, 'read-only xterm must install a copy-only key handler');
assert.match(component, /term\.hasSelection\(\)/, 'copy must require an actual xterm selection');
assert.match(component, /term\.getSelection\(\)/, 'copy must use xterm selection text');
assert.match(component, /navigator\.clipboard\.writeText\(selected\)/, 'Ctrl+C must copy selected terminal text');
assert.match(component, /addEventListener\('contextmenu', handleContextMenu\)/, 'right-click must copy a selection');
assert.match(component, /removeEventListener\('contextmenu', handleContextMenu\)/, 'right-click handler must be disposed');
assert.match(component, /event\.ctrlKey \|\| event\.metaKey/, 'Ctrl+C and Command+C must be supported');
assert.doesNotMatch(component, /sanitizeTerminalText|stripAnsi/, 'the byte stream must not be sanitized');
assert.doesNotMatch(component, /<pre[\s>]/, 'the renderer must never fall back to <pre> text');

// --- RSILab must actually mount the renderer and feed it raw bytes.
const rsiLab = text('apps/floki-neural-interface/src/pages/RSILab.jsx');
assert.match(
  rsiLab,
  /import ReadOnlyXtermTerminal from '@\/components\/rsi\/ReadOnlyXtermTerminal'/,
  'RSILab must import the xterm component'
);
assert.match(rsiLab, /<ReadOnlyXtermTerminal\b/, 'RSILab must mount ReadOnlyXtermTerminal in JSX');
assert.doesNotMatch(rsiLab, /<pre[\s>]/, 'the old raw terminal <pre> display must be removed');
assert.doesNotMatch(
  rsiLab,
  /whitespace-pre|break-words/,
  'terminal bytes must not be rendered through ordinary HTML text wrapping'
);
assert.match(rsiLab, /atob\(/, 'base64 payloads must be decoded');
assert.match(rsiLab, /new Uint8Array\(/, 'decoded bytes must become a Uint8Array');
assert.ok(
  rsiLab.includes("payload?.encoding === 'base64' && payload.data_base64"),
  'the raw data_base64 field must drive rendering when the source is a real PTY'
);
assert.doesNotMatch(rsiLab, /sanitizeTerminalText/, 'the UI must not sanitize the byte stream');
assert.match(
  rsiLab,
  /payload\.source_id !== current\.sourceId/,
  'source identity changes must be detected'
);
assert.match(
  rsiLab,
  /Number\(payload\.cursor\) !== current\.endCursor/,
  'byte cursor continuity must be enforced'
);
assert.ok(
  rsiLab.includes('TERMINAL_TAIL_CURSOR'),
  'bootstrap and recovery must load the newest bounded tail'
);
assert.match(rsiLab, /boundChunksFromStart|terminalWindowBytes/, 'the replay window must stay bounded');

// --- Fixed, bounded terminal card: content must never size the box.
assert.ok(
  rsiLab.includes('h-[clamp(280px,34vh,430px)]'),
  'the terminal body must have a clamped fixed height'
);
assert.ok(rsiLab.includes('min-h-[260px]'), 'the terminal body must keep a readable floor');
assert.ok(rsiLab.includes('max-h-[430px]'), 'the terminal body must keep a hard ceiling');
assert.match(
  rsiLab,
  /relative flex-none min-w-0 overflow-hidden/,
  'the terminal body must be a contained, non-growing flex item'
);

// --- Header controls.
assert.ok(rsiLab.includes('Load older output'), 'the Load Older control must remain');
assert.ok(
  rsiLab.includes('before_cursor: current.startCursor'),
  'Load Older must page backwards by byte cursor'
);
assert.ok(rsiLab.includes('Follow output'), 'a Follow Output control must exist in the header');
assert.ok(rsiLab.includes('Following output'), 'the Follow Output active state must be visible');
assert.match(rsiLab, /aria-pressed=\{following\}/, 'Follow Output must expose its active state');
assert.match(rsiLab, /followOutput\(\)/, 'Follow Output must re-enable following and jump to bottom');

// --- App CSS must lock xterm scrolling inside the host box.
const appCss = text('apps/floki-neural-interface/src/index.css');
assert.match(
  appCss,
  /\.rsi-xterm-host \.xterm \{[^}]*width: 100%;[^}]*height: 100%;/,
  'the .xterm element must fill the fixed host'
);
assert.match(
  appCss,
  /\.rsi-xterm-host \.xterm-viewport \{[^}]*overflow-y: auto !important;[^}]*overflow-x: hidden !important;/,
  'the xterm viewport must scroll internally and never horizontally'
);

// --- No terminal-input backend endpoint may exist for the read-only terminal.
const runtime = text('src/runtime/chat-local-runtime.cjs');
assert.match(
  runtime,
  /req\.method === 'GET' && url\.pathname === '\/self-improvement\/terminal'/,
  'the read-only terminal endpoint must remain a GET'
);
assert.doesNotMatch(
  runtime,
  /req\.method === 'POST' && url\.pathname === '\/self-improvement\/terminal/,
  'no terminal-input endpoint may be added'
);
const adapter = text('apps/floki-neural-interface/src/integrations/floki/adapter.js');
assert.doesNotMatch(
  adapter,
  /terminal\/input|sendSelfImprovementTerminal|writeSelfImprovementTerminal/,
  'the adapter must not grow a terminal input path'
);

// --- Permanent registration through the real Node 24 suite.
const registry = text('tests/rsi-nightly-training-terminal-authority-contract-test.cjs');
assert.ok(
  registry.includes('tests/rsi-xterm-terminal-ui-contract-test.cjs'),
  'this contract must stay registered in the permanent PTY registry'
);
assert.match(
  String(rootPackage.scripts['test:node24'] || ''),
  /rsi-nightly-training-terminal-authority-contract-test\.cjs/,
  'the registry itself must be reached by the real Node 24 suite'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_XTERM_TERMINAL_UI_CONTRACT_PASS',
  xterm_version: REQUIRED_XTERM_VERSION,
  fit_addon_version: REQUIRED_FIT_VERSION,
  live_mount_proven: true,
  bounded_terminal_body: true,
  raw_bytes_rendered: true,
      terminal_read_only: true,
      selection_copy_supported: true,
      right_click_copy_supported: true
}, null, 2));

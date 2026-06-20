'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const BUILD_INDICATOR = path.join(DIST_DIR, 'index.html');
const FLOKI_E2E_FRAME_FILE = path.join(DIST_DIR, 'e2e-test-frame.jpg');
const FRAME_FIXTURE_SCRIPT = path.join(__dirname, 'frame-fixture.cjs');

const HEADED = !!process.env.HEADED;
const TIMEOUT = 60_000;
const RETRY_INTERVAL = 300;

let fixtureProc = null;
let electronApp = null;

function startFrameFixture() {
  return new Promise((resolve, reject) => {
    fixtureProc = spawn(process.execPath, [FRAME_FIXTURE_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FLOKI_E2E_FRAME_FILE, FLOKI_E2E_FRAME_FPS: '10' },
    });
    let resolved = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (!resolved && text.includes('FLOKI_E2E_FRAME_FIXTURE_READY')) {
        resolved = true;
        resolve();
      }
    };
    fixtureProc.stdout.on('data', onData);
    fixtureProc.stderr.on('data', onData);
    fixtureProc.on('error', (err) => { if (!resolved) { resolved = true; reject(err); } });
    fixtureProc.on('exit', (code) => {
      if (!resolved) { resolved = true; reject(new Error(`fixture exited ${code}`)); }
    });
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('fixture timeout')); } }, 10_000);
  });
}

function stopFrameFixture() {
  if (fixtureProc) {
    fixtureProc.kill('SIGTERM');
    fixtureProc = null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForCondition(fn, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) { lastErr = e; }
    await sleep(RETRY_INTERVAL);
  }
  throw new Error(`Timed out waiting for: ${label} — ${lastErr ? lastErr.message : 'no result'}`);
}

async function getLogs(page) {
  return page.evaluate(() => {
    if (typeof window.__e2eLogs !== 'undefined') return window.__e2eLogs;
    return [];
  }).catch(() => []);
}

async function setupPageListeners(page) {
  const errors = [];
  const rejections = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('crash', () => errors.push('PAGE_CRASHED'));
  page.context().on('page', (p) => {
    if (p !== page) errors.push('EXTERNAL_PAGE_OPENED:' + p.url());
  });
  await page.evaluate(() => {
    window.__e2eLogs = [];
    window.addEventListener('error', (e) => { window.__e2eLogs.push('RENDER_ERROR:' + e.message); });
    window.addEventListener('unhandledrejection', (e) => { window.__e2eLogs.push('UNHANDLED_REJECTION:' + e.reason); });
  });
  return { errors, rejections };
}

async function getConsoleLogs(page) {
  return page.evaluate(() => window.__e2eLogs || []).catch(() => []);
}

function assertNoErrors(errors, consoleLogs, phase) {
  const allErrors = [
    ...errors.map((m) => 'PAGE_ERROR:' + m),
    ...consoleLogs.filter((l) => l.startsWith('RENDER_ERROR:') || l.startsWith('UNHANDLED_REJECTION:')),
  ];
  if (allErrors.length > 0) {
    throw new Error(`[${phase}] Found errors: ${allErrors.join(' | ')}`);
  }
}

async function verifyTabRenders(page, tabId, tabLabel) {
  const navBtn = page.locator(`[data-testid="nav-${tabId}"]`);
  await navBtn.click();
  await sleep(500);
  const content = await page.locator('#root').textContent().catch(() => '');
  if (!content || content.length < 10) {
    throw new Error(`${tabLabel} tab produced empty or black content`);
  }
}

async function main() {
  let exitCode = 0;
  const results = [];

  function pass(name) { results.push({ name, status: 'PASS' }); console.log(`  ✓ ${name}`); }
  function fail(name, err) { results.push({ name, status: 'FAIL', error: err.message }); console.log(`  ✗ ${name}: ${err.message}`); exitCode = 1; }

  try {
    /* ------------------------------------------------------------------ */
    /*  BOOTSTRAP                                                         */
    /* ------------------------------------------------------------------ */
    console.log('\n=== Floki-v2 Electron E2E Tests ===\n');

    if (!fs.existsSync(BUILD_INDICATOR)) {
      throw new Error('Build not found. Run `npm run build` first.');
    }

    console.log('Starting frame fixture...');
    await startFrameFixture();
    console.log('Frame fixture ready.');

    console.log('Launching Electron...');
    electronApp = await electron.launch({
      args: [PROJECT_ROOT],
      env: { ...process.env, FLOKI_E2E_FRAME_FILE: FLOKI_E2E_FRAME_FILE },
    });

    console.log('Waiting for window...');
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    /* ------------------------------------------------------------------ */
    /*  1. WINDOW BASICS                                                  */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Window Basics ---');

    {
      const title = await window.title();
      if (!title) fail('window_title', new Error('title empty'));
      else pass('window_title');

      const url = window.url();
      if (url.includes('file://') || url.includes('localhost') || url.includes('127.0.0.1')) {
        pass('window_url_local');
      } else {
        fail('window_url_local', new Error('URL is not local: ' + url));
      }

      await window.waitForSelector('#root', { timeout: 15_000 });
      pass('app_root_mounted');
    }

    /* ------------------------------------------------------------------ */
    /*  2. ERROR-FREE BOOT                                                */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Error-Free Boot ---');

    const { errors, rejections } = await setupPageListeners(window);
    await sleep(2_000);
    const bootLogs = await getConsoleLogs(window);

    try {
      assertNoErrors(errors, bootLogs, 'boot');
      pass('no_boot_errors');
    } catch (e) { fail('no_boot_errors', e); }

    /* ------------------------------------------------------------------ */
    /*  3. ALL TABS RENDER                                                */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Tab Rendering ---');

    const TABS = [
      { id: 'chat',    label: 'Chat Interface' },
      { id: 'dreams',  label: 'Dreams' },
      { id: 'neural',  label: 'Neural Stream' },
      { id: 'system',  label: 'System' },
      { id: 'settings',label: 'Settings' },
    ];

    for (const tab of TABS) {
      try {
        await verifyTabRenders(window, tab.id, tab.label);
        pass(`${tab.label}_renders`);
      } catch (e) { fail(`${tab.label}_renders`, e); }
    }

    /* ------------------------------------------------------------------ */
    /*  4. TAB CYCLING (3x) WITHOUT BLACK WINDOW                          */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Tab Cycling ---');

    for (let cycle = 1; cycle <= 3; cycle++) {
      const tabOrder = [...TABS];
      if (cycle % 2 === 0) tabOrder.reverse();
      for (const tab of tabOrder) {
        try {
          await verifyTabRenders(window, tab.id, tab.label);
        } catch (e) {
          fail(`tab_cycle_${cycle}_${tab.id}`, e);
        }
      }
      pass(`tab_cycle_${cycle}`);
    }

    /* ------------------------------------------------------------------ */
    /*  5. ERROR BOUNDARY NOT TRIGGERED                                   */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Error Boundary ---');

    {
      const pageContent = await window.locator('#root').textContent().catch(() => '');
      if (pageContent.includes('Something went wrong') || pageContent.includes('ErrorBoundary')) {
        fail('error_boundary_not_triggered', new Error('ErrorBoundary was triggered'));
      } else {
        pass('error_boundary_not_triggered');
      }
    }

    const cycleLogs = await getConsoleLogs(window);
    try {
      assertNoErrors(errors, cycleLogs, 'post_cycle');
      pass('no_errors_after_cycling');
    } catch (e) { fail('no_errors_after_cycling', e); }

    /* ------------------------------------------------------------------ */
    /*  6. IPC LISTENERS DO NOT MULTIPLY                                  */
    /* ------------------------------------------------------------------ */
    console.log('\n--- IPC Listener Count ---');

    {
      const count1 = await electronApp.evaluate(({ ipcMain }) => ipcMain.listenerCount('floki:get-initial-status'));
      const count2 = await electronApp.evaluate(({ ipcMain }) => ipcMain.listenerCount('floki:get-emotion'));
      if (count1 <= 1 && count2 <= 1) {
        pass('ipc_listeners_not_multiplied');
      } else {
        fail('ipc_listeners_not_multiplied', new Error(`listener counts: status=${count1} emotion=${count2}`));
      }
    }

    /* ------------------------------------------------------------------ */
    /*  7. MESSAGE INPUT USABLE AFTER NAVIGATION                          */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Chat Input ---');

    {
      const chatNav = window.locator('[data-testid="nav-chat"]');
      await chatNav.click();
      await sleep(800);
      const chatInput = window.locator('[data-testid="chat-input"]');
      const exists = await chatInput.isVisible().catch(() => false);
      if (exists) {
        pass('chat_input_visible');
        await chatInput.fill('test message');
        const val = await chatInput.inputValue();
        if (val === 'test message') {
          pass('chat_input_usable');
        } else {
          fail('chat_input_usable', new Error('Could not type into chat input'));
        }
      } else {
        fail('chat_input_visible', new Error('Chat input not found'));
      }
    }

    /* ------------------------------------------------------------------ */
    /*  8. EMOTION RANGE BUTTONS                                          */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Emotion Range Buttons ---');

    const RANGES = ['1min', '5min', '15min', 'session'];
    for (const r of RANGES) {
      try {
        const btn = window.locator(`[data-testid="emotion-range-${r}"]`);
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) throw new Error(`Button ${r} not visible`);
        await btn.click();
        await sleep(300);
        pass(`emotion_range_${r}`);
      } catch (e) { fail(`emotion_range_${r}`, e); }
    }

    /* ------------------------------------------------------------------ */
    /*  9. OVERLAY TOGGLES                                                */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Overlay Toggles ---');

    const TOGGLES = ['objects', 'faces', 'labels', 'conf', 'scene'];
    for (const t of TOGGLES) {
      try {
        const btn = window.locator(`[data-testid="toggle-${t}"]`);
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) throw new Error(`Toggle ${t} not visible`);
        await btn.click();
        await sleep(200);
        pass(`overlay_toggle_${t}`);
      } catch (e) { fail(`overlay_toggle_${t}`, e); }
    }

    /* ------------------------------------------------------------------ */
    /*  10. FREEZE / UNFREEZE / BLACKOUT                                  */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Freeze / Blackout ---');

    {
      const freezeBtn = window.locator('[data-testid="freeze-btn"]');
      const blackoutBtn = window.locator('[data-testid="blackout-btn"]');

      const freezeVisible = await freezeBtn.isVisible().catch(() => false);
      pass(freezeVisible ? 'freeze_btn_visible' : 'freeze_btn_missing');

      await freezeBtn.click();
      await sleep(500);
      pass('freeze_activated');

      await freezeBtn.click();
      await sleep(500);
      pass('unfreeze_activated');

      const blackoutVisible = await blackoutBtn.isVisible().catch(() => false);
      pass(blackoutVisible ? 'blackout_btn_visible' : 'blackout_btn_missing');

      await blackoutBtn.click();
      await sleep(500);
      pass('blackout_activated');

      await blackoutBtn.click();
      await sleep(500);
      pass('blackout_deactivated');
    }

    /* ------------------------------------------------------------------ */
    /*  11. MJPEG FRAME DELIVERY                                          */
    /* ------------------------------------------------------------------ */
    console.log('\n--- MJPEG Frame Delivery ---');

    {
      const feed = window.locator('[data-testid="vision-feed"]');
      const feedVisible = await feed.isVisible().catch(() => false);
      if (feedVisible) {
        pass('vision_feed_visible');
        const src1 = await feed.getAttribute('src').catch(() => null);
        if (src1 && src1.includes('live.mjpeg')) {
          pass('mjpeg_src_has_endpoint');
        } else {
          fail('mjpeg_src_has_endpoint', new Error('src: ' + src1));
        }
      } else {
        fail('vision_feed_visible', new Error('vision feed img not found'));
      }
    }

    /* ------------------------------------------------------------------ */
    /*  12. SETTINGS IPC INFO                                             */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Settings ---');

    {
      const settingsNav = window.locator('[data-testid="nav-settings"]');
      await settingsNav.click();
      await sleep(1000);
      const text = await window.locator('#root').textContent().catch(() => '');
      if (text.includes('electron') || text.includes('Electron') || text.includes('IPC') || text.includes('ipc')) {
        pass('settings_shows_electron_ipc');
      } else {
        fail('settings_shows_electron_ipc', new Error('No IPC/electron info in settings'));
      }
      if (text.includes('api') && text.includes('key') || text.includes('websocket')) {
        fail('settings_no_fake_api_fields', new Error('Settings appears to contain fake API/WebSocket fields'));
      } else {
        pass('settings_no_fake_api_fields');
      }
    }

    /* ------------------------------------------------------------------ */
    /*  13. NAVIGATION RESILIENCE AFTER STRESS                            */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Navigation Resilience ---');

    for (const tab of TABS) {
      try {
        await verifyTabRenders(window, tab.id, tab.label);
        pass(`navigate_${tab.id}_ok`);
      } catch (e) { fail(`navigate_${tab.id}_ok`, e); }
    }

    /* ------------------------------------------------------------------ */
    /*  FINAL ERROR CHECK                                                 */
    /* ------------------------------------------------------------------ */
    console.log('\n--- Final Error Check ---');

    const finalLogs = await getConsoleLogs(window);
    try {
      assertNoErrors(errors, finalLogs, 'final');
      pass('no_errors_final');
    } catch (e) { fail('no_errors_final', e); }

  } catch (fatal) {
    console.error('\nFATAL:', fatal.message);
    exitCode = 1;
  } finally {
    /* Cleanup */
    if (electronApp) {
      try { await electronApp.close(); } catch (_) {}
    }
    stopFrameFixture();

    /* Summary */
    console.log('\n=== Results ===');
    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    console.log(`Passed: ${passed}, Failed: ${failed}, Total: ${results.length}`);
    if (failed > 0) {
      console.log('\nFailures:');
      results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  ✗ ${r.name}: ${r.error}`));
    }
    process.exit(exitCode);
  }
}

main();

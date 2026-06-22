'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DIST_INDEX = path.join(APP_ROOT, 'dist', 'index.html');
const FRAME_FILE = path.join(APP_ROOT, 'dist', 'vision-controls-e2e-frame.jpg');
const FIXTURE = path.join(__dirname, 'frame-fixture.cjs');
let fixture = null;
let app = null;

function startFixture() {
  return new Promise((resolve, reject) => {
    fixture = spawn(process.execPath, [FIXTURE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FLOKI_E2E_FRAME_FILE: FRAME_FILE, FLOKI_E2E_FRAME_FPS: '10' }
    });
    let done = false;
    const onData = (chunk) => {
      if (!done && String(chunk).includes('FLOKI_E2E_FRAME_FIXTURE_READY')) {
        done = true;
        resolve();
      }
    };
    fixture.stdout.on('data', onData);
    fixture.stderr.on('data', onData);
    fixture.on('error', (error) => { if (!done) { done = true; reject(error); } });
    setTimeout(() => { if (!done) { done = true; reject(new Error('frame fixture timeout')); } }, 10000);
  });
}

async function pressed(locator) {
  return (await locator.getAttribute('aria-pressed')) === 'true';
}

async function verifyQuickToggle(page, name) {
  const toggle = page.locator(`[data-testid="toggle-${name}"]`);
  await toggle.waitFor({ state: 'visible' });
  const before = await pressed(toggle);
  await toggle.click();
  const after = await pressed(toggle);
  if (after === before) throw new Error(`${name} toggle state did not change`);
  await toggle.click();
  const restored = await pressed(toggle);
  if (restored !== before) throw new Error(`${name} toggle state did not restore`);
}

async function main() {
  if (!fs.existsSync(DIST_INDEX)) throw new Error('built interface missing');
  await startFixture();
  app = await electron.launch({
    args: [APP_ROOT],
    env: { ...process.env, FLOKI_E2E_FRAME_FILE: FRAME_FILE }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-testid="nav-chat"]').click();

  for (const name of ['objects', 'persons', 'labels', 'conf', 'scene']) {
    await verifyQuickToggle(page, name);
  }

  const objectQuick = page.locator('[data-testid="toggle-objects"]');
  const quickBefore = await pressed(objectQuick);

  await page.locator('[data-testid="nav-settings"]').click();
  const objectSetting = page.locator('[data-testid="setting-show-object-boxes"]');
  await objectSetting.waitFor({ state: 'visible' });
  await objectSetting.click();

  await page.locator('[data-testid="nav-chat"]').click();
  const quickAfterSetting = await pressed(objectQuick);
  if (quickAfterSetting === quickBefore) {
    throw new Error('Settings-page object switch did not update the Live Vision control');
  }

  await objectQuick.click();
  const quickRestored = await pressed(objectQuick);
  if (quickRestored !== quickBefore) {
    throw new Error('Live Vision object control did not restore shared setting');
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_VISION_CONTROLS_E2E_PASS',
    quick_toggles_clicked_and_state_changed: 5,
    settings_page_to_live_panel_sync: true,
    real_electron_renderer_used: true
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (app) { try { await app.close(); } catch (_error) {} }
  if (fixture) fixture.kill('SIGTERM');
});

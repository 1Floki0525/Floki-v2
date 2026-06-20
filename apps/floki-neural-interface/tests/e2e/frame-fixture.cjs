'use strict';
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const FRAME_FILE = process.env.FLOKI_E2E_FRAME_FILE || path.join(APP_ROOT, 'dist', 'e2e-test-frame.jpg');

const MINI_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI4Q/SFhSRFJiMkVic4EzQjR0RSlFNkVUcCZS/9oADAMBAAIRAxEAPwC1//Z';

const MINI_JPEG = Buffer.from(MINI_JPEG_BASE64, 'base64');
let frameCount = 0;
let running = true;

function writeFrame() {
  if (!running) return;
  try {
    fs.mkdirSync(path.dirname(FRAME_FILE), { recursive: true });
    const buf = Buffer.from(MINI_JPEG);
    buf.writeInt8(frameCount & 0xFF, buf.length - 2);
    frameCount++;
    fs.writeFileSync(FRAME_FILE, buf);
  } catch (_) { /* best-effort */ }
}

process.on('SIGINT', () => { running = false; process.exit(0); });
process.on('SIGTERM', () => { running = false; process.exit(0); });

const fps = Number(process.env.FLOKI_E2E_FRAME_FPS || 10);
writeFrame();
setInterval(writeFrame, 1000 / fps);
console.log(JSON.stringify({ marker: 'FLOKI_E2E_FRAME_FIXTURE_READY', file: FRAME_FILE, fps, pid: process.pid }));

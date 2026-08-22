import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const extensionPath = path.resolve('apps/dock-extension/dist');
assert.ok(fs.existsSync(path.join(extensionPath, 'manifest.json')), 'build the extension first');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dianjing-mv3-'));
const fixtureServer = createServer((request, response) => {
  if (request.url !== '/fixture.html') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><head><title>点睛测试页面</title></head><body><main id="fixture-card"><h1 id="fixture-title">点睛测试页面</h1><button id="fixture-action">开始编辑</button></main></body></html>`);
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixtureAddress = fixtureServer.address();
assert.ok(fixtureAddress && typeof fixtureAddress === 'object', 'fixture server did not start');
const directUrl = `http://127.0.0.1:${fixtureAddress.port}/fixture.html`;
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  assert.ok(extensionId, 'MV3 service worker did not expose an extension id');

  const page = await context.newPage();
  await page.goto(
    `chrome-extension://${extensionId}/workspace.html?entry=blank&reason=${encodeURIComponent('当前是空白页，可直接选择本地 HTML 开始编辑。')}`,
  );
  assert.equal(await page.locator('[data-page-title]').textContent(), '从一个页面开始');
  assert.match(await page.locator('[data-canvas-loading]').textContent(), /选择本地 HTML/);
  assert.equal(await page.getByText('无法连接原页面').count(), 0);

  await page.locator('[data-action="open-url"]').click();
  await page.locator('[data-open-url-input]').fill(directUrl);
  await page.getByRole('button', { name: '打开并进入工作台' }).click();
  await page.waitForURL(
    new RegExp(`chrome-extension://${extensionId}/workspace\\.html\\?session=`),
  );
  await page.locator('[data-object-count]').waitFor({ state: 'visible', timeout: 15_000 });
  assert.match(await page.locator('[data-page-url]').textContent(), /127\.0\.0\.1/);
  assert.equal(
    context.pages().filter((candidate) => candidate.url().startsWith('http://127.0.0.1:'))
      .length,
    1,
  );

  await page.locator('[data-action="open-url"]').click();
  await page.locator('[data-open-url-input]').fill(directUrl);
  await page.getByRole('button', { name: '打开并进入工作台' }).click();
  await page.locator('[data-open-url-dialog]').waitFor({ state: 'detached', timeout: 15_000 });
  await page.locator('[data-object-count]').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(
    context.pages().filter((candidate) => candidate.url().startsWith('http://127.0.0.1:'))
      .length,
    1,
  );

  await page.goto(
    `chrome-extension://${extensionId}/workspace.html?entry=file-access&reason=${encodeURIComponent('需要开启“允许访问文件网址”后才能编辑本地 HTML 页面。')}`,
  );
  assert.equal(await page.locator('[data-page-title]').textContent(), '开启本地文件访问');
  assert.equal(await page.locator('[data-action="open-file-access-settings"]').count(), 1);

  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.ok(!manifest.permissions.includes('downloads'));
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  console.log(`MV3 entry validation passed for extension ${extensionId}.`);
} finally {
  await context.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
}

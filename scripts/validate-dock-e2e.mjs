import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const contentPath = new URL('../apps/dock-extension/dist/content.js', import.meta.url);
const manifestPath = new URL('../apps/dock-extension/dist/manifest.json', import.meta.url);
if (!fs.existsSync(contentPath)) {
  throw new Error('Dock build is missing. Run npm.cmd run build:dock first.');
}
if (!fs.existsSync(manifestPath)) {
  throw new Error('Dock manifest is missing. Run npm.cmd run build:dock first.');
}

const contentScript = fs.readFileSync(contentPath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dianjing-dock-e2e-'));
assert.equal(manifest.name, '点睛');
assert.equal(manifest.action?.default_title, '打开点睛');
assert.match(manifest.description, /AI 创作的最后一笔/);
assert.match(manifest.description, /应手编辑/);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.setContent(`
    <!doctype html>
    <html>
      <head><title>Dock 集成页面</title></head>
      <body>
        <main id="card">
          <h2 id="title" style="display: flex; color: rgb(20, 40, 60); border: 1px solid rgb(20, 40, 60)">原始标题</h2>
          <button id="action">按钮</button>
        </main>
        <aside><b id="compound-count">17<small>条</small></b></aside>
        <canvas id="chart" width="320" height="120" aria-label="趋势图"></canvas>
      </body>
    </html>
  `);

  await page.evaluate(() => {
    globalThis.__dockListeners = [];
    globalThis.__dockSavedHtml = '';
    globalThis.__dockSaveOptions = null;
    globalThis.__dockCopiedPrompt = '';
    globalThis.__pageActionClicks = 0;
    globalThis.document.querySelector('#action').addEventListener('click', () => {
      globalThis.__pageActionClicks += 1;
    });
    globalThis.showSaveFilePicker = async (options) => {
      globalThis.__dockSaveOptions = options;
      return {
        createWritable: async () => ({
          write: async (content) => {
            globalThis.__dockSavedHtml = content;
          },
          close: async () => {},
        }),
      };
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (content) => {
          globalThis.__dockCopiedPrompt = content;
        },
      },
    });
    globalThis.chrome = {
      runtime: {
        sendMessage: async (message) =>
          message?.type === 'workspace/capture-visible'
            ? {
                ok: true,
                title: 'Dock 集成页面',
                dataUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nEAAAAAASUVORK5CYII=',
              }
            : { ok: true },
        onMessage: {
          addListener(listener) {
            globalThis.__dockListeners.push(listener);
          },
        },
      },
    };
  });
  await page.evaluate((script) => globalThis.eval(script), contentScript);
  await page.evaluate(() => globalThis.__dockListeners[0]({ type: 'dock/toggle' }, null, () => {}));

  const host = page.locator('#dock-extension-host');
  await page.waitForTimeout(10);
  assert.equal(await host.locator('.panel-header strong').textContent(), '点睛');
  assert.equal(await host.locator('.panel-header small').textContent(), 'AI 创作的最后一笔');
  assert.equal(await host.locator('.dock-toolbar').getAttribute('aria-label'), '点睛工具');
  const capabilityButton = host.locator('[data-action="capability"]');
  assert.equal(await capabilityButton.getAttribute('aria-label'), '可编辑 · 可导出 HTML');
  assert.match(await capabilityButton.getAttribute('data-tooltip'), /可以直接修改当前页面/);
  assert.equal(await host.locator('.dock-toolbar-group').count(), 3);
  assert.equal(await host.locator('.dock-toolbar-divider').count(), 3);
  assert.ok((await host.locator('.dock-toolbar .dock-icon').count()) >= 7);
  const initialToolbarBox = await host.locator('.dock-toolbar').boundingBox();
  assert.ok(initialToolbarBox);
  assert.equal(Math.round(initialToolbarBox.height), 48);
  assert.equal(Math.round(initialToolbarBox.x), Math.round((1440 - initialToolbarBox.width) / 2));
  assert.equal(Math.round(initialToolbarBox.y), 900 - 48 - 18);

  const compoundTextPoint = await page.locator('#compound-count').evaluate((element) => {
    const textNode = element.firstChild;
    if (!textNode) throw new Error('compound text node missing');
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(compoundTextPoint.x, compoundTextPoint.y);
  assert.match(await host.locator('.selected-head strong').textContent(), /文本 · 17/);
  assert.match(await host.locator('.selected-status').textContent(), /可编辑/);
  const compoundTextInput = host.locator('textarea[data-dock-text]');
  assert.equal(await compoundTextInput.inputValue(), '17');
  await compoundTextInput.fill('18');
  await compoundTextInput.dispatchEvent('change');
  assert.equal(await page.locator('#compound-count').textContent(), '18条');
  await host.locator('[data-action="undo"]').click();
  assert.equal(await page.locator('#compound-count').textContent(), '17条');
  await host.locator('[data-action="redo"]').click();
  assert.equal(await page.locator('#compound-count').textContent(), '18条');
  await host.locator('[data-action="undo"]').click();
  assert.equal(await page.locator('#compound-count').textContent(), '17条');

  await page.locator('#title').click();
  assert.match(await host.locator('.selected-head strong').textContent(), /标题 · 原始标题/);
  assert.equal(await host.locator('.notice').count(), 0);
  await page.screenshot({
    path: path.join(artifactDir, 'dock-refined-text.png'),
    fullPage: false,
  });

  await page.locator('#chart').click();
  assert.match(await host.locator('.selected-status').textContent(), /整体调整/);
  assert.equal(await host.locator('.quick-tab[data-panel="text"]').isDisabled(), true);
  assert.equal(await host.locator('.quick-tab[data-panel="appearance"]').isDisabled(), false);
  assert.match(
    await host.locator('.object-capability-note').textContent(),
    /canvas.*内部内容不能直接编辑/i,
  );
  assert.equal(await host.locator('input[data-dock-style="background"]').count(), 1);

  await page.locator('#title').click();
  assert.match(await host.locator('.selected-status').textContent(), /可编辑/);
  assert.equal(await host.locator('.quick-tab[data-panel="text"]').isDisabled(), false);

  const textInput = host.locator('textarea[data-dock-text]');
  assert.equal(await textInput.count(), 1);
  await textInput.fill('新标题\n第二行');
  await textInput.dispatchEvent('change');
  assert.equal(await host.locator('.notice').count(), 0);
  assert.match(await host.locator('.sr-status').textContent(), /已直接修改/);
  assert.equal(
    await host.locator('.sr-status').evaluate((element) => getComputedStyle(element).clipPath),
    'inset(50%)',
  );

  assert.equal(await host.locator('[data-panel="color"]').count(), 0);
  assert.equal(await host.locator('.quick-tab').count(), 3);
  assert.equal(await host.locator('details.advanced-settings').count(), 0);
  assert.equal(await host.locator('input[data-dock-style="color"]').count(), 1);
  assert.equal(await host.locator('input[data-dock-style="background-color"]').count(), 1);

  const fontSizeInput = host.locator('input[data-dock-style="font-size"]');
  assert.equal(
    await host.locator('output[data-dock-range-output="font-size"]').textContent(),
    '24px',
  );
  await fontSizeInput.evaluate((element) => {
    element.value = '26';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(
    await host.locator('output[data-dock-range-output="font-size"]').textContent(),
    '26px',
  );
  assert.equal(await fontSizeInput.getAttribute('title'), '26px');
  assert.equal(await fontSizeInput.getAttribute('aria-valuetext'), '26px');
  assert.equal(await host.locator('.history-count').textContent(), '1');
  await fontSizeInput.dispatchEvent('change');
  assert.equal(await page.locator('#title').evaluate((element) => element.style.fontSize), '26px');
  const fontFamilySelect = host.locator('select[data-dock-style="font-family"]');
  assert.equal(await fontFamilySelect.locator('option').count(), 12);
  assert.ok((await fontFamilySelect.locator('option').allTextContents()).includes('微软雅黑'));
  await fontFamilySelect.selectOption({ label: '微软雅黑' });
  assert.match(
    await page.locator('#title').evaluate((element) => element.style.fontFamily),
    /Microsoft YaHei/,
  );

  await host.locator('[data-panel="appearance"]').click();
  assert.equal(await host.locator('input[data-dock-style="background"]').count(), 1);
  assert.equal(await host.locator('input[data-dock-style="border-color"]').count(), 1);
  await page.screenshot({
    path: path.join(artifactDir, 'dock-refined-appearance.png'),
    fullPage: false,
  });
  await host.locator('select[data-dock-style="border-style"]').selectOption('dashed');
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.borderStyle),
    'dashed',
  );

  const visibilityToggle = host.locator('.visibility-toggle');
  assert.equal(await visibilityToggle.count(), 1);
  assert.match(await host.locator('.visibility-copy strong').textContent(), /在画布中显示/);
  assert.equal(
    await page.locator('#title').evaluate((element) => getComputedStyle(element).display),
    'flex',
  );
  const titleBoxBeforeHide = await page.locator('#title').boundingBox();
  await visibilityToggle.click();
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.visibility),
    'hidden',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => getComputedStyle(element).display),
    'flex',
  );
  assert.deepEqual(await page.locator('#title').boundingBox(), titleBoxBeforeHide);
  assert.match(await host.locator('.visibility-copy strong').textContent(), /暂时隐藏对象/);
  await host.locator('.visibility-toggle').click();
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.visibility),
    'visible',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => getComputedStyle(element).display),
    'flex',
  );
  assert.equal(
    await host.locator('.visibility-toggle').getAttribute('class'),
    'visibility-toggle is-active',
  );

  const radiusInput = host.locator('input[data-dock-style="border-radius"]');
  await radiusInput.fill('8');
  await radiusInput.dispatchEvent('change');

  await host.locator('[data-panel="spacing"]').click();
  assert.equal(await host.locator('.dock-spacing-controls').count(), 1);
  assert.equal(await host.locator('.box-model-core').count(), 0);
  const paddingTopInput = host.locator('input[data-dock-style="padding-top"]');
  await paddingTopInput.fill('12');
  await paddingTopInput.dispatchEvent('change');
  await host.locator('[data-style-property="text-align"][data-style-value="center"]').click();
  await page.screenshot({
    path: path.join(artifactDir, 'dock-refined-spacing.png'),
    fullPage: false,
  });

  assert.equal(await page.locator('#title').textContent(), '新标题\n第二行');
  assert.equal(
    await page
      .locator('#title')
      .evaluate((element) => globalThis.getComputedStyle(element).whiteSpace),
    'pre-wrap',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.paddingTop),
    '12px',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.textAlign),
    'center',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.borderRadius),
    '8px',
  );
  assert.equal(await host.locator('.history-count').textContent(), '9');

  await host.locator('[data-action="move-down"]').click();
  assert.deepEqual(
    await page
      .locator('#card > *')
      .evaluateAll((elements) => elements.map((element) => element.id || element.tagName)),
    ['action', 'title'],
  );
  await host.locator('[data-action="move-up"]').click();
  assert.deepEqual(
    await page
      .locator('#card > *')
      .evaluateAll((elements) => elements.map((element) => element.id || element.tagName)),
    ['title', 'action'],
  );

  await host.locator('[data-action="copy"]').click();
  assert.equal(await page.locator('#card > *').count(), 3);
  await host.locator('[data-action="delete"]').click();
  assert.equal(await host.locator('.delete-confirm').count(), 1);
  await host.locator('[data-action="delete-confirm"]').click();
  assert.equal(await page.locator('#card > *').count(), 2);
  await host.locator('[data-action="undo"]').click();
  assert.equal(await page.locator('#card > *').count(), 3);
  await host.locator('[data-action="undo"]').click();
  assert.equal(await page.locator('#card > *').count(), 2);

  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  await host.locator('[data-action="undo"]').click();
  assert.equal(await page.locator('#title').textContent(), '原始标题');
  assert.equal(
    await page
      .locator('#title')
      .evaluate((element) => globalThis.getComputedStyle(element).whiteSpace),
    'normal',
  );
  assert.equal(await page.locator('#title').evaluate((element) => element.style.paddingTop), '0px');
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.borderRadius),
    '0px',
  );

  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  await host.locator('[data-action="redo"]').click();
  assert.equal(await page.locator('#title').textContent(), '新标题\n第二行');
  assert.equal(
    await page
      .locator('#title')
      .evaluate((element) => globalThis.getComputedStyle(element).whiteSpace),
    'pre-wrap',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.paddingTop),
    '12px',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => element.style.borderRadius),
    '8px',
  );

  await host.locator('[data-action="history"]').click();
  assert.equal(await host.locator('.history-row').count(), 11);
  assert.equal(await host.locator('.dock-panel .history-popover').count(), 0);
  assert.equal(await host.locator('.dock-toolbar-history-anchor .history-popover').count(), 1);
  await page.screenshot({
    path: path.join(artifactDir, 'dock-history-popover.png'),
    fullPage: false,
  });
  await host.locator('[data-cancel-history]').last().click();
  assert.equal(await host.locator('.history-row').count(), 11);
  assert.match(await host.locator('.history-popover').textContent(), /已取消/);

  await page.mouse.click(10, 10);
  assert.equal(await host.locator('.dock-history-popover').count(), 0);
  await host.locator('[data-action="history"]').click();
  assert.equal(await host.locator('.dock-history-popover').count(), 1);

  await host.locator('[data-action="dock-file-menu"]').click();
  assert.equal(await host.locator('.dock-toolbar-popover').count(), 1);
  assert.equal(await host.locator('.dock-history-popover').count(), 0);
  assert.equal(await host.locator('[data-action="dock-open-html"]').count(), 1);
  assert.equal(await host.locator('[data-action="open-html-export"]').count(), 1);
  assert.equal(await host.locator('[data-action="export-viewport-png"]').count(), 1);
  assert.equal(await host.locator('[data-action="dock-enter-workspace"]').count(), 1);
  await host.locator('[data-action="open-html-export"]').click();
  await page.waitForFunction(() => Boolean(globalThis.__dockSavedHtml));
  const html = await page.evaluate(() => globalThis.__dockSavedHtml);
  const saveOptions = await page.evaluate(() => globalThis.__dockSaveOptions);
  assert.match(saveOptions.suggestedName, /\.html$/);
  assert.match(html, /新标题\n第二行/);
  assert.match(html, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(html, /dock-extension-host|页面重构 Dock/);

  await page.evaluate(() => {
    const filler = document.createElement('div');
    filler.style.height = '1800px';
    document.body.append(filler);
  });
  const captureMetrics = await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.__dockListeners[0]({ type: 'dock/capture-prepare' }, null, resolve),
      ),
  );
  assert.equal(captureMetrics.ready, true);
  assert.ok(captureMetrics.scrollHeight > captureMetrics.viewportHeight);
  assert.equal(
    await page.locator('#dock-extension-host').evaluate((element) => element.hidden),
    true,
  );
  assert.equal(
    await page
      .locator('#dock-extension-host')
      .evaluate((element) => globalThis.getComputedStyle(element).display),
    'none',
  );
  const capturePosition = await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.__dockListeners[0]({ type: 'dock/capture-scroll', top: 240 }, null, resolve),
      ),
  );
  assert.equal(capturePosition.top, 240);
  const captureRestored = await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.__dockListeners[0]({ type: 'dock/capture-restore' }, null, resolve),
      ),
  );
  assert.equal(captureRestored.restored, true);
  assert.equal(
    await page.locator('#dock-extension-host').evaluate((element) => element.hidden),
    false,
  );

  await host.locator('[data-action="copy-prompt"]').click();
  await page.waitForFunction(() => Boolean(globalThis.__dockCopiedPrompt));
  const prompt = await page.evaluate(() => globalThis.__dockCopiedPrompt);
  assert.match(prompt, /点睛 AI 源码同步任务/);
  assert.match(prompt, /最终效果（按页面对象归并）/);
  assert.match(prompt, /ELEMENT-\d+ \|/);
  assert.match(prompt, /文案：当前状态/);
  assert.match(prompt, /#title/);
  assert.doesNotMatch(prompt, /源码应达到|操作摘要|页面模式：/);
  assert.match(prompt, /"原始标题"/);
  assert.match(prompt, /"新标题\\n第二行"/);

  await host.locator('[data-action="dock-exit"]').click();
  assert.equal(
    await page
      .locator('#dock-extension-host')
      .evaluate((element) => globalThis.getComputedStyle(element).display),
    'none',
  );
  assert.equal(
    await page.locator('#title').evaluate((element) => element.textContent),
    '新标题\n第二行',
  );
  await page.locator('#action').click();
  assert.equal(await page.evaluate(() => globalThis.__pageActionClicks), 1);

  await page.evaluate(() =>
    globalThis.__dockListeners[0]({ type: 'dock/toggle', mode: 'web-copy' }, null, () => {}),
  );
  assert.equal(
    await page
      .locator('#dock-extension-host')
      .evaluate((element) => globalThis.getComputedStyle(element).display),
    'block',
  );
  assert.equal(await host.locator('[data-action="dock-exit"]').count(), 1);
  assert.match(await host.locator('.web-copy-note').textContent(), /不会写回原网站/);
  assert.equal(await page.locator('#title').textContent(), '新标题\n第二行');

  const toolbar = host.locator('.dock-toolbar');
  const dragHandle = host.locator('.dock-toolbar-drag-handle');
  const beforeDrag = await toolbar.boundingBox();
  const handleBox = await dragHandle.boundingBox();
  assert.ok(beforeDrag);
  assert.ok(handleBox);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2 + 120,
    handleBox.y + handleBox.height / 2 - 72,
  );
  await page.mouse.up();
  const afterDrag = await toolbar.boundingBox();
  assert.ok(afterDrag);
  assert.equal(Math.round(afterDrag.x - beforeDrag.x), 120);
  assert.equal(Math.round(afterDrag.y - beforeDrag.y), -72);
  await dragHandle.focus();
  await dragHandle.press('ArrowLeft');
  const afterKeyboardMove = await toolbar.boundingBox();
  assert.ok(afterKeyboardMove);
  assert.equal(Math.round(afterKeyboardMove.x - afterDrag.x), -16);

  console.log(
    'Dock e2e validation passed: Dianjing brand identity, direct edit, style edit, undo/redo, history cancellation, toolbar repositioning, HTML save picker, prompt clipboard copy and exit/reopen behavior.',
  );
} finally {
  await browser.close();
}

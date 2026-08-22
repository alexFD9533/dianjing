import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const contentScript = fs.readFileSync(
  new URL('../apps/dock-extension/dist/content.js', import.meta.url),
  'utf8',
);
const workspaceScript = fs.readFileSync(
  new URL('../apps/dock-extension/dist/workspace.js', import.meta.url),
  'utf8',
);
const workspaceCss = fs.readFileSync(
  new URL('../apps/dock-extension/dist/workspace.css', import.meta.url),
  'utf8',
);
const brandIcon = fs.readFileSync(
  new URL('../apps/dock-extension/dist/icons/icon-128.png', import.meta.url),
);
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dianjing-workspace-e2e-'));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const source = await context.newPage();
await source.setViewportSize({ width: 1280, height: 800 });
const workspace = await context.newPage();
await workspace.setViewportSize({ width: 1440, height: 900 });
let directUrlRequest = '';
let requestedOrigins = [];
let resolvePendingOfflineExport;
let workspaceStateRequests = 0;
const requestWorkspaceCommand = (command) =>
  workspace.evaluate(
    (command) =>
      globalThis.__workspaceBridge({
        type: 'workspace/request',
        sessionId: 'e2e-session',
        command,
      }),
    command,
  );

try {
  await source.setContent(
    `<!doctype html><html><head><title>真实产品页面</title><link rel="stylesheet" href="data:text/css,.offline-backdrop%7Bbackground%3A%23123456%7D"><style>:root{--e2e-breakpoint:wide}@media(max-width:800px){:root{--e2e-breakpoint:narrow}}.force-font-size{font-size:16px!important}#logo{display:block;width:160px;height:96px}</style></head><body class="offline-backdrop"><main id="card"><h1 id="title">原始标题</h1><button id="action">立即开始</button></main><div id="forced-font-size" class="force-font-size">技术支持</div><img id="logo" alt="标识" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><audio id="narration" src="data:audio/wav;base64,UklGRg=="></audio><canvas id="chart" width="300" height="120"></canvas></body></html>`,
  );
  await source.evaluate(() => {
    globalThis.__dockListeners = [];
    globalThis.chrome = {
      runtime: {
        getURL: (path) => path,
        sendMessage: async () => ({ ok: true }),
        onMessage: {
          addListener(listener) {
            globalThis.__dockListeners.push(listener);
          },
        },
      },
    };
  });
  await source.evaluate((script) => globalThis.eval(script), contentScript);
  await source.evaluate(() =>
    globalThis.__dockListeners[0]({ type: 'dock/toggle' }, null, () => {}),
  );
  const offlineExport = await source.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.__dockListeners[0](
          {
            type: 'workspace/command',
            command: { action: 'export-html' },
            sessionId: 'e2e-session',
          },
          null,
          resolve,
        );
      }),
  );
  assert.equal(offlineExport.ok, true);
  assert.deepEqual(offlineExport.warnings, []);
  assert.match(offlineExport.html, /data-dianjing-canvas-snapshot="true"/);
  assert.match(offlineExport.html, /data-dianjing-offline-stylesheet="true"/);
  assert.match(offlineExport.html, /<img id="logo"/);
  assert.doesNotMatch(offlineExport.html, /<canvas\b/);
  assert.doesNotMatch(offlineExport.html, /<audio\b/);
  assert.doesNotMatch(offlineExport.html, /<script\b/);

  await workspace.exposeFunction('__workspaceBridge', async (message) => {
    if (message?.type === 'workspace/focus-source') return { ok: true };
    if (message?.type === 'workspace/capture-visible')
      return {
        ok: true,
        title: '真实产品页面',
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nEAAAAAASUVORK5CYII=',
      };
    if (message?.type === 'extension/open-file-access-settings') return { ok: true };
    if (message?.type === 'workspace/open-url') {
      directUrlRequest = message.url;
      return { ok: true, sessionId: 'url-e2e-session' };
    }
    if (message?.type === 'workspace/open-local-html')
      throw new Error('workspace must load local HTML in its current canvas');
    if (message?.type !== 'workspace/request') return { ok: false, error: 'unexpected message' };
    if (message.command?.action === 'get-state') workspaceStateRequests += 1;
    if (message.command?.action === 'export-html')
      return new Promise((resolve) => {
        resolvePendingOfflineExport = resolve;
      });
    return source.evaluate(
      ({ command, sessionId }) =>
        new Promise((resolve) => {
          globalThis.__dockListeners[0](
            { type: 'workspace/command', command, sessionId },
            null,
            resolve,
          );
        }),
      { command: message.command, sessionId: message.sessionId },
    );
  });
  await workspace.exposeFunction('__workspacePermissionRequest', async ({ origins }) => {
    requestedOrigins = origins;
    return true;
  });
  await workspace.route('http://workspace.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/content.js')
      return route.fulfill({
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
        body: contentScript,
      });
    if (pathname === '/icons/icon-128.png')
      return route.fulfill({ contentType: 'image/png', body: brandIcon });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><div id="app"></div></body></html>',
    });
  });
  await workspace.goto('http://workspace.test/?session=e2e-session');
  await workspace.addStyleTag({ content: workspaceCss });
  await workspace.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        getURL: (path) => `http://workspace.test/${path}`,
        sendMessage: (message) => globalThis.__workspaceBridge(message),
        onMessage: {
          addListener(listener) {
            globalThis.__workspaceRuntimeListeners ??= [];
            globalThis.__workspaceRuntimeListeners.push(listener);
          },
        },
      },
      permissions: {
        request: (permission) => globalThis.__workspacePermissionRequest(permission),
      },
    };
  });
  await workspace.evaluate((script) => globalThis.eval(script), workspaceScript);

  await workspace.locator('[data-object-count]').waitFor({ state: 'visible' });
  await workspace.waitForFunction(() =>
    document.querySelector('[data-object-count]')?.textContent?.includes('个可选对象'),
  );
  assert.equal(await workspace.locator('[data-page-title]').textContent(), '真实产品页面');
  assert.match(
    await workspace.locator('[data-page-snapshot]').textContent(),
    /^已同步\s\d{2}:\d{2}$/,
  );
  await source.evaluate(() => (document.body.dataset.workspaceFresh = 'true'));
  await workspace.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await workspace.waitForFunction(() => {
    const frame = document.querySelector('iframe[data-page-frame]');
    return (
      frame instanceof HTMLIFrameElement &&
      frame.contentDocument?.body?.dataset.workspaceFresh === 'true'
    );
  });
  const pageCapability = workspace.locator('[data-page-capability]');
  assert.equal(await pageCapability.getAttribute('aria-label'), '可编辑 · 可导出 HTML');
  assert.match(
    await pageCapability.getAttribute('data-tooltip'),
    /可编辑 · 可导出 HTML：可以直接修改当前页面/,
  );
  assert.equal(await pageCapability.locator('svg').count(), 1);
  assert.ok((await workspace.locator('.tree-row').count()) >= 3);
  assert.equal(await workspace.locator('[data-action="focus-selection"]').isDisabled(), true);
  assert.equal(await workspace.locator('[data-action="open-html"]').textContent(), '打开 HTML');
  assert.equal(await workspace.locator('[data-action="open-url"]').textContent(), '打开链接');
  assert.equal(await workspace.locator('[data-draft-footer]').count(), 0);
  assert.equal(await workspace.getByText('应用修改', { exact: true }).count(), 0);
  assert.equal(await workspace.locator('.canvas-controls [data-canvas-mode]').count(), 2);
  assert.equal(
    await workspace.locator('[data-action="toggle-guides"]').getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(await workspace.locator('[data-rulers]').isHidden(), true);
  assert.equal(await workspace.locator('[data-guide-overlay-layer]').isHidden(), true);
  const closedCanvasGeometry = await workspace.evaluate(() => {
    const viewport = document.querySelector('[data-canvas-viewport]')?.getBoundingClientRect();
    const stage = document.querySelector('[data-canvas-stage]')?.getBoundingClientRect();
    if (!viewport || !stage) throw new Error('关闭参考线时画布尚未准备完成');
    return {
      fillsViewport:
        Math.abs(viewport.left - stage.left) <= 1 &&
        Math.abs(viewport.top - stage.top) <= 1 &&
        Math.abs(viewport.right - stage.right) <= 1 &&
        Math.abs(viewport.bottom - stage.bottom) <= 1,
      viewportBorderTop: getComputedStyle(document.querySelector('[data-canvas-viewport]'))
        .borderTopWidth,
      viewportShadow: getComputedStyle(document.querySelector('[data-canvas-viewport]')).boxShadow,
    };
  });
  assert.equal(closedCanvasGeometry.fillsViewport, true);
  assert.equal(closedCanvasGeometry.viewportBorderTop, '0px');
  assert.equal(closedCanvasGeometry.viewportShadow, 'none');
  assert.equal(await workspace.getByText('浏览', { exact: true }).count(), 0);

  // The workspace canvas keeps a logical page viewport independent from the
  // editor viewport. Zoom must only transform the page, while changing the
  // logical width must change the iframe's responsive viewport.
  const canvasWidth = workspace.locator('[data-canvas-width]');
  const canvasHeight = workspace.locator('[data-canvas-height]');
  assert.equal(await canvasWidth.inputValue(), '1280');
  assert.equal(await canvasHeight.inputValue(), '800');
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('html')
      .evaluate(() => innerWidth),
    1280,
  );
  await workspace.locator('[data-action="zoom-in"]').click();
  assert.equal(await workspace.locator('[data-zoom]').textContent(), '125%');
  assert.equal(
    await workspace.locator('[data-page-frame]').evaluate((frame) => frame.style.width),
    '1280px',
  );
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('html')
      .evaluate(() => innerWidth),
    1280,
  );
  await workspace.locator('[data-zoom]').click();
  assert.equal(await workspace.locator('[data-zoom]').textContent(), '100%');
  const ctrlWheelResult = await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate(() => {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -120,
      });
      const dispatched = document.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, dispatched };
    });
  assert.deepEqual(ctrlWheelResult, { defaultPrevented: true, dispatched: false });
  assert.equal(await workspace.locator('[data-zoom]').textContent(), '125%');
  const regularWheelResult = await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate(() => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 });
      const dispatched = document.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, dispatched };
    });
  assert.deepEqual(regularWheelResult, { defaultPrevented: false, dispatched: true });
  assert.equal(await workspace.locator('[data-zoom]').textContent(), '125%');
  await workspace.locator('[data-zoom]').click();
  assert.equal(await workspace.locator('[data-zoom]').textContent(), '100%');
  await canvasWidth.fill('640');
  await workspace.waitForFunction(
    () => document.querySelector('[data-canvas-width]')?.value === '640',
  );
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('html')
      .evaluate(() => innerWidth),
    640,
  );
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('html')
      .evaluate((element) => getComputedStyle(element).getPropertyValue('--e2e-breakpoint').trim()),
    'narrow',
  );
  await canvasWidth.fill('1280');
  await workspace.locator('[data-action="fit-canvas"]').click();
  const pageBeforePan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().left);
  const stageBox = await workspace.locator('[data-canvas-stage]').boundingBox();
  assert.ok(stageBox);
  await workspace.locator('[data-canvas-mode="pan"]').click();
  await workspace.mouse.move(stageBox.x + 150, stageBox.y + 150);
  await workspace.mouse.down();
  await workspace.mouse.move(stageBox.x + 220, stageBox.y + 180);
  await workspace.mouse.up();
  const pageAfterPan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().left);
  assert.ok(Math.abs(pageAfterPan - pageBeforePan) > 1);
  await workspace.locator('[data-canvas-mode="select"]').click();
  const pageBeforeMiddlePan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().top);
  const middleStageBox = await workspace.locator('[data-canvas-stage]').boundingBox();
  assert.ok(middleStageBox);
  await workspace.mouse.move(middleStageBox.x + 180, middleStageBox.y + 180);
  await workspace.mouse.down({ button: 'middle' });
  await workspace.mouse.move(middleStageBox.x + 210, middleStageBox.y + 220);
  await workspace.mouse.up({ button: 'middle' });
  const pageAfterMiddlePan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(Math.abs(pageAfterMiddlePan - pageBeforeMiddlePan) > 1);
  const pageBeforeSpacePan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().left);
  await workspace.keyboard.down('Space');
  await workspace.mouse.move(middleStageBox.x + 230, middleStageBox.y + 180);
  await workspace.mouse.down();
  await workspace.mouse.move(middleStageBox.x + 260, middleStageBox.y + 180);
  await workspace.mouse.up();
  await workspace.keyboard.up('Space');
  const pageAfterSpacePan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().left);
  assert.ok(Math.abs(pageAfterSpacePan - pageBeforeSpacePan) > 1);
  await workspace.locator('[data-action="fit-canvas"]').click();

  // Space-pan must remain stable even when the pointer starts on a draggable
  // image inside the snapshot iframe. The image is intentionally draggable so
  // this exercises the native-drag conflict reported by the user.
  const image = workspace.frameLocator('[data-page-frame]').locator('#logo');
  await image.waitFor({ state: 'visible' });
  const imageBox = await image.boundingBox();
  assert.ok(imageBox);
  const imagePageBeforePan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().left);
  await workspace.keyboard.down('Space');
  assert.equal(
    await workspace
      .locator('[data-page-frame]')
      .evaluate((frame) => getComputedStyle(frame).pointerEvents),
    'none',
  );
  const imageDragStartX = imageBox.x + imageBox.width / 2;
  const imageDragStartY = imageBox.y + imageBox.height / 2;
  await workspace.mouse.move(imageDragStartX, imageDragStartY);
  await workspace.mouse.down();
  const imagePanSamples = [];
  for (let step = 1; step <= 6; step += 1) {
    await workspace.mouse.move(imageDragStartX + step * 12, imageDragStartY);
    imagePanSamples.push(
      await workspace
        .locator('[data-canvas-page]')
        .evaluate((element) => element.getBoundingClientRect().left),
    );
  }
  assert.ok(
    imagePanSamples.every(
      (value, index) => index === 0 || value >= imagePanSamples[index - 1] - 0.5,
    ),
    `image space-pan moved backwards: ${imagePanSamples.join(', ')}`,
  );
  assert.equal(
    await image.getAttribute('data-dianjing-dragging'),
    null,
    'native image drag must not start during space-pan',
  );
  await workspace.mouse.up();
  await workspace.keyboard.up('Space');
  assert.equal(
    await workspace
      .locator('[data-page-frame]')
      .evaluate((frame) => getComputedStyle(frame).pointerEvents),
    'auto',
  );
  const imagePageAfterPan = await workspace
    .locator('[data-canvas-page]')
    .evaluate((element) => element.getBoundingClientRect().left);
  assert.ok(Math.abs(imagePageAfterPan - imagePageBeforePan - 72) < 3);
  console.log('Space-pan image regression passed');

  await workspace.locator('.tree-row').filter({ hasText: '原始标题' }).first().click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  assert.equal(
    await workspace.locator('.tree-row').filter({ hasText: '文本 · 原始标题' }).count(),
    0,
  );
  assert.equal(await workspace.locator('[data-action="focus-selection"]').isDisabled(), false);
  const historyCountBeforeFocus = await source
    .locator('#dock-extension-host .history-count')
    .textContent();
  await workspace.locator('[data-action="focus-selection"]').click();
  assert.equal(await workspace.locator('[data-selection-count]').textContent(), '已选择 1 个对象');
  assert.equal(
    await source.locator('#dock-extension-host .history-count').textContent(),
    historyCountBeforeFocus,
  );
  await workspace.locator('[data-action="fit-canvas"]').click();
  const widthBeforeHandle = Number(await canvasWidth.inputValue());
  const rightHandle = workspace.locator('[data-canvas-resize="right"]');
  const rightHandleBox = await rightHandle.boundingBox();
  assert.ok(rightHandleBox);
  const rightHandleX = rightHandleBox.x + rightHandleBox.width / 2;
  const rightHandleY = rightHandleBox.y + rightHandleBox.height / 2;
  await rightHandle.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX: rightHandleX,
    clientY: rightHandleY,
    pointerId: 101,
    pointerType: 'mouse',
    isPrimary: true,
  });
  await workspace.evaluate(
    ({ x, y }) => {
      const init = {
        bubbles: true,
        cancelable: true,
        buttons: 1,
        clientX: x,
        clientY: y,
        pointerId: 101,
        pointerType: 'mouse',
        isPrimary: true,
      };
      window.dispatchEvent(new PointerEvent('pointermove', init));
      window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    },
    { x: rightHandleX + 48, y: rightHandleY },
  );
  assert.ok(Number(await canvasWidth.inputValue()) > widthBeforeHandle);
  await canvasWidth.fill(String(widthBeforeHandle));
  const heightBeforeHandle = Number(await canvasHeight.inputValue());
  const bottomHandle = workspace.locator('[data-canvas-resize="bottom"]');
  const bottomHandleBox = await bottomHandle.boundingBox();
  assert.ok(bottomHandleBox);
  const bottomHandleX = bottomHandleBox.x + bottomHandleBox.width / 2;
  const bottomHandleY = bottomHandleBox.y + bottomHandleBox.height / 2;
  await bottomHandle.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX: bottomHandleX,
    clientY: bottomHandleY,
    pointerId: 102,
    pointerType: 'mouse',
    isPrimary: true,
  });
  await workspace.evaluate(
    ({ x, y }) => {
      const init = {
        bubbles: true,
        cancelable: true,
        buttons: 1,
        clientX: x,
        clientY: y,
        pointerId: 102,
        pointerType: 'mouse',
        isPrimary: true,
      };
      window.dispatchEvent(new PointerEvent('pointermove', init));
      window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    },
    { x: bottomHandleX, y: bottomHandleY + 48 },
  );
  assert.ok(Number(await canvasHeight.inputValue()) > heightBeforeHandle);
  await canvasHeight.fill(String(heightBeforeHandle));

  await workspace.locator('[data-action="show-delivery"]').click();
  assert.equal(await workspace.locator('[data-action="export-html"]').count(), 1);
  assert.equal(await workspace.locator('[data-action="export-viewport-png"]').count(), 1);
  await workspace.evaluate(() => {
    globalThis.__copiedPrompt = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          globalThis.__copiedPrompt = value;
        },
      },
    });
  });
  const noticeBeforePromptCopy = await workspace.locator('[data-notice]').textContent();
  await workspace.locator('[data-action="copy-prompt"]').click();
  await workspace.locator('[data-action="copy-prompt"][data-copy-state="success"]').waitFor();
  assert.match(
    await workspace.locator('[data-action="copy-prompt"]').innerText(),
    /已复制 AI 提示词\s*提示词已复制到剪贴板/,
  );
  assert.match(await workspace.evaluate(() => globalThis.__copiedPrompt), /点睛 AI 源码同步任务/);
  assert.match(
    await workspace.evaluate(() => globalThis.__copiedPrompt),
    /当前没有可同步的有效修改/,
  );
  assert.equal(await workspace.locator('[data-notice]').textContent(), noticeBeforePromptCopy);
  await workspace.locator('[data-action="export-html"]').click();
  await workspace.locator('[data-export-progress]').waitFor({ state: 'visible' });
  assert.equal(await workspace.locator('[data-action="export-html"]').isDisabled(), true);
  await workspace.evaluate(() =>
    globalThis.__workspaceRuntimeListeners.forEach((listener) =>
      listener({
        type: 'workspace/export-progress',
        sessionId: 'e2e-session',
        progress: { stage: 'styles', completed: 3, total: 11, label: '正在内嵌页面样式' },
      }),
    ),
  );
  assert.match(await workspace.locator('[data-export-progress]').innerText(), /正在内嵌页面样式/);
  assert.equal(
    await workspace.locator('[data-export-progress] progress').getAttribute('max'),
    '11',
  );
  resolvePendingOfflineExport({
    ok: true,
    html: '<!doctype html><title>离线副本</title>',
    warnings: ['样式资源 images/control/kedu.png：原网页未提供（HTTP 404）'],
  });
  await workspace.locator('[data-action="export-html"]').waitFor({ state: 'visible' });
  assert.equal(await workspace.locator('[data-action="export-html"]').isDisabled(), false);
  assert.match(
    await workspace.locator('[data-export-progress]').innerText(),
    /离线 HTML 已生成 · .*1 项样式资源在原网页已不存在/,
  );

  await workspace.locator('[data-action="export-html"]').click();
  await workspace.locator('[data-export-progress]').waitFor({ state: 'visible' });
  workspaceStateRequests = 0;
  await workspace.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await workspace.waitForTimeout(100);
  assert.equal(workspaceStateRequests, 0);
  resolvePendingOfflineExport({ ok: false, error: '页面资源读取超时（15 秒）' });
  await workspace.locator('[data-export-progress].is-failed').waitFor({ state: 'visible' });
  assert.equal(await workspace.locator('[data-action="export-html"]').isDisabled(), false);
  assert.match(
    await workspace.locator('[data-export-progress]').innerText(),
    /导出未完成 · 页面资源读取超时（15 秒）/,
  );
  assert.equal(await workspace.locator('[data-page-frame]').count(), 1);

  await workspace.frameLocator('[data-page-frame]').locator('#title').click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  assert.equal(await workspace.locator('.tree-row.is-selected').count(), 1);
  assert.equal(await workspace.locator('.tree-row.is-primary').count(), 1);
  assert.equal(await workspace.locator('.selection-overlay.is-primary').count(), 1);
  assert.equal(await workspace.locator('.selection-overlay-label').count(), 0);
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('#title')
      .getAttribute('data-dianjing-selected'),
    'true',
  );
  assert.equal(await workspace.locator('.task-tabs button').count(), 2);
  assert.equal(await workspace.locator('.task-tabs button.is-active').textContent(), '属性');
  assert.equal(await workspace.locator('[data-structure="up"],[data-structure="down"]').count(), 0);
  assert.equal(
    await workspace.locator('select[data-draft-property="font-family"] option').count(),
    12,
  );
  assert.equal(await workspace.locator('.format-grid button').count(), 4);
  assert.equal(
    await workspace
      .locator('input[data-style-property="font-size"][data-range-control="slider"]')
      .getAttribute('type'),
    'range',
  );
  const fontSizeNumberEditor = workspace.locator(
    'input[data-style-property="font-size"][data-range-control="number"]',
  );
  assert.equal(await fontSizeNumberEditor.getAttribute('type'), 'number');
  assert.equal(await fontSizeNumberEditor.getAttribute('data-unit'), 'px');
  assert.equal(await fontSizeNumberEditor.locator('..').locator('em').textContent(), 'px');
  assert.equal(await workspace.locator('.spacing-box--margin input').count(), 4);
  assert.equal(await workspace.locator('.spacing-box--padding input').count(), 4);
  const workspaceVisibilityToggle = workspace.locator('.visibility-toggle');
  assert.match(await workspace.locator('.visibility-copy strong').textContent(), /在画布中显示/);
  await workspaceVisibilityToggle.click();
  await source.waitForFunction(
    () => document.querySelector('#title')?.style.visibility === 'hidden',
  );
  assert.equal(await workspace.locator('.tree-row.is-hidden').count(), 1);
  assert.match(await workspace.locator('.tree-row.is-hidden .tree-visibility').textContent(), /隐/);
  assert.equal(await source.locator('#dock-extension-host .history-count').textContent(), '1');
  await workspace.locator('.visibility-toggle').click();
  await source.waitForFunction(
    () => document.querySelector('#title')?.style.visibility === 'visible',
  );
  assert.equal(await workspace.locator('.tree-row.is-hidden').count(), 0);
  assert.equal(await source.locator('#dock-extension-host .history-count').textContent(), '2');
  const editor = workspace.locator('textarea[data-text-editor]');
  await editor.fill('工作台确认后的标题');
  await workspace.waitForTimeout(250);
  assert.equal(await source.locator('#title').textContent(), '原始标题');
  await editor.press('Tab');
  await source.waitForFunction(
    () => document.querySelector('#title')?.textContent === '工作台确认后的标题',
  );
  assert.equal(await source.locator('#dock-extension-host .history-count').textContent(), '3');

  await workspace.locator('[data-action="undo"]').click();
  await source.waitForFunction(() => document.querySelector('#title')?.textContent === '原始标题');
  await workspace.locator('[data-action="redo"]').click();
  await source.waitForFunction(
    () => document.querySelector('#title')?.textContent === '工作台确认后的标题',
  );

  assert.equal(
    await workspace.locator('input[data-style-property="background-color"]').getAttribute('type'),
    'color',
  );
  assert.equal(
    await workspace.locator('input[data-style-property="border-color"]').getAttribute('type'),
    'color',
  );
  assert.equal(
    await workspace
      .locator('input[data-style-property="border-radius"][data-range-control="slider"]')
      .getAttribute('type'),
    'range',
  );
  assert.equal(
    await workspace
      .locator('input[data-style-property="border-width"][data-range-control="slider"]')
      .getAttribute('type'),
    'range',
  );
  assert.equal(
    await workspace.locator('select[data-draft-property="border-style"] option').count(),
    4,
  );
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-appearance.png'),
    fullPage: false,
  });
  await workspace.locator('select[data-draft-property="border-style"]').selectOption('solid');
  await source.waitForFunction(
    () => document.querySelector('#title')?.style.borderStyle === 'solid',
  );
  assert.equal(await source.locator('#dock-extension-host .history-count').textContent(), '4');

  assert.equal(await workspace.locator('.alignment-row button').count(), 6);
  assert.equal(await workspace.locator('.spacing-box--margin input').count(), 4);
  assert.equal(await workspace.locator('.spacing-box--padding input').count(), 4);
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-spacing.png'),
    fullPage: false,
  });
  await workspace.locator('[data-style-property="text-align"][data-style-value="center"]').click();
  await source.waitForFunction(
    () => document.querySelector('#title')?.style.textAlign === 'center',
  );
  assert.equal(await source.locator('#dock-extension-host .history-count').textContent(), '5');

  const widthEditor = workspace.locator('input[data-style-property="width"]');
  const heightEditor = workspace.locator('input[data-style-property="height"]');
  assert.equal(await widthEditor.getAttribute('type'), 'number');
  assert.equal(await widthEditor.getAttribute('data-unit'), 'px');
  assert.equal(await widthEditor.locator('..').locator('em').textContent(), 'px');
  assert.equal(await heightEditor.getAttribute('type'), 'number');
  assert.equal(await heightEditor.getAttribute('data-unit'), 'px');
  const titleWidthBeforeEditor = await source
    .locator('#title')
    .evaluate((element) => Math.round(element.getBoundingClientRect().width));
  await widthEditor.fill('240');
  await workspace.waitForTimeout(250);
  assert.notEqual(
    await source.locator('#title').evaluate((element) => element.style.width),
    '240px',
  );
  await widthEditor.press('Tab');
  await source.waitForFunction(() => document.querySelector('#title')?.style.width === '240px');
  assert.equal(
    await source
      .locator('#title')
      .evaluate((element) => Math.round(Number.parseFloat(getComputedStyle(element).width))),
    240,
  );
  assert.notEqual(
    await source
      .locator('#title')
      .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    titleWidthBeforeEditor,
  );
  const titleHeightBeforeEditor = await source
    .locator('#title')
    .evaluate((element) => Math.round(element.getBoundingClientRect().height));
  await heightEditor.fill('120');
  await heightEditor.press('Tab');
  await source.waitForFunction(() => document.querySelector('#title')?.style.height === '120px');
  assert.equal(
    await source
      .locator('#title')
      .evaluate((element) => Math.round(Number.parseFloat(getComputedStyle(element).height))),
    120,
  );
  assert.notEqual(
    await source
      .locator('#title')
      .evaluate((element) => Math.round(element.getBoundingClientRect().height)),
    titleHeightBeforeEditor,
  );
  await workspace.waitForFunction(
    () => {
      const title = document
        .querySelector('[data-page-frame]')
        ?.contentDocument?.querySelector('#title');
      return title?.style.width === '240px' && title.style.height === '120px';
    },
    { timeout: 2000 },
  );

  await workspace.locator('[data-format="bold"]').click();
  await source.waitForFunction(() => document.querySelector('#title')?.style.fontWeight === '400');
  assert.equal(await source.locator('#dock-extension-host .history-count').textContent(), '8');
  await fontSizeNumberEditor.fill('23');
  await workspace.waitForTimeout(250);
  assert.notEqual(
    await source.locator('#title').evaluate((element) => element.style.fontSize),
    '23px',
  );
  await fontSizeNumberEditor.press('Tab');
  await source.waitForFunction(() => document.querySelector('#title')?.style.fontSize === '23px');
  assert.equal(
    await workspace
      .locator('input[data-style-property="font-size"][data-range-control="slider"]')
      .inputValue(),
    '23',
  );
  await workspace.locator('[data-task="layout"]').click();
  assert.equal(await workspace.locator('.task-tabs button.is-active').textContent(), '布局');
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-layout-position.png'),
    fullPage: false,
  });
  const horizontalPosition = workspace.locator(
    'input[data-position-offset][data-style-property="left"]',
  );
  const verticalPosition = workspace.locator(
    'input[data-position-offset][data-style-property="top"]',
  );
  assert.equal(await horizontalPosition.getAttribute('min'), '-2560');
  await horizontalPosition.fill('18');
  await workspace.waitForTimeout(250);
  assert.notEqual(await source.locator('#title').evaluate((element) => element.style.left), '18px');
  await horizontalPosition.press('Tab');
  await source.waitForFunction(() => {
    const title = document.querySelector('#title');
    return (
      title instanceof HTMLElement &&
      title.style.position === 'relative' &&
      title.style.left === '18px'
    );
  });
  await verticalPosition.fill('-12');
  await verticalPosition.press('Tab');
  await source.waitForFunction(() => document.querySelector('#title')?.style.top === '-12px');
  // The edit tree intentionally narrows to the selected object's context.
  // Search keeps this assertion stable when the target lives outside that context.
  const objectFilter = workspace.locator('[data-object-filter]');
  await objectFilter.fill('技术支持');
  await workspace
    .locator('.tree-search-result')
    .filter({ hasText: '技术支持' })
    .first()
    .click({ timeout: 2000 });
  await objectFilter.fill('');
  await workspace.waitForTimeout(250);
  await workspace
    .locator('input[data-style-property="font-size"][data-range-control="number"]')
    .fill('23');
  await workspace
    .locator('input[data-style-property="font-size"][data-range-control="number"]')
    .press('Tab');
  await workspace.waitForTimeout(250);
  assert.deepEqual(
    await source.locator('#forced-font-size').evaluate((target) => ({
      fontSize: getComputedStyle(target).fontSize,
      priority: target.style.getPropertyPriority('font-size'),
    })),
    { fontSize: '23px', priority: 'important' },
  );
  await workspace.locator('.tree-row').filter({ hasText: '工作台确认后的标题' }).first().click();
  await workspace.waitForFunction(() =>
    document
      .querySelector('.tree-row.is-primary strong')
      ?.textContent?.includes('工作台确认后的标题'),
  );
  await workspace.waitForTimeout(250);
  assert.equal(
    await workspace.locator('.selection-overlay.is-primary [data-selection-resize]').count(),
    8,
  );
  const titleResizeHandle = workspace.locator(
    '.selection-overlay.is-primary [data-selection-resize="right"]',
  );
  await workspace.locator('[data-action="fit-canvas"]').click();
  await titleResizeHandle.waitFor({ state: 'visible' });
  const titleResizeBox = await titleResizeHandle.boundingBox();
  assert.ok(titleResizeBox);
  await workspace.mouse.move(
    titleResizeBox.x + titleResizeBox.width / 2,
    titleResizeBox.y + titleResizeBox.height / 2,
  );
  await workspace.mouse.down();
  await workspace.mouse.move(
    titleResizeBox.x + titleResizeBox.width / 2 + 48,
    titleResizeBox.y + titleResizeBox.height / 2,
  );
  await workspace.mouse.up();
  await source.waitForFunction(() =>
    /px$/.test(document.querySelector('#title')?.style.width ?? ''),
  );
  await workspace.waitForFunction(
    () =>
      /px$/.test(
        document.querySelector('[data-page-frame]')?.contentDocument?.querySelector('#title')?.style
          .width ?? '',
      ),
    { timeout: 2000 },
  );
  await workspace.waitForTimeout(250);
  const titleMoveHandle = workspace
    .locator('.selection-overlay.is-primary [data-selection-move]')
    .first();
  assert.equal(
    await workspace.locator('.selection-overlay.is-primary [data-selection-move]').count(),
    4,
  );
  const titleMoveBox = await titleMoveHandle.boundingBox();
  assert.ok(titleMoveBox);
  await workspace.mouse.move(
    titleMoveBox.x + titleMoveBox.width / 4,
    titleMoveBox.y + titleMoveBox.height / 2,
  );
  await workspace.mouse.down();
  await workspace.mouse.move(
    titleMoveBox.x + titleMoveBox.width / 4 + 48,
    titleMoveBox.y + titleMoveBox.height / 2 + 24,
  );
  await workspace.mouse.up();
  await source.waitForFunction(
    () =>
      document.querySelector('#title')?.style.position === 'relative' &&
      /px$/.test(document.querySelector('#title')?.style.left ?? '') &&
      /px$/.test(document.querySelector('#title')?.style.top ?? ''),
  );
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-free-move.png'),
    fullPage: false,
  });

  const refreshedTitleRow = workspace
    .locator('.tree-row')
    .filter({ hasText: '工作台确认后的标题' })
    .first();
  await refreshedTitleRow.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  assert.equal(await refreshedTitleRow.getAttribute('aria-selected'), 'true');
  assert.equal(await workspace.locator('.selection-overlay.is-primary').count(), 1);
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('#title')
      .getAttribute('data-dianjing-selected'),
    'true',
  );
  const canvasStageBox = await workspace.locator('[data-canvas-stage]').boundingBox();
  const canvasPageBox = await workspace.locator('[data-canvas-page]').boundingBox();
  assert.ok(canvasStageBox && canvasPageBox);
  const blankCanvasPoint = [
    { x: canvasStageBox.x + 12, y: canvasStageBox.y + 12 },
    { x: canvasStageBox.x + canvasStageBox.width - 12, y: canvasStageBox.y + 12 },
    { x: canvasStageBox.x + 12, y: canvasStageBox.y + canvasStageBox.height - 12 },
    {
      x: canvasStageBox.x + canvasStageBox.width - 12,
      y: canvasStageBox.y + canvasStageBox.height - 12,
    },
  ].find(
    (point) =>
      point.x < canvasPageBox.x ||
      point.x > canvasPageBox.x + canvasPageBox.width ||
      point.y < canvasPageBox.y ||
      point.y > canvasPageBox.y + canvasPageBox.height,
  );
  assert.ok(blankCanvasPoint);
  await workspace.mouse.click(blankCanvasPoint.x, blankCanvasPoint.y);
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '未选择对象',
  );
  assert.equal(await workspace.locator('.selection-overlay').count(), 0);
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('#title')
      .getAttribute('data-dianjing-selected'),
    null,
  );
  await refreshedTitleRow.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace
    .locator('.tree-row')
    .filter({ hasText: '立即开始' })
    .first()
    .click({ modifiers: ['Control'] });
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 2 个对象',
  );
  assert.equal(await workspace.locator('[data-selection-count]').textContent(), '已选择 2 个对象');
  assert.equal(await workspace.locator('.task-tabs button.is-active').textContent(), '布局');
  assert.equal(await workspace.locator('.summary-actions').count(), 0);
  assert.equal(await workspace.locator('.tree-row.is-selected').count(), 2);
  assert.equal(await workspace.locator('.selection-overlay').count(), 2);
  assert.equal(await workspace.locator('[data-batch-align]').count(), 6);
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-multi-layout-implemented.png'),
    fullPage: false,
  });
  await workspace.locator('[data-batch-align="center"]').click();
  await source.waitForFunction(() => {
    const title = document.querySelector('#title')?.getBoundingClientRect();
    const action = document.querySelector('#action')?.getBoundingClientRect();
    return Boolean(
      title &&
      action &&
      Math.abs(title.left + title.width / 2 - (action.left + action.width / 2)) < 1,
    );
  });
  assert.match(await source.locator('#action').evaluate((element) => element.style.left), /px$/);
  await workspace.locator('[data-action="create-group"]').click();
  await source.waitForFunction(
    () => document.querySelector('[data-dianjing-group="true"]')?.children.length === 2,
  );
  assert.equal(await source.locator('[data-dianjing-group="true"]').count(), 1);

  await objectFilter.fill('主内容区');
  await workspace.locator('.tree-search-result').filter({ hasText: '主内容区' }).first().click();
  await objectFilter.fill('');
  await workspace.waitForFunction(
    () => document.querySelector('.tree-row.is-primary strong')?.textContent === '主内容区',
  );
  await workspace.waitForTimeout(250);
  const containerWidthBeforeResize = await source
    .locator('#card')
    .evaluate((element) => Math.round(element.getBoundingClientRect().width));
  const containerResizeHandle = workspace.locator(
    '.selection-overlay.is-primary [data-selection-resize="right"]',
  );
  assert.equal(await containerResizeHandle.count(), 1);
  assert.equal(
    await workspace.locator('.selection-overlay.is-primary [data-selection-resize]').count(),
    8,
  );
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-container-resize.png'),
    fullPage: false,
  });
  const containerResizeBox = await containerResizeHandle.boundingBox();
  assert.ok(containerResizeBox);
  await workspace.mouse.move(
    containerResizeBox.x + containerResizeBox.width / 2,
    containerResizeBox.y + containerResizeBox.height / 2,
  );
  await workspace.mouse.down();
  await workspace.mouse.move(
    containerResizeBox.x + containerResizeBox.width / 2 + 56,
    containerResizeBox.y + containerResizeBox.height / 2,
  );
  await workspace.mouse.up();
  await source.waitForFunction(
    (previousWidth) =>
      Math.round(document.querySelector('#card')?.getBoundingClientRect().width ?? 0) >
      previousWidth,
    containerWidthBeforeResize,
  );
  assert.match(await source.locator('#card').evaluate((element) => element.style.width), /px$/);

  const frameTitle = workspace.frameLocator('[data-page-frame]').locator('#title');
  const frameMain = workspace.frameLocator('[data-page-frame]').locator('#card');
  await frameTitle.evaluate((element) =>
    element.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }),
    ),
  );
  await frameMain.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    element.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: rect.top + rect.height / 2,
        dataTransfer,
      }),
    );
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.top + rect.height / 2,
        dataTransfer,
      }),
    );
  });
  await source.waitForFunction(
    () => document.querySelector('#card')?.lastElementChild?.id === 'title',
  );
  assert.equal(
    await source.locator('#card').evaluate((element) => element.lastElementChild?.id),
    'title',
  );
  await workspace.locator('[data-action="undo"]').click();
  await source.waitForFunction(() =>
    document.querySelector('[data-dianjing-group="true"]')?.querySelector('#title'),
  );
  await workspace.locator('[data-action="redo"]').click();
  await source.waitForFunction(
    () => document.querySelector('#card')?.lastElementChild?.id === 'title',
  );

  const refreshedFrameTitle = workspace.frameLocator('[data-page-frame]').locator('#title');
  await refreshedFrameTitle.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace.locator('[data-action="toggle-guides"]').click();
  assert.equal(
    await workspace.locator('[data-action="toggle-guides"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await workspace.locator('[data-rulers]').isHidden(), false);
  assert.ok((await workspace.locator('[data-ruler-ticks="top"] .ruler-tick.is-major').count()) > 0);
  assert.ok(
    (await workspace.locator('[data-ruler-ticks="left"] .ruler-tick.is-major').count()) > 0,
  );
  assert.equal(await workspace.locator('[data-guide-list]').count(), 0);
  const rulerGutterGeometry = await workspace.evaluate(() => {
    const top = document.querySelector('[data-ruler="top"]')?.getBoundingClientRect();
    const left = document.querySelector('[data-ruler="left"]')?.getBoundingClientRect();
    const stage = document.querySelector('[data-canvas-stage]')?.getBoundingClientRect();
    if (!top || !left || !stage) throw new Error('标尺或画布尚未准备完成');
    return {
      topOutsideStage: top.bottom <= stage.top + 1,
      leftOutsideStage: left.right <= stage.left + 1,
      topHeight: top.height,
      leftWidth: left.width,
    };
  });
  assert.equal(rulerGutterGeometry.topOutsideStage, true);
  assert.equal(rulerGutterGeometry.leftOutsideStage, true);
  assert.equal(rulerGutterGeometry.topHeight, 24);
  assert.equal(rulerGutterGeometry.leftWidth, 32);
  const canvasLayerStyles = await workspace.evaluate(() => {
    const viewport = document.querySelector('[data-canvas-viewport]');
    const stage = document.querySelector('[data-canvas-stage]');
    const page = document.querySelector('[data-canvas-page]');
    if (!viewport || !stage || !page) throw new Error('画布层级尚未准备完成');
    const viewportStyle = getComputedStyle(viewport);
    const stageStyle = getComputedStyle(stage);
    const pageStyle = getComputedStyle(page);
    return {
      viewportBackground: viewportStyle.backgroundColor,
      stageBackground: stageStyle.backgroundColor,
      viewportBorderTop: viewportStyle.borderTopWidth,
      viewportShadow: viewportStyle.boxShadow,
      stageBorderTop: stageStyle.borderTopWidth,
      pageBorderTopWidth: pageStyle.borderTopWidth,
      pageShadow: pageStyle.boxShadow,
    };
  });
  assert.equal(canvasLayerStyles.viewportBackground, canvasLayerStyles.stageBackground);
  assert.equal(canvasLayerStyles.viewportBorderTop, '0px');
  assert.equal(canvasLayerStyles.viewportShadow, 'none');
  assert.equal(canvasLayerStyles.stageBorderTop, '0px');
  assert.equal(canvasLayerStyles.pageBorderTopWidth, '1px');
  assert.notEqual(canvasLayerStyles.pageShadow, 'none');
  assert.equal(await workspace.locator('[data-action="add-guide"]').count(), 0);
  const dragGuideFromRuler = async (orientation, offsetX, offsetY) => {
    const pageBox = await workspace.locator('[data-page-frame]').boundingBox();
    const rulerBox = await workspace
      .locator(`[data-ruler="${orientation === 'vertical' ? 'top' : 'left'}"]`)
      .boundingBox();
    assert.ok(pageBox && rulerBox);
    const start =
      orientation === 'vertical'
        ? { x: Math.max(rulerBox.x + 36, pageBox.x + offsetX), y: rulerBox.y + rulerBox.height / 2 }
        : { x: rulerBox.x + rulerBox.width / 2, y: Math.max(rulerBox.y + 36, pageBox.y + offsetY) };
    const drop = { x: pageBox.x + offsetX, y: pageBox.y + offsetY };
    await workspace.mouse.move(start.x, start.y);
    await workspace.mouse.down();
    await workspace.mouse.move(drop.x, drop.y);
    await workspace.mouse.up();
  };
  const invalidGuideCount = await workspace.locator('[data-guide-id]').count();
  const invalidPageBox = await workspace.locator('[data-page-frame]').boundingBox();
  const invalidRulerBox = await workspace.locator('[data-ruler="top"]').boundingBox();
  assert.ok(invalidPageBox && invalidRulerBox);
  await workspace.mouse.move(
    invalidRulerBox.x + 44,
    invalidRulerBox.y + invalidRulerBox.height / 2,
  );
  await workspace.mouse.down();
  await workspace.mouse.move(invalidPageBox.x - 18, invalidPageBox.y - 18);
  await workspace.mouse.up();
  assert.equal(await workspace.locator('[data-guide-id]').count(), invalidGuideCount);
  await dragGuideFromRuler('vertical', 220, 120);
  await dragGuideFromRuler('horizontal', 220, 260);
  assert.equal(await workspace.locator('[data-guide-id]').count(), 2);
  // Dropping a ruler guide on the canvas can also produce the canvas background
  // click; restore the object selection before inspecting the layout panel.
  await refreshedFrameTitle.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace.locator('[data-task="layout"]').click();
  assert.equal(await workspace.locator('[data-guide-manager] [data-guide-select]').count(), 2);
  assert.equal(
    await workspace.locator('[data-guide-select-none]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await workspace.locator('[data-guide-manager] [data-guide-position]').count(), 0);
  await workspace.locator('[data-task="layout"]').click();
  assert.equal(await workspace.locator('[data-guide-manager]').count(), 1);
  assert.match(await workspace.locator('[data-guide-manager]').textContent(), /不使用参考线/);
  await workspace.locator('[data-guide-manager] [data-guide-select]').nth(1).click();
  assert.equal(
    await workspace.locator('[data-guide-select-none]').getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(await workspace.locator('[data-guide-manager] [data-guide-position]').count(), 1);
  assert.equal(await workspace.locator('[data-guide-id]').count(), 2);
  assert.equal(await workspace.locator('[data-guide-id].is-current').count(), 1);
  const currentGuidePosition = workspace
    .locator('[data-guide-manager] [data-guide-position]')
    .first();
  assert.equal(await currentGuidePosition.getAttribute('max'), '800');
  await currentGuidePosition.fill('300');
  await currentGuidePosition.press('Tab');
  assert.match(
    await workspace
      .locator('[data-guide-id][aria-label^="水平"]')
      .last()
      .getAttribute('aria-label'),
    /300 px/,
  );
  // An active guide must not replace the object property editor.
  await workspace.locator('[data-task="properties"]').click();
  assert.equal(await workspace.locator('[data-text-editor]').count(), 1);
  await workspace.locator('[data-task="layout"]').click();
  await workspace.locator('[data-guide-manager] [data-guide-delete]').click();
  assert.equal(await workspace.locator('[data-guide-id].is-current').count(), 0);
  await dragGuideFromRuler('horizontal', 220, 260);
  await refreshedFrameTitle.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace.locator('[data-task="layout"]').click();
  assert.equal(
    await workspace.locator('[data-guide-select-none]').getAttribute('aria-pressed'),
    'true',
  );
  const guideBeforeDrag = await workspace
    .locator('[data-guide-id]')
    .first()
    .getAttribute('aria-label');
  const guideBox = await workspace.locator('[data-guide-id]').first().boundingBox();
  assert.ok(guideBox);
  await workspace.mouse.move(guideBox.x + guideBox.width / 2, guideBox.y + guideBox.height / 2);
  await workspace.mouse.down();
  await workspace.mouse.move(
    guideBox.x + guideBox.width / 2 + 36,
    guideBox.y + guideBox.height / 2 + 18,
  );
  await workspace.mouse.up();
  assert.notEqual(
    await workspace.locator('[data-guide-id]').first().getAttribute('aria-label'),
    guideBeforeDrag,
  );
  assert.equal(
    await workspace.locator('[data-guide-select-none]').getAttribute('aria-pressed'),
    'false',
  );
  await workspace.locator('[data-guide-manager] [data-guide-select-none]').click();
  assert.equal(
    await workspace.locator('[data-guide-select-none]').getAttribute('aria-pressed'),
    'true',
  );
  await workspace.locator('[data-guide-manager] [data-guide-select]').first().click();
  assert.equal(
    await workspace.locator('[data-guide-select-none]').getAttribute('aria-pressed'),
    'false',
  );
  await workspace.locator('[data-guide-manager] [data-guide-delete]').click();
  assert.equal(
    await workspace.locator('[data-guide-select-none]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await workspace.locator('[data-guide-id].is-current').count(), 0);
  // Add one explicit guide back for the hover/scroll geometry checks below.
  await dragGuideFromRuler('vertical', 220, 120);
  const verticalGuideGeometry = await workspace.evaluate(() => {
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="竖直"]')
      ?.getBoundingClientRect();
    if (!frame || !line) throw new Error('竖直参考线尚未准备完成');
    return {
      topGap: Math.abs(line.top - frame.top),
      heightGap: Math.abs(line.height - frame.height),
      frameHeight: frame.height,
      lineHeight: line.height,
    };
  });
  assert.ok(verticalGuideGeometry.topGap < 2);
  assert.ok(verticalGuideGeometry.heightGap < 2);

  // Make both the outer canvas and the iframe document substantially larger
  // than the visible stage.  This exercises the real two-level scroll model:
  // the guide remains page-bound, while its containing overlay is a child of
  // the scrollable stage.
  await workspace.locator('[data-canvas-width]').fill('2200');
  await workspace.locator('[data-canvas-width]').press('Tab');
  await workspace.locator('[data-canvas-height]').fill('2200');
  await workspace.locator('[data-canvas-height]').press('Tab');
  await workspace.waitForTimeout(40);
  await workspace
    .frameLocator('[data-page-frame]')
    .locator('body')
    .evaluate((body) => {
      body.style.minWidth = '2600px';
      body.style.minHeight = '2600px';
      body.style.width = '2600px';
      body.style.height = '2600px';
    });
  await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate(() => window.scrollTo(0, 0));
  await workspace.waitForTimeout(40);

  const outerStageRange = await workspace.evaluate(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    if (!(stage instanceof HTMLElement)) throw new Error('外层画布尚未准备完成');
    return {
      clientWidth: stage.clientWidth,
      clientHeight: stage.clientHeight,
      scrollWidth: stage.scrollWidth,
      scrollHeight: stage.scrollHeight,
    };
  });
  assert.ok(outerStageRange.scrollHeight - outerStageRange.clientHeight > 1);
  assert.ok(outerStageRange.scrollWidth - outerStageRange.clientWidth > 1);

  const outerGuideBefore = await workspace.evaluate(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="竖直"]')
      ?.getBoundingClientRect();
    if (!(stage instanceof HTMLElement) || !frame || !line)
      throw new Error('外层滚动前参考线几何尚未准备完成');
    return {
      frameTop: frame.top,
      lineTop: line.top,
      frameBottom: frame.bottom,
      lineBottom: line.bottom,
      frameHeight: frame.height,
      lineHeight: line.height,
      stageTop: stage.getBoundingClientRect().top,
      stageBottom: stage.getBoundingClientRect().bottom,
    };
  });
  assert.ok(Math.abs(outerGuideBefore.lineHeight - outerGuideBefore.frameHeight) < 2);
  // A: vertical outer scroll only.  The guide's X axis stays in the stage
  // viewport, while its Y span follows the full frame page.
  const outerScrollTop = await workspace.evaluate(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    if (!(stage instanceof HTMLElement)) throw new Error('外层画布尚未准备完成');
    stage.scrollTop = Math.min(
      stage.scrollHeight - stage.clientHeight,
      Math.max(stage.clientHeight + 24, 1),
    );
    stage.scrollLeft = 0;
    stage.dispatchEvent(new Event('scroll'));
    return { scrollTop: stage.scrollTop, scrollLeft: stage.scrollLeft };
  });
  assert.ok(outerScrollTop.scrollTop > 0);
  const outerGuideAfter = await workspace.evaluate(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="竖直"]')
      ?.getBoundingClientRect();
    if (!(stage instanceof HTMLElement) || !frame || !line)
      throw new Error('外层滚动后参考线几何尚未准备完成');
    const visibleTop = Math.max(frame.top, stage.getBoundingClientRect().top);
    const visibleBottom = Math.min(frame.bottom, stage.getBoundingClientRect().bottom);
    const visibleLeft = Math.max(frame.left, stage.getBoundingClientRect().left);
    const visibleRight = Math.min(frame.right, stage.getBoundingClientRect().right);
    return {
      frameLeft: frame.left,
      frameRight: frame.right,
      frameTop: frame.top,
      lineTop: line.top,
      frameBottom: frame.bottom,
      lineBottom: line.bottom,
      frameHeight: frame.height,
      lineHeight: line.height,
      visibleTop,
      visibleBottom,
      visibleLeft,
      visibleRight,
      lineLeft: line.left,
    };
  });
  assert.ok(Math.abs(outerGuideAfter.lineTop - outerGuideAfter.frameTop) < 2);
  assert.ok(Math.abs(outerGuideAfter.lineHeight - outerGuideAfter.frameHeight) < 2);
  assert.ok(outerGuideAfter.lineTop <= outerGuideAfter.visibleTop + 2);
  assert.ok(outerGuideAfter.lineBottom >= outerGuideAfter.visibleBottom - 2);
  assert.ok(outerGuideAfter.lineLeft >= outerGuideAfter.visibleLeft - 2);
  assert.ok(outerGuideAfter.lineLeft <= outerGuideAfter.visibleRight + 2);
  await workspace.locator('[data-canvas-stage]').evaluate((stage) => {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
    stage.dispatchEvent(new Event('scroll'));
  });

  // B: horizontal outer scroll only.  Its Y axis stays in the stage viewport,
  // while its X span follows the full frame page.
  await dragGuideFromRuler('horizontal', 220, 260);
  const horizontalGuideGeometry = await workspace.evaluate(() => {
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="水平"]')
      ?.getBoundingClientRect();
    if (!frame || !line) throw new Error('水平参考线尚未准备完成');
    return {
      leftGap: Math.abs(line.left - frame.left),
      widthGap: Math.abs(line.width - frame.width),
      frameWidth: frame.width,
      lineWidth: line.width,
    };
  });
  assert.ok(horizontalGuideGeometry.leftGap < 2);
  assert.ok(horizontalGuideGeometry.widthGap < 2);
  const outerScrollLeft = await workspace.evaluate(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    if (!(stage instanceof HTMLElement)) throw new Error('外层画布尚未准备完成');
    stage.scrollTop = 0;
    stage.scrollLeft = Math.min(
      stage.scrollWidth - stage.clientWidth,
      Math.max(stage.clientWidth + 24, 1),
    );
    stage.dispatchEvent(new Event('scroll'));
    return { scrollTop: stage.scrollTop, scrollLeft: stage.scrollLeft };
  });
  assert.equal(outerScrollLeft.scrollTop, 0);
  assert.ok(outerScrollLeft.scrollLeft > 0);
  const outerHorizontalAfter = await workspace.evaluate(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="水平"]')
      ?.getBoundingClientRect();
    if (!(stage instanceof HTMLElement) || !frame || !line)
      throw new Error('水平参考线外层滚动后几何尚未准备完成');
    const stageRect = stage.getBoundingClientRect();
    const visibleTop = Math.max(frame.top, stageRect.top);
    const visibleBottom = Math.min(frame.bottom, stageRect.bottom);
    const visibleLeft = Math.max(frame.left, stageRect.left);
    const visibleRight = Math.min(frame.right, stageRect.right);
    return {
      frameLeft: frame.left,
      frameRight: frame.right,
      lineLeft: line.left,
      lineRight: line.right,
      frameTop: frame.top,
      frameBottom: frame.bottom,
      lineTop: line.top,
      lineBottom: line.bottom,
      visibleTop,
      visibleBottom,
      visibleLeft,
      visibleRight,
    };
  });
  assert.ok(Math.abs(outerHorizontalAfter.lineLeft - outerHorizontalAfter.frameLeft) < 2);
  assert.ok(Math.abs(outerHorizontalAfter.lineRight - outerHorizontalAfter.frameRight) < 2);
  assert.ok(outerHorizontalAfter.lineLeft <= outerHorizontalAfter.visibleLeft + 2);
  assert.ok(outerHorizontalAfter.lineRight >= outerHorizontalAfter.visibleRight - 2);
  assert.ok(outerHorizontalAfter.lineTop >= outerHorizontalAfter.visibleTop - 2);
  assert.ok(outerHorizontalAfter.lineTop <= outerHorizontalAfter.visibleBottom + 2);
  await workspace.locator('[data-canvas-stage]').evaluate((stage) => {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
    stage.dispatchEvent(new Event('scroll'));
  });

  // The iframe's own scroll axes must not turn a guide into a fixed screen
  // crosshair.  A vertical guide keeps its X position while the iframe moves
  // vertically; a horizontal guide keeps its Y position while it moves
  // horizontally, and both still span the full outer frame.
  const iframeGuideBeforeScroll = await workspace.evaluate(() => {
    const vertical = document
      .querySelector('[data-guide-id][aria-label^="竖直"]')
      ?.getBoundingClientRect();
    const horizontal = document
      .querySelector('[data-guide-id][aria-label^="水平"]')
      ?.getBoundingClientRect();
    if (!vertical || !horizontal) throw new Error('iframe 滚动前参考线几何尚未准备完成');
    return { verticalLeft: vertical.left, horizontalTop: horizontal.top };
  });
  await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate(() => window.scrollTo(120, 120));
  await workspace.waitForTimeout(30);
  const iframeScrollAfter = await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate((html) => {
      const frameWindow = html.ownerDocument.defaultView;
      return {
        scrollX: frameWindow?.scrollX ?? 0,
        scrollY: frameWindow?.scrollY ?? 0,
      };
    });
  assert.ok(iframeScrollAfter.scrollX > 0);
  assert.ok(iframeScrollAfter.scrollY > 0);
  const iframeGuideAfter = await workspace.evaluate(() => {
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const vertical = document
      .querySelector('[data-guide-id][aria-label^="竖直"]')
      ?.getBoundingClientRect();
    const horizontal = document
      .querySelector('[data-guide-id][aria-label^="水平"]')
      ?.getBoundingClientRect();
    if (!frame || !vertical || !horizontal) throw new Error('iframe 滚动后参考线几何尚未准备完成');
    return {
      frameTop: frame.top,
      frameLeft: frame.left,
      frameHeight: frame.height,
      frameWidth: frame.width,
      verticalLeft: vertical.left,
      verticalTop: vertical.top,
      verticalHeight: vertical.height,
      horizontalLeft: horizontal.left,
      horizontalTop: horizontal.top,
      horizontalWidth: horizontal.width,
    };
  });
  const iframeZoom = await workspace.evaluate(() => {
    const frame = document.querySelector('[data-page-frame]');
    const widthInput = document.querySelector('[data-canvas-width]');
    if (!(frame instanceof HTMLIFrameElement) || !(widthInput instanceof HTMLInputElement)) {
      throw new Error('无法读取 iframe 缩放比例');
    }
    return frame.getBoundingClientRect().width / Math.max(widthInput.valueAsNumber, 1);
  });
  assert.ok(iframeZoom > 0);
  assert.ok(Math.abs(iframeGuideAfter.verticalTop - iframeGuideAfter.frameTop) < 2);
  assert.ok(Math.abs(iframeGuideAfter.verticalHeight - iframeGuideAfter.frameHeight) < 2);
  assert.ok(Math.abs(iframeGuideAfter.horizontalLeft - iframeGuideAfter.frameLeft) < 2);
  assert.ok(Math.abs(iframeGuideAfter.horizontalWidth - iframeGuideAfter.frameWidth) < 2);
  assert.ok(
    Math.abs(
      iframeGuideAfter.verticalLeft -
        iframeGuideBeforeScroll.verticalLeft +
        iframeScrollAfter.scrollX * iframeZoom,
    ) < 2,
  );
  assert.ok(
    Math.abs(
      iframeGuideAfter.horizontalTop -
        iframeGuideBeforeScroll.horizontalTop +
        iframeScrollAfter.scrollY * iframeZoom,
    ) < 2,
  );
  await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate(() => window.scrollTo(0, 0));
  await workspace.waitForTimeout(30);

  // Return to the fixture canvas before the existing zoom and inspector checks.
  await workspace.locator('[data-canvas-width]').fill('1280');
  await workspace.locator('[data-canvas-width]').press('Tab');
  await workspace.locator('[data-canvas-height]').fill('800');
  await workspace.locator('[data-canvas-height]').press('Tab');
  await workspace.waitForTimeout(40);
  await workspace.locator('[data-action="zoom-in"]').click();
  const scaledGuideGeometry = await workspace.evaluate(() => {
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="竖直"]')
      ?.getBoundingClientRect();
    if (!frame || !line) throw new Error('缩放后竖直参考线尚未准备完成');
    return {
      topGap: Math.abs(line.top - frame.top),
      heightGap: Math.abs(line.height - frame.height),
    };
  });
  assert.ok(scaledGuideGeometry.topGap < 2);
  assert.ok(scaledGuideGeometry.heightGap < 2);
  await workspace.locator('[data-zoom]').click();
  await refreshedFrameTitle.hover();
  await workspace.locator('[data-measure-overlay]').waitFor({ state: 'visible' });
  assert.match(
    await workspace.locator('[data-measure-overlay] span').textContent(),
    /\d+ × \d+ px/,
  );
  await workspace.locator('[data-action="toggle-guides"]').click();
  assert.equal(
    await workspace.locator('[data-action="toggle-guides"]').getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(await workspace.locator('[data-measure-overlay]').isHidden(), true);
  const closedAfterToggleGeometry = await workspace.evaluate(() => {
    const viewport = document.querySelector('[data-canvas-viewport]')?.getBoundingClientRect();
    const stage = document.querySelector('[data-canvas-stage]')?.getBoundingClientRect();
    if (!viewport || !stage) throw new Error('关闭参考线后的画布尚未准备完成');
    return (
      Math.abs(viewport.left - stage.left) <= 1 &&
      Math.abs(viewport.top - stage.top) <= 1 &&
      Math.abs(viewport.right - stage.right) <= 1 &&
      Math.abs(viewport.bottom - stage.bottom) <= 1
    );
  });
  assert.equal(closedAfterToggleGeometry, true);
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-merged.png'),
    fullPage: false,
  });

  // Guide and canvas interactions can also produce a canvas background click;
  // restore the fixture selection before checking the history panel handoff.
  await refreshedFrameTitle.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace.locator('[data-action="show-history"]').click();
  assert.ok((await workspace.locator('.history-item').count()) >= 5);
  assert.match(await workspace.locator('.history-list').textContent(), /修改文字/);
  await workspace.locator('[data-action="show-history"]').click();
  assert.equal(await workspace.locator('.history-list').count(), 0);
  assert.ok(await workspace.locator('.selected-card').count());
  await workspace.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await workspace.evaluate(() => document.documentElement.scrollWidth), 1280);
  assert.equal(await workspace.evaluate(() => document.documentElement.scrollHeight), 800);

  await source.evaluate(() => {
    for (const [id, label, left] of [
      ['distribution-a', '分布对象甲', 12],
      ['distribution-b', '分布对象乙', 96],
      ['distribution-c', '分布对象丙', 412],
    ]) {
      const element = document.createElement('span');
      element.id = id;
      element.textContent = label;
      element.style.position = 'relative';
      element.style.left = `${left}px`;
      document.body.append(element);
    }
  });
  await workspace.locator('[data-action="refresh"]').click();
  const distributionFilter = workspace.locator('[data-object-filter]');
  for (const label of ['分布对象甲', '分布对象乙', '分布对象丙']) {
    await distributionFilter.fill(label);
    await workspace
      .locator('.tree-search-result')
      .filter({ hasText: label })
      .first()
      .click({ modifiers: label === '分布对象甲' ? [] : ['Control'] });
  }
  await distributionFilter.fill('');
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 3 个对象',
  );
  assert.equal(await workspace.locator('[data-distribute="horizontal"]').isDisabled(), false);
  await workspace.locator('[data-distribute="horizontal"]').click();
  await source.waitForFunction(() => {
    const boxes = ['distribution-a', 'distribution-b', 'distribution-c'].map((id) =>
      document.querySelector(`#${id}`)?.getBoundingClientRect(),
    );
    if (boxes.some((box) => !box)) return false;
    const [first, second, third] = boxes;
    return Math.abs(second.left - first.right - (third.left - second.right)) < 1;
  });
  await workspace.locator('[data-batch-align="left"]').click();
  await source.waitForFunction(() => {
    const lefts = ['distribution-a', 'distribution-b', 'distribution-c'].map(
      (id) => document.querySelector(`#${id}`)?.getBoundingClientRect().left,
    );
    return lefts.every((left) => Math.abs(left - lefts[0]) < 1);
  });
  await workspace.locator('[data-batch-align="top"]').click();
  await source.waitForFunction(() => {
    const tops = ['distribution-a', 'distribution-b', 'distribution-c'].map(
      (id) => document.querySelector(`#${id}`)?.getBoundingClientRect().top,
    );
    return tops.every((top) => Math.abs(top - tops[0]) < 1);
  });

  await source.evaluate(() => {
    document.body.style.position = 'relative';
    document.body.style.minHeight = '1800px';
    for (const [id, label, left, top] of [
      ['guide-anchor', 'Guide Anchor', 620, 72],
      ['guide-follower', 'Guide Follower', 140, 318],
    ]) {
      const element = document.createElement('div');
      element.id = id;
      element.textContent = label;
      element.style.position = 'absolute';
      element.style.width = '120px';
      element.style.height = '48px';
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      document.body.append(element);
    }
  });
  await workspace.locator('[data-action="refresh"]').click();
  const guideAnchorRow = workspace.locator('.tree-row').filter({ hasText: 'Guide Anchor' }).first();
  const guideFollowerRow = workspace
    .locator('.tree-row')
    .filter({ hasText: 'Guide Follower' })
    .first();
  await guideAnchorRow.waitFor();
  await guideAnchorRow.click();
  await guideFollowerRow.click({ modifiers: ['Control'] });
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 2 个对象',
  );
  assert.equal(await workspace.locator('[data-selection-anchor="true"]').count(), 1);
  assert.match(
    await workspace.locator('[data-alignment-anchor]:not(.guide-anchor-note)').textContent(),
    /首选对象.*Guide Anchor/,
  );
  assert.equal(
    await workspace.locator('.tree-row.is-primary strong').textContent(),
    '文本 · Guide Follower',
  );
  const anchorBeforeNoGuide = await source.locator('#guide-anchor').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
  await workspace.locator('[data-batch-align="left"]').click();
  await source.waitForFunction(() => {
    const anchor = document.querySelector('#guide-anchor')?.getBoundingClientRect();
    const follower = document.querySelector('#guide-follower')?.getBoundingClientRect();
    return Boolean(anchor && follower && Math.abs(anchor.left - follower.left) < 1);
  });
  const anchorAfterNoGuide = await source.locator('#guide-anchor').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
  assert.ok(Math.abs(anchorAfterNoGuide.left - anchorBeforeNoGuide.left) < 1);
  assert.ok(Math.abs(anchorAfterNoGuide.top - anchorBeforeNoGuide.top) < 1);

  await workspace.locator('[data-action="toggle-guides"]').click();
  await workspace.locator('[data-task="layout"]').click();
  const existingGuideChoice = workspace.locator('[data-guide-manager] [data-guide-select]').first();
  await existingGuideChoice.click();
  await workspace.locator('[data-guide-manager] [data-guide-delete]').click();
  await dragGuideFromRuler('vertical', 220, 120);
  const verticalGuide = workspace.locator('[data-guide-id][aria-label^="竖直"]').last();
  const guideVerticalPx = Number(
    (await verticalGuide.getAttribute('aria-label')).match(/(\d+) px/)?.[1],
  );
  assert.ok(Number.isInteger(guideVerticalPx));
  await guideFollowerRow.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace.locator('[data-task="layout"]').click();
  await workspace.locator('[data-guide-manager] [data-guide-select]').last().click();
  assert.equal(await workspace.locator('[data-guide-manager-current]').count(), 1);
  assert.equal(await workspace.locator('[data-selection-anchor="true"]').count(), 0);
  assert.match(await workspace.locator('[data-alignment-anchor]').textContent(), /当前.*参考线/);
  assert.equal(await workspace.locator('[data-batch-align="top"]').isDisabled(), true);
  assert.equal(await workspace.locator('[data-batch-align="left"]').isDisabled(), false);
  const singleGuideFollowerBefore = await source.locator('#guide-follower').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, width: rect.width };
  });
  await workspace.locator('[data-batch-align="left"]').click();
  await source.waitForFunction(
    ({ position }) => {
      const rect = document.querySelector('#guide-follower')?.getBoundingClientRect();
      return Boolean(rect && Math.abs(rect.left - position) < 1);
    },
    { position: guideVerticalPx },
  );
  assert.notEqual(
    await source
      .locator('#guide-follower')
      .evaluate((element) => element.getBoundingClientRect().left),
    singleGuideFollowerBefore.left,
  );
  await guideAnchorRow.click();
  await guideFollowerRow.click({ modifiers: ['Control'] });
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 2 个对象',
  );
  await workspace.locator('[data-task="layout"]').click();
  await workspace.locator('[data-guide-manager] [data-guide-select]').last().click();
  for (const [alignment, edge] of [
    ['left', 'left'],
    ['center', 'center'],
    ['right', 'right'],
  ]) {
    await workspace.locator(`[data-batch-align="${alignment}"]`).click();
    await source.waitForFunction(
      ({ alignment, position }) => {
        const boxes = ['guide-anchor', 'guide-follower'].map((id) =>
          document.querySelector(`#${id}`)?.getBoundingClientRect(),
        );
        if (boxes.some((box) => !box)) return false;
        return boxes.every((box) => {
          const coordinate =
            alignment === 'left'
              ? box.left
              : alignment === 'center'
                ? box.left + box.width / 2
                : box.right;
          return Math.abs(coordinate - position) < 1;
        });
      },
      { alignment: edge, position: guideVerticalPx },
    );
  }

  await dragGuideFromRuler('horizontal', 220, 260);
  const horizontalGuide = workspace.locator('[data-guide-id][aria-label^="水平"]').last();
  const guideHorizontalPx = Number(
    (await horizontalGuide.getAttribute('aria-label')).match(/(\d+) px/)?.[1],
  );
  assert.ok(Number.isInteger(guideHorizontalPx));
  await workspace.locator('[data-guide-manager] [data-guide-select]').last().click();
  assert.equal(await workspace.locator('[data-batch-align="left"]').isDisabled(), true);
  // A horizontal guide also accepts a single object. Selecting the object
  // clears the anchor, so choose the guide again explicitly in the layout tab.
  await guideFollowerRow.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace.locator('[data-task="layout"]').click();
  await workspace.locator('[data-guide-manager] [data-guide-select]').last().click();
  assert.equal(await workspace.locator('[data-batch-align="top"]').isDisabled(), false);
  await workspace.locator('[data-batch-align="top"]').click();
  await source.waitForFunction(
    ({ position }) => {
      const rect = document.querySelector('#guide-follower')?.getBoundingClientRect();
      return Boolean(rect && Math.abs(rect.top - position) < 1);
    },
    { position: guideHorizontalPx },
  );
  await guideAnchorRow.click();
  await guideFollowerRow.click({ modifiers: ['Control'] });
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 2 个对象',
  );
  await workspace.locator('[data-task="layout"]').click();
  await workspace.locator('[data-guide-manager] [data-guide-select]').last().click();
  const commandTargets = await workspace.evaluate(() =>
    [...document.querySelectorAll('.tree-row.is-selected')]
      .map((row) => row.getAttribute('data-object-id'))
      .filter(Boolean)
      .map((key) =>
        key.startsWith('edit:')
          ? { editId: key.slice('edit:'.length) }
          : { fallbackSelector: key.slice('selector:'.length) },
      ),
  );
  const beforeInvalidGuide = await source.locator('#guide-anchor').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });
  const historyBeforeInvalidGuide = (await requestWorkspaceCommand({ action: 'get-state' })).state
    .history.length;
  const invalidGuideResponse = await requestWorkspaceCommand({
    action: 'align',
    targets: commandTargets,
    alignment: 'left',
    guide: { orientation: 'horizontal', position: guideHorizontalPx },
  });
  assert.equal(invalidGuideResponse.ok, false);
  const afterInvalidGuide = await source.locator('#guide-anchor').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });
  assert.deepEqual(afterInvalidGuide, beforeInvalidGuide);
  const historyAfterInvalidGuide = (await requestWorkspaceCommand({ action: 'get-state' })).state
    .history.length;
  assert.equal(historyAfterInvalidGuide, historyBeforeInvalidGuide);
  for (const [alignment, edge] of [
    ['top', 'top'],
    ['middle', 'middle'],
    ['bottom', 'bottom'],
  ]) {
    await workspace.locator(`[data-batch-align="${alignment}"]`).click();
    await source.waitForFunction(
      ({ alignment, position }) => {
        const boxes = ['guide-anchor', 'guide-follower'].map((id) =>
          document.querySelector(`#${id}`)?.getBoundingClientRect(),
        );
        if (boxes.some((box) => !box)) return false;
        return boxes.every((box) => {
          const coordinate =
            alignment === 'top'
              ? box.top
              : alignment === 'middle'
                ? box.top + box.height / 2
                : box.bottom;
          return Math.abs(coordinate - position) < 1;
        });
      },
      { alignment: edge, position: guideHorizontalPx },
    );
  }
  const horizontalGuideBeforeScroll = await horizontalGuide.boundingBox();
  assert.ok(horizontalGuideBeforeScroll);
  await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate(() => window.scrollTo(0, 96));
  await workspace.waitForTimeout(50);
  const horizontalGuideAfterScroll = await horizontalGuide.boundingBox();
  assert.ok(horizontalGuideAfterScroll);
  assert.ok(Math.abs(horizontalGuideAfterScroll.y - horizontalGuideBeforeScroll.y + 96) < 2);
  await workspace
    .frameLocator('[data-page-frame]')
    .locator('html')
    .evaluate(() => window.scrollTo(0, 0));
  const stageScrollBefore = await workspace.evaluate(() => {
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="水平"]')
      ?.getBoundingClientRect();
    const topZero = [...document.querySelectorAll('[data-ruler-ticks="top"] .ruler-tick.is-major')]
      .find((tick) => tick.textContent?.trim() === '0')
      ?.getBoundingClientRect();
    const leftZero = [
      ...document.querySelectorAll('[data-ruler-ticks="left"] .ruler-tick.is-major'),
    ]
      .find((tick) => tick.textContent?.trim() === '0')
      ?.getBoundingClientRect();
    if (!frame || !line || !topZero || !leftZero) throw new Error('stage 滚动几何尚未准备完成');
    return {
      lineFrameLeft: line.left - frame.left,
      lineFrameTop: line.top - frame.top,
      lineFrameWidth: line.width - frame.width,
      topZeroLeft: topZero.left,
      leftZeroTop: leftZero.top,
    };
  });
  await workspace.locator('[data-canvas-stage]').evaluate((stage) => {
    stage.scrollLeft = 48;
    stage.scrollTop = 48;
    stage.dispatchEvent(new Event('scroll'));
  });
  await workspace.waitForTimeout(20);
  const stageScrollAfter = await workspace.evaluate(() => {
    const stage = document.querySelector('[data-canvas-stage]');
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const line = document
      .querySelector('[data-guide-id][aria-label^="水平"]')
      ?.getBoundingClientRect();
    const topZero = [...document.querySelectorAll('[data-ruler-ticks="top"] .ruler-tick.is-major')]
      .find((tick) => tick.textContent?.trim() === '0')
      ?.getBoundingClientRect();
    const leftZero = [
      ...document.querySelectorAll('[data-ruler-ticks="left"] .ruler-tick.is-major'),
    ]
      .find((tick) => tick.textContent?.trim() === '0')
      ?.getBoundingClientRect();
    if (!(stage instanceof HTMLElement) || !frame || !line || !topZero || !leftZero)
      throw new Error('stage 滚动后几何尚未准备完成');
    return {
      scrollLeft: stage.scrollLeft,
      scrollTop: stage.scrollTop,
      lineFrameLeft: line.left - frame.left,
      lineFrameTop: line.top - frame.top,
      lineFrameWidth: line.width - frame.width,
      topZeroLeft: topZero.left,
      leftZeroTop: leftZero.top,
    };
  });
  assert.equal(stageScrollAfter.scrollLeft, 48);
  assert.equal(stageScrollAfter.scrollTop, 48);
  assert.ok(Math.abs(stageScrollAfter.lineFrameLeft - stageScrollBefore.lineFrameLeft) < 2);
  assert.ok(Math.abs(stageScrollAfter.lineFrameTop - stageScrollBefore.lineFrameTop) < 2);
  assert.ok(Math.abs(stageScrollAfter.lineFrameWidth - stageScrollBefore.lineFrameWidth) < 2);
  assert.ok(Math.abs(stageScrollAfter.topZeroLeft - stageScrollBefore.topZeroLeft + 48) < 2);
  assert.ok(Math.abs(stageScrollAfter.leftZeroTop - stageScrollBefore.leftZeroTop + 48) < 2);
  await workspace.locator('[data-canvas-stage]').evaluate((stage) => {
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
    stage.dispatchEvent(new Event('scroll'));
  });
  await workspace.waitForTimeout(20);
  await workspace.locator('[data-action="toggle-guides"]').click();
  assert.equal(await workspace.locator('[data-guide-overlay-layer]').isHidden(), true);
  await workspace.locator('[data-action="toggle-guides"]').click();
  assert.equal(await workspace.locator('[data-guide-id]').count(), 2);
  await workspace.locator('[data-action="toggle-guides"]').click();

  await source.evaluate(() => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 36; index += 1) {
      const item = document.createElement('p');
      item.textContent = index === 18 ? '聚焦测试对象' : `对象树测试节点 ${index + 1}`;
      fragment.append(item);
    }
    document.body.append(fragment);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const focusRow = workspace.locator('.tree-row').filter({ hasText: '聚焦测试对象' }).first();
  await focusRow.waitFor();
  await focusRow.click();
  await workspace.locator('[data-object-tree]').evaluate((tree) => (tree.scrollTop = 0));
  const historyCountBeforeTreeFocus = await source
    .locator('#dock-extension-host .history-count')
    .textContent();
  await workspace.locator('[data-action="focus-selection"]').click();
  const treeFocusGeometry = await workspace.evaluate(() => {
    const tree = document.querySelector('[data-object-tree]');
    const selected = document.querySelector('.tree-row.is-primary');
    if (!(tree instanceof HTMLElement) || !(selected instanceof HTMLElement))
      throw new Error('对象树尚未准备完成');
    const treeRect = tree.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    return {
      scrollTop: tree.scrollTop,
      offsetY: selectedRect.top + selectedRect.height / 2 - (treeRect.top + tree.clientHeight / 2),
    };
  });
  assert.ok(treeFocusGeometry.scrollTop > 0);
  assert.ok(Math.abs(treeFocusGeometry.offsetY) < 2);
  assert.equal(
    await source.locator('#dock-extension-host .history-count').textContent(),
    historyCountBeforeTreeFocus,
  );

  // Dense business pages can have more than the initial object-tree budget.
  // A later card still has a canvas marker, so selecting it must bring its
  // property data into the inspector instead of clearing the selection.
  await source.evaluate(() => {
    const denseArea = document.createElement('section');
    denseArea.setAttribute('aria-label', '密集业务区域');
    const cardGroup = document.createElement('div');
    cardGroup.setAttribute('aria-label', '信令卡片组');
    for (let index = 0; index < 640; index += 1) {
      const item = document.createElement('p');
      item.textContent = `密集页面节点 ${index + 1}`;
      cardGroup.append(item);
    }
    const card = document.createElement('article');
    card.id = 'resident-signaling-card';
    card.setAttribute('aria-label', '驻留信令卡片');
    card.innerHTML = '<h2>驻留信令</h2><p>实时监测状态</p>';
    cardGroup.append(card);
    denseArea.append(cardGroup);
    document.body.append(denseArea);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const cardGroupRow = workspace.locator('.tree-row').filter({ hasText: '信令卡片组' }).first();
  await cardGroupRow.locator('[data-toggle-tree]').click();
  const residentCardRow = workspace
    .locator('.tree-row')
    .filter({ hasText: '驻留信令卡片' })
    .first();
  await residentCardRow.waitFor();
  await residentCardRow.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace
    .locator('input[data-style-property="border-radius"][data-range-control="number"]')
    .fill('12');
  await workspace.waitForTimeout(250);
  assert.notEqual(
    await source
      .locator('#resident-signaling-card')
      .evaluate((element) => element.style.borderRadius),
    '12px',
  );
  await workspace
    .locator('input[data-style-property="border-radius"][data-range-control="number"]')
    .press('Tab');
  await source.waitForFunction(
    () => document.querySelector('#resident-signaling-card')?.style.borderRadius === '12px',
  );
  assert.match(
    await workspace.locator('[data-inspector-content]').textContent(),
    /驻留信令|当前对象仅支持整体调整/,
  );

  await source.evaluate(() => {
    const legend = document.createElement('span');
    legend.id = 'underground-total-legend';
    legend.setAttribute('aria-label', '下井总人数');
    legend.innerHTML = '<i aria-hidden="true"></i>下井总人数（人）';
    document.body.append(legend);
  });
  await workspace.locator('[data-action="refresh"]').click();
  await workspace.locator('.tree-row').filter({ hasText: '下井总人数' }).first().click();
  await workspace.locator('textarea[data-text-editor]').fill('下井总人数（人次）');
  await workspace.locator('textarea[data-text-editor]').press('Tab');
  await source.waitForFunction(() => {
    const legend = document.querySelector('#underground-total-legend');
    return (
      legend?.querySelector('i')?.isConnected &&
      [...legend.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent === '下井总人数（人次）',
      )
    );
  });

  await source.evaluate(() => {
    const region = document.createElement('section');
    region.setAttribute('aria-label', '深层选择区域');
    const group = document.createElement('div');
    group.setAttribute('aria-label', '未展开对象组');
    const item = document.createElement('span');
    item.id = 'deep-canvas-selection';
    item.setAttribute('aria-label', '深层状态文本');
    item.textContent = '深层状态文本';
    group.append(item);
    region.append(group);
    document.body.append(region);
  });
  await workspace.locator('[data-action="refresh"]').click();
  await workspace.frameLocator('[data-page-frame]').locator('#deep-canvas-selection').click();
  const deepSelectionRow = workspace
    .locator('.tree-row')
    .filter({ hasText: '深层状态文本' })
    .first();
  await deepSelectionRow.waitFor();
  assert.equal(await deepSelectionRow.getAttribute('aria-selected'), 'true');
  assert.equal(
    await workspace
      .locator('.tree-row')
      .filter({ hasText: '未展开对象组' })
      .first()
      .getAttribute('aria-expanded'),
    'true',
  );

  // Switching from a deep object to a target in another first-level region
  // must keep the canvas, tree, location path, and inspector on the same
  // object. This is the regression that used to leave only the top count.
  await source.evaluate(() => {
    const otherRegion = document.createElement('aside');
    otherRegion.setAttribute('aria-label', '其他业务区域');
    const otherTarget = document.createElement('article');
    otherTarget.id = 'other-region-selection';
    otherTarget.setAttribute('aria-label', '其他区域目标');
    otherTarget.textContent = '其他区域目标';
    otherRegion.append(otherTarget);
    const finalTarget = document.createElement('span');
    finalTarget.id = 'rapid-final-selection';
    finalTarget.setAttribute('aria-label', '快速点击最终目标');
    finalTarget.textContent = '快速点击最终目标';
    otherRegion.append(finalTarget);
    document.body.append(otherRegion);
  });
  await workspace.locator('[data-action="refresh"]').click();
  await workspace.frameLocator('[data-page-frame]').locator('#deep-canvas-selection').click();
  await workspace.frameLocator('[data-page-frame]').locator('#other-region-selection').click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  assert.match(await workspace.locator('[data-tree-location]').textContent(), /其他区域目标/);
  assert.equal(
    await workspace
      .locator('.tree-row')
      .filter({ hasText: '其他区域目标' })
      .first()
      .getAttribute('aria-selected'),
    'true',
  );
  assert.match(await workspace.locator('[data-inspector-content]').textContent(), /其他区域目标/);
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('#other-region-selection')
      .getAttribute('data-dianjing-selected'),
    'true',
  );
  const frame = workspace.frameLocator('[data-page-frame]');
  await Promise.all([
    frame.locator('#deep-canvas-selection').click(),
    frame.locator('#other-region-selection').click(),
    frame.locator('#rapid-final-selection').click(),
  ]);
  await workspace.waitForFunction(() =>
    document.querySelector('[data-tree-location]')?.textContent?.includes('快速点击最终目标'),
  );
  assert.equal(
    await frame.locator('#rapid-final-selection').getAttribute('data-dianjing-selected'),
    'true',
  );

  await source.evaluate(() => {
    const metric = document.createElement('span');
    metric.id = 'transport-runtime-metric';
    metric.setAttribute('aria-label', '运输运行时长指标');
    metric.style.position = 'absolute';
    metric.style.left = '80px';
    metric.style.top = '100px';
    metric.style.display = 'inline-block';
    metric.style.width = '128px';
    metric.style.height = '20px';
    const firstLabel = document.createTextNode('提升运输');
    const secondLabel = document.createTextNode('运行时长');
    const existingTextWrapper = document.createElement('span');
    existingTextWrapper.dataset.dianjingTextFragment = 'true';
    existingTextWrapper.dataset.textFragmentIndex = '0';
    existingTextWrapper.append(firstLabel);
    const value = document.createElement('b');
    value.id = 'transport-runtime-value';
    value.textContent = '+57%';
    value.style.position = 'absolute';
    value.style.left = '0';
    value.style.top = '28px';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.id = 'transport-runtime-icon';
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '24');
    icon.setAttribute('height', '24');
    icon.style.position = 'absolute';
    icon.style.left = '0';
    icon.style.top = '56px';
    icon.innerHTML = '<path d="M12 3v18M5 10h14M5 14h14" stroke="currentColor" fill="none" />';
    const peer = document.createElement('span');
    peer.id = 'transport-runtime-peer';
    peer.textContent = '对齐目标';
    peer.style.position = 'absolute';
    peer.style.left = '260px';
    peer.style.top = '84px';
    peer.style.display = 'inline-block';
    peer.style.width = '72px';
    peer.style.height = '18px';
    metric.append(existingTextWrapper, value, secondLabel, icon, peer);
    document.body.append(metric);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const transportRow = workspace
    .locator('.tree-row')
    .filter({ hasText: '运输运行时长指标' })
    .first();
  await transportRow.waitFor();
  await workspace.frameLocator('[data-page-frame]').locator('#transport-runtime-metric').waitFor();
  const transportToggle = transportRow.locator('[data-toggle-tree]');
  await transportToggle.click();
  await workspace.waitForFunction(() =>
    [...document.querySelectorAll('.tree-row')].some(
      (row) =>
        row.textContent?.includes('运输运行时长指标') &&
        row.getAttribute('aria-expanded') === 'false',
    ),
  );
  assert.equal(await workspace.locator('.tree-row').filter({ hasText: '提升运输' }).count(), 0);
  await transportToggle.click();
  const transportTextRow = workspace
    .locator('.tree-row')
    .filter({ hasText: '提升运输运行时长' })
    .first();
  await workspace.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.tree-row')];
    return (
      rows.filter((row) => row.querySelector('strong')?.textContent === '文本 · 提升运输运行时长')
        .length === 1 &&
      !rows.some((row) => row.querySelector('strong')?.textContent === '文本 · 运行时长')
    );
  });
  await transportTextRow.waitFor();
  assert.equal(await transportTextRow.locator('.tree-icon').textContent(), 'T');
  assert.match(await transportTextRow.locator('small').textContent(), /文本 · #text/);
  assert.equal(await transportTextRow.locator('strong').textContent(), '文本 · 提升运输运行时长');

  await transportRow.click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  const transportOverlayCoverage = await workspace.evaluate(() => {
    const overlay = document
      .querySelector('.selection-overlay.is-primary')
      ?.getBoundingClientRect();
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const zoom = Number.parseFloat(document.querySelector('[data-zoom]')?.textContent ?? '') / 100;
    const value = document
      .querySelector('[data-page-frame]')
      ?.contentDocument?.querySelector('#transport-runtime-value')
      ?.getBoundingClientRect();
    const icon = document
      .querySelector('[data-page-frame]')
      ?.contentDocument?.querySelector('#transport-runtime-icon')
      ?.getBoundingClientRect();
    if (!overlay || !frame || !value || !icon || !Number.isFinite(zoom))
      throw new Error('运输运行时长指标选框尚未准备完成');
    const project = (rect) => ({
      left: frame.left + rect.left * zoom,
      right: frame.left + rect.right * zoom,
      top: frame.top + rect.top * zoom,
      bottom: frame.top + rect.bottom * zoom,
    });
    const projectedValue = project(value);
    const projectedIcon = project(icon);
    return {
      containsValue:
        overlay.left <= projectedValue.left + 1 &&
        overlay.right >= projectedValue.right - 1 &&
        overlay.top <= projectedValue.top + 1 &&
        overlay.bottom >= projectedValue.bottom - 1,
      containsIcon:
        overlay.left <= projectedIcon.left + 1 &&
        overlay.right >= projectedIcon.right - 1 &&
        overlay.top <= projectedIcon.top + 1 &&
        overlay.bottom >= projectedIcon.bottom - 1,
    };
  });
  assert.deepEqual(transportOverlayCoverage, { containsValue: true, containsIcon: true });

  await transportTextRow.click();
  assert.equal(
    await workspace.locator('textarea[data-text-editor]').inputValue(),
    '提升运输运行时长',
  );
  const transportTextOverlayCoverage = await workspace.evaluate(() => {
    const overlay = document
      .querySelector('.selection-overlay.is-primary')
      ?.getBoundingClientRect();
    const frame = document.querySelector('[data-page-frame]')?.getBoundingClientRect();
    const zoom = Number.parseFloat(document.querySelector('[data-zoom]')?.textContent ?? '') / 100;
    const metric = document
      .querySelector('[data-page-frame]')
      ?.contentDocument?.querySelector('#transport-runtime-metric');
    const wrapper = metric?.querySelector('[data-dianjing-text-fragment]');
    const first = wrapper?.firstChild;
    const second = [...(metric?.childNodes ?? [])].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent === '运行时长',
    );
    if (!overlay || !frame || !metric || !first || !second || !Number.isFinite(zoom))
      throw new Error('运输运行时长文字片段选框尚未准备完成');
    const rangeRectsByNode = [first, second].map((node) => {
      const range = metric.ownerDocument.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()];
    });
    const rangeRects = rangeRectsByNode.flat();
    if (!rangeRects.length) throw new Error('运输运行时长原始文字 Range 尚未准备完成');
    const project = (rect) => ({
      left: frame.left + rect.left * zoom,
      right: frame.left + rect.right * zoom,
      top: frame.top + rect.top * zoom,
      bottom: frame.top + rect.bottom * zoom,
    });
    const projected = rangeRects.map(project);
    return {
      firstRangeCount: rangeRectsByNode[0].length,
      secondRangeCount: rangeRectsByNode[1].length,
      containsAll: projected.every(
        (rect) =>
          overlay.left <= rect.left + 1 &&
          overlay.right >= rect.right - 1 &&
          overlay.top <= rect.top + 1 &&
          overlay.bottom >= rect.bottom - 1,
      ),
    };
  });
  assert.equal(transportTextOverlayCoverage.firstRangeCount, 1);
  assert.equal(transportTextOverlayCoverage.secondRangeCount, 1);
  assert.equal(transportTextOverlayCoverage.containsAll, true);
  assert.equal(await source.locator('#dock-extension-host [data-action="copy"]').count(), 0);
  assert.equal(await source.locator('#dock-extension-host [data-action="move-up"]').count(), 0);
  assert.equal(await source.locator('#dock-extension-host [data-action="move-down"]').count(), 0);
  assert.equal(await source.locator('#dock-extension-host [data-action="delete"]').count(), 1);
  const textMoveHandle = workspace.locator(
    '.selection-overlay.is-primary .selection-move-handle--right',
  );
  await textMoveHandle.waitFor({ state: 'attached' });
  const metricGeometryBeforeTextMove = await source
    .locator('#transport-runtime-metric')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    });
  const moveResponse = await workspace.evaluate(() =>
    globalThis.__workspaceBridge({
      type: 'workspace/request',
      sessionId: 'e2e-session',
      command: {
        action: 'move-text',
        target: { fallbackSelector: '#transport-runtime-metric', textNodeIndex: 0 },
        deltaX: 12,
        deltaY: 0,
      },
    }),
  );
  assert.equal(moveResponse.ok, true);
  await workspace.locator('[data-action="refresh"]').click();
  await workspace.waitForFunction(() => {
    const frame = document.querySelector('[data-page-frame]');
    const fragment = frame?.contentDocument?.querySelector('[data-dianjing-text-fragment]');
    return fragment?.style.position === 'relative' && fragment.style.left !== '';
  });
  const independentTextMove = await workspace.evaluate(() => {
    const metric = document
      .querySelector('[data-page-frame]')
      ?.contentDocument?.querySelector('#transport-runtime-metric');
    const fragment = metric?.querySelector('[data-dianjing-text-fragment]');
    const metricRect = metric?.getBoundingClientRect();
    const value = metric?.querySelector('#transport-runtime-value');
    const icon = metric?.querySelector('#transport-runtime-icon');
    return {
      metricGeometry: metricRect
        ? {
            left: metricRect.left,
            top: metricRect.top,
            right: metricRect.right,
            bottom: metricRect.bottom,
            width: metricRect.width,
            height: metricRect.height,
          }
        : null,
      fragmentLeft: fragment?.style.left,
      fragmentText: fragment?.textContent,
      valueParentIsMetric: value?.parentElement === metric,
      iconParentIsMetric: icon?.parentElement === metric,
    };
  });
  assert.ok(independentTextMove.metricGeometry);
  for (const [key, before] of Object.entries(metricGeometryBeforeTextMove))
    assert.ok(Math.abs(independentTextMove.metricGeometry[key] - before) < 0.1, key);
  assert.match(independentTextMove.fragmentLeft ?? '', /^-?\d+px$/);
  assert.notEqual(independentTextMove.fragmentLeft, '0px');
  assert.equal(independentTextMove.fragmentText, '提升运输运行时长');
  assert.equal(independentTextMove.valueParentIsMetric, true);
  assert.equal(independentTextMove.iconParentIsMetric, true);

  await transportTextRow.click();
  await workspace.locator('[data-structure="delete"]').click();
  await workspace.locator('[data-action="workspace-delete-confirm"]').click();
  await workspace.waitForFunction(() => {
    const frame = document.querySelector('[data-page-frame]');
    const metric = frame?.contentDocument?.querySelector('#transport-runtime-metric');
    return Boolean(metric) && !metric.textContent?.includes('运行时长');
  });
  assert.equal(
    await workspace.frameLocator('[data-page-frame]').locator('#transport-runtime-metric').count(),
    1,
  );
  assert.equal(
    await workspace.frameLocator('[data-page-frame]').locator('#transport-runtime-value').count(),
    1,
  );
  assert.equal(
    await workspace.frameLocator('[data-page-frame]').locator('#transport-runtime-icon').count(),
    1,
  );
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('#transport-runtime-metric [data-dianjing-text-fragment]')
      .count(),
    0,
  );
  await workspace.locator('[data-action="undo"]').click();
  await workspace.waitForFunction(() =>
    [...document.querySelectorAll('.tree-row')].some(
      (row) => row.querySelector('strong')?.textContent === '文本 · 提升运输运行时长',
    ),
  );
  assert.equal(
    await workspace
      .frameLocator('[data-page-frame]')
      .locator('#transport-runtime-metric [data-dianjing-text-fragment]')
      .textContent(),
    '提升运输运行时长',
  );
  assert.equal(
    await workspace.frameLocator('[data-page-frame]').locator('#transport-runtime-value').count(),
    1,
  );
  assert.equal(
    await workspace.frameLocator('[data-page-frame]').locator('#transport-runtime-icon').count(),
    1,
  );

  await source.evaluate(() => {
    const owner = document.createElement('section');
    owner.id = 'transport-partial-delete-owner';
    owner.style.position = 'absolute';
    owner.style.left = '80px';
    owner.style.top = '220px';
    owner.style.width = '260px';
    owner.style.height = '50px';
    const wrapper = document.createElement('span');
    wrapper.dataset.dianjingTextFragment = 'true';
    wrapper.dataset.textFragmentIndex = '0';
    wrapper.append(document.createTextNode('部分包装'));
    const value = document.createElement('b');
    value.id = 'transport-partial-delete-value';
    value.textContent = '+57%';
    value.style.position = 'absolute';
    value.style.left = '0';
    value.style.top = '24px';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.id = 'transport-partial-delete-icon';
    icon.setAttribute('width', '16');
    icon.setAttribute('height', '16');
    icon.style.position = 'absolute';
    icon.style.left = '70px';
    icon.style.top = '24px';
    owner.append(wrapper, value, document.createTextNode('外部第二段'), icon);
    document.body.append(owner);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const partialDeleteTarget = {
    fallbackSelector: '#transport-partial-delete-owner',
    textNodeIndex: 0,
  };
  const partialDeleteResponse = await requestWorkspaceCommand({
    action: 'delete',
    target: partialDeleteTarget,
  });
  assert.equal(partialDeleteResponse.ok, true);
  const partialDeleteState = await source.evaluate(() => {
    const owner = document.querySelector('#transport-partial-delete-owner');
    const wrapper = owner?.querySelector('[data-dianjing-text-fragment]');
    return {
      text: owner?.textContent,
      wrapperConnected: Boolean(wrapper?.isConnected),
      valueParentIsOwner:
        owner?.querySelector('#transport-partial-delete-value')?.parentElement === owner,
      iconParentIsOwner:
        owner?.querySelector('#transport-partial-delete-icon')?.parentElement === owner,
    };
  });
  assert.equal(partialDeleteState.text, '+57%');
  assert.equal(partialDeleteState.wrapperConnected, false);
  assert.equal(partialDeleteState.valueParentIsOwner, true);
  assert.equal(partialDeleteState.iconParentIsOwner, true);
  const partialUndoResponse = await requestWorkspaceCommand({ action: 'undo' });
  assert.equal(partialUndoResponse.ok, true);
  const partialUndoState = await source.evaluate(() => {
    const owner = document.querySelector('#transport-partial-delete-owner');
    const wrapper = owner?.querySelector('[data-dianjing-text-fragment]');
    return {
      text: wrapper?.textContent,
      wrapperParentIsOwner: wrapper?.parentElement === owner,
      valueParentIsOwner:
        owner?.querySelector('#transport-partial-delete-value')?.parentElement === owner,
      iconParentIsOwner:
        owner?.querySelector('#transport-partial-delete-icon')?.parentElement === owner,
    };
  });
  assert.equal(partialUndoState.text, '部分包装外部第二段');
  assert.equal(partialUndoState.wrapperParentIsOwner, true);
  assert.equal(partialUndoState.valueParentIsOwner, true);
  assert.equal(partialUndoState.iconParentIsOwner, true);

  await source.evaluate(() => {
    const source = document.createElement('div');
    source.id = 'transport-reparent-source';
    const first = document.createElement('span');
    first.id = 'transport-reparent-first';
    first.textContent = '待移动一';
    const second = document.createElement('span');
    second.id = 'transport-reparent-second';
    second.textContent = '待移动二';
    const sourcePeer = document.createElement('span');
    sourcePeer.id = 'transport-reparent-peer';
    sourcePeer.textContent = '原容器其他对象';
    source.append(first, second, sourcePeer);
    const destination = document.createElement('section');
    destination.id = 'transport-reparent-destination';
    const existing = document.createElement('span');
    existing.id = 'transport-reparent-existing';
    existing.textContent = '目标容器已有对象';
    destination.append(existing);
    document.body.append(source, destination);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const reparentTarget = (id) => ({ fallbackSelector: `#${id}` });
  const reparentResponse = await requestWorkspaceCommand({
    action: 'place-many',
    targets: [
      reparentTarget('transport-reparent-first'),
      reparentTarget('transport-reparent-second'),
    ],
    destination: reparentTarget('transport-reparent-destination'),
    position: 'inside',
  });
  assert.equal(reparentResponse.ok, true);
  assert.deepEqual(
    await source.evaluate(() =>
      [...document.querySelector('#transport-reparent-destination').children].map(
        (element) => element.id,
      ),
    ),
    ['transport-reparent-existing', 'transport-reparent-first', 'transport-reparent-second'],
  );
  const reparentUndo = await requestWorkspaceCommand({ action: 'undo' });
  assert.equal(reparentUndo.ok, true);
  assert.deepEqual(
    await source.evaluate(() =>
      [...document.querySelector('#transport-reparent-source').children].map(
        (element) => element.id,
      ),
    ),
    ['transport-reparent-first', 'transport-reparent-second', 'transport-reparent-peer'],
  );
  const reparentRedo = await requestWorkspaceCommand({ action: 'redo' });
  assert.equal(reparentRedo.ok, true);
  assert.equal(
    await source.evaluate(
      () =>
        document.querySelector('#transport-reparent-first')?.parentElement?.id ===
        'transport-reparent-destination',
    ),
    true,
  );

  const transportTextTarget = {
    fallbackSelector: '#transport-runtime-metric',
    textNodeIndex: 0,
  };
  const transportPeerTarget = { fallbackSelector: '#transport-runtime-peer' };
  const metricGeometryBeforeAlign = await source
    .locator('#transport-runtime-metric')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
  const peerLeftBeforeAlign = await source
    .locator('#transport-runtime-peer')
    .evaluate((element) => element.getBoundingClientRect().left);
  const alignResponse = await requestWorkspaceCommand({
    action: 'align',
    targets: [transportTextTarget, transportPeerTarget],
    alignment: 'left',
  });
  assert.equal(alignResponse.ok, true);
  const mixedAlignGeometry = await source.evaluate(() => {
    const metric = document.querySelector('#transport-runtime-metric');
    const fragment = metric?.querySelector('[data-dianjing-text-fragment]');
    const peer = document.querySelector('#transport-runtime-peer');
    const metricRect = metric?.getBoundingClientRect();
    const fragmentRect = fragment?.getBoundingClientRect();
    const peerRect = peer?.getBoundingClientRect();
    return {
      metric: metricRect
        ? {
            left: metricRect.left,
            top: metricRect.top,
            right: metricRect.right,
            bottom: metricRect.bottom,
          }
        : null,
      fragmentLeft: fragmentRect?.left,
      peerLeft: peerRect?.left,
    };
  });
  assert.deepEqual(mixedAlignGeometry.metric, metricGeometryBeforeAlign);
  assert.notEqual(mixedAlignGeometry.peerLeft, peerLeftBeforeAlign);
  assert.ok(Math.abs(mixedAlignGeometry.peerLeft - mixedAlignGeometry.fragmentLeft) < 1);

  const mixedSelection = await requestWorkspaceCommand({
    action: 'select',
    targets: [transportTextTarget, transportPeerTarget],
  });
  assert.equal(mixedSelection.ok, true);
  await workspace.locator('[data-action="refresh"]').click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 2 个对象',
  );
  assert.equal(await workspace.locator('[data-action="create-group"]').isDisabled(), true);

  const captureTransportStructure = () =>
    source.locator('#transport-runtime-metric').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        html: element.outerHTML,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        children: [...element.childNodes].map((node) =>
          node.nodeType === Node.ELEMENT_NODE
            ? node.id || node.tagName
            : `#text:${node.textContent}`,
        ),
      };
    });
  const invalidTextCommands = [
    {
      name: 'group',
      command: {
        action: 'group',
        targets: [transportTextTarget, transportPeerTarget],
      },
    },
    {
      name: 'duplicate',
      command: { action: 'duplicate', target: transportTextTarget },
    },
    {
      name: 'move',
      command: { action: 'move', target: transportTextTarget, delta: 1 },
    },
    {
      name: 'place-source-text',
      command: {
        action: 'place',
        target: transportTextTarget,
        destination: transportPeerTarget,
        position: 'before',
      },
    },
    {
      name: 'place-destination-text',
      command: {
        action: 'place',
        target: transportPeerTarget,
        destination: transportTextTarget,
        position: 'before',
      },
    },
  ];
  for (const { name, command } of invalidTextCommands) {
    const before = await captureTransportStructure();
    const response = await requestWorkspaceCommand(command);
    assert.equal(response.ok, false, name);
    assert.match(response.error ?? '', /文字对象|文字片段/, name);
    assert.deepEqual(await captureTransportStructure(), before, name);
  }

  await source.evaluate(() => {
    const owner = document.createElement('div');
    owner.id = 'transport-distribute-owner';
    owner.style.position = 'absolute';
    owner.style.left = '80px';
    owner.style.top = '260px';
    owner.style.width = '600px';
    owner.style.height = '80px';
    const label = document.createTextNode('分布文字');
    const first = document.createElement('span');
    first.id = 'transport-distribute-a';
    first.textContent = 'A';
    first.style.position = 'absolute';
    first.style.left = '160px';
    first.style.top = '0';
    first.style.width = '40px';
    first.style.height = '20px';
    const second = document.createElement('span');
    second.id = 'transport-distribute-b';
    second.textContent = 'B';
    second.style.position = 'absolute';
    second.style.left = '300px';
    second.style.top = '0';
    second.style.width = '40px';
    second.style.height = '20px';
    owner.append(label, first, second);
    document.body.append(owner);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const distributeTextTarget = {
    fallbackSelector: '#transport-distribute-owner',
    textNodeIndex: 0,
  };
  const assertLayoutFailureWithoutMaterializing = async (command, errorPattern) => {
    const before = await source
      .locator('#transport-distribute-owner')
      .evaluate((element) => element.outerHTML);
    const response = await requestWorkspaceCommand(command);
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', errorPattern);
    assert.equal(
      await source.locator('#transport-distribute-owner').evaluate((element) => element.outerHTML),
      before,
    );
  };
  await assertLayoutFailureWithoutMaterializing(
    { action: 'align', targets: [distributeTextTarget], alignment: 'left' },
    /至少选择两个对象/,
  );
  await assertLayoutFailureWithoutMaterializing(
    { action: 'size', targets: [distributeTextTarget], dimension: 'both' },
    /至少选择两个对象/,
  );
  await assertLayoutFailureWithoutMaterializing(
    {
      action: 'distribute',
      targets: [distributeTextTarget, { fallbackSelector: '#transport-distribute-a' }],
      direction: 'horizontal',
    },
    /至少选择三个对象/,
  );
  await assertLayoutFailureWithoutMaterializing(
    {
      action: 'gap',
      targets: [distributeTextTarget, { fallbackSelector: '#transport-runtime-peer' }],
      direction: 'horizontal',
      value: 18,
    },
    /同一父容器/,
  );
  const distributeOwnerBefore = await source
    .locator('#transport-distribute-owner')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
  const distributeResponse = await requestWorkspaceCommand({
    action: 'distribute',
    targets: [
      distributeTextTarget,
      { fallbackSelector: '#transport-distribute-a' },
      { fallbackSelector: '#transport-distribute-b' },
    ],
    direction: 'horizontal',
  });
  assert.equal(distributeResponse.ok, true);
  const distributeGeometry = await source.evaluate(() => {
    const owner = document.querySelector('#transport-distribute-owner');
    const text = owner?.querySelector('[data-dianjing-text-fragment]');
    const first = document.querySelector('#transport-distribute-a');
    const second = document.querySelector('#transport-distribute-b');
    const rect = owner?.getBoundingClientRect();
    const targetRects = [text, first, second].map((element) => element?.getBoundingClientRect());
    return {
      owner: rect
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        : null,
      gaps:
        targetRects[0] && targetRects[1] && targetRects[2]
          ? [targetRects[1].left - targetRects[0].right, targetRects[2].left - targetRects[1].right]
          : null,
      text: text?.textContent,
    };
  });
  assert.deepEqual(distributeGeometry.owner, distributeOwnerBefore);
  assert.equal(distributeGeometry.text, '分布文字');
  assert.ok(distributeGeometry.gaps);
  assert.ok(Math.abs(distributeGeometry.gaps[0] - distributeGeometry.gaps[1]) < 1);

  await source.evaluate(() => {
    const owner = document.createElement('div');
    owner.id = 'transport-size-owner';
    owner.style.position = 'absolute';
    owner.style.left = '80px';
    owner.style.top = '380px';
    owner.style.width = '320px';
    owner.style.height = '80px';
    owner.append(document.createTextNode('尺寸文字'));
    const peer = document.createElement('span');
    peer.id = 'transport-size-peer';
    peer.textContent = '尺寸目标';
    peer.style.display = 'inline-block';
    peer.style.width = '140px';
    peer.style.height = '36px';
    owner.append(peer);
    document.body.append(owner);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const sizeResponse = await requestWorkspaceCommand({
    action: 'size',
    targets: [
      { fallbackSelector: '#transport-size-owner', textNodeIndex: 0 },
      { fallbackSelector: '#transport-size-peer' },
    ],
    dimension: 'both',
  });
  assert.equal(sizeResponse.ok, true);
  const sizeGeometry = await source.evaluate(() => {
    const wrapper = document.querySelector('#transport-size-owner [data-dianjing-text-fragment]');
    const peer = document.querySelector('#transport-size-peer');
    const wrapperRect = wrapper?.getBoundingClientRect();
    const peerRect = peer?.getBoundingClientRect();
    return {
      display: wrapper ? getComputedStyle(wrapper).display : '',
      wrapper: wrapperRect ? { width: wrapperRect.width, height: wrapperRect.height } : null,
      peer: peerRect ? { width: peerRect.width, height: peerRect.height } : null,
    };
  });
  assert.equal(sizeGeometry.display, 'inline-block');
  assert.ok(sizeGeometry.wrapper && sizeGeometry.peer);
  assert.ok(Math.abs(sizeGeometry.wrapper.width - sizeGeometry.peer.width) < 1);
  assert.ok(Math.abs(sizeGeometry.wrapper.height - sizeGeometry.peer.height) < 1);

  await source.evaluate(() => {
    const owner = document.createElement('div');
    owner.id = 'transport-gap-owner';
    owner.style.position = 'absolute';
    owner.style.left = '480px';
    owner.style.top = '380px';
    owner.style.width = '320px';
    owner.style.height = '60px';
    owner.append(document.createTextNode('间距文字'));
    const peer = document.createElement('span');
    peer.id = 'transport-gap-peer';
    peer.textContent = '间距目标';
    peer.style.display = 'inline-block';
    peer.style.width = '80px';
    peer.style.height = '24px';
    owner.append(peer);
    document.body.append(owner);
  });
  await workspace.locator('[data-action="refresh"]').click();
  const gapResponse = await requestWorkspaceCommand({
    action: 'gap',
    targets: [
      { fallbackSelector: '#transport-gap-owner', textNodeIndex: 0 },
      { fallbackSelector: '#transport-gap-peer' },
    ],
    direction: 'horizontal',
    value: 18,
  });
  assert.equal(gapResponse.ok, true);
  const gapGeometry = await source.evaluate(() => {
    const owner = document.querySelector('#transport-gap-owner');
    const wrapper = owner?.querySelector('[data-dianjing-text-fragment]');
    const peer = document.querySelector('#transport-gap-peer');
    return {
      display: owner ? getComputedStyle(owner).display : '',
      gap: owner ? getComputedStyle(owner).gap : '',
      wrapperParentIsOwner: wrapper?.parentElement === owner,
      peerParentIsOwner: peer?.parentElement === owner,
      wrapperText: wrapper?.textContent,
    };
  });
  assert.equal(gapGeometry.display, 'flex');
  assert.equal(gapGeometry.gap, '18px');
  assert.equal(gapGeometry.wrapperParentIsOwner, true);
  assert.equal(gapGeometry.peerParentIsOwner, true);
  assert.equal(gapGeometry.wrapperText, '间距文字');

  const pageCountBeforeLocalOpen = context.pages().length;
  const oversizedHtml = `<!doctype html><html><head><title>本地运营页</title><script>window.__unsafeScriptRan=true</script></head><body><main id="local-main"><h1 id="local-title">本地 HTML 已打开</h1><button id="local-action">本地按钮</button></main><!--${'x'.repeat(10 * 1024 * 1024 + 1024)}--></body></html>`;
  await workspace.locator('[data-html-input]').setInputFiles({
    name: '本地运营页.html',
    mimeType: 'text/html',
    buffer: Buffer.from(oversizedHtml),
  });
  await workspace.waitForFunction(
    () => document.querySelector('[data-notice]')?.textContent?.includes('已在当前工作台载入'),
    undefined,
    { timeout: 60_000 },
  );
  assert.equal(context.pages().length, pageCountBeforeLocalOpen);
  assert.equal(await workspace.locator('[data-page-title]').textContent(), '本地运营页');
  assert.equal(
    await workspace.locator('[data-page-url]').textContent(),
    '本地文件 · 本地运营页.html',
  );
  assert.equal(await workspace.locator('[data-change-count]').textContent(), '0');
  const localFrame = workspace.frameLocator('[data-page-frame]');
  await localFrame.locator('#local-title').waitFor({ state: 'visible' });
  assert.equal(await localFrame.locator('#local-title').textContent(), '本地 HTML 已打开');
  assert.equal(
    await localFrame.locator('html').evaluate(() => globalThis.__unsafeScriptRan),
    undefined,
  );
  assert.equal(
    await localFrame.locator('#dock-extension-host').evaluate((element) => element.hidden),
    true,
  );
  await localFrame.locator('#local-title').click();
  await workspace.waitForFunction(
    () => document.querySelector('[data-selection-count]')?.textContent === '已选择 1 个对象',
  );
  await workspace.locator('textarea[data-text-editor]').fill('工作台内切换后的标题');
  await workspace.locator('textarea[data-text-editor]').press('Tab');
  await workspace.waitForFunction(
    () =>
      document
        .querySelector('iframe[data-page-frame]')
        ?.contentDocument?.querySelector('#local-title')?.textContent === '工作台内切换后的标题',
  );
  assert.equal(await localFrame.locator('#local-title').textContent(), '工作台内切换后的标题');
  assert.equal(await workspace.locator('[data-change-count]').textContent(), '1');
  assert.equal(await source.locator('#title').textContent(), '工作台确认后的标题');
  await workspace.screenshot({
    path: path.join(artifactDir, 'workspace-local-html-current-canvas.png'),
    fullPage: false,
  });

  await workspace.goto(
    'http://workspace.test/?entry=blank&reason=当前是空白页，可直接选择本地 HTML 开始编辑。',
  );
  await workspace.addStyleTag({ content: workspaceCss });
  await workspace.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        getURL: (path) => `http://workspace.test/${path}`,
        sendMessage: (message) => globalThis.__workspaceBridge(message),
      },
      permissions: { request: (permission) => globalThis.__workspacePermissionRequest(permission) },
    };
  });
  await workspace.evaluate((script) => globalThis.eval(script), workspaceScript);
  assert.equal(await workspace.locator('[data-page-title]').textContent(), '从一个页面开始');
  assert.match(await workspace.locator('[data-canvas-loading]').textContent(), /选择本地 HTML/);
  assert.equal(await workspace.getByText('无法连接原页面').count(), 0);

  await workspace.goto(
    'http://workspace.test/?entry=file-access&reason=需要开启允许访问文件网址后才能编辑本地 HTML 页面。',
  );
  await workspace.addStyleTag({ content: workspaceCss });
  await workspace.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        getURL: (path) => `http://workspace.test/${path}`,
        sendMessage: (message) => globalThis.__workspaceBridge(message),
      },
      permissions: {
        request: (permission) => globalThis.__workspacePermissionRequest(permission),
      },
    };
  });
  await workspace.evaluate((script) => globalThis.eval(script), workspaceScript);
  assert.equal(await workspace.locator('[data-page-title]').textContent(), '开启本地文件访问');
  assert.equal(await workspace.locator('[data-action="open-file-access-settings"]').count(), 1);
  await workspace.locator('[data-action="open-url"]').click();
  await workspace.locator('[data-open-url-input]').fill('example.com/workspace-entry');
  await workspace.locator('[data-open-url-input]').press('Enter');
  await workspace.waitForURL(/session=url-e2e-session/);
  assert.equal(directUrlRequest, 'https://example.com/workspace-entry');
  assert.deepEqual(requestedOrigins, ['https://example.com/*']);

  console.log(
    'Dock/workspace integration passed: current-canvas local HTML switching, real snapshot selection, source-tab writeback, direct drag with undo/redo, multi-select layout and hover measurement.',
  );
} finally {
  await workspace.close();
  await source.close();
  await context.close();
  await browser.close();
}

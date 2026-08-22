import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const contentScript = fs.readFileSync(
  new URL('../apps/dock-extension/dist/content.js', import.meta.url),
  'utf8',
);

const dom = new JSDOM(
  `<!doctype html>
    <html>
      <head>
        <style>
          .source .action {
            display: inline-flex;
            color: rgb(255, 255, 255);
            background-color: rgb(20, 108, 240);
            border: 2px solid rgb(0, 170, 255);
            padding: 8px 12px;
            border-radius: 8px;
          }
          .destination .action {
            color: rgb(80, 80, 80);
            background-color: rgb(136, 136, 136);
            border: 0;
            padding: 0;
            border-radius: 0;
          }
        </style>
      </head>
      <body>
        <section class="source" id="source">
          <button class="action" id="one">用电量</button>
          <button class="action" id="two">手机信令</button>
        </section>
        <section class="destination" id="destination">
          <div id="existing">目标已有内容</div>
        </section>
      </body>
    </html>`,
  { runScripts: 'outside-only', url: 'https://example.test/' },
);

let listener;
dom.window.chrome = {
  runtime: {
    getURL: (path) => path,
    sendMessage: async () => ({ ok: true }),
    onMessage: {
      addListener(nextListener) {
        listener = nextListener;
      },
    },
  },
};
dom.window.eval(contentScript);
assert.ok(listener, 'content script 应注册工作台消息监听');

const request = (command) =>
  new Promise((resolve) =>
    listener({ type: 'workspace/command', command, sessionId: 'style-regression' }, null, resolve),
  );

const readStyle = (selector) => {
  const element = dom.window.document.querySelector(selector);
  assert.ok(element, `找不到 ${selector}`);
  const computed = dom.window.getComputedStyle(element);
  return {
    color: computed.color,
    background: computed.backgroundColor,
    border: computed.border,
    padding: computed.padding,
    radius: computed.borderRadius,
    parent: element.parentElement?.id,
    inlineStyle: element.getAttribute('style'),
    backgroundPriority: element.style.getPropertyPriority('background-color'),
  };
};

const before = readStyle('#one');
const placed = await request({
  action: 'place-many',
  targets: [{ fallbackSelector: '#one' }, { fallbackSelector: '#two' }],
  destination: { fallbackSelector: '#destination' },
  position: 'inside',
});
assert.equal(placed.ok, true);

const after = readStyle('#one');
assert.deepEqual(
  {
    color: after.color,
    background: after.background,
    border: after.border,
    padding: after.padding,
    radius: after.radius,
  },
  {
    color: before.color,
    background: before.background,
    border: before.border,
    padding: before.padding,
    radius: before.radius,
  },
);
assert.equal(after.parent, 'destination');
assert.equal(after.backgroundPriority, 'important');

const undone = await request({ action: 'undo' });
assert.equal(undone.ok, true);
const afterUndo = readStyle('#one');
assert.equal(afterUndo.parent, 'source');
assert.equal(afterUndo.inlineStyle, null);

const redone = await request({ action: 'redo' });
assert.equal(redone.ok, true);
const afterRedo = readStyle('#one');
assert.equal(afterRedo.parent, 'destination');
assert.equal(afterRedo.background, before.background);
assert.equal(afterRedo.padding, before.padding);

dom.window.close();
console.log('Dock style regression passed');

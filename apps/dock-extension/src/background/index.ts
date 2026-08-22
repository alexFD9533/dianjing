import type { WorkspaceSessionRecord } from '../shared/workspace-protocol';
import { classifyExtensionEntry } from './entry-policy';

const contentFile = 'content.js';
const sessions = new Map<string, WorkspaceSessionRecord>();
const MAX_FULL_PNG_DIMENSION = 32_767;
const MAX_FULL_PNG_PIXELS = 200_000_000;

type PageCaptureMetrics = {
  ready: boolean;
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
};

type PageCaptureSlice = {
  top: number;
  dataUrl: string;
};

const dataUrlFromBlob = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return `data:${blob.type || 'image/png'};base64,${btoa(parts.join(''))}`;
};

const stitchPageCapture = async (metrics: PageCaptureMetrics, slices: PageCaptureSlice[]) => {
  const first = slices[0];
  if (!first) throw new Error('未能获取页面截图');
  const firstBitmap = await createImageBitmap(await (await fetch(first.dataUrl)).blob());
  const scaleX = firstBitmap.width / metrics.viewportWidth;
  const scaleY = firstBitmap.height / metrics.viewportHeight;
  const outputWidth = Math.round(metrics.viewportWidth * scaleX);
  const outputHeight = Math.round(metrics.scrollHeight * scaleY);
  if (
    outputWidth > MAX_FULL_PNG_DIMENSION ||
    outputHeight > MAX_FULL_PNG_DIMENSION ||
    outputWidth * outputHeight > MAX_FULL_PNG_PIXELS
  ) {
    firstBitmap.close();
    throw new Error('页面过长，浏览器无法合成为单张 PNG；请改用离线 HTML 导出');
  }
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d');
  if (!context) {
    firstBitmap.close();
    throw new Error('浏览器无法创建整页 PNG 画布');
  }
  context.drawImage(firstBitmap, 0, Math.round(first.top * scaleY));
  firstBitmap.close();
  for (const slice of slices.slice(1)) {
    const bitmap = await createImageBitmap(await (await fetch(slice.dataUrl)).blob());
    context.drawImage(bitmap, 0, Math.round(slice.top * scaleY));
    bitmap.close();
  }
  return dataUrlFromBlob(await canvas.convertToBlob({ type: 'image/png' }));
};

const fileAccessEnabled = () =>
  new Promise<boolean>((resolve) => chrome.extension.isAllowedFileSchemeAccess(resolve));

const setFeedback = async (tabId: number, text: string, title: string) => {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b42318' });
  await chrome.action.setTitle({ tabId, title });
};

const clearFeedback = async (tabId: number) => {
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: '打开点睛' });
};

const ensureContent = async (tabId: number) => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'dock/ping' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: [contentFile] });
  }
};

const waitForTabComplete = async (tabId: number) => {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return current;
  return new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const cleanUp = () => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      chrome.tabs.onRemoved.removeListener(handleRemoved);
    };
    const handleUpdated = (
      updatedTabId: number,
      changeInfo: { status?: string },
      tab: chrome.tabs.Tab,
    ) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      cleanUp();
      resolve(tab);
    };
    const handleRemoved = (removedTabId: number) => {
      if (removedTabId !== tabId) return;
      cleanUp();
      reject(new Error('目标页面在载入完成前已关闭'));
    };
    chrome.tabs.onUpdated.addListener(handleUpdated);
    chrome.tabs.onRemoved.addListener(handleRemoved);
  });
};

const clearWorkspaceSession = async (workspaceTabId: number) => {
  const staleSessionIds = [...sessions.values()]
    .filter((session) => session.workspaceTabId === workspaceTabId)
    .map((session) => session.sessionId);
  staleSessionIds.forEach((sessionId) => sessions.delete(sessionId));
  if (staleSessionIds.length) await chrome.storage.session?.remove(staleSessionIds.map(sessionKey));
};

const canonicalHttpUrl = (value: string | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

const findReusableSourceTab = async (options: {
  targetUrl: string;
  workspaceTabId: number;
  preferredSourceTabId?: number;
  workspaceWindowId?: number;
}) => {
  const tabs = await chrome.tabs.query({});
  const preferred = options.preferredSourceTabId
    ? tabs.find((tab) => tab.id === options.preferredSourceTabId)
    : undefined;
  const sameWindow = tabs.filter(
    (tab) => tab.windowId === options.workspaceWindowId && tab !== preferred,
  );
  const candidates = [preferred, ...sameWindow, ...tabs.filter((tab) => tab !== preferred)];
  const targetUrl = canonicalHttpUrl(options.targetUrl);
  if (!targetUrl) return undefined;
  return candidates.find(
    (tab) =>
      tab?.id !== undefined &&
      tab.id !== options.workspaceTabId &&
      canonicalHttpUrl(tab.url) === targetUrl,
  );
};

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (!tab.id) return;
    const entry = classifyExtensionEntry(tab.url, await fileAccessEnabled());
    if (entry.kind === 'workspace') {
      const params = new URLSearchParams({ entry: entry.entry, reason: entry.reason });
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`workspace.html?${params}`),
        active: true,
      });
      await clearFeedback(tab.id);
      return;
    }

    try {
      await ensureContent(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'dock/toggle', mode: entry.mode });
      await clearFeedback(tab.id);
    } catch {
      await setFeedback(tab.id, '!', '点睛：当前页面无法注入，请检查文件网址权限。');
    }
  })();
});

const sessionKey = (sessionId: string) => `workspace-session:${sessionId}`;

const saveSession = async (session: WorkspaceSessionRecord) => {
  sessions.set(session.sessionId, session);
  await chrome.storage.session?.set({ [sessionKey(session.sessionId)]: session });
};

const loadSession = async (sessionId: string) => {
  const memory = sessions.get(sessionId);
  if (memory) return memory;
  const stored = await chrome.storage.session?.get(sessionKey(sessionId));
  const session = stored?.[sessionKey(sessionId)] as WorkspaceSessionRecord | undefined;
  if (session) sessions.set(sessionId, session);
  return session;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'extension/open-file-access-settings') {
    void chrome.tabs
      .create({ url: `chrome://extensions/?id=${chrome.runtime.id}`, active: true })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '无法打开扩展设置',
        }),
      );
    return true;
  }

  if (message?.type === 'workspace/open-local-html') {
    void (async () => {
      const key = typeof message.key === 'string' ? message.key : '';
      if (!/^local-html:[0-9a-f-]{36}$/i.test(key))
        throw new Error('本地文件会话无效，请重新选择 HTML');
      const tab = await chrome.tabs.create({
        url: chrome.runtime.getURL(`local-preview.html?key=${encodeURIComponent(key)}`),
        active: true,
      });
      sendResponse({ ok: true, tabId: tab.id });
    })().catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '本地 HTML 打开失败',
      }),
    );
    return true;
  }

  if (message?.type === 'workspace/open-url') {
    void (async () => {
      const workspaceTabId = sender.tab?.id;
      if (!workspaceTabId) throw new Error('无法识别当前工作台');
      const rawUrl = typeof message.url === 'string' ? message.url.trim() : '';
      let sourceUrl: URL;
      try {
        sourceUrl = new URL(rawUrl);
      } catch {
        throw new Error('请输入完整的 http:// 或 https:// 页面地址');
      }
      if (!['http:', 'https:'].includes(sourceUrl.protocol))
        throw new Error('目前仅支持打开 http:// 或 https:// 页面地址');
      const permissionOrigin = `${sourceUrl.protocol}//${sourceUrl.hostname}/*`;
      if (!(await chrome.permissions.contains({ origins: [permissionOrigin] })))
        throw new Error('尚未获得该站点的访问授权，请重新确认授权后再试');

      const currentSession =
        typeof message.sessionId === 'string' && message.sessionId
          ? await loadSession(message.sessionId)
          : undefined;
      const reusableTab = await findReusableSourceTab({
        targetUrl: sourceUrl.href,
        workspaceTabId,
        preferredSourceTabId: currentSession?.sourceTabId,
        workspaceWindowId: sender.tab?.windowId,
      });
      let sourceTab = reusableTab;
      let createdSourceTabId: number | undefined;
      try {
        if (!sourceTab) {
          sourceTab = await chrome.tabs.create({ url: sourceUrl.href, active: false });
          createdSourceTabId = sourceTab.id;
        }
        if (!sourceTab.id) throw new Error('无法打开目标页面');
        const loadedTab = await waitForTabComplete(sourceTab.id);
        await ensureContent(sourceTab.id);
        const sourceEntry = classifyExtensionEntry(loadedTab.url ?? sourceUrl.href, true);
        if (sourceEntry.kind !== 'inject')
          throw new Error('该链接受浏览器保护，暂不支持直接进入工作台');

        const loadedUrl = loadedTab.url ?? sourceUrl.href;
        if (
          currentSession?.workspaceTabId === workspaceTabId &&
          currentSession.sourceTabId === sourceTab.id &&
          canonicalHttpUrl(currentSession.sourceUrl) === canonicalHttpUrl(loadedUrl)
        ) {
          sendResponse({ ok: true, sessionId: currentSession.sessionId });
          return;
        }

        const sessionId = crypto.randomUUID();
        await clearWorkspaceSession(workspaceTabId);
        await saveSession({
          sessionId,
          sourceTabId: sourceTab.id,
          workspaceTabId,
          sourceUrl: loadedUrl,
          sourceTitle: loadedTab.title ?? sourceUrl.hostname,
          sourceMode: sourceEntry.mode === 'web-copy' ? 'web-copy' : 'local-page',
          createdAt: new Date().toISOString(),
        });
        sendResponse({ ok: true, sessionId });
      } catch (error) {
        if (createdSourceTabId !== undefined)
          await chrome.tabs.remove(createdSourceTabId).catch(() => undefined);
        throw error;
      }
    })().catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '打开链接失败' }),
    );
    return true;
  }

  if (message?.type === 'workspace/open') {
    void (async () => {
      const sourceTabId = sender.tab?.id;
      if (!sourceTabId) throw new Error('无法识别工作台来源标签页');
      const existing = [...sessions.values()].find((item) => item.sourceTabId === sourceTabId);
      if (existing?.workspaceTabId) {
        try {
          await chrome.tabs.update(existing.workspaceTabId, { active: true });
          await chrome.windows.update(sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
            focused: true,
          });
          sendResponse({ ok: true, sessionId: existing.sessionId });
          return;
        } catch {
          sessions.delete(existing.sessionId);
        }
      }

      const sessionId = crypto.randomUUID();
      const sourceEntry = classifyExtensionEntry(sender.tab?.url, true);
      const session: WorkspaceSessionRecord = {
        sessionId,
        sourceTabId,
        sourceUrl: sender.tab?.url ?? '',
        sourceTitle: sender.tab?.title ?? '未命名页面',
        sourceMode:
          message.mode === 'web-copy' ||
          (sourceEntry.kind === 'inject' && sourceEntry.mode === 'web-copy')
            ? 'web-copy'
            : 'local-page',
        createdAt: new Date().toISOString(),
      };
      const workspaceTab = await chrome.tabs.create({
        url: chrome.runtime.getURL(`workspace.html?session=${encodeURIComponent(sessionId)}`),
        active: true,
      });
      await saveSession({ ...session, workspaceTabId: workspaceTab.id });
      sendResponse({ ok: true, sessionId });
    })().catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '工作台打开失败' }),
    );
    return true;
  }

  if (message?.type === 'workspace/capture-visible') {
    void (async () => {
      const session =
        typeof message.sessionId === 'string' && message.sessionId
          ? await loadSession(message.sessionId)
          : undefined;
      const sourceTabId = session?.sourceTabId ?? sender.tab?.id;
      if (!sourceTabId) throw new Error('当前工作台没有可截图的原页面');
      const sourceTab = await chrome.tabs.get(sourceTabId);
      if (!sourceTab.windowId) throw new Error('无法识别原页面窗口');
      const returnTabId = session?.workspaceTabId;
      await ensureContent(sourceTabId);
      let prepared = false;
      let dataUrl = '';
      try {
        const metrics = (await chrome.tabs.sendMessage(sourceTabId, {
          type: 'dock/capture-prepare',
        })) as PageCaptureMetrics;
        if (!metrics?.ready || !metrics.viewportHeight || !metrics.viewportWidth)
          throw new Error('无法读取页面尺寸');
        prepared = true;
        await chrome.tabs.update(sourceTabId, { active: true });
        await chrome.windows.update(sourceTab.windowId, { focused: true });
        const maxTop = Math.max(0, metrics.scrollHeight - metrics.viewportHeight);
        const slices: PageCaptureSlice[] = [];
        let nextTop = 0;
        while (true) {
          const position = (await chrome.tabs.sendMessage(sourceTabId, {
            type: 'dock/capture-scroll',
            top: nextTop,
          })) as { top?: number };
          const top = Math.max(0, Number(position?.top) || 0);
          slices.push({
            top,
            dataUrl: await chrome.tabs.captureVisibleTab(sourceTab.windowId, { format: 'png' }),
          });
          if (top >= maxTop) break;
          const followingTop = Math.min(maxTop, top + metrics.viewportHeight);
          if (followingTop <= top) throw new Error('页面无法继续滚动，整页 PNG 未生成');
          nextTop = followingTop;
        }
        dataUrl = await stitchPageCapture(metrics, slices);
      } finally {
        if (prepared) {
          await chrome.tabs
            .sendMessage(sourceTabId, { type: 'dock/capture-restore' })
            .catch(() => undefined);
        }
        if (returnTabId)
          await chrome.tabs.update(returnTabId, { active: true }).catch(() => undefined);
      }
      sendResponse({ ok: true, dataUrl, title: sourceTab.title ?? '页面' });
    })().catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '当前视口截图失败',
      }),
    );
    return true;
  }

  if (message?.type === 'workspace/request' && typeof message.sessionId === 'string') {
    void (async () => {
      const session = await loadSession(message.sessionId);
      if (!session) throw new Error('工作台会话已失效，请从原页面重新进入');
      const response = await chrome.tabs.sendMessage(session.sourceTabId, {
        type: 'workspace/command',
        command: message.command,
        sessionId: session.sessionId,
      });
      sendResponse({ ...response, session: { ...session } });
    })().catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '原页面连接失败' }),
    );
    return true;
  }

  if (message?.type === 'workspace/export-progress' && typeof message.sessionId === 'string') {
    void (async () => {
      const session = await loadSession(message.sessionId);
      if (!session?.workspaceTabId) return;
      await chrome.tabs
        .sendMessage(session.workspaceTabId, {
          type: 'workspace/export-progress',
          sessionId: session.sessionId,
          progress: message.progress,
        })
        .catch(() => undefined);
    })();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'workspace/focus-source' && typeof message.sessionId === 'string') {
    void (async () => {
      const session = await loadSession(message.sessionId);
      if (!session) throw new Error('工作台会话已失效');
      await chrome.tabs.update(session.sourceTabId, { active: true });
      sendResponse({ ok: true });
    })().catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '无法返回原页面' }),
    );
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionId, session] of sessions) {
    if (session.sourceTabId === tabId || session.workspaceTabId === tabId) {
      sessions.delete(sessionId);
      void chrome.storage.session?.remove(sessionKey(sessionId));
    }
  }
});

export type ExtensionEntry =
  | { kind: 'inject'; mode: 'local-page' | 'web-copy' }
  | { kind: 'workspace'; entry: 'blank' | 'file-access' | 'restricted'; reason: string };

const INTERNAL_PROTOCOLS = /^(chrome|edge|devtools|view-source|moz-extension|chrome-extension):$/i;
const WEB_STORE_HOSTS = new Set(['chromewebstore.google.com', 'microsoftedge.microsoft.com']);

export const classifyExtensionEntry = (
  rawUrl: string | undefined,
  fileAccess: boolean,
): ExtensionEntry => {
  if (!rawUrl || rawUrl === 'about:blank' || rawUrl === 'about:newtab') {
    return {
      kind: 'workspace',
      entry: 'blank',
      reason: '当前是空白页，可直接选择本地 HTML 开始编辑。',
    };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: 'workspace', entry: 'restricted', reason: '无法识别当前页面地址。' };
  }

  if (url.protocol === 'about:') {
    return { kind: 'workspace', entry: 'restricted', reason: '浏览器内部页面不允许注入。' };
  }
  if (INTERNAL_PROTOCOLS.test(url.protocol) || WEB_STORE_HOSTS.has(url.hostname)) {
    return {
      kind: 'workspace',
      entry: 'restricted',
      reason: WEB_STORE_HOSTS.has(url.hostname)
        ? '浏览器扩展商店受浏览器保护，不能在页面内运行点睛。'
        : '浏览器内部页面受保护，不能在页面内运行点睛。',
    };
  }
  if (url.protocol === 'file:') {
    return fileAccess
      ? { kind: 'inject', mode: 'local-page' }
      : {
          kind: 'workspace',
          entry: 'file-access',
          reason: '需要开启“允许访问文件网址”后才能编辑本地 HTML 页面。',
        };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return {
      kind: 'inject',
      mode: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'local-page' : 'web-copy',
    };
  }
  return { kind: 'workspace', entry: 'restricted', reason: '当前页面类型暂不支持编辑。' };
};

import { getLocalHtmlFile } from '../shared/local-html-store';

const key = new URLSearchParams(location.search).get('key') ?? '';

const showError = (message: string) => {
  document.body.innerHTML = `<main style="max-width:680px;margin:80px auto;padding:24px;font:14px/1.7 system-ui,sans-serif;color:#263b52"><h1 style="font-size:20px">无法打开本地 HTML</h1><p>${message}</p></main>`;
};

const openLocalHtml = async () => {
  if (!key) return showError('缺少本地文件会话，请从点睛工作台重新选择 HTML。');
  const record = await getLocalHtmlFile(key);
  if (!record?.blob) return showError('本地文件会话已失效，请从点睛工作台重新选择 HTML。');
  const html = await record.blob.text();

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script,noscript').forEach((element) => element.remove());
  parsed
    .querySelectorAll('meta[http-equiv="content-security-policy"],meta[http-equiv="refresh"]')
    .forEach((element) => element.remove());
  parsed.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name);
    }
  });

  document.documentElement.lang = parsed.documentElement.lang || 'zh-CN';
  document.documentElement.dataset.dianjingLocalPreview = 'true';
  document.head.replaceChildren(
    ...[...parsed.head.childNodes].map((node) => document.importNode(node, true)),
  );
  document.body.replaceChildren(
    ...[...parsed.body.childNodes].map((node) => document.importNode(node, true)),
  );
  document.title = parsed.title || record.name.replace(/\.html?$/i, '');

  const bootstrap = document.createElement('script');
  bootstrap.src = chrome.runtime.getURL('content.js');
  bootstrap.dataset.dianjingBootstrap = 'true';
  bootstrap.addEventListener('error', () =>
    showError('点睛编辑器加载失败，请重新加载扩展后重试。'),
  );
  document.body.append(bootstrap);
};

void openLocalHtml().catch(() => showError('本地 HTML 解析失败，请确认文件内容有效。'));

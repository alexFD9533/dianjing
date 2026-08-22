const executableUrlAttributes = ['href', 'src', 'xlink:href', 'formaction'];

export const prepareLocalHtmlDocument = (html: string, fileName: string) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script,noscript').forEach((element) => element.remove());
  parsed
    .querySelectorAll('meta[http-equiv="content-security-policy"],meta[http-equiv="refresh"]')
    .forEach((element) => element.remove());
  parsed.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
    }
    for (const attribute of executableUrlAttributes) {
      if (/^\s*javascript:/i.test(element.getAttribute(attribute) ?? ''))
        element.removeAttribute(attribute);
    }
    element.removeAttribute('autofocus');
    element.removeAttribute('contenteditable');
    if (element instanceof HTMLIFrameElement) {
      element.setAttribute('sandbox', '');
      element.removeAttribute('srcdoc');
    }
  });
  parsed.documentElement.lang ||= 'zh-CN';
  parsed.documentElement.dataset.dianjingWorkspaceSource = 'true';
  parsed.title ||= fileName.replace(/\.html?$/i, '') || '本地 HTML';
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
};

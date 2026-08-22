import type { WorkspaceExportProgress } from '../shared/workspace-protocol';

type OfflineSnapshotOptions = {
  sourceUrl: string;
  prepareClone?: (clone: HTMLElement) => void;
  onProgress?: (progress: WorkspaceExportProgress) => void;
};

type OfflineSnapshot = {
  html: string;
  failures: string[];
  warnings: string[];
};

const resourceAttributes = ['src', 'href', 'xlink:href'] as const;
const resourceSelector = [
  'img[src]',
  'input[type="image"][src]',
  'picture source[src]',
  'image[href]',
  'image[xlink\\:href]',
  'use[href]',
  'use[xlink\\:href]',
  'link[rel~="icon"][href]',
].join(',');

const RESOURCE_TIMEOUT_MS = 15_000;
const RESOURCE_CONCURRENCY = 6;
const transparentImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

type PendingResourceTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const pendingResourceTasks: PendingResourceTask<unknown>[] = [];
let activeResourceTasks = 0;

const runWithResourceLimit = <T>(task: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    pendingResourceTasks.push({
      run: task,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    const next = () => {
      while (activeResourceTasks < RESOURCE_CONCURRENCY && pendingResourceTasks.length) {
        const pending = pendingResourceTasks.shift();
        if (!pending) return;
        activeResourceTasks += 1;
        void pending
          .run()
          .then(pending.resolve, pending.reject)
          .finally(() => {
            activeResourceTasks -= 1;
            next();
          });
      }
    };
    next();
  });

const fetchResource = async (url: string) =>
  runWithResourceLimit(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(`读取超时（${RESOURCE_TIMEOUT_MS / 1000} 秒）`);
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  });

const safeResourceUrl = (value: string) => {
  const trimmed = value.trim();
  return Boolean(trimmed) && !/^(?:data:|blob:|about:|#)/i.test(trimmed);
};

const base64From = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(parts.join(''));
};

const replaceAsync = async (
  value: string,
  expression: RegExp,
  replacer: (...args: string[]) => Promise<string>,
) => {
  const matches = [...value.matchAll(expression)];
  if (!matches.length) return value;
  const replacements = await Promise.all(
    matches.map((match) => replacer(match[0], ...match.slice(1).map((part) => part ?? ''))),
  );
  let cursor = 0;
  return (
    matches
      .map((match, index) => {
        const start = match.index ?? 0;
        const unchanged = value.slice(cursor, start);
        cursor = start + match[0].length;
        return `${unchanged}${replacements[index]}`;
      })
      .join('') + value.slice(cursor)
  );
};

export const createOfflineHtmlSnapshot = async (
  sourceDocument: Document,
  { sourceUrl, prepareClone, onProgress = () => undefined }: OfflineSnapshotOptions,
): Promise<OfflineSnapshot> => {
  const clone = sourceDocument.documentElement.cloneNode(true) as HTMLElement;
  prepareClone?.(clone);

  const failures: string[] = [];
  const warnings: string[] = [];
  const resourceCache = new Map<string, Promise<string>>();
  const cssCache = new Map<string, Promise<string>>();
  const sourceCanvases = [...sourceDocument.querySelectorAll('canvas')];
  const cloneCanvases = [...clone.querySelectorAll('canvas')];
  const sourceStyles = [...sourceDocument.querySelectorAll('style')];
  const cloneStyles = [...clone.querySelectorAll('style')];
  const sourceLinks = [
    ...sourceDocument.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'),
  ];
  const cloneLinks = [...clone.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')];
  const scannedResources = [...clone.querySelectorAll<HTMLElement>(resourceSelector)].reduce(
    (count, element) =>
      count + resourceAttributes.filter((attribute) => element.hasAttribute(attribute)).length,
    0,
  );
  onProgress({
    stage: 'scan',
    completed: 1,
    total: 1,
    label: `已识别 ${sourceLinks.length} 份样式、${scannedResources} 项页面资源和 ${sourceCanvases.length} 个画布`,
  });
  let completedResources = 0;
  let totalResources = 0;
  let completedStyles = 0;
  const totalStyles = sourceStyles.length + sourceLinks.length;

  const toDataUrl = async (resource: string, baseUrl: string) => {
    if (!safeResourceUrl(resource)) return resource;
    const resolvedUrl = new URL(resource, baseUrl).href;
    const cached = resourceCache.get(resolvedUrl);
    if (cached) return cached;
    totalResources += 1;
    onProgress({
      stage: 'resources',
      completed: completedResources,
      total: totalResources,
      label: '正在读取页面资源',
    });
    const task = (async () => {
      try {
        const response = await fetchResource(resolvedUrl);
        const blob = await response.blob();
        const contentType =
          blob.type || response.headers.get('content-type') || 'application/octet-stream';
        return `data:${contentType.split(';')[0]};base64,${base64From(await blob.arrayBuffer())}`;
      } finally {
        completedResources += 1;
        onProgress({
          stage: 'resources',
          completed: completedResources,
          total: totalResources,
          label: '正在读取页面资源',
        });
      }
    })();
    resourceCache.set(resolvedUrl, task);
    return task;
  };

  const inlineCss = async (cssText: string, baseUrl: string): Promise<string> => {
    const withImports = await replaceAsync(
      cssText,
      /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^\s;)]+))\s*\)?\s*([^;]*);/gi,
      async (whole, _quote, quotedUrl, unquotedUrl, media) => {
        const resource = quotedUrl || unquotedUrl;
        if (!safeResourceUrl(resource)) return whole;
        try {
          const resolvedUrl = new URL(resource, baseUrl).href;
          let cached = cssCache.get(resolvedUrl);
          if (!cached) {
            cached = fetchResource(resolvedUrl)
              .then((response) => response.text())
              .then((text) => inlineCss(text, resolvedUrl));
            cssCache.set(resolvedUrl, cached);
          }
          const imported = await cached;
          return media.trim() ? `@media ${media.trim()}{${imported}}` : imported;
        } catch (error) {
          failures.push(
            `样式表 ${resource}：${error instanceof Error ? error.message : '无法读取'}`,
          );
          return whole;
        }
      },
    );
    return replaceAsync(
      withImports,
      /url\(\s*(?:(["'])(.*?)\1|([^\s'")]+))\s*\)/gi,
      async (whole, _quote, quotedUrl, unquotedUrl) => {
        const resource = quotedUrl || unquotedUrl;
        if (!safeResourceUrl(resource)) return whole;
        try {
          return `url("${await toDataUrl(resource, baseUrl)}")`;
        } catch (error) {
          const message = error instanceof Error ? error.message : '无法读取';
          if (message === 'HTTP 404') {
            warnings.push(`样式资源 ${resource}：原网页未提供（HTTP 404）`);
            return `url("${transparentImage}")`;
          }
          failures.push(`样式资源 ${resource}：${message}`);
          return whole;
        }
      },
    );
  };

  sourceCanvases.forEach((canvas, index) => {
    const copy = cloneCanvases[index];
    if (!copy) return;
    try {
      const image = clone.ownerDocument.createElement('img');
      for (const attribute of [...copy.attributes])
        image.setAttribute(attribute.name, attribute.value);
      image.src = canvas.toDataURL('image/png');
      image.setAttribute('data-dianjing-canvas-snapshot', 'true');
      copy.replaceWith(image);
    } catch (error) {
      failures.push(
        `图表画布 ${index + 1}：${error instanceof Error ? error.message : '无法定格'}`,
      );
    }
    onProgress({
      stage: 'canvas',
      completed: index + 1,
      total: sourceCanvases.length,
      label: '正在定格图表画面',
    });
  });
  if (!sourceCanvases.length)
    onProgress({ stage: 'canvas', completed: 0, total: 0, label: '页面没有需要定格的图表画布' });

  const sourceControls = [...sourceDocument.querySelectorAll('input,textarea,select')];
  const cloneControls = [...clone.querySelectorAll('input,textarea,select')];
  sourceControls.forEach((control, index) => {
    const copy = cloneControls[index];
    if (!copy) return;
    if (control instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      copy.setAttribute('value', control.value);
      copy.toggleAttribute('checked', control.checked);
    }
    if (control instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement)
      copy.textContent = control.value;
    if (control instanceof HTMLSelectElement && copy instanceof HTMLSelectElement)
      [...copy.options].forEach((option, optionIndex) =>
        option.toggleAttribute('selected', control.options[optionIndex]?.selected ?? false),
      );
  });

  clone.querySelectorAll('audio,video,object').forEach((element) => element.remove());

  await Promise.all(
    [...clone.querySelectorAll<HTMLElement>(resourceSelector)].flatMap((element) =>
      resourceAttributes
        .filter((attribute) => element.hasAttribute(attribute))
        .map(async (attribute) => {
          const value = element.getAttribute(attribute) ?? '';
          if (!safeResourceUrl(value)) return;
          try {
            element.setAttribute(attribute, await toDataUrl(value, sourceUrl));
          } catch (error) {
            failures.push(
              `页面资源 ${value}：${error instanceof Error ? error.message : '无法读取'}`,
            );
          }
        }),
    ),
  );

  await Promise.all(
    [...clone.querySelectorAll<HTMLElement>('[style]')].map(async (element) => {
      element.setAttribute(
        'style',
        await inlineCss(element.getAttribute('style') ?? '', sourceUrl),
      );
    }),
  );

  await Promise.all(
    cloneStyles.map(async (style, index) => {
      style.textContent = await inlineCss(
        sourceStyles[index]?.textContent ?? style.textContent ?? '',
        sourceUrl,
      );
      completedStyles += 1;
      onProgress({
        stage: 'styles',
        completed: completedStyles,
        total: totalStyles,
        label: '正在内嵌页面样式',
      });
    }),
  );

  await Promise.all(
    cloneLinks.map(async (link, index) => {
      const sourceLink = sourceLinks[index];
      if (!sourceLink) return;
      try {
        const response = await fetchResource(sourceLink.href);
        const style = clone.ownerDocument.createElement('style');
        style.setAttribute('data-dianjing-offline-stylesheet', 'true');
        style.textContent = await inlineCss(await response.text(), sourceLink.href);
        link.replaceWith(style);
      } catch (error) {
        failures.push(
          `样式表 ${sourceLink.href}：${error instanceof Error ? error.message : '无法读取'}`,
        );
      } finally {
        completedStyles += 1;
        onProgress({
          stage: 'styles',
          completed: completedStyles,
          total: totalStyles,
          label: '正在内嵌页面样式',
        });
      }
    }),
  );

  clone
    .querySelectorAll('script,noscript,link[rel~="preload"][as="script"]')
    .forEach((element) => element.remove());
  clone
    .querySelectorAll('meta[http-equiv="content-security-policy"],meta[http-equiv="refresh"]')
    .forEach((element) => element.remove());
  onProgress({ stage: 'finalize', completed: 1, total: 1, label: '正在生成离线 HTML 文件' });
  return {
    html: `<!doctype html>\n${clone.outerHTML}`,
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)],
  };
};

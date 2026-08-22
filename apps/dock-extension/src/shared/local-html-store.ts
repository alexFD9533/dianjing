const databaseName = 'dianjing-local-html';
const storeName = 'files';
const databaseVersion = 1;
const retentionMs = 24 * 60 * 60 * 1000;

const createUuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export type LocalHtmlFileRecord = {
  key: string;
  name: string;
  blob: Blob;
  size: number;
  type: string;
  openedAt: string;
};

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('本地文件存储失败')),
      {
        once: true,
      },
    );
  });

const transactionComplete = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('本地文件存储事务已中止')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('本地文件存储事务失败')),
      { once: true },
    );
  });

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.addEventListener(
      'upgradeneeded',
      () => {
        if (!request.result.objectStoreNames.contains(storeName))
          request.result.createObjectStore(storeName, { keyPath: 'key' });
      },
      { once: true },
    );
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('无法初始化本地文件存储')),
      { once: true },
    );
    request.addEventListener(
      'blocked',
      () => reject(new Error('本地文件存储正在升级，请关闭旧的点睛页面后重试')),
      { once: true },
    );
  });

const withDatabase = async <T>(run: (database: IDBDatabase) => Promise<T>) => {
  const database = await openDatabase();
  try {
    return await run(database);
  } finally {
    database.close();
  }
};

const pruneExpiredRecords = (store: IDBObjectStore, now: number) => {
  const cursor = store.openCursor();
  cursor.addEventListener('success', () => {
    const current = cursor.result;
    if (!current) return;
    const record = current.value as Partial<LocalHtmlFileRecord>;
    const openedAt = Date.parse(record.openedAt ?? '');
    if (!Number.isFinite(openedAt) || now - openedAt > retentionMs) current.delete();
    current.continue();
  });
};

export const storeLocalHtmlFile = async (file: File) => {
  const key = `local-html:${createUuid()}`;
  const record: LocalHtmlFileRecord = {
    key,
    name: file.name,
    blob: file.slice(0, file.size, file.type || 'text/html'),
    size: file.size,
    type: file.type || 'text/html',
    openedAt: new Date().toISOString(),
  };

  await withDatabase(async (database) => {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    store.put(record);
    pruneExpiredRecords(store, Date.now());
    await transactionComplete(transaction);
  });
  return key;
};

export const getLocalHtmlFile = (key: string) =>
  withDatabase(async (database) => {
    const transaction = database.transaction(storeName, 'readonly');
    const record = await requestResult(
      transaction.objectStore(storeName).get(key) as IDBRequest<LocalHtmlFileRecord | undefined>,
    );
    await transactionComplete(transaction);
    return record;
  });

export const deleteLocalHtmlFile = (key: string) =>
  withDatabase(async (database) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await transactionComplete(transaction);
  });

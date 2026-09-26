// IndexedDB 轻封装（离线优先；无 IndexedDB 环境自动降级为内存存储）
const DB_NAME = 'app-024-lantern-riddle';
const DB_VERSION = 2;
export const STORE_RIDDLES = 'riddles';
export const STORE_RECORDS = 'records';
export const STORE_REDEMPTIONS = 'redemptions';
export const STORE_KV = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RIDDLES)) {
        const s = db.createObjectStore(STORE_RIDDLES, { keyPath: 'id' });
        s.createIndex('no', 'no', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const s = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        s.createIndex('riddleId', 'riddleId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_REDEMPTIONS)) {
        const s = db.createObjectStore(STORE_REDEMPTIONS, { keyPath: 'id' });
        // 兑奖号码唯一索引：两个窗口（标签页）同时核销同一号码时，add 只有一个能成功
        s.createIndex('code', 'code', { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

// 内存降级（测试/隐私模式）
const mem = new Map<string, Map<string, unknown>>();
function memStore(name: string): Map<string, unknown> {
  let m = mem.get(name);
  if (!m) { m = new Map(); mem.set(name, m); }
  return m;
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<{ ok: boolean; result: T | null }> {
  const db = await openDB();
  if (!db) return { ok: false, result: null };
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const req = run(t.objectStore(store));
      req.onsuccess = () => resolve({ ok: true, result: req.result as T });
      req.onerror = () => resolve({ ok: false, result: null });
    } catch { resolve({ ok: false, result: null }); }
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  const { ok, result } = await tx<T[]>(store, 'readonly', (s) => s.getAll());
  if (ok && result) return result;
  return [...memStore(store).values()] as T[];
}

export async function put<T extends { id?: string; key?: string }>(store: string, value: T): Promise<void> {
  const { ok } = await tx(store, 'readwrite', (s) => s.put(value));
  if (!ok) memStore(store).set((value.id ?? value.key) as string, value);
}

export async function putMany<T extends { id?: string; key?: string }>(store: string, values: T[]): Promise<void> {
  const db = await openDB();
  if (!db) {
    const m = memStore(store);
    for (const v of values) m.set((v.id ?? v.key) as string, v);
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      for (const v of values) os.put(v);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
      t.onabort = () => resolve();
    } catch { resolve(); }
  });
}

export async function del(store: string, key: string): Promise<void> {
  const { ok } = await tx(store, 'readwrite', (s) => s.delete(key));
  if (!ok) memStore(store).delete(key);
}

/**
 * 原子写入（add 语义）：依赖 store 上 indexName 对应的唯一索引。
 * 同一 key 已存在时本次写入失败并返回已存在的记录——跨标签页/窗口并发也只有一方成功。
 */
export async function addUnique<T extends { id: string }>(
  store: string, value: T, indexName: keyof T & string,
): Promise<{ ok: boolean; existing: T | null }> {
  const key = (value as Record<string, unknown>)[indexName];
  const db = await openDB();
  if (!db) {
    const m = memStore(store);
    for (const v of m.values()) {
      if ((v as Record<string, unknown>)[indexName] === key) return { ok: false, existing: v as T };
    }
    m.set(value.id, value);
    return { ok: true, existing: null };
  }
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, 'readwrite');
      const req = t.objectStore(store).add(value);
      req.onsuccess = () => resolve({ ok: true, existing: null });
      req.onerror = () => {
        // 唯一索引冲突：取出已存在的那条（第一次核销的记录）
        try {
          const q = db.transaction(store, 'readonly').objectStore(store).index(indexName).get(key as IDBValidKey);
          q.onsuccess = () => resolve({ ok: false, existing: (q.result as T) ?? null });
          q.onerror = () => resolve({ ok: false, existing: null });
        } catch { resolve({ ok: false, existing: null }); }
      };
    } catch { resolve({ ok: false, existing: null }); }
  });
}

export async function clearStore(store: string): Promise<void> {
  const { ok } = await tx(store, 'readwrite', (s) => s.clear());
  if (!ok) memStore(store).clear();
}

export async function getKV<T>(key: string): Promise<T | null> {
  const { ok, result } = await tx<{ key: string; value: T }>(STORE_KV, 'readonly', (s) => s.get(key));
  if (ok) return result ? result.value : null;
  const v = memStore(STORE_KV).get(key) as { value: T } | undefined;
  return v?.value ?? null;
}

export async function setKV<T>(key: string, value: T): Promise<void> {
  await put(STORE_KV, { key, value });
}

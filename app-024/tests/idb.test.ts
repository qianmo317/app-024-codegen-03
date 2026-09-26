// redemptions 表 code 唯一索引的原子写入测试（fake-indexeddb 走真实 IndexedDB 代码路径）
// 两个窗口（标签页）共享同一数据库：并发 addUnique 同一兑奖号码，只有一方成功
import { describe, it, expect, beforeAll } from 'vitest';
import { indexedDB as fakeIDB } from 'fake-indexeddb';

// 必须在导入 idb 模块前装好 indexedDB（模块级缓存连接）
(globalThis as Record<string, unknown>).indexedDB = fakeIDB;

let idb: typeof import('../src/lib/idb');

beforeAll(async () => {
  idb = await import('../src/lib/idb');
});

interface Rd { id: string; code: string; window: string }

describe('idb.addUnique 唯一索引原子写入', () => {
  it('同一 code 并发写入：只成功一次，失败方能拿到首次记录', async () => {
    const a: Rd = { id: 'a1', code: 'DJ-0001', window: '1 号窗' };
    const b: Rd = { id: 'b2', code: 'DJ-0001', window: '2 号窗' };
    const [ra, rb] = await Promise.all([
      idb.addUnique<Rd>(idb.STORE_REDEMPTIONS, a, 'code'),
      idb.addUnique<Rd>(idb.STORE_REDEMPTIONS, b, 'code'),
    ]);
    const oks = [ra, rb].filter((r) => r.ok);
    const fails = [ra, rb].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    // 失败方拿到的 existing 就是成功方写入的那条（首次领取记录）
    expect(fails[0].existing?.id).toBe(oks[0] === ra ? 'a1' : 'b2');
    const all = await idb.getAll<Rd>(idb.STORE_REDEMPTIONS);
    expect(all.filter((x) => x.code === 'DJ-0001')).toHaveLength(1);
  });

  it('不同 code 互不影响；串行重复也被拦下', async () => {
    const c: Rd = { id: 'c3', code: 'DJ-0002', window: '1 号窗' };
    expect((await idb.addUnique<Rd>(idb.STORE_REDEMPTIONS, c, 'code')).ok).toBe(true);
    const dup = await idb.addUnique<Rd>(idb.STORE_REDEMPTIONS, { id: 'd4', code: 'DJ-0002', window: '2 号窗' }, 'code');
    expect(dup.ok).toBe(false);
    expect(dup.existing?.id).toBe('c3');
  });
});

// 领奖核销测试：号码归一化、收场统计、同号仅一次（含并发）、出号不重号
import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeCode, buildRedeemReport } from '../src/lib/redeem';
import { store } from '../src/lib/store';
import type { OnsiteRecord, Redemption, Riddle } from '../src/types';

function mkRiddle(id: string, no: number, surface = `谜面${no}`): Riddle {
  return {
    id, no, surface, answer: '甲', category: 'char', format: 'none',
    difficulty: 2, tags: [], check: { verdict: 'pass', reasons: [], checkedAt: 0 },
  };
}
function mkRecord(id: string, riddleId: string, prize: string, code?: string): OnsiteRecord {
  return { id, riddleId, winnerName: '张三', prize, at: 1000, code };
}
function mkRedemption(code: string, prize: string, window = '1 号窗'): Redemption {
  return { id: `rd-${code}-${window}`, code, riddleId: 'r1', winnerName: '张三', prize, window, operator: '李四', at: 2000 };
}

describe('normalizeCode 兑奖号码归一化', () => {
  it('标准与变体写法统一为 DJ-xxxx', () => {
    expect(normalizeCode('DJ-0001')).toBe('DJ-0001');
    expect(normalizeCode('dj-0001')).toBe('DJ-0001');
    expect(normalizeCode('DJ0001')).toBe('DJ-0001');
    expect(normalizeCode('dj 0001')).toBe('DJ-0001');
    expect(normalizeCode('0001')).toBe('DJ-0001');
    expect(normalizeCode('1')).toBe('DJ-0001');
    expect(normalizeCode('  12  ')).toBe('DJ-0012');
  });
  it('无法解析的输入返回 null', () => {
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('   ')).toBeNull();
    expect(normalizeCode('abc')).toBeNull();
    expect(normalizeCode('DJ-')).toBeNull();
    expect(normalizeCode('DJ-A001')).toBeNull();
    expect(normalizeCode('1234567')).toBeNull(); // 超过 6 位
  });
});

describe('buildRedeemReport 收场统计', () => {
  const riddles = [mkRiddle('r1', 1), mkRiddle('r2', 2), mkRiddle('r3', 3)];
  const records = [
    mkRecord('rec1', 'r1', '一等奖', 'DJ-0001'),
    mkRecord('rec2', 'r2', '参与奖', 'DJ-0002'),
    mkRecord('rec3', 'r3', '参与奖'), // 未出号
  ];

  it('按奖项与窗口汇总已领取，列出未领取名单', () => {
    const redemptions = [mkRedemption('DJ-0001', '一等奖', '2 号窗')];
    const rep = buildRedeemReport(records, redemptions, riddles, { 参与奖: 10 });
    expect(rep.codedTotal).toBe(2);
    expect(rep.issuedTotal).toBe(1);
    expect(rep.noCodeCount).toBe(1);
    // 按奖项
    const first = rep.byPrize.find((p) => p.prize === '一等奖');
    const join = rep.byPrize.find((p) => p.prize === '参与奖');
    expect(first).toMatchObject({ issued: 1, unclaimed: 0, limit: 0 });
    expect(join).toMatchObject({ issued: 0, unclaimed: 1, limit: 10 });
    // 按窗口
    expect(rep.byWindow).toEqual([{ window: '2 号窗', count: 1 }]);
    // 未领取名单
    expect(rep.unclaimed).toHaveLength(1);
    expect(rep.unclaimed[0]).toMatchObject({ code: 'DJ-0002', no: 2, prize: '参与奖', winnerName: '张三' });
  });

  it('全部领取后未领取名单为空；无奖项时按奖项表为空', () => {
    const rep = buildRedeemReport(
      [mkRecord('rec1', 'r1', '一等奖', 'DJ-0001')],
      [mkRedemption('DJ-0001', '一等奖')],
      riddles,
      {},
    );
    expect(rep.unclaimed).toHaveLength(0);
    const empty = buildRedeemReport([], [], [], {});
    expect(empty.byPrize).toHaveLength(0);
    expect(empty.byWindow).toHaveLength(0);
  });
});

describe('store 领奖核销（内存降级 IndexedDB）', () => {
  beforeEach(async () => {
    await store.init();
    await store.clearRedemptions();
    await store.clearRecords();
    await store.clearRiddles();
  });

  async function seedRiddleWithCode(prize = '参与奖'): Promise<Riddle> {
    const r = await store.saveRiddle({ surface: `谜面${Date.now()}${Math.random()}`, answer: '甲', category: 'char', format: 'none', tags: [], difficulty: 2 });
    await store.addRecord({ riddleId: r.id, winnerName: '张三', prize });
    await store.generatePrizeCodes();
    return r;
  }

  it('同一号码只能核销一次，第二次返回首次领取记录', async () => {
    await seedRiddleWithCode();
    const first = await store.redeemByCode('DJ-0001', '1 号窗', '李四');
    expect(first.ok).toBe(true);
    const second = await store.redeemByCode('DJ-0001', '2 号窗', '王五');
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === 'already') {
      expect(second.existing?.window).toBe('1 号窗');
      expect(second.existing?.operator).toBe('李四');
    } else {
      throw new Error('应为 already');
    }
    expect(store.getState().redemptions).toHaveLength(1);
  });

  it('两个窗口同时核销同一号码：并发只有一方成功', async () => {
    await seedRiddleWithCode();
    const [a, b] = await Promise.all([
      store.redeemByCode('DJ-0001', '1 号窗', '李四'),
      store.redeemByCode('dj0001', '2 号窗', '王五'), // 写法不同，归一化后同号
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const already = [a, b].filter((r) => !r.ok && r.reason === 'already');
    expect(oks).toHaveLength(1);
    expect(already).toHaveLength(1);
    expect(store.getState().redemptions).toHaveLength(1);
  });

  it('号码格式错误与查不到分别给出明确结果', async () => {
    await seedRiddleWithCode();
    const bad = await store.redeemByCode('你好', '1 号窗', '李四');
    expect(bad).toMatchObject({ ok: false, reason: 'invalid' });
    const missing = await store.redeemByCode('DJ-9999', '1 号窗', '李四');
    expect(missing).toMatchObject({ ok: false, reason: 'not-found', code: 'DJ-9999' });
  });

  it('撤销后该号码可重新核销', async () => {
    await seedRiddleWithCode();
    const first = await store.redeemByCode('DJ-0001', '1 号窗', '李四');
    if (!first.ok) throw new Error('首次核销应成功');
    await store.revokeRedemption(first.redemption.id);
    const again = await store.redeemByCode('DJ-0001', '2 号窗', '王五');
    expect(again.ok).toBe(true);
    expect(store.getState().redemptions).toHaveLength(1);
  });

  it('兑奖号码分批生成不重号（续号而非从 DJ-0001 重来）', async () => {
    await seedRiddleWithCode();
    const r2 = await store.saveRiddle({ surface: '另一条谜面', answer: '乙', category: 'char', format: 'none', tags: [], difficulty: 2 });
    await store.addRecord({ riddleId: r2.id, winnerName: '王五', prize: '一等奖' });
    await store.generatePrizeCodes();
    const codes = store.getState().records.map((r) => r.code).sort();
    expect(codes).toEqual(['DJ-0001', 'DJ-0002']);
  });
});

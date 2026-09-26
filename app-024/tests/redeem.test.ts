// 领奖核销测试：号码归一化 / 查号 / 原子核销（重复+并发）/ 库存闸口 / 收场报表 / 兑奖号码续号
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  normalizeCodeInput, lookupByCode, issuedCount, stockConfirmReason,
  buildRedeemReport, reportToRows, REPORT_CSV_HEADERS,
} from '../src/lib/redeem';
import { store } from '../src/lib/store';
import type { OnsiteRecord, PrizeClaim, Riddle } from '../src/types';

let seq = 0;
function mkRiddle(no: number): Riddle {
  return {
    id: `rid${no}`, no, surface: `谜面${no}`, answer: `底${no}`, category: 'char', format: 'none',
    difficulty: 2, tags: [], check: { verdict: 'pass', reasons: [], checkedAt: 0 },
  };
}
function mkRecord(over: Partial<OnsiteRecord> = {}): OnsiteRecord {
  seq++;
  return { id: `rec${seq}`, riddleId: 'rid1', prize: '参与奖', at: 1000 + seq, ...over };
}
function mkClaim(over: Partial<PrizeClaim> = {}): PrizeClaim {
  seq++;
  return {
    id: `clm${seq}`, code: 'DJ-0001', recordId: 'rec1', riddleId: 'rid1',
    at: 2000 + seq, window: '1号窗口', operator: '小王', ...over,
  };
}

describe('normalizeCodeInput 兑奖号码归一化', () => {
  it('标准与宽松写法都归一为 DJ-xxxx', () => {
    expect(normalizeCodeInput('DJ-0001')).toBe('DJ-0001');
    expect(normalizeCodeInput('dj-0001')).toBe('DJ-0001');
    expect(normalizeCodeInput('DJ0001')).toBe('DJ-0001');
    expect(normalizeCodeInput('Dj-0007')).toBe('DJ-0007');
    expect(normalizeCodeInput('0001')).toBe('DJ-0001');
    expect(normalizeCodeInput('1')).toBe('DJ-0001');
    expect(normalizeCodeInput(' 12 ')).toBe('DJ-0012');
    expect(normalizeCodeInput('dj 23')).toBe('DJ-0023');
  });
  it('非法输入返回 null（页面据此给出明确提示）', () => {
    for (const bad of ['', '   ', 'abc', 'DJ-', 'DJ-A001', 'DJ-12-3', '0', '0000', '-1', 'DJ-0000000']) {
      expect(normalizeCodeInput(bad), `输入「${bad}」`).toBeNull();
    }
  });
});

describe('lookupByCode 按号码查谜条与奖项', () => {
  const riddles = [mkRiddle(1), mkRiddle(2)];
  const records = [mkRecord({ id: 'r1', riddleId: 'rid1', code: 'DJ-0001', prize: '二等奖' })];
  it('命中返回登记与谜条', () => {
    const hit = lookupByCode('DJ-0001', records, riddles);
    expect(hit?.record.prize).toBe('二等奖');
    expect(hit?.riddle?.surface).toBe('谜面1');
  });
  it('查不到返回 null', () => {
    expect(lookupByCode('DJ-9999', records, riddles)).toBeNull();
  });
});

describe('stockConfirmReason 库存闸口', () => {
  const records = [
    mkRecord({ id: 'r1', code: 'DJ-0001', prize: '一等奖' }),
    mkRecord({ id: 'r2', code: 'DJ-0002', prize: '一等奖' }),
    mkRecord({ id: 'r3', code: 'DJ-0003', prize: '参与奖' }),
  ];
  const claims = [mkClaim({ recordId: 'r1', code: 'DJ-0001' })];
  it('未设数量（0）不拦截', () => {
    expect(stockConfirmReason('一等奖', [], records, claims)).toBeNull();
    expect(stockConfirmReason('一等奖', [{ prize: '一等奖', total: 0 }], records, claims)).toBeNull();
  });
  it('未达设定数量不拦截', () => {
    expect(stockConfirmReason('一等奖', [{ prize: '一等奖', total: 2 }], records, claims)).toBeNull();
  });
  it('发到设定数量时需先确认', () => {
    const reason = stockConfirmReason('一等奖', [{ prize: '一等奖', total: 1 }], records, claims);
    expect(reason).toContain('一等奖');
    expect(reason).toContain('1');
  });
  it('issuedCount 只算已核销的份数', () => {
    expect(issuedCount('一等奖', records, claims)).toBe(1);
    expect(issuedCount('参与奖', records, claims)).toBe(0);
  });
});

describe('buildRedeemReport 收场报表', () => {
  const riddles = [mkRiddle(1), mkRiddle(2), mkRiddle(3)];
  const records = [
    mkRecord({ id: 'r1', riddleId: 'rid1', code: 'DJ-0001', prize: '一等奖', winnerName: '张三' }),
    mkRecord({ id: 'r2', riddleId: 'rid2', code: 'DJ-0002', prize: '一等奖', winnerName: '李四' }),
    mkRecord({ id: 'r3', riddleId: 'rid3', code: 'DJ-0003', prize: '参与奖', winnerName: '王五' }),
    mkRecord({ id: 'r4', riddleId: 'rid1', prize: '参与奖' }), // 未生成号码，不进报表
  ];
  const claims = [
    mkClaim({ id: 'c1', recordId: 'r1', riddleId: 'rid1', code: 'DJ-0001', window: '1号窗口', operator: '小王', at: 3000 }),
    mkClaim({ id: 'c2', recordId: 'r3', riddleId: 'rid3', code: 'DJ-0003', window: '2号窗口', operator: '小李', at: 3100 }),
  ];
  it('按奖项分出已领取/未领取名单', () => {
    const rep = buildRedeemReport(records, riddles, claims);
    expect(rep.totalCodes).toBe(3);
    expect(rep.totalClaimed).toBe(2);
    expect(rep.totalUnclaimed).toBe(1);
    const first = rep.byPrize.find((g) => g.prize === '一等奖');
    expect(first?.claimed.map((r) => r.code)).toEqual(['DJ-0001']);
    expect(first?.unclaimed.map((r) => r.code)).toEqual(['DJ-0002']);
    expect(first?.claimed[0].window).toBe('1号窗口');
    expect(first?.claimed[0].operator).toBe('小王');
    expect(first?.unclaimed[0].winnerName).toBe('李四');
  });
  it('按窗口汇总已领取名单', () => {
    const rep = buildRedeemReport(records, riddles, claims);
    expect(rep.byWindow.map((w) => w.window).sort()).toEqual(['1号窗口', '2号窗口']);
    expect(rep.byWindow.find((w) => w.window === '2号窗口')?.rows.map((r) => r.code)).toEqual(['DJ-0003']);
  });
  it('导出 CSV 行含状态列且表头齐全', () => {
    const rep = buildRedeemReport(records, riddles, claims);
    const rows = reportToRows(rep);
    expect(REPORT_CSV_HEADERS).toContain('状态');
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r[5] === '已领取')).toBe(true);
    expect(rows.some((r) => r[5] === '未领取')).toBe(true);
  });
});

describe('store 核销与兑奖号码（内存存储降级路径）', () => {
  beforeAll(async () => {
    await store.init();
  });
  beforeEach(async () => {
    await store.clearRecords();
    await store.clearRiddles();
  });

  async function seedRecord(prize = '参与奖'): Promise<OnsiteRecord> {
    const riddle = await store.saveRiddle({
      surface: `测试谜面${Math.random()}`, answer: '甲', category: 'char', format: 'none',
      difficulty: 2, tags: [],
    });
    return store.addRecord({ riddleId: riddle.id, winnerName: '张三', prize });
  }

  it('同一号码只能核销一次，重复核销返回首次领取记录', async () => {
    const rec = await seedRecord();
    await store.generatePrizeCodes();
    const code = store.getState().records.find((r) => r.id === rec.id)!.code!;
    const first = await store.claimPrize({ code, recordId: rec.id, riddleId: rec.riddleId, window: '1号窗口', operator: '小王' });
    expect(first.ok).toBe(true);
    const dup = await store.claimPrize({ code, recordId: rec.id, riddleId: rec.riddleId, window: '2号窗口', operator: '小李' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.existing?.window).toBe('1号窗口');
      expect(dup.existing?.operator).toBe('小王');
    }
    expect(store.getState().claims.filter((c) => c.code === code)).toHaveLength(1);
  });

  it('并发核销同一号码：只有一次成功（模拟两个窗口同时点）', async () => {
    const rec = await seedRecord();
    await store.generatePrizeCodes();
    const code = store.getState().records.find((r) => r.id === rec.id)!.code!;
    const [a, b] = await Promise.all([
      store.claimPrize({ code, recordId: rec.id, riddleId: rec.riddleId, window: '1号窗口', operator: '甲' }),
      store.claimPrize({ code, recordId: rec.id, riddleId: rec.riddleId, window: '2号窗口', operator: '乙' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(store.getState().claims.filter((c) => c.code === code)).toHaveLength(1);
  });

  it('撤销核销后该号码可再次核销', async () => {
    const rec = await seedRecord();
    await store.generatePrizeCodes();
    const code = store.getState().records.find((r) => r.id === rec.id)!.code!;
    const first = await store.claimPrize({ code, recordId: rec.id, riddleId: rec.riddleId, window: '1号窗口', operator: '小王' });
    expect(first.ok).toBe(true);
    if (first.ok) await store.revokeClaim(first.claim.id);
    expect(store.claimByCode(code)).toBeUndefined();
    const again = await store.claimPrize({ code, recordId: rec.id, riddleId: rec.riddleId, window: '2号窗口', operator: '小李' });
    expect(again.ok).toBe(true);
  });

  it('删除登记记录时级联删除其核销记录', async () => {
    const rec = await seedRecord();
    await store.generatePrizeCodes();
    const code = store.getState().records.find((r) => r.id === rec.id)!.code!;
    await store.claimPrize({ code, recordId: rec.id, riddleId: rec.riddleId, window: '1号窗口', operator: '小王' });
    expect(store.claimByCode(code)).toBeDefined();
    await store.removeRecord(rec.id);
    expect(store.claimByCode(code)).toBeUndefined();
  });

  it('兑奖号码续号：已有 DJ-0002 时新号码从 DJ-0003 开始（不重号）', async () => {
    const r1 = await seedRecord();
    await store.generatePrizeCodes();
    const code1 = store.getState().records.find((r) => r.id === r1.id)!.code;
    expect(code1).toBe('DJ-0001');
    // 模拟历史数据：把已有号码改成 DJ-0002，再补新登记的号码
    const rec1 = store.getState().records.find((r) => r.id === r1.id)!;
    rec1.code = 'DJ-0002';
    const r2 = await seedRecord();
    const n = await store.generatePrizeCodes();
    expect(n).toBe(1);
    const code2 = store.getState().records.find((r) => r.id === r2.id)!.code;
    expect(code2).toBe('DJ-0003');
    const all = store.getState().records.map((r) => r.code).filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
  });
});

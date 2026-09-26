// 领奖核销纯逻辑：号码归一化、查号、库存闸口、收场报表（不依赖 UI/存储，可单测）
import type { OnsiteRecord, PrizeClaim, PrizeStock, Riddle } from '../types';

export const CODE_PREFIX = 'DJ-';

/**
 * 兑奖号码归一化：接受 DJ-0001 / dj-0001 / DJ0001 / 0001 / 1 等写法，
 * 统一为 DJ-xxxx（4 位起，超过 4 位按实际位数）。非法输入返回 null。
 */
export function normalizeCodeInput(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  const m = s.match(/^(?:DJ-?)?(\d{1,6})$/);
  if (!m) return null;
  const digits = m[1];
  if (parseInt(digits, 10) <= 0) return null;
  return `${CODE_PREFIX}${digits.padStart(4, '0')}`;
}

export interface CodeLookup {
  record: OnsiteRecord;
  riddle: Riddle | undefined;
}

/** 按兑奖号码查登记记录与谜条；查不到返回 null */
export function lookupByCode(code: string, records: OnsiteRecord[], riddles: Riddle[]): CodeLookup | null {
  const record = records.find((r) => r.code === code);
  if (!record) return null;
  return { record, riddle: riddles.find((x) => x.id === record.riddleId) };
}

/** 某奖项已核销（已领取）份数 */
export function issuedCount(prize: string, records: OnsiteRecord[], claims: PrizeClaim[]): number {
  const claimedRecordIds = new Set(claims.map((c) => c.recordId));
  return records.filter((r) => r.prize === prize && claimedRecordIds.has(r.id)).length;
}

/** 某奖项的设定数量（一箱）；未设置或 0 表示不限 */
export function stockTotalOf(prize: string, stock: PrizeStock[]): number {
  return stock.find((s) => s.prize === prize)?.total ?? 0;
}

/**
 * 库存闸口：该奖项已发份数达到设定数量时，继续发奖需先确认。
 * 返回 null 表示可直接发；否则返回需确认的原因文案。
 */
export function stockConfirmReason(
  prize: string,
  stock: PrizeStock[],
  records: OnsiteRecord[],
  claims: PrizeClaim[],
): string | null {
  const total = stockTotalOf(prize, stock);
  if (!prize.trim() || total <= 0) return null;
  const issued = issuedCount(prize, records, claims);
  if (issued < total) return null;
  return `「${prize}」已发出 ${issued} 份，达到设定数量 ${total}，请核对这一箱是否发完，确认后再继续发`;
}

// ---- 收场报表 ----

export interface ReportRow {
  code: string;
  riddleNo: number | null;
  surface: string;
  winnerName: string;
  prize: string;
  claimed: boolean;
  claimAt: number | null;
  window: string;
  operator: string;
}

export interface PrizeGroup {
  prize: string;
  claimed: ReportRow[];
  unclaimed: ReportRow[];
}

export interface WindowGroup {
  window: string;
  rows: ReportRow[]; // 该窗口已领取名单
}

export interface RedeemReport {
  byPrize: PrizeGroup[];      // 按奖项分组的已领取/未领取名单
  byWindow: WindowGroup[];    // 按窗口分组的已领取名单
  totalCodes: number;
  totalClaimed: number;
  totalUnclaimed: number;
}

/** 收场报表：只对已生成兑奖号码的登记记录出名单（按奖项与窗口分组） */
export function buildRedeemReport(
  records: OnsiteRecord[],
  riddles: Riddle[],
  claims: PrizeClaim[],
): RedeemReport {
  const riddleById = new Map(riddles.map((r) => [r.id, r]));
  const claimByRecord = new Map(claims.map((c) => [c.recordId, c]));

  const rows: ReportRow[] = records
    .filter((r) => r.code)
    .map((r) => {
      const claim = claimByRecord.get(r.id);
      const riddle = riddleById.get(r.riddleId);
      return {
        code: r.code as string,
        riddleNo: riddle?.no ?? null,
        surface: riddle?.surface ?? '',
        winnerName: r.winnerName || '匿名',
        prize: r.prize || '（未设奖项）',
        claimed: !!claim,
        claimAt: claim?.at ?? null,
        window: claim?.window ?? '',
        operator: claim?.operator ?? '',
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const prizeNames: string[] = [];
  for (const row of rows) if (!prizeNames.includes(row.prize)) prizeNames.push(row.prize);
  const byPrize: PrizeGroup[] = prizeNames.map((prize) => ({
    prize,
    claimed: rows.filter((r) => r.prize === prize && r.claimed),
    unclaimed: rows.filter((r) => r.prize === prize && !r.claimed),
  }));

  const windowNames: string[] = [];
  for (const c of claims) if (c.window && !windowNames.includes(c.window)) windowNames.push(c.window);
  const byWindow: WindowGroup[] = windowNames.map((window) => ({
    window,
    rows: rows.filter((r) => r.claimed && r.window === window),
  }));

  const totalClaimed = rows.filter((r) => r.claimed).length;
  return {
    byPrize,
    byWindow,
    totalCodes: rows.length,
    totalClaimed,
    totalUnclaimed: rows.length - totalClaimed,
  };
}

/** 报表导出 CSV 行 */
export function reportToRows(report: RedeemReport): (string | number)[][] {
  const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-CN') : '');
  const rows: (string | number)[][] = [];
  for (const g of report.byPrize) {
    for (const r of [...g.claimed, ...g.unclaimed]) {
      rows.push([
        r.prize, r.code, r.riddleNo ?? '', r.surface, r.winnerName,
        r.claimed ? '已领取' : '未领取', fmt(r.claimAt), r.window, r.operator,
      ]);
    }
  }
  return rows;
}

export const REPORT_CSV_HEADERS = ['奖项', '兑奖号码', '谜号', '谜面', '猜中者', '状态', '领取时间', '领取窗口', '经手人'];

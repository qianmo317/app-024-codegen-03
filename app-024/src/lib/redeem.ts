// 领奖核销：兑奖号码归一化 + 收场统计（纯函数，便于单测）
import type { OnsiteRecord, Redemption, Riddle } from '../types';

/**
 * 兑奖号码归一化：接受 DJ-0001 / dj0001 / DJ 0001 / 0001 等写法，统一为 DJ-xxxx。
 * 无法解析（字母以外的字符、空串等）返回 null，由调用方给出「号码不对」提示。
 */
export function normalizeCode(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  const m = s.match(/^(?:DJ-?)?(\d{1,6})$/);
  if (!m) return null;
  return `DJ-${m[1].padStart(4, '0')}`;
}

export interface PrizeReportRow {
  prize: string;
  issued: number;    // 已领取份数
  limit: number;     // 设定数量（0 = 不限）
  unclaimed: number; // 已出号未领取份数
}

export interface WindowReportRow {
  window: string;
  count: number;
}

export interface UnclaimedRow {
  code: string;
  no: number | '';
  surface: string;
  winnerName: string;
  prize: string;
}

export interface RedeemReport {
  byPrize: PrizeReportRow[];
  byWindow: WindowReportRow[];
  unclaimed: UnclaimedRow[];
  noCodeCount: number; // 已登记但尚未生成兑奖号码的条数
  codedTotal: number;  // 已出号总数
  issuedTotal: number; // 已核销总数
}

/** 收场统计：按奖项与窗口汇总已领取，列出已出号未领取名单 */
export function buildRedeemReport(
  records: OnsiteRecord[],
  redemptions: Redemption[],
  riddles: Riddle[],
  limits: Record<string, number>,
): RedeemReport {
  const redeemedCodes = new Set(redemptions.map((x) => x.code));
  const noOf = new Map(riddles.map((r) => [r.id, r.no]));
  const surfaceOf = new Map(riddles.map((r) => [r.id, r.surface]));

  const coded = records.filter((r) => r.code);
  const unclaimed: UnclaimedRow[] = coded
    .filter((r) => !redeemedCodes.has(r.code as string))
    .map((r): UnclaimedRow => ({
      code: r.code as string,
      no: noOf.get(r.riddleId) ?? '',
      surface: surfaceOf.get(r.riddleId) ?? '',
      winnerName: r.winnerName || '匿名',
      prize: r.prize,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const prizeNames = new Set<string>();
  for (const r of coded) if (r.prize.trim()) prizeNames.add(r.prize);
  for (const x of redemptions) if (x.prize.trim()) prizeNames.add(x.prize);
  for (const p of Object.keys(limits)) if ((limits[p] ?? 0) > 0) prizeNames.add(p);

  const byPrize: PrizeReportRow[] = [...prizeNames].sort().map((p) => ({
    prize: p,
    issued: redemptions.filter((x) => x.prize === p).length,
    limit: limits[p] ?? 0,
    unclaimed: unclaimed.filter((u) => u.prize === p).length,
  }));

  const winCount = new Map<string, number>();
  for (const x of redemptions) winCount.set(x.window, (winCount.get(x.window) ?? 0) + 1);
  const byWindow: WindowReportRow[] = [...winCount.entries()]
    .map(([window, count]) => ({ window, count }))
    .sort((a, b) => b.count - a.count || a.window.localeCompare(b.window));

  return {
    byPrize,
    byWindow,
    unclaimed,
    noCodeCount: records.filter((r) => !r.code).length,
    codedTotal: coded.length,
    issuedTotal: redemptions.length,
  };
}

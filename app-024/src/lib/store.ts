// 集中式应用状态：数据读写全部在此，UI 只做展示与动作调用
import type { AppSettings, OnsiteRecord, Redemption, Riddle } from '../types';
import { validateRiddle } from './validate';
import { normalizeCode } from './redeem';
import { EMPTY_CTX, loadDataCtx, type DataCtx } from './datafiles';
import * as idb from './idb';
import { formatDate } from './format';

const KV_SETTINGS = 'settings';
const SYNC_CHANNEL = 'app-024-sync'; // 跨标签页同步（BroadcastChannel）

export const DEFAULT_SETTINGS: AppSettings = {
  event: { id: 'event-default', title: '元宵灯会', host: '', date: '', riddleIds: [] },
  print: {
    cardWmm: 63, cardHmm: 135, perPage: 6,
    showAnswerSlip: true, showCutLine: true,
    hostLine: '',
  },
  prizes: ['参与奖', '三等奖', '二等奖', '一等奖'],
  redeem: { windows: ['1 号窗', '2 号窗'], stockLimits: {} },
};

export interface AppState {
  ready: boolean;
  riddles: Riddle[];
  records: OnsiteRecord[];
  redemptions: Redemption[];
  settings: AppSettings;
  ctx: DataCtx; // 拼音/部件离线数据
  selected: Set<string>; // 批量出条选中（会话级，不持久化）
}

export type RedeemResult =
  | { ok: true; redemption: Redemption }
  | { ok: false; reason: 'invalid'; input: string }
  | { ok: false; reason: 'not-found'; code: string }
  | { ok: false; reason: 'already'; code: string; existing?: Redemption };

type Listener = () => void;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class AppStore {
  private state: AppState = {
    ready: false,
    riddles: [],
    records: [],
    redemptions: [],
    settings: DEFAULT_SETTINGS,
    ctx: EMPTY_CTX,
    selected: new Set<string>(),
  };
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;
  private bc: BroadcastChannel | null = null;

  getState = (): AppState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    this.state = { ...this.state };
    for (const l of this.listeners) l();
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const [riddles, records, redemptions, settings, ctx] = await Promise.all([
          idb.getAll<Riddle>(idb.STORE_RIDDLES),
          idb.getAll<OnsiteRecord>(idb.STORE_RECORDS),
          idb.getAll<Redemption>(idb.STORE_REDEMPTIONS),
          idb.getKV<AppSettings>(KV_SETTINGS),
          loadDataCtx(import.meta.env.BASE_URL),
        ]);
        this.state.riddles = riddles.sort((a, b) => a.no - b.no);
        this.state.records = records.sort((a, b) => b.at - a.at);
        this.state.redemptions = redemptions.sort((a, b) => b.at - a.at);
        if (settings) {
          this.state.settings = {
            event: { ...DEFAULT_SETTINGS.event, ...settings.event },
            print: { ...DEFAULT_SETTINGS.print, ...settings.print },
            prizes: settings.prizes?.length ? settings.prizes : DEFAULT_SETTINGS.prizes,
            redeem: {
              windows: settings.redeem?.windows?.length ? settings.redeem.windows : DEFAULT_SETTINGS.redeem.windows,
              stockLimits: settings.redeem?.stockLimits ?? {},
            },
          };
        }
        if (!this.state.settings.print.hostLine && this.state.settings.event.host) {
          this.state.settings.print.hostLine = `${this.state.settings.event.host}`;
        }
        this.state.ctx = ctx;
        // 其他窗口（标签页）核销后，及时拉回最新核销记录，避免慢一拍重复发奖
        if (typeof BroadcastChannel !== 'undefined') {
          this.bc = new BroadcastChannel(SYNC_CHANNEL);
          this.bc.onmessage = (e) => { if (e.data === 'redemptions') void this.reloadRedemptions(); };
        }
        this.state.ready = true;
        this.emit();
      })();
    }
    return this.initPromise;
  }

  // ---- 谜库 ----
  nextNo(): number {
    return this.state.riddles.reduce((m, r) => Math.max(m, r.no), 0) + 1;
  }

  /** 新增/保存：自动计算谜格校验结果 */
  async saveRiddle(patch: Omit<Riddle, 'id' | 'no' | 'check'> & { id?: string; no?: number }): Promise<Riddle> {
    const id = patch.id ?? uid();
    const existing = patch.id ? this.state.riddles.find((r) => r.id === patch.id) : undefined;
    const no = patch.no ?? existing?.no ?? this.nextNo();
    const check = validateRiddle(patch, this.state.ctx);
    const riddle: Riddle = {
      ...patch,
      id,
      no,
      check: { ...check, checkedAt: Date.now() },
      tags: patch.tags ?? [],
      difficulty: patch.difficulty ?? 2,
    };
    if (existing) {
      this.state.riddles = this.state.riddles.map((r) => (r.id === id ? riddle : r));
    } else {
      this.state.riddles = [...this.state.riddles, riddle];
    }
    this.state.riddles.sort((a, b) => a.no - b.no);
    await idb.put(idb.STORE_RIDDLES, riddle);
    this.emit();
    return riddle;
  }

  /** 批量导入（去重后的新增项） */
  async addRiddles(items: (Omit<Riddle, 'id' | 'no' | 'check'> & Partial<Pick<Riddle, 'no'>>)[]): Promise<number> {
    if (!items.length) return 0;
    let no = this.nextNo();
    const now = Date.now();
    const riddles: Riddle[] = items.map((it) => ({
      ...it,
      id: uid(),
      no: it.no ?? no++,
      tags: it.tags ?? [],
      difficulty: it.difficulty ?? 2,
      check: { ...validateRiddle(it, this.state.ctx), checkedAt: now },
    }));
    this.state.riddles = [...this.state.riddles, ...riddles].sort((a, b) => a.no - b.no);
    await idb.putMany(idb.STORE_RIDDLES, riddles);
    this.emit();
    return riddles.length;
  }

  async recheckAll(): Promise<void> {
    const now = Date.now();
    const riddles = this.state.riddles.map((r) => ({
      ...r,
      check: { ...validateRiddle(r, this.state.ctx), checkedAt: now },
    }));
    this.state.riddles = riddles.sort((a, b) => a.no - b.no);
    await idb.putMany(idb.STORE_RIDDLES, riddles);
    this.emit();
  }

  async removeRiddles(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.state.riddles = this.state.riddles.filter((r) => !set.has(r.id));
    this.state.settings.event.riddleIds = this.state.settings.event.riddleIds.filter((x) => !set.has(x));
    await Promise.all(ids.map((id) => idb.del(idb.STORE_RIDDLES, id)));
    await this.saveSettings(this.state.settings); // 同步活动清单
    this.emit();
  }

  async clearRiddles(): Promise<void> {
    this.state.riddles = [];
    this.state.settings.event.riddleIds = [];
    await idb.clearStore(idb.STORE_RIDDLES);
    await this.saveSettings(this.state.settings);
    this.emit();
  }

  async loadSample(samples: Omit<Riddle, 'id' | 'no' | 'check'>[]): Promise<number> {
    return this.addRiddles(samples);
  }

  // ---- 批量选中（会话级）----
  toggleSelect(id: string): void {
    const s = new Set(this.state.selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.state.selected = s;
    this.emit();
  }

  selectMany(ids: string[], on: boolean): void {
    const s = new Set(this.state.selected);
    for (const id of ids) { if (on) s.add(id); else s.delete(id); }
    this.state.selected = s;
    this.emit();
  }

  clearSelection(): void {
    this.state.selected = new Set();
    this.emit();
  }

  // ---- 现场登记 ----
  recordsOf(riddleId: string): OnsiteRecord[] {
    return this.state.records.filter((r) => r.riddleId === riddleId);
  }

  async addRecord(rec: Omit<OnsiteRecord, 'id' | 'at'> & { at?: number }): Promise<OnsiteRecord> {
    const full: OnsiteRecord = { ...rec, id: uid(), at: rec.at ?? Date.now() };
    this.state.records = [full, ...this.state.records];
    await idb.put(idb.STORE_RECORDS, full);
    this.emit();
    return full;
  }

  async removeRecord(id: string): Promise<void> {
    this.state.records = this.state.records.filter((r) => r.id !== id);
    await idb.del(idb.STORE_RECORDS, id);
    this.emit();
  }

  async clearRecords(): Promise<void> {
    this.state.records = [];
    await idb.clearStore(idb.STORE_RECORDS);
    this.emit();
  }

  /** 兑奖号码生成：按登记时间顺序生成 DJ-xxxx（仅生成号码，不做在线抽奖）；已生成的号码不重号 */
  async generatePrizeCodes(): Promise<number> {
    let n = 0;
    for (const r of this.state.records) {
      const m = r.code?.match(/^DJ-(\d+)$/);
      if (m) n = Math.max(n, parseInt(m[1], 10));
    }
    let made = 0;
    const sorted = [...this.state.records].sort((a, b) => a.at - b.at);
    for (const r of sorted) {
      if (!r.code) {
        n++;
        made++;
        r.code = `DJ-${String(n).padStart(4, '0')}`;
        await idb.put(idb.STORE_RECORDS, r);
      }
    }
    if (made) this.emit();
    return made;
  }

  // ---- 领奖核销 ----
  redemptionOf(code: string): Redemption | undefined {
    return this.state.redemptions.find((x) => x.code === code);
  }

  /** 某奖项已核销份数（配合设定数量做发放前确认） */
  prizeIssued(prize: string): number {
    return this.state.redemptions.filter((x) => x.prize === prize).length;
  }

  /**
   * 核销一个兑奖号码：同一号码全库只能核销一次。
   * 唯一性由 redemptions 表 code 唯一索引保证（add 原子写入），
   * 两个窗口（标签页）同时核销同一号码也只有一方成功，另一方拿到首次领取记录。
   */
  async redeemByCode(input: string, windowName: string, operator: string): Promise<RedeemResult> {
    const code = normalizeCode(input);
    if (!code) return { ok: false, reason: 'invalid', input };
    const rec = this.state.records.find((r) => r.code === code);
    if (!rec) return { ok: false, reason: 'not-found', code };
    // 本标签页内存快速拦截
    const inMem = this.redemptionOf(code);
    if (inMem) return { ok: false, reason: 'already', code, existing: inMem };

    const redemption: Redemption = {
      id: uid(), code, riddleId: rec.riddleId,
      winnerName: rec.winnerName, prize: rec.prize,
      window: windowName, operator, at: Date.now(),
    };
    const { ok, existing } = await idb.addUnique(idb.STORE_REDEMPTIONS, redemption, 'code');
    if (!ok) {
      // 另一窗口已抢先核销：拉回首次领取记录并同步到本页内存
      const prior = existing
        ?? (await idb.getAll<Redemption>(idb.STORE_REDEMPTIONS)).find((x) => x.code === code)
        ?? undefined;
      if (prior && !this.redemptionOf(code)) {
        this.state.redemptions = [prior, ...this.state.redemptions];
        this.emit();
      }
      return { ok: false, reason: 'already', code, existing: prior };
    }
    this.state.redemptions = [redemption, ...this.state.redemptions];
    this.bc?.postMessage('redemptions');
    this.emit();
    return { ok: true, redemption };
  }

  /** 撤销一次核销（误操作回退；撤销后该号码可重新核销） */
  async revokeRedemption(id: string): Promise<void> {
    this.state.redemptions = this.state.redemptions.filter((x) => x.id !== id);
    await idb.del(idb.STORE_REDEMPTIONS, id);
    this.bc?.postMessage('redemptions');
    this.emit();
  }

  async clearRedemptions(): Promise<void> {
    this.state.redemptions = [];
    await idb.clearStore(idb.STORE_REDEMPTIONS);
    this.bc?.postMessage('redemptions');
    this.emit();
  }

  private async reloadRedemptions(): Promise<void> {
    const list = await idb.getAll<Redemption>(idb.STORE_REDEMPTIONS);
    this.state.redemptions = list.sort((a, b) => b.at - a.at);
    this.emit();
  }

  // ---- 设置 ----
  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    this.state.settings = {
      event: { ...this.state.settings.event, ...patch.event },
      print: { ...this.state.settings.print, ...patch.print },
      prizes: patch.prizes ?? this.state.settings.prizes,
      redeem: patch.redeem
        ? { windows: patch.redeem.windows ?? this.state.settings.redeem.windows, stockLimits: patch.redeem.stockLimits ?? this.state.settings.redeem.stockLimits }
        : this.state.settings.redeem,
    };
    await idb.setKV(KV_SETTINGS, this.state.settings);
    this.emit();
  }

  // ---- 统计 ----
  stats(): { total: number; solved: number; remaining: number; prizes: number } {
    const solvedSet = new Set(this.state.records.map((r) => r.riddleId));
    return {
      total: this.state.riddles.length,
      solved: solvedSet.size,
      remaining: this.state.riddles.length - solvedSet.size,
      prizes: this.state.records.filter((r) => r.prize.trim()).length,
    };
  }

  riddleByNo(no: number): Riddle | undefined {
    return this.state.riddles.find((r) => r.no === no);
  }
}

export const store = new AppStore();

// ---- 导出辅助（供各页面/导出模块复用）----
export function exportFileName(prefix: string, ext: string): string {
  const ev = store.getState().settings.event;
  const base = ev.title ? `${ev.title}-` : '';
  return `${prefix}-${base}${formatDate(new Date())}.${ext}`;
}

// 集中式应用状态：数据读写全部在此，UI 只做展示与动作调用
import type { AppSettings, OnsiteRecord, PrizeClaim, Riddle } from '../types';
import { validateRiddle } from './validate';
import { EMPTY_CTX, loadDataCtx, type DataCtx } from './datafiles';
import * as idb from './idb';
import { formatDate } from './format';

const KV_SETTINGS = 'settings';

export const DEFAULT_SETTINGS: AppSettings = {
  event: { id: 'event-default', title: '元宵灯会', host: '', date: '', riddleIds: [] },
  print: {
    cardWmm: 63, cardHmm: 135, perPage: 6,
    showAnswerSlip: true, showCutLine: true,
    hostLine: '',
  },
  prizes: ['参与奖', '三等奖', '二等奖', '一等奖'],
  redeem: { windows: ['1号窗口', '2号窗口'], stock: [] },
};

export interface AppState {
  ready: boolean;
  riddles: Riddle[];
  records: OnsiteRecord[];
  claims: PrizeClaim[];
  settings: AppSettings;
  ctx: DataCtx; // 拼音/部件离线数据
  selected: Set<string>; // 批量出条选中（会话级，不持久化）
}

type Listener = () => void;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 跨标签页同步：一个窗口核销/撤销后，其余窗口立即刷新（双窗口发奖场景）
const CLAIMS_CHANNEL = 'app-024-redeem';
type ClaimsMsg = { type: 'claims-changed' };

function openChannel(onMsg: (m: ClaimsMsg) => void): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel(CLAIMS_CHANNEL);
  ch.onmessage = (e) => onMsg(e.data as ClaimsMsg);
  return ch;
}

class AppStore {
  private state: AppState = {
    ready: false,
    riddles: [],
    records: [],
    claims: [],
    settings: DEFAULT_SETTINGS,
    ctx: EMPTY_CTX,
    selected: new Set<string>(),
  };
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;
  private channel: BroadcastChannel | null = null;

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
        const [riddles, records, claims, settings, ctx] = await Promise.all([
          idb.getAll<Riddle>(idb.STORE_RIDDLES),
          idb.getAll<OnsiteRecord>(idb.STORE_RECORDS),
          idb.getAll<PrizeClaim>(idb.STORE_CLAIMS),
          idb.getKV<AppSettings>(KV_SETTINGS),
          loadDataCtx(import.meta.env.BASE_URL),
        ]);
        this.state.riddles = riddles.sort((a, b) => a.no - b.no);
        this.state.records = records.sort((a, b) => b.at - a.at);
        this.state.claims = claims.sort((a, b) => b.at - a.at);
        if (settings) {
          this.state.settings = {
            event: { ...DEFAULT_SETTINGS.event, ...settings.event },
            print: { ...DEFAULT_SETTINGS.print, ...settings.print },
            prizes: settings.prizes?.length ? settings.prizes : DEFAULT_SETTINGS.prizes,
            redeem: {
              windows: settings.redeem?.windows?.length ? settings.redeem.windows : DEFAULT_SETTINGS.redeem.windows,
              stock: settings.redeem?.stock ?? [],
            },
          };
        }
        if (!this.state.settings.print.hostLine && this.state.settings.event.host) {
          this.state.settings.print.hostLine = `${this.state.settings.event.host}`;
        }
        this.state.ctx = ctx;
        this.state.ready = true;
        // 其他窗口核销变动时，从存储层重新加载核销记录
        this.channel = openChannel((m) => {
          if (m?.type === 'claims-changed') void this.reloadClaims();
        });
        this.emit();
      })();
    }
    return this.initPromise;
  }

  private broadcastClaims(): void {
    try { this.channel?.postMessage({ type: 'claims-changed' } satisfies ClaimsMsg); } catch { /* 忽略 */ }
  }

  private async reloadClaims(): Promise<void> {
    const claims = await idb.getAll<PrizeClaim>(idb.STORE_CLAIMS);
    this.state.claims = claims.sort((a, b) => b.at - a.at);
    this.emit();
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
    // 级联删除该登记的核销记录（若有）
    const linked = this.state.claims.filter((c) => c.recordId === id);
    this.state.claims = this.state.claims.filter((c) => c.recordId !== id);
    await idb.del(idb.STORE_RECORDS, id);
    await Promise.all(linked.map((c) => idb.del(idb.STORE_CLAIMS, c.id)));
    if (linked.length) this.broadcastClaims();
    this.emit();
  }

  async clearRecords(): Promise<void> {
    this.state.records = [];
    this.state.claims = [];
    await idb.clearStore(idb.STORE_RECORDS);
    await idb.clearStore(idb.STORE_CLAIMS);
    this.broadcastClaims();
    this.emit();
  }

  /** 兑奖号码生成：按登记时间顺序补齐 DJ-xxxx（从已有最大编号续号，保证全库唯一） */
  async generatePrizeCodes(): Promise<number> {
    let n = this.state.records.reduce((m, r) => {
      const match = r.code?.match(/^DJ-(\d+)$/);
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    const start = n;
    const sorted = [...this.state.records].sort((a, b) => a.at - b.at);
    for (const r of sorted) {
      if (!r.code) {
        n++;
        r.code = `DJ-${String(n).padStart(4, '0')}`;
        await idb.put(idb.STORE_RECORDS, r);
      }
    }
    if (n > start) this.emit();
    return n - start;
  }

  // ---- 领奖核销 ----
  claimByCode(code: string): PrizeClaim | undefined {
    return this.state.claims.find((c) => c.code === code);
  }

  /**
   * 核销发奖：存储层原子「查重+写入」，两个窗口同时提交也只会有一个成功；
   * 重复核销返回首次领取记录（ok: false）。
   */
  async claimPrize(input: { code: string; recordId: string; riddleId: string; window: string; operator: string }): Promise<
    { ok: true; claim: PrizeClaim } | { ok: false; existing: PrizeClaim | null }
  > {
    const claim: PrizeClaim = { ...input, id: uid(), at: Date.now() };
    const res = await idb.claimOnce(claim);
    if (res.ok) {
      this.state.claims = [claim, ...this.state.claims];
      this.broadcastClaims();
      this.emit();
      return { ok: true, claim };
    }
    // 已被核销（可能发生在其他窗口）：把首次核销记录并入本地状态
    const existing = (res.existing as PrizeClaim | null) ?? this.claimByCode(input.code) ?? null;
    if (existing && !this.state.claims.some((c) => c.code === existing.code)) {
      this.state.claims = [existing, ...this.state.claims];
    }
    this.emit();
    return { ok: false, existing };
  }

  /** 撤销核销（误操作纠正，需页面二次确认） */
  async revokeClaim(id: string): Promise<void> {
    this.state.claims = this.state.claims.filter((c) => c.id !== id);
    await idb.del(idb.STORE_CLAIMS, id);
    this.broadcastClaims();
    this.emit();
  }

  // ---- 设置 ----
  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    this.state.settings = {
      event: { ...this.state.settings.event, ...patch.event },
      print: { ...this.state.settings.print, ...patch.print },
      prizes: patch.prizes ?? this.state.settings.prizes,
      redeem: patch.redeem
        ? {
            windows: patch.redeem.windows ?? this.state.settings.redeem.windows,
            stock: patch.redeem.stock ?? this.state.settings.redeem.stock,
          }
        : this.state.settings.redeem,
    };
    await idb.setKV(KV_SETTINGS, this.state.settings);
    this.emit();
  }

  // ---- 统计 ----
  stats(): { total: number; solved: number; remaining: number; prizes: number; claimed: number } {
    const solvedSet = new Set(this.state.records.map((r) => r.riddleId));
    return {
      total: this.state.riddles.length,
      solved: solvedSet.size,
      remaining: this.state.riddles.length - solvedSet.size,
      prizes: this.state.records.filter((r) => r.prize.trim()).length,
      claimed: this.state.claims.length,
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

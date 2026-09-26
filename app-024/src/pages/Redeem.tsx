// 领奖核销：凭兑奖号码核销发奖，同号仅一次；重复当场拦下并显示首次领取记录；
// 到设定数量先确认再发；收场按奖项与窗口出已领/未领名单
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../ui/router';
import { CATEGORY_LABEL, FORMAT_LABEL, type OnsiteRecord, type Redemption, type Riddle } from '../types';
import { buildRedeemReport, normalizeCode } from '../lib/redeem';
import { stringifyCSV, withBOM } from '../lib/csv';
import { downloadText, formatDateTime } from '../lib/format';
import { exportFileName, store } from '../lib/store';

const LS_WINDOW = 'app-024-redeem-window';
const LS_OPERATOR = 'app-024-redeem-operator';

type Found =
  | { kind: 'ready'; code: string; rec: OnsiteRecord; riddle?: Riddle }
  | { kind: 'already'; code: string; existing: Redemption; riddle?: Riddle };

function lsGet(k: string): string {
  try { return localStorage.getItem(k) ?? ''; } catch { return ''; }
}
function lsSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* 隐私模式忽略 */ }
}

export function Redeem() {
  const state = useAppState();
  const windows = state.settings.redeem.windows.length ? state.settings.redeem.windows : ['1 号窗'];
  const [codeInput, setCodeInput] = useState('');
  const [windowName, setWindowName] = useState(() => lsGet(LS_WINDOW) || state.settings.redeem.windows[0] || '1 号窗');
  // 上次选用的窗口可能已在设置里移除，回退到第一个窗口
  const effectiveWindow = windows.includes(windowName) ? windowName : windows[0];
  const [operator, setOperator] = useState(() => lsGet(LS_OPERATOR));
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [stockConfirm, setStockConfirm] = useState(false); // 达到设定数量，等待二次确认
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const report = useMemo(
    () => buildRedeemReport(state.records, state.redemptions, state.riddles, state.settings.redeem.stockLimits),
    [state.records, state.redemptions, state.riddles, state.settings.redeem.stockLimits],
  );
  const riddleOf = (id: string) => state.riddles.find((r) => r.id === id);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { lsSet(LS_WINDOW, windowName); }, [windowName]);
  useEffect(() => { lsSet(LS_OPERATOR, operator); }, [operator]);

  const showAlready = (code: string, existing?: Redemption) => {
    const riddle = existing ? riddleOf(existing.riddleId) : undefined;
    setFound(existing ? { kind: 'already', code, existing, riddle } : null);
    setMsg(existing
      ? { kind: 'warn', text: `兑奖号码 ${code} 已核销过，请勿重复发奖！首次领取记录见下。` }
      : { kind: 'warn', text: `兑奖号码 ${code} 已核销过，请勿重复发奖！` });
  };

  const lookup = (raw: string) => {
    setStockConfirm(false);
    const code = normalizeCode(raw);
    if (!code) {
      setFound(null);
      setMsg({ kind: 'bad', text: `「${raw.trim() || '空'}」不是有效的兑奖号码，请按谜条上的 DJ-xxxx 格式重新输入` });
      return;
    }
    const rec = state.records.find((r) => r.code === code);
    if (!rec) {
      setFound(null);
      setMsg({ kind: 'bad', text: `兑奖号码 ${code} 查不到对应登记，请核对号码是否输错，或先到「现场登记」生成兑奖号码` });
      return;
    }
    const existing = store.redemptionOf(code);
    if (existing) { showAlready(code, existing); return; }
    setFound({ kind: 'ready', code, rec, riddle: riddleOf(rec.riddleId) });
    setMsg({ kind: 'ok', text: `兑奖号码 ${code} 未核销，请核对猜中者身份后点击「确认核销发奖」` });
  };

  const doRedeem = async () => {
    if (!found || found.kind !== 'ready' || busy) return;
    const prize = found.rec.prize;
    const limit = state.settings.redeem.stockLimits[prize] ?? 0;
    const issued = store.prizeIssued(prize);
    // 某一箱奖品发到设定数量：先确认再继续发
    if (!stockConfirm && limit > 0 && issued >= limit) {
      setStockConfirm(true);
      setMsg({ kind: 'warn', text: `「${prize}」已发出 ${issued} 份，达到设定数量 ${limit}。如确需继续发放，请再次点击「确认继续发放」。` });
      return;
    }
    setBusy(true);
    const res = await store.redeemByCode(found.code, effectiveWindow, operator.trim() || '未留名');
    setBusy(false);
    setStockConfirm(false);
    if (res.ok) {
      const x = res.redemption;
      setFound(null);
      setCodeInput('');
      setMsg({ kind: 'ok', text: `已核销：${x.code} · ${x.prize} · ${x.window} · 经手人 ${x.operator} · ${formatDateTime(x.at)}` });
      inputRef.current?.focus();
    } else if (res.reason === 'already') {
      // 另一窗口抢先核销：拦下并显示首次领取记录
      showAlready(res.code, res.existing);
    } else if (res.reason === 'not-found') {
      setFound(null);
      setMsg({ kind: 'bad', text: `兑奖号码 ${res.code} 查不到对应登记` });
    } else {
      setFound(null);
      setMsg({ kind: 'bad', text: '兑奖号码格式不对，请重新输入' });
    }
  };

  const revoke = async (x: Redemption) => {
    if (!confirm(`确定撤销 ${x.code}（${x.prize}）的核销记录？撤销后该号码可重新核销。`)) return;
    await store.revokeRedemption(x.id);
    setMsg({ kind: 'ok', text: `已撤销 ${x.code} 的核销记录` });
  };

  const exportReport = () => {
    const rows: (string | number)[][] = [['兑奖号码', '谜号', '谜面', '猜中者', '奖项', '状态', '领取时间', '领取窗口', '经手人']];
    for (const x of [...state.redemptions].sort((a, b) => a.code.localeCompare(b.code))) {
      const r = riddleOf(x.riddleId);
      rows.push([x.code, r?.no ?? '', r?.surface ?? '', x.winnerName || '匿名', x.prize, '已领取',
        formatDateTime(x.at), x.window, x.operator]);
    }
    for (const u of report.unclaimed) {
      rows.push([u.code, u.no, u.surface, u.winnerName, u.prize, '未领取', '', '', '']);
    }
    downloadText(exportFileName('领奖核销', 'csv'), withBOM(stringifyCSV(rows)));
  };

  const ready = found?.kind === 'ready' ? found : null;
  const already = found?.kind === 'already' ? found : null;
  const readyLimit = ready ? (state.settings.redeem.stockLimits[ready.rec.prize] ?? 0) : 0;
  const readyIssued = ready ? store.prizeIssued(ready.rec.prize) : 0;

  return (
    <div>
      <div className="page-head">
        <h1>领奖核销</h1>
        <div className="btn-row">
          <button className="btn" onClick={exportReport}>⬇ 导出核销名单 CSV</button>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat"><b>{report.codedTotal}</b><span>已出兑奖号码</span></div>
        <div className="stat stat-ok"><b>{report.issuedTotal}</b><span>已核销领取</span></div>
        <div className="stat"><b>{report.unclaimed.length}</b><span>已出号未领取</span></div>
        <div className="stat"><b>{report.noCodeCount}</b><span>未出号登记</span></div>
      </div>

      {report.noCodeCount > 0 && (
        <p className="msg msg-warn">还有 {report.noCodeCount} 条登记未生成兑奖号码，请先到「现场登记」页点击「生成兑奖号码」。</p>
      )}

      <div className="onsite-grid redeem-grid">
        <div className="panel">
          <h3>核销台</h3>
          <div className="field-row">
            <label className="field"><span>领取窗口</span>
              <select className="input redeem-window" value={effectiveWindow} onChange={(e) => setWindowName(e.target.value)}>
                {windows.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
            <label className="field"><span>经手人</span>
              <input className="input redeem-operator" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="发奖人姓名" />
            </label>
          </div>
          <div className="onsite-input-row">
            <input
              ref={inputRef}
              className="input onsite-no redeem-code"
              type="text"
              placeholder="兑奖号码 DJ-xxxx"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') lookup(codeInput); }}
            />
            <button className="btn btn-primary btn-lg" onClick={() => lookup(codeInput)}>查找</button>
          </div>
          {msg && <p className={`msg msg-${msg.kind}`}>{msg.text}</p>}

          {ready && (
            <div className="onsite-current">
              <div className="onsite-no-big redeem-code-big">{ready.code}</div>
              <div>
                <p className="onsite-surface">
                  谜号 {ready.riddle?.no ?? '?'}：{ready.riddle?.surface ?? '（谜条已删除）'}
                </p>
                <p className="muted">
                  {ready.riddle && (
                    <>（{CATEGORY_LABEL[ready.riddle.category]}
                      {ready.riddle.format !== 'none' ? ` · ${FORMAT_LABEL[ready.riddle.format]}` : ''}）
                      　谜底：<b className="onsite-answer">{ready.riddle.answer}</b>　</>
                  )}
                  奖项：<b>{ready.rec.prize || '（无）'}</b>　猜中者：<b>{ready.rec.winnerName || '匿名'}</b>
                </p>
                <p className="muted small">请核对猜中者身份（回收联 / 姓名）后再发奖。</p>
                {readyLimit > 0 && (
                  <p className={`muted small ${readyIssued >= readyLimit ? 'bad-text' : ''}`}>
                    「{ready.rec.prize}」已发 {readyIssued} / 设定 {readyLimit} 份
                  </p>
                )}
                <div className="btn-row">
                  <button
                    className={`btn btn-lg ${stockConfirm ? 'btn-danger' : 'btn-primary'}`}
                    disabled={busy}
                    onClick={() => void doRedeem()}
                  >
                    {stockConfirm ? '⚠ 确认继续发放（已超设定数量）' : '✓ 确认核销发奖'}
                  </button>
                  {stockConfirm && (
                    <button className="btn btn-lg" onClick={() => { setStockConfirm(false); setMsg({ kind: 'ok', text: '已取消本次发放' }); }}>
                      取消
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {already && (
            <div className="onsite-current redeem-already">
              <div className="onsite-no-big redeem-code-big">{already.code}</div>
              <div>
                <p className="onsite-surface bad-text">该号码已核销，不能重复领奖</p>
                <ul className="dup-list">
                  <li>奖项：{already.existing.prize || '（无）'}　猜中者：{already.existing.winnerName || '匿名'}</li>
                  <li>领取时间：{formatDateTime(already.existing.at)}</li>
                  <li>领取窗口：{already.existing.window}　经手人：{already.existing.operator}</li>
                  {already.riddle && <li>对应谜条：谜号 {already.riddle.no} · {already.riddle.surface}</li>}
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <h3>最近核销（{state.redemptions.length}）</h3>
          {state.redemptions.length === 0 ? (
            <p className="muted">还没有核销记录。</p>
          ) : (
            <div className="table-wrap records-table">
              <table>
                <thead><tr><th>兑奖号</th><th>谜号</th><th>奖项</th><th>窗口</th><th>经手人</th><th>时间</th><th /></tr></thead>
                <tbody>
                  {state.redemptions.slice(0, 30).map((x) => {
                    const r = riddleOf(x.riddleId);
                    return (
                      <tr key={x.id}>
                        <td className="no-cell">{x.code}</td>
                        <td>{r?.no ?? '?'}</td>
                        <td>{x.prize}</td>
                        <td>{x.window}</td>
                        <td>{x.operator}</td>
                        <td className="muted">{formatDateTime(x.at)}</td>
                        <td><button className="btn btn-ghost btn-sm" onClick={() => void revoke(x)}>撤销</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {state.redemptions.length > 30 && <p className="muted">… 仅显示最近 30 条</p>}
            </div>
          )}
        </div>
      </div>

      <div className="panel redeem-report">
        <h3>收场统计（按奖项与窗口）</h3>
        <div className="redeem-report-grid">
          <div>
            <h4>按奖项</h4>
            {report.byPrize.length === 0 ? <p className="muted">暂无数据。</p> : (
              <div className="table-wrap">
                <table className="report-prize-table">
                  <thead><tr><th>奖项</th><th>已领取</th><th>未领取</th><th>设定数量</th></tr></thead>
                  <tbody>
                    {report.byPrize.map((p) => (
                      <tr key={p.prize}>
                        <td>{p.prize}</td>
                        <td>{p.issued}</td>
                        <td>{p.unclaimed}</td>
                        <td>{p.limit > 0 ? p.limit : '不限'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h4>按窗口</h4>
            {report.byWindow.length === 0 ? <p className="muted">暂无核销记录。</p> : (
              <div className="table-wrap">
                <table className="report-window-table">
                  <thead><tr><th>领取窗口</th><th>已核销份数</th></tr></thead>
                  <tbody>
                    {report.byWindow.map((w) => (
                      <tr key={w.window}><td>{w.window}</td><td>{w.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h4>未领取名单（{report.unclaimed.length}）</h4>
            {report.unclaimed.length === 0 ? <p className="muted">已出号的奖项全部领取完毕。</p> : (
              <div className="table-wrap records-table">
                <table className="report-unclaimed-table">
                  <thead><tr><th>兑奖号</th><th>谜号</th><th>谜面</th><th>猜中者</th><th>奖项</th></tr></thead>
                  <tbody>
                    {report.unclaimed.map((u) => (
                      <tr key={u.code}>
                        <td className="no-cell">{u.code}</td>
                        <td>{u.no}</td>
                        <td>{u.surface}</td>
                        <td>{u.winnerName}</td>
                        <td>{u.prize}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 领奖核销：按兑奖号码查谜条与奖项 → 核对身份 → 记下领取时间/窗口/经手人；
// 同一号码只能核销一次（存储层原子保证，双窗口同时操作也拦得住）；
// 达设定数量先确认；收场按奖项与窗口出已领取/未领取名单
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../ui/router';
import { CATEGORY_LABEL, FORMAT_LABEL } from '../types';
import { formatDateTime, downloadText } from '../lib/format';
import { stringifyCSV, withBOM } from '../lib/csv';
import { exportFileName, store } from '../lib/store';
import {
  buildRedeemReport, lookupByCode, normalizeCodeInput, stockConfirmReason,
  REPORT_CSV_HEADERS, reportToRows, type CodeLookup,
} from '../lib/redeem';

const LS_OPERATOR = 'app-024-redeem-operator';
const LS_WINDOW = 'app-024-redeem-window';

export function Redeem() {
  const state = useAppState();
  const [codeInput, setCodeInput] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const [looked, setLooked] = useState<(CodeLookup & { code: string }) | null>(null);
  const [win, setWin] = useState(() => localStorage.getItem(LS_WINDOW) ?? state.settings.redeem.windows[0] ?? '');
  const [operator, setOperator] = useState(() => localStorage.getItem(LS_OPERATOR) ?? '');
  const [verified, setVerified] = useState(false); // 已核对领奖人身份
  const [stockConfirm, setStockConfirm] = useState<string | null>(null); // 待确认的库存闸口提示
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const windows = state.settings.redeem.windows;
  const report = useMemo(
    () => buildRedeemReport(state.records, state.riddles, state.claims),
    [state.records, state.riddles, state.claims],
  );
  const noCodeCount = useMemo(() => state.records.filter((r) => !r.code).length, [state.records]);

  // 当前查到号码的核销记录（可能因其他窗口广播而实时变为已核销）
  const existingClaim = looked ? store.claimByCode(looked.code) : undefined;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { localStorage.setItem(LS_OPERATOR, operator); }, [operator]);
  useEffect(() => { localStorage.setItem(LS_WINDOW, win); }, [win]);

  const lookup = (raw: string) => {
    setStockConfirm(null);
    setVerified(false);
    const code = normalizeCodeInput(raw);
    if (!raw.trim()) { setMsg({ kind: 'bad', text: '请输入兑奖号码' }); setLooked(null); return; }
    if (!code) {
      setMsg({ kind: 'bad', text: `「${raw.trim()}」不是有效的兑奖号码，格式应为 DJ-0001（或直接输入数字编号）` });
      setLooked(null);
      return;
    }
    const hit = lookupByCode(code, state.records, state.riddles);
    if (!hit) {
      setMsg({ kind: 'bad', text: `查不到兑奖号码 ${code}，请核对号码是否输错，或先在「现场登记」生成兑奖号码` });
      setLooked(null);
      return;
    }
    setLooked({ ...hit, code });
    const claim = store.claimByCode(code);
    setMsg(claim
      ? { kind: 'warn', text: `${code} 已领取过，请勿重复发奖（首次领取记录见下）` }
      : { kind: 'ok', text: `${code} 未领取，核对身份后可核销发奖` });
  };

  const doClaim = async (bypassStock = false) => {
    if (!looked || busy) return;
    if (!operator.trim()) { setMsg({ kind: 'bad', text: '请填写经手人' }); return; }
    if (!win.trim()) { setMsg({ kind: 'bad', text: '请选择领取窗口' }); return; }
    // 库存闸口：该奖项发到设定数量时需先确认再继续发
    if (!bypassStock) {
      const reason = stockConfirmReason(looked.record.prize, state.settings.redeem.stock, state.records, state.claims);
      if (reason) { setStockConfirm(reason); return; }
    }
    setStockConfirm(null);
    setBusy(true);
    try {
      const res = await store.claimPrize({
        code: looked.code,
        recordId: looked.record.id,
        riddleId: looked.record.riddleId,
        window: win.trim(),
        operator: operator.trim(),
      });
      if (res.ok) {
        setMsg({ kind: 'ok', text: `${looked.code} 核销成功 · ${looked.record.prize || '（无奖项）'} · ${win.trim()} · ${operator.trim()}` });
        setVerified(false);
        setCodeInput(''); // 清空输入，迎接下一位领奖人
      } else if (res.existing) {
        // 被另一窗口抢先 / 已核销过：当场拦下并显示首次领取记录
        const first = res.existing;
        setMsg({
          kind: 'bad',
          text: `拦下重复核销：${looked.code} 已于 ${formatDateTime(first.at)} 在「${first.window}」由 ${first.operator} 核销，请勿重复发奖`,
        });
      } else {
        setMsg({ kind: 'bad', text: '核销失败：本地存储异常，请重试' });
      }
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const exportReport = () => {
    const csv = stringifyCSV([REPORT_CSV_HEADERS, ...reportToRows(report)]);
    downloadText(exportFileName('领奖核销名单', 'csv'), withBOM(csv));
  };

  return (
    <div>
      <div className="page-head">
        <h1>领奖核销</h1>
        <div className="btn-row">
          <button className="btn" onClick={exportReport} disabled={!report.totalCodes}>⬇ 导出核销名单 CSV</button>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat"><b>{report.totalCodes}</b><span>已生成号码</span></div>
        <div className="stat stat-ok"><b>{report.totalClaimed}</b><span>已领取</span></div>
        <div className="stat"><b>{report.totalUnclaimed}</b><span>未领取</span></div>
      </div>

      {noCodeCount > 0 && (
        <div className="notice">
          有 {noCodeCount} 条登记还没有兑奖号码。
          <button className="btn btn-sm" onClick={() => void store.generatePrizeCodes().then((n) => setMsg({ kind: 'ok', text: `已生成 ${n} 个兑奖号码` }))}>
            立即生成
          </button>
        </div>
      )}

      <div className="redeem-grid">
        <div className="panel">
          <h3>按兑奖号码核销</h3>
          <div className="onsite-input-row">
            <input
              ref={inputRef}
              className="input onsite-no redeem-code"
              type="text"
              placeholder="DJ-0001"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') lookup(codeInput); }}
            />
            <button className="btn btn-primary btn-lg" onClick={() => lookup(codeInput)}>查找</button>
          </div>
          {msg && <p className={`msg msg-${msg.kind}`}>{msg.text}</p>}

          {looked && (
            <div className="onsite-current">
              <div className="redeem-code-big">{looked.code}</div>
              <div style={{ flex: 1 }}>
                <p className="onsite-surface">
                  {looked.riddle ? `谜号 ${looked.riddle.no} · ${looked.riddle.surface}` : '（对应谜条已删除）'}
                </p>
                <p className="muted">
                  {looked.riddle && (
                    <>（{CATEGORY_LABEL[looked.riddle.category]}
                    {looked.riddle.format !== 'none' ? ` · ${FORMAT_LABEL[looked.riddle.format]}` : ''}）　</>
                  )}
                  谜底：<b className="onsite-answer">{looked.riddle?.answer ?? '—'}</b>
                </p>
                <p>
                  奖项：<b>{looked.record.prize || '（未设奖项）'}</b>
                  　猜中者：<b>{looked.record.winnerName || '匿名'}</b>
                  　<span className="muted">登记于 {formatDateTime(looked.record.at)}</span>
                </p>

                {existingClaim ? (
                  <div className="claim-block" role="alert">
                    <p className="claim-block-title">✕ 该号码已领取，请勿重复发奖</p>
                    <ul className="dup-list">
                      <li>首次领取时间：{formatDateTime(existingClaim.at)}</li>
                      <li>领取窗口：{existingClaim.window}</li>
                      <li>经手人：{existingClaim.operator}</li>
                    </ul>
                  </div>
                ) : (
                  <>
                    <div className="field-row">
                      <label className="field"><span>领取窗口</span>
                        <select className="input" value={win} onChange={(e) => setWin(e.target.value)}>
                          {windows.map((w) => <option key={w} value={w}>{w}</option>)}
                          {!windows.includes(win) && win && <option value={win}>{win}</option>}
                        </select>
                      </label>
                      <label className="field"><span>经手人</span>
                        <input className="input" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="发奖人姓名" />
                      </label>
                    </div>
                    <label className="check-inline">
                      <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
                      已核对领奖人身份（{looked.record.winnerName || '匿名'}）
                    </label>
                    {stockConfirm && (
                      <div className="msg msg-warn stock-confirm" role="alert">
                        <p style={{ margin: '0 0 8px' }}>⚠ {stockConfirm}</p>
                        <div className="btn-row">
                          <button className="btn btn-primary" disabled={busy} onClick={() => void doClaim(true)}>确认无误，继续发奖</button>
                          <button className="btn" onClick={() => setStockConfirm(null)}>先不发</button>
                        </div>
                      </div>
                    )}
                    <div className="btn-row" style={{ marginTop: 10 }}>
                      <button
                        className="btn btn-primary btn-lg"
                        disabled={!verified || busy}
                        title={!verified ? '请先勾选「已核对领奖人身份」' : ''}
                        onClick={() => void doClaim(false)}
                      >
                        ✓ 核销发奖
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <h3>核销记录（{state.claims.length}）</h3>
          {state.claims.length === 0 ? (
            <p className="muted">还没有核销记录。</p>
          ) : (
            <div className="table-wrap records-table">
              <table>
                <thead><tr><th>兑奖号</th><th>谜号</th><th>奖项</th><th>窗口</th><th>经手人</th><th>领取时间</th><th /></tr></thead>
                <tbody>
                  {state.claims.slice(0, 30).map((c) => {
                    const rec = state.records.find((r) => r.id === c.recordId);
                    const riddle = state.riddles.find((x) => x.id === c.riddleId);
                    return (
                      <tr key={c.id}>
                        <td className="no-cell">{c.code}</td>
                        <td>{riddle?.no ?? '?'}</td>
                        <td>{rec?.prize ?? ''}</td>
                        <td>{c.window}</td>
                        <td>{c.operator}</td>
                        <td className="muted">{formatDateTime(c.at)}</td>
                        <td>
                          <button
                            className="btn btn-ghost btn-sm"
                            title="撤销核销（误操作纠正）"
                            onClick={() => { if (confirm(`确定撤销 ${c.code} 的核销记录？撤销后该号码可再次核销。`)) void store.revokeClaim(c.id); }}
                          >撤</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {state.claims.length > 30 && <p className="muted">… 仅显示最近 30 条</p>}
            </div>
          )}
        </div>
      </div>

      <div className="panel redeem-report">
        <h3>收场报表 · 按奖项与窗口</h3>
        {report.totalCodes === 0 ? (
          <p className="muted">还没有已生成的兑奖号码，收场报表为空。</p>
        ) : (
          <>
            <div className="report-grid">
              {report.byPrize.map((g) => (
                <div key={g.prize} className="report-group">
                  <h4>{g.prize} <span className="muted small">已领 {g.claimed.length} / 共 {g.claimed.length + g.unclaimed.length}</span></h4>
                  {g.claimed.length > 0 && (
                    <>
                      <p className="small ok-text" style={{ margin: '4px 0' }}>已领取</p>
                      <ul className="report-list">
                        {g.claimed.map((r) => (
                          <li key={r.code}>{r.code} · {r.winnerName} · {r.window} · {r.operator} · {r.claimAt ? formatDateTime(r.claimAt) : ''}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {g.unclaimed.length > 0 && (
                    <>
                      <p className="small warn-text" style={{ margin: '4px 0' }}>未领取</p>
                      <ul className="report-list">
                        {g.unclaimed.map((r) => (
                          <li key={r.code}>{r.code} · {r.winnerName}{r.riddleNo != null ? ` · 谜号 ${r.riddleNo}` : ''}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ))}
              <div className="report-group">
                <h4>按窗口汇总</h4>
                {report.byWindow.length === 0 ? (
                  <p className="muted small">各窗口暂无核销记录。</p>
                ) : (
                  <ul className="report-list">
                    {report.byWindow.map((w) => (
                      <li key={w.window}><b>{w.window}</b>：已发 {w.rows.length} 份（{w.rows.map((r) => r.code).join('、')}）</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

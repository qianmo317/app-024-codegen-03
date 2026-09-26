// 领奖核销 E2E：查号 → 核销 → 重复拦截 / 库存确认 / 双窗口并发 / 收场报表
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, '../../public/samples/riddles.csv');

async function importSample(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type=file]', SAMPLE);
  await expect(page.locator('.panel-import')).toContainText('导入预览');
  await page.click('button:has-text("确认导入")');
  await expect(page.locator('.page-head h1')).toContainText('53 条');
}

/** 现场登记一条猜中记录（默认第一个奖项），返回谜号 */
async function register(page: Page, no: string, winner: string) {
  await page.goto('/#/onsite');
  await page.fill('.onsite-no', no);
  await page.click('button:has-text("查找")');
  await page.fill('.onsite-current input.input >> nth=0', winner);
  await page.click('button:has-text("✓ 登记猜中")');
  await expect(page.locator('.msg-ok')).toContainText('已登记');
}

/** 登记两条记录并生成兑奖号码（DJ-0001、DJ-0002），进入核销页 */
async function seedAndGotoRedeem(page: Page) {
  await importSample(page);
  await register(page, '1', '张三');
  await register(page, '2', '李四');
  await page.click('button:has-text("生成兑奖号码")');
  await expect(page.locator('.msg-ok')).toContainText('已生成 2 个');
  await page.click('nav >> text=领奖核销');
  await expect(page.getByRole('heading', { name: '领奖核销' })).toBeVisible();
}

async function lookupCode(page: Page, code: string) {
  await page.fill('.redeem-code', code);
  await page.click('button:has-text("查找")');
}

async function fillClaimForm(page: Page, operator: string, window_?: string) {
  if (window_) await page.selectOption('.onsite-current select', window_);
  await page.fill('.onsite-current .field input', operator);
  await page.locator('.check-inline input[type=checkbox]').check();
}

/** 统计 IndexedDB 里指定兑奖号码的核销记录条数 */
async function idbClaimCount(page: Page, code: string): Promise<number> {
  return page.evaluate((c) => new Promise<number>((res, rej) => {
    const open = indexedDB.open('app-024-lantern-riddle');
    open.onsuccess = () => {
      const db = open.result;
      try {
        const q = db.transaction('claims', 'readonly').objectStore('claims').getAll();
        q.onsuccess = () => res((q.result as { code: string }[]).filter((x) => x.code === c).length);
        q.onerror = () => rej(q.error);
      } catch (e) { rej(e); }
    };
    open.onerror = () => rej(open.error);
  }), code);
}

test.describe('领奖核销 E2E', () => {
  test('查号 → 核对身份 → 核销成功，重复来领当场拦下并显示首次领取记录', async ({ page }) => {
    await seedAndGotoRedeem(page);
    // 宽松输入：只输数字也能查到
    await lookupCode(page, '1');
    await expect(page.locator('.onsite-current')).toContainText('一口咬掉牛尾巴');
    await expect(page.locator('.onsite-current')).toContainText('参与奖');
    await expect(page.locator('.onsite-current')).toContainText('张三');
    // 未勾选核对身份时按钮不可用
    await expect(page.locator('button:has-text("✓ 核销发奖")')).toBeDisabled();
    await fillClaimForm(page, '小王', '1号窗口');
    await page.click('button:has-text("✓ 核销发奖")');
    await expect(page.locator('.msg-ok')).toContainText('DJ-0001 核销成功');
    await expect(page.locator('.claim-block')).toContainText('1号窗口');
    await expect(page.locator('.claim-block')).toContainText('小王');
    // 同一个人拿着号码再来一次：当场拦下，显示首次领取记录
    await lookupCode(page, 'DJ-0001');
    await expect(page.locator('.msg-warn')).toContainText('已领取过');
    await expect(page.locator('.claim-block')).toContainText('该号码已领取，请勿重复发奖');
    await expect(page.locator('.claim-block')).toContainText('小王');
    await expect(page.locator('button:has-text("✓ 核销发奖")')).toHaveCount(0);
    // 统计与记录
    await expect(page.locator('.stat-ok')).toContainText('1');
    await expect(page.locator('.records-table')).toContainText('DJ-0001');
  });

  test('号码输错或查不到：明确提示', async ({ page }) => {
    await seedAndGotoRedeem(page);
    await page.click('button:has-text("查找")');
    await expect(page.locator('.msg-bad')).toContainText('请输入兑奖号码');
    await lookupCode(page, 'abc');
    await expect(page.locator('.msg-bad')).toContainText('不是有效的兑奖号码');
    await lookupCode(page, 'DJ-9999');
    await expect(page.locator('.msg-bad')).toContainText('查不到兑奖号码 DJ-9999');
  });

  test('某一箱发到设定数量：先确认再继续发', async ({ page }) => {
    await seedAndGotoRedeem(page);
    // 设置「参与奖」一箱 1 份
    await page.click('nav >> text=设置');
    await page.locator('.stock-list li', { hasText: '参与奖' }).locator('input').fill('1');
    await page.click('nav >> text=领奖核销');
    // 第 1 份直接核销（未达设定数量）
    await lookupCode(page, 'DJ-0001');
    await fillClaimForm(page, '小王');
    await page.click('button:has-text("✓ 核销发奖")');
    await expect(page.locator('.msg-ok')).toContainText('核销成功');
    // 第 2 份达到设定数量：先弹确认，点「先不发」则不发
    await lookupCode(page, 'DJ-0002');
    await fillClaimForm(page, '小王');
    await page.click('button:has-text("✓ 核销发奖")');
    await expect(page.locator('.stock-confirm')).toContainText('达到设定数量 1');
    await page.click('button:has-text("先不发")');
    await expect(page.locator('.stock-confirm')).toHaveCount(0);
    expect(await idbClaimCount(page, 'DJ-0002')).toBe(0);
    // 确认后继续发
    await page.click('button:has-text("✓ 核销发奖")');
    await page.click('button:has-text("确认无误，继续发奖")');
    await expect(page.locator('.msg-ok')).toContainText('DJ-0002 核销成功');
    expect(await idbClaimCount(page, 'DJ-0002')).toBe(1);
  });

  test('两个窗口同时核销同一号码：只发一份，慢一拍的当场被拦', async ({ page, context }) => {
    await seedAndGotoRedeem(page);
    const page2 = await context.newPage();
    await page2.goto('/#/redeem');
    await expect(page2.getByRole('heading', { name: '领奖核销' })).toBeVisible();
    // 两个窗口都查到同一号码、各自填好经手人
    await lookupCode(page, 'DJ-0001');
    await fillClaimForm(page, '甲窗');
    await lookupCode(page2, 'DJ-0001');
    await fillClaimForm(page2, '乙窗', '2号窗口');
    // 同时点核销（page2 的按钮可能因广播同步已消失——同样算拦住）
    await Promise.all([
      page.click('button:has-text("✓ 核销发奖")'),
      page2.click('button:has-text("✓ 核销发奖")', { timeout: 5000 }).catch(() => {}),
    ]);
    // 全库该号码只有一条核销记录
    await expect(page.locator('.claim-block')).toBeVisible();
    await expect(page2.locator('.claim-block')).toBeVisible();
    expect(await idbClaimCount(page, 'DJ-0001')).toBe(1);
    // 两页合计恰好一个「核销成功」
    const ok1 = await page.locator('.msg-ok', { hasText: '核销成功' }).count();
    const ok2 = await page2.locator('.msg-ok', { hasText: '核销成功' }).count();
    expect(ok1 + ok2).toBe(1);
    await page2.close();
  });

  test('另一窗口核销后，本窗口即时看到已领取（跨窗口同步）', async ({ page, context }) => {
    await seedAndGotoRedeem(page);
    const page2 = await context.newPage();
    await page2.goto('/#/redeem');
    await lookupCode(page2, 'DJ-0001');
    await expect(page2.locator('button:has-text("✓ 核销发奖")')).toBeVisible();
    // 窗口 1 核销
    await lookupCode(page, 'DJ-0001');
    await fillClaimForm(page, '小王');
    await page.click('button:has-text("✓ 核销发奖")');
    await expect(page.locator('.msg-ok')).toContainText('核销成功');
    // 窗口 2 不刷新页面也即时变为已领取，核销按钮消失
    await expect(page2.locator('.claim-block')).toContainText('该号码已领取', { timeout: 5000 });
    await expect(page2.locator('button:has-text("✓ 核销发奖")')).toHaveCount(0);
    await page2.close();
  });

  test('收场报表：按奖项与窗口给出已领取/未领取名单，可导出 CSV', async ({ page }) => {
    await seedAndGotoRedeem(page);
    await lookupCode(page, 'DJ-0001');
    await fillClaimForm(page, '小王', '1号窗口');
    await page.click('button:has-text("✓ 核销发奖")');
    await expect(page.locator('.msg-ok')).toContainText('核销成功');
    // 报表：参与奖组已领 DJ-0001 / 未领 DJ-0002；窗口汇总 1号窗口
    const report = page.locator('.redeem-report');
    await expect(report).toContainText('已领 1 / 共 2');
    await expect(report.locator('.report-group').first()).toContainText('DJ-0001');
    await expect(report.locator('.report-group').first()).toContainText('DJ-0002');
    await expect(report).toContainText('1号窗口');
    await expect(report).toContainText('小王');
    // 导出 CSV（UTF-8 BOM，含已领取/未领取）
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("导出核销名单 CSV")'),
    ]);
    const buf = readFileSync((await download.path())!);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.toString('utf8');
    expect(text).toContain('奖项,兑奖号码,谜号,谜面,猜中者,状态,领取时间,领取窗口,经手人');
    expect(text).toContain('DJ-0001');
    expect(text).toContain('已领取');
    expect(text).toContain('未领取');
  });

  test('撤销核销后该号码可再次核销', async ({ page }) => {
    await seedAndGotoRedeem(page);
    await lookupCode(page, 'DJ-0001');
    await fillClaimForm(page, '小王');
    await page.click('button:has-text("✓ 核销发奖")');
    await expect(page.locator('.msg-ok')).toContainText('核销成功');
    page.once('dialog', (d) => d.accept());
    await page.locator('.records-table tbody tr').first().locator('button:has-text("撤")').click();
    await expect(page.locator('.claim-block')).toHaveCount(0);
    // 再次查同一号码：恢复为可核销状态
    await lookupCode(page, 'DJ-0001');
    await expect(page.locator('.msg-ok')).toContainText('未领取');
    expect(await idbClaimCount(page, 'DJ-0001')).toBe(0);
  });
});

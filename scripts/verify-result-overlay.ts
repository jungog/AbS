/**
 * 结算浮层自查：手机上「每一局结束都要过一遍」的那张卡片放不放得下。
 *
 * 为什么单独一个脚本、不塞进 `check:viewports`：这个检查要把**整局打完**
 * （几十次点牌 + 等 AI），一轮十几秒；`check:viewports` 只打到「轮到我」就够，
 * 不该为了这一条拖慢四倍。
 *
 * 断的是三件在最小屏上最容易坏的事：
 *   1. 浮层整个在屏幕内（不用滚动就能看到标题和按钮）
 *   2. 「再来一局」在屏内、且点击高度 ≥32px
 *   3. 「调整座位 / 人数」这种文字链接也得 ≥32px（曾经只有 16px）
 */
import { chromium, type Browser, type Page } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640 },
  { name: '390x844', width: 390, height: 844 },
];

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✖ ${label}${detail !== undefined ? ` —— ${String(detail)}` : ''}`);
  }
}

/** 推进一步：选角 → 结束出牌 → 收下/放弃响应 → 选一张牌传出去 */
async function step(p: Page): Promise<boolean> {
  const pick = p.locator('.pick-card').first();
  if ((await pick.count()) > 0) {
    await pick.click().catch(() => undefined);
    return true;
  }
  const hit = async (kw: string): Promise<boolean> => {
    const btn = p.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
    if ((await btn.count()) === 0) return false;
    await btn.first().click().catch(() => undefined);
    return true;
  };
  for (const kw of ['结束出牌', '收下', '放弃响应']) {
    if (await hit(kw)) return true;
  }
  const cards = () => p.locator('.actionbar .hand .card:not(.selected)');
  for (let i = 0; i < 3; i++) {
    if ((await cards().count()) === 0) break;
    await cards().first().click();
    await sleep(100);
    for (const kw of ['传出这张情报', '确认弃牌']) {
      if (await hit(kw)) return true;
    }
  }
  return false;
}

interface OverlayInfo {
  winH: number;
  top: number;
  bottom: number;
  h: number;
  scrollH: number;
  clientH: number;
  primary: { h: number; bottom: number; text: string } | null;
  arrange: { h: number } | null;
  ready: boolean;
}

async function measure(p: Page): Promise<OverlayInfo | null> {
  const info = await p.evaluate(`(() => {
    const res = document.querySelector('.result');
    if (!res) return null;
    const r = res.getBoundingClientRect();
    const btn = document.querySelector('.result-actions .primary');
    const br = btn ? btn.getBoundingClientRect() : null;
    const arr = document.querySelector('.ready-arrange');
    const ar = arr ? arr.getBoundingClientRect() : null;
    return {
      winH: window.innerHeight,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      h: Math.round(r.height),
      scrollH: Math.round(res.scrollHeight),
      clientH: Math.round(res.clientHeight),
      primary: br
        ? { h: Math.round(br.height), bottom: Math.round(br.bottom), text: (btn.textContent || '').trim() }
        : null,
      arrange: ar ? { h: Math.round(ar.height) } : null,
      ready: !!document.querySelector('.ready-row'),
    };
  })()`);
  return info as OverlayInfo | null;
}

async function runViewport(browser: Browser, vp: (typeof VIEWPORTS)[number]): Promise<void> {
  console.log(`\n=== ${vp.name} ===`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill('结算');
  await sleep(500);
  await p.locator('button', { hasText: '创建并进入' }).click();
  await p.waitForSelector('.room-bigcode', { timeout: 15_000 });
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(800);

  let ended = false;
  for (let i = 0; i < 260; i++) {
    if ((await p.locator('.result').count()) > 0) {
      ended = true;
      break;
    }
    await step(p);
    await sleep(200);
  }
  check('一局能打到结算（不是卡在对局里）', ended, ended ? undefined : '260 步之内没出现结算浮层');
  if (!ended) {
    await ctx.close();
    return;
  }
  await sleep(400);

  const info = await measure(p);
  if (!info) {
    check('结算浮层存在', false, '量不到 .result');
    await ctx.close();
    return;
  }

  check(
    '浮层整个在屏幕内（不用滚动就能看到标题和按钮）',
    info.top >= 0 && info.bottom <= info.winH,
    `顶 ${info.top} / 底 ${info.bottom} / 屏高 ${info.winH}`,
  );
  check(
    '浮层自己不需要内部滚动',
    info.scrollH <= info.clientH + 1,
    `内容 ${info.scrollH} / 可视 ${info.clientH}`,
  );
  check(
    '「再来一局」在屏内，且点击高度 ≥32px',
    !!info.primary && info.primary.h >= 32 && info.primary.bottom <= info.winH,
    info.primary ? `${info.primary.text} ${info.primary.h}px / 底 ${info.primary.bottom}` : '找不到主按钮',
  );
  check('结算页有准备进度（再来一局是投票制）', info.ready, info.ready ? undefined : '没有 .ready-row');
  // 「调整座位 / 人数」是文字链接样式的按钮：补 padding + 负 margin 之后才够点
  check(
    '「调整座位 / 人数」点击高度 ≥32px',
    !info.arrange || info.arrange.h >= 32,
    info.arrange ? `${info.arrange.h}px` : '没有这个入口',
  );
  check('结算页没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await p.screenshot({ path: `shots/result-${vp.name}.png` });
  await ctx.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const vp of VIEWPORTS) await runViewport(browser, vp);
  await browser.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`通过 ${passed} 项`);
  console.log('结算浮层自查通过。');
}

void main().catch((err) => {
  console.error('结算浮层自查异常', err);
  process.exit(1);
});

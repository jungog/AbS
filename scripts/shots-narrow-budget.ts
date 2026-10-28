/**
 * 出图：360×640 上「目标条最长」时，第一排座位卡的身份行是否还露在操作区上面。
 *
 * 这张图是给 `check:viewports` 里那条断言做肉眼佐证的：
 * 目标条的高度是内容驱动的（短任务 46px / 最长任务 62px），
 * 而矮屏的纵向预算刚好卡在这条线上 —— 数字上通过了，也得看一眼是不是真的能读。
 *
 * 两个必须踩过的坑：
 * 1. **注入和测量要在同一个 `evaluate` 里**。分两步的话，React 先重渲染把注入的
 *    文案覆盖回去，量到的还是原来那条短任务（实测量出 45px，比最长的那条矮 17px，
 *    数字看着「通过」，其实是假绿）。
 * 2. **截图时要把 JS 冻住**。倒计时环每秒重渲染一次，`screenshot` 是一次独立的
 *    CDP 调用（几十毫秒），落在那 1 秒边界上就会拍到还原后的样子。
 *    用 `Emulation.setScriptExecutionDisabled` 关掉脚本执行，DOM 定格，
 *    拍完再打开 —— 截图和数字才保证是同一帧。
 *
 * `npm run shots:budget`
 */
import { chromium, type Page } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 引擎里最长的一条机密任务（core/tasks.ts 的 noBlackWith，count 取上限） */
const WORST_TASK_TEXT = '对局结束时，你面前有 6 张情报，且一张黑色情报都没有。';

async function enterBattle(p: Page): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill('视口');
  await sleep(400);
  await p.locator('button', { hasText: '创建并进入' }).click();
  await p.waitForSelector('.room-bigcode', { timeout: 15_000 });
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(700);

  const pick = p.locator('.pick-card').first();
  if ((await pick.count()) > 0) await pick.click({ timeout: 5000 }).catch(() => {});

  for (let i = 0; i < 40; i++) {
    const has = await p.evaluate(() => {
      const b = document.querySelector('.actionbar:not(.waiting)');
      return !!b && !!b.querySelector('.hand');
    });
    if (has) return;
    await sleep(400);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const p = await ctx.newPage();
  await enterBattle(p);

  // 注入 + 测量放在同一个 evaluate 里（坑 1）。整句替换，不是只换 <b> 里的字：
  // 颜色阵营的句式是「目标：面前集齐 ___」，只塞任务正文会拼出读不通的句子。
  const geo = (await p.evaluate(`(() => {
    const m = document.querySelector('.battle-main');
    if (m) m.scrollTop = 0;

    const goal = document.querySelector('.goalbar');
    const main = document.querySelector('.goal-main');
    if (main) main.innerHTML = '机密任务：<b>' + ${JSON.stringify(WORST_TASK_TEXT)} + '</b>';
    // 特工的目标条比颜色阵营多一行「或集齐 N 张真情报」。抽到的不是特工时这行不存在，
    // 不补的话拍出来的是「军情局 + 长任务」（45px），比真实的特工形态矮 17px —— 假的最坏情况。
    const ALT_TEXT = '或集齐 6 张真情报（红蓝皆可）· 当前 0/6';
    const alt = document.querySelector('.goal-alt');
    if (alt) {
      alt.textContent = ALT_TEXT;
    } else if (goal) {
      const el = document.createElement('span');
      el.className = 'goal-alt';
      el.textContent = ALT_TEXT;
      goal.appendChild(el);
    }

    const bar = document.querySelector('.actionbar:not(.waiting)');
    const card = document.querySelector('.pcard');
    const ch = card ? card.querySelector('.pcard-char') : null;
    const barTop = bar ? bar.getBoundingClientRect().top : -1;
    return {
      goal: goal ? Math.round(goal.getBoundingClientRect().height) : -1,
      barTop: barTop === -1 ? -1 : Math.round(barTop),
      charBottom: ch ? Math.round(ch.getBoundingClientRect().bottom) : -1,
      slack: ch && barTop !== -1 ? Math.round(barTop - 4 - ch.getBoundingClientRect().bottom) : -1,
    };
  })()`)) as { goal: number; barTop: number; charBottom: number; slack: number };

  // 冻结脚本执行再截图（坑 2）：倒计时的每秒重渲染不会插进来。
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
  try {
    await p.screenshot({ path: 'shots/narrow-worst-task.png' });
  } finally {
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
  }

  console.log('shots/narrow-worst-task.png', JSON.stringify(geo));
  if (geo.slack < 8) {
    console.error(`身份行余量只有 ${geo.slack}px（要求 ≥8px），这张图不能当「通过」的佐证`);
    process.exitCode = 1;
  }
  await browser.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

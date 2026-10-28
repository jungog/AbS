/**
 * 观众视角自查：观战者在手机上到底看得到什么。
 *
 * 为什么单独一个脚本：`check:viewports` 和 `check:result` 都只覆盖玩家 ——
 * 玩家有操作区、手牌条、机密任务条，观众一样都没有，走的是另一套分支
 * （SpectatorPanel + 只读状态条）。这套分支从来没被量过。
 *
 * 断的是五件观众专属的事：
 *   1. 房间条不折行。实测 360 宽下「房间号 + 观战中 + 延迟 + 退出」要 384px、
 *      可用只有 324px，必然折行；而折不折取决于「延迟」这颗晚到的 pill，
 *      于是进入观战 1 秒后整块内容会往下跳 28px。
 *   2. 状态条写着「当时」。观众看到的是落后 N 轮的旧画面，
 *      不写「当时」就是把旧局面说成现在 —— 观众没有操作区，
 *      也没法靠「我能不能出牌」反推时态。
 *   3. 状态条带阶段。玩家的阶段靠操作区按钮文案体现，观众什么都没有。
 *   4. 观战面板够得着。竖屏上它在 4 张座位卡下面，必须滚到底能看到完整一块。
 *   5. 观众不该出现玩家的东西：操作区 / 手牌条 / 机密任务条。
 *
 * 前置：npm run build && npm run server，然后 npm run check:spectator
 *      ABS_URL 可覆盖地址，默认打 8787 的生产构建
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: 'small', width: 360, height: 640, label: '小屏安卓 360×640' },
  { name: 'mobile', width: 390, height: 844, label: '手机竖屏 390×844' },
  { name: 'landscape', width: 844, height: 390, label: '手机横屏 844×390' },
];

/** 阶段文案的白名单，和 SpectatorPanel 的 PHASE_TEXT 保持一致 */
const PHASES = [
  '正在选角',
  '出牌阶段',
  '情报阶段',
  '接收决策',
  '响应窗口',
  '弃牌阶段',
  '对局结束',
  '对局进行中',
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

/** 房主：建房 → 开局。观众要进的是「对局中」的房间 */
async function hostStartsGame(
  browser: Browser,
  vp: { width: number; height: number },
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; p: Page }> {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill('房主');
  await sleep(400);
  await p.locator('button', { hasText: '创建并进入' }).click();
  await p.waitForSelector('.room-bigcode', { timeout: 15_000 });
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(600);
  return { ctx, p };
}

/** 观众：大厅里点「观战」 */
async function joinAsSpectator(
  browser: Browser,
  vp: { width: number; height: number },
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; p: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill('观众');
  await sleep(500);
  const btn = p.locator('.room-row button', { hasText: '观战' }).first();
  await btn.waitFor({ timeout: 10_000 });
  await btn.click();
  await p.waitForSelector('.spectator-panel', { timeout: 20_000 });
  return { ctx, p, errors };
}

interface SpecInfo {
  winH: number;
  winW: number;
  roomStrip: { h: number; text: string };
  specPill: { top: number; bottom: number; text: string } | null;
  quit: { w: number; h: number; top: number; bottom: number } | null;
  status: { h: number; rows: number; text: string; first: string };
  panel: { top: number; bottom: number; h: number } | null;
  hasActionbar: boolean;
  hasHandStrip: boolean;
  hasGoalbar: boolean;
  hScroll: boolean;
  /** 对局页顶部那条需要手动点「知道了」的横幅（观战不该有） */
  notice: { h: number; text: string } | null;
}

async function measure(p: Page): Promise<SpecInfo> {
  const info = await p.evaluate(`(() => {
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        h: Math.round(r.height),
        w: Math.round(r.width),
      };
    };
    const txt = (e) => (e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : '');
    const strip = document.querySelector('.room-strip');
    const sb = document.querySelector('.battle-main > .statusbar:not(.room-strip)');
    const pill = Array.from(document.querySelectorAll('.room-strip .pill')).find((e) =>
      (e.textContent || '').includes('观战中'),
    );
    const quit = Array.from(document.querySelectorAll('.room-strip button')).find((b) =>
      (b.textContent || '').includes('退出观战'),
    );
    const panel = document.querySelector('.spectator-panel');
    // 状态条行数：状态条里全是同高的 pill，按 top 去重即可
    const rows = sb
      ? new Set(Array.from(sb.children).map((c) => Math.round(c.getBoundingClientRect().top))).size
      : 0;
    return {
      winH: window.innerHeight,
      winW: window.innerWidth,
      roomStrip: strip ? { h: Math.round(strip.getBoundingClientRect().height), text: txt(strip) } : { h: -1, text: '' },
      specPill: pill ? rect(pill) : null,
      quit: quit ? rect(quit) : null,
      status: sb
        ? {
            h: Math.round(sb.getBoundingClientRect().height),
            rows,
            text: txt(sb),
            first: txt(sb.children[0]),
          }
        : { h: -1, rows: -1, text: '', first: '' },
      panel: panel ? rect(panel) : null,
      hasActionbar: !!document.querySelector('.actionbar'),
      hasHandStrip: !!document.querySelector('.hand-strip'),
      hasGoalbar: !!document.querySelector('.goalbar'),
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      notice: document.querySelector('.battle-notice')
        ? {
            h: Math.round(document.querySelector('.battle-notice').getBoundingClientRect().height),
            text: txt(document.querySelector('.battle-notice')),
          }
        : null,
    };
  })()`);
  return info as SpecInfo;
}

/** 滚到底再看面板：竖屏上面板在座位卡下面，横屏上是固定在右栏的，滚不动也无所谓 */
async function panelAfterScroll(p: Page): Promise<{ top: number; bottom: number; h: number } | null> {
  return p.evaluate(`(() => {
    const main = document.querySelector('.battle-main');
    if (main) main.scrollTop = main.scrollHeight;
    const el = document.querySelector('.spectator-panel');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
  })()`);
}

async function runViewport(browser: Browser, vp: (typeof VIEWPORTS)[number]): Promise<void> {
  console.log(`\n=== ${vp.label} ===`);
  const host = await hostStartsGame(browser, vp);
  const viewer = await joinAsSpectator(browser, vp);

  // 关键前提：等房主那边「延迟」已经测出来。
  // 观众的房间条曾经因为「延迟」这颗晚到的 pill 而折行 —— 折行与否取决于它到没到，
  // 所以必须等到「它该到了」的时刻再量，否则量到的是折行前的假象。
  await host.p
    .waitForFunction(
      `!!Array.from(document.querySelectorAll('.room-strip .pill')).find(e => (e.textContent || '').includes('延迟'))`,
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  await sleep(500);

  const info = await measure(viewer.p);

  // 1. 房间条不折行。一行 33px；折成两行是 61px（矮屏）/73px（常规字号）
  check(
    '房间条只有一行（延迟已经测出来了也不折）',
    info.roomStrip.h > 0 && info.roomStrip.h <= 40,
    `高 ${info.roomStrip.h}px / ${info.roomStrip.text}`,
  );

  // 2. 观战中标记在屏内 —— 观众唯一能确认「我在观战」的地方
  check(
    '「观战中」标记在屏内',
    !!info.specPill && info.specPill.top >= 0 && info.specPill.bottom <= info.winH,
    info.specPill ? `${info.specPill.text} 顶 ${info.specPill.top} 底 ${info.specPill.bottom}` : '找不到',
  );

  // 2b. 不许再弹「已进入观战」那条横幅。
  //
  // 它和上面那颗常驻 pill 说的是同一件事，却要多占 53px + 22px 外边距，
  // 而且要手动点「知道了」才收回去 —— 小屏上（日志区只有 62px）这笔账不划算。
  // 实测去掉后 `.battle-main` 的 scrollHeight 669 → 594，第 3 张座位卡
  // 从贴着容器底边（540/540）上移到 465。
  check(
    '不弹「已进入观战」横幅（常驻 pill 已经说全了）',
    info.notice === null,
    info.notice ? `横幅「${info.notice.text}」高 ${info.notice.h}px` : undefined,
  );

  // 3. 退出观战要够得着、点得动
  check(
    '「退出观战」在屏内且点击高度 ≥32px',
    !!info.quit && info.quit.h >= 32 && info.quit.top >= 0 && info.quit.bottom <= info.winH,
    info.quit ? `${info.quit.w}×${info.quit.h} 底 ${info.quit.bottom}` : '找不到',
  );

  // 4. 时态：观众看的是旧画面，第一颗 pill 必须写「当时」
  check(
    '状态条第一颗 pill 写着「当时」（不把旧局面说成现在）',
    info.status.first.includes('当时'),
    info.status.first,
  );

  // 5. 阶段：观众没有操作区，阶段只能由状态条给
  const phase = PHASES.find((x) => info.status.text.includes(x));
  check('状态条带当前阶段（观众没有操作区可看）', !!phase, `阶段 ${phase ?? '缺失'} / ${info.status.text}`);

  // 6. 矮屏上状态条必须压在一行里 —— 高度预算最紧的两档
  if (vp.height <= 700) {
    check('矮屏上状态条只有一行', info.status.rows === 1, `${info.status.rows} 行 / 高 ${info.status.h}px`);
  }

  // 7-9. 观众不该有玩家的东西
  check('观众没有操作区', !info.hasActionbar, info.hasActionbar ? '出现了 .actionbar' : undefined);
  check('观众没有手牌条', !info.hasHandStrip, info.hasHandStrip ? '出现了 .hand-strip' : undefined);
  check('观众没有机密任务条（他没有身份）', !info.hasGoalbar, info.hasGoalbar ? '出现了 .goalbar' : undefined);

  // 10. 滚到底，观战面板要完整在屏内（不是被容器裁掉）
  const panel = await panelAfterScroll(viewer.p);
  check(
    '滚到底后观战面板完整可见',
    !!panel && panel.top >= 0 && panel.bottom <= info.winH && panel.h > 60,
    panel ? `顶 ${panel.top} 底 ${panel.bottom} 高 ${panel.h} / 屏高 ${info.winH}` : '量不到面板',
  );

  // 11. 横向溢出（手机上最常见的坏法）
  check('没有横向溢出', !info.hScroll, info.hScroll ? `doc ${info.winW}` : undefined);

  // 12. 控制台
  check('没有控制台报错', viewer.errors.length === 0, viewer.errors.slice(0, 3).join(' | '));

  await viewer.p.evaluate(`(() => { const m = document.querySelector('.battle-main'); if (m) m.scrollTop = 0; })()`);
  await sleep(200);
  await viewer.p.screenshot({ path: `${OUT}/spectator-${vp.name}.png` });
  console.log(`  · ${OUT}/spectator-${vp.name}.png`);

  await viewer.ctx.close();
  await host.ctx.close();
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
  console.log('观众视角自查通过。');
}

void main().catch((err) => {
  console.error('观众视角自查异常', err);
  process.exit(1);
});

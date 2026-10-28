/**
 * 弃牌阶段自查：手机上「手牌超上限、要挑几张扔掉」那一下。
 *
 * 为什么单独一个脚本：弃牌是唯一一个「多选 + 计数 + 确认按钮」同时出现的状态，
 * 而 `check:viewports` 只量到「轮到我」、`check:result` 只量结算浮层。
 *
 * 用**本地对局**而不是联机：本地 AI 的思考间隔可以调到 80ms，一局几秒钟，
 * 撞不到弃牌就重开一局，比联机（每步 300ms + 网络往返）快一个数量级。
 *
 * 断的是六件事（360×640 实测过的坑）：
 *   1. 「弃牌阶段」不被挤成两行（曾经是「弃牌阶」/「段」，和顶栏 tab 同类失败）
 *   2. 标题只占一行（「已选 X / N」挪出标题后，prompt 才放得下）
 *   3. 「已选 X / N」贴在确认按钮旁边，选够了变金色
 *   4. 确认按钮在屏内、≥32px，选够张数才能点
 *   5. 手牌是单排（换行会让操作区高到盖死牌板）
 *   6. 选中的手牌不被手牌条裁掉（`overflow-x: auto` 会把纵向也变成 auto，
 *      选中态 `translateY(-4px)` 抬起的那几像素会被容器上沿切掉，连点都点不中）
 *
 * 前置：npm run build && npm run server，然后 npm run check:discard
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: 'small', width: 360, height: 640 },
  { name: 'mobile', width: 390, height: 844 },
];

/** 一局最多推多少步（本地 3 人局，几百步足够打完） */
const MAX_STEPS = 400;
/** 一局没撞到弃牌就重开，最多几局 */
const MAX_GAMES = 4;

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

/** 开一局本地对局。
 *
 * 用**热座**（所有座位都由这一双手操作）而不是「单人 + AI」：
 * AI 局里对局什么时候结束不受控，实测只有约 1/3 的局能撑到我的手牌超过上限，
 * 靠重开来撞就是「十次红两次」。
 * 热座里每个座位都等我点，而且可以一直拒收把局面拖住 —— 没人凑齐 3 张情报，
 * 对局就不会结束，手牌照样每回合 +1（摸 2 传 1），于是弃牌一定会来。
 */
async function startLocalGame(p: Page): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.launch', { timeout: 20_000 });
  await p.locator('.mode-card', { hasText: '热座' }).click();
  const selects = p.locator('.launch select');
  await selects.nth(0).selectOption('3');
  await p.locator('.launch button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(300);
}

/** 推进一步。刻意不点「确认弃牌」—— 那是要量的状态。
 *  返回「这一步有没有真的做成一件事」，调用方据此判断该不该继续推进。 */
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
  // 拒收优先：收下黑色情报三次就出局，出局之后再也没有自己的回合，也就等不到弃牌
  for (const kw of ['结束出牌', '拒收', '收下', '放弃响应']) {
    if (await hit(kw)) return true;
  }
  const cards = () => p.locator('.actionbar .hand .card:not(.selected)');
  if ((await cards().count()) > 0) {
    await cards().first().click().catch(() => undefined);
    await sleep(80);
    if (await hit('传出这张情报')) return true;
  }
  return false;
}

const inDiscard = (p: Page) =>
  p.evaluate(`(() => {
    const a = document.querySelector('.actionbar');
    return !!a && (a.textContent || '').includes('弃牌阶段');
  })()`);

const gameOver = (p: Page) => p.evaluate(`!!document.querySelector('.result')`);

interface Info {
  winH: number;
  bar: { top: number; bottom: number; h: number } | null;
  barNeedScroll: number;
  title: { h: number; lh: number } | null;
  strong: { h: number; w: number; text: string } | null;
  counter: { top: number; bottom: number; text: string; cls: string } | null;
  btn: { top: number; bottom: number; h: number; w: number; disabled: boolean; text: string } | null;
  hand: { h: number; rows: number; cards: number; scrollNeed: number } | null;
  clipped: number;
  hScroll: boolean;
}

const measure = (p: Page) =>
  p.evaluate(`(() => {
    const r = (e) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) };
    };
    const bar = document.querySelector('.actionbar');
    const hand = document.querySelector('.actionbar .hand');
    const title = document.querySelector('.actionbar .actionbar-title');
    const strong = document.querySelector('.actionbar-title strong');
    const counter = document.querySelector('.actionbar .sel-count');
    const btn = Array.from(document.querySelectorAll('.actionbar button')).find((b) =>
      (b.textContent || '').includes('确认弃牌'),
    );
    const cards = Array.from(document.querySelectorAll('.actionbar .hand .card'));
    const cardH = cards.length ? cards[0].getBoundingClientRect().height : 0;
    const hb = hand ? hand.getBoundingClientRect() : null;
    // 被容器裁掉的卡：选中态 translateY(-4px) 之后会越过容器上沿
    const clipped = hb
      ? cards.filter((c) => {
          const b = c.getBoundingClientRect();
          return b.top < hb.top - 0.5 || b.bottom > hb.bottom + 0.5;
        }).length
      : 0;
    return {
      winH: window.innerHeight,
      bar: r(bar),
      barNeedScroll: bar ? bar.scrollHeight - bar.clientHeight : -1,
      title: title ? { h: Math.round(title.getBoundingClientRect().height), lh: parseFloat(getComputedStyle(title).lineHeight) || 20 } : null,
      strong: strong ? { ...r(strong), text: (strong.textContent || '').trim() } : null,
      counter: counter ? { ...r(counter), text: (counter.textContent || '').trim(), cls: counter.className } : null,
      btn: btn ? { ...r(btn), disabled: btn.disabled, text: (btn.textContent || '').trim() } : null,
      hand: hand
        ? {
            h: Math.round(hand.getBoundingClientRect().height),
            rows: cardH ? Math.round(hand.clientHeight / cardH) : 0,
            cards: cards.length,
            scrollNeed: hand.scrollWidth - hand.clientWidth,
          }
        : null,
      clipped,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  })()`) as Promise<Info>;

async function runViewport(browser: Browser, vp: (typeof VIEWPORTS)[number]): Promise<void> {
  console.log(`\n=== ${vp.width}×${vp.height} ===`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  let info: Info | null = null;
  for (let g = 1; g <= MAX_GAMES && !info; g++) {
    await startLocalGame(p);
    let hit = false;
    for (let i = 0; i < MAX_STEPS; i++) {
      if (await inDiscard(p)) {
        hit = true;
        break;
      }
      if (await gameOver(p)) break;
      await step(p);
      await sleep(70);
      // 弃牌提示是「结束回合」之后才出现的，推进一步后要立刻再看一次，
      // 否则会被下一轮 step 里的「点牌」吃掉
      if (await inDiscard(p)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      await sleep(250);
      info = await measure(p);
      console.log(`  （第 ${g} 局撞到弃牌）`);
    } else {
      console.log(`  （第 ${g} 局没撞到弃牌，重开）`);
    }
  }

  check(`能走到弃牌阶段（${MAX_GAMES} 局以内）`, !!info, info ? undefined : '一局都没出现弃牌提示');
  if (!info) {
    await ctx.close();
    return;
  }

  // 1. 阶段名不能被挤成两行
  check(
    '「弃牌阶段」没有被挤成两行',
    !!info.strong && info.strong.h <= (info.title?.lh ?? 20) * 1.3,
    info.strong ? `高 ${info.strong.h}px / 行高 ${info.title?.lh} / ${info.strong.text}` : '找不到阶段名',
  );

  // 2. 标题一行放得下（prompt + 阶段名）
  check(
    '标题只占一行',
    !!info.title && info.title.h <= info.title.lh * 1.5,
    info.title ? `高 ${info.title.h}px / 行高 ${info.title.lh}` : '量不到标题',
  );

  // 3. 「已选 X / N」和确认按钮在同一行
  check(
    '「已选 X / N」贴在确认按钮旁边（同一行）',
    !!info.counter && !!info.btn && Math.abs(info.counter.top - info.btn.top) < 14,
    info.counter && info.btn ? `计数 ${info.counter.top} / 按钮 ${info.btn.top}` : '找不到计数或按钮',
  );

  // 4. 按钮在屏内、够大、选不够张数时不可点
  check(
    '确认按钮在屏内且点击高度 ≥32px',
    !!info.btn && info.btn.h >= 32 && info.btn.top >= 0 && info.btn.bottom <= info.winH,
    info.btn ? `${info.btn.w}×${info.btn.h} 底 ${info.btn.bottom} / 屏高 ${info.winH}` : '找不到按钮',
  );
  check(
    '还没选牌时按钮不可点（选够才让确认）',
    !!info.btn && info.btn.disabled,
    info.btn ? `disabled=${info.btn.disabled}` : undefined,
  );

  // 5. 手牌单排
  check(
    '手牌是单排（换行会把操作区撑高到盖死牌板）',
    !!info.hand && info.hand.rows === 1,
    info.hand ? `${info.hand.cards} 张 / ${info.hand.rows} 行 / 高 ${info.hand.h}px` : '量不到手牌',
  );

  // 6. 操作区自己不需要内部滚动
  check('操作区不需要内部滚动', info.barNeedScroll <= 1, `还要滚 ${info.barNeedScroll}px`);

  // 7. 选够张数：按钮变可用、计数变金色、卡片不被裁。
  //    **不能写死「选一张」**：要弃几张取决于手牌超了几张（手牌 7 张时 need=1，
  //    8 张时 need=2），写死一张就会在 need=2 的局里报「按钮没变可用」——
  //    实测红过一次（已选 1 / 2）。所以先读 need，再点够它。
  const need = (await p.evaluate(`(() => {
    const c = document.querySelector('.actionbar .sel-count');
    const m = c && (c.textContent || '').match(/\\/\\s*(\\d+)/);
    return m ? Number(m[1]) : 1;
  })()`)) as number;
  for (let i = 0; i < need; i++) {
    await p.locator('.actionbar .hand .card:not(.selected)').first().click();
    await sleep(120);
  }
  await sleep(200);
  const picked = await measure(p);
  check(
    `选够 ${need} 张后按钮变可用`,
    !!picked.btn && !picked.btn.disabled,
    picked.btn ? `disabled=${picked.btn.disabled} / ${picked.counter?.text}` : undefined,
  );
  check(
    '选够了计数变金色（.sel-count.ok）',
    !!picked.counter && picked.counter.cls.includes('ok'),
    picked.counter ? `${picked.counter.text} / ${picked.counter.cls}` : undefined,
  );
  check(
    '选中的手牌没有被手牌条裁掉',
    picked.clipped === 0,
    `被裁 ${picked.clipped} 张（选中态是 translateY(-4px)，容器 overflow 会切掉上沿）`,
  );

  check('没有横向溢出', !info.hScroll);
  check('没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await p.screenshot({ path: `${OUT}/discard-${vp.name}.png` });
  console.log(`  · ${OUT}/discard-${vp.name}.png`);
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
  console.log('弃牌阶段自查通过。');
}

void main().catch((err) => {
  console.error('弃牌阶段自查异常', err);
  process.exit(1);
});

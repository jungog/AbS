/**
 * 响应窗口自查：别人传出情报时，手机上的「截获 / 识破」那一下。
 *
 * 为什么单独一个脚本：响应窗口是**全游戏最挤的状态** ——
 * 它同时要放阶段名、提示句、可选的牌、两个按钮，还要把牌板留在屏幕上。
 * `check:viewports` 量的是「轮到我」和「等别人」，`check:discard` 量的是弃牌，
 * 都不覆盖这里。
 *
 * 用**本地热座 3 人局**：响应窗口的归属由引擎按手牌决定，
 * 「单人 + AI」里实测 260 步一次都没轮到玩家 0（都派给 AI 了），
 * 热座里所有座位都是这一双手，窗口必然停在这儿。
 *
 * 断的是七件事（360×640 实测过的坑）：
 *   1. 提示句只出现一次（`description` 曾是 `prompt` 的严格前缀，
 *      两行都在说「有情报正在传递」，白占 28px —— 牌板因此只剩 3px）
 *   2. 「截获响应 / 识破响应」不被挤成两行（和顶栏 tab、弃牌阶段同类失败）
 *   3. 标题最多两行（阶段名不许折，提示句最多折一次）
 *   4. 操作区自己不需要内部滚动
 *   5. 「放弃响应」在屏内、点击高度 ≥32px
 *   6. 牌板还剩得下一块（操作区不能把牌板盖死）
 *   7. 选中一张能用的牌后，「使用【X】」和「放弃响应」同一行，
 *      不许因为多出一个按钮就把操作区再撑高一截
 *
 * 前置：npm run build && npm run server，然后 npm run check:response
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

/** 一局最多推多少步 */
const MAX_STEPS = 400;
/** 一局没撞到响应窗口就重开，最多几局 */
const MAX_GAMES = 4;

let passed = 0;
let skipped = 0;
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

function skip(label: string, why: string): void {
  skipped++;
  console.log(`  · 跳过「${label}」：${why}`);
}

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

/** 推进一步。刻意不点「放弃响应」—— 那是要量的状态。 */
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
  // 收下情报最容易把对局推向结束（黑情报收三次出局），
  // 所以先「收下」再「结束出牌」，把局面拖长一点好撞响应窗口。
  for (const kw of ['收下', '结束出牌', '拒收']) {
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

const inResponse = (p: Page) =>
  p.evaluate(`(() => {
    const s = document.querySelector('.actionbar .actionbar-title strong');
    const t = s ? (s.textContent || '').trim() : '';
    return t === '截获响应' || t === '识破响应';
  })()`);

const gameOver = (p: Page) => p.evaluate(`!!document.querySelector('.result')`);

interface Info {
  winH: number;
  bar: { top: number; bottom: number; h: number } | null;
  barNeedScroll: number;
  title: { h: number; lh: number } | null;
  strong: { h: number; text: string } | null;
  hint: string;
  desc: string | null;
  dup: boolean;
  btns: { t: string; top: number; bottom: number; h: number; w: number; disabled: boolean }[];
  hand: { cards: number; rows: number; h: number } | null;
  seatVisible: number | null;
  seatH: number | null;
  /** 牌板上每张座位卡：是否完整露在操作区上方 */
  seats: { h: number; fully: boolean }[];
  boardBottom: number | null;
  /** 纵向栈：滚动位置 + 每一块占多高。seatVisible 会随滚动位置变，量清楚才好判断。 */
  stack: Record<string, number | null>;
  hScroll: boolean;
}

const measure = (p: Page) =>
  p.evaluate(`(() => {
    const r = (e) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) };
    };
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const bar = document.querySelector('.actionbar');
    const title = document.querySelector('.actionbar .actionbar-title');
    const strong = document.querySelector('.actionbar .actionbar-title strong');
    const hintEl = document.querySelector('.actionbar .actionbar-title .hint');
    // description 是 .actionbar 的直接子节点 .hint（不在 .actionbar-title 里）
    const descEl = bar ? Array.from(bar.children).find((c) => c.classList.contains('hint')) : null;
    const btns = Array.from(document.querySelectorAll('.actionbar button')).map((b) => ({
      t: norm(b.textContent),
      ...r(b),
      disabled: b.disabled,
    }));
    const hand = document.querySelector('.actionbar .hand');
    const cards = hand ? Array.from(hand.querySelectorAll('.card')) : [];
    const cardH = cards.length ? cards[0].getBoundingClientRect().height : 0;
    // 牌板还剩多少：座位卡被吸底操作区盖住之前露出来的高度
    const seat = document.querySelector('.board > *');
    const sb = seat ? seat.getBoundingClientRect() : null;
    const bb = bar ? bar.getBoundingClientRect() : null;
    const hintText = norm(hintEl ? hintEl.textContent : '');
    const descText = descEl ? norm(descEl.textContent) : '';
    return {
      winH: window.innerHeight,
      bar: r(bar),
      barNeedScroll: bar ? bar.scrollHeight - bar.clientHeight : -1,
      title: title ? { h: Math.round(title.getBoundingClientRect().height), lh: parseFloat(getComputedStyle(title).lineHeight) || 20 } : null,
      strong: strong ? { h: Math.round(strong.getBoundingClientRect().height), text: norm(strong.textContent) } : null,
      hint: hintText,
      desc: descText || null,
      // 重复判定：desc 整句被 hint 包含（hint 就是 desc 加一句「是否使用…」）
      dup: !!descText && hintText.includes(descText),
      btns,
      hand: hand ? { cards: cards.length, rows: cardH ? Math.round(hand.clientHeight / cardH) : 0, h: Math.round(hand.getBoundingClientRect().height) } : null,
      seatVisible: sb && bb ? Math.round(Math.min(sb.bottom, bb.top) - sb.top) : null,
      seatH: sb ? Math.round(sb.height) : null,
      seats: Array.from(document.querySelectorAll('.board > *')).map((e) => {
        const b = e.getBoundingClientRect();
        return { h: Math.round(b.height), fully: !!bb && b.top >= 0 && b.bottom <= bb.top + 1 };
      }),
      boardBottom: (() => {
        const w = document.querySelector('.board-wrap');
        return w ? Math.round(w.getBoundingClientRect().bottom) : null;
      })(),
      stack: (() => {
        const h = (sel) => {
          const e = document.querySelector(sel);
          return e ? Math.round(e.getBoundingClientRect().height) : null;
        };
        const main = document.querySelector('.battle-main');
        return {
          winH: window.innerHeight,
          scrollTop: main ? Math.round(main.scrollTop) : null,
          scrollNeed: main ? Math.round(main.scrollHeight - main.clientHeight) : null,
          topbar: h('.topbar'),
          statusbar: h('.battle-main > .statusbar'),
          goalbar: h('.goalbar'),
          boardWrap: h('.board-wrap'),
          transit: h('.transit-strip') ?? h('.transit'),
          boardTop: sb ? Math.round(sb.top) : null,
          barTop: bb ? Math.round(bb.top) : null,
        };
      })(),
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
      if (await inResponse(p)) {
        hit = true;
        break;
      }
      if (await gameOver(p)) break;
      await step(p);
      await sleep(70);
      // 响应窗口是「传出情报」之后立刻弹的，推进一步后要马上再看，
      // 否则会被下一轮 step 里的「放弃响应」点掉
      if (await inResponse(p)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      await sleep(250);
      info = await measure(p);
      if (process.env.ABS_DEBUG) console.log(JSON.stringify(info, null, 2));
      console.log(`  （第 ${g} 局撞到响应窗口）`);
    } else {
      console.log(`  （第 ${g} 局没撞到响应窗口，重开）`);
    }
  }

  check(`能走到响应窗口（${MAX_GAMES} 局以内）`, !!info, info ? undefined : '一局都没出现截获/识破响应');
  if (!info) {
    await ctx.close();
    return;
  }

  // 1. 同一句话不出现两遍
  check(
    '提示句只出现一次（description 不与 prompt 重复）',
    !info.dup,
    info.desc ? `description「${info.desc}」已经包含在 prompt 里了` : `prompt「${info.hint}」`,
  );

  // 2. 阶段名不折行
  check(
    '「截获/识破响应」没有被挤成两行',
    !!info.strong && info.strong.h <= (info.title?.lh ?? 20) * 1.3,
    info.strong ? `高 ${info.strong.h}px / 行高 ${info.title?.lh} / ${info.strong.text}` : '找不到阶段名',
  );

  // 3. 标题最多两行。
  //    360px 上做不到一行：「截获响应」占 56px，剩下 260px 放不下 25 个字的提示句，
  //    而阶段名不许折（上一轮踩过「弃牌阶 / 段」）。两行是这个取舍的上限 ——
  //    再长一行（折成三行）就会把牌板再挤掉 20px，所以这里卡死在 2 行。
  check(
    '标题最多两行（再折就说明提示文案又变长了）',
    !!info.title && info.title.h <= info.title.lh * 2.5,
    info.title ? `高 ${info.title.h}px / 行高 ${info.title.lh}` : '量不到标题',
  );

  // 4. 操作区不需要内部滚动
  check('操作区不需要内部滚动', info.barNeedScroll <= 1, `还要滚 ${info.barNeedScroll}px`);

  // 5. 「放弃响应」够大、在屏内
  const pass = info.btns.find((b) => b.t.includes('放弃响应'));
  check(
    '「放弃响应」在屏内且点击高度 ≥32px',
    !!pass && pass.h >= 32 && pass.top >= 0 && pass.bottom <= info.winH,
    pass ? `${pass.w}×${pass.h} 底 ${pass.bottom} / 屏高 ${info.winH}` : '找不到「放弃响应」',
  );

  // 6a. 操作区高度预算。
  //    响应窗口的操作区高度是固定的（标题 + 手牌一行 + 两个按钮），实测 237px；
  //    加回那句重复的 description 就是 264px。640 的 39% = 250，
  //    刚好卡在两者之间：改回去会红，正常的小幅波动不会。
  const barH = info.bar?.h ?? 0;
  check(
    '操作区不超过屏高的 39%（再多就把牌板挤没了）',
    barH > 0 && barH <= info.winH * 0.39,
    `操作区 ${barH}px / 屏高 ${info.winH}px = ${((barH / info.winH) * 100).toFixed(1)}%（上限 39%）`,
  );

  // 6b. 牌板够得着：把牌板滚到视野顶部之后，座位卡要能完整露出来。
  //    「首屏露出多少」会随状态条折几行而变（实测 14px 和 31px 都出现过），
  //    不能直接拿来卡阈值；也不能「滚到底」—— 那时牌板已经被推出屏幕上方了。
  await p.evaluate(`(() => {
    const m = document.querySelector('.battle-main');
    const w = document.querySelector('.board-wrap');
    if (!m || !w) return;
    const mr = m.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    m.scrollTop = m.scrollTop + (wr.top - mr.top) - 8;
  })()`);
  await sleep(250);
  const boardTop = await measure(p);
  const full = boardTop.seats.filter((s) => s.fully).length;
  if (process.env.ABS_DEBUG) {
    console.log(`  座位 ${JSON.stringify(boardTop.seats)} 牌板底 ${boardTop.boardBottom} / 操作区顶 ${boardTop.bar?.top}`);
  }
  // 360×640 实测 2/3 张（牌板两行，第二行被操作区盖住一半）——
  // 阈值卡 1 而不是 2：这里要防的是「牌板被永久盖死」，不是「一张不剩地全看见」，
  // 卡在实测值上会让这条断言变成对字号敏感的一次性快照。
  check(
    '把牌板滚进视野后，座位卡完整可见（牌板没被永久盖住）',
    full >= 1,
    `${full}/${boardTop.seats.length} 张完整可见（牌板底 ${boardTop.boardBottom} / 操作区顶 ${boardTop.bar?.top}）`,
  );
  await p.evaluate(`(() => {
    const m = document.querySelector('.battle-main');
    if (m) m.scrollTop = 0;
  })()`);
  await sleep(200);

  // 7. 手牌单排
  check(
    '手牌是单排',
    !!info.hand && info.hand.rows === 1,
    info.hand ? `${info.hand.cards} 张 / ${info.hand.rows} 行 / 高 ${info.hand.h}px` : '量不到手牌',
  );

  check('没有横向溢出', !info.hScroll);
  await p.screenshot({ path: `${OUT}/response-${vp.name}.png` });

  // 8. 选一张能用的牌：多出一个「使用【X】」按钮，不许把操作区撑高
  let usable = false;
  const cards = p.locator('.actionbar .hand .card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    await cards.nth(i).click().catch(() => undefined);
    await sleep(220);
    const useBtn = p.locator('.actionbar button:not([disabled])').filter({ hasText: '使用【' });
    if ((await useBtn.count()) > 0) {
      usable = true;
      break;
    }
  }
  if (!usable) {
    skip('多出一个按钮时操作区不增高', `这一手 ${n} 张牌里没有能用的响应牌`);
  } else {
    const picked = await measure(p);
    const useBtn = picked.btns.find((b) => b.t.includes('使用【'));
    const pass2 = picked.btns.find((b) => b.t.includes('放弃响应'));
    check(
      '「使用【X】」和「放弃响应」在同一行（不额外占一行）',
      !!useBtn && !!pass2 && Math.abs(useBtn.top - pass2.top) < 14,
      useBtn && pass2 ? `使用 ${useBtn.top} / 放弃 ${pass2.top}` : '找不到两个按钮',
    );
    check(
      '选牌后操作区没有变高',
      !!picked.bar && !!info.bar && picked.bar.h <= info.bar.h + 2,
      picked.bar && info.bar ? `选牌前 ${info.bar.h}px → 选牌后 ${picked.bar.h}px` : '量不到操作区',
    );
    await p.screenshot({ path: `${OUT}/response-${vp.name}-picked.png` });
  }

  check('没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`  · ${OUT}/response-${vp.name}.png`);
  await ctx.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const vp of VIEWPORTS) await runViewport(browser, vp);
  await browser.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项${skipped ? `，跳过 ${skipped} 项` : ''}：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`通过 ${passed} 项${skipped ? `，跳过 ${skipped} 项` : ''}`);
  console.log('响应窗口自查通过。');
}

void main().catch((err) => {
  console.error('响应窗口自查异常', err);
  process.exit(1);
});

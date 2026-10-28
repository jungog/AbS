/**
 * 本地三种模式的冒烟自查：上帝视角 / 单机热座 / 单人 + AI 陪练。
 *
 * 为什么单独一个脚本：`check:viewports` 只跑**联机**流程（大厅 → 房间 → 对局），
 * 本地这三条渲染路径从来没被断言过 —— 而它们各自有一套「谁在行动」的判定：
 *
 *   单人 + AI   viewerId = 'p0'，i > 0 的座位是 bot ⇒ AI effect 自动推进
 *   单机热座    viewerId = pending.player ⇒ 视角跟着当前行动者走，等人点
 *   上帝视角    viewerId = null（`redactState` 用 null 表示全公开）
 *
 * 第三种的坑：`viewerId` 是 null ⇒ `isMyTurn` 恒 false ⇒ 没有操作面板；
 * 而 `start()` 原来把所有座位都设成 `isBot: false` ⇒ AI effect 也不接管。
 * 两条路都堵死，第一个 pending（选角）永远没人应答，对局**永远停在第一步**。
 * 实测 t=1s 与 t=9s 状态完全一致（第 1 轮 / 等待：玩家 1 / 5 张卡全「待选角色」），
 * 而模式文案写着「用来观察规则流程与调试」。
 *
 * 修法是让上帝视角全 AI 自动推进。这个修法有个**副作用风险**：热座和它是
 * 同一个 `start()` 分支，一旦条件写错就会把热座也变成自动跑 —— 热座是几个人
 * 围着一台电脑轮流操作，自动跑等于废掉这个模式。所以下面专门有一条
 * 「热座不会自己跑」。
 *
 * 前置：npm run build && npm run server，然后 npm run check:modes
 *      ABS_URL 可覆盖地址，默认打 8787 的生产构建
 */
import { chromium, type Browser, type Page } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✖ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

interface Snap {
  cards: number;
  deck: number;
  logs: number;
  unknownIdentity: number;
  /** 每张座位卡：foot 里写的张数 / title 里数出来的牌名数 */
  hands: { count: number; names: number }[];
  pickPanel: boolean;
  actionPanel: boolean;
  /** 卡头最多占几行（按行盒数，不按像素） */
  headLines: number;
  /** 玩家名被压成省略号的张数 */
  nameTrunc: number;
}

const SNAP = `(() => {
  const txt = (e) => (e.textContent || '').replace(/\\s+/g, ' ').trim();
  const pills = [...document.querySelectorAll('.statusbar .pill')].map(txt);
  const deckPill = pills.find((t) => t.includes('牌库')) || '';
  const m = deckPill.match(/牌库\\s*(\\d+)/);
  const cards = [...document.querySelectorAll('.pcard')];
  const hands = cards.map((c) => {
    const foot = c.querySelector('.pcard-foot');
    const span = foot ? [...foot.children].find((s) => txt(s).startsWith('手牌')) : null;
    const t = txt(span);
    const count = Number((t.match(/手牌\\s*(\\d+)/) || [])[1] || 0);
    const title = span ? span.getAttribute('title') || '' : '';
    return { count, names: title ? title.split('、').filter(Boolean).length : 0 };
  });
  const heads = cards.map((c) => c.querySelector('.pcard-head')).filter(Boolean);
  // 数**行盒**而不是比高度阈值：实测单行卡头正好 24px，用高度阈值是贴边通过，
  // 差 1px 就红，而且分不清「一行」和「两行」（两行约 40px，靠猜阈值不可靠）。
  // 同一视觉行里不同元素（AI 徽标有 border）的 top 会差 1–2px，按 4px 聚簇。
  const lineCount = (e) => {
    if (!e) return 0;
    const r = document.createRange();
    r.selectNodeContents(e);
    const tops = [...r.getClientRects()]
      .filter((x) => x.width > 0.5 && x.height > 0.5)
      .map((x) => x.top)
      .sort((a, b) => a - b);
    let n = 0;
    let last = -1e9;
    for (const t of tops) {
      if (t - last > 4) n++;
      last = t;
    }
    return n;
  };
  return {
    cards: cards.length,
    deck: m ? Number(m[1]) : -1,
    logs: document.querySelectorAll('.log-item').length,
    // 「身份未知」是 .tag.hidden 的一种；同一个 class 还用于「盖伏」「已出局」，按文字区分
    unknownIdentity: [...document.querySelectorAll('.pcard .tag.hidden')].filter(
      (e) => txt(e) === '身份未知',
    ).length,
    hands,
    pickPanel: !!document.querySelector('.pick-card'),
    actionPanel: !!document.querySelector('.handzone'),
    headLines: heads.length ? Math.max(...heads.map(lineCount)) : 0,
    // 名字被压成省略号的张数：scrollWidth > clientWidth 就是「放不下、被 ellipsis 截了」
    nameTrunc: [...document.querySelectorAll('.pcard-name')].filter(
      (e) => e.scrollWidth > e.clientWidth + 1,
    ).length,
  };
})()`;

async function snap(p: Page): Promise<Snap> {
  return (await p.evaluate(SNAP)) as Snap;
}

/** 收集控制台报错。AI 卡住时 `useLocalGame` 会打 `[AbS] AI 没有可用操作` */
function watchErrors(p: Page, bag: string[]): void {
  p.on('console', (m) => {
    if (m.type() === 'error') bag.push(m.text().slice(0, 160));
  });
  p.on('pageerror', (e) => bag.push(`pageerror: ${e.message.slice(0, 160)}`));
}

async function launch(p: Page, mode: string, errs: string[]): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  try {
    await p.waitForSelector('.launch', { timeout: 20_000 });
  } catch (e) {
    // 这条路径实测会偶发（同一份构建，两次跑分别在第 2、第 3 个上下文上超时）。
    // 不做静默重试：先把现场打出来，再 reload 一次 —— 只要触发过就一定能看见。
    const info = (await p.evaluate(`({
      url: location.href,
      body: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 240),
      html: document.body ? document.body.innerHTML.length : -1,
    })`)) as { url: string; body: string; html: number };
    console.error(`\n[launch 首次失败，准备 reload] mode=${mode}`);
    console.error(`  url  = ${info.url}`);
    console.error(`  html = ${info.html} 字节`);
    console.error(`  body = ${info.body}`);
    console.error(`  控制台 = ${errs.length ? errs.join(' | ') : '（无）'}`);
    await p.screenshot({ path: `shots/_modes-launch-fail-${mode}.png` });
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('.launch', { timeout: 15_000 }).catch(() => {
      throw e;
    });
  }
  await p.locator('.mode-card', { hasText: mode }).click();
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(500);
}

/* ------------------------------------------------------------------ */
/* 上帝视角：必须自己往下走，而且什么都看得见                          */
/* ------------------------------------------------------------------ */

async function checkGod(browser: Browser, w: number, h: number): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errs: string[] = [];
  watchErrors(p, errs);
  await launch(p, '上帝视角', errs);

  const s0 = await snap(p);
  await sleep(8000);
  const s1 = await snap(p);

  const tag = `${w}×${h}`;
  if (s0.cards < 3) {
    check(`${tag} 上帝视角能量到座位卡`, false, `只有 ${s0.cards} 张`);
    await ctx.close();
    return;
  }
  check(`${tag} 上帝视角能量到座位卡`, true);

  // 判据用「牌库下降 或 日志变多」：8 秒 ≈ 28 步，一局要 190 步左右，不会打完
  check(
    `${tag} 上帝视角会自己往下走`,
    s1.deck < s0.deck || s1.logs > s0.logs,
    `牌库 ${s0.deck}→${s1.deck} / 日志 ${s0.logs}→${s1.logs}（都没变就是卡在第一步）`,
  );
  check(`${tag} 上帝视角没有 AI 卡住的报错`, errs.length === 0, errs.join(' | '));
  check(
    `${tag} 上帝视角把身份都公开了`,
    s1.unknownIdentity === 0,
    `${s1.unknownIdentity} 张卡仍写「身份未知」`,
  );

  // 手牌：`player.hand` 只有自己 / 上帝视角才非 null（core/redact.ts）。
  // 以前座位卡只印张数，数据在 view 里躺着没人用。
  const badHand = s1.hands.filter((x) => x.count > 0 && x.names !== x.count);
  check(
    `${tag} 上帝视角能查到每张手牌是什么`,
    s1.hands.length > 0 && badHand.length === 0,
    badHand.map((x) => `${x.count} 张只查到 ${x.names} 个牌名`).join('；'),
  );

  // 全 AI 之后每张卡头都多一个 AI 徽标，360 宽上要确认它没把身份标签挤下去。
  // `s1.headLines > 0` 是**必须**的：选择器没命中时行数会是 0，
  // 而 `0 === 1` 是假 —— 但 `headLines === 1` 单独写仍然要靠这一条兜住「量不到」。
  check(
    `${tag} 座位卡头没有被 AI 徽标挤成两行`,
    s1.headLines === 1,
    s1.headLines > 0 ? `卡头占 ${s1.headLines} 行` : '量不到 .pcard-head',
  );

  // 玩家名不许被压成省略号。这一条是修上面那条时**自己踩出来的**：
  // 上帝视角改成全 AI 之后，每张卡头都多一个「AI」徽标，
  // 360 宽（卡 157px）上第 2/3/4 张卡的名字当场变成「玩…」。
  // 修法是「全员 AI 时不画徽标」（它那时区分不了任何东西），不是缩字号。
  check(
    `${tag} 玩家名没有被挤成省略号`,
    s1.nameTrunc === 0,
    `${s1.nameTrunc} 张卡的名字被截断`,
  );

  await p.screenshot({ path: `shots/modes-god-${w}x${h}.png` });
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* 热座：必须**不会**自己跑（这条防的是上一条的修法写宽了）            */
/* ------------------------------------------------------------------ */

async function checkHotseat(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
  const p = await ctx.newPage();
  const errs: string[] = [];
  watchErrors(p, errs);
  await launch(p, '单机热座', errs);

  const s0 = await snap(p);
  check('热座开局停在选角面板（等人操作）', s0.pickPanel, '找不到 .pick-card');

  await sleep(4000);
  const s1 = await snap(p);
  check(
    '热座不会自己跑（没人点就停住）',
    s1.deck === s0.deck && s1.logs === s0.logs,
    `牌库 ${s0.deck}→${s1.deck} / 日志 ${s0.logs}→${s1.logs} —— 热座被改成自动跑了`,
  );
  check('热座没有控制台报错', errs.length === 0, errs.join(' | '));

  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* 单人 + AI：对照，证明这次改动没波及它                              */
/* ------------------------------------------------------------------ */

async function checkAi(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
  const p = await ctx.newPage();
  const errs: string[] = [];
  watchErrors(p, errs);
  await launch(p, '单人 + AI 陪练', errs);

  const pick = p.locator('.pick-card').first();
  if ((await pick.count()) > 0) {
    await pick.click().catch(() => undefined);
    await sleep(1200);
  }
  const s = await snap(p);
  check(
    '单人 + AI 选完角后出现操作区（轮到自己）',
    s.actionPanel,
    '找不到 .handzone —— 真人拿不到操作权',
  );
  check('单人 + AI 没有控制台报错', errs.length === 0, errs.join(' | '));

  await ctx.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    console.log('1) 上帝视角');
    await checkGod(browser, 360, 640);
    await checkGod(browser, 1280, 900);
    console.log('2) 单机热座');
    await checkHotseat(browser);
    console.log('3) 单人 + AI 陪练');
    await checkAi(browser);
  } finally {
    await browser.close();
  }

  if (fails.length) {
    console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项：`);
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n通过 ${pass} 项`);
  console.log('本地模式自查通过。');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

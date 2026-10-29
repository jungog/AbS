/**
 * 7 人局验收 —— 对应《端游化可行性评估》8.1 的 M2：「7 人完整流程」。
 *
 * 为什么单独一个脚本：`check:viewports` / `check:online` / `check:multi` 跑的都是
 * 2–3 人局，7 人只在引擎层（feature-test 遍历 3..7）和服务端（server-test 用 7 人
 * 测观战延迟）出现过 —— **真浏览器里一次都没跑过 7 人**。7 人是策划案 5.6 的标准局，
 * 也是这份文档 M2 的验收对象，必须有真浏览器证据。
 *
 * 覆盖两件事：
 *   1. 7 人局能从开局一路跑到结算浮层（不是「能开起来」就算）
 *   2. 1440 / 844 / 360 三个视口下 7 张座位卡都不溢出、名字不被截断
 *
 * 用「上帝视角」而不是「单人 + AI 陪练」：后者 p0 是真人，AI 推到 p0 就停，
 * 永远到不了结算。上帝视角全座位 isBot，才会自己跑完。
 *
 * 前置：npm run build && npm run server（或 PORT=8899 起一个）
 * 运行：npm run check:7p
 *      ABS_URL 可覆盖地址，默认打 8787 的生产构建
 */
import { chromium, type Page } from 'playwright';

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

/** 用轮询代替固定 sleep：AI 推进速度受机器负载影响，睡死必然假红 */
async function until(fn: () => Promise<boolean>, timeout: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`  · 等待超时：${label}（${timeout}ms）`);
  return false;
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
  const de = document.documentElement;
  return {
    cards: cards.length,
    deck: m ? Number(m[1]) : -1,
    logs: document.querySelectorAll('.log-item').length,
    hands,
    overflowX: de.scrollWidth - de.clientWidth,
    // 名字被 ellipsis 截断的张数：scrollWidth > clientWidth 就是「放不下、被截了」
    nameTrunc: [...document.querySelectorAll('.pcard-name')].filter(
      (e) => e.scrollWidth > e.clientWidth + 1,
    ).length,
    // 座位卡自身横向溢出
    cardOverflow: cards.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
    /** 结算浮层：Board.tsx 里是 .overlay > .result。
     *  别用 body 正则判「获胜」—— 座位卡/规则文案里也有这词，实测第 3 轮就误报「已结束」。 */
    ended: !!document.querySelector('.overlay .result'),
    winnerText: (() => {
      const r = document.querySelector('.overlay .result');
      return r ? txt(r).slice(0, 120) : '';
    })(),
    body: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200),
  };
})()`;

interface Snap {
  cards: number;
  deck: number;
  logs: number;
  hands: { count: number; names: number }[];
  overflowX: number;
  nameTrunc: number;
  cardOverflow: number;
  ended: boolean;
  winnerText: string;
  body: string;
}

const snap = async (p: Page) => (await p.evaluate(SNAP)) as Snap;

async function open7(p: Page, speed: string, errs: string[]): Promise<void> {
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 160));
  });
  p.on('pageerror', (e) => errs.push(`pageerror: ${e.message.slice(0, 160)}`));
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.launch', { timeout: 20_000 });
  await p.locator('.mode-card', { hasText: '上帝视角' }).click();
  const selects = p.locator('select');
  await selects.first().selectOption('7');
  if ((await selects.count()) > 1) await selects.nth(1).selectOption(speed);
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(600);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /* ---------- 开局：牌数必须对得上 ---------- */
  console.log('\n[1] 1440×900 · 7 人局开局');
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p1 = await ctx1.newPage();
  const errs1: string[] = [];
  // 用最慢的速度开局：80ms 档下 AI 在 600ms 内就能抽完牌，采到的「牌库 66 / 手牌 3」
  // 会变成「牌库 64 / 手牌 5」（实测就是这么红的）。开局断言必须在第一步之前采。
  await open7(p1, '900', errs1);

  const s0 = await snap(p1);
  check('7 张座位卡', s0.cards === 7, `实际 ${s0.cards}`);
  check('牌库 = 87 - 7×3 = 66', s0.deck === 66, `实际 ${s0.deck}`);
  check(
    '7 人都有 3 张起始手牌',
    s0.hands.filter((h) => h.count === 3).length === 7,
    s0.hands.map((h) => h.count).join(','),
  );
  check(
    '手牌张数与牌名数一致（没有「6 张只列 3 个名字」）',
    s0.hands.every((h) => h.count === h.names),
    s0.hands.map((h) => `${h.count}/${h.names}`).join(' '),
  );
  check('横向无溢出', s0.overflowX <= 0, `溢出 ${s0.overflowX}px`);
  check('名字无截断', s0.nameTrunc === 0, `${s0.nameTrunc} 张被截`);
  await p1.screenshot({ path: 'shots/_7p-1440-start.png' });
  await ctx1.close();

  /* ---------- 跑完整局 ----------
     速度下拉只在启动面板上，进对局就卸载了 —— 想跑快只能重开一个上下文。
     实测直接在对局里 selectOption 会一直等「element is not visible」到 30s 超时。 */
  console.log('\n[2] 1440×900 · 7 人局跑到结算（80ms 档）');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  await open7(p2, '80', errs1);

  const advanced = await until(async () => (await snap(p2)).logs > 5, 30_000, 'AI 开始推进');
  check('AI 自动推进（日志增长）', advanced);

  const done = await until(async () => (await snap(p2)).ended, 180_000, '7 人局跑到结算');
  const sEnd = await snap(p2);
  check('7 人局能跑到结算', done, sEnd.body.slice(0, 120));
  console.log(`    结束时：座位卡 ${sEnd.cards}　日志 ${sEnd.logs} 条　牌库剩 ${sEnd.deck}`);
  console.log(`    结算浮层：${sEnd.winnerText || '（没抓到）'}`);
  check('结算浮层写明了获胜方与原因', sEnd.winnerText.includes('获胜'), sEnd.winnerText);
  await p2.screenshot({ path: 'shots/_7p-1440-end.png' });
  check('全程无控制台报错', errs1.length === 0, errs1.slice(0, 3).join(' | '));
  await ctx2.close();

  /* ---------- 窄视口：只验布局 ---------- */
  for (const [w, h, tag] of [
    [844, 390, '844'],
    [360, 640, '360'],
  ] as const) {
    console.log(`\n[3] ${w}×${h} · 7 人局布局`);
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    const errs: string[] = [];
    await open7(p, '900', errs);
    await sleep(1200);
    const s = await snap(p);
    check(`${tag}：7 张座位卡都在`, s.cards === 7, `实际 ${s.cards}`);
    check(`${tag}：横向无溢出`, s.overflowX <= 0, `溢出 ${s.overflowX}px`);
    check(`${tag}：名字无截断`, s.nameTrunc === 0, `${s.nameTrunc} 张被截`);
    check(`${tag}：座位卡自身无溢出`, s.cardOverflow === 0, `${s.cardOverflow} 张`);
    await p.screenshot({ path: `shots/_7p-${tag}.png` });
    await ctx.close();
  }

  await browser.close();
  const total = pass + fails.length;
  console.log(`\n通过 ${pass} / ${total} 项`);
  if (fails.length) {
    console.log('失败项：\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  console.log('7 人局验收通过。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

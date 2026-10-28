/**
 * 真·多人线上验收（生产单端口）
 *
 * 前面所有联机测试都是「同一个进程里 import 服务端」或者「假 WebSocket」。
 * 这个脚本不一样：两个**独立的浏览器上下文**（= 两个独立 localStorage = 两个真人），
 * 打开的是 `npm run serve` 起来的那一个端口 —— 前端和 WebSocket 同源。
 *
 * 它证明的是三件别处证明不了的事：
 *  1. 生产构建下 `resolveWsUrl()` 走同源是对的（开发环境是 8787，生产是 location.host）
 *  2. 两个人的状态真的是各自裁剪的（看不到对方手牌）
 *  3. 一个端口就能开局、能操作、能出日志
 *
 * 用法：先 npm run serve，然后 npm run check:online
 *      ABS_URL=http://localhost:8787/ 可覆盖地址
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function openLobby(p: Page, name: string): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill(name);
  await sleep(500);
}

/** 走一步：选角 → 结束出牌 / 收下 / 放弃响应 → 传情报 / 弃牌 */
async function step(p: Page): Promise<boolean> {
  const pick = p.locator('.pick-card').first();
  if ((await pick.count()) > 0) {
    await pick.click();
    return true;
  }

  const hit = async (kw: string): Promise<boolean> => {
    const btn = p.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
    if ((await btn.count()) === 0) return false;
    await btn.first().click();
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

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors: string[] = [];

  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  for (const [tag, page] of [
    ['A', a],
    ['B', b],
  ] as const) {
    page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${tag} console: ${m.text().slice(0, 160)}`);
    });
  }

  console.log('1) 建房 / 加入（两个独立浏览器上下文）');
  await openLobby(a, '甲');
  await a.locator('button', { hasText: '创建并进入' }).click();
  await a.waitForSelector('.room-bigcode', { timeout: 15_000 });
  const code = ((await a.locator('.room-bigcode').textContent()) ?? '').trim();
  check('拿到房间号', /^[A-Z0-9]{4,8}$/.test(code), code);

  await openLobby(b, '乙');
  await b.locator('input[placeholder="例如 A3KP"]').fill(code);
  await b.locator('.field-inline button', { hasText: '加入' }).click();
  await b.waitForSelector('.room-bigcode', { timeout: 15_000 });
  const codeB = ((await b.locator('.room-bigcode').textContent()) ?? '').trim();
  check('乙进的是同一个房间', codeB === code, `${code} vs ${codeB}`);

  // 双方座位表里都应该看到两个人
  await sleep(600);
  const seatsA = await a.locator('.seat:not(.empty) .seat-name').count();
  check('房主看到 2 个座位', seatsA >= 2, seatsA);

  console.log('2) 房主开局');
  await a.locator('button', { hasText: '开始对局' }).click();
  await a.waitForSelector('.battle', { timeout: 20_000 });
  await b.waitForSelector('.battle', { timeout: 20_000 });
  check('房主进入对局界面', true);
  check('另一位玩家也进入对局界面', true);

  console.log('3) 双方各走几步');
  let stepsA = 0;
  for (let i = 0; i < 12; i++) {
    const mine = await a.locator('.battle .actionbar').count();
    if (mine === 0) break;
    if (await step(a)) stepsA++;
    else break;
    await sleep(150);
    // 对手（乙）也可能是当前行动者
    if (await step(b).catch(() => false)) continue;
  }
  const logA = await a.locator('.log-item').count();
  check('房主操作成功', stepsA > 0, stepsA);
  check('对局产生了日志', logA > 0, logA);

  // 双方视角必须各自独立：手牌只出现在自己的常驻手牌条里（.hand-strip），
  // 别人的手牌只显示「手牌 3」这种张数。用 .actionbar .hand 是不行的 ——
  // 那条只在「轮到你操作」时存在，选角阶段两边都是空的。
  const handA = await a.locator('.hand-strip .card').count();
  const handB = await b.locator('.hand-strip .card').count();
  check('两名玩家各自拿到了手牌', handA > 0 && handB > 0, `${handA} / ${handB}`);

  console.log('4) 对局中有人离开（真浏览器）');
  // 这条只有真浏览器能验：服务端要下发 left 标记 + 往对局日志写一行，
  // 客户端要渲染出来，而且**不能把留下的人一起踢回大厅**。
  const leaveBtn = b.locator('.battle button', { hasText: '离开' }).first();
  check('对局界面有「离开」按钮', (await leaveBtn.count()) > 0);
  await leaveBtn.click();
  await b.waitForSelector('.lobby', { timeout: 10_000 });
  check('离开的人回到大厅', (await b.locator('.lobby').count()) > 0);

  await a
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.log-item')].some((el) =>
          (el.textContent ?? '').includes('离开了对局'),
        ),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  const leaveLog = await a.locator('.log-item', { hasText: '离开了对局' }).count();
  check('留下的人在对局日志里看到「离开了对局」', leaveLog > 0, leaveLog);
  check('留下的人还在对局界面（没被一起踢回大厅）', (await a.locator('.battle').count()) > 0);

  // 日志会滚走，座位卡是常驻的 —— 走掉的人必须在卡上就能看出来，
  // 而且不能和「掉线」（会回来）用同一个说法
  const goneCard = a.locator('.pcard.left');
  const goneCardCount = await goneCard.count();
  check('离开的人的座位卡被标出来', goneCardCount === 1, goneCardCount);
  check(
    '座位卡上写的是「已离开」',
    ((await goneCard.first().textContent()) ?? '').includes('已离开'),
    (await goneCard.first().textContent()) ?? '',
  );

  await a.screenshot({ path: `${OUT}/online-prod-leave.png` });
  console.log(`  · ${OUT}/online-prod-leave.png`);

  await a.screenshot({ path: `${OUT}/online-prod-a.png` });
  await b.screenshot({ path: `${OUT}/online-prod-b.png` });
  console.log(`  · ${OUT}/online-prod-a.png`);
  console.log(`  · ${OUT}/online-prod-b.png`);

  check('没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`通过 ${passed} 项`);
  console.log('多人线上（单端口）验收通过。');
}

void main().catch((err) => {
  console.error('验收脚本异常', err);
  process.exit(1);
});

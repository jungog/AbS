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

/**
 * 轮询到条件成立为止（默认最多 15 秒），返回是否等到。
 *
 * 原来这里是 `await sleep(600)` 然后一次性数座位 —— 本地 RTT 下够用，
 * 但对着 Render 免费层实测会**假红**：乙已经进房了，房主那边的状态还没推过来，
 * 数出来只有 1 个座位（实测 13/15，本地 15/15，同一个脚本）。
 * 断言应该等「事实发生」，而不是赌「600ms 够了」。
 */
async function until(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(250);
  }
}

/** 走一步：选角 → 结束出牌 / 收下 / 放弃响应 → 传情报 / 弃牌 */
async function step(p: Page): Promise<boolean> {
  const pick = p.locator('.pick-card').first();
  if ((await pick.count()) > 0) {
    // 不用 click()：`.pick-card:hover` 带 `transform: translateY(-1px)`，
    // Playwright 点之前会先把鼠标移过去 → 元素自己动了 → 判定
    // 「element is not stable」；再叠加状态推送把选角面板重新挂载
    // （「element was detached from the DOM」），click 会一直重试到 30 秒超时。
    // 公网实测就是这么挂的（本地 RTT 下刚好躲过去，所以只在线上红）。
    // 卡片是 div + onClick，直接派发 click 最稳，也绕开鼠标悬停。
    await pick.dispatchEvent('click');
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

  // —— 邀请链接：朋友第一次点开时，localStorage 是空的 ——
  // 这条链路以前没有任何断言守着。ui-online 里的邀请用例是「先手动点一下
  // 『联机对局』再断言房间号已填好」—— 测试替用户切了页签，于是
  // 「`?room=` 根本没被读到、直接停在本地对局页」藏了很久（公网上就是这样）。
  // 这里开一个全新上下文（= 一个从没来过的人），只做只读检查，不动房间状态。
  console.log('1b) 邀请链接：全新浏览器直接打开 ?room=' + code);
  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const c = await ctxC.newPage();
  c.on('pageerror', (e) => errors.push(`C pageerror: ${e.message}`));
  await c.goto(`${URL}?room=${code}`, { waitUntil: 'domcontentloaded' });
  const landed = await until(async () => (await c.locator('.lobby').count()) > 0, 20_000);
  check(
    '邀请链接直接落在联机大厅（不用手动切页签）',
    landed,
    (await c.locator('body').innerText().catch(() => '')).slice(0, 80).replace(/\s+/g, ' '),
  );
  const prefilled = await c
    .locator('input[placeholder="例如 A3KP"]')
    .inputValue()
    .catch(() => '');
  check('邀请链接把房间号填好了', prefilled === code, `${prefilled} vs ${code}`);
  const noticeText = await c.locator('.invite-notice').innerText().catch(() => '');
  check('邀请提示条认出了房间号', noticeText.includes(code), noticeText.replace(/\s+/g, ' '));
  check('地址栏里的邀请参数被消费掉', !c.url().includes('room='), c.url());

  // 提示条里现在有两个按钮，而 `.notice` 是**不换行**的 flex：
  // 不管住的话，360px 上主按钮被压成 73×67，文案「以「玩家」加入」折成竖排三行。
  // 判据用「按钮不许被压窄、也不许被压高」，比截图比对稳定。
  await c.setViewportSize({ width: 360, height: 640 });
  await sleep(200);
  const narrowBtn = await c.locator('.invite-notice button.primary').boundingBox();
  check(
    '窄屏（360）上邀请按钮没被压扁',
    Boolean(narrowBtn) && narrowBtn!.width >= 90 && narrowBtn!.height <= 40,
    narrowBtn ? `${narrowBtn.width.toFixed(0)}x${narrowBtn.height.toFixed(0)}` : '无',
  );
  await ctxC.close();

  await openLobby(b, '乙');
  await b.locator('input[placeholder="例如 A3KP"]').fill(code);
  await b.locator('.field-inline button', { hasText: '加入' }).click();
  await b.waitForSelector('.room-bigcode', { timeout: 15_000 });
  const codeB = ((await b.locator('.room-bigcode').textContent()) ?? '').trim();
  check('乙进的是同一个房间', codeB === code, `${code} vs ${codeB}`);

  // 双方座位表里都应该看到两个人。乙那边 `.room-bigcode` 已经出现了，
  // 但房主这边的座位表要等一次服务端推送 —— 公网上这个间隔可能是几百毫秒到几秒。
  let seatsA = 0;
  const twoSeats = await until(async () => {
    seatsA = await a.locator('.seat:not(.empty) .seat-name').count();
    return seatsA >= 2;
  });
  check('房主看到 2 个座位', twoSeats, `${seatsA}（等了最多 15 秒）`);

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
  // 别人的手牌只显示「手牌 3」这种张数。
  //
  // **两种形态都要数**：轮到自己时 `.hand-strip` 会被操作区（`.actionbar .hand`）替换掉，
  // 只数 hand-strip 就会把「正轮到自己」误判成「没有手牌」。
  // 公网实测就是栽在这儿（3 / 0）：本地节奏里乙恰好还在等，公网上乙已经轮到自己了。
  const countHand = async (p: Page): Promise<number> =>
    (await p.locator('.hand-strip .card').count()) + (await p.locator('.actionbar .hand .card').count());
  let handA = 0;
  let handB = 0;
  const bothHands = await until(async () => {
    // 乙可能一直停在选角面板上 —— 上面那 12 轮循环是「按次数」推进的，
    // 公网慢的时候根本轮不到乙选角，它就一直没手牌（实测 3 / 0，等 15 秒也不动）。
    // 这里在轮询里顺手替它点一下，而不是靠循环次数碰运气。
    const pick = b.locator('.pick-card').first();
    if ((await pick.count()) > 0) await pick.dispatchEvent('click').catch(() => undefined);
    handA = await countHand(a);
    handB = await countHand(b);
    return handA > 0 && handB > 0;
  });
  check('两名玩家各自拿到了手牌', bothHands, `${handA} / ${handB}（等了最多 15 秒）`);
  if (!bothHands) {
    // 失败时把乙的现场打出来 —— 公网验收最怕「只看到一个数字」，分不清是
    // 还在选角、掉线回大厅、还是渲染层出问题。
    const dbg = await b.evaluate(`(() => ({
      battle: !!document.querySelector('.battle'),
      pick: document.querySelectorAll('.pick-card').length,
      strip: document.querySelectorAll('.hand-strip .card').length,
      bar: document.querySelectorAll('.actionbar .hand .card').length,
      waiting: !!document.querySelector('.actionbar.waiting'),
      overlay: !!document.querySelector('.overlay'),
      connecting: (document.body.innerText || '').includes('正在连接'),
    }))()`);
    console.log('  · 乙的现场:', JSON.stringify(dbg));
  }

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

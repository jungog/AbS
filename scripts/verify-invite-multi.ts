/**
 * 邀请链接的两条真实路径：**带密码的房间** 和 **3 人以上的局**。
 *
 * 为什么单独一个脚本：`check:online` 已经覆盖了「2 人 + 无密码 + 点链接进来」，
 * 而朋友实际会遇到的是另外两种：
 *
 *   A) 房主设了密码。朋友点链接 → 自动发 join（没有密码）→ 被拒。
 *      以前服务端对「没填密码」和「填错了」都说「房间密码不对。」，
 *      而点链接进来的人**从没看见过密码输入框** —— 他不知道这个房间要密码，
 *      也不知道去哪儿填，只能自己往下滚碰运气。
 *      现在：服务端分开说，界面把「填写密码」按钮顶到提示条上、光标送到密码框。
 *
 *   B) 三个人一起玩。座位表、开局、各自手牌都要在 3 人下成立 ——
 *      这是「发给朋友一起玩」最常见的人数，却一直没被验过。
 *
 * 用法：先 `npm run build && npm run server`，然后 `npm run check:multi`
 *      `ABS_URL=https://abs-7xaq.onrender.com/ npm run check:multi` 打公网
 *
 * 注：脚本刻意不共用 verify-online-prod 的辅助函数 —— 两个脚本各自独立跑、
 * 各自的通过/失败计数才是自洽的；抽公共库会让「谁绿谁红」变得不好读。
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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

/** 轮询到条件成立为止 —— 公网上任何「睡固定时长再看一眼」都会假红 */
async function until(fn: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(250);
  }
}

/** 手牌有两种形态：不是自己回合是 `.hand-strip`，轮到自己时是 `.actionbar .hand` */
async function countHand(p: Page): Promise<number> {
  return (
    (await p.locator('.hand-strip .card').count()) +
    (await p.locator('.actionbar .hand .card').count())
  );
}

const PW_CREATE = 'input[placeholder="房间密码（留空表示不设）"]';
const PW_JOIN = 'input[placeholder="房间密码（有则填）"]';

async function openLobby(p: Page, name: string): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 25_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 15_000 });
  await p.locator('.nick-input').fill(name);
  await sleep(400);
}

async function bigCode(p: Page): Promise<string> {
  await p.waitForSelector('.room-bigcode', { timeout: 20_000 });
  return ((await p.locator('.room-bigcode').textContent()) ?? '').trim();
}

function watch(page: Page, tag: string, errors: string[]): void {
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${tag} console: ${m.text().slice(0, 160)}`);
  });
}

/* ------------------------------------------------------------------ */
/* A) 带密码的房间：朋友点邀请链接                                      */
/* ------------------------------------------------------------------ */
async function partPassword(browser: Browser, errors: string[]): Promise<void> {
  console.log('\nA) 带密码的房间：朋友点邀请链接');

  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  watch(a, 'A房主', errors);
  await openLobby(a, '房主');
  await a.locator(PW_CREATE).fill('8888');
  await a.locator('button', { hasText: '创建并进入' }).click();
  const code = await bigCode(a);
  check('建好带密码的房间', /^[A-Z0-9]{4,8}$/.test(code), code);

  // 朋友：全新上下文（= 没昵称、没房间记忆），手机竖屏
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const b = await ctxB.newPage();
  watch(b, 'B朋友', errors);
  await b.goto(`${URL}?room=${code}`, { waitUntil: 'domcontentloaded' });
  check(
    '朋友直接落在联机大厅（不用手动切页签）',
    await until(async () => (await b.locator('.lobby').count()) > 0, 25_000),
  );

  const noticeBtn = b.locator('.invite-notice button.primary');
  check('提示条上有「加入」按钮', (await noticeBtn.count()) > 0);
  await noticeBtn.click();

  // 没填密码 → 必须说「这个房间设了密码」，而不是「密码不对」
  let errText = '';
  const blocked = await until(async () => {
    errText = await b.locator('.error.banner-error').innerText().catch(() => '');
    return errText.includes('密码');
  }, 20_000);
  check('被拒时明确说「这个房间设了密码」', blocked && errText.includes('设了密码'), errText.replace(/\s+/g, ' '));

  // 提示条上的按钮要变成「填写密码」，而不是让人再点一次注定被拒的「加入」
  const btnAfter = (await b.locator('.invite-notice button.primary').innerText().catch(() => '')).trim();
  check('提示条按钮变成「填写密码」', btnAfter.includes('填写密码'), btnAfter);

  await b.locator('.invite-notice button.primary').click();
  await sleep(300);
  const focused = (await b.evaluate(
    `(() => { const el = document.activeElement; return el ? (el.getAttribute('placeholder') || el.tagName) : null; })()`,
  )) as string | null;
  check('点「填写密码」把光标送到房间密码框', focused === '房间密码（有则填）', focused);
  await b.screenshot({ path: `${OUT}/multi-a-password-blocked.png` });
  console.log(`  · ${OUT}/multi-a-password-blocked.png`);

  await b.locator(PW_JOIN).fill('8888');
  const btnFilled = (await b.locator('.invite-notice button.primary').innerText().catch(() => '')).trim();
  check('填了密码后按钮回到「加入」', btnFilled.includes('加入'), btnFilled);
  await b.locator('.invite-notice button.primary').click();

  const entered = await until(async () => (await b.locator('.room-bigcode').count()) > 0, 25_000);
  check('填对密码后进房成功', entered, entered ? '' : '还在大厅');
  const codeB = entered ? ((await b.locator('.room-bigcode').textContent()) ?? '').trim() : '';
  check('进的是同一个房间', codeB === code, `${codeB} vs ${code}`);

  await b.screenshot({ path: `${OUT}/multi-a-password-room.png` });
  console.log(`  · ${OUT}/multi-a-password-room.png`);

  await ctxA.close();
  await ctxB.close();
}

/* ------------------------------------------------------------------ */
/* B) 3 人局：房主 + 两个点邀请链接进来的朋友                           */
/* ------------------------------------------------------------------ */
async function partThreePlayers(browser: Browser, errors: string[]): Promise<void> {
  console.log('\nB) 3 人局：房主 + 两个点邀请链接进来的朋友');

  /** 带「记住过昵称」的上下文 —— 等价于「来过一次的朋友」 */
  async function guest(name: string): Promise<{ ctx: BrowserContext; p: Page }> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(
      `try { localStorage.setItem('abs:name', ${JSON.stringify(name)}); } catch (e) {}`,
    );
    const p = await ctx.newPage();
    watch(p, name, errors);
    return { ctx, p };
  }

  const ctxHost = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const host = await ctxHost.newPage();
  watch(host, '房主', errors);
  await openLobby(host, '房主');
  await host.locator('button', { hasText: '创建并进入' }).click();
  const code = await bigCode(host);
  check('建好房间', /^[A-Z0-9]{4,8}$/.test(code), code);

  const b = await guest('乙');
  await b.p.goto(`${URL}?room=${code}`, { waitUntil: 'domcontentloaded' });
  check(
    '记住过昵称的朋友点链接自动进房（乙）',
    await until(async () => (await b.p.locator('.room-bigcode').count()) > 0, 25_000),
  );

  const c = await guest('丙');
  await c.p.goto(`${URL}?room=${code}`, { waitUntil: 'domcontentloaded' });
  check(
    '第三个人点链接也能进（丙）',
    await until(async () => (await c.p.locator('.room-bigcode').count()) > 0, 25_000),
  );

  let seats = 0;
  const three = await until(async () => {
    seats = await host.locator('.seat:not(.empty) .seat-name').count();
    return seats >= 3;
  });
  check('房主看到 3 个座位', three, `${seats} 个（等了最多 20 秒）`);

  // 三个人，总人数就设 3（补 0 个 AI）—— 这样「3 人局」是确定的，
  // 不会因为默认总人数是 5 而混进机器人。
  await host.locator('select').first().selectOption('3');
  await host.locator('button', { hasText: '开始对局' }).click();

  for (const [tag, page] of [
    ['房主', host],
    ['乙', b.p],
    ['丙', c.p],
  ] as const) {
    const ok = await page
      .waitForSelector('.battle', { timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
    check(`${tag} 进入对局界面`, ok);
  }

  // 三个人都要拿到手牌。谁停在选角面板上就替谁点一下 ——
  // 点用 dispatchEvent：`.pick-card:hover` 有 translateY，click 会被判「不稳定」。
  let hHost = 0;
  let hB = 0;
  let hC = 0;
  const hands = await until(async () => {
    for (const p of [host, b.p, c.p]) {
      const pick = p.locator('.pick-card').first();
      if ((await pick.count()) > 0) await pick.dispatchEvent('click').catch(() => undefined);
    }
    hHost = await countHand(host);
    hB = await countHand(b.p);
    hC = await countHand(c.p);
    return hHost > 0 && hB > 0 && hC > 0;
  }, 25_000);
  check('三个人各自拿到了手牌', hands, `${hHost} / ${hB} / ${hC}`);

  // 3 人局的座位卡数量 = 3（多出来的是 AI 或掉线残留都算错）
  const cards = await host.locator('.battle .pcard').count();
  check('牌板上就是 3 张玩家卡', cards === 3, `${cards} 张`);

  await host.screenshot({ path: `${OUT}/multi-b-three-players.png` });
  console.log(`  · ${OUT}/multi-b-three-players.png`);

  await ctxHost.close();
  await b.ctx.close();
  await c.ctx.close();
}

async function main(): Promise<void> {
  console.log(`目标：${URL}`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors: string[] = [];

  await partPassword(browser, errors);
  await partThreePlayers(browser, errors);

  check('没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项：` : ''}`);
  for (const f of failures) console.log(`  ✖ ${f}`);
  if (failures.length) {
    console.log('邀请链路（密码 / 3 人）验收未通过。');
    process.exitCode = 1;
  } else {
    console.log('邀请链路（密码 / 3 人）验收通过。');
  }
}

void main();

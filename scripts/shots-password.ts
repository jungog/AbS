/**
 * 视觉自查：房间密码 + 观战延迟
 *
 * 只截图不断言。DOM 测试证明不了「锁标记有没有挤歪」「密码提示看不看得见」。
 *
 * 前置：npm run dev（5173）+ npm run server（8787，默认 30 秒观战延迟）
 * 输出：shots/pw-*.png
 *
 * 每个玩家单独一个 browser context —— 同一个 context 共享 localStorage，
 * 后开的页面会读到前一个页面的回座凭证，直接顶掉别人的座位。
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'shots';
const URL = process.env.APP_URL ?? 'http://localhost:5173/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  · ${OUT}/${name}.png`);
}

async function newPlayer(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 15_000 });
  return p;
}

async function openLobby(p: Page, name: string): Promise<void> {
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill(name);
  await sleep(600);
}

/** 帮当前操作者走一步（只用于推进截图，不做断言） */
async function step(p: Page): Promise<boolean> {
  const hit = async (kw: string): Promise<boolean> => {
    const btn = p.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
    if ((await btn.count()) === 0) return false;
    await btn.first().click();
    return true;
  };
  for (const kw of ['结束出牌', '收下', '放弃响应']) {
    if (await hit(kw)) return true;
  }
  const cards = p.locator('.actionbar .hand .card:not(.selected)');
  for (let i = 0; i < 3; i++) {
    if ((await cards.count()) === 0) break;
    await cards.first().click();
    await sleep(120);
    for (const kw of ['传出这张情报', '确认弃牌']) {
      if (await hit(kw)) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });

  console.log('1) 甲建一个有密码的房间');
  const a = await newPlayer(browser);
  await openLobby(a, '甲');
  await a.locator('input[placeholder="房间密码（留空表示不设）"]').fill('8888');
  await a.locator('button', { hasText: '创建并进入' }).click();
  await sleep(1200);
  await shot(a, 'pw-01-room-locked');

  console.log('2) 乙在大厅看到这个房间（有锁标记）');
  const b = await newPlayer(browser);
  await openLobby(b, '乙');
  await sleep(400);
  await shot(b, 'pw-02-lobby-lock');

  console.log('3) 乙直接点「加入」→ 被拦下要求填密码');
  await b.locator('.room-row button', { hasText: '加入' }).first().click();
  await sleep(400);
  await shot(b, 'pw-03-need-password');

  console.log('4) 乙填密码后进房');
  await b.locator('input[placeholder="房间密码（有则填）"]').fill('8888');
  await sleep(200);
  await b.locator('.field-inline button', { hasText: '加入' }).click();
  await sleep(1200);
  await shot(b, 'pw-04-two-players');

  console.log('5) 开局，两人各自选角');
  await a.locator('button', { hasText: '开始对局' }).click();
  await sleep(1600);
  await a.locator('.pick-card').first().click();
  await sleep(700);
  await b.locator('.pick-card').first().click();
  await sleep(1400);

  console.log('6) 丙从大厅点「观战」（私密房也要密码）');
  const c = await newPlayer(browser);
  await openLobby(c, '丙');
  await sleep(500);
  await c.locator('.room-row button', { hasText: '观战' }).first().click();
  await sleep(500);
  await shot(c, 'pw-05-spectator-need-password');

  await c.locator('input[placeholder="房间密码（有则填）"]').fill('8888');
  await sleep(200);
  await c.locator('.room-row button', { hasText: '观战' }).first().click();
  await sleep(1800);
  await shot(c, 'pw-06-spectator-delayed');

  console.log('7) 推进到第 2 轮，对比玩家视角与观众视角');

  /**
   * 从状态栏里读「第 N 轮」。
   * 页面上有两个 .statusbar：上面那个是房间/延迟/离开，下面那个才有轮次。
   * 所以要把所有 .statusbar 的文本拼起来再找，不能只取第一个。
   */
  const roundOf = async (p: Page): Promise<number> => {
    const all = await p.locator('.statusbar').allTextContents().catch(() => [] as string[]);
    const m = all.join(' ').match(/第\s*(\d+)\s*轮/);
    return m ? Number(m[1]) : 0;
  };

  // 按回合延迟：必须真的推进过一轮边界，才能看出「观众停在上一轮」
  for (let i = 0; i < 60; i++) {
    const didA = await step(a);
    const didB = didA ? false : await step(b);
    if (!didA && !didB) await sleep(400);
    else await sleep(240);
    if ((await roundOf(a)) >= 2) break;
  }
  await sleep(900);

  await shot(a, 'pw-07-player-view');
  await shot(c, 'pw-08-spectator-behind');

  const pill = (await c.locator('.spec-pill').textContent().catch(() => '')) ?? '';
  const delayNote = (await c.locator('.spec-delay').textContent().catch(() => '')) ?? '';
  const logA = await a.locator('.log-item').count();
  const logC = await c.locator('.log-item').count();
  console.log(`  玩家轮次 ${await roundOf(a)} / 观众轮次 ${await roundOf(c)}`);
  console.log(`  观众状态栏：${pill.replace(/\s+/g, ' ').trim()}`);
  console.log(`  观战面板：${delayNote.replace(/\s+/g, ' ').trim()}`);
  console.log(`  日志条数：玩家 ${logA} / 观众 ${logC}`);
  // 按回合延迟时日志条数不是判据（一轮的日志只占总量一小部分），
  // 真正的判据是轮次差 + 观战面板上的「第 N 轮结束时的局面」。
  const gap = (await roundOf(a)) - (await roundOf(c));
  console.log(`  轮次差：${gap} 轮 ${gap >= 1 ? '（观众拿不到当前轮的信息）' : '（异常：延迟没生效）'}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

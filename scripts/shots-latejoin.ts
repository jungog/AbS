/**
 * 「结算阶段允许新人加入」的视觉自查。
 *
 * 场景：甲乙打完一局，丙这时才赶到。
 * 要确认的三件事（DOM 断言证明不了）：
 *   1. 大厅把房间显示成「上一局已结束 · 可加入下一局」，而不是「对局中」
 *   2. 丙进房后看到的是「等下一局」那一屏，不会误以为走错房间
 *   3. 下一局开始后丙是**正常玩家**（有手牌），不是观众
 *
 * 前置：npm run dev + npm run server 都在跑。
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = 'http://localhost:5173/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  · ${OUT}/${name}.png`);
}

async function openLobby(p: Page, name: string): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 15_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill(name);
  await sleep(600);
}

/** 帮一个页面走一步。只用于把对局推到结束，不做断言。 */
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
  const browser = await chromium.launch({ channel: 'chrome' });
  const mk = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    return ctx.newPage();
  };
  const a = await mk();
  const b = await mk();

  console.log('1) 建房 / 加入');
  await openLobby(a, '甲');
  await a.locator('button', { hasText: '创建并进入' }).click();
  await a.waitForSelector('.room-bigcode', { timeout: 10_000 });
  const code = ((await a.locator('.room-bigcode').textContent()) ?? '').trim();

  await openLobby(b, '乙');
  await b.locator('input[placeholder="例如 A3KP"]').fill(code);
  await b.locator('.field-inline button', { hasText: '加入' }).click();
  await sleep(900);

  console.log('2) 开局（2 真人 + 1 AI）');
  await a.locator('button', { hasText: '开始对局' }).click();
  await sleep(900);

  console.log('3) 把这一局打完');
  let idle = 0;
  for (let i = 0; i < 400; i++) {
    if ((await a.locator('.result').count()) > 0) break;
    let did = false;
    for (const p of [a, b]) {
      try {
        if (await step(p)) did = true;
      } catch {
        /* 页面重渲染中 */
      }
    }
    if (did) idle = 0;
    else {
      idle += 1;
      if (idle > 20) break;
    }
    await sleep(200);
  }
  await sleep(700);

  const ended = (await a.locator('.result').count()) > 0;
  console.log(`   对局结束：${ended ? '是' : '否'}`);
  if (!ended) {
    await shot(a, 'lj-00-not-finished');
    await browser.close();
    return;
  }

  console.log('4) 丙这时才来 —— 大厅里这个房间应该显示成「可加入下一局」');
  const c = await mk();
  await openLobby(c, '丙');
  await sleep(800);
  const row = c.locator('.room-row').filter({ hasText: code }).first();
  const rowText = ((await row.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  console.log(`   大厅行：${rowText}`);
  await shot(c, 'lj-01-lobby-gameover');

  console.log('5) 丙点「加入下一局」');
  await row.locator('button', { hasText: '加入下一局' }).click();
  await sleep(1200);
  await shot(c, 'lj-02-room-waiting');

  const roomText = ((await c.locator('.room-side').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  const actions = ((await c.locator('.room-actions').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  console.log(`   房间状态栏：${roomText}`);
  console.log(`   房间操作区：${actions}`);

  console.log('6) 甲乙也准备 → 自动开下一局');
  await a.locator('.result-actions .primary').click();
  await sleep(500);
  await b.locator('.result-actions .primary').click();
  await sleep(1600);

  await shot(a, 'lj-03-next-game-a');
  await shot(c, 'lj-04-next-game-c');

  const cInBattle = (await c.locator('.battle').count()) > 0;
  const cHand = await c.locator('.actionbar .hand .card, .hand-strip .card').count();
  const cPick = await c.locator('.pick-card').count();
  console.log(`   丙进入对局：${cInBattle ? '是' : '否'} · 选角面板 ${cPick} 张 · 手牌 ${cHand} 张`);
  console.log(`   丙的身份标记：${(await c.locator('.statusbar').first().textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim()}`);

  await browser.close();
  console.log('完成。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

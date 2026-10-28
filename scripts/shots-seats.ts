/**
 * 换座位 + 结算页「调整座位 / 人数」的视觉自查。
 *
 * 不做断言，只出图 —— DOM 测试能证明「点了会发 swap」，
 * 但证明不了「换完之后座位表看起来是乱的」「结算页那个入口像不像能点」。
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

/** 座位顺序（只取有人坐的位子） */
async function seatOrder(p: Page): Promise<string> {
  const names = await p.locator('.seat:not(.empty) .seat-name').allTextContents();
  return names.map((t) => t.replace(/\s+/g, '').replace('你', '')).join(' > ');
}

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
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  console.log('1) 建房 / 加入');
  await openLobby(a, '甲');
  await a.locator('button', { hasText: '创建并进入' }).click();
  await a.waitForSelector('.room-bigcode', { timeout: 10_000 });
  const code = ((await a.locator('.room-bigcode').textContent()) ?? '').trim();

  await openLobby(b, '乙');
  await b.locator('input[placeholder="例如 A3KP"]').fill(code);
  await b.locator('.field-inline button', { hasText: '加入' }).click();
  await sleep(1000);

  console.log(`2) 初始座位：${await seatOrder(a)}`);
  await shot(a, 'st-01-room-before');

  console.log('3) 甲点 1 号位 → 2 号位（换座）');
  await a.locator('.seat:not(.empty)').nth(0).click();
  await sleep(200);
  await shot(a, 'st-02-seat-picked');
  await a.locator('.seat:not(.empty)').nth(1).click();
  await sleep(900);
  const after = await seatOrder(a);
  console.log(`   换完之后：${after}`);
  await shot(a, 'st-03-room-after-swap');
  await shot(b, 'st-04-room-other-side');

  console.log('4) 开局并打完（3 人局，结束得快）');
  await a.locator('.room-actions select').first().selectOption('3');
  await sleep(300);
  await a.locator('button', { hasText: '开始对局' }).click();
  await sleep(900);
  let idle = 0;
  for (let i = 0; i < 800; i++) {
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
      // 机器人行动时两个真人都不该动，这时「没操作可做」是正常的。
      // 阈值给到 8 秒（40 拍 × 200ms），否则一轮 3 个 AI 各自思考就会误判成卡住。
      if (idle > 40) break;
    }
    await sleep(200);
  }
  await sleep(600);

  if ((await a.locator('.result').count()) === 0) {
    console.log('   没打完，只出当前局面');
    await shot(a, 'st-05-not-finished');
    await browser.close();
    return;
  }

  await shot(a, 'st-05-result');

  console.log('5) 点「调整座位 / 人数」');
  await a.locator('.ready-arrange').click();
  await sleep(700);
  await shot(a, 'st-06-room-between-games');
  const stillSwappable = (await a.locator('.seat.swappable').count()) > 0;
  const hasBots = (await a.locator('.room-actions select').count()) > 0;
  console.log(`   座位可换：${stillSwappable ? '是' : '否'} · 有「下一局 AI」选择器：${hasBots ? '是' : '否'}`);

  console.log('6) 换一次座（两局之间）');
  await a.locator('.seat:not(.empty)').nth(1).click();
  await sleep(200);
  await a.locator('.seat:not(.empty)').nth(0).click();
  await sleep(800);
  console.log(`   换完之后：${await seatOrder(a)}`);
  await shot(a, 'st-07-between-games-swapped');

  await browser.close();
  console.log('完成。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

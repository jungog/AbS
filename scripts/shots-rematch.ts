/**
 * 结算页准备制的视觉自查。
 *
 * 这个脚本不做断言，只出图 —— DOM 测试能证明「按钮存在」，
 * 但证明不了「两个按钮挤在一起」「准备进度看着像报错」。
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

/**
 * 帮一个页面走一步。只用于把对局推到结束，不做断言。
 * 顺序很重要：先找不用选牌就能点的，再试「先选牌再提交」。
 */
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
  // 大厅里有两个「房间号」输入框（建房 / 加入），按 placeholder 精确取加入那个
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
  await sleep(600);

  const ended = (await a.locator('.result').count()) > 0;
  console.log(`   对局结束：${ended ? '是' : '否'}`);
  if (!ended) {
    console.log('   没打完，只出当前局面');
    await shot(a, 'rm-00-not-finished');
    await browser.close();
    return;
  }

  await shot(a, 'rm-01-result-idle');

  console.log('4) 甲点「再来一局」（只准备，不重开）');
  await a.locator('.result-actions .primary').click();
  await sleep(700);
  await shot(a, 'rm-02-ready-mine');
  const countA = ((await a.locator('.ready-count').textContent()) ?? '').trim();
  console.log(`   甲的进度：${countA}`);

  // 乙那边应该看到「1/2」，但自己的按钮仍是「再来一局」
  await shot(b, 'rm-03-ready-other');
  const btnB = ((await b.locator('.result-actions .primary').textContent()) ?? '').trim();
  console.log(`   乙的按钮：${btnB}`);

  console.log('5) 乙也准备 → 自动开新局');
  await b.locator('.result-actions .primary').click();
  await sleep(1200);
  await shot(a, 'rm-04-next-game');
  const backToBattle = (await a.locator('.battle').count()) > 0;
  console.log(`   新一局已开始：${backToBattle ? '是' : '否'}`);

  await browser.close();
  console.log('完成。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 用真实浏览器确认「打开链接 → 单人 + AI 陪练 → 真的能操作」这条路是通的。
 *
 * 这不是断言测试，是交付前的自检：dev server 可能因为 HMR 报错、
 * 也可能因为我刚改的代码有运行时问题，而 tsc 查不出来。
 */
import { chromium } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:5173/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`);
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tabs-line button', { timeout: 15_000 });

  // 1. 本地页签 + 单人 + AI
  await page.locator('.tabs-line button', { hasText: '本地' }).click();
  await sleep(300);
  const aiCard = page.locator('.mode-card', { hasText: '单人 + AI' });
  await aiCard.click();
  await sleep(200);

  // 2. 开始对局
  await page.locator('button', { hasText: '开始对局' }).click();
  await page.waitForSelector('.battle', { timeout: 10_000 });
  console.log('  ✔ 进入对局界面');

  // 3. 选角（自己先选，AI 会自动选）
  await page.waitForSelector('.pick-card', { timeout: 10_000 });
  const pickCount = await page.locator('.pick-card').count();
  await page.locator('.pick-card').first().click();
  console.log(`  ✔ 选角面板 ${pickCount} 张候选，已选 1 张`);
  await sleep(1200);

  // 4. 轮到自己的时候能操作：找到可点的牌 + 提交按钮
  let acted = 0;
  for (let i = 0; i < 40; i++) {
    const pick = page.locator('.pick-card').first();
    if ((await pick.count()) > 0) {
      await pick.click();
      await sleep(400);
      continue;
    }

    const hit = async (kw: string): Promise<boolean> => {
      const b = page.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
      if ((await b.count()) === 0) return false;
      await b.first().click();
      acted++;
      return true;
    };

    let did = false;
    for (const kw of ['结束出牌', '收下', '放弃响应']) {
      if (await hit(kw)) {
        did = true;
        break;
      }
    }
    if (!did) {
      const cards = page.locator('.actionbar .hand .card:not(.selected)');
      for (let k = 0; k < 3 && !did; k++) {
        if ((await cards.count()) === 0) break;
        await cards.first().click();
        await sleep(120);
        for (const kw of ['传出这张情报', '确认弃牌']) {
          if (await hit(kw)) {
            did = true;
            break;
          }
        }
      }
    }
    await sleep(did ? 260 : 420);
    if (acted >= 6) break;
  }

  const logCount = await page.locator('.log-item').count();
  const barText = ((await page.locator('.actionbar').first().textContent().catch(() => '')) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  await page.screenshot({ path: 'shots/play-link.png' });

  console.log(`  ✔ 我操作了 ${acted} 次，日志 ${logCount} 条`);
  console.log(`  · 当前操作区：${barText}`);
  console.log(`  · 截图：shots/play-link.png`);

  if (errors.length > 0) {
    console.log('  ✖ 页面报错：');
    errors.slice(0, 6).forEach((e) => console.log(`    ${e}`));
  } else {
    console.log('  ✔ 无控制台报错');
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

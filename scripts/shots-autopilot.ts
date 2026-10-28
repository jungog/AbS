/**
 * 视觉自查（二）：超时托管与断线重连的界面
 *
 * 需要服务端用短超时启动：
 *   ABS_TURN_TIMEOUT_MS=2500 npx tsx server/index.ts
 * 然后：npx tsx scripts/shots-autopilot.ts
 *
 * 单独一个脚本是因为它必须等「什么都不做」超时 —— 30 秒的默认值太慢，
 * 而把默认值改短会影响正常对局。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'shots';
const BASE = 'http://localhost:5173';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '联机对局' }).click();
  await sleep(800);

  await page.getByPlaceholder('最多 12 字').fill('阿甲');
  await page.getByRole('button', { name: '创建并进入' }).click();
  await sleep(1000);

  // 3 人局：1 真人 + 2 AI，开局后真人什么都不做
  await page.locator('.room-actions select').selectOption('3');
  await page.getByRole('button', { name: '开始对局' }).click();
  await sleep(1200);

  console.log('  等超时…');
  await page.waitForSelector('.autopilot-bar', { timeout: 8000 });
  await sleep(300);
  await page.screenshot({ path: `${OUT}/11-autopilot.png` });
  console.log(`  · ${OUT}/11-autopilot.png`);

  // 点「我回来了」应立刻消失
  await page.getByRole('button', { name: '我回来了' }).click();
  await sleep(500);
  const gone = (await page.locator('.autopilot-bar').count()) === 0;
  console.log(`  收回控制权后托管条消失：${gone ? '是' : '否'}`);
  await page.screenshot({ path: `${OUT}/12-takeback.png` });

  // 断线重连：直接断网模拟
  // 断网时浏览器不会立刻关闭 WebSocket，要靠心跳判死（15 秒）才会触发重连。
  // 这一步同时验证「客户端比服务端托管更早发现掉线」。
  await page.context().setOffline(true);
  console.log('  断网，等心跳判死…');
  let overlay = 0;
  try {
    await page.waitForSelector('.reconnect-overlay', { timeout: 25_000 });
    overlay = 1;
  } catch {
    overlay = 0;
  }
  await page.screenshot({ path: `${OUT}/13-reconnecting.png` });
  console.log(`  · ${OUT}/13-reconnecting.png`);
  console.log(`  心跳判死后出现重连遮罩：${overlay > 0 ? '是' : '否'}`);

  await page.context().setOffline(false);
  await page.waitForSelector('.reconnect-overlay', { state: 'detached', timeout: 15000 });
  await sleep(600);
  await page.screenshot({ path: `${OUT}/14-resumed.png` });
  console.log(`  · ${OUT}/14-resumed.png`);
  const back = (await page.locator('.battle').count()) > 0;
  console.log(`  恢复后回到对局：${back ? '是' : '否'}`);

  await browser.close();
  console.log('托管 / 重连截图完成。');
}

main().catch((e) => {
  console.error('失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});

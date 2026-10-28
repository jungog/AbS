/**
 * 视觉自查：用系统 Chrome 真开两个页面，把「大厅 → 建房 → 加入 → 开局」走一遍并截图。
 *
 * 这个脚本不进 CI（依赖本机 Chrome 和正在跑的两个服务），
 * 作用是替代「我盯着 DOM 断言想象布局」—— CSS 写歪了、文字溢出、
 * 元素重叠这类问题只有真渲染才看得出来。
 *
 * 运行前提：
 *   npx vite --port 5173        # 前端
 *   npx tsx server/index.ts     # 联机服务端
 * 然后：npx tsx scripts/shots.ts
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'shots';
const BASE = 'http://localhost:5173';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  · ${OUT}/${name}.png`);
}

/**
 * 帮两个页面各走一步：谁的操作区有可用主按钮就点谁。
 * 只用于截图推进，不做任何断言 —— 规则正确性由 jsdom 测试保证。
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

  // 不需要选牌就能点的
  for (const kw of ['结束出牌', '收下', '放弃响应']) {
    if (await hit(kw)) return true;
  }

  // 需要先选手牌的：选一张再找提交按钮
  const cards = () => p.locator('.actionbar .hand .card:not(.selected)');
  for (let i = 0; i < 3; i++) {
    if ((await cards().count()) === 0) break;
    await cards().first().click();
    await sleep(110);
    for (const kw of ['传出这张情报', '确认弃牌']) {
      if (await hit(kw)) return true;
    }
  }
  return false;
}

async function drive(a: Page, b: Page, rounds: number): Promise<number> {
  let n = 0;
  // 机器人行动时两个真人都不该动 —— 这时「没操作可做」是正常的，
  // 不能一判 false 就退出，要给它几拍时间把 AI 的回合走完。
  let idle = 0;
  for (let i = 0; i < rounds; i++) {
    let did = false;
    for (const p of [a, b]) {
      try {
        if (await step(p)) {
          did = true;
          n++;
        }
      } catch {
        /* 页面正在重渲染，下一拍再试 */
      }
    }
    if (did) {
      idle = 0;
    } else {
      idle += 1;
      if (idle > 12) break;
    }
    await sleep(220);
  }
  return n;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  a.on('console', (m) => {
    if (m.type() === 'error') console.log('  [A console error]', m.text());
  });
  b.on('console', (m) => {
    if (m.type() === 'error') console.log('  [B console error]', m.text());
  });

  /* ---------- 1. 首页（本地启动面板） ---------- */
  await a.goto(BASE, { waitUntil: 'networkidle' });
  await sleep(500);
  await shot(a, '01-home');

  /* ---------- 2. 大厅 ---------- */
  await a.getByRole('button', { name: '联机对局' }).click();
  await sleep(900);
  await shot(a, '02-lobby');

  /* ---------- 3. 建房 → 房间等待页 ---------- */
  await a.getByPlaceholder('最多 12 字').fill('阿甲');
  await a.getByRole('button', { name: '创建并进入' }).click();
  await sleep(1200);
  await shot(a, '03-room-host');

  const code = (await a.locator('.room-bigcode').textContent())?.trim() ?? '';
  console.log(`  房间号：${code}`);

  /* ---------- 4. 第二个人按号加入 ---------- */
  await b.goto(BASE, { waitUntil: 'networkidle' });
  await b.getByRole('button', { name: '联机对局' }).click();
  await sleep(900);
  await b.getByPlaceholder('例如 A3KP').fill(code);
  await b.locator('.field-inline button', { hasText: '加入' }).click();
  await sleep(1200);
  await shot(b, '04-room-guest');
  await sleep(300);
  await shot(a, '05-room-two-players');

  /* ---------- 5. 开局（3 人：2 真人 + 1 AI） ---------- */
  await a.locator('.room-actions select').selectOption('3');
  await a.getByRole('button', { name: '开始对局' }).click();
  await sleep(1500);
  await shot(a, '06-pick-character');

  /* ---------- 6. 两个真人各自选角 ---------- */
  await a.locator('.pick-card').first().click();
  await sleep(700);
  await shot(b, '07-pick-character-b');
  await b.locator('.pick-card').first().click();
  await sleep(900);
  await shot(a, '08-battle');

  /* ---------- 7. 推几步，看传递与落位 ---------- */
  const acted = await drive(a, b, 26);
  console.log(`  推进了 ${acted} 步`);
  await shot(a, '09-battle-running');
  await sleep(1400);
  await shot(a, '10-battle-later');

  /* ---------- 7. 倒计时与托管（等 30 秒太慢，只截倒计时） ---------- */
  const hasCountdown = await a.locator('.countdown').count();
  console.log(`  倒计时环：${hasCountdown > 0 ? '有' : '无'}`);

  await browser.close();
  console.log('截图完成。');
}

main().catch((e) => {
  console.error('截图失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});

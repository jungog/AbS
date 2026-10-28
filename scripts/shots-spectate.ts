/**
 * 视觉自查（三）：观战与邀请链接
 *
 * 需要先跑起来：npm run dev + npm run server
 * 然后：npx tsx scripts/shots-spectate.ts
 *
 * 这个脚本只负责「让人用眼睛验收」：观战界面是否真的没有手牌、
 * 房间页的邀请链接按钮排版有没有歪。断言由 ui-online / server-test 负责。
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { rightColumnState, rightColumnVerdict } from './lib/right-column';

const OUT = 'shots';
const BASE = 'http://localhost:5173';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


/**
 * 帮房主走一步。只用于截图推进，不做断言 —— 规则正确性由 jsdom 测试保证。
 * 和 shots.ts 里那份是同一种写法：先找不用选牌就能点的，再试「先选牌再提交」。
 */
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

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const host = await hostCtx.newPage();

  await host.goto(BASE, { waitUntil: 'networkidle' });
  await host.getByRole('button', { name: '联机对局' }).click();
  await sleep(700);
  await host.getByPlaceholder('最多 12 字').fill('阿甲');
  await host.getByRole('button', { name: '创建并进入' }).click();
  await sleep(900);

  const roomCode = ((await host.locator('.room-bigcode').textContent()) ?? '').trim();
  console.log(`  房间号 ${roomCode}`);

  // 房间等待页（含「复制邀请链接」）
  await host.screenshot({ path: `${OUT}/15-room-invite.png` });
  console.log(`  · ${OUT}/15-room-invite.png`);

  // 3 人局：1 真人 + 2 AI
  await host.locator('.room-actions select').selectOption('3');
  await host.getByRole('button', { name: '开始对局' }).click();
  await sleep(1200);
  await host.locator('.pick-card').first().click();
  await sleep(1000);
  await host.screenshot({ path: `${OUT}/16-host-battle.png` });
  console.log(`  · ${OUT}/16-host-battle.png`);

  /* ---------------- 观战者 ---------------- */
  const specCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const spec = await specCtx.newPage();
  await spec.goto(BASE, { waitUntil: 'networkidle' });
  await spec.getByRole('button', { name: '联机对局' }).click();
  await sleep(900);

  const row = spec.locator('.room-row', { hasText: roomCode });
  const specBtn = row.getByRole('button', { name: '观战' });
  const hasSpecBtn = (await specBtn.count()) > 0;
  console.log(`  大厅里出现「观战」入口：${hasSpecBtn ? '是' : '否'}`);
  await spec.screenshot({ path: `${OUT}/17-lobby-spectate.png` });
  console.log(`  · ${OUT}/17-lobby-spectate.png`);

  if (hasSpecBtn) {
    await specBtn.click();
    await sleep(1200);
    await spec.screenshot({ path: `${OUT}/18-spectator.png` });
    console.log(`  · ${OUT}/18-spectator.png`);

    const pill = (await spec.locator('.spec-pill').count()) > 0;
    const handStrip = (await spec.locator('.hand-strip').count()) > 0;
    const handCards = await spec.locator('.actionbar .hand .card').count();
    console.log(`  观战标记：${pill ? '有' : '无'} · 手牌条：${handStrip ? '有' : '无'} · 可点手牌：${handCards} 张`);

    // 让房主真的动几步，看观战视角是否跟着走（顺带验证观众也能看到飞牌）
    for (let i = 0; i < 8; i++) {
      const acted = await step(host);
      if (!acted) break;
      await sleep(260);
    }
    await spec.screenshot({ path: `${OUT}/19-spectator-later.png` });
    console.log(`  · ${OUT}/19-spectator-later.png`);
  }

  /* ---------------- 观战者（手机横屏） ---------------- */
  /* 观战没有操作区，渲染的是 .spectator-panel。横屏布局把「操作区 + 日志」
     挪到右侧固定栏，如果面板不一起挪：右栏空着 320px，而面板被挤到 y=666
     （屏高 390）—— 得往下滚一大截才看得到「当时轮到谁 / 落后几轮」。
     这条断言盯的就是「面板在右栏里、在屏内」。 */
  const landCtx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const land = await landCtx.newPage();
  await land.goto(BASE, { waitUntil: 'networkidle' });
  await land.getByRole('button', { name: '联机对局' }).click();
  await sleep(900);
  const landRow = land.locator('.room-row', { hasText: roomCode });
  const landSpecBtn = landRow.getByRole('button', { name: '观战' });
  if ((await landSpecBtn.count()) > 0) {
    await landSpecBtn.click();
    await sleep(1400);
    await land.screenshot({ path: `${OUT}/20-spectator-landscape.png` });
    console.log(`  · ${OUT}/20-spectator-landscape.png`);

    const geo = (await land.evaluate(`(() => {
      const panel = document.querySelector('.spectator-panel');
      const card = document.querySelector('.pcard');
      const ch = card ? card.querySelector('.pcard-char') : null;
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      const cr = ch ? ch.getBoundingClientRect() : null;
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        vw: window.innerWidth,
        vh: window.innerHeight,
        identityBottom: cr && Math.round(cr.bottom),
      };
    })()`)) as {
      top: number;
      bottom: number;
      left: number;
      vw: number;
      vh: number;
      identityBottom: number | null;
    } | null;

    const onScreen = !!geo && geo.top >= 0 && geo.bottom <= geo.vh + 1;
    const inRightColumn = !!geo && geo.left >= geo.vw - 321;
    const boardReadable = !!geo && (geo.identityBottom ?? 9999) <= geo.vh;
    // 通用不变量（scripts/lib/right-column.ts）：右栏那 320px 必须有人占。
    // 上面三条盯的是「观战面板本人」；这一条盯的是「布局整体」——
    // 以后再加新面板（比如聊天/复盘），忘了挪进右栏，这里也会红。
    const rc = await rightColumnState(land);
    const rcV = rightColumnVerdict(rc);
    console.log(
      `  横屏观战：面板 ${geo?.top}..${geo?.bottom}（屏高 ${geo?.vh}）/ 左边界 ${geo?.left} / ` +
        `在屏内 ${onScreen ? '是' : '否'} · 在右栏 ${inRightColumn ? '是' : '否'} · 牌板可读 ${boardReadable ? '是' : '否'} / ` +
        `右栏 ${rcV.detail}`,
    );
    if (!(onScreen && inRightColumn && boardReadable)) {
      console.error('  ✖ 横屏观战布局不合格');
      process.exitCode = 1;
    }
    if (!rcV.ok) {
      console.error(`  ✖ 横屏观战时右栏空着 —— ${rcV.detail}`);
      process.exitCode = 1;
    }
  }

  /* ---------------- 邀请链接 ---------------- */
  const inviteCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const invited = await inviteCtx.newPage();
  await invited.goto(`${BASE}/?room=${roomCode}`, { waitUntil: 'networkidle' });
  await invited.getByRole('button', { name: '联机对局' }).click();
  await sleep(900);
  const prefilled = await invited.locator('input[placeholder="例如 A3KP"]').inputValue();
  console.log(`  邀请链接带入的房间号：${prefilled || '(空)'}`);
  await invited.screenshot({ path: `${OUT}/21-invite-link.png` });
  console.log(`  · ${OUT}/21-invite-link.png`);

  await browser.close();
  console.log('观战 / 邀请链接截图完成。');
}

main().catch((e) => {
  console.error('失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});

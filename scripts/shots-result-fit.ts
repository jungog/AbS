/**
 * 出图 + 自查：结算浮层在「矮屏」里放不放得下、放不下时滚不滚得到按钮。
 *
 * 为什么单独一条：结算页是打完一局才会出现的浮层，`check:viewports` 跑不到它
 * （每个视口都要真打完一局，太慢）。而它正好是「内容比屏幕高」的典型 ——
 * 手机横屏带浏览器工具栏只有 330 高，结算卡最坏情况（全员获胜 chip 两行 +
 * 「N 人掉线」提示行）有 328px。
 *
 * 修前：`overflow: visible` + `align-items: center` ⇒ 卡片上下**各裁一半**，
 * 标题和「再来一局」都够不着，而且滚不动（实测 cardTop −11、bottom 341 / 屏高 330）。
 * 修后：浮层可滚 + 短屏压一版（328px），330 高上按钮直接可见；
 * 300 高这种极小横屏靠滚动兜底，脚本会真的滚到底再断言按钮够得着。
 *
 * `npm run shots:result`（会真打完一局，一两分钟）
 */
import { chromium, type Page } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  for (const kw of ['结束出牌', '收下', '接收', '退回', '截获', '跳过', '放弃响应']) {
    if (await hit(kw)) return true;
  }
  const cards = () => p.locator('.actionbar .hand .card:not(.selected)');
  for (let i = 0; i < 3; i++) {
    if ((await cards().count()) === 0) break;
    await cards().first().click();
    await sleep(80);
    for (const kw of ['传出这张情报', '确认弃牌']) {
      if (await hit(kw)) return true;
    }
  }
  return false;
}

async function probe(w: number, h: number) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill('结算');
  await sleep(400);
  await p.locator('button', { hasText: '创建并进入' }).click();
  await p.waitForSelector('.room-bigcode', { timeout: 15_000 });
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(600);

  // 自己先出局是常事：剩下的全是 AI，对局还要自己打完，这段时间没有任何可点的东西。
  // 所以「多久没动作就放弃」不能按回合算，得按真实时间（这里 90 秒）。
  let idleMs = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    if ((await p.locator('.result').count()) > 0) break;
    let did = false;
    try {
      if (await step(p)) did = true;
    } catch {
      /* 重渲染中 */
    }
    idleMs = did ? 0 : idleMs + 180;
    if (idleMs > 90_000) break;
    await sleep(180);
  }
  await sleep(700);

  const ended = (await p.locator('.result').count()) > 0;
  console.log(`${w}×${h} 对局结束：${ended ? '是' : '否'}`);
  if (!ended) {
    await p.screenshot({ path: `shots/result-${w}x${h}-unfinished.png` });
    await browser.close();
    return;
  }

  const geo = (await p.evaluate(`(() => {
    // 最坏情况：全员获胜（chip 多两行）+ 结算页有人掉线（多一行红字提示）
    const winners = document.querySelector('.result .winners');
    if (winners) {
      for (const n of ['机器人 5', '机器人 6']) {
        const c = document.createElement('span');
        c.className = 'winner-chip';
        c.textContent = n;
        winners.appendChild(c);
      }
    }
    const row = document.querySelector('.ready-row');
    if (row) {
      const hint = document.createElement('span');
      hint.className = 'hint warn';
      hint.textContent = '2 人掉线：开局后由 AI 代打，他们回来点「我回来了」就能收回。';
      row.appendChild(hint);
    }

    const ov = document.querySelector('.overlay');
    const res = document.querySelector('.result');
    const ready = document.querySelector('.ready-row');
    const btns = document.querySelectorAll('.result-actions button');
    const r = (e) => e ? e.getBoundingClientRect() : null;
    const o = r(ov), c = r(res), rd = r(ready);
    const last = btns.length ? r(btns[btns.length - 1]) : null;
    return {
      vh: window.innerHeight,
      cardTop: c && Math.round(c.top),
      cardBottom: c && Math.round(c.bottom),
      cardH: c && Math.round(c.height),
      overflowTop: c ? Math.round(Math.max(0, -c.top)) : -1,
      overflowBottom: c ? Math.round(Math.max(0, c.bottom - window.innerHeight)) : -1,
      readyBottom: rd && Math.round(rd.bottom),
      lastBtnBottom: last && Math.round(last.bottom),
      lastBtnTop: last && Math.round(last.top),
      overlayScroll: ov ? getComputedStyle(ov).overflowY : '',
      cardScroll: res ? getComputedStyle(res).overflowY : '',
      docScrollable: document.documentElement.scrollHeight > window.innerHeight + 1,
    };
  })()`)) as Record<string, number | string | boolean>;

  console.log(JSON.stringify(geo));

  // 溢出时必须真的滚得到：滚到底再量一次最后一个按钮
  const scrolled = (await p.evaluate(`(() => {
    const ov = document.querySelector('.overlay');
    ov.scrollTop = ov.scrollHeight;
    const btns = document.querySelectorAll('.result-actions button');
    const last = btns.length ? btns[btns.length - 1].getBoundingClientRect() : null;
    return {
      scrollTop: Math.round(ov.scrollTop),
      lastTop: last && Math.round(last.top),
      lastBottom: last && Math.round(last.bottom),
      vh: window.innerHeight,
    };
  })()`)) as { scrollTop: number; lastTop: number; lastBottom: number; vh: number };
  const reachable = scrolled.lastBottom <= scrolled.vh + 1 && scrolled.lastTop >= 0;
  console.log(`  滚到底：scrollTop=${scrolled.scrollTop} 按钮 ${scrolled.lastTop}..${scrolled.lastBottom} → ${reachable ? '够得着' : '够不着'}`);
  if (!reachable) process.exitCode = 1;

  await p.screenshot({ path: `shots/result-${w}x${h}.png` });
  await browser.close();
}

async function main() {
  const hs = (process.env.ABS_HEIGHTS ?? '390,330,300').split(',').map(Number);
  for (const h of hs) await probe(844, h);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

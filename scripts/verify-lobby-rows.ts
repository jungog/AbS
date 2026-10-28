/**
 * 大厅房间列表的自查：一行房间在窄屏上放不放得下。
 *
 * 为什么单独一个脚本、不塞进 `check:viewports`：
 * 要复现的坏状态是「刚打完一局的公开房」—— 那种房在大厅里有两个按钮
 * （「加入下一局」+「观战」），而普通房只有一个。`check:viewports` 走到大厅时
 * 列表是空的，造不出这个状态；把整局打完又要几十秒，不该塞进每个视口。
 *
 * 抓到的 bug（360×640，一个 1 真人 + 4 AI 打完的公开房）：
 *   整行 282×475，说明列被挤到 7px，状态文字断成 21 行 —— 一字一行。
 * 根因是 `.room-row` 没有 `flex-wrap`，而 `.room-meta` 是 `flex: 1`
 * （`flex-basis: 0`）—— 折行算法比的是 flex-basis，所以连折行都触发不了。
 *
 * 断的是四件事：
 *   1. 说明列至少 100px（修前 7px / 37px）
 *   2. 状态文字不超过 4 行（修前 21 行 / 8 行）
 *   3. 整行不超过 160px（修前 475px / 221px）
 *   4. 两个按钮都在行内，没被挤出行外
 *
 * 顺带断一条跟布局绑定的文案：空状态说「在右边建一个」，而 `.lobby-grid`
 * 在 820px 以下只有一列，建房面板其实在**下面**。断言直接把「文案里的方位」
 * 和「实际的列数」对起来，所以以后谁改断点都会被抓到。
 *
 * 前置：npm run build && npm run server（默认打 8787 的生产构建）。
 * 运行：npm run check:lobby
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640 },
  { name: '390x844', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
  { name: 'laptop720', width: 1280, height: 720 },
  { name: 'desktop', width: 1440, height: 900 },
];

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

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: `shots/${name}.png` });
  console.log(`  · shots/${name}.png`);
}

/** 把大厅滚回顶部 —— 填昵称时浏览器会把输入框滚进视野，截图上标题就被切掉了 */
async function scrollLobbyTop(p: Page): Promise<void> {
  await p.evaluate(`(() => {
    const el = document.querySelector('.lobby');
    const sc = el && el.parentElement;
    if (sc) sc.scrollTop = 0;
  })()`);
  await sleep(150);
}

async function openLobby(p: Page, name: string): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill(name);
  await sleep(600);
}

/** 推进一步：选角 → 结束出牌 → 收下/放弃响应 → 选一张牌传出去 */
async function step(p: Page): Promise<boolean> {
  const pick = p.locator('.pick-card').first();
  if ((await pick.count()) > 0) {
    await pick.click().catch(() => undefined);
    return true;
  }
  const hit = async (kw: string): Promise<boolean> => {
    const btn = p.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
    if ((await btn.count()) === 0) return false;
    await btn.first().click().catch(() => undefined);
    return true;
  };
  for (const kw of ['结束出牌', '收下', '放弃响应']) {
    if (await hit(kw)) return true;
  }
  const cards = () => p.locator('.actionbar .hand .card:not(.selected)');
  for (let i = 0; i < 3; i++) {
    if ((await cards().count()) === 0) break;
    await cards().first().click().catch(() => undefined);
    await sleep(100);
    for (const kw of ['传出这张情报', '确认弃牌']) {
      if (await hit(kw)) return true;
    }
  }
  return false;
}

/**
 * 空状态那句方位话，和 `.lobby-grid` 实际是几列，对得上吗。
 *
 * 用 innerText 取文案：它按渲染结果走，`display: none` 的那份不会算进来 ——
 * 正好是「用户真正看到的那一句」。
 */
async function emptyCopyState(p: Page): Promise<{ cols: number; text: string } | null> {
  return p.evaluate(`(() => {
    const grid = document.querySelector('.lobby-grid');
    const empty = document.querySelector('.lobby-empty');
    if (!grid || !empty) return null;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    return { cols, text: empty.innerText.replace(/\\s+/g, '') };
  })()`) as Promise<{ cols: number; text: string } | null>;
}

/** 量一个 gameOver 房的行。找不到就返回 null。 */
interface RowInfo {
  rowW: number;
  rowH: number;
  rowRight: number;
  metaW: number;
  stateLines: number;
  stateText: string;
  buttons: { t: string; left: number; right: number }[];
}

async function gameOverRow(p: Page): Promise<RowInfo | null> {
  return p.evaluate(`(() => {
    const row = [...document.querySelectorAll('.room-row')]
      .find(r => [...r.querySelectorAll('button')].some(b => b.textContent.includes('加入下一局')));
    if (!row) return null;
    const lh = (e) => parseFloat(getComputedStyle(e).lineHeight) || 1;
    const rr = row.getBoundingClientRect();
    const meta = row.querySelector('.room-meta');
    const mr = meta.getBoundingClientRect();
    const state = row.querySelector('.room-state');
    const sr = state.getBoundingClientRect();
    const buttons = [...row.querySelectorAll('button')].map(b => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right) };
    });
    return {
      rowW: Math.round(rr.width), rowH: Math.round(rr.height), rowRight: Math.round(rr.right),
      metaW: Math.round(mr.width),
      stateLines: Math.round(sr.height / lh(state)),
      stateText: state.textContent.trim(),
      buttons,
    };
  })()`) as Promise<RowInfo | null>;
}

/** 1) 空状态文案：必须在「列表真的是空的」时候量。 */
async function checkEmptyCopy(browser: Browser): Promise<void> {
  console.log('\n1) 空状态说「在右边建一个」，可右边真的有东西吗');
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const p = await ctx.newPage();
    // 在导航**之前**把 WebSocket 掐掉，房间列表就永远是空的。
    //
    // 不能靠「大厅里碰巧没房」：`isPublic` 默认是 true，`check:viewports`
    // 每跑一次都会在大厅里留下 5 个公开房，5 分钟内不回收。
    // 靠碰运气的话这一条会一直跳过 —— 而永久跳过等于没测。
    // 空状态是纯本地渲染（`.lobby-grid` + 两句文案），不需要服务端。
    await p.routeWebSocket(/.*/, (ws) => ws.close({ code: 1000, reason: 'blocked by check' }));
    await openLobby(p, '空');
    const st = await emptyCopyState(p);
    if (!st) {
      check(`${vp.name} 空状态能渲染出来`, false, '掐掉 WebSocket 后仍量不到 .lobby-empty');
      await ctx.close();
      continue;
    }
    const saysRight = st.text.includes('在右边');
    const saysBelow = st.text.includes('在下面');
    if (st.cols >= 2) {
      check(
        `${vp.name} 两列布局时说「在右边」`,
        saysRight && !saysBelow,
        `${st.cols} 列，文案「${st.text}」`,
      );
    } else {
      check(
        `${vp.name} 单列布局时说「在下面」`,
        saysBelow && !saysRight,
        `${st.cols} 列，文案「${st.text}」`,
      );
    }
    await ctx.close();
  }
}

/** 2) 打完一局，让大厅里出现一个 gameOver 房。返回房主页面，保持连接。 */
async function playOneGame(browser: Browser): Promise<{ ctx: BrowserContext; code: string } | null> {
  console.log('\n2) 打完一局（1 真人 + 4 AI），让大厅里出现一个「上一局已结束」的公开房');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await openLobby(p, '房主');
  await p.locator('label.check input').check(); // 公开，才会出现在大厅
  await p.locator('button', { hasText: '创建并进入' }).click();
  await p.waitForSelector('.room-bigcode', { timeout: 15_000 });
  const code = ((await p.locator('.room-bigcode').textContent()) ?? '').trim();
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(800);

  let ended = false;
  const t0 = Date.now();
  let used = 0;
  // 原来卡「300 步」：实测打完一局要 52 秒，而 300 步 × 150ms 光是等待就 45 秒 ——
  // 一直是贴着上限在跑，机器稍慢就红（实测偶发过一次「300 步之内没出现结算浮层」）。
  // 真正的约束是时间不是步数：改成「最多 240 秒 / 2000 步，先到先停」；
  // 并且真的点到了东西就只等 60ms（游戏在推进），没点到才等 200ms（等对手/AI）。
  for (let i = 0; i < 2000; i++) {
    if ((await p.locator('.result').count()) > 0) {
      ended = true;
      break;
    }
    if (Date.now() - t0 > 240_000) break;
    let acted = false;
    try {
      acted = await step(p);
    } catch {
      /* 重渲染中 */
    }
    used = i + 1;
    await sleep(acted ? 60 : 200);
  }
  console.log(
    `   房间 ${code} · 对局结束：${ended ? '是' : '否'}（${Math.round((Date.now() - t0) / 1000)}s / ${used} 步）`,
  );
  check(
    '一局能打完（否则造不出 gameOver 房）',
    ended,
    ended ? undefined : `240 秒 / 2000 步之内没出现结算浮层（用了 ${used} 步）`,
  );
  if (!ended) {
    await ctx.close();
    return null;
  }
  // 不关页面：房主还在线，房间才不会进「无人在线」分支
  return { ctx, code };
}

/** 3) gameOver 那一行在五个视口下排成什么样。 */
async function checkGameOverRow(browser: Browser): Promise<void> {
  console.log('\n3) 「上一局已结束」那一行在窄屏上放不放得下');
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const p = await ctx.newPage();
    await openLobby(p, '看客');
    let row = null;
    for (let i = 0; i < 10 && !row; i++) {
      row = await gameOverRow(p);
      if (!row) {
        await p.locator('button', { hasText: '刷新列表' }).click().catch(() => undefined);
        await sleep(600);
      }
    }
    if (!row) {
      // 这一局是脚本自己刚打完的，房主页面还开着 —— 列表里找不到就是真出问题了
      check(`${vp.name} 大厅里能找到刚打完的那间房`, false, '刷新 10 次仍没找到带「加入下一局」的行');
      await ctx.close();
      continue;
    }
    await scrollLobbyTop(p);
    await shot(p, `lobby-row-${vp.name}`);

    check(
      `${vp.name} 房间说明列没被压扁（≥100px）`,
      row.metaW >= 100,
      `${row.metaW}px（整行 ${row.rowW}×${row.rowH}）`,
    );
    check(
      `${vp.name} 房间状态不竖排（≤4 行）`,
      row.stateLines <= 4,
      `${row.stateLines} 行 · 说明列 ${row.metaW}px ·「${row.stateText}」`,
    );
    check(
      `${vp.name} 整行不至于比屏还高（≤160px）`,
      row.rowH <= 160,
      `${row.rowH}px（说明列 ${row.metaW}px）`,
    );
    const outside = row.buttons.filter((b) => b.right > row.rowRight + 1);
    check(
      `${vp.name} 两个按钮都在行内`,
      row.buttons.length >= 2 && outside.length === 0,
      outside.length ? `溢出：${outside.map((b) => b.t).join(' / ')}` : `${row.buttons.length} 个按钮`,
    );
    await ctx.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  await checkEmptyCopy(browser);
  const game = await playOneGame(browser);
  if (game) await checkGameOverRow(browser);
  await game?.ctx.close();
  await browser.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`通过 ${passed} 项`);
  console.log('大厅房间列表自查通过。');
}

void main().catch((err) => {
  console.error('大厅房间列表自查异常', err);
  process.exit(1);
});

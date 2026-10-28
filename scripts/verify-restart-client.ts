/**
 * 真·重启恢复验收（浏览器侧）
 *
 * `server-prod-test` 已经证明「服务端能凭 token 把座位还给你」——但那是原始 WebSocket 客户端。
 * 真正会被用户碰到的问题是：**正在打的一局，服务端重启了，浏览器会不会自己回来？**
 *
 * 这个脚本就是走那一条路：
 *   两个浏览器 → 建房 → 加入 → 开局 → **杀掉服务端** → 看到「正在重连…」→ 重启服务端
 *   → 遮罩消失、房间号还在、日志条数没减少、还能继续出牌
 *
 * 它同时验证了三件东西：客户端退避重连、快照恢复、恢复后的对局能继续推进。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const URL = `http://127.0.0.1:${PORT}/`;
/** 排水接口的令牌：只有配了它，/admin/shutdown 才存在 */
const ADMIN_TOKEN = 'restart-test-token';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/* ------------------------------------------------------------------ */
/* 子进程                                                              */
/* ------------------------------------------------------------------ */

const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT, 'server', 'index.ts');

interface Child {
  proc: ChildProcess;
  out: string[];
}

function startServer(dataDir: string): Child {
  const out: string[] = [];
  const proc = spawn(process.execPath, [TSX_CLI, ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ABS_DATA_DIR: dataDir,
      ABS_PERSIST_MS: '150',
      ABS_BOT_STEP_MS: '400',
      // 注意别写成 '20_000'：Number('20_000') 是 NaN，setTimeout 会当 0 毫秒用
      ABS_TURN_TIMEOUT_MS: '20000',
      ABS_MAX_ROOMS: '20',
      ABS_MAX_CONNECTIONS: '50',
      ABS_ADMIN_TOKEN: ADMIN_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (b: Buffer) => out.push(b.toString('utf8')));
  proc.stderr?.on('data', (b: Buffer) => out.push(b.toString('utf8')));
  return { proc, out };
}

async function waitHealth(timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL}healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

async function stopServer(child: Child): Promise<void> {
  if (child.proc.exitCode !== null) return;
  child.proc.kill();
  await Promise.race([once(child.proc, 'exit'), sleep(6000)]);
}

/* ------------------------------------------------------------------ */
/* 页面操作                                                            */
/* ------------------------------------------------------------------ */

async function openLobby(p: Page, name: string): Promise<void> {
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 25_000 });
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill(name);
  await sleep(500);
}

/** 如果自己在托管中，先收回控制权 —— 重启后 AI 可能已经替你走了几步 */
async function takeback(p: Page): Promise<void> {
  const btn = p.locator('.autopilot-bar button', { hasText: '我回来了' });
  if ((await btn.count()) === 0) return;
  await btn.first().click().catch(() => {});
  await sleep(150);
}

/** 走一步：选角 → 结束出牌 / 收下 / 放弃响应 → 传情报 / 弃牌 */
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

/** 等服务端重启期间，浏览器必然打出一堆 ERR_CONNECTION_REFUSED —— 这些不算缺陷 */
const EXPECTED = [
  /WebSocket connection to .* failed/i,
  /WebSocket is closed before the connection is established/i,
  /net::ERR_CONNECTION_REFUSED/i,
  /Failed to load resource.*ERR_CONNECTION_REFUSED/i,
];

function isExpected(text: string): boolean {
  return EXPECTED.some((re) => re.test(text));
}

/** 排障用：ABS_DEBUG_FRAMES=1 时把浏览器收到的每一帧打出来 */
const DEBUG = process.env.ABS_DEBUG_FRAMES === '1';

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'abs-restart-ui-'));
  let server = startServer(dataDir);
  if (!(await waitHealth())) {
    console.error('服务端没起来', server.out.join('').slice(-500));
    await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
    process.exit(1);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors: string[] = [];
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const [tag, page] of [
    ['A', a],
    ['B', b],
  ] as const) {
    page.on('pageerror', (e) => {
      if (!isExpected(e.message)) errors.push(`${tag} pageerror: ${e.message}`);
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (!isExpected(text)) errors.push(`${tag} console: ${text.slice(0, 160)}`);
    });
    if (DEBUG && tag === 'A') {
      page.on('websocket', (sock) => {
        sock.on('framesent', (f) => console.log(`  → ${String(f.payload).slice(0, 120)}`));
        sock.on('framereceived', (f) => console.log(`  ← ${String(f.payload).slice(0, 200)}`));
      });
    }
  }

  console.log('1) 建房 / 加入 / 开局');
  await openLobby(a, '甲');
  await a.locator('button', { hasText: '创建并进入' }).click();
  await a.waitForSelector('.room-bigcode', { timeout: 15_000 });
  const code = ((await a.locator('.room-bigcode').textContent()) ?? '').trim();

  await openLobby(b, '乙');
  await b.locator('input[placeholder="例如 A3KP"]').fill(code);
  await b.locator('.field-inline button', { hasText: '加入' }).click();
  await b.waitForSelector('.room-bigcode', { timeout: 15_000 });

  await a.locator('button', { hasText: '开始对局' }).click();
  await a.waitForSelector('.battle', { timeout: 20_000 });
  await b.waitForSelector('.battle', { timeout: 20_000 });
  check('两个人都在对局里', true, code);

  // 先走几步，让日志有内容 —— 重启后要用它证明「进度没丢」
  for (let i = 0; i < 6; i++) {
    await takeback(a);
    await takeback(b);
    await step(a).catch(() => false);
    await step(b).catch(() => false);
    await sleep(200);
  }
  const logBefore = await a.locator('.log-item').count();
  check('重启前已经有日志', logBefore > 0, logBefore);

  /**
   * 一轮「停服 → 重启 → 客户端自愈」。
   *
   * 两种停法都要验，因为它们在真实世界里对应两件不同的事：
   *  - graceful：发版时的优雅排水。服务端会先落盘、再发 restart 通知、最后关连接。
   *    这条路上最怕的是「通知被客户端当成报错，于是把人踢回大厅、座位也清掉」。
   *  - crash：进程被强杀 / OOM。只能靠周期快照兜底，最多丢 2 秒进度。
   */
  async function restartRound(mode: 'graceful' | 'crash', round: number): Promise<void> {
    const label = mode === 'graceful' ? '优雅排水' : '进程被强杀';
    console.log(`${round}) 停服务端（${label}）`);

    const before = await a.locator('.log-item').count();

    if (mode === 'graceful') {
      const res = await fetch(`${URL}admin/shutdown`, {
        method: 'POST',
        headers: { 'x-abs-token': ADMIN_TOKEN },
      });
      check('排水接口返回 202', res.status === 202, res.status);

      // 关键断言：客户端拿到的是「服务器要重启」，不是「你的座位没了」
      const noticed = await a
        .waitForFunction(() => (document.body.textContent ?? '').includes('正在重启'), null, {
          timeout: 8000,
        })
        .then(() => true)
        .catch(() => false);
      check('界面提示「服务器正在重启」', noticed);
      check('重启通知没有把玩家踢回大厅', (await a.locator('.lobby').count()) === 0);
    }

    await stopServer(server);
    check('服务端进程已退出', server.proc.exitCode !== null || server.proc.killed);

    const overlay = await a
      .waitForSelector('.reconnect-overlay', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check('界面进入「正在重连…」', overlay);

    console.log('   重启服务端（同一份快照）');
    server = startServer(dataDir);
    const up = await waitHealth(25_000);
    check('服务端重新监听', up, server.out.join('').slice(-400));

    const recovered = await a
      .waitForSelector('.reconnect-overlay', { state: 'detached', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    check('遮罩消失（客户端自己连回来了）', recovered);

    check('还停在对局界面，没被踢回大厅', (await a.locator('.battle').count()) > 0);

    // 房间号应该还是原来那个（说明恢复的是同一个房间，不是新建了一个）
    const headText = (await a.locator('.battle').textContent()) ?? '';
    check('房间号没变', headText.includes(code), code);

    const after = await a.locator('.log-item').count();
    check('对局日志没丢（恢复后条数不减）', after >= before, `${before} → ${after}`);

    // 恢复后还能出牌（可能正好轮到 AI，等它走完）
    let played = 0;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && played < 2) {
      await takeback(a);
      await takeback(b);
      const did = (await step(a).catch(() => false)) || (await step(b).catch(() => false));
      if (did) {
        played++;
        await sleep(250);
      } else {
        await sleep(400);
      }
    }
    check('恢复后仍能出牌', played > 0, played);
  }

  await restartRound('graceful', 2);
  await restartRound('crash', 3);

  await a.screenshot({ path: 'shots/restart-client.png' });
  console.log('  · shots/restart-client.png');

  check('没有预期之外的控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  await stopServer(server);
  await rm(dataDir, { recursive: true, force: true });

  console.log('');
  if (failures.length > 0) {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`通过 ${passed} 项`);
  console.log('浏览器侧重启恢复验收通过。');
}

void main().catch((err) => {
  console.error('验收脚本异常', err);
  process.exit(1);
});

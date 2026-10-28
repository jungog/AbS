/**
 * 「掉线」在界面上长什么样 —— 出图用。
 *
 * 两段：
 *  1. **房间页**：3 个人在房里，其中 1 个直接关掉 socket（模拟关浏览器，不是点「离开」）。
 *     房主必须看到「他会由 AI 代打」—— 否则他会以为「3 个人打」，实际是 2 个人 + 1 个 AI。
 *  2. **大厅**：一个房间的人全掉线了。座位还留着（5 分钟保座宽限期），
 *     但一个人都不在屏幕前 —— 大厅要标「无人在线」并禁用入口，
 *     否则点进去会独自坐在空房间里，还莫名其妙接管房主。
 *
 * 前置：npm run build && npm run server（默认打 8787）
 */
import { WebSocket } from 'ws';
import { chromium } from 'playwright';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const WS_URL = URL.replace(/^http/, 'ws');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一个只用来「占座然后消失」的客户端 */
async function openGhost(name: string, room?: string): Promise<{ ws: WebSocket; roomId: string }> {
  const ws = new WebSocket(WS_URL);
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
  });
  ws.send(
    room
      ? JSON.stringify({ t: 'join', room, name })
      : JSON.stringify({ t: 'create', name, isPublic: true }),
  );
  const roomId = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('等 joined 超时')), 8000);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { t: string; room?: string };
      if (m.t === 'joined' && m.room) {
        clearTimeout(timer);
        res(m.room);
      }
    });
  });
  return { ws, roomId };
}

const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1100, height: 760 } });
const p = await ctx.newPage();

/* ---------------- 1. 房间页：有人掉线 ---------------- */
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
await p.waitForSelector('.lobby', { timeout: 10_000 });
await p.locator('.nick-input').fill('房主');
await sleep(400);
await p.locator('button', { hasText: '创建并进入' }).click();
await p.waitForSelector('.room-bigcode', { timeout: 15_000 });
const code = (await p.locator('.room-bigcode').textContent())?.trim() ?? '';
console.log('房间号：' + code);

// 两个人进来，然后其中一个直接掉线
const guest1 = await openGhost('客人甲', code);
await sleep(300);
const guest2 = await openGhost('客人乙', code);
await sleep(600);
guest2.ws.close();
console.log('客人乙 已掉线（没点离开）');
await sleep(1200);

await p.screenshot({ path: 'shots/room-offline.png' });
const roomInfo = await p.evaluate(() => ({
  offlineSeats: document.querySelectorAll('.seat.offline').length,
  hint: document.querySelector('.hint.warn')?.textContent ?? '',
  humanHint: Array.from(document.querySelectorAll('.hint')).map((e) => e.textContent).join(' | '),
}));
console.log('房间页：' + JSON.stringify(roomInfo));

/* ---------------- 2. 大厅：整个房间都没人在线 ---------------- */
guest1.ws.close();
await p.locator('button', { hasText: '离开' }).first().click();
await p.waitForSelector('.lobby', { timeout: 10_000 });

const ghost = await openGhost('全掉线的人');
ghost.ws.close();
console.log('幽灵房间：' + ghost.roomId);
await sleep(1200);

await p.screenshot({ path: 'shots/lobby-ghost.png' });
const lobbyInfo = await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.room-row')) as HTMLElement[];
  const target = rows.find((r) => r.querySelector('.offline-tag')) ?? null;
  const btn = target?.querySelector('button') as HTMLButtonElement | null;
  return { text: target?.textContent ?? '', disabled: btn?.disabled ?? null };
});
console.log('大厅：' + JSON.stringify(lobbyInfo));

await b.close();

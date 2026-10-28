/**
 * 生产化验收 —— 单端口托管 / 防护 / 容量 / 快照恢复
 *
 * 前面几个测试脚本验的是「规则对不对」，这个验的是「能不能真的对外服务」：
 *
 *  A. HTTP：/healthz、/stats、静态托管（长缓存 / 不缓存 / 路径穿越 / SPA 回落）
 *  B. 防护：令牌桶限流、消息体积上限、连接总数上限
 *  C. 容量：房间总数上限
 *  D. 快照：SnapshotStore 的读写、指纹校验、坏文件容错
 *  E. 重启恢复：起一个真子进程建房开局 → 杀掉 → 再起一个 → 凭 token 回原座
 *
 * E 是唯一需要子进程的一段。为什么不 import 两次：ESM 模块只能求值一次，
 * 「模拟重启」在同一个进程里是做不到的 —— 而重启恢复正是这一轮最需要被证明的东西。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { ServerMsg } from '../src/net/protocol';
import type { RedactedState } from '../src/core/redact';
import { loadDefaultPack } from '../src/data/load';
import { packFingerprint, SnapshotStore, SNAPSHOT_VERSION, type Snapshot } from '../server/persist';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;

/* 必须在 import 服务端之前设好 */
process.env.PORT = String(PORT);
process.env.ABS_TURN_TIMEOUT_MS = '4000';
process.env.ABS_BOT_STEP_MS = '60';
process.env.ABS_MAX_ROOMS = '2';
process.env.ABS_MAX_SPECTATORS = '2';
process.env.ABS_MAX_CONNECTIONS = '12';
process.env.ABS_MSG_BURST = '30';
process.env.ABS_MSG_RATE = '10';
process.env.ABS_MAX_PAYLOAD = '1024';
/* 本进程不落盘：快照相关的东西在 D/E 两段里单独验 */
process.env.ABS_DATA_DIR = 'off';
/* 排水接口默认关闭，A 段要断言它确实不存在 */
delete process.env.ABS_ADMIN_TOKEN;

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
/* WebSocket 客户端                                                     */
/* ------------------------------------------------------------------ */

interface Waiter {
  pred: (m: ServerMsg) => boolean;
  resolve: (m: ServerMsg) => void;
  timer: ReturnType<typeof setTimeout>;
}

class Client {
  readonly ws: WebSocket;
  inbox: ServerMsg[] = [];
  private waiters: Waiter[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });
    this.ws.on('message', (raw) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(raw)) as ServerMsg;
      } catch {
        return;
      }
      this.inbox.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i]!;
        if (w.pred(msg)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });
    // 没有 error 监听时 ws 会直接抛
    this.ws.on('error', () => {});
  }

  open(): Promise<void> {
    return once(this.ws, 'open').then(() => undefined);
  }

  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  wait(pred: (m: ServerMsg) => boolean, label: string, timeoutMs = 6000): Promise<ServerMsg> {
    const hit = this.inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等待超时：${label}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(name: string): Promise<Client> {
  const c = new Client(`ws://127.0.0.1:${PORT}`);
  await c.open();
  c.send({ t: 'lobby' });
  void name;
  return c;
}

const isError = (m: ServerMsg) => m.t === 'error';
const isJoined = (m: ServerMsg) => m.t === 'joined';

/* ------------------------------------------------------------------ */
/* A. HTTP                                                             */
/* ------------------------------------------------------------------ */

async function phaseHttp(): Promise<void> {
  console.log('\n[A] HTTP：探活 / 指标 / 静态托管');

  const health = await fetch(`${BASE}/healthz`);
  const healthBody = (await health.json()) as { ok?: boolean };
  check('/healthz 返回 200', health.status === 200, health.status);
  check('/healthz 内容 ok=true', healthBody.ok === true, JSON.stringify(healthBody));
  check('/healthz 不缓存', health.headers.get('cache-control') === 'no-store');

  const statsRes = await fetch(`${BASE}/stats`);
  const statsBody = (await statsRes.json()) as { limits?: { maxRooms?: number }; rooms?: number };
  check('/stats 返回 200', statsRes.status === 200);
  check('/stats 带上限信息', statsBody.limits?.maxRooms === 2, JSON.stringify(statsBody.limits));
  check('/stats 带房间数', typeof statsBody.rooms === 'number');

  const index = await fetch(`${BASE}/`);
  const indexText = await index.text();
  check('/ 返回 200', index.status === 200);
  check('/ 是 HTML', (index.headers.get('content-type') ?? '').includes('text/html'));
  check('/ 不缓存（否则改版后用户拿到旧页面）', index.headers.get('cache-control') === 'no-cache');
  check('/ 内容里引用了前端脚本', /<script[^>]+src=/.test(indexText));

  const etag = index.headers.get('etag');
  if (etag) {
    const again = await fetch(`${BASE}/`, { headers: { 'if-none-match': etag } });
    check('ETag 命中返回 304', again.status === 304, again.status);
  } else {
    check('index.html 带 ETag', false, '没有 ETag');
  }

  // 带内容哈希的产物应该长缓存
  const assetsDir = path.join(ROOT, 'dist', 'assets');
  const assets = existsSync(assetsDir) ? await readdir(assetsDir) : [];
  const js = assets.find((n) => n.endsWith('.js'));
  if (js) {
    const asset = await fetch(`${BASE}/assets/${js}`);
    check('产物文件返回 200', asset.status === 200);
    check(
      '带哈希的产物长缓存',
      (asset.headers.get('cache-control') ?? '').includes('immutable'),
      asset.headers.get('cache-control'),
    );
  } else {
    check('dist/assets 里有 js 产物（先 npm run build）', false, assetsDir);
  }

  const trav = await fetch(`${BASE}/%2e%2e%2fpackage.json`);
  check('编码过的路径穿越被拦（403）', trav.status === 403, trav.status);

  const nul = await fetch(`${BASE}/%00`);
  check('含空字节的路径被拒（400）', nul.status === 400, nul.status);

  const missing = await fetch(`${BASE}/assets/definitely-not-here.js`);
  check('缺失的产物是 404 而不是 HTML', missing.status === 404, missing.status);

  const spa = await fetch(`${BASE}/some/deep/route`);
  check('无扩展名路径回落到 index.html', spa.status === 200 && (spa.headers.get('content-type') ?? '').includes('text/html'));

  const post = await fetch(`${BASE}/`, { method: 'POST' });
  check('非 GET/HEAD 返回 405', post.status === 405, post.status);

  const nosniff = index.headers.get('x-content-type-options');
  check('带 X-Content-Type-Options: nosniff', nosniff === 'nosniff', nosniff);

  // 排水接口默认不开放：没配 ABS_ADMIN_TOKEN 时它必须像不存在一样
  const adminOff = await fetch(`${BASE}/admin/shutdown`, { method: 'POST' });
  check('未配置 ABS_ADMIN_TOKEN 时排水接口不存在（404）', adminOff.status === 404, adminOff.status);
}

/* ------------------------------------------------------------------ */
/* B. 防护                                                             */
/* ------------------------------------------------------------------ */

async function phaseGuard(): Promise<void> {
  console.log('\n[B] 防护：限流 / 体积上限');

  // 限流：突发 30、每秒补 10。连发 100 条必然触发
  const flood = await connect('flood');
  for (let i = 0; i < 100; i++) flood.send({ t: 'ping' });
  const limited = await flood.wait(isError, '限流错误', 4000).catch(() => null);
  check(
    '连发消息会收到限流提示',
    Boolean(limited && limited.t === 'error' && limited.msg.includes('频繁')),
    limited && limited.t === 'error' ? limited.msg : 'no error',
  );

  const floodClosed = await Promise.race([flood.closed, sleep(3000).then(() => null)]);
  check(
    '持续超限的连接被主动断开（1008）',
    Boolean(floodClosed && floodClosed.code === 1008),
    floodClosed ? floodClosed.code : 'still open',
  );

  // 体积上限：ABS_MAX_PAYLOAD=1024
  const big = new Client(`ws://127.0.0.1:${PORT}`);
  await big.open();
  big.send({ t: 'ping', pad: 'x'.repeat(4000) });
  const bigClosed = await Promise.race([big.closed, sleep(3000).then(() => null)]);
  check(
    '超过体积上限的消息导致断开（1009）',
    Boolean(bigClosed && bigClosed.code === 1009),
    bigClosed ? bigClosed.code : 'still open',
  );

  // 限流之后同一进程还能正常服务（桶是按连接算的，不是全局）
  const ok = await connect('after-flood');
  ok.send({ t: 'ping' });
  const pong = await ok.wait((m) => m.t === 'pong', 'pong', 3000).catch(() => null);
  check('限流只影响那一条连接，不影响别人', pong?.t === 'pong');
  ok.close();
}

/* ------------------------------------------------------------------ */
/* C. 容量                                                             */
/* ------------------------------------------------------------------ */

async function phaseCapacity(): Promise<void> {
  console.log('\n[C] 容量：房间上限 / 连接上限');

  const a = await connect('A');
  a.send({ t: 'create', room: 'CAPA', name: '甲' });
  const ja = await a.wait(isJoined, 'A 建房', 4000).catch(() => null);
  check('第 1 个房间能建', ja?.t === 'joined');

  const b = await connect('B');
  b.send({ t: 'create', room: 'CAPB', name: '乙' });
  const jb = await b.wait(isJoined, 'B 建房', 4000).catch(() => null);
  check('第 2 个房间能建', jb?.t === 'joined');

  const c = await connect('C');
  c.send({ t: 'create', room: 'CAPC', name: '丙' });
  const capErr = await c.wait(isError, '第 3 个房间被拒', 4000).catch(() => null);
  check(
    '房间数到上限后拒绝新建',
    Boolean(capErr && capErr.t === 'error' && capErr.msg.includes('上限')),
    capErr && capErr.t === 'error' ? capErr.msg : 'no error',
  );

  // 连接上限 12：已有 a/b/c 三条（flood/big 已断），再开 15 条必然有被拒的
  const extra: Client[] = [];
  let opened = 0;
  let rejected = 0;
  for (let i = 0; i < 15; i++) {
    const cl = new Client(`ws://127.0.0.1:${PORT}`);
    const outcome = await Promise.race([
      once(cl.ws, 'open')
        .then(() => 'open' as const)
        // 被 503 拒掉时 once 会带着 error 拒绝，不吞掉就会变成未处理拒绝
        .catch(() => 'error' as const),
      once(cl.ws, 'error').then(() => 'error' as const),
      sleep(2000).then(() => 'timeout' as const),
    ]);
    if (outcome === 'open') {
      opened++;
      extra.push(cl);
    } else {
      rejected++;
      cl.ws.terminate();
    }
  }
  check('连接数受上限约束（有被拒的）', rejected > 0, `opened=${opened} rejected=${rejected}`);
  check('已建立的连接不超过上限', 3 + opened <= 12, `3 + ${opened}`);

  for (const cl of extra) cl.close();
  a.close();
  b.close();
  c.close();
  await sleep(300);
}

/* ------------------------------------------------------------------ */
/* D. 快照存储                                                         */
/* ------------------------------------------------------------------ */

async function phaseSnapshot(): Promise<void> {
  console.log('\n[D] 快照：读写 / 指纹 / 容错');

  const pack = loadDefaultPack();
  const fp = packFingerprint(pack);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'abs-snap-'));
  const file = path.join(dir, 'rooms.json');

  const build = (savedAt = Date.now()): Snapshot => ({
    v: SNAPSHOT_VERSION,
    savedAt,
    pack: fp,
    rooms: [
      {
        id: 'SNAP',
        password: 'x',
        hostId: 'u1',
        isPublic: true,
        createdAt: Date.now(),
        started: false,
        ready: [],
        seats: [
          {
            playerId: 'u1',
            resumeToken: 'tk1',
            gamePlayerId: null,
            name: '甲',
            seat: 0,
            isBot: false,
          },
        ],
        state: null,
      },
    ],
  });

  let savedAt = Date.now();
  const store = new SnapshotStore({ file, build: () => build(savedAt) });
  await store.flush();
  check('落盘后文件存在', existsSync(file));
  check('临时文件已清掉（原子写）', !existsSync(`${file}.tmp`));

  const loaded = await store.load(fp);
  check('快照能读回来', loaded?.rooms.length === 1, loaded?.rooms.length);
  check('座位信息完整', loaded?.rooms[0]?.seats[0]?.resumeToken === 'tk1');

  const wrongPack = await store.load('0000000000000000');
  check('卡池指纹不匹配时整份丢弃', wrongPack === null);

  savedAt = Date.now() - 13 * 60 * 60_000;
  await store.flush();
  const stale = await store.load(fp);
  check('过期快照被丢弃', stale === null);

  await writeFile(file, '{ this is not json', 'utf8');
  const broken = await store.load(fp);
  check('坏 JSON 不会抛错，返回 null', broken === null);

  const noFile = await new SnapshotStore({ file: path.join(dir, 'none.json'), build }).load(fp);
  check('没有快照文件时返回 null', noFile === null);

  await rm(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* E. 重启恢复                                                         */
/* ------------------------------------------------------------------ */

const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT, 'server', 'index.ts');

interface Child {
  proc: ChildProcess;
  out: string[];
}

function startChild(port: number, dataDir: string, extra: Record<string, string> = {}): Child {
  const out: string[] = [];
  const proc = spawn(process.execPath, [TSX_CLI, ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ABS_DATA_DIR: dataDir,
      ABS_PERSIST_MS: '150',
      ABS_BOT_STEP_MS: '80',
      ABS_TURN_TIMEOUT_MS: '3000',
      ABS_MAX_ROOMS: '50',
      ABS_MAX_CONNECTIONS: '50',
      ABS_MSG_BURST: '200',
      ABS_MSG_RATE: '100',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (b: Buffer) => out.push(b.toString('utf8')));
  proc.stderr?.on('data', (b: Buffer) => out.push(b.toString('utf8')));
  return { proc, out };
}

async function waitHealth(port: number, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

async function stopChild(child: Child): Promise<void> {
  if (child.proc.exitCode !== null) return;
  child.proc.kill();
  await Promise.race([once(child.proc, 'exit'), sleep(5000)]);
}

async function phaseRestart(): Promise<void> {
  console.log('\n[E] 重启恢复：开局 → 杀进程 → 再起 → 凭 token 回座');

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'abs-restart-'));
  const port = 8796;
  const url = `ws://127.0.0.1:${port}`;

  /* ---- 第一次启动 ---- */
  const first = startChild(port, dataDir);
  const up1 = await waitHealth(port);
  check('第一个进程起来了', up1, first.out.join('').slice(-400));
  if (!up1) {
    await stopChild(first);
    await rm(dataDir, { recursive: true, force: true });
    return;
  }

  const c1 = new Client(url);
  await c1.open();
  c1.send({ t: 'create', room: 'RSTR', name: '重启甲' });
  const joined = (await c1.wait(isJoined, '建房', 6000)) as Extract<ServerMsg, { t: 'joined' }>;
  const token = joined.token;
  check('建房成功并拿到 token', Boolean(token), token);

  const c2 = new Client(url);
  await c2.open();
  c2.send({ t: 'join', room: 'RSTR', name: '重启乙' });
  await c2.wait(isJoined, '加入', 6000);

  c1.send({ t: 'start', playerCount: 3, bots: 1 });
  const st = (await c1.wait((m) => m.t === 'state', '开局状态', 8000)) as Extract<
    ServerMsg,
    { t: 'state' }
  >;
  check('开局成功（3 人）', st.state.players.length === 3, st.state.players.length);

  // 等落盘：ABS_PERSIST_MS=150，给足 4 秒。
  //
  // 这里等的是**断言本身**（`"started":true`），不是「文件里出现 RSTR」。
  // 房间是开局前就建好的，第一份含 RSTR 的快照完全可能是「还没开局」那一版；
  // 读到它就 break、紧接着杀进程，磁盘上留下的就是没有对局的快照 ——
  // 后面「恢复后能拿到对局状态 / 人数没丢 / 进度没丢」三条会跟着一起红，
  // 看起来像持久化回归，其实只是等错了东西（实测偶发 4 条全红，单独重跑 62/62 全绿）。
  let persisted = '';
  for (let i = 0; i < 40; i++) {
    persisted = await readFile(path.join(dataDir, 'rooms.json'), 'utf8').catch(() => '');
    if (persisted.includes('"RSTR"') && persisted.includes('"started":true')) break;
    await sleep(100);
  }
  check('房间已落盘', persisted.includes('"RSTR"'), persisted.slice(0, 120));
  check('落盘内容里有进行中的对局', persisted.includes('"started":true'), persisted.slice(0, 160));

  /* ---- 杀掉第一个进程 ---- */
  await stopChild(first);
  check('第一个进程已退出', first.proc.exitCode !== null || first.proc.killed);

  /* ---- 第二次启动 ---- */
  const second = startChild(port, dataDir);
  const up2 = await waitHealth(port);
  check('重启后服务恢复监听', up2, second.out.join('').slice(-400));
  if (!up2) {
    await stopChild(second);
    await rm(dataDir, { recursive: true, force: true });
    return;
  }

  const statsRes = await fetch(`http://127.0.0.1:${port}/stats`);
  const statsBody = (await statsRes.json()) as { restores?: number; rooms?: number };
  check('恢复计数 > 0', (statsBody.restores ?? 0) > 0, JSON.stringify(statsBody));
  check('恢复后房间还在', (statsBody.rooms ?? 0) >= 1, JSON.stringify(statsBody));

  const c3 = new Client(url);
  await c3.open();
  c3.send({ t: 'resume', room: 'RSTR', token });
  const resumed = (await c3.wait(isJoined, '回座', 8000).catch(() => null)) as
    | Extract<ServerMsg, { t: 'joined' }>
    | null;
  check('重启后能凭 token 回原座', Boolean(resumed && resumed.resumed), resumed?.resumed);
  check('回到的是同一个房间', resumed?.room === 'RSTR', resumed?.room);

  const restState = (await c3.wait((m) => m.t === 'state', '恢复后的状态', 8000).catch(() => null)) as
    | Extract<ServerMsg, { t: 'state' }>
    | null;
  const rs = restState?.state as RedactedState | undefined;
  check('恢复后能拿到对局状态', Boolean(rs), restState ? 'ok' : 'no state');
  check('对局人数没丢（3 人）', rs?.players.length === 3, rs?.players.length);
  check('对局进度没丢（轮次 >= 1）', (rs?.round ?? 0) >= 1, rs?.round);

  await stopChild(second);
  await rm(dataDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* F. 优雅关闭（运维排水）                                              */
/* ------------------------------------------------------------------ */

async function phaseGracefulShutdown(): Promise<void> {
  console.log('\n[F] 优雅关闭：排水接口 / restart 通知 / 强刷快照');

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'abs-drain-'));
  const port = 8800;
  const token = 'drain-token-for-test';
  const child = startChild(port, dataDir, { ABS_ADMIN_TOKEN: token });

  const up = await waitHealth(port);
  check('排水测试用的进程起来了', up, child.out.join('').slice(-300));
  if (!up) {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
    return;
  }

  const c = new Client(`ws://127.0.0.1:${port}`);
  await c.open();
  c.send({ t: 'create', room: 'DRAIN', name: '甲' });
  const j = await c.wait(isJoined, '建房', 6000).catch(() => null);
  check('客户端已进房（准备被排水）', j?.t === 'joined');

  const url = `http://127.0.0.1:${port}/admin/shutdown`;

  const noToken = await fetch(url, { method: 'POST' });
  check('不带 token 的排水请求被拒（403）', noToken.status === 403, noToken.status);

  const wrongToken = await fetch(url, { method: 'POST', headers: { 'x-abs-token': 'nope' } });
  check('token 不对也被拒（403）', wrongToken.status === 403, wrongToken.status);

  const getInstead = await fetch(url, { headers: { 'x-abs-token': token } });
  check('用 GET 调排水接口被拒（405）', getInstead.status === 405, getInstead.status);

  const ok = await fetch(url, { method: 'POST', headers: { 'x-abs-token': token } });
  check('带正确 token 的排水请求返回 202', ok.status === 202, ok.status);

  const restart = (await c.wait((m) => m.t === 'restart', 'restart 通知', 6000).catch(() => null)) as
    | Extract<ServerMsg, { t: 'restart' }>
    | null;
  check('客户端收到 restart 通知', Boolean(restart), 'no restart');
  check('通知文案说明会自动重连', Boolean(restart?.msg.includes('重连')), restart?.msg);
  check(
    '关闭通知没有伪装成 error（否则客户端会清掉座位存档）',
    !c.inbox.some((m) => m.t === 'error' && m.msg.includes('重启')),
  );

  const exited = await Promise.race([
    once(child.proc, 'exit').then(() => true),
    sleep(10_000).then(() => false),
  ]);
  check('进程优雅退出（不是被强杀）', exited);

  const text = await readFile(path.join(dataDir, 'rooms.json'), 'utf8').catch(() => '');
  check('关闭前强刷了快照（房间还在）', text.includes('"DRAIN"'), text.slice(0, 80));

  await stopChild(child);
  await rm(dataDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await import('../server/index');
  // 等监听就绪（main() 里的 listen 是异步的）
  const up = await waitHealth(PORT, 15_000);
  if (!up) {
    console.error('服务端没有起来，后续检查全部跳过');
    process.exit(1);
  }

  await phaseHttp();
  await phaseGuard();
  await phaseCapacity();
  await phaseSnapshot();
  await phaseRestart();
  await phaseGracefulShutdown();

  console.log('');
  if (failures.length > 0) {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`通过 ${passed} 项`);
  console.log('生产化验收通过。');
  process.exit(0);
}

void main().catch((err) => {
  console.error('测试脚本异常', err);
  process.exit(1);
});

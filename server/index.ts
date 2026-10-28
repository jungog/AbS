/**
 * 服务端 —— 权威端（静态资源 + WebSocket 对局，同一个端口）
 *
 * 复用了与客户端完全相同的引擎，只是把「状态」按玩家裁剪后再下发。
 * 启动：npm run build && npm run server
 *
 * 六件事都在这里：
 *  1. 房间：创建 / 大厅列表 / 按号加入 / 房主转移 / 空房回收
 *  2. 重连：每个座位发一个 resumeToken，断线 5 分钟内凭 token 回原座
 *  3. 超时托管：每个操作点 30 秒倒计时，超时或掉线就交给 AI 代打，本人回来点「我回来了」立刻交还
 *  4. 观战：不占座位、不发指令，只收「公开视角」—— 手牌全不可见、身份不公开
 *  5. 静态托管：dist/ 由这里发出去，前端和 WebSocket 同源同端口（客户端生产环境走 location.host）
 *  6. 快照持久化：进程重启后房间还在，进行中的对局接着打（座位算离线，等重连）
 *
 * 参数都能用环境变量覆盖（测试里调小）：
 *   PORT                        监听端口，默认 8787
 *   ABS_TURN_TIMEOUT_MS         每个操作点的思考时间，默认 30000
 *   ABS_SEAT_GRACE_MS           掉线后座位保留时长，默认 300000
 *   ABS_BOT_STEP_MS             AI 代打每一步的间隔，默认 300
 *   ABS_SPECTATOR_DELAY_ROUNDS  观战落后几轮，默认 1
 *   ABS_CLEANUP_MS              空房 / 过期座位的巡检间隔，默认 15000
 *   ABS_MAX_ROOMS               房间总数上限，默认 200
 *   ABS_MAX_SPECTATORS          单房观战位上限，默认 20
 *   ABS_MAX_CONNECTIONS         连接总数上限，默认 500
 *   ABS_MSG_BURST / ABS_MSG_RATE  单连接令牌桶（突发量 / 每秒补充），默认 200 / 100
 *   ABS_DATA_DIR                快照目录，默认 ./.abs-data；设为 "off" 则不落盘
 *   ABS_PERSIST_MS              快照巡检间隔，默认 2000
 *   ABS_STATIC_DIR              静态目录，默认 ./dist
 *   ABS_ADMIN_TOKEN             配了才开放 POST /admin/shutdown（运维排水，默认关闭）
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { loadDefaultPack } from '../src/data/load';
import { appendSystemLog, applyCommand, createGame } from '../src/core/engine';
import { botDecide } from '../src/core/ai';
import { redactPublic, redactState } from '../src/core/redact';
import type { Command, GameState } from '../src/core/types';
import type { RedactedState } from '../src/core/redact';
import type { ClientMsg, RoomSeat, RoomSummary, ServerMsg } from '../src/net/protocol';
import { createStaticHandler, writeJson } from './static';
import {
  packFingerprint,
  SnapshotStore,
  SNAPSHOT_VERSION,
  type Snapshot,
  type SnapshotRoom,
} from './persist';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 环境变量取整数。写错了就退回默认值 —— 一个手滑的 env 不该让服务起不来 */
/**
 * 环境变量取整数。写错了就退回默认值 —— 一个手滑的 env 不该让服务起不来。
 *
 * 这个函数不是「防御性编程」的装饰品，它挡的是一个很难查的事故：
 * `Number('20_000')` 是 **NaN**（下划线是数字字面量语法，不是字符串语法），
 * 而 `setTimeout(fn, NaN)` 等价于 0 毫秒 —— 于是 `ABS_TURN_TIMEOUT_MS=20_000`
 * 会让「思考时间」变成「立刻超时，AI 接管」，界面看起来像所有人都在被托管。
 * 实测踩过一次（验收脚本里写错了一个下划线），所以所有数值型 env 一律走这里。
 */
function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.warn(`[配置] ${name}=${JSON.stringify(raw)} 不是合法数字，改用默认值 ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

const PORT = envInt('PORT', 8787, 1);
const TURN_TIMEOUT_MS = envInt('ABS_TURN_TIMEOUT_MS', 30_000, 100);
const SEAT_GRACE_MS = envInt('ABS_SEAT_GRACE_MS', 5 * 60_000, 1000);
const BOT_STEP_MS = envInt('ABS_BOT_STEP_MS', 300, 10);
/**
 * 观战延迟：**按回合，落后 1 轮**。
 *
 * 不延迟的话，观众看到的是和玩家完全同步的实时状态 —— 微信语音里一句「他手里有红」
 * 就能把整局作弊掉。
 *
 * 为什么是「一轮」而不是「30 秒」：
 * - 固定秒数在慢局里太保守 —— 观众盯着半分钟前的选角画面干等，而那一局其实毫无进展；
 * - 固定秒数在快局里又不够 —— 30 秒够看好几手了；
 * - 按轮的语义是明确的：**当前这一轮里发生的任何事，观众都看不到**。和回合制的节奏天然对齐。
 *
 * 代价是「一轮之内画面是静止的」。这不是 bug：观众看的就是「上一轮结束时的牌桌」，
 * 状态栏会写「慢 1 轮」，让他知道自己在看过去。
 */
const SPECTATOR_DELAY_ROUNDS = envInt('ABS_SPECTATOR_DELAY_ROUNDS', 1, 0);

/* ---------------- 容量与防护 ---------------- */

/**
 * 上限全部可配。默认值按「一台 2 核小机器」估：
 *  - 200 个房间 ≈ 200 局同时进行，每局状态几 KB，内存不是瓶颈，CPU 才是（AI 代打每步要算）
 *  - 500 个连接 ≈ 200 局 × 2.5 人，够用；再往上先扩机器，而不是把单机拉满
 *
 * 这些数字**不是为了限制正常用户**，是为了让「有人拿脚本刷」这件事
 * 变成「服务端回一句 503」而不是「整台机器 OOM」。
 */
const MAX_ROOMS = envInt('ABS_MAX_ROOMS', 200, 1);
const MAX_SPECTATORS_PER_ROOM = envInt('ABS_MAX_SPECTATORS', 20, 0);
const MAX_CONNECTIONS = envInt('ABS_MAX_CONNECTIONS', 500, 1);

/**
 * 单连接令牌桶。突发 200 条、每秒补 100 条。
 *
 * 定得这么宽是有意的：一次「开局」客户端会在同一拍里发 start + 若干 lobby 刷新，
 * 手速快的人点牌也可能连着几下。真正的洪水是每秒几千条 —— 100/s 的补充速率
 * 对正常操作毫无感知，对脚本是硬墙。
 */
const MSG_BURST = envInt('ABS_MSG_BURST', 200, 1);
const MSG_RATE = envInt('ABS_MSG_RATE', 100, 1);
/** 连续超限多少次就断开。偶尔超一次只警告，一直超就是脚本 */
const MSG_STRIKE_LIMIT = 20;

/** WS 层心跳：清理半开连接（拔网线、休眠）—— 客户端 app 层 ping 管不到这种情况 */
const WS_PING_MS = 15_000;

/** 快照目录。"off" 关闭落盘（测试和一次性演示用） */
const DATA_DIR_RAW = process.env.ABS_DATA_DIR ?? path.join(ROOT, '.abs-data');
const PERSIST_ENABLED = DATA_DIR_RAW !== 'off' && DATA_DIR_RAW !== '';
const SNAPSHOT_FILE = path.join(DATA_DIR_RAW === 'off' ? ROOT : DATA_DIR_RAW, 'rooms.json');
const PERSIST_MS = envInt('ABS_PERSIST_MS', 2000, 100);

const STATIC_DIR = path.resolve(ROOT, process.env.ABS_STATIC_DIR ?? 'dist');

const pack = loadDefaultPack();
/** 卡池指纹：写进快照，换卡表之后老存档自动作废 */
const PACK_FP = packFingerprint(pack);

/* ------------------------------------------------------------------ */
/* 数据结构                                                            */
/* ------------------------------------------------------------------ */

interface Seat {
  playerId: string;
  /** 重连凭证（客户端存 localStorage） */
  resumeToken: string;
  /** 引擎内玩家 id（p0/p1/...），开局时写入 */
  gamePlayerId: string | null;
  name: string;
  seat: number;
  connected: boolean;
  isBot: boolean;
  /** 当前由 AI 代打（掉线或超时） */
  autopilot: boolean;
  /** 掉线时间戳，用于宽限期回收 */
  disconnectedAt: number | null;
  /**
   * 主动离开过（点了「离开」/ 退出观战）。
   *
   * 和「掉线」是两件事：掉线要留 5 分钟宽限期，主动离开是明确意图 ——
   * 座位该立刻摘掉，否则再来一局时剩下的人会凭空多一个 AI 空位。
   * 对局进行中不能真的删座位（引擎状态会错位），所以先打标记，
   * 等这一局结束、下次开局时再摘。
   */
  left: boolean;
}

interface Room {
  id: string;
  seats: Seat[];
  /**
   * 观战连接。刻意**不放进 seats** ——
   * 座位数组一旦混进观众，人数上限、房主转移、AI 补位、托管判定全都要额外判断，
   * 而观众和这些逻辑一点关系都没有。
   */
  spectators: Set<WebSocket>;
  /**
   * 观战延迟缓冲：每个状态变化存一份「公开视角」快照，到点才发给观众。
   *
   * 为什么没有观众时也要存：否则观众「退出再进来」就能直接拿到当前状态，
   * 延迟等于不存在 —— 那是个很好用的作弊手法。
   *
   * `round` 是延迟的判据：目标是「最新一帧 round <= 当前轮 - 1」。
   * `seq` 是帧的自增编号 —— **不能用时间戳当帧标识**：一次指令里可能同步推好几个状态，
   * `Date.now()` 会撞在同一毫秒上，去重就会误判成「这帧已经发过了」。
   */
  specBuffer: { seq: number; round: number; state: RedactedState }[];
  /** 帧序号发生器 */
  specSeq: number;
  /** 上一次推给观众的帧序号。同一轮内目标帧不变，靠它避免每 500ms 重复推一样的内容 */
  specSentSeq: number;
  /**
   * 「再来一局」的准备名单（存 playerId）。
   *
   * 做成准备制而不是房主一键重开：朋友局打完一局会复盘、会打字，
   * 房主一点就把画面重置了，比不让重开更难受。
   * 机器人不投票；掉线的人算自动准备 —— 否则一个走了的人能把整桌卡在结算页。
   */
  ready: Set<string>;
  /**
   * 是否已经广播过「本局结束」。
   *
   * 对局结束时房间的状态真的变了（从「进行中」变成「可以加入打下一局」），
   * 但 advance() 只在状态变化时推 state、不推 room，于是大厅和房间页会一直
   * 显示「进行中」。用这个标记在翻转的那一刻补一次 broadcastRoom，
   * 且只补一次 —— 否则每条指令都会触发一次全房间广播。
   */
  announcedOver: boolean;
  /**
   * 房间密码。明文存内存里没问题（进程重启即丢、也不落盘），
   * 但**永远不下发** —— 大厅和房间页只知道「有没有锁」，不知道锁的密码。
   */
  password: string | null;
  hostId: string;
  state: GameState | null;
  started: boolean;
  isPublic: boolean;
  createdAt: number;
  /** 当前操作点的截止时间戳 */
  deadlineAt: number | null;
  turnTimer: NodeJS.Timeout | null;
  /** AI 连续失败次数，防止死循环 */
  stuckCount: number;
}

const rooms = new Map<string, Room>();
/** playerId -> socket */
const sockets = new Map<string, WebSocket>();
/** socket -> { roomId, playerId } */
const session = new Map<WebSocket, { roomId: string; playerId: string }>();
/** 观战 socket -> roomId（观战者没有座位，所以单独一张表） */
const spectatorRooms = new Map<WebSocket, string>();

/**
 * 运行期计数。只增不减的累计值，`/stats` 直接吐出去 ——
 * 线上排障时最先要知道的是「谁在刷」和「有没有一直在报错」。
 */
const stats = {
  startedAt: Date.now(),
  connections: 0,
  peakConnections: 0,
  rejectedConnections: 0,
  messages: 0,
  dispatchErrors: 0,
  rateLimited: 0,
  roomsCreated: 0,
  gamesStarted: 0,
  restores: 0,
};

/**
 * 快照存储。`build` 是惰性的 —— 只有真的要写盘时才去序列化整个房间表，
 * 巡检空转时一次 JSON.stringify 都不做。
 */
const persist = new SnapshotStore({
  file: SNAPSHOT_FILE,
  build: buildSnapshot,
  intervalMs: PERSIST_MS,
  onError: (err) => console.error(`[快照] ${err instanceof Error ? err.message : String(err)}`),
});

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 人类可读的房间号，避开容易看错的 0/O/1/I */
function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return nextId('R').toUpperCase().slice(0, 6);
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function seatOfGamePlayer(room: Room, gamePlayerId: string | null): Seat | null {
  if (!gamePlayerId) return null;
  return room.seats.find((s) => s.gamePlayerId === gamePlayerId) ?? null;
}

function seatOfPlayer(room: Room, playerId: string): Seat | null {
  return room.seats.find((s) => s.playerId === playerId) ?? null;
}

/** 密码校验。返回 null 表示通过，否则返回给用户看的错误文案 */
function checkPassword(room: Room, input: unknown): string | null {
  if (room.password === null) return null;
  const got = typeof input === 'string' ? input : '';
  if (got !== room.password) return '房间密码不对。';
  return null;
}

function seatsOf(room: Room): RoomSeat[] {
  return room.seats.map((s) => ({
    playerId: s.playerId,
    gamePlayerId: s.gamePlayerId,
    name: s.name,
    seat: s.seat,
    connected: s.connected,
    isBot: s.isBot,
    autopilot: s.autopilot,
    // 客户端要能区分「掉线（会回来）」和「已离开（不会回来）」。
    // 只发 connected 的话，走了的人在对局界面里和掉线的人长得一模一样。
    left: s.left,
    ready: room.ready.has(s.playerId),
  }));
}

/** 一局打完了？只有这种情况下才允许「新人加入打下一局」 */
function isGameOver(room: Room): boolean {
  return Boolean(room.started && room.state?.winner);
}

function summaryOf(room: Room): RoomSummary {
  // 主动离开的人还留在座位表里（对局中的座位要等本局结束才摘），
  // 但大厅的人数得按「真的还在房里的人」算 —— 否则会显示 4/7 而实际只有 3 个人，
  // 并且这种幽灵座位还会占掉一个加入名额。
  const humans = room.seats.filter((s) => !s.isBot && !s.left);
  const host = seatOfPlayer(room, room.hostId);
  return {
    id: room.id,
    players: humans.length,
    // 掉线待回来的人不算「在线」：他们还在座位表里（5 分钟宽限期），
    // 但大厅上不该显示成「有人在房里」—— 那会让人点进一个空房间。
    online: humans.filter((s) => s.connected).length,
    capacity: 7,
    started: room.started,
    isPublic: room.isPublic,
    hostName: host?.name ?? '—',
    joinable: (!room.started || isGameOver(room)) && humans.length < 7,
    gameOver: isGameOver(room),
    spectators: room.spectators.size,
    hasPassword: room.password !== null,
  };
}

/**
 * 准备情况汇总。`total` 只数在线真人 —— 掉线的人自动算准备，
 * 数进来会让「3/4 已准备」这种文案自相矛盾（明明差一个却开不了）。
 *
 * 主动离开的人两边都不算：他既不是「在线」，也不该被算成一个等着开局的玩家，
 * 否则进度条会显示「3/3 已准备」然后开出一局只有 2 个人的游戏（他的座位在开局时被摘掉）。
 *
 * 分子同样只数在线的人。原来分子把掉线的人也算进去了（`|| !s.connected`），
 * 结果：3 人局里丙掉线、甲点了准备、乙没点 —— 分子 = 甲 + 丙 = 2，
 * 分母 = max(在线 2, 分子 2) = 2，界面显示「2 / 2 已准备」，
 * 但 allReady 是 false，游戏根本不会开始。玩家会盯着一个「已满」的进度条干等。
 * 掉线者的「自动准备」是 allReady 的规则，不该泄漏到进度条上。
 */
function readySummary(room: Room): { count: number; total: number; offline: number } {
  const humans = room.seats.filter((s) => !s.isBot && !s.left);
  const online = humans.filter((s) => s.connected);
  const count = online.filter((s) => room.ready.has(s.playerId)).length;
  return { count, total: online.length, offline: humans.length - online.length };
}

/* ------------------------------------------------------------------ */
/* 广播                                                                */
/* ------------------------------------------------------------------ */

function roomPayload(room: Room): ServerMsg {
  return {
    t: 'room',
    room: room.id,
    seats: seatsOf(room),
    started: room.started,
    hostId: room.hostId,
    isPublic: room.isPublic,
    spectators: room.spectators.size,
    hasPassword: room.password !== null,
    ready: readySummary(room),
    gameOver: isGameOver(room),
  };
}

function broadcastRoom(room: Room): void {
  // 房间结构变了（加入/离开/换座/准备/开局）→ 值得落盘
  persist.touch();
  const payload = roomPayload(room);
  for (const s of room.seats) {
    if (s.isBot) continue;
    const ws = sockets.get(s.playerId);
    if (ws) send(ws, payload);
  }
  for (const ws of room.spectators) send(ws, payload);
  broadcastLobby();
}

function broadcastState(room: Room): void {
  if (!room.state) return;
  // 对局推进了 → 值得落盘（节流由 SnapshotStore 负责，这里只管标脏）
  persist.touch();
  for (const s of room.seats) {
    if (s.isBot) continue;
    if (!s.gamePlayerId) continue;
    const ws = sockets.get(s.playerId);
    if (!ws) continue;
    send(ws, {
      t: 'state',
      state: redactState(room.state, pack, s.gamePlayerId),
      deadlineAt: room.deadlineAt,
      autopilot: s.autopilot,
    });
  }

  // 观众拿的是「公开视角」，不是上帝视角：手牌全空、身份不公开。
  // 这里绝不能复用 viewerId = null（那是全公开），否则每个观众都是作弊器。
  room.specSeq += 1;
  room.specBuffer.push({
    seq: room.specSeq,
    round: room.state.round,
    state: redactPublic(room.state, pack),
  });
  // 上限保护：一局正常几百帧，但机器人连续快进时可能更多。
  // 每帧都带完整日志，不封顶的话长对局后期会攒出几十 MB。
  if (room.specBuffer.length > SPEC_BUFFER_MAX) {
    room.specBuffer.splice(0, room.specBuffer.length - SPEC_BUFFER_MAX);
  }
  flushSpectators(room);
}

/**
 * 算出「观众此刻应该看到哪一帧」：最新一帧 `round <= 当前轮 - 1`，
 * 也就是**上一轮结束时的局面**。
 *
 * 第 1 轮时没有「上一轮」，退到缓冲里最早的一帧（开局局面）——
 * 观众看到的是发牌完成的牌桌，而不是空白。
 *
 * 新观众进场也走这个函数。**绝不能直接发 `room.state`** —— 那是实时状态，
 * 等于延迟不存在，观众退出重进一次就绕过去了。
 */
function specTarget(room: Room): { seq: number; round: number; state: RedactedState } | null {
  const buf = room.specBuffer;
  if (buf.length === 0) return null;
  if (!room.state) return buf[0]!;

  const visibleRound = room.state.round - SPECTATOR_DELAY_ROUNDS;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i]!.round <= visibleRound) return buf[i]!;
  }
  return buf[0]!;
}

/**
 * 把观众该看的那一帧推出去，并丢掉再也用不到的旧帧。
 *
 * 调用点：每次状态变化后、每 500ms 的巡检、观众刚连上时。
 *
 * 按回合延迟下，一轮之内目标帧不变，所以定时器在功能上不是必需的 ——
 * 留着它是因为「清理旧帧」和「未来改成混合策略」都需要一个周期性的钩子，
 * 而它的成本只是一次数组扫描。
 */
function flushSpectators(room: Room): void {
  if (!room.state) {
    room.specBuffer = [];
    return;
  }

  // 对局结束：立刻放行最后一帧。
  // 让观众再等一轮才知道谁赢了，除了折磨人没有任何意义。
  if (room.state.winner) {
    const last = room.specBuffer[room.specBuffer.length - 1];
    room.specBuffer = [];
    room.specSentSeq = -1;
    if (!last) return;
    for (const ws of room.spectators) {
      send(ws, { t: 'state', state: last.state, deadlineAt: null, autopilot: false });
    }
    return;
  }

  // 清理：比「可见轮次」早一轮以上的帧永远不会再被选中
  const keepFrom = room.state.round - SPECTATOR_DELAY_ROUNDS - 1;
  while (room.specBuffer.length > 1 && room.specBuffer[0]!.round < keepFrom) {
    room.specBuffer.shift();
  }

  const target = specTarget(room);
  if (!target) return;
  // 同一帧不重复推（一轮之内目标帧是不变的）
  if (room.specSentSeq === target.seq) return;
  room.specSentSeq = target.seq;

  for (const ws of room.spectators) {
    // deadlineAt 传 null：那是过去某一刻的截止时间，画出来只会是个 0 秒倒计时
    send(ws, { t: 'state', state: target.state, deadlineAt: null, autopilot: false });
  }
}

/** 只推给某个座位（重连时用） */
function sendStateTo(room: Room, seat: Seat, ws: WebSocket): void {
  if (!room.state || !seat.gamePlayerId) return;
  send(ws, {
    t: 'state',
    state: redactState(room.state, pack, seat.gamePlayerId),
    deadlineAt: room.deadlineAt,
    autopilot: seat.autopilot,
  });
}

function broadcastLobby(): void {
  const list: RoomSummary[] = [...rooms.values()]
    .filter((r) => r.isPublic)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map(summaryOf);
  for (const ws of lobbySockets) {
    send(ws, { t: 'lobby', rooms: list });
  }
}

/** 正在看大厅的连接（还没进房间的） */
const lobbySockets = new Set<WebSocket>();

/* ------------------------------------------------------------------ */
/* 托管与推进                                                          */
/* ------------------------------------------------------------------ */

function clearTurnTimer(room: Room): void {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

/**
 * 每次状态变化后调用：决定「现在该谁动」。
 *  - 机器人 / 已托管的人类 → 取消倒计时，交给 AI 立刻走
 *  - 在线的人类           → 起 30 秒倒计时
 *  - 已结束 / 无 pending  → 收摊
 */
function advance(room: Room): void {
  const st = room.state;
  if (!st || st.winner || !st.pending || st.pending.kind === 'gameOver') {
    clearTurnTimer(room);
    room.deadlineAt = null;
    broadcastState(room);
    // 本局刚结束：房间从「进行中」变成「可加入打下一局」，
    // 这个变化只在 room 消息里，不补推的话大厅会一直显示「进行中」
    const over = Boolean(st?.winner);
    if (over !== room.announcedOver) {
      room.announcedOver = over;
      broadcastRoom(room);
    }
    return;
  }

  const actor = seatOfGamePlayer(room, st.pending.player);
  if (!actor) {
    clearTurnTimer(room);
    room.deadlineAt = null;
    return;
  }

  clearTurnTimer(room);

  if (actor.isBot || actor.autopilot) {
    room.deadlineAt = null;
    room.turnTimer = setTimeout(() => autoStep(room), BOT_STEP_MS);
    return;
  }

  room.deadlineAt = Date.now() + TURN_TIMEOUT_MS;
  room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_TIMEOUT_MS);
  broadcastState(room);
}

/** 倒计时到点：交给 AI 托管，然后继续推进 */
function onTurnTimeout(room: Room): void {
  const st = room.state;
  if (!st || !st.pending || st.pending.kind === 'gameOver') return;
  const actor = seatOfGamePlayer(room, st.pending.player);
  if (!actor || actor.isBot || actor.autopilot) return;

  actor.autopilot = true;
  console.log(`[托管] ${room.id} · ${actor.name} 超时，AI 接管`);
  broadcastRoom(room);
  advance(room);
}

/** 兜底指令：AI 给不出可用决策时，也要让对局往前走 */
function fallbackCommand(state: GameState, seat: Seat): Command | null {
  const p = state.pending;
  if (!p || p.kind === 'gameOver') return null;
  const me = state.players.find((x) => x.id === p.player);
  if (!me) return null;

  switch (p.kind) {
    case 'pickCharacter':
      return p.options[0] ? { type: 'pickCharacter', characterId: p.options[0] } : null;
    case 'action':
      return { type: 'advancePhase' };
    case 'intelDeclare': {
      const card = me.hand[0];
      return card ? { type: 'transmitIntel', cardUid: card.uid, method: 'cipher' } : null;
    }
    case 'receive':
      return { type: 'decideReceive', accept: true };
    case 'response':
      return { type: 'pass' };
    case 'discard':
      return { type: 'discard', cardUids: me.hand.slice(0, p.need).map((c) => c.uid) };
    default:
      void seat;
      return null;
  }
}

/** AI 代打一步 */
function autoStep(room: Room): void {
  const st = room.state;
  if (!st || st.winner || !st.pending || st.pending.kind === 'gameOver') {
    room.deadlineAt = null;
    broadcastState(room);
    return;
  }
  const actor = seatOfGamePlayer(room, st.pending.player);
  if (!actor || (!actor.isBot && !actor.autopilot)) {
    advance(room);
    return;
  }

  let cmd = botDecide(st, pack);
  let res = cmd ? applyCommand(st, pack, cmd) : null;
  if (!cmd || !res || res.error) {
    const fb = fallbackCommand(st, actor);
    const r2 = fb ? applyCommand(st, pack, fb) : null;
    if (r2 && !r2.error) {
      cmd = fb;
      res = r2;
    }
  }

  if (!cmd || !res || res.error) {
    room.stuckCount += 1;
    console.error(`[AI] ${room.id} · ${actor.name} 无法行动：${res?.error ?? '无可用指令'}`);
    if (room.stuckCount > 8) {
      // 连续卡死：把这一桌停下，避免 CPU 空转
      clearTurnTimer(room);
      room.deadlineAt = null;
      return;
    }
    room.turnTimer = setTimeout(() => autoStep(room), BOT_STEP_MS * 3);
    return;
  }

  room.stuckCount = 0;
  room.state = res.state;
  broadcastState(room);
  advance(room);
}

/* ------------------------------------------------------------------ */
/* 房间操作                                                            */
/* ------------------------------------------------------------------ */

function attachSeat(room: Room, seat: Seat, ws: WebSocket, resumed: boolean): void {
  sockets.set(seat.playerId, ws);
  session.set(ws, { roomId: room.id, playerId: seat.playerId });
  lobbySockets.delete(ws);

  seat.connected = true;
  seat.disconnectedAt = null;
  // 人回来了：立刻结束托管，把控制权还给他
  seat.autopilot = false;
  // 回来 = 不再是「已离开」。不清这个标记的话，对局中点了离开又用 token 回来的人，
  // 会在下一局开始时被 startNextIfReady 当成「走了」摘掉座位 —— 而他明明就在线
  seat.left = false;

  if (!room.hostId) room.hostId = seat.playerId;

  send(ws, {
    t: 'joined',
    playerId: seat.playerId,
    token: seat.resumeToken,
    seat: seat.seat,
    room: room.id,
    host: room.hostId === seat.playerId,
    resumed,
  });
  send(ws, roomPayload(room));
  sendStateTo(room, seat, ws);

  broadcastRoom(room);

  // 只在「本来就该他动」或「当前没人计时」时才重排倒计时。
  // 否则任何一人重连都会给正在思考的对手续一次 30 秒，属于变相送时间。
  if (room.started && room.state && !room.state.winner) {
    const pending = room.state.pending;
    const mine = pending && pending.kind !== 'gameOver' && pending.player === seat.gamePlayerId;
    if (mine || room.deadlineAt === null) advance(room);
  }
}

function createRoom(id: string, isPublic: boolean, password: string | null): Room {
  const room: Room = {
    id,
    seats: [],
    spectators: new Set(),
    specBuffer: [],
    specSeq: 0,
    specSentSeq: -1,
    ready: new Set<string>(),
    announcedOver: false,
    password,
    hostId: '',
    state: null,
    started: false,
    isPublic,
    createdAt: Date.now(),
    deadlineAt: null,
    turnTimer: null,
    stuckCount: 0,
  };
  rooms.set(id, room);
  stats.roomsCreated += 1;
  return room;
}

function joinRoom(room: Room, name: string, ws: WebSocket, autoReady = false): void {
  const seat: Seat = {
    playerId: nextId('u'),
    resumeToken: nextId('tk'),
    gamePlayerId: null,
    name: String(name || `玩家 ${room.seats.length + 1}`).slice(0, 12),
    // 真正的座位号在下面决定（可能顶掉机器人，沿用它的位置）
    seat: room.seats.length,
    connected: true,
    isBot: false,
    autopilot: false,
    disconnectedAt: null,
    left: false,
  };
  // 结算阶段进来的真人优先「顶掉一个机器人」，而不是追加座位。
  //
  // 房主开局时选的是「3 人局」，多来一个朋友不该把对局悄悄变成 4 人 ——
  // 补位用的机器人本来就是「人不够时凑数」的，真人到了就该让位。
  // 没有机器人可顶时才追加（房间上限 7 已在调用方校验）。
  const botIdx = autoReady ? room.seats.findIndex((x) => x.isBot) : -1;
  if (botIdx >= 0) {
    seat.seat = room.seats[botIdx]!.seat;
    room.seats[botIdx] = seat;
  } else {
    seat.seat = room.seats.length;
    room.seats.push(seat);
  }

  if (!room.hostId) room.hostId = seat.playerId;
  // 结算阶段进来的人 = 想打下一局，直接算准备。
  // 让他再去点一次「准备」只是多一步没信息量的操作。
  if (autoReady) room.ready.add(seat.playerId);
  attachSeat(room, seat, ws, false);
}

/** 房主掉线 / 离开时把房主转给还在线的下一位 */
function ensureHost(room: Room): void {
  const host = seatOfPlayer(room, room.hostId);
  if (host && (host.connected || host.isBot)) return;
  const next = room.seats.find((s) => s.connected && !s.isBot);
  if (next) {
    room.hostId = next.playerId;
    console.log(`[房间] ${room.id} 房主转移给 ${next.name}`);
  } else {
    room.hostId = '';
  }
}

/**
 * 真正开始一局：座位已经定好，这里只负责建状态、复位「每局」的临时字段。
 *
 * 抽出来是因为「首局」和「再来一局」只差座位怎么定 ——
 * 建状态这一段两边完全一样，复制一遍迟早会漏掉某个字段的复位
 * （漏 `specSentSeq` 的话，新一局的帧号会和老一局撞上，观众直接卡住）。
 */
function beginGame(room: Room): void {
  const state = createGame({
    pack,
    players: room.seats.map((s) => ({ name: s.name, isBot: s.isBot })),
  });
  room.seats.forEach((s, i) => {
    s.gamePlayerId = state.players[i]?.id ?? null;
    // 开局时掉线的人直接进入托管
    s.autopilot = !s.isBot && !s.connected;
  });
  room.state = state;
  room.started = true;
  room.stuckCount = 0;
  room.deadlineAt = null;
  // 上一局的观战快照必须清干净：帧号是从 0 重新数的，
  // 留着老 buffer 会让「按 seq 去重」误判成已发送
  room.specBuffer = [];
  room.specSeq = 0;
  room.specSentSeq = -1;
  room.ready.clear();
  room.announcedOver = false;
  stats.gamesStarted += 1;
  broadcastRoom(room);
  advance(room);
}

function startGame(room: Room, playerCount: number, botCount: number): string | null {
  // 对局结束后允许直接再开一局（房主不用先回大厅）
  if (room.started && !room.state?.winner) return '对局已经开始。';
  const humans = room.seats.filter((s) => !s.isBot && !s.left);
  const total = Math.min(7, Math.max(3, playerCount));
  const bots = Math.min(total - humans.length, Math.max(0, botCount));
  if (humans.length + bots < 3) return '至少需要 3 名参与者（含机器人）。';
  if (humans.length + bots > total) return '座位不足。';

  room.seats = room.seats.filter((s) => !s.isBot && !s.left);
  for (let i = 0; i < bots; i++) {
    room.seats.push({
      playerId: nextId('bot'),
      resumeToken: '',
      gamePlayerId: null,
      name: `机器人 ${i + 1}`,
      seat: room.seats.length,
      connected: true,
      isBot: true,
      autopilot: false,
      disconnectedAt: null,
      left: false,
    });
  }
  room.seats = room.seats.slice(0, total).map((s, i) => ({ ...s, seat: i }));

  beginGame(room);
  return null;
}

/**
 * 再来一局：座位原样保留，全员准备后建新状态。
 *
 * 刻意**不做座位增删** —— 中途掉线的人在这里被当成「还在座」继续托管。
 * 短暂断线（刷新页面）的人如果被踢掉，代价远大于「留一个僵尸座位」；
 * 真要去掉某人，房主回大厅重建更直接。
 *
 * @param ready 显式设成准备 / 取消准备；不传则切换（同一个按钮点两下能反悔）
 */
function rematch(room: Room, playerId: string, ready?: boolean): string | null {
  if (!room.state?.winner) return '本局还没结束。';

  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat || seat.isBot) return '你不在座位上。';

  const want = ready ?? !room.ready.has(playerId);
  if (want) room.ready.add(playerId);
  else room.ready.delete(playerId);

  return startNextIfReady(room);
}

/**
 * 换座位：把 a、b 两个座位互换。
 *
 * 为什么允许「未开局」和「两局之间」：
 * 座位顺序 = 行动顺序 = 情报传递方向（密电 / 文本按座位往下传）。
 * 红色阵营的人想坐在盟友旁边，不然情报一路要穿过敌人，被【截获】的概率高得多。
 *
 * 为什么不需要对方同意：
 * 身份是**开局时随机分配**的，所以开局前怎么排座位都拿不到任何信息优势 ——
 * 能换的只是「谁挨着谁」，而这是所有人都看得见的公开信息。
 * 加一道确认只会让「开局前调个座位」变成来回点击。
 *
 * 权限：房主可以交换任意两个座位；其他人只能发起涉及自己座位的交换
 * （否则两个人可以互相把人踢来踢去）。
 */
function swapSeats(room: Room, playerId: string, a: number, b: number): string | null {
  if (room.started && !isGameOver(room)) return '对局进行中，不能换座位。';
  if (a === b) return null;

  const mine = room.seats.find((s) => s.playerId === playerId);
  if (!mine) return '你不在座位上。';

  const ia = room.seats.findIndex((s) => s.seat === a);
  const ib = room.seats.findIndex((s) => s.seat === b);
  if (ia < 0 || ib < 0) return '这两个座位得都有人才能交换。';

  const isHost = room.hostId === playerId;
  if (!isHost && mine.seat !== a && mine.seat !== b) {
    return '只有房主可以调整别人的座位。';
  }

  const nameA = room.seats[ia]!.name;
  const nameB = room.seats[ib]!.name;
  const tmp = room.seats[ia]!;
  room.seats[ia] = room.seats[ib]!;
  room.seats[ib] = tmp;
  room.seats.forEach((s, i) => {
    s.seat = i;
  });

  broadcastRoom(room);
  console.log(`[房间] ${room.id} 换座：${nameA} ${a + 1} 号 ↔ ${nameB} ${b + 1} 号`);
  return null;
}

/**
 * 房主调整下一局的机器人数。
 *
 * 只在「两局之间」有效：首局的人数是在 `start` 里定的（那时还没有机器人让位的问题），
 * 而两局之间座位表已经存在，只能改机器人的数量。
 *
 * 真人不会被挪动 —— 重建座位表时真人保持原有先后顺序排在前面，
 * 机器人补在后面。座位号会重排，但「谁挨着谁」的顺序不变。
 */
function setBotCount(room: Room, count: number): string | null {
  if (!isGameOver(room)) return '只能在两局之间调整人数。';

  // 已离开的人不算「真人」：他会在开局时被摘掉，这里把他算进来只会让
  // 「至少 3 人」的机器人数下限算少，最后开出一局凑不够人的空档。
  // 顺带把他从座位表里清出去 —— 反正下一局也留不住。
  const humans = room.seats.filter((s) => !s.isBot && !s.left);
  const bots = room.seats.filter((s) => s.isBot);
  // 至少 3 人才能开局，所以机器人不能减到「凑不够 3 人」
  const minBots = Math.max(0, 3 - humans.length);
  const want = Math.max(minBots, Math.min(7 - humans.length, Math.floor(count) || 0));
  if (want === bots.length) return null;

  const kept = bots.slice(0, want);
  for (let i = kept.length; i < want; i++) {
    kept.push({
      playerId: nextId('bot'),
      resumeToken: '',
      gamePlayerId: null,
      name: `机器人 ${i + 1}`,
      seat: 0,
      connected: true,
      isBot: true,
      autopilot: false,
      disconnectedAt: null,
      left: false,
    });
  }

  room.seats = [...humans, ...kept].map((s, i) => ({ ...s, seat: i }));
  broadcastRoom(room);
  console.log(
    `[房间] ${room.id} 下一局人数：${humans.length} 真人 + ${kept.length} 机器人`,
  );
  return null;
}

/**
 * 全员准备好就开下一局。
 *
 * 「再来一局」和「结算阶段有人加入」共用这一条路径 ——
 * 两条路各写一遍的话，漏掉「摘掉已离开座位」或者「少于 3 人」的检查是迟早的事。
 */
function startNextIfReady(room: Room): string | null {
  if (!allReady(room)) {
    broadcastRoom(room);
    return null;
  }

  // 开局前把「真的走了的人」摘掉，但要**尊重 5 分钟保座宽限期**。
  //
  // 这里原来只按 `connected` 判断，等于把宽限期的承诺作废：
  // 结算页正好赶上一次 wifi 抖动 / 刷新页面的人，会在「再来一局」的那一瞬间被永久删座，
  // 回来时 token 已经失效 —— 而上一秒界面还在告诉他「座位保留 5 分钟」。
  //
  // 判定条件与 15 秒巡检里回收未开局座位的那段**保持完全一致**，
  // 两处各写一套的话迟早会分叉。
  const now = Date.now();
  const before = room.seats.length;
  room.seats = room.seats.filter(
    (s) =>
      s.isBot ||
      s.connected ||
      (!s.left && s.disconnectedAt !== null && now - s.disconnectedAt < SEAT_GRACE_MS),
  );
  if (room.seats.length !== before) {
    room.seats.forEach((s, i) => {
      s.seat = i;
    });
    ensureHost(room);
    console.log(`[房间] ${room.id} 再来一局前移除 ${before - room.seats.length} 个已离开的座位`);
  }
  if (room.seats.length < 3) {
    broadcastRoom(room);
    return '在线人数不足 3 人，无法开始下一局。';
  }

  beginGame(room);
  return null;
}

/**
 * 在线真人都准备好了？（掉线的人按自动准备处理）
 *
 * 「全员离线」要单独挡掉：所有人工位都掉线时，按定义人人都是「自动准备」，
 * 会开出一局谁也没在看的游戏，还把房间状态推进掉。
 */
function allReady(room: Room): boolean {
  const humans = room.seats.filter((s) => !s.isBot);
  if (humans.length === 0) return false;
  if (!humans.some((s) => s.connected)) return false;
  return humans.every((s) => !s.connected || room.ready.has(s.playerId));
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成快照。
 *
 * 只存「重启后重建房间必需」的东西：
 *  - 座位骨架（playerId / resumeToken / 名字 / 是否机器人 / 引擎内 id）
 *  - 引擎状态（GameState 是纯 JSON：没有 Map/Set/Date，直接序列化即可）
 *  - 房主、密码、是否公开、准备名单
 *
 * 刻意**不存**：连接、倒计时截止时间、观战缓冲。
 * 前两个活不过进程，第三个是给实时观众看的，重启后从当前状态重新攒就行。
 */
function buildSnapshot(): Snapshot {
  const out: SnapshotRoom[] = [];
  for (const room of rooms.values()) {
    out.push({
      id: room.id,
      password: room.password,
      hostId: room.hostId,
      isPublic: room.isPublic,
      createdAt: room.createdAt,
      started: room.started,
      ready: [...room.ready],
      seats: room.seats.map((s) => ({
        playerId: s.playerId,
        resumeToken: s.resumeToken,
        gamePlayerId: s.gamePlayerId,
        name: s.name,
        seat: s.seat,
        isBot: s.isBot,
        left: s.left,
      })),
      state: room.state,
    });
  }
  return { v: SNAPSHOT_VERSION, savedAt: Date.now(), pack: PACK_FP, rooms: out };
}

/**
 * 从快照恢复。
 *
 * 关键决定：**恢复出来的座位一律算「离线」**。
 *
 * 直接把 connected 置 true 很诱人 —— 房间看起来和重启前一模一样。
 * 但那是假的：没有任何 socket 挂在这些座位上，广播会全部落空，
 * 倒计时到点后 AI 接管，而界面上的「在线」标记从头到尾是骗人的。
 *
 * 走离线路径反而是对的：座位进 5 分钟宽限期，玩家用 localStorage 里的 token 重连，
 * 全部复用正常逻辑 —— 没有「只在重启后才走」的分支，也就没有只在重启后才出现的 bug。
 */
function restoreFromSnapshot(snap: Snapshot): void {
  const now = Date.now();
  for (const raw of snap.rooms) {
    if (rooms.has(raw.id)) continue;

    const room: Room = {
      id: raw.id,
      seats: raw.seats.map((s) => ({
        playerId: s.playerId,
        resumeToken: s.resumeToken,
        gamePlayerId: s.gamePlayerId,
        name: s.name,
        seat: s.seat,
        connected: false,
        isBot: s.isBot,
        autopilot: false,
        disconnectedAt: now,
        // 老快照没有这个字段，按「没主动离开过」处理：
        // 宁可多留一个座位，也不要因为升级把某人的座位判成「已离开」
        left: s.left === true,
      })),
      spectators: new Set(),
      specBuffer: [],
      specSeq: 0,
      specSentSeq: -1,
      ready: new Set(raw.ready),
      announcedOver: Boolean(raw.state?.winner),
      password: raw.password,
      hostId: raw.hostId,
      state: raw.state,
      started: raw.started,
      isPublic: raw.isPublic,
      createdAt: raw.createdAt,
      deadlineAt: null,
      turnTimer: null,
      stuckCount: 0,
    };

    // 引擎内 id 存了就用手上的，没存（老快照）就按座位索引对齐 ——
    // 座位数组顺序 == 座位号 == state.players 顺序，这三者开局时是一起定的。
    room.seats.forEach((s, i) => {
      if (!s.gamePlayerId) s.gamePlayerId = raw.state?.players[i]?.id ?? null;
      // 对局中恢复：真人一律先进托管，等人回来点「我回来了」
      if (room.started && !raw.state?.winner) s.autopilot = !s.isBot;
    });

    if (room.seats.length === 0) continue;

    rooms.set(room.id, room);
    stats.restores += 1;
  }
}

/* ------------------------------------------------------------------ */
/* 防护                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单连接令牌桶。放 WeakMap 里：连接一关，桶跟着被回收，不需要手动清理。
 */
const buckets = new WeakMap<WebSocket, { tokens: number; last: number }>();
const strikes = new WeakMap<WebSocket, number>();

function allowMessage(ws: WebSocket): boolean {
  // 已经在关闭流程里的连接不再计数：客户端可能已经排了一队消息在缓冲区里，
  // 继续算下去只会刷出一串「被限流」日志，而那条连接其实早就断了
  if (ws.readyState !== WebSocket.OPEN) return false;

  const now = Date.now();
  let b = buckets.get(ws);
  if (!b) {
    b = { tokens: MSG_BURST, last: now };
    buckets.set(ws, b);
  }
  b.tokens = Math.min(MSG_BURST, b.tokens + ((now - b.last) / 1000) * MSG_RATE);
  b.last = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    strikes.set(ws, 0);
    return true;
  }

  const n = (strikes.get(ws) ?? 0) + 1;
  strikes.set(ws, n);
  stats.rateLimited += 1;
  // 只警告第一次：刷屏的脚本不需要被反复告知，正常人看到一次就够了
  if (n === 1) send(ws, { t: 'error', msg: '操作太频繁了，慢一点。' });
  // 判定断开也只在跨过阈值的那一次执行 —— 否则日志会被同一条连接刷满
  if (n === MSG_STRIKE_LIMIT) {
    console.warn(`[防护] 单连接被限流 ${n} 次，主动断开`);
    ws.close(1008, 'rate limited');
  }
  return false;
}

/** 一条消息把分发器炸了：记日志、回一句人话，连接和房间都保留 */
function reportDispatchError(ws: WebSocket, err: unknown): void {
  stats.dispatchErrors += 1;
  console.error('[消息] 处理异常', err instanceof Error ? (err.stack ?? err.message) : String(err));
  send(ws, { t: 'error', msg: '服务端处理这条指令时出错了，对局状态没有变化。' });
}

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket 启动                                               */
/* ------------------------------------------------------------------ */

const serveStatic = createStaticHandler(STATIC_DIR);

function statsPayload(): Record<string, unknown> {
  let humans = 0;
  let bots = 0;
  let leftSeats = 0;
  let playing = 0;
  let spectators = 0;
  for (const room of rooms.values()) {
    for (const s of room.seats) {
      if (s.isBot) bots += 1;
      // 已离开的人还占着座位（对局中不能删），但他不在这局里 ——
      // 单独计数，否则「humans」会虚高，看指标的人会以为房里还有人
      else if (s.left) leftSeats += 1;
      else humans += 1;
    }
    if (room.started && !room.state?.winner) playing += 1;
    spectators += room.spectators.size;
  }
  return {
    uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
    connections: stats.connections,
    peakConnections: stats.peakConnections,
    rejectedConnections: stats.rejectedConnections,
    lobbySockets: lobbySockets.size,
    rooms: rooms.size,
    playing,
    humans,
    bots,
    leftSeats,
    spectators,
    /**
     * 下面三个是**泄漏诊断**：服务端要连续跑几小时，这几张表只增不减的话
     * 内存会一路涨上去，而且症状是「跑了一下午才开始变慢」，很难回溯。
     * 正常情况下它们应该等于「当前活着的连接 / 座位」，进出房间后回到基线。
     */
    sessions: session.size,
    seatedSockets: sockets.size,
    spectatorSessions: spectatorRooms.size,
    messages: stats.messages,
    dispatchErrors: stats.dispatchErrors,
    rateLimited: stats.rateLimited,
    roomsCreated: stats.roomsCreated,
    gamesStarted: stats.gamesStarted,
    restores: stats.restores,
    snapshotWrites: persist.writeCount,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    limits: {
      maxRooms: MAX_ROOMS,
      maxConnections: MAX_CONNECTIONS,
      maxSpectatorsPerRoom: MAX_SPECTATORS_PER_ROOM,
      msgBurst: MSG_BURST,
      msgRate: MSG_RATE,
    },
  };
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    writeJson(res, 400, { error: 'bad url' });
    return;
  }

  // 探活：给进程守护 / 容器编排用，故意做得极轻（不遍历房间）
  if (url.pathname === '/healthz') {
    writeJson(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000) });
    return;
  }

  if (url.pathname === '/stats') {
    writeJson(res, 200, statsPayload());
    return;
  }

  /**
   * 运维排水：优雅关闭。
   *
   * 只有显式配了 `ABS_ADMIN_TOKEN` 才开这个口子 —— 没配就当作不存在（404）。
   * 用途：发版前先把在打的局落盘、通知客户端重连，而不是直接 kill 掉让所有人掉线。
   *
   *   curl -X POST -H "x-abs-token: $TOKEN" http://localhost:8787/admin/shutdown
   */
  if (url.pathname === '/admin/shutdown') {
    const token = process.env.ABS_ADMIN_TOKEN ?? '';
    if (!token) {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'use POST' });
      return;
    }
    if (req.headers['x-abs-token'] !== token) {
      writeJson(res, 403, { error: 'forbidden' });
      return;
    }
    writeJson(res, 202, { ok: true, stopping: true });
    // 先把响应发完再关：否则客户端拿到的是「连接被重置」而不是 202
    setTimeout(() => void shutdown('admin'), 50);
    return;
  }

  await serveStatic(req, res, url);
}

const httpServer = http.createServer((req, res) => {
  // 任何一条请求抛错都不能带崩进程：这是公网入口，必须假设有人乱打
  handleHttp(req, res).catch((err) => {
    console.error('[HTTP] 请求处理异常', err instanceof Error ? err.message : String(err));
    if (!res.headersSent) writeJson(res, 500, { error: 'internal' });
    else res.destroy();
  });
});

// 慢客户端不能一直占着 socket：请求头 10 秒、整体 60 秒
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 60_000;
httpServer.keepAliveTimeout = 65_000;

/**
 * WebSocket 走 noServer + 手动 upgrade：
 * 这样才能和 HTTP 静态资源共用一个端口（`{ port }` 模式会自己再监听一个端口）。
 */
const wss = new WebSocketServer({
  noServer: true,
  // 单条消息上限。最大的一条是「弃牌」，带几个 uid，几十字节；
  // 64KB 留了三个数量级的余量，同时挡住了「发个 100MB 的 JSON 把内存吃满」。
  maxPayload: envInt('ABS_MAX_PAYLOAD', 64 * 1024, 1024),
});

httpServer.on('upgrade', (req, socket, head) => {
  if (stats.connections >= MAX_CONNECTIONS) {
    stats.rejectedConnections += 1;
    // upgrade 阶段还没有 WebSocket，只能手写 HTTP 响应
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

/** 半开连接检测：上一轮 ping 之后没回 pong 的，说明对端已经不在了 */
const alive = new WeakMap<WebSocket, boolean>();

setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      // terminate 而不是 close：对端已经不响应了，等它回 close 帧是等不到的
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    try {
      ws.ping();
    } catch {
      /* 已经在关闭流程里 */
    }
  }
}, WS_PING_MS).unref();

wss.on('connection', (ws) => {
  stats.connections += 1;
  stats.peakConnections = Math.max(stats.peakConnections, stats.connections);
  alive.set(ws, true);
  // 收到 pong 就证明对端还活着；巡检时把标记清零再 ping，下一轮还没回就终止
  ws.on('pong', () => alive.set(ws, true));

  /**
   * 必须有人接 `error`。
   *
   * ws 内部遇到协议错误（超长帧、非法 opcode、对端乱发）时会 `emit('error')`；
   * EventEmitter 在没有监听者时会**抛出**，而那个 throw 发生在 socket 的 data 回调里，
   * 直接升级成 uncaughtException —— 一个乱发包的客户端就能把整台服务打挂。
   * 这不是理论问题：把 maxPayload 调小之后第一次跑验收就复现了。
   */
  ws.on('error', (err) => {
    console.warn(`[连接] ${err instanceof Error ? err.message : String(err)}`);
    // ws 内部出错时通常已经把 readyState 推进到 CLOSING 并准备发关闭帧（比如 1009），
    // 这里只在它还活着的情况下兜底终止，不要抢在它前面把连接掐掉
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.terminate();
      } catch {
        /* 已经断了 */
      }
    }
  });

  lobbySockets.add(ws);

  ws.on('message', (raw) => {
    stats.messages += 1;
    if (!allowMessage(ws)) return;

    let msg: ClientMsg | null = null;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      send(ws, { t: 'error', msg: '无法解析的消息。' });
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // 整段分发包一层 try：一条畸形指令只该回一句错误，
    // 不该把整个连接（乃至整个进程）带走。
    try {
      /* ---------- 不需要先加入房间的消息 ---------- */

      if (msg.t === 'ping') {
        send(ws, { t: 'pong' });
        return;
      }

      if (msg.t === 'lobby') {
        lobbySockets.add(ws);
        broadcastLobby();
        return;
      }

      if (msg.t === 'create') {
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { t: 'error', msg: '服务器房间数已达上限，稍后再试。' });
          return;
        }
        const wantId = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        const id = wantId || makeRoomCode();
        if (rooms.has(id)) {
          send(ws, { t: 'error', msg: `房间号 ${id} 已被占用，换一个。` });
          return;
        }
        // 密码只留可见字符、最长 16 位：太长的密码没人记得住，也没人念得清
        const password = String(msg.password ?? '')
          .trim()
          .slice(0, 16);
        const room = createRoom(id, msg.isPublic !== false, password || null);
        joinRoom(room, msg.name, ws);
        return;
      }

      if (msg.t === 'join') {
        const roomId = String(msg.room || '').toUpperCase().slice(0, 8);
        const room = rooms.get(roomId);
        if (!room) {
          send(ws, { t: 'error', msg: `房间 ${roomId} 不存在。` });
          return;
        }
        const over = isGameOver(room);
        if (room.started && !over) {
          send(ws, { t: 'error', msg: '该房间的对局已经开始，无法加入。' });
          return;
        }
        if (room.seats.filter((s) => !s.isBot).length >= 7) {
          send(ws, { t: 'error', msg: '房间已满（最多 7 人）。' });
          return;
        }
        const pwErr = checkPassword(room, msg.password);
        if (pwErr) {
          send(ws, { t: 'error', msg: pwErr });
          return;
        }
        joinRoom(room, msg.name, ws, over);
        // 结算阶段加入的人可能正好凑齐准备名单 → 直接开下一局
        if (over) startNextIfReady(room);
        return;
      }

      if (msg.t === 'resume') {
        const roomId = String(msg.room || '').toUpperCase().slice(0, 8);
        const room = rooms.get(roomId);
        if (!room) {
          send(ws, { t: 'error', msg: '房间已不存在（可能已结束或被回收）。' });
          return;
        }
        const seat = room.seats.find((s) => s.resumeToken && s.resumeToken === msg.token);
        if (!seat) {
          send(ws, { t: 'error', msg: '座位已失效，请重新加入。' });
          return;
        }
        // 同一个座位被另一个连接占着（比如刷新前那个还没断）→ 顶掉旧的
        const old = sockets.get(seat.playerId);
        if (old && old !== ws) {
          session.delete(old);
          try {
            old.close();
          } catch {
            /* ignore */
          }
        }
        attachSeat(room, seat, ws, true);
        return;
      }

      if (msg.t === 'spectate') {
        const roomId = String(msg.room || '').toUpperCase().slice(0, 8);
        const room = rooms.get(roomId);
        if (!room) {
          send(ws, { t: 'error', msg: `房间 ${roomId} 不存在。` });
          return;
        }
        if (!room.started) {
          // 没开局没什么可看的，直接让他加入
          send(ws, { t: 'error', msg: '该房间还没开始对局，直接加入吧。' });
          return;
        }
        // 有密码的局，观战也要密码 —— 否则「私密对局」只是不让坐，还是能被围观
        const specPwErr = checkPassword(room, msg.password);
        if (specPwErr) {
          send(ws, { t: 'error', msg: specPwErr });
          return;
        }
        // 观战位上限：广播成本是按观众数线性放大的，不设上限等于给了一个
        // 「开 500 个标签页就能把服务端拖慢」的把手
        if (spectatorRooms.get(ws) !== roomId && room.spectators.size >= MAX_SPECTATORS_PER_ROOM) {
          send(ws, { t: 'error', msg: '这个房间的观战位满了。' });
          return;
        }
        // 同一个 socket 重复观战同一个房：幂等，别把计数刷上去
        if (spectatorRooms.get(ws) !== roomId) {
          room.spectators.add(ws);
          spectatorRooms.set(ws, roomId);
        }
        lobbySockets.delete(ws);

        send(ws, {
          t: 'joined',
          // 观战者也有一个会话 id（方便日志），但它不对应任何座位
          playerId: nextId('sp'),
          token: '',
          seat: -1,
          room: roomId,
          host: false,
          resumed: false,
          spectator: true,
          spectatorDelayRounds: SPECTATOR_DELAY_ROUNDS,
        });
        send(ws, roomPayload(room));
        if (room.state) {
          // 直接发当前状态等于绕过延迟，观众退出重进就能看到实时画面。
          // 所以取「他此刻该看到的那一帧」，和 flush 用的是同一个函数。
          const first = specTarget(room);
          send(ws, {
            t: 'state',
            state: first?.state ?? redactPublic(room.state, pack),
            deadlineAt: null,
            autopilot: false,
          });
        }
        // 让房内玩家看到「有人在看」
        broadcastRoom(room);
        return;
      }

      /* ---------- 需要先加入房间的消息 ---------- */

      // 观战者退出：没有座位要摘，断掉就行
      if (msg.t === 'leave' && spectatorRooms.has(ws)) {
        try {
          ws.close(1000, 'left');
        } catch {
          /* 已经断了 */
        }
        return;
      }

      if (spectatorRooms.has(ws)) {
        send(ws, { t: 'error', msg: '观战者不能操作对局。' });
        return;
      }

      const sess = session.get(ws);
      if (!sess) {
        send(ws, { t: 'error', msg: '请先加入房间。' });
        return;
      }
      const room = rooms.get(sess.roomId);
      if (!room) {
        send(ws, { t: 'error', msg: '房间不存在。' });
        return;
      }
      const mySeat = seatOfPlayer(room, sess.playerId);
      if (!mySeat) {
        send(ws, { t: 'error', msg: '你的座位已失效。' });
        return;
      }

      /**
       * 主动离开。和「掉线」分开处理：
       *  - 不在对局中（大厅 / 两局之间）→ 座位立刻摘掉，座位号重排
       *  - 对局进行中 → 座位不能删（引擎状态会错位），只打 left 标记 + 交给 AI，
       *    等这一局结束、下次开局时再摘
       */
      if (msg.t === 'leave') {
        mySeat.connected = false;
        mySeat.disconnectedAt = Date.now();
        mySeat.left = true;
        room.ready.delete(mySeat.playerId);
        sockets.delete(mySeat.playerId);
        session.delete(ws);

        if (!room.started || room.state?.winner) {
          const idx = room.seats.findIndex((s) => s.playerId === mySeat.playerId);
          if (idx >= 0) room.seats.splice(idx, 1);
          room.seats.forEach((s, i) => {
            s.seat = i;
          });
          console.log(`[房间] ${room.id} · ${mySeat.name} 离开，座位已摘除`);
        } else {
          mySeat.autopilot = true;
          // 写进对局日志，而不是只发一条广播：
          // 日志会跟着快照持久化，中途重连 / 服务端重启之后还在。
          // 否则后进来的人只会看到「某个座位一直在被 AI 托管」，永远不知道是有人走了。
          if (room.state) {
            appendSystemLog(room.state, `${mySeat.name} 离开了对局，之后由 AI 代打`, 'warn');
          }
          console.log(`[房间] ${room.id} · ${mySeat.name} 离开，对局中交给 AI`);
        }

        // 房主走了就立刻转移，**对局中也要转**。
        //
        // 只在大厅分支转是漏的：对局中离开的座位要留到下一局才摘，于是 hostId 会一直
        // 指着一个已经走了的人。本局打完后剩下的人里谁都不是房主 ——
        // 「调整人数」被挡、大厅里房主名显示成一个不在线的人，
        // 而唯一的解法是等有人点「再来一局」时顺带摘座位，属于靠运气自愈。
        // ensureHost 只挑「在线真人」，走了的人不会被选上。
        ensureHost(room);

        broadcastRoom(room);
        if (room.started) advance(room);
        try {
          ws.close(1000, 'left');
        } catch {
          /* 已经断了 */
        }
        return;
      }

      if (msg.t === 'start') {
        if (room.hostId !== sess.playerId) {
          send(ws, { t: 'error', msg: '只有房主可以开始对局。' });
          return;
        }
        const err = startGame(room, msg.playerCount, msg.bots);
        if (err) send(ws, { t: 'error', msg: err });
        return;
      }

      if (msg.t === 'rematch') {
        const err = rematch(room, sess.playerId, msg.ready);
        if (err) send(ws, { t: 'error', msg: err });
        return;
      }

      if (msg.t === 'swap') {
        const err = swapSeats(room, sess.playerId, msg.a, msg.b);
        if (err) send(ws, { t: 'error', msg: err });
        return;
      }

      if (msg.t === 'bots') {
        if (room.hostId !== sess.playerId) {
          send(ws, { t: 'error', msg: '只有房主可以调整人数。' });
          return;
        }
        const err = setBotCount(room, msg.count);
        if (err) send(ws, { t: 'error', msg: err });
        return;
      }

      if (msg.t === 'takeback') {
        if (!mySeat.autopilot) {
          send(ws, { t: 'error', msg: '你当前没有被托管。' });
          return;
        }
        mySeat.autopilot = false;
        broadcastRoom(room);
        console.log(`[托管] ${room.id} · ${mySeat.name} 收回控制权`);
        advance(room);
        return;
      }

      if (msg.t === 'command') {
        if (!room.state) {
          send(ws, { t: 'error', msg: '对局尚未开始。' });
          return;
        }
        const pending = room.state.pending;
        if (!pending || pending.kind === 'gameOver') {
          send(ws, { t: 'error', msg: '对局已结束。' });
          return;
        }
        if (pending.player !== mySeat.gamePlayerId) {
          send(ws, { t: 'error', msg: '还没轮到你。' });
          return;
        }
        // 托管中的人直接发指令 = 他回来了
        if (mySeat.autopilot) {
          mySeat.autopilot = false;
          broadcastRoom(room);
        }
        const res = applyCommand(room.state, pack, msg.cmd);
        if (res.error) {
          send(ws, { t: 'error', msg: res.error });
          return;
        }
        room.state = res.state;
        room.stuckCount = 0;
        broadcastState(room);
        advance(room);
        return;
      }
    } catch (err) {
      reportDispatchError(ws, err);
    }
  });

  ws.on('close', () => {
    stats.connections = Math.max(0, stats.connections - 1);
    lobbySockets.delete(ws);

    // 观战连接：从房间的观众集合里摘掉，并让房内玩家的人数跟着变
    const specRoomId = spectatorRooms.get(ws);
    if (specRoomId) {
      spectatorRooms.delete(ws);
      const specRoom = rooms.get(specRoomId);
      if (specRoom) {
        specRoom.spectators.delete(ws);
        broadcastRoom(specRoom);
      }
      return;
    }

    const sess = session.get(ws);
    if (!sess) return;
    session.delete(ws);

    const room = rooms.get(sess.roomId);
    if (!room) return;
    // 同一座位可能已经有新连接接上了（重连顶号），别把新连接的状态改坏
    if (sockets.get(sess.playerId) !== ws) return;
    sockets.delete(sess.playerId);

    const seat = seatOfPlayer(room, sess.playerId);
    if (!seat) return;
    seat.connected = false;
    seat.disconnectedAt = Date.now();
    // 对局中掉线：立刻交给 AI，别把整桌人卡在倒计时上
    if (room.started && !room.state?.winner) seat.autopilot = true;

    ensureHost(room);
    broadcastRoom(room);
    if (room.started) advance(room);
  });
});

/* ------------------------------------------------------------------ */
/* 定期清理                                                            */
/* ------------------------------------------------------------------ */

/** 观战缓冲的巡检间隔：对局卡在某人的思考时间里时，观众也要能收到新帧 */
const SPECTATOR_FLUSH_MS = 500;
/**
 * 观战快照缓冲上限（帧）。纯粹是内存安全阀，正常不会触发：
 * 30 秒窗口 × 每 300ms 一次状态变化 ≈ 100 帧。
 * 真触发了说明状态变化比这更密，此时宁可少给一点延迟，也不能让内存无上限涨。
 */
const SPEC_BUFFER_MAX = 300;

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.started) flushSpectators(room);
  }
}, SPECTATOR_FLUSH_MS).unref();

const CLEANUP_INTERVAL_MS = envInt('ABS_CLEANUP_MS', 15_000, 100);

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    // 1. 未开局：掉线超过宽限期的座位回收
    if (!room.started) {
      const before = room.seats.length;
      room.seats = room.seats.filter(
        (s) =>
          s.isBot ||
          s.connected ||
          (!s.left && (!s.disconnectedAt || now - s.disconnectedAt < SEAT_GRACE_MS)),
      );
      if (room.seats.length !== before) {
        room.seats.forEach((s, i) => (s.seat = i));
        ensureHost(room);
        broadcastRoom(room);
      }
    }

    // 2. 没有活人 → 删房间
    //
    // 「活人」= 在线，或者掉线但还在 5 分钟宽限期内。**主动离开的人不算** ——
    // 他的 disconnectedAt 也是刚设的，不加 left 判断的话，一个人点了「离开」
    // 也会让房间在宽限期里赖着不走：大厅上挂着一个 0 人房间，最长 5 分钟。
    // 主动离开是明确的意图，不需要给他留反悔窗口。
    const humans = room.seats.filter((s) => !s.isBot);
    const anyoneAlive = humans.some(
      (s) =>
        !s.left &&
        (s.connected || (s.disconnectedAt !== null && now - s.disconnectedAt < SEAT_GRACE_MS)),
    );
    if (!anyoneAlive) {
      clearTurnTimer(room);
      // 先把还在看的观众请走，再删房 —— 否则他们的界面会停在最后一帧
      for (const ws of room.spectators) {
        send(ws, {
          t: 'room',
          room: id,
          seats: [],
          started: false,
          hostId: '',
          isPublic: room.isPublic,
          closed: true,
        });
        spectatorRooms.delete(ws);
      }
      room.spectators.clear();
      rooms.delete(id);
      persist.touch();
      console.log(`[房间] ${id} 已回收（无人在线）`);
      broadcastLobby();
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

/* ------------------------------------------------------------------ */
/* 启动 / 关闭                                                         */
/* ------------------------------------------------------------------ */

/**
 * 进程级兜底。
 *
 * 一个游戏服务端最不能接受的是「某一局的异常把所有人的对局一起带走」。
 * 消息分发已经各自包了 try，这里兜的是剩下的漏网之鱼：
 * 定时器回调、异步落盘、某个第三方库内部抛出的东西。
 *
 * 短时间内炸太多次说明状态已经不可信 —— 那就干脆退出让守护进程重启，
 * 好过带着一个不知道烂在哪的进程继续服务（快照已经落过盘，重启能接上）。
 */
let crashCount = 0;
function onFatal(kind: string, err: unknown): void {
  crashCount += 1;
  console.error(`[致命] ${kind}`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  if (crashCount >= 10) {
    console.error('[致命] 一分钟内异常过多，退出进程等待重启');
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => onFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => onFatal('unhandledRejection', err));
setInterval(() => {
  crashCount = 0;
}, 60_000).unref();

/**
 * 优雅关闭。
 *
 * 顺序很重要：
 *  1. 通知所有连接「服务要重启」—— 客户端立刻进入重连流程，
 *     而不是干等 15 秒心跳超时才发现自己掉了
 *  2. 强刷快照 —— 这一步丢了，前面所有的节流都白做
 *  3. 关 HTTP，给在途请求一点收尾时间
 *
 * 不用 process.exit(0) 直接退：tsx 下会丢掉 stdout 缓冲里的最后几行日志。
 */
let closing = false;
async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[AbS] 收到 ${reason}，开始优雅关闭…`);

  for (const ws of wss.clients) {
    try {
      // 用 restart 而不是 error：客户端的 error 分支会把「回座失败」理解成
      // 「座位没了，回大厅」，那正好是发版时最不该发生的事
      send(ws, { t: 'restart', msg: '服务器正在重启，稍候会自动重连（座位保留 5 分钟）。' });
      ws.close(1001, 'server restarting');
    } catch {
      /* 已经断了 */
    }
  }

  if (PERSIST_ENABLED) {
    try {
      await persist.flush();
    } catch (err) {
      console.error('[快照] 关闭时落盘失败', err);
    }
  }

  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
    // 还有 keep-alive 连接挂着时 close 不会回调，给一个上限
    setTimeout(resolve, 800).unref();
  });

  console.log('[AbS] 已关闭');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  // 先恢复再监听：第一个连进来的人看到的就是完整的大厅，
  // 而不是「先空一下，几百毫秒后突然冒出几个房间」
  if (PERSIST_ENABLED) {
    const snap = await persist.load(PACK_FP);
    if (snap) {
      restoreFromSnapshot(snap);
      if (stats.restores > 0) {
        console.log(`[快照] 恢复 ${stats.restores} 个房间（座位按离线处理，等玩家凭 token 重连）`);
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(PORT, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  // 恢复出来的对局：座位上全是离线/托管，让 AI 接着往下推
  for (const room of rooms.values()) {
    if (room.started && room.state && !room.state.winner) advance(room);
  }

  if (PERSIST_ENABLED) {
    persist.start();
    // 立刻标脏一次：把「全员离线」这个恢复后的真实状态写回磁盘，
    // 否则万一这次启动又崩了，下次读到的还是那份「大家都在线」的旧快照
    persist.touch();
  }

  const indexPath = path.join(STATIC_DIR, 'index.html');
  console.log(`[AbS] 已启动：http://localhost:${PORT} （静态资源与 WebSocket 同端口）`);

  /**
   * 把局域网地址打出来。
   *
   * 「能不能让朋友一起玩」卡住人的往往不是代码，而是「我该发给他哪个地址」——
   * 发 localhost 等于让对方连他自己的电脑。服务端本来就监听所有网卡
   * （listen 没传 host），这里只是把可用的那个 IP 显式告诉人。
   *
   * 跳过回环和 IPv6：链接里塞一个 fe80:: 只会让人多问一轮。
   * 拿不到任何网卡（纯离线 / 只有回环）就静默跳过，不当成错误。
   */
  const lanUrls: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) lanUrls.push(`http://${a.address}:${PORT}`);
    }
  }
  if (lanUrls.length > 0) {
    console.log(`[AbS] 局域网：${lanUrls.join('  ')} ← 同一个 wifi 下的朋友用这个`);
  }

  if (existsSync(indexPath)) {
    console.log(`[AbS] 静态目录：${STATIC_DIR}`);
  } else {
    console.warn(`[AbS] 未找到 ${indexPath} —— 只提供 WebSocket 接口。先跑 npm run build`);
  }
  console.log(
    `[AbS] 卡池 ${pack.cards.length} 张 · 角色 ${pack.characters.length} 个 · 思考时间 ${TURN_TIMEOUT_MS}ms · 掉线保座 ${Math.round(
      SEAT_GRACE_MS / 1000,
    )}s · 观战延迟 ${SPECTATOR_DELAY_ROUNDS} 轮`,
  );
  console.log(
    `[AbS] 上限：房间 ${MAX_ROOMS} · 连接 ${MAX_CONNECTIONS} · 单房观战 ${MAX_SPECTATORS_PER_ROOM} · 单连接 ${MSG_RATE}/s（突发 ${MSG_BURST}）`,
  );
  console.log(
    PERSIST_ENABLED
      ? `[AbS] 快照：${SNAPSHOT_FILE}（每 ${PERSIST_MS}ms 巡检）`
      : '[AbS] 快照：已关闭（ABS_DATA_DIR=off）',
  );
}

void main().catch((err) => {
  console.error('[AbS] 启动失败', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

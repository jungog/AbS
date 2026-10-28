/**
 * 联机全链路集成测试
 *
 * 自己把服务端跑起来（同进程 import，不是子进程）——
 * 子进程方式在 Windows 上要处理 npx/shell/编码一堆问题，同进程只剩一个风险：
 * 必须在 import 之前设好环境变量。所以下面先写 process.env，再 await import。
 *
 * 覆盖：
 *   大厅列表 → 建房 → 按号加入 → 房主开局 → 状态裁剪
 *   → 倒计时下发 → 超时自动托管 → 「我回来了」收回
 *   → 断线重连（token 回原座）→ 观战（公开视角，拿不到手牌）
 *   → 房间密码（大厅只标「有锁」）→ 观战延迟（看到的是几十秒前）→ 打完整局 → 房主转移
 */
import { WebSocket } from 'ws';
import os from 'node:os';
import path from 'node:path';
import type { ClientMsg, RoomSeat, RoomSummary, ServerMsg } from '../src/net/protocol';
import type { RedactedState } from '../src/core/redact';

const PORT = 8790;
const TURN_TIMEOUT_MS = 2000;

/* 必须在 import 服务端之前设好 */
process.env.PORT = String(PORT);
process.env.ABS_TURN_TIMEOUT_MS = String(TURN_TIMEOUT_MS);
process.env.ABS_BOT_STEP_MS = '50';
process.env.ABS_SEAT_GRACE_MS = '8000';
/* 巡检间隔压到 300ms：默认 15 秒会让「房间回收」这类用例白等十几秒，
   而宽限期（8 秒）远大于它，所以不会把「该留的座位」提前清掉 */
process.env.ABS_CLEANUP_MS = '300';
/* 观战延迟：落后 1 轮（默认值，这里显式写出来，改默认值时测试不会悄悄失效） */
process.env.ABS_SPECTATOR_DELAY_ROUNDS = '1';
/* 快照目录指到临时目录：测试不该往工程里写 .abs-data，
   也不该读到上一次跑剩下的房间（那会让房间号/座位数出现莫名其妙的偏差） */
process.env.ABS_DATA_DIR = path.join(os.tmpdir(), `abs-server-test-${process.pid}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

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
/* 测试客户端                                                          */
/* ------------------------------------------------------------------ */

interface Waiter {
  pred: () => boolean;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

class Client {
  ws: WebSocket;
  name: string;
  playerId: string | null = null;
  token: string | null = null;
  gamePlayerId: string | null = null;
  room = '';
  seats: RoomSeat[] = [];
  hostId: string | null = null;
  last: RedactedState | null = null;
  deadlineAt: number | null = null;
  autopilot = false;
  resumed = false;
  spectator = false;
  seat = -1;
  spectators = 0;
  started = false;
  gameOver = false;
  spectatorDelayRounds = -1;
  readyCount = 0;
  readyTotal = 0;
  states = 0;
  /** 收到「轮到我决策」的状态帧次数 —— 用来验证多人局里没有座位被跳过 */
  turnStates = 0;
  rooms: RoomSummary[] = [];
  errors: string[] = [];
  private waiters: Waiter[] = [];

  constructor(name: string, ws: WebSocket) {
    this.name = name;
    this.ws = ws;
    ws.on('message', (raw) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(String(raw)) as ServerMsg;
      } catch {
        return;
      }
      this.handle(m);
      this.flush();
    });
  }

  private handle(m: ServerMsg): void {
    switch (m.t) {
      case 'joined':
        this.playerId = m.playerId;
        this.token = m.token;
        this.room = m.room;
        this.resumed = m.resumed;
        this.spectator = Boolean(m.spectator);
        this.spectatorDelayRounds = m.spectatorDelayRounds ?? -1;
        this.seat = m.seat;
        break;
      case 'room':
        this.seats = m.seats;
        this.spectators = m.spectators ?? 0;
        this.started = m.started;
        this.gameOver = Boolean(m.gameOver);
        this.readyCount = m.ready?.count ?? 0;
        this.readyTotal = m.ready?.total ?? 0;
        this.hostId = m.hostId || null;
        if (this.playerId) {
          const mine = m.seats.find((s) => s.playerId === this.playerId);
          if (mine) {
            this.gamePlayerId = mine.gamePlayerId ?? this.gamePlayerId;
            this.autopilot = mine.autopilot;
          }
        }
        break;
      case 'state':
        this.last = m.state;
        this.deadlineAt = m.deadlineAt;
        this.autopilot = m.autopilot;
        this.states++;
        if (this.gamePlayerId && m.state.pending?.player === this.gamePlayerId) this.turnStates += 1;
        break;
      case 'lobby':
        this.rooms = m.rooms;
        break;
      case 'error':
        this.errors.push(m.msg);
        break;
      default:
        break;
    }
  }

  private flush(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.pred()) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.timer !== timer);
        reject(new Error(`等待超时：${label}`));
      }, ms);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 所有建过的测试客户端。
 *
 * 收尾要统一断开 —— 之前是各段自己 close，漏掉一个就会在后面的「资源回到基线」
 * 用例里变成幽灵连接（实测抓到 3 个只在大厅、从没进过房间的连接）。
 * 那 3 个不是服务端漏清理，是脚手架自己没关：把它们当成泄漏会得出完全错误的结论。
 */
const ALL_CLIENTS: Client[] = [];

function connect(name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const c = new Client(name, ws);
    ALL_CLIENTS.push(c);
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

function closeAllClients(): void {
  for (const c of ALL_CLIENTS) c.close();
}

/* ------------------------------------------------------------------ */
/* 服务端指标（泄漏诊断）                                                */
/* ------------------------------------------------------------------ */

interface ServerStats {
  connections: number;
  rooms: number;
  sessions: number;
  seatedSockets: number;
  spectatorSessions: number;
  lobbySockets: number;
}

async function stats(): Promise<ServerStats> {
  // 用 localhost 而不是 127.0.0.1：本机的代理会拦后者（实测 curl 报 upstream connect failed）
  const res = await fetch(`http://localhost:${PORT}/stats`);
  return (await res.json()) as ServerStats;
}

async function waitStats(
  pred: (s: ServerStats) => boolean,
  ms: number,
  label: string,
): Promise<ServerStats> {
  const deadline = Date.now() + ms;
  let last = await stats();
  while (Date.now() < deadline) {
    if (pred(last)) return last;
    await sleep(100);
    last = await stats();
  }
  throw new Error(`等待超时：${label} —— ${JSON.stringify(last)}`);
}

/* ------------------------------------------------------------------ */
/* 驱动一局                                                            */
/* ------------------------------------------------------------------ */

function decide(c: Client): ClientMsg | null {
  const v = c.last;
  if (!v || !v.pending || v.pending.kind === 'gameOver') return null;
  if (v.pending.player !== c.gamePlayerId) return null;

  const kind = v.pending.kind;
  if (kind === 'pickCharacter') {
    const opt = v.pending.options?.[0];
    return opt ? { t: 'command', cmd: { type: 'pickCharacter', characterId: opt } } : null;
  }
  if (kind === 'action') return { t: 'command', cmd: { type: 'advancePhase' } };
  if (kind === 'intelDeclare') {
    const self = v.players.find((p) => p.id === c.gamePlayerId);
    const card = self?.hand?.[0];
    return card ? { t: 'command', cmd: { type: 'transmitIntel', cardUid: card.uid, method: 'cipher' } } : null;
  }
  if (kind === 'receive') return { t: 'command', cmd: { type: 'decideReceive', accept: true } };
  if (kind === 'response') return { t: 'command', cmd: { type: 'pass' } };
  if (kind === 'discard') {
    const self = v.players.find((p) => p.id === c.gamePlayerId);
    const uids = (self?.hand ?? []).slice(0, v.pending.need ?? 0).map((x) => x.uid);
    return { t: 'command', cmd: { type: 'discard', cardUids: uids } };
  }
  return null;
}

async function playToEnd(clients: Client[], budgetMs: number): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    for (const c of clients) {
      const msg = decide(c);
      if (msg) c.send(msg);
    }
    const any = clients.find((c) => c.last?.winner);
    if (any) return any.last!.winner!.side;
    if (clients.every((c) => c.last?.pending?.kind === 'gameOver')) return null;
    await sleep(40);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // 同进程启动服务端
  await import('../server/index');
  await sleep(300);

  console.log('\n[1] 大厅与建房');
  const lobby = await connect('看客');
  lobby.send({ t: 'lobby' });
  await sleep(150);

  const a = await connect('甲');
  a.send({ t: 'create', name: '甲' });
  await a.waitFor(() => Boolean(a.playerId), 3000, '建房后收到 joined');
  check('建房成功并拿到 4 位房间号', /^[A-Z0-9]{4}$/.test(a.room), a.room);
  check('建房者拿到重连 token', Boolean(a.token));
  check('建房者自动成为房主', a.hostId === a.playerId);

  // 建房后服务端会主动广播大厅，等它自己到
  await lobby.waitFor(() => lobby.rooms.some((r) => r.id === a.room), 2000, '大厅出现新房间');
  check(
    '新房间出现在大厅列表里',
    lobby.rooms.some((r) => r.id === a.room),
    JSON.stringify(lobby.rooms),
  );

  const b = await connect('乙');
  b.send({ t: 'join', room: a.room, name: '乙' });
  await b.waitFor(() => Boolean(b.playerId), 3000, '按房间号加入');
  check('按房间号加入成功', b.room === a.room, b.room);

  await a.waitFor(() => a.seats.length === 2, 2000, '房主看到 2 个座位');
  check('房主实时看到新玩家入座', a.seats.length === 2, a.seats.length);

  console.log('\n[2] 开局与状态裁剪');
  a.send({ t: 'start', playerCount: 3, bots: 1 });
  await a.waitFor(() => Boolean(a.last), 4000, '开局后收到状态');
  await b.waitFor(() => Boolean(b.last), 4000, '乙收到状态');

  check('对局开始，3 人（2 真人 + 1 AI）', a.last?.players.length === 3, a.last?.players.length);

  const bInA = a.last?.players.find((p) => p.id === b.gamePlayerId);
  const aInA = a.last?.players.find((p) => p.id === a.gamePlayerId);
  check('甲看不到乙的手牌', bInA?.hand === null, '泄露了');
  check('甲能看到自己的手牌', Array.isArray(aInA?.hand) && (aInA?.hand?.length ?? 0) > 0);

  console.log('\n[3] 倒计时与超时托管');
  await a.waitFor(() => a.deadlineAt !== null, 3000, '收到 deadlineAt');
  const firstDeadline = a.deadlineAt;
  check(
    '服务端下发操作截止时间（约 2 秒后）',
    typeof firstDeadline === 'number' && firstDeadline - Date.now() <= TURN_TIMEOUT_MS + 500,
    `${firstDeadline ? firstDeadline - Date.now() : 'null'}ms`,
  );

  const logLenBefore = a.last?.log.length ?? 0;
  const actorBefore = a.last?.pending?.player ?? null;
  // 故意不动，等它超时
  await a.waitFor(() => a.autopilot, TURN_TIMEOUT_MS + 2500, '超时后进入托管');
  check('超时未操作 → 自动进入托管', a.autopilot);
  await a.waitFor(
    () => (a.last?.log.length ?? 0) > logLenBefore || (a.last?.pending?.player ?? null) !== actorBefore,
    TURN_TIMEOUT_MS + 2500,
    '托管后对局继续推进',
  );
  check(
    '托管后 AI 替玩家推进了对局',
    (a.last?.log.length ?? 0) > logLenBefore,
    `日志 ${logLenBefore} → ${a.last?.log.length}`,
  );

  a.send({ t: 'takeback' });
  await a.waitFor(() => !a.autopilot, 3000, '收回控制权');
  check('「我回来了」能立刻收回控制权', !a.autopilot);

  console.log('\n[4] 断线重连');
  const tokenB = b.token!;
  const gameIdB = b.gamePlayerId;
  b.close();
  await sleep(500);
  check('乙掉线后座位仍保留', a.seats.some((s) => s.playerId === b.playerId));

  const b2 = await connect('乙-重连');
  b2.send({ t: 'resume', room: a.room, token: tokenB });
  await b2.waitFor(() => Boolean(b2.playerId), 3000, 'resume 回座');
  check('凭 token 回到原座位', b2.playerId === b.playerId, `${b2.playerId} vs ${b.playerId}`);
  check('回座标记 resumed=true', b2.resumed);
  check('回座后拿回同一个引擎玩家 id', b2.gamePlayerId === gameIdB, `${b2.gamePlayerId} vs ${gameIdB}`);
  await b2.waitFor(() => Boolean(b2.last), 3000, '重连后收到状态');
  check('重连后立刻收到裁剪过的完整状态', Boolean(b2.last?.players.length));
  check('重连后托管自动解除', !b2.autopilot);

  console.log('\n[5] 观战');

  // 观战：不占座位、不发指令，只收公开视角
  const spec = await connect('观众');
  spec.send({ t: 'spectate', room: a.room });
  await spec.waitFor(() => Boolean(spec.last), 4000, '观战者收到状态');
  check('观战者以观战身份进入', spec.spectator, `spectator=${spec.spectator}`);
  check('观战者没有重连 token', spec.token === '', spec.token);
  check('观战者不占座位', a.seats.length === 3, `座位数 ${a.seats.length}`);

  check(
    '观战者看不到任何人的手牌',
    spec.last!.players.every((p) => p.hand === null),
    spec.last!.players.map((p) => `${p.name}:${p.hand === null ? 'hidden' : 'LEAK'}`).join(','),
  );
  check(
    '观战者看不到存活玩家的身份',
    spec.last!.players.filter((p) => p.alive).every((p) => p.identity === null),
    spec.last!.players.map((p) => `${p.name}:${p.identity ?? '-'}`).join(','),
  );
  check(
    '观战者收不到密文日志',
    spec.last!.log.every((e) => !e.secretTo),
    spec.last!.log.filter((e) => e.secretTo).map((e) => e.text).join('|'),
  );

  // 同一时刻玩家视角仍有自己的手牌 —— 证明这是两套裁剪，不是「都裁成空」
  const selfInA = a.last?.players.find((p) => p.id === a.gamePlayerId);
  check('同一时刻玩家自己仍能看到手牌', Array.isArray(selfInA?.hand) && (selfInA?.hand?.length ?? 0) > 0);

  spec.send({ t: 'command', cmd: { type: 'advancePhase' } });
  await spec.waitFor(() => spec.errors.length > 0, 2000, '观战者发指令应被拒');
  check('观战者不能操作对局', spec.errors.some((m) => m.includes('观战者')), spec.errors.join('|'));

  await a.waitFor(() => a.spectators > 0, 2000, '玩家看到观战人数');
  check('玩家能看到有人在观战', a.spectators > 0, a.spectators);

  spec.close();
  await a.waitFor(() => a.spectators === 0, 3000, '观战者离开后人数归零');
  check('观战者断开后人数归零', a.spectators === 0, a.spectators);

  console.log('\n[6] 房间密码');

  const pwLobby = await connect('看大厅');
  pwLobby.send({ t: 'lobby' });
  await pwLobby.waitFor(() => pwLobby.rooms.length > 0, 3000, '拿到大厅列表');

  const pwHost = await connect('房主甲');
  pwHost.send({ t: 'create', name: '房主甲', password: '8888' });
  await pwHost.waitFor(() => Boolean(pwHost.playerId), 3000, '建密码房');
  check('建房时可以设密码', Boolean(pwHost.room), pwHost.room);

  // 大厅只暴露「有没有锁」，不暴露锁的密码
  await pwLobby.waitFor(() => pwLobby.rooms.some((r) => r.id === pwHost.room), 3000, '大厅出现密码房');
  const pwSummary = pwLobby.rooms.find((r) => r.id === pwHost.room)!;
  check('大厅标出这个房间有密码', pwSummary.hasPassword === true, JSON.stringify(pwSummary));
  check(
    '大厅不下发密码本身',
    !JSON.stringify(pwSummary).includes('8888'),
    JSON.stringify(pwSummary),
  );

  const noPw = await connect('没带密码');
  noPw.send({ t: 'join', room: pwHost.room, name: '没带密码' });
  await noPw.waitFor(() => noPw.errors.length > 0, 2500, '无密码被拒');
  check('没带密码进不去', noPw.errors.some((m) => m.includes('密码')), noPw.errors.join('|'));
  // 「没填」和「填错了」必须是两句不同的话。点邀请链接进来的人从没看见过
  // 密码输入框，收到「密码不对」只会一头雾水：他不知道要密码、也不知道去哪填。
  check(
    '没带密码时说的是「设了密码」，不是「密码不对」',
    noPw.errors.some((m) => m.includes('设了密码')) && !noPw.errors.some((m) => m.includes('不对')),
    noPw.errors.join('|'),
  );

  const wrongPw = await connect('密码错');
  wrongPw.send({ t: 'join', room: pwHost.room, name: '密码错', password: '0000' });
  await wrongPw.waitFor(() => wrongPw.errors.length > 0, 2500, '错密码被拒');
  check('密码不对进不去', wrongPw.errors.some((m) => m.includes('密码')), wrongPw.errors.join('|'));
  check(
    '填错密码时说的是「密码不对」',
    wrongPw.errors.some((m) => m.includes('不对')) && !wrongPw.errors.some((m) => m.includes('设了密码')),
    wrongPw.errors.join('|'),
  );

  const rightPw = await connect('密码对');
  rightPw.send({ t: 'join', room: pwHost.room, name: '密码对', password: '8888' });
  await rightPw.waitFor(() => Boolean(rightPw.playerId), 3000, '正确密码进房');
  check('密码正确能进房', rightPw.seat >= 0, `seat=${rightPw.seat}`);

  // 开局后观战也要密码 —— 否则「私密对局」只是不让坐，还是能被围观
  pwHost.send({ t: 'start', playerCount: 3, bots: 1 });
  await pwHost.waitFor(() => pwHost.started, 4000, '密码房开局');
  const specNoPw = await connect('围观没密码');
  specNoPw.send({ t: 'spectate', room: pwHost.room });
  await specNoPw.waitFor(() => specNoPw.errors.length > 0, 2500, '观战也要密码');
  check(
    '私密房的观战同样要密码',
    specNoPw.errors.some((m) => m.includes('密码')),
    specNoPw.errors.join('|'),
  );

  console.log('\n[7] 观战延迟（按回合）');

  // 另开一局「1 真人 + 6 机器人」：机器人每 50ms 推一步，轮次推进很快，
  // 正好用来看「观众是不是永远落后一轮」。
  const dlHost = await connect('延迟房主');
  dlHost.send({ t: 'create', name: '延迟房主' });
  await dlHost.waitFor(() => Boolean(dlHost.playerId), 3000, '建延迟测试房');
  dlHost.send({ t: 'start', playerCount: 7, bots: 6 });
  await dlHost.waitFor(() => dlHost.started && Boolean(dlHost.last), 5000, '延迟房开局');

  const dlSpec = await connect('延迟观众');
  dlSpec.send({ t: 'spectate', room: dlHost.room });
  await dlSpec.waitFor(() => Boolean(dlSpec.last), 4000, '延迟观众收到状态');
  check(
    '服务端告知观众落后几轮',
    dlSpec.spectatorDelayRounds === 1,
    `${dlSpec.spectatorDelayRounds}`,
  );

  // 第 1 轮没有「上一轮」，退到开局局面 —— 观众看到的是发牌完成的牌桌，不是空白
  check(
    '第 1 轮时观众看到的是开局局面',
    dlSpec.last!.round === 1,
    `round=${dlSpec.last!.round}`,
  );

  await dlHost.waitFor(() => (dlHost.last?.round ?? 1) >= 2, 20_000, '玩家侧进入第 2 轮');
  check(
    '玩家进入第 2 轮时观众还停在第 1 轮',
    (dlSpec.last?.round ?? 99) < (dlHost.last?.round ?? 1),
    `观众 ${dlSpec.last?.round} / 玩家 ${dlHost.last?.round}`,
  );

  // 连续采样：差距必须始终 >= 1 轮。只要有一帧追平，就等于观众能实时报点。
  let minGap = 99;
  let samples = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) {
    // 先判结算再采样：对局结束时服务端会**立刻放行最后一帧**（设计如此），
    // 那一帧观众和玩家同轮。把它算进「必须落后一轮」的采样里，就会让这条断言
    // 在「对局正好在这 2.5 秒里打完」时随机翻红 —— 实测确实 flaky 过。
    if (dlHost.last?.winner) break;
    const sr = dlSpec.last?.round ?? 0;
    const pr = dlHost.last?.round ?? 0;
    if (sr > 0 && pr >= 2) {
      minGap = Math.min(minGap, pr - sr);
      samples += 1;
    }
    await sleep(80);
  }
  check(
    '观众始终落后至少一轮（拿不到当前轮的任何信息）',
    samples > 0 && minGap >= 1,
    `${samples} 次采样，最小差距 ${minGap} 轮`,
  );

  // 对局结束：不再等一轮，立刻放行最后一帧 —— 让观众多等一轮才知道谁赢了没有意义
  await dlHost.waitFor(() => Boolean(dlHost.last?.winner), 40_000, '延迟房打完');
  const winnerSide = dlHost.last!.winner!.side;
  await dlSpec.waitFor(() => dlSpec.last?.winner?.side === winnerSide, 3000, '观众立刻看到结算');
  check(
    '对局结束立刻放行最后一帧（不再压一轮）',
    dlSpec.last?.winner?.side === winnerSide,
    `观众 ${dlSpec.last?.winner?.side ?? '无'} / 玩家 ${winnerSide}`,
  );

  dlHost.close();
  dlSpec.close();
  pwHost.close();
  rightPw.close();
  pwLobby.close();

  console.log('\n[8] 打完整局');
  const winner = await playToEnd([a, b2], 60_000);
  check('两个客户端协作能打完一整局', winner !== null, '60 秒内未结束');
  if (winner) console.log(`  · 获胜方：${winner}`);

  console.log('\n[9] 再来一局（准备制）');

  /** 自己的座位是否已准备 */
  const iAmReady = (cl: Client): boolean =>
    Boolean(cl.seats.find((x) => x.playerId === cl.playerId)?.ready);

  check('一局结束后还没人准备', a.readyCount === 0, `${a.readyCount}/${a.readyTotal}`);

  // 只有一个人准备时不能开局 —— 否则还在看结算的人会被直接掀桌
  a.send({ t: 'rematch' });
  await a.waitFor(() => iAmReady(a), 3000, '甲准备');
  await a.waitFor(() => a.readyCount === 1, 3000, '准备人数变成 1');
  check('点「再来一局」是准备，不是立刻重开', a.readyCount === 1 && a.readyTotal === 2, `${a.readyCount}/${a.readyTotal}`);
  check('一个人准备时对局没有重启', Boolean(a.last?.winner), a.last?.winner?.side ?? '无');

  // 再点一次可以反悔
  a.send({ t: 'rematch' });
  await a.waitFor(() => !iAmReady(a), 3000, '甲取消准备');
  check('再点一次可以取消准备', !iAmReady(a) && a.readyCount === 0, `${a.readyCount}/${a.readyTotal}`);

  // 两个人一起准备 → 自动开新局
  a.send({ t: 'rematch' });
  await a.waitFor(() => iAmReady(a), 3000, '甲重新准备');
  b2.send({ t: 'rematch' });
  await a.waitFor(() => !a.last?.winner, 5000, '全员准备后开新局');
  check('全员准备好后自动开新一局', !a.last?.winner, a.last?.winner?.side ?? '无');
  check('新一局回到选角阶段', a.last?.phase === 'setup', a.last?.phase);
  check(
    '新一局所有人的情报清空',
    a.last!.players.every((p) => p.intel.length === 0),
    a.last!.players.map((p) => `${p.name}:${p.intel.length}`).join(','),
  );
  await a.waitFor(() => a.readyCount === 0, 3000, '开局后准备名单清空');
  check('开局后准备名单被清空', a.readyCount === 0 && !iAmReady(a), `${a.readyCount}/${a.readyTotal}`);

  // 观战者不占准备名额：上面 total 一直是 2（两个真人）
  check('准备人数只数真人，不含机器人', a.readyTotal === 2, String(a.readyTotal));

  console.log('\n[9b] 结算页有人掉线：进度条不能说「全员已准备」');

  // readySummary 的 total 原本是 max(在线人数, 已准备人数)，而「已准备人数」
  // 把掉线的人也算进去（掉线 = 自动准备，这是对的）。
  // 两者一混：3 人局里丙掉线、甲点了准备、乙没点 —— count = 甲 + 丙 = 2，
  // total = max(2, 2) = 2，界面显示「2 / 2 已准备」，但 allReady 是 false，
  // 游戏根本不会开始。玩家会盯着一个「已满」的进度条干等。
  const rdA = await connect('准备甲');
  rdA.send({ t: 'create', name: '准备甲' });
  await rdA.waitFor(() => Boolean(rdA.playerId), 3000, '准备甲建房');
  const rdB = await connect('准备乙');
  rdB.send({ t: 'join', room: rdA.room, name: '准备乙' });
  await rdB.waitFor(() => Boolean(rdB.playerId), 3000, '准备乙加入');
  const rdC = await connect('准备丙');
  rdC.send({ t: 'join', room: rdA.room, name: '准备丙' });
  await rdC.waitFor(() => Boolean(rdC.playerId), 3000, '准备丙加入');
  rdA.send({ t: 'start', playerCount: 3, bots: 0 });
  await rdA.waitFor(() => rdA.started, 4000, '准备房开局');
  await playToEnd([rdA, rdB, rdC], 60_000);
  await rdA.waitFor(() => Boolean(rdA.last?.winner), 5000, '准备房打完');

  rdC.close(); // 丙掉线，不点离开
  await rdA.waitFor(() => rdA.readyTotal === 2, 4000, '进度条看到 2 个在线');
  rdA.send({ t: 'rematch' }); // 甲准备，乙没点
  // 不能等 readyCount >= 1：掉线的丙自己就让 count 变成 1 了，
  // 这个条件在甲的 rematch 到达之前就已经成立（第一版栽在这里，用例假绿）。
  await rdA.waitFor(() => iAmReady(rdA), 3000, '甲的准备状态生效');

  console.log(`  · 实测 ${rdA.readyCount}/${rdA.readyTotal}，座位：` +
    rdA.seats.map((x) => `${x.name}:${x.connected ? '在线' : '掉线'}${x.ready ? '/已准备' : ''}`).join(','));
  check(
    '掉线的人自动算准备，但不能把进度条凑成「全员已准备」',
    rdA.readyCount === 1 && rdA.readyTotal === 2,
    `${rdA.readyCount}/${rdA.readyTotal}（丙掉线、乙没准备，应该是 1/2）`,
  );
  check('这种情况下不该开新一局', Boolean(rdA.last?.winner), rdA.last?.winner?.side ?? '无');
  rdA.close();
  rdB.close();

  console.log('\n[10] 再来一局：主动离开的人不会留成空位');

  // 真实场景：5 人局打完，一个人直接点了「离开」走了，
  // 剩下的人重开时不能凭空多出一个 AI 代打的空座位。
  const zm = await connect('子');
  zm.send({ t: 'create', name: '子' });
  await zm.waitFor(() => Boolean(zm.playerId), 3000, '子建房');
  const cm = await connect('丑');
  cm.send({ t: 'join', room: zm.room, name: '丑' });
  await cm.waitFor(() => Boolean(cm.playerId), 3000, '丑加入');
  zm.send({ t: 'start', playerCount: 5, bots: 3 });
  await zm.waitFor(() => zm.started, 4000, '子开局');
  const zmWinner = await playToEnd([zm, cm], 60_000);
  check('第二个房间也能打完一局', zmWinner !== null, '60 秒内未结束');

  const seatsBefore = zm.seats.length;
  check('开局时是 5 个座位', seatsBefore === 5, String(seatsBefore));

  // 丑点「离开」—— 主动离开，不是掉线
  cm.send({ t: 'leave' });
  await zm.waitFor(() => zm.seats.length === 4, 4000, '丑离开后座位被摘掉');
  check('主动离开的座位被立刻摘掉', zm.seats.length === 4, `实际 ${zm.seats.length} 个座位`);
  check(
    '剩下的座位号连续（没有空洞）',
    zm.seats.every((x, i) => x.seat === i),
    zm.seats.map((x) => x.seat).join(','),
  );

  zm.send({ t: 'rematch' });
  await zm.waitFor(() => !zm.last?.winner, 5000, '子一个人准备也能开（离线的人算自动准备）');
  check('新一局正常开始', zm.last?.phase === 'setup', zm.last?.phase);

  zm.close();

  console.log('\n[10b] 宽限期内掉线 ≠ 主动离开（座位必须留着）');

  // 与 [10] 相对：直接断 socket（wifi 抖动 / 刷新页面）不是「走了」。
  // 这里曾经只按 connected 判断，于是结算页刚好断一下的人会被永久删座，
  // 回来时 token 已失效 —— 而界面上一秒还在说「座位保留 5 分钟」。
  const bp = await connect('寅');
  bp.send({ t: 'create', name: '寅' });
  await bp.waitFor(() => Boolean(bp.playerId), 3000, '寅建房');
  const mp = await connect('卯');
  mp.send({ t: 'join', room: bp.room, name: '卯' });
  await mp.waitFor(() => Boolean(mp.playerId), 3000, '卯加入');
  bp.send({ t: 'start', playerCount: 3, bots: 1 });
  await bp.waitFor(() => bp.started, 4000, '寅开局');
  const bpWinner = await playToEnd([bp, mp], 60_000);
  check('第三个房间也能打完一局', bpWinner !== null, '60 秒内未结束');

  const mpId = mp.playerId;
  const mpToken = mp.token;
  mp.close();
  await bp.waitFor(
    () => bp.seats.filter((x) => !x.isBot && !x.connected).length === 1,
    4000,
    '卯离线',
  );
  check('掉线不会把座位摘掉', bp.seats.length === 3, `实际 ${bp.seats.length} 个座位`);

  const mp2 = await connect('卯');
  mp2.send({ t: 'resume', room: bp.room, token: mpToken ?? '' });
  await mp2.waitFor(() => Boolean(mp2.playerId), 4000, '卯回座');
  check('宽限期内掉线的人能凭 token 回到原座', mp2.playerId === mpId, `${mp2.playerId} vs ${mpId}`);
  check('回座被标记为 resumed', mp2.resumed);

  // 必须等「卯重新在线」被观测到再断第二次：否则下面的谓词会被**上一次**离线的旧状态
  // 立刻满足，测试就会在卯其实还连着的时候发 rematch（这个坑实测踩过）
  await bp.waitFor(
    () => bp.seats.filter((x) => !x.isBot && x.connected).length === 2,
    4000,
    '卯回座后重新在线',
  );

  // 再断一次，房主直接点准备：宽限期内的人应该留在座位表里（这一局由 AI 代打），
  // 而不是被「再来一局」当成「走了」删掉
  mp2.close();
  await bp.waitFor(
    () => bp.seats.filter((x) => !x.isBot && !x.connected).length === 1,
    4000,
    '卯再次离线',
  );
  bp.send({ t: 'rematch' });
  await bp.waitFor(() => !bp.last?.winner, 6000, '寅一个人准备也能开');
  check('宽限期内掉线的人不会被再来一局摘掉', bp.seats.length === 3, `实际 ${bp.seats.length} 个座位`);
  check('新一局仍有 3 个参与者（掉线的由 AI 顶替）', bp.last?.players.length === 3, bp.last?.players.length);

  bp.close();

  console.log('\n[10c] 对局中主动离开：座位留到本局结束，先交给 AI');

  // 和 [10] 的区别：[10] 是「打完点离开」（座位立刻摘），这里是「打到一半点离开」。
  // 对局中不能摘座位 —— 座位号就是引擎里的玩家下标，删一个整个状态会错位。
  // 所以这条路径的正确行为是：留座 + 打 left 标记 + 立刻托管，下一局开局时再摘。
  const si = await connect('巳');
  si.send({ t: 'create', name: '巳' });
  await si.waitFor(() => Boolean(si.playerId), 3000, '巳建房');
  const wu = await connect('午');
  wu.send({ t: 'join', room: si.room, name: '午' });
  await wu.waitFor(() => Boolean(wu.playerId), 3000, '午加入');
  si.send({ t: 'start', playerCount: 4, bots: 2 });
  await si.waitFor(() => si.started, 4000, '巳开局');
  const wuId = wu.playerId;

  wu.send({ t: 'leave' });
  // 注意谓词要看**标记变化**，不能看座位数 —— 座位数本来就已经是 4，
  // waitFor 会被开局时的旧状态立刻满足，等于什么都没验（这个坑踩过）
  await si.waitFor(
    () => si.seats.some((x) => x.playerId === wuId && !x.connected && x.autopilot),
    4000,
    '午的座位被打上离线 + 托管标记',
  );
  const goneSeat = si.seats.find((x) => x.playerId === wuId);
  check('对局中离开不摘座位（摘了引擎状态就错位）', si.seats.length === 4, `实际 ${si.seats.length}`);
  check('离开的座位标记为离线', goneSeat?.connected === false, String(goneSeat?.connected));
  check('离开的座位立刻交给 AI 托管', goneSeat?.autopilot === true, String(goneSeat?.autopilot));

  // 走日志而不是只发一条广播：日志跟着快照持久化，
  // 中途重连 / 服务端重启之后还在。否则后来的人只会看到「这个座位一直在被 AI 托管」
  await si.waitFor(
    () => Boolean(si.last?.log.some((e) => e.text.includes('离开了对局'))),
    4000,
    '对局日志里出现「某人离开了对局」',
  );
  check(
    '对局日志记下了有人离开（不是只弹个提示）',
    Boolean(si.last?.log.some((e) => e.text.includes('离开了对局') && e.text.includes('午'))),
    si.last?.log.slice(-2).map((e) => e.text).join(' | '),
  );
  check(
    '剩下的人不会卡在倒计时上',
    si.last?.pending !== undefined,
    JSON.stringify(si.last?.pending),
  );

  const siWinner = await playToEnd([si], 60_000);
  check('少一个人也能把这一局打完（AI 代打）', siWinner !== null, '60 秒内未结束');

  si.send({ t: 'rematch' });
  await si.waitFor(() => !si.last?.winner, 6000, '再来一局');
  check('下一局开始时摘掉已离开的座位', si.seats.length === 3, `实际 ${si.seats.length}`);
  check('离开的人不在新一局的座位表里', !si.seats.some((x) => x.playerId === wuId));
  si.close();

  console.log('\n[10d] 房主在对局中离开：房主立刻转给还在线的下一位');

  // 只在大厅分支转房主是漏的：对局中离开的座位要留到下一局才摘，
  // hostId 会一直指着一个已经走了的人 —— 本局打完后剩下的人里谁都不是房主，
  // 「调整人数」被挡，只能靠「有人点再来一局时顺带摘座位」碰运气自愈。
  const wei = await connect('未');
  wei.send({ t: 'create', name: '未' });
  await wei.waitFor(() => Boolean(wei.playerId), 3000, '未建房');
  const shen = await connect('申');
  shen.send({ t: 'join', room: wei.room, name: '申' });
  await shen.waitFor(() => Boolean(shen.playerId), 3000, '申加入');
  wei.send({ t: 'start', playerCount: 4, bots: 2 });
  await wei.waitFor(() => wei.started, 4000, '未开局');
  check('开局时房主是建房的人', shen.hostId === wei.playerId, `${shen.hostId} vs ${wei.playerId}`);

  wei.send({ t: 'leave' });
  await shen.waitFor(() => shen.hostId === shen.playerId, 4000, '房主转给申');
  check('房主对局中离开 → 房主立刻转移', shen.hostId === shen.playerId, String(shen.hostId));
  check(
    '房主没有留在一个已经离开的座位上',
    shen.hostId !== wei.playerId,
    `${shen.hostId} vs ${wei.playerId}`,
  );

  const shenWinner = await playToEnd([shen], 60_000);
  check('第四个房间也能打完一局', shenWinner !== null, '60 秒内未结束');

  // 光看 hostId 只能证明字段变了，这里再验一次「权限真的到手了」：
  // 调整人数这条命令在转移前会被「只有房主可以调整人数」挡掉。
  // 数量要给成和现有机器人**不同**的值 —— 相同的话 setBotCount 会直接 early-return，
  // 座位表根本不会重建，等于什么都没验到（第一版就是这么写的，白跑一轮）。
  shen.send({ t: 'bots', count: 3 });
  await sleep(250);
  check(
    '新房主能行使房主权限（调整人数）',
    !shen.errors.some((m) => m.includes('房主')),
    shen.errors.join('|'),
  );
  check(
    '已离开的人被清出座位表，不再参与人数计算',
    !shen.seats.some((x) => x.playerId === wei.playerId),
    shen.seats.map((x) => `${x.name}${x.isBot ? '(bot)' : ''}`).join(','),
  );
  check(
    '重建后的座位表只数还在的人',
    shen.seats.filter((x) => !x.isBot).length === 1,
    shen.seats.map((x) => `${x.name}${x.isBot ? '(bot)' : ''}`).join(','),
  );
  shen.close();

  console.log('\n[10e] 全员主动离开：房间立刻回收，不在大厅挂 5 分钟');

  // 修之前这里要等满 5 分钟宽限期：left 座位的 disconnectedAt 也是刚设的，
  // 「还有活人」的判定会把他当成「掉线但可能回来」，于是大厅上挂着一个 0 人房间。
  // 主动离开是明确的意图，不该享受反悔窗口。
  // 注意测试里的宽限期是 8 秒，所以「4 秒内消失」才说明是 left 标记起了作用。
  const obs = await connect('旁观');
  obs.send({ t: 'lobby' });
  await sleep(150);

  const you = await connect('酉');
  you.send({ t: 'create', name: '酉' });
  await you.waitFor(() => Boolean(you.playerId), 3000, '酉建房');
  const xu = await connect('戌');
  xu.send({ t: 'join', room: you.room, name: '戌' });
  await xu.waitFor(() => Boolean(xu.playerId), 3000, '戌加入');
  you.send({ t: 'start', playerCount: 3, bots: 1 });
  await you.waitFor(() => you.started, 4000, '酉开局');
  const ghostRoom = you.room;
  await obs.waitFor(() => obs.rooms.some((r) => r.id === ghostRoom), 3000, '大厅能看到这个房间');

  // 对局中两个人先后离开 → 房间里只剩机器人和两个 left 座位
  you.send({ t: 'leave' });
  xu.send({ t: 'leave' });
  await obs.waitFor(() => !obs.rooms.some((r) => r.id === ghostRoom), 4000, '房间从大厅消失');
  check(
    '全员主动离开后房间立刻回收（不用等宽限期）',
    !obs.rooms.some((r) => r.id === ghostRoom),
    JSON.stringify(obs.rooms.map((r) => r.id)),
  );

  // 走掉的房间不能被复活：token 已经没用了，再来一次必须进不去
  const back = await connect('酉');
  back.send({ t: 'resume', room: ghostRoom, token: you.token ?? '' });
  await back.waitFor(() => back.errors.length > 0, 3000, '回收后 token 失效');
  check('房间回收后旧 token 不能把人塞回去', back.errors.length > 0, back.errors.join('|'));
  back.close();
  obs.close();

  console.log('\n[10f] 全员掉线（不是主动离开）：大厅必须说「无人在线」');

  // 掉线有保座宽限期（测试里是 8 秒），这期间座位还在、players 也还数着他。
  // 但「一个人都不在线」的房间不能在大厅上显示成「2 / 7 人」——
  // 玩家点进去才发现是空的（实测：还会莫名其妙接管房主）。
  // 所以 RoomSummary 把 online 和 players 分开报。
  const watcher = await connect('看客');
  watcher.send({ t: 'lobby' });
  await sleep(150);

  const h1 = await connect('房主甲');
  h1.send({ t: 'create', name: '房主甲' });
  await h1.waitFor(() => Boolean(h1.playerId), 3000, '房主甲建房');
  const guestB = await connect('客人乙');
  guestB.send({ t: 'join', room: h1.room, name: '客人乙' });
  await guestB.waitFor(() => Boolean(guestB.playerId), 3000, '客人乙加入');
  const sleepy = h1.room;
  await watcher.waitFor(() => watcher.rooms.some((r) => r.id === sleepy), 3000, '大厅能看到这个房间');

  // 等大厅把「乙也进来了」这一帧推过来，否则读到的是加入之前的旧列表
  await watcher.waitFor(
    () => watcher.rooms.find((r) => r.id === sleepy)?.players === 2,
    3000,
    '大厅看到两个人',
  );
  const ghostBefore = watcher.rooms.find((r) => r.id === sleepy);
  check(
    '两个人都连着时 online 等于 players',
    ghostBefore?.online === 2 && ghostBefore?.players === 2,
    JSON.stringify(ghostBefore),
  );

  // 两个人先后直接关掉 socket（模拟关浏览器 / wifi 断），不点「离开」
  h1.close();
  guestB.close();
  await watcher.waitFor(
    () => watcher.rooms.find((r) => r.id === sleepy)?.online === 0,
    4000,
    'online 掉到 0',
  );
  const ghostAfter = watcher.rooms.find((r) => r.id === sleepy);
  check('全员掉线后 online 归零', ghostAfter?.online === 0, JSON.stringify(ghostAfter));
  check('但座位还留着（保座宽限期，人可能回来）', ghostAfter?.players === 2, JSON.stringify(ghostAfter));

  // 宽限期过后没人回来 → 房间回收。这条同时保证这个用例不会给后面的
  // 「资源回到基线」留下一个挂着的房间。
  await watcher.waitFor(
    () => !watcher.rooms.some((r) => r.id === sleepy),
    20000,
    '宽限期过后房间回收',
  );
  check('宽限期过后房间自动回收', !watcher.rooms.some((r) => r.id === sleepy));
  watcher.close();

  console.log('\n[11] 结算阶段允许新人加入');

  // 场景：3 人局打完，一个朋友才赶到。房间此时 started=true，
  // 但已经分出胜负，应该让他进来打下一局，而不是「对局已开始，无法加入」。
  const lj = await connect('寅');
  lj.send({ t: 'create', name: '寅' });
  await lj.waitFor(() => Boolean(lj.playerId), 3000, '寅建房');
  const lj2 = await connect('卯');
  lj2.send({ t: 'join', room: lj.room, name: '卯' });
  await lj2.waitFor(() => Boolean(lj2.playerId), 3000, '卯加入');
  lj.send({ t: 'start', playerCount: 3, bots: 1 });
  await lj.waitFor(() => lj.started, 4000, '寅开局');

  // 对局进行中：加入仍然要被拒（这是不能松的那条线）
  const early = await connect('辰');
  early.send({ t: 'join', room: lj.room, name: '辰' });
  await early.waitFor(() => early.errors.length > 0, 3000, '对局中不能加入');
  check(
    '对局进行中仍然不能加入',
    early.errors.some((m) => m.includes('已经开始')),
    early.errors.join('|'),
  );
  early.close();

  const ljWinner = await playToEnd([lj, lj2], 60_000);
  check('第三个房间能打完一局', ljWinner !== null, '60 秒内未结束');
  await lj.waitFor(() => lj.gameOver, 3000, '房间标记为「本局已结束」');
  check('结算阶段房间标记 gameOver', lj.gameOver);

  // 大厅里这个房间要显示成「可加入下一局」，不能显示成「对局中」
  lj.send({ t: 'lobby' });
  await lj.waitFor(() => lj.rooms.some((r) => r.id === lj.room && r.gameOver), 3000, '大厅标记 gameOver');
  const ljSummary = lj.rooms.find((r) => r.id === lj.room)!;
  check('大厅里结算阶段的房间可加入', ljSummary.joinable, JSON.stringify(ljSummary));
  check('大厅里结算阶段的房间仍标记 started', ljSummary.started, JSON.stringify(ljSummary));

  // 新人在结算阶段加入
  const late = await connect('巳');
  late.send({ t: 'join', room: lj.room, name: '巳' });
  await late.waitFor(() => Boolean(late.playerId), 4000, '结算阶段加入');
  check(
    '结算阶段可以加入',
    Boolean(late.playerId) && late.errors.length === 0,
    late.errors.join('|') || '没拿到 playerId',
  );

  await late.waitFor(() => late.seats.length === 3, 3000, '新人出现在座位表里');
  check('座位数没有膨胀（还是 3 个）', late.seats.length === 3, `${late.seats.length} 个座位`);
  check(
    '新人顶掉了机器人，而不是被追加成第 4 人',
    late.seats.filter((x) => !x.isBot).length === 3,
    late.seats.map((x) => `${x.name}${x.isBot ? '(AI)' : ''}`).join(','),
  );
  check('新人一开始没有 gamePlayerId', late.gamePlayerId === null, String(late.gamePlayerId));

  // 关键：没有 gamePlayerId 就不能收到对局状态，否则他拿到的是「谁的手牌都看得见」的视角
  await sleep(600);
  check(
    '新人不会收到上一局的状态（拿不到别人的手牌）',
    late.states === 0,
    `收到 ${late.states} 条 state`,
  );

  // 新人算自动准备：他已经用「加入」表达过想打了，再点一次「准备」是多余操作
  await late.waitFor(() => late.readyCount >= 1, 3000, '新人自动准备');
  check(
    '结算阶段加入的人自动算准备',
    Boolean(late.seats.find((x) => x.playerId === late.playerId)?.ready),
    late.seats.map((x) => `${x.name}:${x.ready ? 'ready' : '-'}`).join(','),
  );

  // 原来两人也准备 → 应该直接开下一局
  lj.send({ t: 'rematch' });
  lj2.send({ t: 'rematch' });
  await lj.waitFor(() => !lj.last?.winner && lj.started, 6000, '全员准备后开下一局');
  check('新人加入后能凑齐并开出下一局', !lj.last?.winner, lj.last?.winner?.side ?? '无');
  await late.waitFor(() => Boolean(late.gamePlayerId), 4000, '新人拿到 gamePlayerId');
  check('新人在下一局里有自己的 gamePlayerId', Boolean(late.gamePlayerId), String(late.gamePlayerId));
  await late.waitFor(() => Boolean(late.last), 4000, '新人收到新一局的状态');
  check(
    '新人收到的是新一局（情报清空）',
    Boolean(late.last) && late.last!.players.every((p) => p.intel.length === 0),
    late.last?.players.map((p) => `${p.name}:${p.intel.length}`).join(','),
  );
  const lateSelf = late.last?.players.find((p) => p.id === late.gamePlayerId);
  check(
    '新人看到的是自己的手牌（不是别人的）',
    Array.isArray(lateSelf?.hand) && (lateSelf?.hand?.length ?? 0) > 0,
    `${lateSelf?.hand?.length ?? 'null'} 张`,
  );

  for (const cl of [lj, lj2, late]) cl.close();

  console.log('\n[12] 换座位与人数调整');

  // 座位顺序 = 行动顺序 = 情报传递方向，所以这是有策略意义的操作，值得测死。
  const sw = await connect('戊');
  sw.send({ t: 'create', name: '戊' });
  await sw.waitFor(() => Boolean(sw.playerId), 3000, '戊建房');
  const sw2 = await connect('己');
  sw2.send({ t: 'join', room: sw.room, name: '己' });
  await sw2.waitFor(() => Boolean(sw2.playerId), 3000, '己加入');
  const sw3 = await connect('庚');
  sw3.send({ t: 'join', room: sw.room, name: '庚' });
  await sw3.waitFor(() => Boolean(sw3.playerId), 3000, '庚加入');

  const orderOf = (cl: Client): string => cl.seats.map((x) => x.name).join('>');
  // 庚拿到自己的 joined 不等于戊已经收到房间广播 —— 要等戊这边的座位表补齐
  await sw.waitFor(() => sw.seats.length === 3, 3000, '戊看到 3 个座位');
  check('初始座位顺序', orderOf(sw) === '戊>己>庚', orderOf(sw));

  // 非房主不能动别人的座位
  sw3.send({ t: 'swap', a: 0, b: 1 });
  await sw3.waitFor(() => sw3.errors.length > 0, 3000, '非房主换别人的座位应被拒');
  check(
    '非房主不能交换别人的座位',
    sw3.errors.some((m) => m.includes('只有房主')),
    sw3.errors.join('|'),
  );
  check('被拒之后座位没变', orderOf(sw) === '戊>己>庚', orderOf(sw));

  // 非房主可以把自己和别人换
  sw3.send({ t: 'swap', a: 2, b: 0 });
  await sw.waitFor(() => orderOf(sw) === '庚>己>戊', 3000, '庚换到 1 号位');
  check('非房主可以把自己和一个别人交换', orderOf(sw) === '庚>己>戊', orderOf(sw));

  // 房主可以交换任意两个
  sw.send({ t: 'swap', a: 1, b: 2 });
  await sw.waitFor(() => orderOf(sw) === '庚>戊>己', 3000, '房主交换己和戊');
  check('房主可以交换任意两个座位', orderOf(sw) === '庚>戊>己', orderOf(sw));
  check(
    '交换后座位号是连续的 0..n-1',
    sw.seats.every((x, i) => x.seat === i),
    sw.seats.map((x) => x.seat).join(','),
  );

  // 开局后锁死
  sw.send({ t: 'start', playerCount: 3, bots: 0 });
  await sw.waitFor(() => sw.started, 4000, '戊开局');
  const orderInGame = orderOf(sw);
  sw.send({ t: 'swap', a: 0, b: 1 });
  await sw.waitFor(() => sw.errors.some((m) => m.includes('对局进行中')), 3000, '对局中换座应被拒');
  check(
    '对局进行中不能换座位',
    sw.errors.some((m) => m.includes('对局进行中')),
    sw.errors.join('|'),
  );
  check('对局中座位保持不变', orderOf(sw) === orderInGame, orderOf(sw));

  // 对局中也不能改人数
  sw.send({ t: 'bots', count: 2 });
  await sw.waitFor(() => sw.errors.some((m) => m.includes('两局之间')), 3000, '对局中改人数应被拒');
  check('对局进行中不能改人数', sw.errors.some((m) => m.includes('两局之间')));

  const swWinner = await playToEnd([sw, sw2, sw3], 90_000);
  check('换座之后的房间也能打完一局', swWinner !== null, '90 秒内未结束');
  await sw.waitFor(() => sw.gameOver, 3000, '戊的房间进入结算阶段');

  // 结算阶段又能换座了
  sw.send({ t: 'swap', a: 0, b: 2 });
  await sw.waitFor(() => orderOf(sw) !== orderInGame, 3000, '结算阶段换座');
  check('两局之间可以换座位', orderOf(sw) !== orderInGame, orderOf(sw));

  // 房主调人数
  const beforeBots = sw.seats.filter((x) => x.isBot).length;
  check('这一局没有机器人', beforeBots === 0, String(beforeBots));

  sw2.send({ t: 'bots', count: 2 });
  await sw2.waitFor(() => sw2.errors.some((m) => m.includes('只有房主')), 3000, '非房主改人数应被拒');
  check('非房主不能改人数', sw2.errors.some((m) => m.includes('只有房主')), sw2.errors.join('|'));

  sw.send({ t: 'bots', count: 2 });
  await sw.waitFor(() => sw.seats.filter((x) => x.isBot).length === 2, 3000, '补 2 个机器人');
  check('房主能把机器人补到 2 个', sw.seats.filter((x) => x.isBot).length === 2, String(sw.seats.length));
  check('补机器人后总座位是 5', sw.seats.length === 5, String(sw.seats.length));
  check(
    '真人仍然排在前面且顺序不变（机器人补在后面）',
    sw.seats.slice(0, 3).every((x) => !x.isBot),
    sw.seats.map((x) => `${x.name}${x.isBot ? '(AI)' : ''}`).join(','),
  );

  sw.send({ t: 'bots', count: 0 });
  await sw.waitFor(() => sw.seats.filter((x) => x.isBot).length === 0, 3000, '机器人减到 0');
  check('房主能把机器人减到 0', sw.seats.filter((x) => x.isBot).length === 0, String(sw.seats.length));
  check('减机器人后总座位回到 3', sw.seats.length === 3, String(sw.seats.length));

  // 低于 3 人会被兜住（3 个真人时下限就是 0，所以这里换一个 2 人房来验）
  const sw4 = await connect('辛');
  sw4.send({ t: 'create', name: '辛' });
  await sw4.waitFor(() => Boolean(sw4.playerId), 3000, '辛建房');
  const sw5 = await connect('壬');
  sw5.send({ t: 'join', room: sw4.room, name: '壬' });
  await sw5.waitFor(() => Boolean(sw5.playerId), 3000, '壬加入');
  sw4.send({ t: 'start', playerCount: 3, bots: 1 });
  await sw4.waitFor(() => sw4.started, 4000, '辛开局（2 真人 + 1 机器人）');
  const sw5Winner = await playToEnd([sw4, sw5], 90_000);
  check('两人房也能打完', sw5Winner !== null, '90 秒内未结束');
  await sw4.waitFor(() => sw4.gameOver, 3000, '辛的房间进入结算阶段');
  sw4.send({ t: 'bots', count: 0 });
  await sw4.waitFor(() => sw4.seats.filter((x) => x.isBot).length === 1, 4000, '机器人不能被减到 0');
  check(
    '2 个真人时机器人不会被减到 0（否则凑不够 3 人开局）',
    sw4.seats.filter((x) => x.isBot).length === 1,
    sw4.seats.map((x) => `${x.name}${x.isBot ? '(AI)' : ''}`).join(','),
  );

  for (const cl of [sw, sw2, sw3, sw4, sw5]) cl.close();

  console.log('\n[13] 房主转移');
  const c = await connect('丙');
  c.send({ t: 'create', name: '丙' });
  await c.waitFor(() => Boolean(c.playerId), 3000, '丙建房');
  const d = await connect('丁');
  d.send({ t: 'join', room: c.room, name: '丁' });
  await d.waitFor(() => Boolean(d.playerId), 3000, '丁加入');
  await d.waitFor(() => d.hostId === c.playerId, 2000, '丁看到房主是丙');
  check('建房者是房主', d.hostId === c.playerId);

  c.close();
  await d.waitFor(() => d.hostId === d.playerId, 4000, '房主转移给丁');
  check('房主掉线后自动转移给剩下的人', d.hostId === d.playerId, d.hostId);

  console.log('\n[14] 错误处理');
  const e = await connect('戊');
  e.send({ t: 'join', room: 'ZZZZ', name: '戊' });
  await e.waitFor(() => e.errors.length > 0, 2000, '加入不存在的房间应报错');
  check('加入不存在的房间会报错', e.errors.some((m) => m.includes('不存在')), e.errors.join('|'));

  const g2 = await connect('庚');
  g2.send({ t: 'create', name: '庚' });
  await g2.waitFor(() => Boolean(g2.playerId), 3000, '庚建房');
  const h2 = await connect('辛');
  h2.send({ t: 'spectate', room: g2.room });
  await h2.waitFor(() => h2.errors.length > 0, 2000, '未开局的房间不能观战');
  check('未开局的房间不能观战', h2.errors.some((m) => m.includes('还没开始')), h2.errors.join('|'));

  // 没打完就点「再来一局」：必须被拒，否则等于「重置对局」按钮
  const nr = await connect('壬');
  nr.send({ t: 'create', name: '壬' });
  await nr.waitFor(() => Boolean(nr.playerId), 3000, '壬建房');
  nr.send({ t: 'start', playerCount: 3, bots: 2 });
  await nr.waitFor(() => nr.started, 3000, '壬开局');
  nr.send({ t: 'rematch' });
  await nr.waitFor(() => nr.errors.length > 0, 2000, '未结束时不能准备');
  check('对局没结束不能点再来一局', nr.errors.some((m) => m.includes('还没结束')), nr.errors.join('|'));

  const f = await connect('己');
  f.send({ t: 'resume', room: a.room, token: 'bogus-token' });
  await f.waitFor(() => f.errors.length > 0, 2000, '无效 token 应报错');
  check('无效 token 无法回座', f.errors.some((m) => m.includes('座位')), f.errors.join('|'));

  for (const cl of [a, b2, c, d, e, f, g2, h2, nr, zm, lobby]) cl.close();

  console.log('\n[15] 四个真人同桌（服务端轮转 + 每人独立视角）');

  // 之前所有联机用例都是「2 个真人 + 机器人」：轮到真人时只有一个客户端要等，
  // 座位轮转、情报按座位顺序往下传、多人同时可响应这些路径其实没在服务端跑过。
  // 这里用 4 个真人、0 个机器人，把这几种情况一次性压出来。
  const p1 = await connect('冬');
  p1.send({ t: 'create', name: '冬' });
  await p1.waitFor(() => Boolean(p1.playerId), 3000, '冬建房');
  const four: Client[] = [p1];
  for (const nm of ['春', '夏', '秋']) {
    const c2 = await connect(nm);
    c2.send({ t: 'join', room: p1.room, name: nm });
    await c2.waitFor(() => Boolean(c2.playerId), 3000, `${nm} 加入`);
    four.push(c2);
  }
  p1.send({ t: 'start', playerCount: 4, bots: 0 });
  await p1.waitFor(() => p1.started, 4000, '冬开局（4 个真人）');
  for (const c2 of four) await c2.waitFor(() => Boolean(c2.last), 6000, `${c2.name} 收到状态`);

  check(
    '4 个真人都在同一局里',
    four.every((c2) => c2.last?.players.length === 4),
    four.map((c2) => c2.last?.players.length).join(','),
  );
  check(
    '这一局没有机器人',
    p1.seats.filter((x) => x.isBot).length === 0,
    p1.seats.map((x) => x.name).join(','),
  );
  check(
    '每人拿到自己的手牌',
    four.every((c2) => (c2.last?.players.find((p) => p.id === c2.gamePlayerId)?.hand?.length ?? 0) > 0),
    four.map((c2) => c2.last?.players.find((p) => p.id === c2.gamePlayerId)?.hand?.length).join(','),
  );

  // 视角裁剪：别人的手牌必须是 null（不是空数组 —— 空数组说明服务端「裁剪成空」而不是「不下发」）
  for (const c2 of four) {
    const others = (c2.last?.players ?? []).filter((p) => p.id !== c2.gamePlayerId);
    const leaked = others.filter((p) => p.hand !== null);
    check(`${c2.name} 看不到另外 3 个人的手牌`, leaked.length === 0, leaked.map((p) => p.name).join(','));
  }

  const fourWinner = await playToEnd(four, 150_000);
  check('4 个真人的一局能正常打完', fourWinner !== null, '150 秒内未结束');
  for (const c2 of four) {
    check(`${c2.name} 在整局里至少被轮到过一次`, c2.turnStates > 0, c2.turnStates);
  }
  for (const c2 of four) c2.close();

  console.log('\n[16] 进出房间后资源回到基线（泄漏诊断）');

  // 服务端要连续跑几小时。sockets / session / lobbySockets 这几张表只增不减的话，
  // 症状是「跑了一下午才开始变慢」，几乎没法回溯 —— 所以在测试里直接钉住基线。
  // 先把自己这边的连接全部断干净，否则量到的是脚手架残留，不是服务端行为。
  closeAllClients();
  const base = await waitStats(
    (s) => s.connections === 0 && s.sessions === 0 && s.seatedSockets === 0 && s.lobbySockets === 0,
    10_000,
    '服务端回到完全空闲',
  );
  check(
    '空闲时没有任何残留会话',
    base.sessions === 0 && base.seatedSockets === 0 && base.lobbySockets === 0,
    JSON.stringify(base),
  );

  // 5 个房间 × 2 个真人：建房 → 加入 → 主动离开 → 断开
  const churn: Client[] = [];
  for (let i = 0; i < 5; i++) {
    const host = await connect(`临${i}`);
    host.send({ t: 'create', name: `临${i}` });
    await host.waitFor(() => Boolean(host.playerId), 3000, `临${i} 建房`);
    const guest = await connect(`游${i}`);
    guest.send({ t: 'join', room: host.room, name: `游${i}` });
    await guest.waitFor(() => Boolean(guest.playerId), 3000, `游${i} 加入`);
    churn.push(host, guest);
  }
  const peak = await stats();
  check('10 个连接都被记进指标', peak.connections >= 10, peak.connections);

  for (const cl of churn) cl.send({ t: 'leave' });
  for (const cl of churn) cl.close();

  // rooms 用 <= ：更早用例的房间可能在宽限期到点后被回收，数量只会变少
  const after = await waitStats(
    (s) =>
      s.rooms <= base.rooms &&
      s.connections === 0 &&
      s.sessions === 0 &&
      s.seatedSockets === 0 &&
      s.lobbySockets === 0,
    12_000,
    '房间与连接表回到基线',
  );
  check('房间数没有增长（空房都被回收）', after.rooms <= base.rooms, `${after.rooms} vs ${base.rooms}`);
  check('会话表清空（session 不泄漏）', after.sessions === 0, after.sessions);
  check('座位连接表清空（sockets 不泄漏）', after.seatedSockets === 0, after.seatedSockets);
  check('大厅连接表清空（lobbySockets 不泄漏）', after.lobbySockets === 0, after.lobbySockets);

  console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ''}`);
  if (failures.length) {
    console.error('失败项：');
    failures.forEach((f2) => console.error('  - ' + f2));
    process.exit(1);
  }
  console.log('联机全链路测试通过。');
  process.exit(0);
}

main().catch((err) => {
  console.error('✖ 联机测试异常：');
  console.error(err instanceof Error ? err.stack : err);
  // 直接 process.exit(1) 会把刚写进 stderr 的这段吞掉（Windows + tsx 下实测），
  // 结果只剩一个 exit=1、一个字都没有 —— 排错时最难受的那种。
  // 先让出 50ms 把日志刷出去，再退。
  setTimeout(() => process.exit(1), 50);
});

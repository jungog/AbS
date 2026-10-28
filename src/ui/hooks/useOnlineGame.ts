/**
 * 联机客户端层
 *
 * 这个 hook 承担三件事，都不是「一次请求一次响应」那么简单，所以按状态机写：
 *
 *  1. **连接与重连**：用一个「意图」（intent）记录「我本来要做什么」——
 *     看大厅 / 加入某房 / 凭 token 回座。断线后重放同一个意图即可，
 *     不需要在上层写任何重连逻辑。
 *  2. **心跳**：15 秒 ping 一次。40 秒没收到 pong 就主动断开重连 ——
 *     很多「卡住不动」的联机问题其实是 TCP 半开，浏览器不会触发 close。
 *  3. **倒计时**：deadlineAt 是服务端下发的绝对时间戳，客户端只做本地递减渲染。
 *     绝不用「本地计时器数到 0 就自己托管」—— 那会和真正的服务端判定错位。
 *
 * 另外「观战」不是第四种连接状态，而是同一个 joined 状态下的一个**角色**：
 * 观战者照样断线重连、照样收状态，只是没有座位、没有 token、拿不到手牌。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RedactedState } from '@core/redact';
import type { Command } from '@core/types';
import {
  clearSeat,
  DEFAULT_SEAT_GRACE_MS,
  lastRoom,
  loadSeat,
  saveSeat,
  type ClientMsg,
  type RoomSeat,
  type RoomSummary,
  type ServerMsg,
} from '@net/protocol';

export type OnlineStatus =
  /** 还没连过 */
  | 'idle'
  /** 正在建立连接（首次） */
  | 'connecting'
  /** 已连上、在看大厅 */
  | 'lobby'
  /** 已在房间里 */
  | 'joined'
  /** 连接断了，正在自动重连 */
  | 'reconnecting'
  /** 连不上（服务端没起 / 网络不通） */
  | 'error';

export interface OnlineGame {
  status: OnlineStatus;
  rooms: RoomSummary[];
  /** 我在这个房间里是玩家还是观众；没进房间为 null */
  role: 'player' | 'spectator' | null;
  playerId: string | null;
  /** 重连凭证（存在 localStorage，测试里也用得到） */
  token: string | null;
  /** 引擎内玩家 id，开局后才有；作为 redactState 的视角参数 */
  gamePlayerId: string | null;
  isHost: boolean;
  /** 房主座位对应的 playerId（房主转移时会变） */
  hostId: string | null;
  /** 房间是否在大厅公开 */
  isPublic: boolean;
  /** 房间是否有密码 */
  hasPassword: boolean;
  room: string;
  seats: RoomSeat[];
  /** 正在观战的人数（含自己） */
  spectators: number;
  /** 观战落后几轮。1 = 只能看到上一轮结束时的局面，0 = 实时 */
  spectatorDelayRounds: number;
  view: RedactedState | null;
  error: string | null;
  notice: string | null;
  started: boolean;
  /** 当前操作点截止时间（服务端时间轴），null = 无倒计时 */
  deadlineAt: number | null;
  /** 剩余毫秒（本地每 200ms 重算，只用于显示） */
  remainMs: number | null;
  /** 自己是否正被 AI 托管 */
  autopilot: boolean;
  /** 往返延迟（毫秒），来自 ping/pong */
  latency: number | null;
  /** 重连重试次数，0 表示连接正常 */
  retry: number;
  /** 结算页准备进度（只数在线真人） */
  ready: { count: number; total: number; offline: number };
  /**
   * 上一局已结束、房间还在等下一局。
   *
   * 这个状态下房间仍然 `started`，但新人可以加入 ——
   * 只靠 `started` 判断会把人挡在门外，也会让大厅把房间显示成「对局中」。
   */
  gameOver: boolean;
  /** 自己是否已点「再来一局」 */
  myReady: boolean;

  openLobby: () => void;
  createRoom: (name: string, opts?: { room?: string; isPublic?: boolean; password?: string }) => void;
  joinRoom: (room: string, name: string, password?: string) => void;
  /** 观战：不占座位，只看公开信息（有密码的房要一起给密码） */
  spectate: (room: string, password?: string) => void;
  startGame: (playerCount: number, bots: number) => void;
  send: (cmd: Command) => void;
  takeback: () => void;
  /** 再来一局：点一下准备，再点一下取消（全员准备好才真开） */
  rematch: () => void;
  /** 换座位：把 a、b 两个座位互换（非房主只能发起涉及自己座位的交换） */
  swapSeats: (a: number, b: number) => void;
  /** 房主调整下一局补几个机器人（只在两局之间有效） */
  setBots: (count: number) => void;
  leave: () => void;
  clearNotice: () => void;
  clearError: () => void;
}

/* ------------------------------------------------------------------ */
/* 连接地址                                                            */
/* ------------------------------------------------------------------ */

function resolveWsUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const explicit = env?.VITE_WS_URL;
  if (explicit) return explicit;
  if (typeof location === 'undefined') return 'ws://localhost:8787';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // 开发时 vite 在 5173/4173，服务端在 8787；生产走同源反代
  const isDev = location.port === '5173' || location.port === '4173';
  return `${proto}://${isDev ? `${location.hostname}:8787` : location.host}`;
}

const WS_URL = resolveWsUrl();

/**
 * 心跳间隔与判死阈值。
 *
 * 这两个数字要和服务端的托管超时（30 秒）对齐 —— 客户端必须在「被判超时」
 * 之前发现自己掉线，否则玩家会先被 AI 接管，然后才看到「正在重连」。
 * 5 秒一次 ping 的成本可以忽略（每分钟 12 条小消息），
 * 15 秒判死给三次丢包留了余量，又明显早于 30 秒。
 */
const PING_EVERY_MS = 5_000;
const PONG_TIMEOUT_MS = 15_000;
/** 重连退避：400ms 起，翻倍，封顶 5s，最多 8 次 */
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 5_000;
const RETRY_LIMIT = 8;

type Intent =
  | { kind: 'lobby' }
  | { kind: 'join'; room: string; name: string; password?: string }
  | { kind: 'resume'; room: string; token: string }
  | { kind: 'spectate'; room: string; password?: string };

export function useOnlineGame(): OnlineGame {
  const socketRef = useRef<WebSocket | null>(null);
  /** 「我本来要做什么」，断线后照着重放 */
  const intentRef = useRef<Intent | null>(null);
  /** 主动离开时置 true，避免 close 事件又触发重连 */
  const closingRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const lastPongRef = useRef(0);
  const pingSentAtRef = useRef(0);
  /** 还没连上时要补发的消息（建房 / 加入），连上后按序 flush */
  const pendingRef = useRef<ClientMsg[]>([]);
  /** 最近一次用的昵称，回座存档时一并记下 */
  const nameRef = useRef('');
  /** 观战用的房间密码：断线重连重放 spectate 时要一起带上 */
  const spectatePwRef = useRef<string | undefined>(undefined);
  /**
   * 当前这条连接是否已经「进房成功」。
   *
   * 用来区分两种长得很像的 `error`：
   *  - 还没进房就报错 → 回座失败（房间没了 / token 过期），该清存档回大厅
   *  - 进房之后报错   → 只是这条指令被拒（「还没轮到你」「操作太频繁了」），
   *                    对局要继续，绝不能因此把人踢回大厅
   *
   * 以前没有这个标记，所有 error 都按「回座失败」处理 —— 于是任何一次误点
   * 都会把人从对局里弹出去。`intentRef` 在进房后恒为 resume，靠它区分不了。
   */
  const joinedRef = useRef(false);

  const [status, setStatus] = useState<OnlineStatus>('idle');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [role, setRole] = useState<'player' | 'spectator' | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  /**
   * playerId 的镜像。
   *
   * 消息处理里必须用它而不是 state：`joined` 和紧随其后的 `room` 可能落在同一拍，
   * 那时 React 还没提交 playerId，闭包里读到的仍是 null —— 房主会被算成非房主。
   */
  const playerIdRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(true);
  const [hasPassword, setHasPassword] = useState(false);
  const [room, setRoom] = useState('');
  const [seats, setSeats] = useState<RoomSeat[]>([]);
  const [spectators, setSpectators] = useState(0);
  const [spectatorDelayRounds, setSpectatorDelayRounds] = useState(0);
  const [ready, setReady] = useState<{ count: number; total: number; offline: number }>({
    count: 0,
    total: 0,
    offline: 0,
  });
  const [gameOver, setGameOver] = useState(false);
  const [view, setView] = useState<RedactedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const [autopilot, setAutopilot] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  /* ---------------------------------------------------------------- */
  /* 清理定时器                                                        */
  /* ---------------------------------------------------------------- */

  const stopTimers = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* 发消息                                                            */
  /* ---------------------------------------------------------------- */

  const rawSend = useCallback((msg: ClientMsg) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  /* ---------------------------------------------------------------- */
  /* 处理服务端消息（用 ref 存，避免每次渲染重建 socket）              */
  /* ---------------------------------------------------------------- */

  playerIdRef.current = playerId;

  const handleRef = useRef<(msg: ServerMsg) => void>(() => undefined);

  handleRef.current = (msg: ServerMsg) => {
    switch (msg.t) {
      case 'lobby':
        setRooms(msg.rooms);
        // 没进房间时才把状态标成 lobby，否则从房间被弹回大厅会打断对局界面
        setStatus((s) => (s === 'joined' ? s : 'lobby'));
        break;

      case 'joined': {
        setPlayerId(msg.playerId);
        if (msg.host) setHostId(msg.playerId);
        setRoom(msg.room);
        setStatus('joined');
        setError(null);
        joinedRef.current = true;
        retryRef.current = 0;
        setRetry(0);

        if (msg.spectator) {
          setRole('spectator');
          setToken(null);
          // 观战者没有座位，断线后重放 spectate 即可 —— 绝不能写座位存档，
          // 否则刷新页面会拿一个空 token 去 resume，然后被服务端判定「座位已失效」
          intentRef.current = { kind: 'spectate', room: msg.room, password: spectatePwRef.current };
          setSpectatorDelayRounds(msg.spectatorDelayRounds ?? 0);
          // 这里**故意不弹 notice**。
          //
          // 原来写的是 `setNotice('已进入观战')`，但房间条里已经常驻一颗
          // 「观战中 · 只看公开信息 · 慢 N 轮」+「退出观战」，这句话是纯重复。
          // 代价不小：360×640 上这条横幅占 53px + 22px 外边距，还要手动点「知道了」
          // 才收回去 —— 而小屏正是最缺纵向空间的地方（日志区只有 62px）。
          //
          // 实测（360×640 观战首屏）：`.battle-main` 的 scrollHeight 669 → 594，
          // 少滚 75px；第 3 张座位卡从 386..540（正好贴着容器底边 540）上移到 311..465。
          // 注意**可视高度不变**（488 → 488）：`.battle-main` 是 `1fr` 网格行里的
          // 滚动容器，高度由网格决定，去掉内容只会让 scrollHeight 变小。
          //
          // 不改成「3 秒自动消失」：notice 是共用通道，里面混着「房间已关闭」
          // 这种必须常驻的提示，加定时器会误伤它们。对观众来说，
          // 页面直接切到对局界面 + 常驻 pill 已经是足够明确的反馈。
          break;
        }

        setRole('player');
        setToken(msg.token);
        // 之后的断线都用 token 回座，而不是重新占一个座位
        intentRef.current = { kind: 'resume', room: msg.room, token: msg.token };
        saveSeat({ room: msg.room, token: msg.token, name: nameRef.current, at: Date.now() });
        if (msg.resumed) setNotice('已回到原座位');
        break;
      }

      case 'room': {
        if (msg.closed) {
          setNotice('房间已关闭');
          setSeats([]);
          setView(null);
          setStarted(false);
          setSpectators(0);
          // 必须把 role 也清掉。
          //
          // BattlePage 的判定顺序是「inGame → spectator && !view → inRoom → 大厅」，
          // 那个「spectator && !view」是给「正在进入观战」用的过渡态。
          // 只把 status 切回 lobby、role 还留着 spectator 的话，view 已经被置空，
          // 于是条件成立 —— 观战者会**永远**停在「正在进入观战…」，大厅再也回不去。
          setRole(null);
          setStatus('lobby');
          clearSeat(msg.room);
          intentRef.current = { kind: 'lobby' };
          rawSend({ t: 'lobby' });
          break;
        }
        setSeats(msg.seats);
        setSpectators(msg.spectators ?? 0);
        setReady(msg.ready ?? { count: 0, total: 0, offline: 0 });
        setGameOver(Boolean(msg.gameOver));
        setStarted(msg.started);
        setHostId(msg.hostId || null);
        setIsPublic(msg.isPublic);
        setHasPassword(Boolean(msg.hasPassword));
        // 托管状态以服务端为准。这里用 ref 而不是 state：
        // joined 与紧随其后的 room 可能在同一拍到达，此时闭包里的 playerId 还是旧值（null）。
        const me = msg.seats.find((s) => s.playerId === playerIdRef.current);
        if (me) setAutopilot(me.autopilot);
        break;
      }

      case 'state':
        setView(msg.state);
        setDeadlineAt(msg.deadlineAt);
        setAutopilot(msg.autopilot);
        break;

      case 'error':
        // 只有「还没进房」的报错才是回座失败（房间没了 / 座位过期）。
        // 进房之后的 error 一律只是这条指令被拒 —— 误点一下不该被踢出对局。
        if (intentRef.current?.kind === 'resume' && !joinedRef.current) {
          const failedRoom = intentRef.current.room;
          clearSeat(failedRoom);
          intentRef.current = { kind: 'lobby' };
          setStatus('lobby');
          setNotice(msg.msg);
          rawSend({ t: 'lobby' });
        } else if (intentRef.current?.kind === 'spectate' && !joinedRef.current) {
          // 观战被拒（房间已回收 / 还没开始 / 观战位满）。
          //
          // `role` 是点「观战」那一刻**乐观**设成 spectator 的，服务端点头之前就设了。
          // 被拒之后不清掉的话，BattlePage 的「spectator && !view」过渡态会一直成立，
          // 界面永远停在「正在进入观战…」—— 和房间被回收那条是同一个坑。
          // 必须带 !joinedRef 护栏：已经在看的人误点一下只会收到普通报错，不能被踢回大厅。
          setRole(null);
          intentRef.current = { kind: 'lobby' };
          setStatus('lobby');
          setNotice(msg.msg);
          rawSend({ t: 'lobby' });
        } else {
          setError(msg.msg);
        }
        break;

      case 'restart':
        // 服务端要重启：座位还在，什么都不用做，等 onclose 触发重连即可。
        // 这里只负责把「不是你的错」这件事说清楚。
        setNotice(msg.msg);
        break;

      case 'pong':
        lastPongRef.current = Date.now();
        if (pingSentAtRef.current > 0) {
          setLatency(Date.now() - pingSentAtRef.current);
        }
        break;

      default:
        break;
    }
  };

  /* ---------------------------------------------------------------- */
  /* 建连接 + 重连                                                     */
  /* ---------------------------------------------------------------- */

  const openRef = useRef<() => void>(() => undefined);

  /**
   * 连接失效的唯一出口：onclose 和「心跳判死」都走这里。
   *
   * 为什么不能只靠 onclose：网络断开（拔网线 / 飞行模式 / 地铁进隧道）时，
   * 浏览器不会立刻触发 close —— 它会一直等着连接恢复，可能几分钟都不回调。
   * 这时候界面会「看着像卡住」，玩家完全不知道发生了什么。
   * 所以心跳判死之后必须自己把状态推进到「重连中」，而不是把希望寄托在事件上。
   */
  const downRef = useRef<(ws: WebSocket) => void>(() => undefined);

  downRef.current = (ws: WebSocket) => {
    if (socketRef.current !== ws) return;
    socketRef.current = null;
    // 这条连接已经死了，「已进房」的标记必须跟着失效，
    // 否则重连时若回座被拒，会被误判成「进房后的普通报错」而卡在重试里
    joinedRef.current = false;
    stopTimers();
    if (closingRef.current) return;
    if (!intentRef.current) return;

    if (retryRef.current >= RETRY_LIMIT) {
      setStatus('error');
      setError(`连接已断开，重连 ${RETRY_LIMIT} 次均失败。服务端是否在运行？（${WS_URL}）`);
      return;
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** retryRef.current, RETRY_MAX_MS);
    retryRef.current += 1;
    setRetry(retryRef.current);
    setStatus('reconnecting');
    retryTimerRef.current = window.setTimeout(() => openRef.current(), delay);
  };

  openRef.current = () => {
    stopTimers();
    closingRef.current = false;

    // 先摘引用再关旧连接：旧 socket 的 onclose 会因为 socketRef.current !== ws 直接返回，
    // 不会触发一次多余的重连
    const prev = socketRef.current;
    socketRef.current = null;
    joinedRef.current = false;
    if (prev) {
      try {
        prev.close();
      } catch {
        /* ignore */
      }
    }

    const intent = intentRef.current;
    if (!intent) return;

    setStatus((s) => (s === 'joined' || s === 'reconnecting' ? 'reconnecting' : 'connecting'));

    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      setStatus('error');
      setError(`无法连接服务端 ${WS_URL}`);
      return;
    }
    socketRef.current = ws;

    ws.onopen = () => {
      lastPongRef.current = Date.now();
      // 重放意图
      const it = intentRef.current;
      if (!it) return;
      if (it.kind === 'lobby') rawSend({ t: 'lobby' });
      else if (it.kind === 'join') rawSend({ t: 'join', room: it.room, name: it.name });
      else if (it.kind === 'spectate') rawSend({ t: 'spectate', room: it.room, password: it.password });
      else rawSend({ t: 'resume', room: it.room, token: it.token });

      // 连上前就排队的消息（比如「创建房间」）
      const queued = pendingRef.current;
      pendingRef.current = [];
      for (const m of queued) rawSend(m);

      // 心跳
      if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = window.setInterval(() => {
        if (Date.now() - lastPongRef.current > PONG_TIMEOUT_MS) {
          // 判死：先尝试关闭（能关就关），但重连流程自己推进，不等 onclose
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          downRef.current(ws);
          return;
        }
        pingSentAtRef.current = Date.now();
        rawSend({ t: 'ping' });
      }, PING_EVERY_MS);
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg | null = null;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') handleRef.current(msg);
    };

    ws.onerror = () => {
      // onclose 一定会紧跟着来，重连逻辑统一放那边
    };

    ws.onclose = () => downRef.current(ws);
  };

  /* ---------------------------------------------------------------- */
  /* 倒计时：只在有 deadline 时才跑定时器                                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (deadlineAt === null) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(t);
  }, [deadlineAt]);

  const remainMs = deadlineAt === null ? null : Math.max(0, deadlineAt - now);

  /* ---------------------------------------------------------------- */
  /* 挂载：有存档座位就自动回座（刷新页面不丢局）                       */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const rec = lastRoom();
    if (rec && Date.now() - rec.at < DEFAULT_SEAT_GRACE_MS) {
      intentRef.current = { kind: 'resume', room: rec.room, token: rec.token };
      setRoom(rec.room);
      setStatus('reconnecting');
      openRef.current();
    }
    return () => {
      closingRef.current = true;
      stopTimers();
      socketRef.current?.close();
      socketRef.current = null;
    };
    // 只跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------- */
  /* 对外动作                                                          */
  /* ---------------------------------------------------------------- */

  const openLobby = useCallback(() => {
    setError(null);
    setNotice(null);
    intentRef.current = { kind: 'lobby' };
    retryRef.current = 0;
    setRetry(0);
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      rawSend({ t: 'lobby' });
      setStatus('lobby');
      return;
    }
    openRef.current();
  }, [rawSend]);

  const createRoom = useCallback(
    (name: string, opts?: { room?: string; isPublic?: boolean; password?: string }) => {
      setError(null);
      setNotice(null);
      const payload: ClientMsg = {
        t: 'create',
        name: name.trim() || '玩家',
        room: opts?.room,
        isPublic: opts?.isPublic !== false,
        password: opts?.password?.trim() || undefined,
      };
      nameRef.current = String(payload.name);
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        rawSend(payload);
        return;
      }
      // 没连上：先排队，连上后由 onopen 补发
      intentRef.current = { kind: 'lobby' };
      retryRef.current = 0;
      setRetry(0);
      pendingRef.current = [payload];
      openRef.current();
    },
    [rawSend],
  );

  const joinRoom = useCallback(
    (roomCode: string, name: string, password?: string) => {
      const code = roomCode.trim().toUpperCase();
      if (!code) {
        setError('请填写房间号。');
        return;
      }
      setError(null);
      setNotice(null);
      const playerName = name.trim() || '玩家';
      const pw = password?.trim() || undefined;
      intentRef.current = { kind: 'join', room: code, name: playerName, password: pw };
      nameRef.current = playerName;
      retryRef.current = 0;
      setRetry(0);
      setRoom(code);

      // 已经连着（在看大厅）就直接发 join，省一次握手
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        rawSend({ t: 'join', room: code, name: playerName, password: pw });
        return;
      }
      openRef.current();
    },
    [],
  );

  const spectate = useCallback(
    (roomCode: string, password?: string) => {
      const code = roomCode.trim().toUpperCase();
      if (!code) {
        setError('请填写房间号。');
        return;
      }
      setError(null);
      setNotice(null);
      setRole('spectator');
      const pw = password?.trim() || undefined;
      spectatePwRef.current = pw;
      intentRef.current = { kind: 'spectate', room: code, password: pw };
      retryRef.current = 0;
      setRetry(0);
      setRoom(code);

      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        rawSend({ t: 'spectate', room: code, password: pw });
        return;
      }
      openRef.current();
    },
    [rawSend],
  );

  const startGame = useCallback(
    (playerCount: number, bots: number) => {
      rawSend({ t: 'start', playerCount, bots });
    },
    [rawSend],
  );

  const send = useCallback(
    (cmd: Command) => {
      rawSend({ t: 'command', cmd });
    },
    [rawSend],
  );

  const takeback = useCallback(() => {
    rawSend({ t: 'takeback' });
    setAutopilot(false);
    setNotice('已收回控制权');
  }, [rawSend]);

  const rematch = useCallback(() => {
    // 不传 ready：服务端按「切换」处理，同一个按钮点两下能反悔
    rawSend({ t: 'rematch' });
  }, [rawSend]);

  const swapSeats = useCallback(
    (a: number, b: number) => {
      rawSend({ t: 'swap', a, b });
    },
    [rawSend],
  );

  const setBots = useCallback(
    (count: number) => {
      rawSend({ t: 'bots', count });
    },
    [rawSend],
  );

  const leave = useCallback(() => {
    const cur = room || lastRoom()?.room;
    closingRef.current = true;
    // 先告诉服务端「我是主动走的」再断开。
    // 只靠 socket 关闭的话，服务端分不清「他走了」和「他 wifi 抖了一下」，
    // 只能按掉线处理 —— 座位会白占 5 分钟，下一次开局还多出一个 AI 空位。
    rawSend({ t: 'leave' });
    intentRef.current = null;
    stopTimers();
    socketRef.current?.close();
    socketRef.current = null;
    if (cur) clearSeat(cur);
    setStatus('idle');
    setRooms([]);
    setView(null);
    setSeats([]);
    setSpectators(0);
    setSpectatorDelayRounds(0);
    setReady({ count: 0, total: 0, offline: 0 });
    setGameOver(false);
    spectatePwRef.current = undefined;
    setPlayerId(null);
    setToken(null);
    setStarted(false);
    setHostId(null);
    setIsPublic(true);
    setHasPassword(false);
    setDeadlineAt(null);
    setAutopilot(false);
    setRoom('');
    setRole(null);
    setError(null);
    setNotice(null);
    setRetry(0);
    retryRef.current = 0;
  }, [room, stopTimers]);

  const myReady = useMemo(
    () => seats.find((s) => s.playerId === playerId)?.ready ?? false,
    [seats, playerId],
  );

  /**
   * 房主身份由 hostId 推导，不单独存一份状态。
   * 存两份的后果是它们会不一致 —— 房主转移、重连、同一拍到达的消息都能让它们分叉。
   */
  const isHost = useMemo(
    () => Boolean(hostId && playerId && hostId === playerId),
    [hostId, playerId],
  );

  const gamePlayerId = useMemo(
    () => seats.find((s) => s.playerId === playerId)?.gamePlayerId ?? null,
    [seats, playerId],
  );

  return {
    status,
    rooms,
    role,
    playerId,
    token,
    gamePlayerId,
    isHost,
    hostId,
    isPublic,
    hasPassword,
    room,
    seats,
    spectators,
    spectatorDelayRounds,
    view,
    error,
    notice,
    started,
    deadlineAt,
    remainMs,
    autopilot,
    latency,
    retry,
    ready,
    myReady,
    gameOver,
    openLobby,
    createRoom,
    joinRoom,
    spectate,
    startGame,
    send,
    takeback,
    rematch,
    swapSeats,
    setBots,
    leave,
    clearNotice: () => setNotice(null),
    clearError: () => setError(null),
  };
}

/** 供测试用：把地址暴露出来，避免测试里硬编码端口 */
export const __WS_URL = WS_URL;

/** 重连后是否还能回座（给 UI 判断「上次的房间」） */
export function previousSeat(room: string) {
  return loadSeat(room);
}

export type { Intent as OnlineIntent };

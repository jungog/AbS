/**
 * 客户端 / 服务端共享协议
 *
 * 设计要点：
 *  1. 服务端只下发「已按玩家裁剪」的状态（RedactedState），朝下情报的牌面永远不会出现在网络包里。
 *  2. 重连靠 resumeToken（不是昵称）：昵称会重名、会改，token 不会。
 *  3. 超时托管由服务端判定并下发 deadlineAt，客户端只负责显示倒计时 ——
 *     客户端算时间会被改系统时钟、切后台、网络延迟影响，一律以服务端为准。
 */
import type { Command } from '@core/types';
import type { RedactedState } from '@core/redact';

export const PROTOCOL_VERSION = 1;

/** 每个操作点的思考时间（毫秒）。服务端可被环境变量覆盖，测试里调小 */
export const DEFAULT_TURN_TIMEOUT_MS = 30_000;
/** 掉线后座位保留时长 */
export const DEFAULT_SEAT_GRACE_MS = 5 * 60_000;

export interface RoomSeat {
  /** 服务端会话 id */
  playerId: string;
  /** 引擎内的玩家 id（p0/p1/...），开局后才有 */
  gamePlayerId: string | null;
  name: string;
  seat: number;
  connected: boolean;
  isBot: boolean;
  /** 该座位当前由 AI 代打（掉线或超时托管） */
  autopilot: boolean;
  /**
   * 主动离开了（点了「离开」，不是掉线）。
   *
   * 和 `connected: false` 的区别是**会不会回来**：掉线只是连不上，5 分钟内随时能回原座；
   * 主动离开的人不会回来了。界面上必须分开说 ——
   * 把走了的人标成「掉线」，其他人会一直等他重连，还会以为他只是网络不好。
   */
  left?: boolean;
  /** 结算页点了「再来一局」 */
  ready: boolean;
}

/** 大厅里的一张房间卡片 */
export interface RoomSummary {
  id: string;
  players: number;
  capacity: number;
  /**
   * 真正连着的人（不含机器人、不含已离开、不含掉线但还在宽限期内待回来的）。
   *
   * 为什么和 `players` 分开：掉线有 5 分钟保座宽限期，这期间座位还在、
   * `players` 也还数着他 —— 但人已经不在屏幕前了。只报 `players` 的话，
   * 大厅会出现「2 / 7 人」而实际上一个人都没有的房间，点进去才发现是空的。
   */
  online: number;
  started: boolean;
  isPublic: boolean;
  hostName: string;
  /** 是否还能加入（未开局、或上一局已结束，且未满） */
  joinable: boolean;
  /** 上一局已结束：这时加入是「打下一局」，不是观战 */
  gameOver: boolean;
  /** 正在观战的人数（含自己） */
  spectators: number;
  /** 有密码的房间：大厅不显示密码，只标一个锁 */
  hasPassword: boolean;
}

export type ClientMsg =
  /** 拉一次大厅列表 */
  | { t: 'lobby' }
  /** 创建房间并直接坐进去；room 为空则自动分配房间号 */
  | { t: 'create'; name: string; room?: string; isPublic?: boolean; password?: string }
  | { t: 'join'; room: string; name: string; password?: string }
  /** 用上次拿到的 token 回到原座位 */
  | { t: 'resume'; room: string; token: string }
  /**
   * 观战：不占座位、不发指令，只收公开视角的状态。
   * 和 join 的区别是「我要看」而不是「我要玩」—— 所以开局后也能进。
   */
  | { t: 'spectate'; room: string; name?: string; password?: string }
  | { t: 'start'; playerCount: number; bots: number }
  | { t: 'command'; cmd: Command }
  /** 我回来了：取消托管，把控制权拿回来 */
  | { t: 'takeback' }
  /**
   * 再来一局：把自己的状态设成准备 / 取消准备（不传 ready 就是切换）。
   * 座位原样保留，全员准备好才真正开局。
   */
  | { t: 'rematch'; ready?: boolean }
  /**
   * 换座位：把 a、b 两个座位互换。
   *
   * 只在「还没开局」和「两局之间」有效 —— 座位顺序 = 行动顺序 = 情报传递方向，
   * 开局后再换等于改规则。非房主只能发起涉及自己座位的交换。
   */
  | { t: 'swap'; a: number; b: number }
  /** 房主调整下一局补几个机器人（只在两局之间有效） */
  | { t: 'bots'; count: number }
  /**
   * 主动离开（点「离开」按钮 / 退出观战）。
   *
   * 和「直接关掉 socket」必须区分开：服务端对掉线要给 5 分钟保座宽限期
   * （刷新页面、wifi 抖一下都不该丢座位），但主动离开是明确的意图 ——
   * 座位应该立刻摘掉，否则再来一局时剩下的人会凭空多一个 AI 空位。
   */
  | { t: 'leave' }
  | { t: 'ping' };

export type ServerMsg =
  | { t: 'lobby'; rooms: RoomSummary[] }
  | {
      t: 'joined';
      playerId: string;
      /** 重连凭证，客户端存 localStorage */
      token: string;
      seat: number;
      room: string;
      host: boolean;
      /** 是否是断线重连回来的 */
      resumed: boolean;
      /** 观战者：不占座位、没有 token、拿不到手牌 */
      spectator?: boolean;
      /**
       * 观战落后几轮。1 表示「你看到的是上一轮结束时的局面」，
       * 当前这一轮里发生的任何事你都看不到。0 / 缺省表示实时。
       */
      spectatorDelayRounds?: number;
    }
  | {
      t: 'room';
      room: string;
      seats: RoomSeat[];
      started: boolean;
      hostId: string;
      isPublic: boolean;
      /** 观战人数 */
      spectators?: number;
      /** 房间是否有密码（房间页显示用，密码本身永不下发） */
      hasPassword?: boolean;
      /**
       * 结算页的准备进度。
       *
       * `count` / `total` **只数在线真人**：掉线的人虽然按「自动准备」处理
       * （`allReady` 的规则），但算进进度条会让「2 / 2 已准备」和「游戏不开始」
       * 同时成立。掉线人数单独放在 `offline` 里，界面用一句话说明就行。
       */
      ready?: { count: number; total: number; offline: number };
      /**
       * 本局已结束。房间此时仍算「进行中」，但允许新人加入打下一局，
       * 所以 lobby 的 `joinable` 和这个字段要分开看。
       */
      gameOver?: boolean;
      /** 房间被销毁（超时回收 / 对局结束） */
      closed?: boolean;
    }
  | {
      t: 'state';
      state: RedactedState;
      /** 当前操作点的截止时间（毫秒时间戳）；null = 没有倒计时（机器人或已托管） */
      deadlineAt: number | null;
      /** 你自己是否处于托管中 */
      autopilot: boolean;
    }
  | { t: 'error'; msg: string }
  /**
   * 服务端要重启（优雅关闭 / 运维排水）。
   *
   * 刻意**不复用 `error`**：客户端把 `error` 当「这条指令被拒了」处理，
   * 而回座阶段的 error 语义是「座位没了，回大厅」。用同一个类型表示
   * 「服务器要重启，你的座位还在」会让所有在线玩家在发版时被踢回大厅。
   */
  | { t: 'restart'; msg: string }
  | { t: 'pong' };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 重连凭证的本地存储                                                   */
/* ------------------------------------------------------------------ */

const STORAGE_PREFIX = 'abs:seat:';

export interface StoredSeat {
  room: string;
  token: string;
  name: string;
  at: number;
}

function storage(): Storage | null {
  // 直接访问 localStorage 在某些环境会抛（隐私模式、沙箱 iframe、SSR），
  // 所以两处都试：全局，再退到 window 上挂的实例。
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* 继续尝试 window.localStorage */
  }
  try {
    const w = (globalThis as { window?: { localStorage?: Storage } }).window;
    if (w?.localStorage) return w.localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveSeat(rec: StoredSeat): void {
  try {
    storage()?.setItem(STORAGE_PREFIX + rec.room, JSON.stringify(rec));
  } catch {
    /* 隐私模式 / 配额满，忽略 */
  }
}

export function loadSeat(room: string): StoredSeat | null {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + room);
    if (!raw) return null;
    const rec = JSON.parse(raw) as StoredSeat;
    return rec && rec.room === room && rec.token ? rec : null;
  } catch {
    return null;
  }
}

export function clearSeat(room: string): void {
  try {
    storage()?.removeItem(STORAGE_PREFIX + room);
  } catch {
    /* ignore */
  }
}

/** 最近一次坐过的房间（刷新页面后优先尝试回这个房） */
export function lastRoom(): StoredSeat | null {
  const s = storage();
  if (!s) return null;
  let best: StoredSeat | null = null;
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k || !k.startsWith(STORAGE_PREFIX)) continue;
    try {
      const rec = JSON.parse(s.getItem(k) ?? '') as StoredSeat;
      if (rec?.token && (!best || rec.at > best.at)) best = rec;
    } catch {
      /* ignore */
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 邀请链接                                                            */
/* ------------------------------------------------------------------ */

const INVITE_PARAM = 'room';

/**
 * 取 `location` / `history`。
 *
 * 和 storage() 一样要两段式：裸全局在某些环境（SSR、沙箱 iframe）拿不到，
 * 但 `window.` 上挂着实例。只用裸全局的话会**静默失效** ——
 * 邀请参数清不掉，用户点「返回大厅」后刷新又被拉回同一个房间。
 */
function currentLocation(): Location | null {
  try {
    if (typeof location !== 'undefined') return location;
  } catch {
    /* 继续尝试 window.location */
  }
  try {
    const w = (globalThis as { window?: { location?: Location } }).window;
    if (w?.location) return w.location;
  } catch {
    /* ignore */
  }
  return null;
}

function currentHistory(): History | null {
  try {
    if (typeof history !== 'undefined') return history;
  } catch {
    /* 继续尝试 window.history */
  }
  try {
    const w = (globalThis as { window?: { history?: History } }).window;
    if (w?.history) return w.history;
  } catch {
    /* ignore */
  }
  return null;
}

function normalizeRoomCode(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/**
 * 从地址里取出邀请的房间号（`?room=ABCD`）。
 *
 * 用 query 参数而不是路径，是因为它是静态站点 —— 路径要配 history fallback，
 * 而 `?room=` 在任何静态托管上都能直接打开。
 */
export function inviteRoomFromUrl(search?: string): string | null {
  try {
    const q = search ?? currentLocation()?.search ?? '';
    const code = normalizeRoomCode(new URLSearchParams(q).get(INVITE_PARAM));
    return code || null;
  } catch {
    return null;
  }
}

/** 生成邀请链接：`https://host/path?room=ABCD` */
export function inviteLink(room: string, base?: string): string {
  const loc = currentLocation();
  const origin = base ?? (loc ? `${loc.origin}${loc.pathname}` : '');
  return `${origin}?${INVITE_PARAM}=${encodeURIComponent(room)}`;
}

/**
 * 消费掉地址栏里的邀请参数。
 *
 * 不清掉的话，用户点「返回大厅」刷新页面会又被自动拉回同一个房间，
 * 看起来像「退不出去」。
 */
export function clearInviteParam(): void {
  try {
    const loc = currentLocation();
    const hist = currentHistory();
    if (!loc || !hist) return;
    const url = new URL(loc.href);
    if (!url.searchParams.has(INVITE_PARAM)) return;
    url.searchParams.delete(INVITE_PARAM);
    hist.replaceState(null, '', url.toString());
  } catch {
    /* ignore */
  }
}

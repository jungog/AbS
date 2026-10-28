/**
 * 房间快照持久化
 *
 * 解决的问题很具体：服务端进程重启（发版、崩溃、机器重启）时，
 * 正在进行的一局会直接消失 —— 四个朋友正打到一半，全部掉回大厅，房间号也没了。
 *
 * 做法是「定期落盘 + 启动恢复」，不是数据库：
 *  - 只存房间骨架 + 引擎状态，不存连接、不存倒计时（那些本来就活不过进程）
 *  - 恢复出来的座位**一律算离线**，走正常的 5 分钟保座 + 重连 token 路径，
 *    不做任何「特殊恢复逻辑」—— 越特殊的分支越容易和正常路径不一致
 *  - 进行中的对局恢复后立刻交给 AI 托管，人回来点「我回来了」就交还
 *
 * 为什么不每次都写：
 * 一局里 AI 每 300ms 推一步，每次状态变化都落盘的话是纯磁盘噪音。
 * 用「标脏 + 2 秒巡检」，最多丢 2 秒的进度 —— 对回合制游戏来说完全够用。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnginePack, GameState } from '../src/core/types';

/** 快照格式版本。改了字段就必须 +1，老文件会被直接丢弃而不是猜着读 */
export const SNAPSHOT_VERSION = 2;

export interface SnapshotSeat {
  playerId: string;
  resumeToken: string;
  /** 引擎内玩家 id（p0/p1/...）。存下来是为了恢复时不必依赖「座位顺序 == players 顺序」这个隐式约定 */
  gamePlayerId: string | null;
  name: string;
  seat: number;
  isBot: boolean;
  /** 主动离开过（老快照没有这个字段，按 false 处理） */
  left?: boolean;
}

export interface SnapshotRoom {
  id: string;
  password: string | null;
  hostId: string;
  isPublic: boolean;
  createdAt: number;
  started: boolean;
  ready: string[];
  seats: SnapshotSeat[];
  state: GameState | null;
}

export interface Snapshot {
  v: number;
  savedAt: number;
  /** 卡池指纹：换了卡表/角色表之后，老快照里的牌 uid 可能已经对不上 */
  pack: string;
  rooms: SnapshotRoom[];
}

/**
 * 卡池指纹。
 *
 * 只取「牌 id 顺序 + 角色 id + 关键配置」，不取整份定义 ——
 * 改一句描述文案不该让所有存档失效，但改牌表顺序（= 牌堆顺序）必须失效。
 */
export function packFingerprint(pack: EnginePack): string {
  const h = createHash('sha1');
  h.update(pack.cards.map((c) => c.id).join(','));
  h.update('|');
  h.update(pack.characters.map((c) => c.id).join(','));
  h.update('|');
  h.update(
    [
      pack.config.handLimit,
      pack.config.startHand,
      pack.config.drawPerTurn,
      pack.config.winIntelCount,
      pack.config.agentWinIntelCount,
      pack.config.deathBlackCount,
    ].join(','),
  );
  return h.digest('hex').slice(0, 16);
}

const ROOM_ID = /^[A-Z0-9]{1,8}$/;

/** 粗校验：只要有一处不像我们写出去的东西，整份丢弃。宁可丢存档，不可带着脏数据启动 */
function validSnapshot(raw: unknown): raw is Snapshot {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Partial<Snapshot>;
  if (s.v !== SNAPSHOT_VERSION) return false;
  if (typeof s.pack !== 'string' || typeof s.savedAt !== 'number') return false;
  if (!Array.isArray(s.rooms)) return false;
  return s.rooms.every((r) => {
    if (!r || typeof r !== 'object') return false;
    const room = r as Partial<SnapshotRoom>;
    if (typeof room.id !== 'string' || !ROOM_ID.test(room.id)) return false;
    if (!Array.isArray(room.seats)) return false;
    if (!Array.isArray(room.ready)) return false;
    if (room.state !== null && (typeof room.state !== 'object' || !Array.isArray(room.state?.players))) {
      return false;
    }
    return room.seats.every(
      (x) =>
        x &&
        typeof x.playerId === 'string' &&
        typeof x.name === 'string' &&
        typeof x.seat === 'number' &&
        typeof x.isBot === 'boolean',
    );
  });
}

export interface SnapshotStoreOptions {
  /** 快照文件绝对路径 */
  file: string;
  /** 生成快照（只在真正要写的时候调用） */
  build: () => Snapshot;
  /** 巡检间隔，默认 2000ms */
  intervalMs?: number;
  /** 保存回调，用于日志 */
  onError?: (err: unknown) => void;
}

export class SnapshotStore {
  private readonly file: string;
  private readonly build: () => Snapshot;
  private readonly intervalMs: number;
  private readonly onError: (err: unknown) => void;

  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private writes = 0;

  constructor(opts: SnapshotStoreOptions) {
    this.file = opts.file;
    this.build = opts.build;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.onError = opts.onError ?? (() => {});
  }

  /** 标脏。任何会改变房间结构/对局状态的地方调用一次即可 */
  touch(): void {
    this.dirty = true;
  }

  get writeCount(): number {
    return this.writes;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // 不因为一个落盘定时器让进程无法退出
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.dirty) return;
    if (this.writing) return; // 上一次还没写完，这一轮跳过（下一轮会再来）
    this.dirty = false;
    this.writing = this.write();
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  /** 立即落盘。优雅关闭时调用 —— 那时没有「下一轮」了 */
  async flush(): Promise<void> {
    this.stop();
    if (this.writing) await this.writing.catch(() => {});
    this.dirty = false;
    await this.write();
  }

  private async write(): Promise<void> {
    let text: string;
    try {
      text = JSON.stringify(this.build());
    } catch (err) {
      this.onError(err);
      return;
    }
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      // 先写临时文件再改名：进程在写到一半被杀掉时，
      // 磁盘上留下的是一个残缺的 .tmp，而不是一份读不出来的 rooms.json
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, this.file);
      this.writes += 1;
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * 读取快照。任何异常都返回 null —— 启动阶段不该因为一个坏文件起不来。
   *
   * @param expectedPack 卡池指纹，不匹配则丢弃
   * @param maxAgeMs     超过这个时长的快照直接丢弃（默认 12 小时）
   */
  async load(expectedPack: string, maxAgeMs = 12 * 60 * 60_000): Promise<Snapshot | null> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return null; // 首次启动，正常
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.onError(new Error('快照不是合法 JSON，已忽略'));
      return null;
    }

    if (!validSnapshot(raw)) {
      this.onError(new Error('快照格式不匹配（版本或字段），已忽略'));
      return null;
    }
    if (raw.pack !== expectedPack) {
      this.onError(new Error('卡池已变化，旧快照不再适用，已忽略'));
      return null;
    }
    if (Date.now() - raw.savedAt > maxAgeMs) {
      this.onError(new Error('快照过期，已忽略'));
      return null;
    }
    return raw;
  }
}

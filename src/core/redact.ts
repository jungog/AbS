/**
 * 状态裁剪 —— 反作弊的关键一层
 *
 * 红线：朝下的密电内容，在接收成功之前，任何客户端都不得收到牌面数据。
 *
 * 这里有**三种**视角，别混：
 *  - `viewerId = 某个玩家 id`   → 玩家视角（自己的手牌 + 公开信息）
 *  - `viewerId = PUBLIC_VIEW`  → 观战视角（谁都手牌都看不到，身份也不公开）
 *  - `viewerId = null`         → 上帝视角（全公开），只在本地热座 / 复盘用，服务端绝不下发
 *
 * 观战为什么不能复用 `null`：`null` 是「全公开」，观战者一旦拿到它，
 * 等于每个观众都能看见所有人的手牌 —— 这不是观战，是作弊器。
 */
import { describeTask } from './tasks';
import type {
  CardInstance,
  EnginePack,
  GameState,
  IdentityKind,
  IntelColor,
  LogEntry,
  PassMethod,
  Phase,
  PlayerId,
  WinResult,
} from './types';

export interface RedactedIntel {
  uid: string;
  color: IntelColor;
  method: PassMethod;
  defName: string;
  encrypted: boolean;
}

export interface RedactedPlayer {
  id: PlayerId;
  seat: number;
  name: string;
  isBot: boolean;
  alive: boolean;
  /** null = 未知（未公开的身份） */
  identity: IdentityKind | null;
  characterId: string;
  characterName: string;
  /** 是否已完成选角 */
  characterPicked: boolean;
  characterHidden: boolean;
  skillText: string;
  taskText: string;
  handCount: number;
  /** null = 不可见（别人的手牌） */
  hand: CardInstance[] | null;
  intel: RedactedIntel[];
  counts: { red: number; blue: number; black: number };
}

export interface RedactedFlow {
  uid: string;
  /** null = 牌面朝下，内容未知 */
  color: IntelColor | null;
  method: PassMethod;
  source: PlayerId;
  current: PlayerId | null;
  step: 'passing' | 'arrive' | 'resolve';
  locked: boolean;
  skipped: PlayerId[];
  applied: { kind: string; by: PlayerId; target?: PlayerId }[];
  /** 剩余路径上还会经过谁（公开信息） */
  remainingPath: PlayerId[];
}

export interface RedactedWindow {
  kind: 'counter' | 'intercept';
  description: string;
  /** 截获窗口下：是否可见 */
  visibleColor: IntelColor | null;
  pendingKind: string | null;
}

export interface RedactedState {
  version: 1;
  seed: string | null;
  turnIndex: number;
  round: number;
  phase: Phase;
  pending:
    | {
        kind: 'pickCharacter' | 'action' | 'intelDeclare' | 'response' | 'receive' | 'discard' | 'gameOver';
        player: PlayerId | null;
        prompt: string;
        need?: number;
        /** 仅选角阶段：可选角色 id */
        options?: string[];
      }
    | null;
  players: RedactedPlayer[];
  deckCount: number;
  discardCount: number;
  flow: RedactedFlow | null;
  window: RedactedWindow | null;
  log: LogEntry[];
  winner: WinResult | null;
  stats: GameState['stats'];
  /** 当前视角玩家自己是否已出局 */
  viewerAlive: boolean;
}

/**
 * 观战视角的伪 viewerId。
 *
 * 用一个绝不可能是真实玩家 id 的字符串：`redactState` 里 `players.find(p => p.id === viewerId)`
 * 找不到人，于是 isSelf 全为 false、hand 全为 null、身份只在出局/结算后公开 —— 正好是
 * 「一个坐在场边、什么都不知道的旁观者」该看到的东西。
 */
export const PUBLIC_VIEW = '__public__';

/** 观战视角：只看公开信息 */
export function redactPublic(state: GameState, pack: EnginePack): RedactedState {
  return redactState(state, pack, PUBLIC_VIEW);
}

/**
 * @param viewerId 视角玩家；传 PUBLIC_VIEW 表示观战（只看公开信息），传 null 表示上帝视角
 */
export function redactState(state: GameState, pack: EnginePack, viewerId: PlayerId | null): RedactedState {
  const godMode = viewerId === null;
  const viewer = viewerId ? state.players.find((p) => p.id === viewerId) : undefined;
  const gameOver = state.winner !== null;

  const players: RedactedPlayer[] = state.players.map((p) => {
    const charDef = pack.characterById.get(p.characterId);
    const isSelf = viewerId === p.id;
    const identityVisible = godMode || isSelf || !p.alive || gameOver;

    const intel: RedactedIntel[] = p.intel.map((s) => {
      const def = pack.cardById.get(s.defId);
      return {
        uid: s.uid,
        color: s.color,
        method: s.method,
        defName: def?.name ?? s.defId,
        encrypted: Boolean(s.encrypted),
      };
    });

    return {
      id: p.id,
      seat: p.seat,
      name: p.name,
      isBot: p.isBot,
      alive: p.alive,
      identity: identityVisible ? p.identity : null,
      characterId: p.characterId,
      characterName: p.characterPicked ? (charDef?.name ?? p.characterId) : '待选角色',
      characterPicked: p.characterPicked,
      characterHidden: p.characterHidden,
      skillText: p.characterPicked ? (charDef?.skillText ?? '') : '',
      taskText: p.characterPicked ? describeTask(charDef?.task ?? null) : '',
      handCount: p.hand.length,
      hand: isSelf || godMode ? p.hand.map((c) => ({ ...c })) : null,
      intel,
      counts: {
        red: intel.filter((s) => s.color === 'red').length,
        blue: intel.filter((s) => s.color === 'blue').length,
        black: intel.filter((s) => s.color === 'black').length,
      },
    };
  });

  let flow: RedactedFlow | null = null;
  if (state.flow) {
    const f = state.flow;
    const def = pack.cardById.get(f.defId);
    const revealColor =
      godMode || f.method === 'text' || f.source === viewerId || (viewerId ? f.decodedBy.includes(viewerId) : false);
    flow = {
      uid: f.uid,
      color: revealColor ? f.color : null,
      method: f.method,
      source: f.source,
      current: f.current,
      step: f.step,
      locked: f.locked,
      skipped: [...f.skipped],
      applied: f.applied.map((a) => ({ kind: a.kind, by: a.by, target: a.target })),
      remainingPath: [...f.path],
    };
    void def;
  }

  let window: RedactedWindow | null = null;
  if (state.window) {
    const w = state.window;
    window =
      w.ctx.kind === 'counter'
        ? { kind: 'counter', description: w.ctx.description, visibleColor: null, pendingKind: w.ctx.pending.kind }
        : {
            kind: 'intercept',
            description: '有情报正在传递',
            visibleColor: w.ctx.visible ? w.ctx.color : null,
            pendingKind: null,
          };
  }

  const pending: RedactedState['pending'] = state.pending
    ? {
        kind: state.pending.kind,
        player: state.pending.kind === 'gameOver' ? null : state.pending.player,
        prompt: state.pending.prompt,
        need: state.pending.kind === 'discard' ? state.pending.need : undefined,
        options: state.pending.kind === 'pickCharacter' ? [...state.pending.options] : undefined,
      }
    : null;

  const log = state.log.filter((e) => godMode || !e.secretTo || e.secretTo === viewerId);

  return {
    version: 1,
    seed: godMode || gameOver ? state.seed : null,
    turnIndex: state.turnIndex,
    round: state.round,
    phase: state.phase,
    pending,
    players,
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    flow,
    window,
    log,
    winner: state.winner,
    stats: state.stats,
    viewerAlive: viewer ? viewer.alive : true,
  };
}

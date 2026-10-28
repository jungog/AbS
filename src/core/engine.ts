/**
 * 核心战斗模块 —— 规则引擎
 *
 * 设计原则：
 *  1. 纯 TS，不依赖 React / DOM / Node API，浏览器与服务端跑同一份代码。
 *  2. 状态是纯数据，可用 structuredClone 快照 —— 重连、复盘、AI 推演都靠这个。
 *  3. 单一入口 applyCommand(state, cmd)，所有合法性校验都在这里，UI 不做规则判断。
 *  4. pending 由 refreshPending() 从状态推导，不做手工维护，避免状态漂移。
 *
 * v1 已知简化（详见 README）：
 *  - 角色不抽 3 选 1，直接随机分配
 *  - 机密任务只展示不自动判定，特工 v1 只有「6 张真情报」一条胜利路径
 *  - 【破译】不开放识破响应窗口（纯信息效果，不影响场面）
 */
import type {
  ApplyResult,
  CardDef,
  CardInstance,
  CardUid,
  Command,
  EnginePack,
  FunctionKind,
  GameState,
  IntelSlot,
  PassMethod,
  PendingFunction,
  PlayerId,
  PlayerState,
  ResponseWindow,
} from './types';
import { randomSeed, shuffle } from './rng';
import { getSkill, type SkillCtx } from './skills';
import { describeTask, isTaskDone } from './tasks';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const FN_LABEL: Record<FunctionKind, string> = {
  lock: '锁定',
  lure: '调虎离山',
  return: '退回',
  intercept: '截获',
  decode: '破译',
  counter: '识破',
  burn: '烧毁',
  probe: '试探',
  shuffle: '真伪莫辨',
};

const METHOD_LABEL: Record<PassMethod, string> = {
  cipher: '密电',
  text: '文本',
  direct: '直达',
};

const COLOR_LABEL = { red: '红', blue: '蓝', black: '黑' } as const;

/** 出牌阶段可主动使用的功能牌 */
const ACTION_PHASE_FUNCTIONS: FunctionKind[] = ['burn', 'shuffle', 'probe'];
/** 接收决策时可用的功能牌 */
const RECEIVE_FUNCTIONS: FunctionKind[] = ['decode', 'return'];
/** 会影响场面的功能牌（需要经过识破窗口） */
const BOARD_FUNCTIONS: FunctionKind[] = ['lock', 'lure', 'return', 'intercept', 'burn', 'shuffle'];

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function clone(state: GameState): GameState {
  return structuredClone(state);
}

function alivePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => p.alive);
}

function byId(state: GameState, id: PlayerId): PlayerState | undefined {
  return state.players.find((p) => p.id === id);
}

function mustById(state: GameState, id: PlayerId): PlayerState {
  const p = byId(state, id);
  if (!p) throw new Error(`玩家不存在：${id}`);
  return p;
}

/** 从 startId 之后开始，按座位顺序（逆时针）返回存活玩家，不含 startId 本人 */
function aliveAfter(state: GameState, startId: PlayerId): PlayerId[] {
  const n = state.players.length;
  const start = byId(state, startId);
  const startSeat = start ? start.seat : 0;
  const out: PlayerId[] = [];
  for (let i = 1; i <= n; i++) {
    const p = state.players[(startSeat + i) % n]!;
    if (p.alive) out.push(p.id);
  }
  return out;
}

function log(
  state: GameState,
  text: string,
  opts?: { secretTo?: PlayerId; tone?: 'normal' | 'good' | 'bad' | 'warn' },
): void {
  state.logSeq += 1;
  state.log.push({ seq: state.logSeq, text, ...opts });
}

/**
 * 往对局日志里写一条**非规则事件**（目前只有「某人离开对局」）。
 *
 * 为什么走引擎的日志而不是在界面上弹个 toast：日志会跟着快照一起持久化，
 * 刷新、重连、服务端重启之后都还在。走 toast 的话，中途重连的人永远不知道
 * 某个座位为什么突然变成 AI 在打。
 *
 * 只有服务端会调它 —— 引擎自己不会产生这类日志（规则里没有「玩家离开」这个概念）。
 */
export function appendSystemLog(
  state: GameState,
  text: string,
  tone: 'normal' | 'good' | 'bad' | 'warn' = 'warn',
): void {
  log(state, text, { tone });
}

function defOf(pack: EnginePack, card: CardInstance): CardDef {
  const def = pack.cardById.get(card.defId);
  if (!def) throw new Error(`卡牌定义缺失：${card.defId}`);
  return def;
}

/* ------------------------------------------------------------------ */
/* 抽牌 / 洗牌                                                          */
/* ------------------------------------------------------------------ */

function reshuffleIfNeeded(state: GameState): void {
  if (state.deck.length > 0) return;
  if (state.discard.length === 0) return;
  const r = shuffle(state.discard, state.rngCursor, state.seed);
  state.deck = r.result;
  state.rngCursor = r.cursor;
  state.discard = [];
  log(state, '牌库已空，弃牌堆洗回成为新的牌库。', { tone: 'warn' });
}

function drawCards(state: GameState, pid: PlayerId, n: number): void {
  const p = mustById(state, pid);
  for (let i = 0; i < n; i++) {
    reshuffleIfNeeded(state);
    const card = state.deck.shift();
    if (!card) {
      log(state, `${p.name} 需要抽牌，但牌库与弃牌堆都已耗尽。`, { tone: 'warn' });
      return;
    }
    p.hand.push(card);
  }
}

/* ------------------------------------------------------------------ */
/* 技能上下文                                                          */
/* ------------------------------------------------------------------ */

function makeSkillCtx(state: GameState, pack: EnginePack, self: PlayerId): SkillCtx {
  return {
    state,
    self,
    draw: (pid, n) => drawCards(state, pid, n),
    log: (text, opts) => log(state, text, opts),
    peekTop: (n) => {
      const out: string[] = [];
      for (let i = 0; i < n && i < state.deck.length; i++) {
        const card = state.deck[i]!;
        const def = pack.cardById.get(card.defId);
        out.push(def ? `${def.name}·${COLOR_LABEL[def.color]}` : card.defId);
      }
      return out;
    },
    charName: (pid) => {
      const p = byId(state, pid);
      if (!p) return '';
      return pack.characterById.get(p.characterId)?.name ?? p.name;
    },
  };
}

function fireHook(
  state: GameState,
  pack: EnginePack,
  pid: PlayerId,
  hook: 'onTurnStart' | 'onDecode' | 'onIntelReturn' | 'onIntercepted',
): void {
  const p = byId(state, pid);
  if (!p || !p.alive) return;
  const skill = getSkill(pack.characterById.get(p.characterId)?.skillId);
  const fn = skill?.[hook];
  if (fn) fn(makeSkillCtx(state, pack, pid));
}

function handLimitOf(state: GameState, pack: EnginePack, pid: PlayerId): number {
  const p = byId(state, pid);
  let limit = pack.config.handLimit;
  if (!p) return limit;
  const skill = getSkill(pack.characterById.get(p.characterId)?.skillId);
  if (skill?.handLimitBonus) limit += skill.handLimitBonus(makeSkillCtx(state, pack, pid));
  return limit;
}

/* ------------------------------------------------------------------ */
/* 创建对局                                                            */
/* ------------------------------------------------------------------ */

export interface CreateOptions {
  pack: EnginePack;
  players: { name: string; isBot?: boolean }[];
  seed?: string;
  /**
   * 跳过选角：每人直接拿候选里的第一个。
   * 给测试脚本和「快速开局」用，正常对局不要开。
   */
  skipSetup?: boolean;
}

export function createGame(opts: CreateOptions): GameState {
  const { pack, players } = opts;
  const seed = opts.seed ?? randomSeed();
  const n = players.length;

  const seatCfg = pack.config.seats[String(n)];
  if (!seatCfg) throw new Error(`没有 ${n} 人局的身份配置，请检查 gameConfig.seats`);

  // 1. 身份牌池
  const identityPool = [
    ...Array.from({ length: seatCfg.red }, () => 'red' as const),
    ...Array.from({ length: seatCfg.blue }, () => 'blue' as const),
    ...Array.from({ length: seatCfg.agent }, () => 'agent' as const),
  ];
  const idShuffle = shuffle(identityPool, 0, seed);

  // 2. 牌库
  const deckCards: CardInstance[] = [];
  let uidSeq = 0;
  for (const def of pack.cards) {
    deckCards.push({ uid: `u${String(++uidSeq).padStart(3, '0')}`, defId: def.id });
  }
  const deckShuffle = shuffle(deckCards, idShuffle.cursor, seed);

  // 3. 角色池（每个玩家抽 3 个候选，v1 直接取第一个）
  const charIds = pack.characters.map((c) => c.id);
  const charShuffle = shuffle(charIds, deckShuffle.cursor, seed);

  const state: GameState = {
    version: 1,
    seed,
    rngCursor: charShuffle.cursor,
    players: [],
    turnIndex: 0,
    round: 1,
    phase: 'setup',
    pending: null,
    deck: deckShuffle.result,
    discard: [],
    flow: null,
    window: null,
    log: [],
    logSeq: 0,
    winner: null,
    stats: { intelPlaced: 0, deaths: 0, intercepted: 0, counters: 0 },
  };

  for (let i = 0; i < n; i++) {
    const choices: string[] = [];
    for (let k = 0; k < 3; k++) {
      choices.push(charShuffle.result[(i * 3 + k) % charShuffle.result.length]!);
    }
    const characterId = choices[0]!;
    const charDef = pack.characterById.get(characterId);
    state.players.push({
      id: `p${i}`,
      seat: i,
      name: players[i]!.name,
      isBot: players[i]!.isBot ?? false,
      identity: idShuffle.result[i]!,
      characterId,
      characterHidden: charDef?.hidden ?? false,
      characterPicked: false,
      alive: true,
      hand: [],
      intel: [],
      usedOnce: {},
      characterChoices: choices,
    });
  }

  // 日志里**不能写种子**：日志是广播文本，每个玩家和观战者都能看到，
  // 而「种子 + 引擎」等于「牌堆顺序」—— 拿着它就能算出朝下的牌是什么。
  // 种子本身存在 state.seed 里，redactState 只对上帝视角 / 结算后放行。
  log(state, `对局开始（${n} 人局）。`);

  // 4. 发起始手牌
  for (const p of state.players) {
    drawCards(state, p.id, pack.config.startHand);
  }

  // 5. 选角阶段：每人从 3 个候选里挑 1 个，全部选完才开始第一回合
  if (opts.skipSetup) {
    for (const p of state.players) {
      p.characterId = p.characterChoices[0]!;
      p.characterHidden = pack.characterById.get(p.characterId)?.hidden ?? false;
      p.characterPicked = true;
    }
    state.phase = 'action';
    beginTurn(state, pack);
    return state;
  }

  refreshPending(state, pack);
  return state;
}

/* ------------------------------------------------------------------ */
/* 回合                                                                */
/* ------------------------------------------------------------------ */

function beginTurn(state: GameState, pack: EnginePack): void {
  const cur = state.players[state.turnIndex]!;
  if (!cur.alive) {
    advanceTurn(state, pack);
    return;
  }
  log(state, `—— 第 ${state.round} 轮 · ${cur.name} 的回合 ——`);
  fireHook(state, pack, cur.id, 'onTurnStart');
  drawCards(state, cur.id, pack.config.drawPerTurn);
  state.phase = 'action';
  refreshPending(state, pack);
}

function advanceTurn(state: GameState, pack: EnginePack): void {
  const n = state.players.length;
  let idx = state.turnIndex;
  for (let i = 0; i < n; i++) {
    idx = (idx + 1) % n;
    if (idx === 0) state.round += 1;
    if (state.players[idx]!.alive) break;
  }
  state.turnIndex = idx;
  beginTurn(state, pack);
}

function endTurn(state: GameState, pack: EnginePack): void {
  advanceTurn(state, pack);
}

/* ------------------------------------------------------------------ */
/* pending 推导                                                        */
/* ------------------------------------------------------------------ */

function currentPlayer(state: GameState): PlayerState {
  return state.players[state.turnIndex]!;
}

function refreshPending(state: GameState, pack: EnginePack): void {
  for (let guard = 0; guard < 100; guard++) {
    // 每次状态变化都重新判定：特工任务优先于阵营胜利
    checkSecretTasks(state, pack);
    if (!state.winner) checkWin(state, pack);

    if (state.winner) {
      state.phase = 'gameOver';
      state.pending = { kind: 'gameOver', prompt: state.winner.reason };
      return;
    }

    // 0. 选角阶段
    if (state.phase === 'setup') {
      const picker = state.players.find((p) => p.alive && !p.characterPicked);
      if (picker) {
        state.pending = {
          kind: 'pickCharacter',
          player: picker.id,
          options: availableCharacters(state, picker),
          prompt: '从 3 个候选角色里选 1 个。',
        };
        return;
      }
      // 全部选完，正式开打
      state.phase = 'action';
      beginTurn(state, pack);
      return;
    }

    // 1. 响应窗口优先
    if (state.window) {
      const w = state.window;
      let next = w.queue.find((id) => !w.passed.includes(id) && byId(state, id)?.alive);
      // 手里没有对应牌的人直接算「已放弃」，不弹窗。
      // 这样队列空了就自然走 closeWindow（效果生效），不需要额外的分支。
      while (next && !canRespond(state, pack, next, w.ctx.kind)) {
        w.passed.push(next);
        next = w.queue.find((id) => !w.passed.includes(id) && byId(state, id)?.alive);
      }
      if (next) {
        state.pending = { kind: 'response', player: next, prompt: windowPrompt(w) };
        return;
      }
      closeWindow(state, pack);
      continue;
    }

    // 2. 情报流程
    if (state.flow) {
      const f = state.flow;

      if (f.step === 'passing') {
        const current = f.current;
        const candidates = (current ? aliveAfter(state, current) : aliveAfter(state, f.source)).filter(
          (id) => id !== f.source && id !== current && !f.askedIntercept.includes(id),
        );
        if (candidates.length > 0) {
          openInterceptWindow(state, candidates);
          continue;
        }
        f.step = 'arrive';
        continue;
      }

      if (f.step === 'arrive') {
        const cur = f.current;
        if (!cur) {
          f.step = 'resolve';
          continue;
        }
        // 传回出牌者：不得拒收，直接落位
        if (cur === f.source) {
          resolveIntel(state, pack, f.source);
          continue;
        }
        state.pending = {
          kind: 'receive',
          player: cur,
          prompt: f.locked
            ? '这张情报已被【锁定】，你必须收下。'
            : '是否接收这张情报？可使用【破译】查看内容，或用【退回】退回。',
        };
        return;
      }

      // resolve 步骤由 resolveIntel 直接处理，不应停留
      f.step = 'arrive';
      continue;
    }

    // 3. 按阶段
    if (state.phase === 'action') {
      const p = currentPlayer(state);
      state.pending = {
        kind: 'action',
        player: p.id,
        prompt: '出牌阶段：可打出功能牌，或结束出牌进入情报阶段。',
      };
      return;
    }

    if (state.phase === 'intel') {
      const p = currentPlayer(state);
      // 规则：手牌为空时，从牌库顶抽 1 张直接当作情报传出，避免回合卡死
      if (p.hand.length === 0) {
        reshuffleIfNeeded(state);
        const card = state.deck.shift();
        if (!card) {
          log(state, `${p.name} 无牌可传，且牌库已空。`, { tone: 'warn' });
          state.phase = 'discard';
          continue;
        }
        log(state, `${p.name} 手牌为空，从牌库顶抽 1 张当作情报传出。`);
        p.hand.push(card);
      }
      state.pending = {
        kind: 'intelDeclare',
        player: p.id,
        prompt: '情报阶段：必须传出一张情报。',
      };
      return;
    }

    if (state.phase === 'discard') {
      const p = currentPlayer(state);
      const limit = handLimitOf(state, pack, p.id);
      const need = p.hand.length - limit;
      if (need > 0) {
        state.pending = {
          kind: 'discard',
          player: p.id,
          need,
          prompt: `手牌 ${p.hand.length} 张，上限 ${limit} 张，请弃掉 ${need} 张。`,
        };
        return;
      }
      endTurn(state, pack);
      continue;
    }

    throw new Error(`refreshPending 无法处理的状态：phase=${state.phase}`);
  }
  throw new Error('refreshPending 未能收敛，可能存在死循环');
}

/** 该响应窗口需要哪种牌 */
function responseKindNeeds(kind: 'counter' | 'intercept'): FunctionKind {
  return kind === 'counter' ? 'counter' : 'intercept';
}

/**
 * 这个玩家手里有没有能用于该响应窗口的牌。
 *
 * 没有就不该弹窗：弹出来只有「放弃响应」一个选项，玩家点了等于没点，
 * 还会以为自己漏看了什么牌。这种情况在「手里没有截获」时几乎每回合都会发生。
 */
function canRespond(state: GameState, pack: EnginePack, pid: PlayerId, kind: 'counter' | 'intercept'): boolean {
  const p = byId(state, pid);
  if (!p || !p.alive) return false;
  const need = responseKindNeeds(kind);
  return p.hand.some((c) => pack.cardById.get(c.defId)?.fn === need);
}

function windowPrompt(w: ResponseWindow): string {
  if (w.ctx.kind === 'counter') {
    return `${w.ctx.description} —— 是否使用【识破】抵销？`;
  }
  return '有情报正在传递 —— 是否使用【截获】拿走它？';
}

/* ------------------------------------------------------------------ */
/* 响应窗口                                                            */
/* ------------------------------------------------------------------ */

function openCounterWindow(
  state: GameState,
  pack: EnginePack,
  pending: PendingFunction,
  description: string,
  counterCount = 0,
  depth = 0,
): void {
  const queue = aliveAfter(state, pending.by);
  state.window = {
    id: `w${state.logSeq + 1}`,
    ctx: { kind: 'counter', pending, description, counterCount },
    queue,
    passed: [],
    depth,
  };
  void pack;
}

function openInterceptWindow(state: GameState, candidates: PlayerId[]): void {
  const f = state.flow!;
  f.askedIntercept.push(...candidates);
  state.window = {
    id: `w${state.logSeq + 1}`,
    ctx: {
      kind: 'intercept',
      cardUid: f.uid,
      visible: f.method === 'text',
      color: f.method === 'text' ? f.color : null,
      from: f.source,
      current: f.current,
    },
    queue: candidates,
    passed: [],
    depth: 0,
  };
}

function closeWindow(state: GameState, pack: EnginePack): void {
  const w = state.window;
  state.window = null;
  if (!w) return;

  if (w.ctx.kind === 'counter') {
    const { pending, counterCount } = w.ctx;
    if (counterCount % 2 === 1) {
      state.stats.counters += 1;
      log(state, `【${FN_LABEL[pending.kind]}】被【识破】抵销，效果失效。`, { tone: 'bad' });
      return;
    }
    applyFunction(state, pack, pending);
  }
}

/* ------------------------------------------------------------------ */
/* 功能牌生效                                                          */
/* ------------------------------------------------------------------ */

function applyFunction(state: GameState, pack: EnginePack, fn: PendingFunction): void {
  const f = state.flow;
  switch (fn.kind) {
    case 'lock': {
      if (f) {
        f.locked = true;
        f.applied.push({ kind: 'lock', by: fn.by, target: fn.target });
      }
      log(state, `【锁定】生效：本次情报接收者不可拒收。`, { tone: 'warn' });
      return;
    }
    case 'lure': {
      if (f && fn.target) {
        f.skipped.push(fn.target);
        f.applied.push({ kind: 'lure', by: fn.by, target: fn.target });
        log(state, `【调虎离山】生效：${mustById(state, fn.target).name} 在本次传递中被跳过。`, {
          tone: 'warn',
        });
        if (f.current === fn.target) advanceStop(state);
      }
      return;
    }
    case 'return': {
      if (f && f.current) {
        log(state, `【退回】生效：情报被退回给 ${mustById(state, f.source).name}。`, { tone: 'warn' });
        f.applied.push({ kind: 'return', by: fn.by });
        resolveIntel(state, pack, f.source);
      }
      return;
    }
    case 'intercept': {
      const card = f ? { uid: f.uid, defId: f.defId } : null;
      if (f && card) {
        const p = mustById(state, fn.by);
        p.hand.push(card);
        state.stats.intercepted += 1;
        log(state, `【截获】生效：${p.name} 拿走了传递中的情报（已入其手牌）。`, { tone: 'bad' });
        const sourceId = f.source;
        state.flow = null;
        state.window = null;
        fireHook(state, pack, sourceId, 'onIntercepted');
        state.phase = 'discard';
        // 不在这里 refreshPending：closeWindow 之后外层循环会继续推进
      }
      return;
    }
    case 'burn': {
      const target = fn.target ? mustById(state, fn.target) : null;
      if (target) {
        const idx = target.intel.findIndex((s) => s.color === 'black' && !s.encrypted);
        if (idx >= 0) {
          const [slot] = target.intel.splice(idx, 1);
          if (slot) state.discard.push({ uid: slot.uid, defId: slot.defId });
          log(state, `【烧毁】生效：${target.name} 面前的 1 张黑色情报被弃置。`, { tone: 'good' });
        }
      }
      return;
    }
    case 'shuffle': {
      const alive = alivePlayers(state);
      const drawn: CardInstance[] = [];
      for (let i = 0; i < alive.length; i++) {
        reshuffleIfNeeded(state);
        const c = state.deck.shift();
        if (c) drawn.push(c);
      }
      const r = shuffle(drawn, state.rngCursor, state.seed);
      state.rngCursor = r.cursor;
      alive.forEach((p, i) => {
        const card = r.result[i];
        if (!card) return;
        const def = pack.cardById.get(card.defId);
        if (!def) return;
        p.intel.push({ uid: card.uid, defId: card.defId, color: def.color, method: def.method });
        state.stats.intelPlaced += 1;
        log(state, `【真伪莫辨】：${p.name} 被发到 1 张情报（${COLOR_LABEL[def.color]}）。`, {
          tone: 'warn',
        });
      });
      return;
    }
    case 'decode':
      return;
    case 'counter':
      return;
    case 'probe': {
      // v1 自制规则：指定一名玩家，得知其手牌中「黑色（假情报）」的数量。
      // 结果只写进自己的密文日志，其他人看不到。
      const target = fn.target ? mustById(state, fn.target) : null;
      if (target) {
        let black = 0;
        for (const c of target.hand) {
          if (pack.cardById.get(c.defId)?.color === 'black') black += 1;
        }
        log(
          state,
          `【试探】${target.name} 手牌 ${target.hand.length} 张，其中黑色（假情报）${black} 张。`,
          { secretTo: fn.by, tone: 'warn' },
        );
      }
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 情报流程                                                            */
/* ------------------------------------------------------------------ */

function startIntelFlow(
  state: GameState,
  pack: EnginePack,
  sourceId: PlayerId,
  cardUid: CardUid,
  method: PassMethod,
  targetId?: PlayerId,
): string | null {
  const src = mustById(state, sourceId);
  const idx = src.hand.findIndex((c) => c.uid === cardUid);
  if (idx < 0) return '这张牌不在你的手牌中。';
  const card = src.hand[idx]!;
  const def = defOf(pack, card);

  // 技能强制传递方式
  const skill = getSkill(pack.characterById.get(src.characterId)?.skillId);
  const forced = skill?.forceMethod?.(makeSkillCtx(state, pack, sourceId), def);
  const finalMethod: PassMethod = forced ?? method ?? def.method;

  if (finalMethod === 'direct' && !targetId) return '选择【直达】时必须指定一名接收者。';
  if (targetId && targetId === sourceId) return '不能把情报直达给自己。';

  src.hand.splice(idx, 1);

  let path: PlayerId[];
  if (finalMethod === 'direct') {
    path = [targetId!];
  } else {
    // 密电 / 文本：从下家开始逐人传，最后传回出牌者（不得拒收）
    const order = aliveAfter(state, sourceId);
    path = [...order, sourceId];
  }

  state.flow = {
    uid: card.uid,
    defId: card.defId,
    color: def.color,
    method: finalMethod,
    source: sourceId,
    path,
    current: null,
    step: 'passing',
    applied: [],
    skipped: [],
    locked: false,
    decodedBy: [],
    askedIntercept: [],
    rejectedDirect: false,
  };

  const visible = finalMethod === 'text';
  log(
    state,
    `${src.name} 以【${METHOD_LABEL[finalMethod]}】传出一张情报${
      visible ? `（${COLOR_LABEL[def.color]}色，公开）` : '（牌面朝下）'
    }${finalMethod === 'direct' ? `，目标：${mustById(state, targetId!).name}` : ''}。`,
  );

  advanceStop(state);
  return null;
}

/** 走到路径的下一站 */
function advanceStop(state: GameState): void {
  const f = state.flow;
  if (!f) return;
  f.askedIntercept = [];
  f.locked = false;
  f.step = 'passing';

  // 跳过被【调虎离山】指定的人
  let next = f.path.shift();
  while (next && f.skipped.includes(next) && next !== f.source) {
    log(state, `${mustById(state, next).name} 被【调虎离山】跳过。`);
    next = f.path.shift();
  }

  if (!next) {
    // 路径走完，传回出牌者（强制接收）
    f.current = f.source;
    f.step = 'arrive';
    return;
  }

  f.current = next;
  f.step = 'passing';
}

/** 情报落位 */
function resolveIntel(state: GameState, pack: EnginePack, receiverId: PlayerId): void {
  const f = state.flow;
  if (!f) return;
  const receiver = mustById(state, receiverId);
  const def = pack.cardById.get(f.defId);

  const slot: IntelSlot = { uid: f.uid, defId: f.defId, color: f.color, method: f.method };
  receiver.intel.push(slot);
  state.stats.intelPlaced += 1;
  state.flow = null;
  state.window = null;

  log(
    state,
    `${receiver.name} 收下了 1 张${COLOR_LABEL[f.color]}色情报（当前 ${receiver.intel.length} 张）。`,
    { tone: f.color === 'black' ? 'bad' : 'normal' },
  );
  if (def && f.method === 'text') {
    log(state, `（文本传递，全场可见：${def.name}）`);
  }

  // 技能：收到情报
  const p = byId(state, receiverId);
  if (p) {
    const skill = getSkill(pack.characterById.get(p.characterId)?.skillId);
    skill?.onReceiveIntel?.(makeSkillCtx(state, pack, receiverId), slot);
  }

  // 技能：情报传回出牌者
  if (receiverId === f.source) {
    fireHook(state, pack, f.source, 'onIntelReturn');
  }

  // 特工机密任务优先于阵营胜利：任务达成就当场结束
  checkSecretTasks(state, pack);
  if (!state.winner) checkWin(state, pack);
  if (!state.winner) checkDeath(state, pack, receiverId);
  // 有人出局也可能让「他人出局」类任务达成
  if (!state.winner) checkSecretTasks(state, pack);

  state.phase = 'discard';
  // 注意：这里不调用 refreshPending —— 由调用方决定何时推进，
  // 避免在 refreshPending 的循环内部递归导致 pending 被覆盖。
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

/** 该玩家现在能挑的角色（已被别人选走的不再出现） */
function availableCharacters(state: GameState, p: PlayerState): string[] {
  const taken = new Set(
    state.players.filter((x) => x.id !== p.id && x.characterPicked).map((x) => x.characterId),
  );
  const own = p.characterChoices.filter((id) => !taken.has(id));
  if (own.length > 0) return own;
  // 候选都被挑走了（人多的局会发生）→ 把全场没人要的角色给他
  const all = [...new Set(state.players.flatMap((x) => x.characterChoices))];
  const rest = all.filter((id) => !taken.has(id));
  return rest.length > 0 ? rest : p.characterChoices.slice(0, 1);
}

/** 特工完成机密任务 → 单独获胜。其他人不检查任务。 */
function checkSecretTasks(state: GameState, pack: EnginePack): void {
  if (state.winner) return;
  for (const p of alivePlayers(state)) {
    if (p.identity !== 'agent') continue;
    const task = pack.characterById.get(p.characterId)?.task ?? null;
    if (!task) continue;
    if (!isTaskDone(task, state, p)) continue;

    state.winner = {
      side: 'agent',
      winners: [p.id],
      by: p.id,
      reason: `${p.name} 完成机密任务（${describeTask(task)}），特工单独获胜。`,
    };
    log(state, state.winner.reason, { tone: 'bad' });
    return;
  }
}

function checkWin(state: GameState, pack: EnginePack): void {
  const { winIntelCount, agentWinIntelCount } = pack.config;

  for (const p of alivePlayers(state)) {
    const red = p.intel.filter((s) => s.color === 'red').length;
    const blue = p.intel.filter((s) => s.color === 'blue').length;

    if (red >= winIntelCount) {
      state.winner = {
        side: 'red',
        winners: state.players.filter((x) => x.identity === 'red' && x.alive).map((x) => x.id),
        by: p.id,
        reason: `${p.name} 集齐 ${winIntelCount} 张红色情报，潜伏战线获胜。`,
      };
      log(state, state.winner.reason, { tone: 'good' });
      return;
    }
    if (blue >= winIntelCount) {
      state.winner = {
        side: 'blue',
        winners: state.players.filter((x) => x.identity === 'blue' && x.alive).map((x) => x.id),
        by: p.id,
        reason: `${p.name} 集齐 ${winIntelCount} 张蓝色情报，军情局获胜。`,
        };
      log(state, state.winner.reason, { tone: 'good' });
      return;
    }
    if (p.identity === 'agent' && red + blue >= agentWinIntelCount) {
      state.winner = {
        side: 'agent',
        winners: [p.id],
        by: p.id,
        reason: `${p.name} 集齐 ${agentWinIntelCount} 张真情报，特工单独获胜。`,
      };
      log(state, state.winner.reason, { tone: 'good' });
      return;
    }
  }

  // 只剩一人 → 独活获胜
  const alive = alivePlayers(state);
  if (alive.length === 1) {
    const last = alive[0]!;
    state.winner = {
      side: last.identity,
      winners: [last.id],
      by: last.id,
      reason: `只剩 ${last.name} 一人存活，单独获胜。`,
    };
    log(state, state.winner.reason, { tone: 'good' });
  }
}

function checkDeath(state: GameState, pack: EnginePack, pid: PlayerId): void {
  const p = byId(state, pid);
  if (!p || !p.alive) return;
  const black = p.intel.filter((s) => s.color === 'black').length;
  if (black < pack.config.deathBlackCount) return;

  p.alive = false;
  state.stats.deaths += 1;
  for (const c of p.hand) state.discard.push(c);
  for (const s of p.intel) state.discard.push({ uid: s.uid, defId: s.defId });
  p.hand = [];
  p.intel = [];

  const charName = pack.characterById.get(p.characterId)?.name ?? p.name;
  log(
    state,
    `${p.name}（${charName}）累计 ${pack.config.deathBlackCount} 张黑色情报，出局。身份公开：${
      p.identity === 'red' ? '潜伏战线' : p.identity === 'blue' ? '军情局' : '特工'
    }。`,
    { tone: 'bad' },
  );
}

/* ------------------------------------------------------------------ */
/* 指令入口                                                            */
/* ------------------------------------------------------------------ */

export function applyCommand(prev: GameState, pack: EnginePack, cmd: Command): ApplyResult {
  const state = clone(prev);
  const pending = state.pending;

  try {
    if (!pending) throw new Error('当前没有待处理的输入');

    if (pending.kind === 'gameOver') {
      return { state, error: '对局已结束。' };
    }

    switch (cmd.type) {
      case 'pickCharacter': {
        if (pending.kind !== 'pickCharacter') throw new Error('现在不是选角阶段。');
        if (!pending.options.includes(cmd.characterId)) {
          return { state: prev, error: '这个角色不在你的候选里。' };
        }
        const p = mustById(state, pending.player);
        const def = pack.characterById.get(cmd.characterId);
        p.characterId = cmd.characterId;
        p.characterHidden = def?.hidden ?? false;
        p.characterPicked = true;
        log(state, `${p.name} 选定了角色【${def?.name ?? cmd.characterId}】。`);
        refreshPending(state, pack);
        return { state };
      }

      case 'advancePhase': {
        if (pending.kind !== 'action') throw new Error('现在不是出牌阶段。');
        state.phase = 'intel';
        refreshPending(state, pack);
        return { state };
      }

      case 'transmitIntel': {
        if (pending.kind !== 'intelDeclare') throw new Error('现在不是情报阶段。');
        if (pending.player !== currentPlayer(state).id) throw new Error('还没轮到你。');
        const err = startIntelFlow(
          state,
          pack,
          pending.player,
          cmd.cardUid,
          cmd.method ?? 'cipher',
          cmd.targetId,
        );
        if (err) return { state: prev, error: err };
        refreshPending(state, pack);
        return { state };
      }

      case 'playFunction': {
        return playFunctionCommand(state, prev, pack, pending, cmd.cardUid, cmd.targetId);
      }

      case 'pass': {
        if (pending.kind === 'response' && state.window) {
          state.window.passed.push(pending.player);
          refreshPending(state, pack);
          return { state };
        }
        if (pending.kind === 'action') {
          state.phase = 'intel';
          refreshPending(state, pack);
          return { state };
        }
        throw new Error('当前不能放弃。');
      }

      case 'decideReceive': {
        if (pending.kind !== 'receive') throw new Error('当前没有待接收的情报。');
        const f = state.flow;
        if (!f) throw new Error('没有正在传递的情报。');
        if (f.current !== pending.player) throw new Error('不是你的接收决策。');

        if (!cmd.accept) {
          if (f.locked) return { state: prev, error: '这张情报被【锁定】，你必须收下。' };
          if (f.method === 'direct') {
            f.rejectedDirect = true;
            log(state, `${mustById(state, pending.player).name} 拒收了这张直达情报，情报回到传出者面前。`);
            resolveIntel(state, pack, f.source);
            refreshPending(state, pack);
            return { state };
          }
          log(state, `${mustById(state, pending.player).name} 拒收，情报继续向下传递。`);
          advanceStop(state);
          refreshPending(state, pack);
          return { state };
        }

        resolveIntel(state, pack, pending.player);
        refreshPending(state, pack);
        return { state };
      }

      case 'discard': {
        if (pending.kind !== 'discard') throw new Error('现在不是弃牌阶段。');
        const p = mustById(state, pending.player);
        if (cmd.cardUids.length !== pending.need) {
          return { state: prev, error: `需要弃 ${pending.need} 张，实际提交 ${cmd.cardUids.length} 张。` };
        }
        const set = new Set(cmd.cardUids);
        if (set.size !== cmd.cardUids.length) return { state: prev, error: '弃牌列表中有重复项。' };
        for (const uid of cmd.cardUids) {
          const i = p.hand.findIndex((c) => c.uid === uid);
          if (i < 0) return { state: prev, error: '要弃的牌不在手牌中。' };
          const [c] = p.hand.splice(i, 1);
          if (c) state.discard.push(c);
        }
        log(state, `${p.name} 弃掉了 ${cmd.cardUids.length} 张牌。`);
        refreshPending(state, pack);
        return { state };
      }

      default:
        throw new Error('未知指令。');
    }
  } catch (e) {
    return { state: prev, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* 功能牌指令                                                          */
/* ------------------------------------------------------------------ */

function playFunctionCommand(
  state: GameState,
  prev: GameState,
  pack: EnginePack,
  pending: NonNullable<GameState['pending']>,
  cardUid: CardUid,
  targetId?: PlayerId,
): ApplyResult {
  // 确定操作者与当前允许的功能牌
  let actor: PlayerId;
  let allowed: FunctionKind[] = [];
  let contextLabel = '';

  if (pending.kind === 'action') {
    actor = pending.player;
    allowed = ACTION_PHASE_FUNCTIONS;
    contextLabel = '出牌阶段';
  } else if (pending.kind === 'receive') {
    actor = pending.player;
    allowed = RECEIVE_FUNCTIONS;
    contextLabel = '接收决策';
  } else if (pending.kind === 'response' && state.window) {
    actor = pending.player;
    const ctx = state.window.ctx;
    if (ctx.kind === 'counter') {
      allowed = ['counter'];
      contextLabel = '识破响应';
    } else {
      allowed = ['intercept'];
      contextLabel = '截获响应';
    }
  } else {
    throw new Error('当前不能打出功能牌。');
  }

  const p = mustById(state, actor);
  const idx = p.hand.findIndex((c) => c.uid === cardUid);
  if (idx < 0) return { state: prev, error: '这张牌不在你的手牌中。' };
  const card = p.hand[idx]!;
  const def = defOf(pack, card);

  if (!allowed.includes(def.fn)) {
    return {
      state: prev,
      error: `【${FN_LABEL[def.fn]}】不能在此使用（当前为${contextLabel}）。`,
    };
  }

  // 目标校验
  if ((def.fn === 'burn' || def.fn === 'lure' || def.fn === 'probe') && !targetId) {
    return { state: prev, error: `【${FN_LABEL[def.fn]}】需要指定一名目标玩家。` };
  }

  // 从手牌移除并进弃牌堆（功能牌结算完即入弃牌堆）
  p.hand.splice(idx, 1);
  state.discard.push(card);
  log(state, `${p.name} 打出【${FN_LABEL[def.fn]}】。`);

  // 识破：直接结算为「抵销上一张」
  if (def.fn === 'counter') {
    const w = state.window;
    if (!w || w.ctx.kind !== 'counter') return { state: prev, error: '当前没有可识破的功能牌。' };
    const pendingFn = w.ctx.pending;
    log(state, `${p.name} 使用【识破】抵销【${FN_LABEL[pendingFn.kind]}】。`, { tone: 'warn' });

    // 重新开一个窗口：如果没人再识破，则上一张牌失效
    openCounterWindow(
      state,
      pack,
      pendingFn,
      `${p.name} 对【${FN_LABEL[pendingFn.kind]}】使用了【识破】`,
      w.ctx.counterCount + 1,
      w.depth + 1,
    );
    refreshPending(state, pack);
    return { state };
  }

  // 截获：进入识破窗口，无人识破才真正拿走
  if (def.fn === 'intercept') {
    openCounterWindow(state, pack, { kind: 'intercept', by: actor, cardUid }, `${p.name} 使用【截获】`, 0, 1);
    refreshPending(state, pack);
    return { state };
  }

  // 破译：纯信息效果，立即生效，不进识破窗口
  if (def.fn === 'decode') {
    const f = state.flow;
    if (!f) return { state: prev, error: '没有正在传递的情报。' };
    if (f.method === 'text') return { state: prev, error: '这张情报是【文本】传递，本就公开，无需破译。' };
    if (f.decodedBy.includes(actor)) return { state: prev, error: '你已经破译过这张情报了。' };
    f.decodedBy.push(actor);
    const def2 = pack.cardById.get(f.defId);
    log(state, `【破译】你看到的情报是：${def2 ? `${def2.name}·${COLOR_LABEL[def2.color]}` : '未知'}`, {
      secretTo: actor,
      tone: 'good',
    });
    fireHook(state, pack, actor, 'onDecode');
    refreshPending(state, pack);
    return { state };
  }

  // 其余影响场面的功能牌：先进识破窗口
  if (BOARD_FUNCTIONS.includes(def.fn)) {
    openCounterWindow(
      state,
      pack,
      { kind: def.fn, by: actor, target: targetId, cardUid },
      `${p.name} 使用【${FN_LABEL[def.fn]}】`,
    );
    refreshPending(state, pack);
    return { state };
  }

  // 兜底
  applyFunction(state, pack, { kind: def.fn, by: actor, target: targetId, cardUid });
  refreshPending(state, pack);
  return { state };
}

/* ------------------------------------------------------------------ */
/* 查询辅助（给 UI 与 AI 用）                                          */
/* ------------------------------------------------------------------ */

/** 当前该谁行动 */
export function actingPlayer(state: GameState): PlayerId | null {
  return state.pending && state.pending.kind !== 'gameOver' ? state.pending.player : null;
}

/** 某玩家在指定上下文里可以打出的功能牌 */
export function legalFunctions(
  state: GameState,
  pack: EnginePack,
  pid: PlayerId,
  context: 'action' | 'receive' | 'counter' | 'intercept',
): FunctionKind[] {
  const p = byId(state, pid);
  if (!p || !p.alive) return [];
  const own = new Set<FunctionKind>();
  for (const c of p.hand) {
    const d = pack.cardById.get(c.defId);
    if (d) own.add(d.fn);
  }
  const allowed =
    context === 'action'
      ? ACTION_PHASE_FUNCTIONS
      : context === 'receive'
        ? RECEIVE_FUNCTIONS
        : context === 'counter'
          ? (['counter'] as FunctionKind[])
          : (['intercept'] as FunctionKind[]);
  return allowed.filter((k) => own.has(k));
}

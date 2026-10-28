/**
 * 核心战斗模块 —— 类型定义
 *
 * 本文件不依赖任何框架 / DOM / Node API，浏览器与服务端共用。
 * 所有状态均为纯数据（可 structuredClone / JSON 序列化），便于快照、重连与复盘。
 */

export type PlayerId = string;
export type CardUid = string;

/** 情报颜色：红=潜伏，蓝=军情，黑=假情报 */
export type IntelColor = 'red' | 'blue' | 'black';

/** 传递方式：密电（朝下逐传）/ 文本（朝上逐传）/ 直达（指定，拒收则出牌者自收） */
export type PassMethod = 'cipher' | 'text' | 'direct';

/** 九种功能牌 */
export type FunctionKind =
  | 'lock'
  | 'lure'
  | 'return'
  | 'intercept'
  | 'decode'
  | 'counter'
  | 'burn'
  | 'probe'
  | 'shuffle';

/** 阵营 */
export type IdentityKind = 'red' | 'blue' | 'agent';

export interface CardDef {
  id: string;
  name: string;
  color: IntelColor;
  method: PassMethod;
  fn: FunctionKind;
  fnText: string;
}

/**
 * 机密任务 —— 特工的个人胜利条件（机器可判定）
 *
 * 之所以做成结构化数据而不是一句文本，是因为「判定」必须由引擎执行，
 * 文本只负责显示。配置工具里改的是这里的字段，展示文案由 describeTask() 生成，
 * 两边不会漂移。
 */
export type SecretTask =
  /** 自己面前有 count 张指定颜色（红/蓝）的情报 */
  | { kind: 'holdColor'; color: 'red' | 'blue'; count: number }
  /** 自己面前一共有 count 张情报（不分颜色） */
  | { kind: 'collectTotal'; count: number }
  /** 自己面前有 count 张情报，且一张黑色都没有 */
  | { kind: 'noBlackWith'; count: number }
  /** 除自己以外有 count 名玩家出局 */
  | { kind: 'othersDead'; count: number }
  /** 存活到第 round 轮开始 */
  | { kind: 'surviveRounds'; round: number };

export interface CharacterDef {
  id: string;
  name: string;
  hidden: boolean;
  difficulty: number;
  skillId: string | null;
  skillText: string;
  /** 特工的机密任务；null = 该角色没有任务（做特工时退回「集齐 N 张真情报」） */
  task: SecretTask | null;
}

export interface IdentityDef {
  kind: IdentityKind;
  name: string;
  desc: string;
  winText: string;
}

export interface CardInstance {
  uid: CardUid;
  defId: string;
}

export interface IntelSlot {
  uid: CardUid;
  defId: string;
  color: IntelColor;
  method: PassMethod;
  encrypted?: boolean;
}

export interface PlayerState {
  id: PlayerId;
  seat: number;
  name: string;
  isBot: boolean;
  identity: IdentityKind;
  characterId: string;
  characterHidden: boolean;
  /** 是否已完成「3 选 1」 */
  characterPicked: boolean;
  alive: boolean;
  hand: CardInstance[];
  intel: IntelSlot[];
  usedOnce: Record<string, boolean>;
  /** 开局抽到的 3 个角色候选，仅用于展示 */
  characterChoices: string[];
}

export type Phase = 'setup' | 'draw' | 'action' | 'intel' | 'discard' | 'gameOver';

/** 情报流程步骤 —— 对应规则中的四个响应点 */
export type IntelStep = 'passing' | 'arrive' | 'resolve';

/** 正在传递中的情报 */
export interface IntelFlow {
  uid: CardUid;
  defId: string;
  color: IntelColor;
  method: PassMethod;
  source: PlayerId;
  /** 剩余传递路径（按顺序），最后一位通常是传出者本人（强制接收） */
  path: PlayerId[];
  current: PlayerId | null;
  step: IntelStep;
  /** 本次传递已生效的功能牌 */
  applied: { kind: FunctionKind; by: PlayerId; target?: PlayerId }[];
  /** 被【调虎离山】跳过的人 */
  skipped: PlayerId[];
  /** 已被【锁定】：当前接收者不可拒收 */
  locked: boolean;
  /** 已被【破译】查看过的人 */
  decodedBy: PlayerId[];
  /** 本停靠点已询问过【截获】的人，避免重复询问 */
  askedIntercept: PlayerId[];
  /** 直达被指定者拒收，需传回传出者 */
  rejectedDirect: boolean;
}

/** 待结算的功能牌（先进入响应窗口，无人识破才生效） */
export interface PendingFunction {
  kind: FunctionKind;
  by: PlayerId;
  target?: PlayerId;
  cardUid: CardUid;
}

export type ResponseContext =
  | {
      kind: 'counter';
      /** 正在被响应的功能牌 */
      pending: PendingFunction;
      description: string;
      /** 已被识破的次数：奇数=已失效，偶数=仍然生效 */
      counterCount: number;
    }
  | {
      kind: 'intercept';
      cardUid: CardUid;
      visible: boolean;
      color: IntelColor | null;
      from: PlayerId;
      current: PlayerId | null;
    };

export interface ResponseWindow {
  id: string;
  ctx: ResponseContext;
  /** 待询问队列（逆时针顺序） */
  queue: PlayerId[];
  /** 已放弃的玩家 */
  passed: PlayerId[];
  /** 嵌套深度，防止无限连锁 */
  depth: number;
}

export type Pending =
  | { kind: 'pickCharacter'; player: PlayerId; options: string[]; prompt: string }
  | { kind: 'action'; player: PlayerId; prompt: string }
  | { kind: 'intelDeclare'; player: PlayerId; prompt: string }
  | { kind: 'response'; player: PlayerId; prompt: string }
  | { kind: 'receive'; player: PlayerId; prompt: string }
  | { kind: 'discard'; player: PlayerId; need: number; prompt: string }
  | { kind: 'gameOver'; prompt: string };

export interface LogEntry {
  seq: number;
  text: string;
  /** 仅该玩家可见 */
  secretTo?: PlayerId;
  tone?: 'normal' | 'good' | 'bad' | 'warn';
}

export interface WinResult {
  winners: PlayerId[];
  /** 真正凑齐情报 / 触发胜利的人（winners[0] 只是队友列表的第一位，不代表是他凑齐的） */
  by?: PlayerId;
  side: IdentityKind;
  reason: string;
}

export interface GameState {
  version: 1;
  seed: string;
  rngCursor: number;
  players: PlayerState[];
  turnIndex: number;
  round: number;
  phase: Phase;
  pending: Pending | null;
  deck: CardInstance[];
  discard: CardInstance[];
  flow: IntelFlow | null;
  window: ResponseWindow | null;
  log: LogEntry[];
  logSeq: number;
  winner: WinResult | null;
  stats: {
    intelPlaced: number;
    deaths: number;
    intercepted: number;
    counters: number;
  };
}

export type Command =
  | { type: 'pickCharacter'; characterId: string }
  | { type: 'advancePhase' }
  | { type: 'transmitIntel'; cardUid: CardUid; method?: PassMethod; targetId?: PlayerId }
  | { type: 'playFunction'; cardUid: CardUid; targetId?: PlayerId }
  | { type: 'pass' }
  | { type: 'decideReceive'; accept: boolean }
  | { type: 'discard'; cardUids: CardUid[] };

export interface ApplyResult {
  state: GameState;
  error?: string;
}

/** 引擎所需的静态数据（由数据层注入，引擎不直接读文件） */
export interface EnginePack {
  /** 全部卡牌定义（按牌库顺序） */
  cards: CardDef[];
  /** 全部角色定义 */
  characters: CharacterDef[];
  cardById: Map<string, CardDef>;
  characterById: Map<string, CharacterDef>;
  config: {
    handLimit: number;
    startHand: number;
    drawPerTurn: number;
    winIntelCount: number;
    agentWinIntelCount: number;
    deathBlackCount: number;
    seats: Record<string, { red: number; blue: number; agent: number }>;
  };
}

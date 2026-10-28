/**
 * 数据层 —— zod Schema
 *
 * 所有卡牌 / 角色 / 身份 / 规则参数都必须通过这里的校验才能进入引擎。
 * 配置工具与 CLI 校验脚本共用同一套 Schema，避免两处标准不一致。
 */
import { z } from 'zod';

export const intelColorSchema = z.enum(['red', 'blue', 'black']);
export const passMethodSchema = z.enum(['cipher', 'text', 'direct']);
export const identityKindSchema = z.enum(['red', 'blue', 'agent']);
export const functionKindSchema = z.enum([
  'lock',
  'lure',
  'return',
  'intercept',
  'decode',
  'counter',
  'burn',
  'probe',
  'shuffle',
]);

export const cardDefSchema = z.object({
  id: z.string().min(1, 'id 不能为空'),
  name: z.string().min(1, 'name 不能为空'),
  color: intelColorSchema,
  method: passMethodSchema,
  fn: functionKindSchema,
  fnText: z.string().default(''),
});

export const secretTaskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('holdColor'), color: z.enum(['red', 'blue']), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('collectTotal'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('noBlackWith'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('othersDead'), count: z.number().int().min(1) }),
  z.object({ kind: z.literal('surviveRounds'), round: z.number().int().min(1) }),
]);

export const characterDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 是否状态角色（技能名标注【隐藏】/【暴露】），可选择开局不公开 */
  hidden: z.boolean(),
  /** 特工机密任务（结构化，引擎按它判定胜负） */
  task: secretTaskSchema.nullable().default(null),
  /** 技能描述（给玩家看） */
  skillText: z.string().default(''),
  /** 技能实现 id，对应 src/core/skills.ts 的注册表；null 表示纯数据占位 */
  skillId: z.string().nullable().default(null),
  /** 难度星级 1-5，仅用于展示 */
  difficulty: z.number().int().min(1).max(5).default(3),
});

export const identityDefSchema = z.object({
  kind: identityKindSchema,
  name: z.string().min(1),
  desc: z.string().default(''),
  winText: z.string().default(''),
});

export const seatConfigSchema = z.object({
  red: z.number().int().min(0),
  blue: z.number().int().min(0),
  agent: z.number().int().min(0),
});

export const gameConfigSchema = z.object({
  /** 手牌上限 */
  handLimit: z.number().int().min(1).default(6),
  /** 起始手牌 */
  startHand: z.number().int().min(1).default(3),
  /** 每回合抽牌数 */
  drawPerTurn: z.number().int().min(0).default(2),
  /** 阵营获胜所需同色情报数 */
  winIntelCount: z.number().int().min(1).default(3),
  /** 特工获胜所需真情报数 */
  agentWinIntelCount: z.number().int().min(1).default(6),
  /** 死亡所需黑色情报数 */
  deathBlackCount: z.number().int().min(1).default(3),
  /** 各人数下的身份配置，键为人数 */
  seats: z.record(z.string(), seatConfigSchema),
});

export const dataPackSchema = z.object({
  version: z.literal(1),
  config: gameConfigSchema,
  identities: z.array(identityDefSchema).min(3),
  characters: z.array(characterDefSchema).min(1),
  cards: z.array(cardDefSchema).min(1),
});

export type CardDefInput = z.infer<typeof cardDefSchema>;
export type CharacterDefInput = z.infer<typeof characterDefSchema>;
export type IdentityDefInput = z.infer<typeof identityDefSchema>;
export type GameConfigInput = z.infer<typeof gameConfigSchema>;
export type DataPackInput = z.infer<typeof dataPackSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
  level: 'error' | 'warn';
}

/**
 * 结构化校验：在 Schema 通过之后，再做跨字段一致性检查。
 * 这些是 Schema 表达不了的业务规则。
 */
export function checkDataPack(pack: DataPackInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, level: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, level: 'warn' });

  // 1. 卡牌 id 唯一
  const cardIds = new Set<string>();
  pack.cards.forEach((c, i) => {
    if (cardIds.has(c.id)) err(`cards[${i}].id`, `卡牌 id 重复：${c.id}`);
    cardIds.add(c.id);
  });

  // 2. 角色 id 唯一
  const charIds = new Set<string>();
  pack.characters.forEach((c, i) => {
    if (charIds.has(c.id)) err(`characters[${i}].id`, `角色 id 重复：${c.id}`);
    charIds.add(c.id);
  });

  // 3. 身份配置必须覆盖 3–7 人，且总和等于人数
  for (let n = 3; n <= 7; n++) {
    const cfg = pack.config.seats[String(n)];
    if (!cfg) {
      warn(`config.seats.${n}`, `缺少 ${n} 人局身份配置`);
      continue;
    }
    const sum = cfg.red + cfg.blue + cfg.agent;
    if (sum !== n) {
      err(`config.seats.${n}`, `${n} 人局身份总数为 ${sum}，应为 ${n}`);
    }
    if (cfg.red === 0 || cfg.blue === 0) {
      err(`config.seats.${n}`, `${n} 人局红蓝两方都不能为 0`);
    }
    if (Math.abs(cfg.red - cfg.blue) > 1) {
      warn(`config.seats.${n}`, `${n} 人局红蓝人数差 ${Math.abs(cfg.red - cfg.blue)} > 1，可能不平衡`);
    }
  }

  // 4. 卡池健康度
  const total = pack.cards.length;
  const byColor = { red: 0, blue: 0, black: 0 };
  const byMethod = { cipher: 0, text: 0, direct: 0 };
  const byFn = new Map<string, number>();
  for (const c of pack.cards) {
    byColor[c.color]++;
    byMethod[c.method]++;
    byFn.set(c.fn, (byFn.get(c.fn) ?? 0) + 1);
  }

  const intelRatio = 1; // 每张基础牌都同时是情报牌
  void intelRatio;

  for (const k of ['red', 'blue', 'black'] as const) {
    if (byColor[k] === 0) err('cards', `缺少 ${k} 色情报牌`);
  }
  if (Math.abs(byColor.red - byColor.blue) > Math.max(2, total * 0.05)) {
    warn('cards', `红(${byColor.red}) 蓝(${byColor.blue}) 数量差偏大，可能影响阵营平衡`);
  }
  const blackRatio = byColor.black / total;
  if (blackRatio > 0.35) {
    warn('cards', `黑色情报占比 ${(blackRatio * 100).toFixed(1)}% 偏高，死亡节奏会过快`);
  }
  if (blackRatio < 0.15) {
    warn('cards', `黑色情报占比 ${(blackRatio * 100).toFixed(1)}% 偏低，死亡威胁不足`);
  }
  for (const k of ['cipher', 'text', 'direct'] as const) {
    if (byMethod[k] === 0) err('cards', `缺少 ${k} 传递方式的牌`);
  }
  const fnKinds = ['lock', 'lure', 'return', 'intercept', 'decode', 'counter', 'burn', 'probe', 'shuffle'];
  for (const k of fnKinds) {
    if (!byFn.has(k)) warn('cards', `功能牌【${k}】一张都没有`);
  }

  // 5. 起始手牌 + 每回合抽牌必须小于牌库，否则第一轮就抽空
  const needPerRound = pack.config.startHand * 7 + pack.config.drawPerTurn * 7;
  if (total < needPerRound) {
    warn('cards', `牌库 ${total} 张，7 人局首轮需要 ${needPerRound} 张，可能过早洗牌`);
  }

  // 6. 角色至少要有 8 个可选（每人抽 3 选 1）
  if (pack.characters.length < 8) {
    warn('characters', `角色仅 ${pack.characters.length} 个，7 人局发牌后选择空间不足`);
  }

  return issues;
}

export function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return '✔ 数据校验通过，无问题。';
  return issues
    .map((i) => `${i.level === 'error' ? '✖' : '▲'} [${i.path}] ${i.message}`)
    .join('\n');
}

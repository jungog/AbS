/**
 * 数据层 —— 加载与索引
 *
 * 数据文件是唯一真相源；引擎只认这里产出的 DataPack。
 * 配置工具导出 JSON 后，替换 defaults/*.json 即可生效。
 */
import cardsJson from './defaults/cards.json';
import charactersJson from './defaults/characters.json';
import identitiesJson from './defaults/identities.json';
import configJson from './defaults/gameConfig.json';
import { dataPackSchema, checkDataPack, formatIssues, type ValidationIssue } from './schema';
import type { CardDef, CharacterDef, IdentityDef } from '@core/types';

export interface GameConfig {
  handLimit: number;
  startHand: number;
  drawPerTurn: number;
  winIntelCount: number;
  agentWinIntelCount: number;
  deathBlackCount: number;
  seats: Record<string, { red: number; blue: number; agent: number }>;
}

export interface DataPack {
  version: 1;
  config: GameConfig;
  identities: IdentityDef[];
  characters: CharacterDef[];
  cards: CardDef[];
  /** 索引：卡牌 id -> 定义 */
  cardById: Map<string, CardDef>;
  /** 索引：角色 id -> 定义 */
  characterById: Map<string, CharacterDef>;
}

export interface LoadResult {
  pack: DataPack | null;
  issues: ValidationIssue[];
  /** Schema 级别的致命错误（结构不合法，无法构造 DataPack） */
  fatal: string | null;
}

/** 校验并构造 DataPack；不抛异常，错误通过返回值表达 */
export function parsePack(raw: unknown): LoadResult {
  const parsed = dataPackSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      pack: null,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        level: 'error' as const,
      })),
      fatal: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'),
    };
  }
  const issues = checkDataPack(parsed.data);
  const pack: DataPack = {
    version: 1,
    config: parsed.data.config as GameConfig,
    identities: parsed.data.identities as IdentityDef[],
    characters: parsed.data.characters as CharacterDef[],
    cards: parsed.data.cards as CardDef[],
    cardById: new Map(parsed.data.cards.map((c) => [c.id, c as CardDef])),
    characterById: new Map(parsed.data.characters.map((c) => [c.id, c as CharacterDef])),
  };
  return { pack, issues, fatal: null };
}

/** 内置默认数据包 */
export function loadDefaultPack(): DataPack {
  const result = parsePack({
    version: 1,
    config: configJson,
    identities: identitiesJson,
    characters: charactersJson,
    cards: cardsJson,
  });
  if (!result.pack) {
    throw new Error(`默认数据包不合法：\n${result.fatal}`);
  }
  const errors = result.issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    throw new Error(`默认数据包存在错误：\n${formatIssues(errors)}`);
  }
  return result.pack;
}

/** 原始数据（用于配置工具编辑） */
export function loadRawDefault(): unknown {
  return {
    version: 1,
    config: configJson,
    identities: identitiesJson,
    characters: charactersJson,
    cards: cardsJson,
  };
}

export const COLOR_LABEL: Record<string, string> = {
  red: '红',
  blue: '蓝',
  black: '黑',
};

export const COLOR_FULL: Record<string, string> = {
  red: '红色情报',
  blue: '蓝色情报',
  black: '黑色情报',
};

export const METHOD_LABEL: Record<string, string> = {
  cipher: '密电',
  text: '文本',
  direct: '直达',
};

export const METHOD_HINT: Record<string, string> = {
  cipher: '牌面朝下，逐人传递',
  text: '牌面朝上，逐人传递',
  direct: '牌面朝下，直接指定接收者',
};

export const FN_LABEL: Record<string, string> = {
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

export const IDENTITY_LABEL: Record<string, string> = {
  red: '潜伏战线',
  blue: '军情局',
  agent: '特工',
};

export { checkDataPack, formatIssues, dataPackSchema };
export type { ValidationIssue };

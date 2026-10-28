/**
 * 角色技能注册表
 *
 * 数据（characters.json）只存 skillId 与展示文案；真正的行为写在这里。
 * 这样「换角色文本」不需要改代码，「改技能逻辑」也不需要动数据文件。
 *
 * v1 的 8 个角色全部是**自动触发 / 被动**技能，不产生额外决策点。
 * 需要玩家做选择的技能（如"可查看牌库顶"）在 v1 里一律改为自动执行，
 * 后续要做成可选，只需在引擎里插入一个 pending 决策点。
 */
import type { CardDef, GameState, IntelSlot, PassMethod, PlayerId } from './types';

export interface SkillCtx {
  state: GameState;
  self: PlayerId;
  /** 抽牌（会自动处理洗牌） */
  draw: (playerId: PlayerId, n: number) => void;
  /** 写日志；secretTo 指定则仅该玩家可见 */
  log: (text: string, opts?: { secretTo?: PlayerId; tone?: 'normal' | 'good' | 'bad' | 'warn' }) => void;
  /** 查看牌库顶 n 张（不取走） */
  peekTop: (n: number) => string[];
  /** 取角色定义 */
  charName: (playerId: PlayerId) => string;
}

export interface SkillHooks {
  /** 回合开始时 */
  onTurnStart?: (ctx: SkillCtx) => void;
  /** 使用【破译】查看情报后 */
  onDecode?: (ctx: SkillCtx) => void;
  /** 自己传出的情报被拒收、最终传回自己面前 */
  onIntelReturn?: (ctx: SkillCtx) => void;
  /** 收到一张情报并落位后（此时死亡判定尚未执行） */
  onReceiveIntel?: (ctx: SkillCtx, slot: IntelSlot) => void;
  /** 自己传出的情报被他人【截获】 */
  onIntercepted?: (ctx: SkillCtx) => void;
  /** 手牌上限加成 */
  handLimitBonus?: (ctx: SkillCtx) => number;
  /** 强制传递方式（返回 undefined 表示不干预） */
  forceMethod?: (ctx: SkillCtx, def: CardDef) => PassMethod | undefined;
}

export const SKILLS: Record<string, SkillHooks> = {
  /** 译电员：破译后抽 1 张 */
  drawOnDecode: {
    onDecode: (ctx) => {
      ctx.draw(ctx.self, 1);
      ctx.log(`${ctx.charName(ctx.self)}【明译】发动：破译后抽 1 张牌。`, { tone: 'good' });
    },
  },

  /** 老鬼：回合开始查看牌库顶 1 张 */
  peekOnTurnStart: {
    onTurnStart: (ctx) => {
      const top = ctx.peekTop(1);
      if (top.length === 0) return;
      ctx.log(`【探路】牌库顶：${top[0]}`, { secretTo: ctx.self });
    },
  },

  /** 联络员：传出情报被拒收传回时抽 1 张 */
  drawOnIntelReturn: {
    onIntelReturn: (ctx) => {
      ctx.draw(ctx.self, 1);
      ctx.log(`${ctx.charName(ctx.self)}【往返】发动：情报传回，抽 1 张牌。`, { tone: 'good' });
    },
  },

  /** 情报贩子：每局一次，收到黑色情报自动弃置 */
  discardBlackOnce: {
    onReceiveIntel: (ctx, slot) => {
      if (slot.color !== 'black') return;
      const self = ctx.state.players.find((p) => p.id === ctx.self);
      if (!self || self.usedOnce['discardBlackOnce']) return;
      self.usedOnce['discardBlackOnce'] = true;
      self.intel = self.intel.filter((s) => s.uid !== slot.uid);
      ctx.state.discard.push({ uid: slot.uid, defId: slot.defId });
      ctx.log(`${ctx.charName(ctx.self)}【脱手】发动：弃置了 1 张黑色情报（每局一次）。`, { tone: 'good' });
    },
  },

  /** 译码专家：手牌上限 +2 */
  handLimit2: {
    handLimitBonus: () => 2,
  },

  /** 播音员：传出情报强制文本 */
  forceTextMethod: {
    forceMethod: () => 'text',
  },

  /** 硬骨头：收到黑色情报抽 1 张 */
  drawOnBlack: {
    onReceiveIntel: (ctx, slot) => {
      if (slot.color !== 'black') return;
      ctx.draw(ctx.self, 1);
      ctx.log(`${ctx.charName(ctx.self)}【硬扛】发动：收到黑色情报，抽 1 张牌。`, { tone: 'good' });
    },
  },

  /** 哨兵：自己的情报被截获时抽 1 张 */
  drawOnIntercepted: {
    onIntercepted: (ctx) => {
      ctx.draw(ctx.self, 1);
      ctx.log(`${ctx.charName(ctx.self)}【反制】发动：情报被截获，抽 1 张牌。`, { tone: 'good' });
    },
  },
};

export function getSkill(skillId: string | null | undefined): SkillHooks | null {
  if (!skillId) return null;
  return SKILLS[skillId] ?? null;
}

/**
 * AI 陪练
 *
 * 目标不是「强」，而是「规则正确 + 不犯蠢」，用于单人调试与压测。
 * 决策全部基于公开信息 + 自身身份，不做任何作弊读取。
 * 随机性由 (seed, 日志序号, 玩家 id) 派生，保证同种子可复现。
 */
import type {
  CardDef,
  Command,
  EnginePack,
  GameState,
  FunctionKind,
  IntelColor,
  PlayerId,
  PlayerState,
  SecretTask,
} from './types';
import { hashSeed } from './rng';

function botRand(state: GameState, pid: PlayerId, salt: string): number {
  return hashSeed(`${state.seed}|${pid}|${state.logSeq}|${salt}`) / 4294967296;
}

function handDefs(state: GameState, pack: EnginePack, pid: PlayerId): CardDef[] {
  const p = state.players.find((x) => x.id === pid);
  if (!p) return [];
  return p.hand.map((c) => pack.cardById.get(c.defId)).filter((d): d is CardDef => Boolean(d));
}

/** 该玩家的机密任务（没有角色 / 没有任务时返回 null） */
function taskOf(pack: EnginePack, p: PlayerState): SecretTask | null {
  return pack.characterById.get(p.characterId)?.task ?? null;
}

/** 特工是否想要这张颜色的情报（用于接收决策与传出评分） */
function agentWants(me: PlayerState, task: SecretTask | null, color: IntelColor): boolean {
  if (!task) return color !== 'black';
  switch (task.kind) {
    case 'holdColor':
      return color === task.color;
    case 'collectTotal':
      return me.intel.length < task.count;
    case 'noBlackWith':
      return color !== 'black' && me.intel.length < task.count;
    default:
      return color !== 'black';
  }
}

/** 值得留在手里的防守牌 */
const KEEP_FUNCTIONS: FunctionKind[] = ['counter', 'return', 'decode'];

export function botDecide(state: GameState, pack: EnginePack): Command | null {
  const pending = state.pending;
  if (!pending || pending.kind === 'gameOver') return null;
  const pid = pending.player;
  const me = state.players.find((p) => p.id === pid);
  if (!me || !me.isBot) return null;

  /* ---------------- 选角 ---------------- */
  if (pending.kind === 'pickCharacter') {
    // 偏好难度高的角色（技能通常更实在），同档位用种子随机，避免每局都一样
    const options = pending.options.slice();
    options.sort((a, b) => {
      const da = pack.characterById.get(a)?.difficulty ?? 3;
      const db = pack.characterById.get(b)?.difficulty ?? 3;
      return db - da;
    });
    const span = Math.min(2, options.length);
    const pick = options[Math.floor(botRand(state, pid, 'pick') * span)] ?? options[0];
    return pick ? { type: 'pickCharacter', characterId: pick } : null;
  }

  /* ---------------- 出牌阶段 ---------------- */
  if (pending.kind === 'action') {
    // 自己快死了就烧掉自己的黑牌
    const myBlack = me.intel.filter((s) => s.color === 'black').length;
    if (myBlack >= pack.config.deathBlackCount - 1) {
      const burn = handDefs(state, pack, pid).find((d) => d.fn === 'burn');
      if (burn) {
        const card = me.hand.find((c) => c.defId === burn.id);
        if (card) return { type: 'playFunction', cardUid: card.uid, targetId: pid };
      }
    }
    return { type: 'advancePhase' };
  }

  /* ---------------- 情报阶段 ---------------- */
  if (pending.kind === 'intelDeclare') {
    const defs = handDefs(state, pack, pid);
    if (defs.length === 0) {
      // 理论上不会发生（空手会从牌库顶抽一张当情报），这里兜底
      const card = me.hand[0];
      return card ? { type: 'transmitIntel', cardUid: card.uid, method: 'cipher' } : null;
    }

    const myColor = me.identity === 'red' ? 'red' : me.identity === 'blue' ? 'blue' : null;

    // 打分：分数越高越优先传出。
    // 关键认知：胜利条件是「任意一名玩家集齐 3 张同色」，
    // 所以把自己阵营的颜色传出去永远是正收益 —— 落在谁面前都算自己阵营的进度。
    // 反过来，把对手颜色传出去，一旦被拒收传回自己手上就是纯亏损。
    const scored = defs.map((d, i) => {
      let score = 0;
      if (d.color === 'black') score += 10; // 黑牌必须尽快脱手
      if (myColor && d.color === myColor) score += 7; // 自己阵营的颜色，传出去就是推进
      if (myColor && d.color !== myColor && d.color !== 'black') score += 2; // 对手颜色，尽量别自己留着
      if (!myColor && d.color !== 'black') {
        // 特工：任务需要的颜色自己留着，不需要的尽快送走
        score += agentWants(me, taskOf(pack, me), d.color) ? -2 : 4;
      }
      if (KEEP_FUNCTIONS.includes(d.fn)) score -= 3; // 防守牌留着
      if (d.fn === 'probe') score += 5; // 未实现，尽快甩掉
      score += botRand(state, pid, `intel-${i}`) * 2; // 少量随机，避免每局一样
      return { def: d, card: me.hand[i]!, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0]!;

    // 黑牌尽量直达给黑牌最多的人，其他用密电（有概率被拒收传回自己）
    if (chosen.def.color === 'black') {
      const others = state.players.filter((p) => p.alive && p.id !== pid);
      if (others.length > 0) {
        const target = others
          .slice()
          .sort((a, b) => {
            const ba = a.intel.filter((s) => s.color === 'black').length;
            const bb = b.intel.filter((s) => s.color === 'black').length;
            return bb - ba;
          })[0]!;
        return { type: 'transmitIntel', cardUid: chosen.card.uid, method: 'direct', targetId: target.id };
      }
    }
    return { type: 'transmitIntel', cardUid: chosen.card.uid, method: 'cipher' };
  }

  /* ---------------- 接收决策 ---------------- */
  if (pending.kind === 'receive') {
    const flow = state.flow;
    if (!flow) return { type: 'decideReceive', accept: true };
    if (flow.locked) return { type: 'decideReceive', accept: true };

    const myBlack = me.intel.filter((s) => s.color === 'black').length;
    const wouldDie = myBlack + 1 >= pack.config.deathBlackCount;

    const visible = flow.method === 'text';
    const color = visible ? flow.color : null;

    if (color === 'black') return { type: 'decideReceive', accept: false };

    if (color === 'red' || color === 'blue') {
      // 特工：只收自己机密任务需要的颜色
      if (me.identity === 'agent') {
        const want = agentWants(me, taskOf(pack, me), color);
        return { type: 'decideReceive', accept: want };
      }
      const mine = me.identity === color;
      if (mine) return { type: 'decideReceive', accept: true };
      // 对手的颜色：能躲就躲
      return { type: 'decideReceive', accept: false };
    }

    // 牌面朝下：按风险接受度决定
    if (wouldDie) return { type: 'decideReceive', accept: false };
    let riskAversion = 0.35 + myBlack * 0.15;
    if (me.identity === 'agent' && taskOf(pack, me)?.kind === 'noBlackWith') {
      riskAversion = Math.min(0.92, riskAversion + 0.3);
    }
    const accept = botRand(state, pid, 'receive') > riskAversion;
    return { type: 'decideReceive', accept };
  }

  /* ---------------- 响应窗口 ---------------- */
  if (pending.kind === 'response') {
    const w = state.window;
    if (w && w.ctx.kind === 'intercept') {
      // 只有看得到颜色、且正是自己阵营的牌，才值得截获
      if (w.ctx.visible && w.ctx.color) {
        const myColor = me.identity === 'red' ? 'red' : me.identity === 'blue' ? 'blue' : null;
        const want =
          (myColor && w.ctx.color === myColor) ||
          (me.identity === 'agent' && w.ctx.color !== 'black');
        if (want) {
          const intercept = handDefs(state, pack, pid).find((d) => d.fn === 'intercept');
          const card = intercept ? me.hand.find((c) => c.defId === intercept.id) : undefined;
          if (card) return { type: 'playFunction', cardUid: card.uid };
        }
      }
      return { type: 'pass' };
    }
    // 识破窗口：默认不响应（AI 不做复杂连锁）
    return { type: 'pass' };
  }

  /* ---------------- 弃牌阶段 ---------------- */
  if (pending.kind === 'discard') {
    const sorted = me.hand
      .map((c, i) => ({ c, i, def: pack.cardById.get(c.defId) }))
      .sort((a, b) => {
        const ka = a.def && KEEP_FUNCTIONS.includes(a.def.fn) ? 1 : 0;
        const kb = b.def && KEEP_FUNCTIONS.includes(b.def.fn) ? 1 : 0;
        return ka - kb;
      });
    const uids = sorted.slice(0, pending.need).map((x) => x.c.uid);
    return { type: 'discard', cardUids: uids };
  }

  return null;
}

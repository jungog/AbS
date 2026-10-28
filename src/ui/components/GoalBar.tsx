import { PACK } from '@data/pack';
import { COLOR_LABEL, IDENTITY_LABEL } from '@data/load';
import type { RedactedState } from '@core/redact';

/**
 * 我的目标条。
 *
 * 存在的理由很直接：界面上原来只写了「军情局」三个字，
 * 玩家得自己知道「军情局 = 收蓝色」才能打 —— 这不是玩家该记的规则。
 * 所以把「收什么颜色、几张、还差几张、黑几张会死」直接摆在牌桌上方。
 *
 * 三件事刻意放在一起：
 *  1. 目标颜色 + 进度（蓝色 2/3）
 *  2. 黑色死亡线（黑 1/3）—— 它和目标一样是「我该躲什么」的核心信息
 *  3. 特工没有颜色目标，显示机密任务原文 + 备选的「6 张真情报」
 */
export function GoalBar(props: { view: RedactedState; viewerId: string | null }) {
  const me = props.viewerId ? props.view.players.find((p) => p.id === props.viewerId) : null;
  // 观战 / 上帝视角没有「我」，不显示
  if (!me || !me.identity) return null;

  const cfg = PACK.config;
  const death = cfg.deathBlackCount;
  const black = me.counts.black;
  // 差一张就死的时候，这条信息比目标还重要
  const blackDanger = black >= death - 1;

  if (me.identity === 'agent') {
    const real = me.counts.red + me.counts.blue;
    const need = cfg.agentWinIntelCount;
    return (
      <div className="goalbar agent">
        <span className="goal-tag agent">特工</span>
        <span className="goal-main">
          机密任务：<b>{me.taskText || '（本局无任务）'}</b>
        </span>
        <span className="goal-alt">
          或集齐 {need} 张真情报（红蓝皆可）· 当前 {real}/{need}
        </span>
        <span className={`goal-black${blackDanger ? ' danger' : ''}`}>
          黑色 {black}/{death}
        </span>
      </div>
    );
  }

  const color = me.identity;
  const goal = cfg.winIntelCount;
  const have = color === 'red' ? me.counts.red : me.counts.blue;
  const pips = Array.from({ length: goal }, (_, i) => i < have);

  return (
    <div className={`goalbar ${color}`}>
      <span className={`goal-tag ${color}`}>{IDENTITY_LABEL[color]}</span>
      <span className="goal-main">
        目标：面前集齐 <b>{goal} 张{COLOR_LABEL[color]}色情报</b>
      </span>
      <span className={`goal-pips ${color}`}>
        {pips.map((filled, i) => (
          <i key={i} className={filled ? 'on' : ''} />
        ))}
      </span>
      <span className={`goal-num${have >= goal ? ' done' : ''}`}>
        {COLOR_LABEL[color]} {have}/{goal}
      </span>
      <span className={`goal-black${blackDanger ? ' danger' : ''}`}>
        黑色 {black}/{death}
        {blackDanger && <em>{black === death - 1 ? ' 再收 1 张出局' : ' 已出局'}</em>}
      </span>
    </div>
  );
}

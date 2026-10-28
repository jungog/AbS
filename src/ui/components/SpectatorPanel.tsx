/**
 * 观战面板
 *
 * 观众没有手牌、不能操作，如果直接复用 ActionPanel 的「等待」态，
 * 界面下半部分会是一大片空白 —— 看起来像加载失败而不是「你在看别人打」。
 * 所以给观众一个自己的面板：说清现在是什么阶段、在等谁、以及为什么看不到牌。
 *
 * 面板展示的是**观众视角**的状态，也就是落后 `delayRounds` 轮的旧画面。
 * 所以文案不能说「正在出牌」「等待某人」——那是现在发生的事，观众看到的不是现在。
 * 用「当时」把时态拉开，否则观众会以为对局卡住了。
 */
import type { RedactedPlayer, RedactedState } from '@core/redact';

const PHASE_TEXT: Record<string, string> = {
  pickCharacter: '正在选角',
  action: '出牌阶段',
  intelDeclare: '情报阶段',
  receive: '接收决策',
  response: '响应窗口',
  discard: '弃牌阶段',
  gameOver: '对局结束',
};

/**
 * 阶段文案。战斗状态条（观众版）和观战面板共用这一份 ——
 * 观众没有操作区，操作区的按钮就是玩家判断阶段的唯一线索，
 * 观众什么都没有，所以阶段必须由状态条顶上。两处各写一份迟早写岔。
 */
export function describePhase(view: RedactedState): string {
  const kind = view.pending?.kind ?? '';
  return PHASE_TEXT[kind] ?? '对局进行中';
}

export function SpectatorPanel(props: {
  view: RedactedState;
  actor: RedactedPlayer | null;
  /** 落后几轮。0 表示实时（理论上不会出现在联机观战里） */
  delayRounds?: number;
}) {
  const { view, actor } = props;
  const delay = props.delayRounds ?? 0;
  const phase = describePhase(view);

  return (
    <div className="spectator-panel">
      <div className="spec-eyebrow">观 战</div>
      <div className="spec-phase">
        {delay > 0 ? `当时：${phase}` : phase}
      </div>
      {actor ? (
        <div className="spec-actor">
          {delay > 0 ? '当时轮到' : '等待'} <b>{actor.name}</b>
          {actor.isBot && <span className="pill-inline">AI</span>}
        </div>
      ) : (
        <div className="spec-actor">{view.winner ? '本局已结束' : '正在结算…'}</div>
      )}
      {delay > 0 && (
        <div className="spec-delay">
          你看到的是第 {view.round} 轮结束时的局面，落后 {delay} 轮
        </div>
      )}
      <div className="spec-note">
        观战者只看公开信息：手牌、身份、以及朝下情报的内容都不可见。
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { PACK } from '@data/pack';
import { COLOR_LABEL, IDENTITY_LABEL } from '@data/load';
import { CardView } from './Board';
import type { RedactedState } from '@core/redact';
import type { Command, FunctionKind, PassMethod } from '@core/types';

interface Props {
  view: RedactedState;
  viewerId: string | null;
  onCommand: (cmd: Command) => void;
  error: string | null;
  onClearError: () => void;
  /** 联机托管中：这一步由 AI 代打，界面只展示不给操作 */
  readOnly?: boolean;
}

const METHOD_OPTIONS: { value: PassMethod; label: string; hint: string }[] = [
  { value: 'cipher', label: '密电', hint: '朝下逐传' },
  { value: 'text', label: '文本', hint: '朝上逐传' },
  { value: 'direct', label: '直达', hint: '指定一人' },
];

export function ActionPanel({ view, viewerId, onCommand, error, onClearError, readOnly }: Props) {
  const [sel, setSel] = useState<string[]>([]);
  const [method, setMethod] = useState<PassMethod>('cipher');
  const [target, setTarget] = useState<string>('');

  const sig = `${view.pending?.kind ?? 'none'}|${view.pending?.player ?? '-'}|${view.log.length}`;
  useEffect(() => {
    setSel([]);
    setMethod('cipher');
    setTarget('');
    onClearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const me = view.players.find((p) => p.id === viewerId) ?? null;
  const hand = me?.hand ?? [];
  const others = view.players.filter((p) => p.alive && p.id !== viewerId);

  const selDef = useMemo(() => {
    if (sel.length === 0) return null;
    const card = hand.find((c) => c.uid === sel[0]);
    return card ? PACK.cardById.get(card.defId) ?? null : null;
  }, [sel, hand]);

  const toggle = (uid: string, multi: boolean) => {
    setSel((prev) => {
      if (multi) return prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid];
      return prev[0] === uid ? [] : [uid];
    });
  };

  // 我的目标色与进度：接收决策和传出情报时都要用它给提示
  const myGoal = me && (me.identity === 'red' || me.identity === 'blue') ? me.identity : null;
  const goalNeed = PACK.config.winIntelCount;
  const myHave = myGoal && me ? me.counts[myGoal] : 0;
  const deathLine = PACK.config.deathBlackCount;

  const pending = view.pending;

  /* ---------------- 未轮到自己 ---------------- */
  if (!pending || pending.kind === 'gameOver') {
    return (
      <div className="actionbar waiting">
        <div className="actionbar-title">对局已结束</div>
      </div>
    );
  }

  if (readOnly) {
    return (
      <div className="actionbar waiting autopilot">
        <div className="actionbar-title">
          <strong>托管中</strong>
          <span className="hint">这一步由 AI 代你操作</span>
        </div>
        <div className="hint">{pending.prompt}</div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  if (pending.player !== viewerId) {
    const actor = view.players.find((p) => p.id === pending.player);
    return (
      <div className="actionbar waiting">
        <div className="actionbar-title">
          等待 <strong>{actor?.name ?? pending.player}</strong> 操作
          {actor?.isBot && <span className="hint">（AI 正在思考…）</span>}
        </div>
        <div className="hint">{pending.prompt}</div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  /* ---------------- 手牌区 ---------------- */
  const multi = pending.kind === 'discard';

  const handRow = (
    <div className="handzone">
      <div className="section-label">
        我 的 手 牌{me ? `（${hand.length} 张）` : ''}
        {me && (
          <span style={{ marginLeft: 10, letterSpacing: 0, color: 'var(--ink2)' }}>
            {me.identity ? IDENTITY_LABEL[me.identity] : '身份未知'} · {me.characterName}
          </span>
        )}
      </div>
      <div className="hand">
        {hand.map((c) => (
          <CardView
            key={c.uid}
            defId={c.defId}
            selected={sel.includes(c.uid)}
            onClick={() => toggle(c.uid, multi)}
          />
        ))}
        {hand.length === 0 && <span className="hint">手牌为空</span>}
      </div>
    </div>
  );

  /* ---------------- 各阶段操作 ---------------- */
  let body: React.ReactNode = null;

  if (pending.kind === 'action') {
    const canBurn = selDef?.fn === 'burn';
    const canShuffle = selDef?.fn === 'shuffle';
    const canProbe = selDef?.fn === 'probe';
    body = (
      <>
        <div className="actionbar-title">
          <strong>出牌阶段</strong>
          <span className="hint">可选：打出一张功能牌，或直接进入情报阶段</span>
        </div>
        <div className="action-row">
          <button className="primary" onClick={() => onCommand({ type: 'advancePhase' })}>
            结束出牌，进入情报阶段
          </button>
        </div>
        {(canBurn || canShuffle || canProbe) && (
          <div className="action-row">
            {canBurn && (
              <>
                <span className="hint">【烧毁】目标：</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">选择玩家</option>
                  {view.players
                    .filter((p) => p.alive && p.counts.black > 0)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}（黑 {p.counts.black}）
                      </option>
                    ))}
                </select>
              </>
            )}
            {canProbe && (
              <>
                <span className="hint">【试探】目标：</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">选择玩家</option>
                  {others.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}（手牌 {p.handCount}）
                    </option>
                  ))}
                </select>
              </>
            )}
            <button
              disabled={(canBurn || canProbe) && !target}
              onClick={() => {
                if (!sel[0]) return;
                onCommand({
                  type: 'playFunction',
                  cardUid: sel[0],
                  targetId: canBurn || canProbe ? target : undefined,
                });
              }}
            >
              打出【{selDef?.name}】
            </button>
          </div>
        )}
      </>
    );
  }

  if (pending.kind === 'intelDeclare') {
    const needTarget = method === 'direct';
    body = (
      <>
        <div className="actionbar-title">
          <strong>情报阶段</strong>
          <span className="hint">必须传出一张情报 —— 选一张牌，再选传递方式</span>
        </div>
        <div className="action-row">
          <span className="hint">方式：</span>
          {METHOD_OPTIONS.map((m) => (
            <button
              key={m.value}
              className={`method-btn${method === m.value ? ' active' : ''}`}
              onClick={() => setMethod(m.value)}
            >
              {m.label}
              <span style={{ opacity: 0.6, marginLeft: 4, fontSize: 11 }}>{m.hint}</span>
            </button>
          ))}
        </div>
        {needTarget && (
          <div className="action-row">
            <span className="hint">接收者：</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">选择玩家</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="action-row">
          <button
            className="primary"
            disabled={!sel[0] || (needTarget && !target)}
            onClick={() => {
              if (!sel[0]) return;
              onCommand({
                type: 'transmitIntel',
                cardUid: sel[0],
                method,
                targetId: needTarget ? target : undefined,
              });
            }}
          >
            传出这张情报
          </button>
          {selDef && (
            <span className="hint">
              将传出：【{selDef.name}】{selDef.color === 'black' ? '黑' : selDef.color === 'red' ? '红' : '蓝'}色
              {method !== 'text' && '（牌面朝下）'}
            </span>
          )}
          {/* 把自己目标颜色的情报传出去，基本等于送给对手 —— 这里必须提醒 */}
          {selDef && myGoal && selDef.color === myGoal && (
            <span className="hint warn">
              这是你要收的{COLOR_LABEL[myGoal]}色情报，传出去就收不回来了（当前 {myHave}/{goalNeed}）
            </span>
          )}
        </div>
      </>
    );
  }

  if (pending.kind === 'receive') {
    const canDecode = selDef?.fn === 'decode';
    const canReturn = selDef?.fn === 'return';
    body = (
      <>
        <div className="actionbar-title">
          <strong>接收决策</strong>
          <span className="hint">{pending.prompt}</span>
        </div>
        <div className="action-row recv-info">
          {view.flow?.color ? (
            <span className={`recv-color ${view.flow.color}`}>
              这张是{COLOR_LABEL[view.flow.color]}色情报
              {myGoal &&
                (view.flow.color === myGoal
                  ? ` —— 正是你要的（收下后 ${myHave + 1}/${goalNeed}）`
                  : view.flow.color === 'black'
                    ? ` —— 收下后黑 ${me ? me.counts.black + 1 : 1}/${deathLine}`
                    : ' —— 是对手阵营的颜色')}
            </span>
          ) : (
            <span className="recv-color unknown">
              这张情报牌面朝下，收下之后才知道颜色
            </span>
          )}
          {myGoal && me && (
            <span className="hint">
              你目前 {COLOR_LABEL[myGoal]}色 {myHave}/{goalNeed} · 黑 {me.counts.black}/{deathLine}
            </span>
          )}
        </div>
        <div className="action-row">
          <button className="primary" onClick={() => onCommand({ type: 'decideReceive', accept: true })}>
            收下
          </button>
          <button
            className="danger"
            disabled={view.flow?.locked}
            onClick={() => onCommand({ type: 'decideReceive', accept: false })}
          >
            拒收
          </button>
          {view.flow?.locked && <span className="hint">已被【锁定】，无法拒收</span>}
        </div>
        {(canDecode || canReturn) && (
          <div className="action-row">
            <button
              onClick={() => {
                if (!sel[0]) return;
                onCommand({ type: 'playFunction', cardUid: sel[0] });
              }}
            >
              使用【{selDef?.name}】
            </button>
            <span className="hint">
              {canDecode ? '破译后可看到真实牌面（仅自己可见）' : '退回给上一个传出者'}
            </span>
          </div>
        )}
      </>
    );
  }

  if (pending.kind === 'response') {
    const win = view.window;
    const isCounter = win?.kind === 'counter';
    const usable = isCounter ? selDef?.fn === 'counter' : selDef?.fn === 'intercept';
    /**
     * description 在这两个窗口里是 prompt 的**前缀**：
     *   engine.ts  截获 → prompt = '有情报正在传递 —— 是否使用【截获】拿走它？'
     *   engine.ts  识破 → prompt = `${description} —— 是否使用【识破】抵销？`
     *   redact.ts  两者都把 description 单独带出来
     * 原来两个都渲染，于是同一句话在操作区里出现两遍，白占 20px 行高 + 8px 边距。
     * 响应窗口是全游戏最挤的状态（360×640 实测操作区 264px、牌板只剩 3px），
     * 这一行买不到任何新信息。
     *
     * 用前缀判断而不是直接删掉：将来 prompt 不再包含 description 时，它会自己回来。
     */
    const descAdds = !!win?.description && !(pending.prompt ?? '').includes(win.description);
    body = (
      <>
        <div className="actionbar-title">
          <strong>{isCounter ? '识破响应' : '截获响应'}</strong>
          <span className="hint">{pending.prompt}</span>
        </div>
        {descAdds && (
          <div className="hint" style={{ marginBottom: 8 }}>
            {win!.description}
          </div>
        )}
        <div className="action-row">
          <button className="primary" onClick={() => onCommand({ type: 'pass' })}>
            放弃响应
          </button>
          {usable && (
            <button
              onClick={() => {
                if (!sel[0]) return;
                onCommand({ type: 'playFunction', cardUid: sel[0] });
              }}
            >
              使用【{selDef?.name}】
            </button>
          )}
        </div>
      </>
    );
  }

  if (pending.kind === 'discard') {
    body = (
      <>
        <div className="actionbar-title">
          <strong>弃牌阶段</strong>
          <span className="hint">{pending.prompt}</span>
        </div>
        <div className="action-row">
          <button
            className="primary"
            disabled={sel.length !== pending.need}
            onClick={() => onCommand({ type: 'discard', cardUids: sel })}
          >
            确认弃牌
          </button>
          {/* 「已选 X / N」放在按钮旁边，不塞进标题：
              塞进去会把「弃牌阶段」压成两行（360 宽实测 41px、「弃牌阶」/「段」），
              而这个数字是多选唯一的过程反馈，应该跟着手指走。 */}
          <span className={`sel-count${sel.length === pending.need ? ' ok' : ''}`}>
            已选 {sel.length} / {pending.need}
          </span>
        </div>
      </>
    );
  }

  return (
    <div className="actionbar">
      {handRow}
      <div className="action-gap" />
      {body}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function functionKindLabel(k: FunctionKind): string {
  return PACK.cards.find((c) => c.fn === k)?.name ?? k;
}

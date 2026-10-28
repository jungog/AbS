import { useLayoutEffect, useRef, useState } from 'react';
import { PACK } from '@data/pack';
import { COLOR_LABEL, METHOD_LABEL, IDENTITY_LABEL } from '@data/load';
import type { RedactedPlayer, RedactedState } from '@core/redact';
import type { IntelColor, PassMethod } from '@core/types';

/* ------------------------------------------------------------------ */
/* 单张手牌                                                            */
/* ------------------------------------------------------------------ */

export function CardView(props: {
  defId: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const def = PACK.cardById.get(props.defId);
  if (!def) return null;
  return (
    <div
      className={`card${props.selected ? ' selected' : ''}${props.disabled ? ' disabled' : ''}`}
      onClick={props.disabled ? undefined : props.onClick}
      title={def.fnText}
    >
      <div className={`card-color ${def.color}`} />
      <div className="card-fn">{def.name}</div>
      <div className="card-meta">
        <span>{COLOR_LABEL[def.color]}色</span>
        <span className="card-method">
          <i className={`method-dot ${def.method}`} />
          {METHOD_LABEL[def.method]}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 情报小方块                                                          */
/* ------------------------------------------------------------------ */

function IntelChips(props: { player: RedactedPlayer }) {
  const { intel } = props.player;
  const empty = Math.max(0, 3 - intel.length);
  return (
    <div className="intel-row">
      {intel.map((s) => (
        <div
          key={s.uid}
          className={`intel-chip ${s.color}`}
          title={`${COLOR_LABEL[s.color]}色 · ${METHOD_LABEL[s.method]} · ${s.defName}`}
        >
          {COLOR_LABEL[s.color]}
        </div>
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <div key={`e${i}`} className="intel-chip empty">
          ·
        </div>
      ))}
      {/* 用中点分隔，不用斜杠：别处的 x/y 都表示「进度 / 目标」，
          写成「红 0 / 蓝 0」会被读成两个分数 */}
      <span className="intel-count">
        红 {props.player.counts.red} · 蓝 {props.player.counts.blue} · 黑 {props.player.counts.black}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 我的情报（自己收下的，摆在底部）                                     */
/* ------------------------------------------------------------------ */

/**
 * 收下的情报会进「面前」的情报区，**不进手牌**。
 *
 * 原来只在自己玩家卡上显示成几个小色块，玩家会以为「收到的牌没进我的牌堆、丢了」。
 * 所以单独做一条，把每张情报当成牌摆出来（牌名 + 颜色 + 传递方式）。
 */
export function MyIntelStrip(props: {
  player: RedactedPlayer;
  goalColor: IntelColor | null;
  goal: number;
}) {
  const { player, goalColor, goal } = props;
  const intel = player.intel;
  const hit = goalColor ? intel.filter((s) => s.color === goalColor).length : 0;

  return (
    <div className="intel-strip">
      <div className="section-label">
        我 的 情 报（{intel.length} 张）
        {goalColor && (
          <span className={`intel-strip-goal ${goalColor}`}>
            目标 {COLOR_LABEL[goalColor]}色 {hit}/{goal}
          </span>
        )}
        <span className="intel-strip-note">收下的情报放在面前，不进手牌</span>
      </div>
      <div className="intel-cards">
        {intel.map((s) => (
          <div key={s.uid} className={`intel-card ${s.color}${goalColor === s.color ? ' goal' : ''}`}>
            <span className="intel-card-bar" />
            <span className="intel-card-name">{s.defName}</span>
            <span className="intel-card-meta">
              {COLOR_LABEL[s.color]} · {METHOD_LABEL[s.method]}
            </span>
          </div>
        ))}
        {intel.length === 0 && <span className="hint">还没有收到情报</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 玩家面板                                                            */
/* ------------------------------------------------------------------ */

export function PlayerCard(props: {
  player: RedactedPlayer;
  acting: boolean;
  isSelf: boolean;
  /**
   * 这个人已经主动离开（不是掉线）。
   *
   * 对局中离开的座位不能删（引擎状态会错位），所以卡片还会留在这儿继续由 AI 打。
   * 不标出来的话，其他人只能靠「对局日志里那行提示」知道 —— 而日志会滚走，
   * 卡片是常驻的。掉线的人不标（他 5 分钟内会回来）。
   */
  left?: boolean;
  /** 要不要显示「AI」徽标。全员都是 AI 时传 false —— 那时它区分不了任何东西，只会挤掉玩家名 */
  showBot?: boolean;
}) {
  const { player } = props;
  const identityCls =
    player.identity === 'red' ? 'red' : player.identity === 'blue' ? 'blue' : 'agent';
  return (
    <div
      data-player-id={player.id}
      className={`pcard${props.acting ? ' acting' : ''}${props.isSelf ? ' me' : ''}${
        player.alive ? '' : ' dead'
      }${props.left ? ' left' : ''}`}
    >
      <div className="pcard-head">
        <span className="pcard-seat">{player.seat + 1}</span>
        <span className="pcard-name">{player.name}</span>
        {props.showBot !== false && player.isBot && <span className="pcard-bot">AI</span>}
        {props.left && <span className="tag gone">已离开</span>}
        {player.identity ? (
          <span className={`tag ${identityCls}`}>{IDENTITY_LABEL[player.identity]}</span>
        ) : (
          <span className="tag hidden">身份未知</span>
        )}
      </div>
      <div className="pcard-char">
        <span>{player.characterName}</span>
        {player.characterHidden && <span className="tag hidden">盖伏</span>}
        {!player.alive && <span className="tag hidden">已出局</span>}
      </div>
      <IntelChips player={player} />
      <div className="pcard-foot">
        {/*
          `player.hand` 只有「自己」和「上帝视角」才非 null（见 core/redact.ts）。
          以前这里只印张数，于是上帝视角承诺的「手牌全公开」其实只公开了**数量** ——
          数据在 `view` 里躺着，界面上一个地方都没用。
          用 title 而不是把手牌铺进卡里：座位卡在 360 宽上只有 157px，
          铺开会把卡片撑高、并挤掉下面「黑 0/3」那行。hover 能看到牌名就够了，
          这个模式本来就是在桌面上用的。
        */}
        <span
          title={
            player.hand
              ? player.hand.map((c) => PACK.cardById.get(c.defId)?.name ?? c.defId).join('、')
              : undefined
          }
        >
          手牌 {player.handCount}
        </span>
        {props.isSelf && player.identity && player.identity !== 'agent' ? (
          // 自己身上直接显示「离目标还差几张」，比原始计数有用得多
          <span className={`pcard-goal ${player.identity}`}>
            {COLOR_LABEL[player.identity]} {player.counts[player.identity]}/{PACK.config.winIntelCount}
          </span>
        ) : null}
        <span>
          {player.counts.black >= PACK.config.deathBlackCount - 1 ? (
            <b style={{ color: 'var(--red)' }}>
              黑 {player.counts.black}/{PACK.config.deathBlackCount}
              {player.counts.black >= PACK.config.deathBlackCount ? '' : ' 濒死'}
            </b>
          ) : (
            `黑 ${player.counts.black}/${PACK.config.deathBlackCount}`
          )}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 传递中的情报                                                        */
/* ------------------------------------------------------------------ */

export function TransitStrip(props: { view: RedactedState }) {
  const { flow, players } = props.view;
  if (!flow) return null;
  const nameOf = (id: string | null) =>
    id ? players.find((p) => p.id === id)?.name ?? id : '—';
  const colorText = flow.color ? `${COLOR_LABEL[flow.color]}色` : '牌面朝下';
  return (
    <div
      style={{
        border: '1px solid var(--gold)',
        background: '#fff',
        borderRadius: 3,
        padding: '9px 14px',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 12.5,
        flex: 'none',
      }}
    >
      <span style={{ color: 'var(--gold)', fontWeight: 700, letterSpacing: '0.1em' }}>传递中</span>
      <span>
        {nameOf(flow.source)} → <b>{nameOf(flow.current)}</b>
      </span>
      <span style={{ color: 'var(--ink3)' }}>
        【{METHOD_LABEL[flow.method]}】{colorText}
      </span>
      {flow.locked && <span style={{ color: 'var(--red)', fontWeight: 700 }}>已锁定</span>}
      {flow.skipped.length > 0 && (
        <span style={{ color: 'var(--ink3)' }}>跳过 {flow.skipped.map(nameOf).join('、')}</span>
      )}
      {flow.remainingPath.length > 0 && (
        <span style={{ color: 'var(--ink3)' }}>
          后续：{flow.remainingPath.map(nameOf).join(' → ')}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

export function LogPanel(props: { view: RedactedState }) {
  const items = props.view.log.slice(-120);
  const listRef = useRef<HTMLDivElement | null>(null);
  /**
   * 是否跟着最新一条走。用户往上翻（离开底部 24px 以上）就停下，
   * 自己翻回底部附近再跟上 —— 手机上一屏只放得下两三行，
   * 想看清上一手到底传了什么，必须能停住。
   */
  const stickRef = useRef(true);
  const total = props.view.log.length;
  /** 上次渲染时的条数：用来算「翻上去之后又来了几条」 */
  const seenRef = useRef(total);
  /**
   * 未读条数 / 是否在底部，两个都要 state —— 浮在底部的那颗
   * 「↓ N 条新消息」得靠它们决定显不显示。
   *
   * 为什么需要它：日志不再抢滚动之后（见下面的 useLayoutEffect），
   * 用户翻上去读历史时，新消息会静静地堆在下面。手机上一屏只有两三行，
   * 用户没有任何线索知道「下面还有」，只能自己想起来往下拨。
   */
  const [unseen, setUnseen] = useState(0);
  const [atBottom, setAtBottom] = useState(true);

  // 只在**新日志进来**时滚，而且只在「原本就贴底」时滚。
  //
  // 原来写的是 `ref={(el) => el && (el.scrollTop = el.scrollHeight)}`：
  // 内联 ref 回调每次渲染都会执行，等于无条件滚到底 ——
  // 360×640 实测：翻到顶（scrollTop 0），对面一出牌就变成 199（= 最底部），
  // 历史根本读不了。日志区在那儿只有 62px 高，约两行半。
  useLayoutEffect(() => {
    const el = listRef.current;
    const grew = total - seenRef.current;
    seenRef.current = total;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      // 已经贴底就不算未读。setUnseen(0) 在本来就是 0 时 React 会跳过重渲染。
      setUnseen(0);
      return;
    }
    if (grew > 0) setUnseen((n) => n + grew);
  }, [total]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    stickRef.current = bottom;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
    if (bottom) setUnseen(0);
  };

  const jumpToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setUnseen(0);
  };

  return (
    <div className="battle-side">
      <div className="log-head">情 报 日 志</div>
      <div className="log-wrap">
        <div className="log-list" ref={listRef} onScroll={onScroll}>
          {items.map((e) => (
            <div
              key={e.seq}
              className={`log-item ${e.tone ?? 'normal'}${e.secretTo ? ' secret' : ''}`}
            >
              {e.secretTo ? '〔仅你可见〕' : ''}
              {e.text}
            </div>
          ))}
        </div>
        {!atBottom && unseen > 0 && (
          <button className="log-jump" onClick={jumpToLatest} title="回到最新一条">
            ↓ {unseen} 条新消息
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 结算浮层                                                            */
/* ------------------------------------------------------------------ */

export function ResultOverlay(props: {
  view: RedactedState;
  onRestart: () => void;
  /** 按钮文案：本地是「再来一局」，联机是「返回大厅」 */
  label?: string;
  /**
   * 联机：准备进度。传了就变成「准备制」——
   * 点按钮不是立刻重开，而是给自己投一票，全员准备好才开局。
   * 房主一键重开会把还在复盘的人直接掀桌，比不让重开更难受。
   */
  ready?: { count: number; total: number; offline: number; mine: boolean };
  /** 次要按钮（联机用来放「返回大厅」） */
  secondary?: { label: string; onClick: () => void };
  /**
   * 回到房间页调座位 / 调下一局人数。
   *
   * 不做成「对局一结束就自动跳回房间页」—— 那会把正在看结算、正在复盘的人
   * 直接掀桌。入口放这儿，想去调的人自己点。
   */
  onArrange?: () => void;
}) {
  const { winner, players } = props.view;
  if (!winner) return null;
  const sideLabel =
    winner.side === 'red' ? '潜伏战线' : winner.side === 'blue' ? '军情局' : '特工';
  const ready = props.ready;

  return (
    <div className="overlay">
      <div className="result">
        <div className="side">对 局 结 束</div>
        <h2>{sideLabel} 获胜</h2>
        <p>{winner.reason}</p>
        <div className="winners">
          {winner.winners.map((id) => {
            const p = players.find((x) => x.id === id);
            return (
              <span key={id} className="winner-chip">
                {p?.name ?? id}
              </span>
            );
          })}
        </div>

        {ready && (
          <div className="ready-row">
            <span
              className={`ready-count${ready.total > 0 && ready.count >= ready.total ? ' full' : ''}`}
            >
              准备 {ready.count} / {ready.total}
            </span>
            <span className="hint">
              {ready.total > 0 && ready.count >= ready.total
                ? '开局中…'
                : ready.offline > 0
                  ? `全员准备后自动开始 · ${ready.offline} 人掉线（自动算准备）`
                  : '全员准备后自动开始下一局'}
            </span>
            {props.onArrange && (
              <button className="ready-arrange" onClick={props.onArrange}>
                调整座位 / 人数
              </button>
            )}
          </div>
        )}

        <div className="result-actions">
          <button
            className={`primary${ready?.mine ? ' is-ready' : ''}`}
            onClick={props.onRestart}
          >
            {ready
              ? ready.mine
                ? '已准备 · 点此取消'
                : '再来一局'
              : (props.label ?? '再来一局')}
          </button>
          {props.secondary && (
            <button className="ghost" onClick={props.secondary.onClick}>
              {props.secondary.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function colorClass(c: IntelColor): string {
  return c;
}

export function methodLabel(m: PassMethod): string {
  return METHOD_LABEL[m];
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocalGame, type Mode } from '@ui/hooks/useLocalGame';
import { useOnlineGame, type OnlineGame } from '@ui/hooks/useOnlineGame';
import { useBattleAnim } from '@ui/hooks/useBattleAnim';
import { ActionPanel } from '@ui/components/ActionPanel';
import { CharacterPick } from '@ui/components/CharacterPick';
import { SpectatorPanel, describePhase } from '@ui/components/SpectatorPanel';
import {
  CardView,
  LogPanel,
  MyIntelStrip,
  PlayerCard,
  ResultOverlay,
  TransitStrip,
} from '@ui/components/Board';
import { GoalBar } from '@ui/components/GoalBar';
import { PACK } from '@data/pack';
import {
  AutopilotBar,
  CountdownRing,
  ReconnectOverlay,
  RoundBanner,
} from '@ui/components/OnlineChrome';
import { LobbyPage } from '@ui/pages/LobbyPage';
import { RoomPage } from '@ui/pages/RoomPage';
import { inviteRoomFromUrl, lastRoom } from '@net/protocol';
import { PUBLIC_VIEW } from '@core/redact';
import type { RedactedState } from '@core/redact';
import type { Command } from '@core/types';

/* ------------------------------------------------------------------ */
/* 战斗视图（本地 / 联机共用）                                          */
/* ------------------------------------------------------------------ */

function BattleShell(props: {
  view: RedactedState;
  viewerId: string | null;
  onCommand: (cmd: Command) => void;
  error: string | null;
  onClearError: () => void;
  onRestart?: () => void;
  restartLabel?: string;
  banner?: React.ReactNode;
  /** 联机：当前操作点剩余时间（null = 无倒计时） */
  remainMs?: number | null;
  /** 联机：自己被托管时显示「我回来了」 */
  autopilot?: boolean;
  onTakeback?: () => void;
  /** 联机：正在重连 */
  reconnecting?: boolean;
  retry?: number;
  /** 联机：服务端提示（回座成功、房间关闭等） */
  notice?: string | null;
  onClearNotice?: () => void;
  /** 观战者：不显示操作区，换成只读的观战面板 */
  spectator?: boolean;
  /** 观战落后几轮（观战面板据此把时态拉开） */
  spectatorDelayRounds?: number;
  /** 联机：结算页的准备进度。传了就把「再来一局」变成准备投票 */
  readyInfo?: { count: number; total: number; offline: number; mine: boolean };
  /** 联机：结算页的次要按钮（返回大厅 / 退出观战） */
  onLeave?: () => void;
  leaveLabel?: string;
  /** 联机：从结算页回房间调座位 / 下一局人数 */
  onArrange?: () => void;
  /** 联机：已主动离开的引擎玩家 id（座位卡上标「已离开」） */
  leftIds?: Set<string>;
}) {
  const { view, viewerId } = props;
  const { roundBanner, bannerRound } = useBattleAnim(view);
  const actorId = view.pending && view.pending.kind !== 'gameOver' ? view.pending.player : null;
  const turnPlayer = view.players[view.turnIndex];
  const actor = actorId ? view.players.find((p) => p.id === actorId) : null;
  const me = view.players.find((p) => p.id === viewerId) ?? null;
  // 操作区自己会渲染手牌（可点选）时不要重复渲染；托管时操作区是只读的，所以仍要显示
  const showHandStrip =
    Boolean(me?.hand?.length) && (view.pending?.player !== viewerId || Boolean(props.autopilot));

  return (
    <div className="battle">
      <div className="battle-main">
        {props.notice && (
          <div className="notice battle-notice">
            {props.notice}
            {props.onClearNotice && (
              <button className="ghost" onClick={props.onClearNotice}>
                知道了
              </button>
            )}
          </div>
        )}
        {props.banner}
        <div className="statusbar">
          {/* 观众看到的是落后 N 轮的旧画面，`view.round` 因此不是「现在第几轮」。
              不写「当时」的话，这颗 pill 就是在骗人：它把旧局面说成现在。
              观众没法操作、也就没法通过「我能不能出牌」反推时态，
              所以时态必须由这颗 pill 自己说清楚。 */}
          <span className="pill">
            {props.spectator ? '当时 第 ' : '第 '}
            {view.round} 轮
          </span>
          <span className="pill turn">{turnPlayer?.name ?? '—'} 的回合</span>
          {/* 观众没有操作区 —— 玩家的阶段靠按钮文案体现（「结束出牌」/「收下」），
              观众只能靠这颗 pill。它顶替了下面那颗「等待：谁」的位置：
              谁在动，座位卡上的 acting 高亮已经说了，不必再写一遍。 */}
          {props.spectator && <span className="pill">{describePhase(view)}</span>}
          <span className="pill">
            牌库 {view.deckCount} · 弃牌 {view.discardCount}
          </span>
          {/* 轮到别人时才写「等待：谁」。
              轮到自己时这句话是废话（金色的「X 的回合」已经说了），
              而 360px 宽上它会把计时环挤到下一行、白占 30px 高度。
              观众也不写：观众不在等待任何东西，他们在看。 */}
          {actorId && actorId !== viewerId && !props.spectator && (
            <span className="pill">
              等待：{actor?.name ?? actorId}
              {actor?.isBot && <span className="pill-inline">AI</span>}
            </span>
          )}
          {props.remainMs !== null && props.remainMs !== undefined && (
            <CountdownRing remainMs={props.remainMs} />
          )}
          {view.stats.deaths > 0 && <span className="pill warn">出局 {view.stats.deaths}</span>}
        </div>

        <GoalBar view={view} viewerId={viewerId} />

        <div className="board-wrap">
          <div className="board">
            {view.players.map((p) => (
              <PlayerCard
                key={p.id}
                player={p}
                acting={p.id === actorId}
                isSelf={p.id === viewerId}
                left={props.leftIds?.has(p.id)}
              />
            ))}
          </div>
          <RoundBanner round={bannerRound} show={roundBanner} />
        </div>

        <TransitStrip view={view} />

        {props.autopilot && props.onTakeback && <AutopilotBar onTakeback={props.onTakeback} />}

        {props.spectator ? (
          <SpectatorPanel
            view={view}
            actor={actor ?? null}
            delayRounds={props.spectatorDelayRounds ?? 0}
          />
        ) : view.pending?.kind === 'pickCharacter' && view.pending.player === viewerId ? (
          <CharacterPick view={view} onCommand={props.onCommand} />
        ) : (
          <ActionPanel
            view={view}
            viewerId={viewerId}
            onCommand={props.onCommand}
            error={props.error}
            onClearError={props.onClearError}
            readOnly={props.autopilot}
          />
        )}

        {/* 收下的情报不进手牌，必须单独摆出来 —— 否则玩家会以为「收到的牌丢了」 */}
        {!props.spectator && me && (
          <MyIntelStrip
            player={me}
            goalColor={
              me.identity === 'red' || me.identity === 'blue' ? me.identity : null
            }
            goal={PACK.config.winIntelCount}
          />
        )}

        {/* 不是自己回合时，操作区不显示手牌 —— 但玩家永远想看着自己的牌，
            所以这里补一条只读手牌条。margin-top:auto 让它贴在底部，顺便把留白填掉。 */}
        {showHandStrip && me?.hand && (
          <div className="hand-strip">
            <div className="section-label">
              我 的 手 牌（{me.hand.length} 张）
              <span className="hand-strip-note">
                {props.autopilot ? '托管中，AI 正在替你出牌' : '等待中，轮到你时才能操作'}
              </span>
            </div>
            <div className="hand">
              {me.hand.map((c) => (
                <CardView key={c.uid} defId={c.defId} disabled />
              ))}
            </div>
          </div>
        )}
      </div>

      <LogPanel view={view} />

      {view.winner && props.onRestart && (
        <ResultOverlay
          view={view}
          onRestart={props.onRestart}
          label={props.restartLabel}
          ready={props.readyInfo}
          onArrange={props.onArrange}
          secondary={
            props.onLeave ? { label: props.leaveLabel ?? '返回大厅', onClick: props.onLeave } : undefined
          }
        />
      )}

      {props.reconnecting && <ReconnectOverlay retry={props.retry ?? 0} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 本地启动面板                                                        */
/* ------------------------------------------------------------------ */

const MODES: { key: Mode; title: string; desc: string }[] = [
  {
    key: 'ai',
    title: '单人 + AI 陪练',
    desc: '你坐 1 号位，其余由 AI 填充。适合熟悉规则、验证数值。',
  },
  {
    key: 'hotseat',
    title: '单机热座',
    desc: '同一台设备轮流操作，视角自动切到当前行动者。适合几个人围着电脑打。',
  },
  {
    key: 'god',
    title: '上帝视角',
    desc: '所有身份与手牌全公开，用来观察规则流程与调试。',
  },
];

function LaunchLocal(props: {
  onStart: (opts: { playerCount: number; mode: Mode }) => void;
  speed: number;
  setSpeed: (n: number) => void;
}) {
  const [mode, setMode] = useState<Mode>('ai');
  const [count, setCount] = useState(5);

  return (
    <div className="launch">
      <h1>风声再临 · 线上版</h1>
      <div className="sub">核心战斗模块 v1 —— 情报传递 / 响应点 / 功能牌 / 阵营胜负</div>

      <div className="mode-grid">
        {MODES.map((m) => (
          <div
            key={m.key}
            className={`mode-card${mode === m.key ? ' active' : ''}`}
            onClick={() => setMode(m.key)}
          >
            <h3>{m.title}</h3>
            <p>{m.desc}</p>
          </div>
        ))}
      </div>

      <div className="field">
        <label>人数</label>
        <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {[3, 4, 5, 6, 7].map((n) => (
            <option key={n} value={n}>
              {n} 人
            </option>
          ))}
        </select>
      </div>

      {mode === 'ai' && (
        <div className="field">
          <label>AI 速度</label>
          <select value={props.speed} onChange={(e) => props.setSpeed(Number(e.target.value))}>
            <option value={900}>慢（900ms）</option>
            <option value={280}>正常（280ms）</option>
            <option value={80}>快（80ms）</option>
          </select>
        </div>
      )}

      <button className="primary" onClick={() => props.onStart({ playerCount: count, mode })}>
        开始对局
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 联机流程：大厅 → 房间 → 对局                                        */
/* ------------------------------------------------------------------ */

/** 观战延迟的文案。刻意不用「延迟」二字 —— 状态栏里已有一个「延迟 12ms」表示网络往返 */
function describeSpectatorDelay(rounds: number): string {
  return rounds > 0 ? `慢 ${rounds} 轮` : '';
}

function OnlineFlow(props: { online: OnlineGame }) {
  const { online } = props;
  const spectator = online.role === 'spectator';

  const inGame = online.started && online.view;
  const inRoom =
    !inGame &&
    (online.status === 'joined' || (online.status === 'reconnecting' && online.seats.length > 0));

  /**
   * 结算页点「调整座位 / 人数」→ 临时回到房间页。
   *
   * 只在上一局已结束（gameOver）时有效：对局进行中座位是锁死的，
   * 让人进得去再告诉他不能改，不如不给入口。
   * 下一局一开（gameOver 变 false）就自动收回，免得这一局的结算又把人送进房间页。
   */
  const [showRoom, setShowRoom] = useState(false);
  useEffect(() => {
    if (!online.gameOver) setShowRoom(false);
  }, [online.gameOver]);

  if (showRoom && !spectator && online.gameOver) {
    return <RoomPage online={online} onBack={() => setShowRoom(false)} />;
  }

  if (inGame) {
    // 谁已经主动离开了（换成引擎玩家 id，座位卡按它标「已离开」）。
    // 掉线的人不算 —— 他的座位还在宽限期里，随时会回来。
    const leftIds = new Set(
      online.seats.filter((s) => s.left && s.gamePlayerId).map((s) => s.gamePlayerId as string),
    );
    return (
      <BattleShell
        view={online.view!}
        leftIds={leftIds}
        // 观战者没有 gamePlayerId（那是 null）。传 null 会被当成「上帝视角」，
        // 操作区就会去比对自己的手牌 —— 必须传一个绝不匹配任何玩家的哨兵值。
        viewerId={spectator ? PUBLIC_VIEW : online.gamePlayerId}
        onCommand={online.send}
        error={online.error}
        onClearError={online.clearError}
        // 玩家点「再来一局」是投票，不是立刻重开（全员准备好才开局）；
        // 观众没资格投票，那个按钮对他就是「退出观战」。
        onRestart={spectator ? online.leave : online.rematch}
        restartLabel={spectator ? '退出观战' : '再来一局'}
        readyInfo={
          spectator
            ? undefined
            : {
                count: online.ready.count,
                total: online.ready.total,
                offline: online.ready.offline,
                mine: online.myReady,
              }
        }
        onLeave={spectator ? undefined : online.leave}
        onArrange={spectator ? undefined : () => setShowRoom(true)}
        // 重连中 / 托管中都不显示倒计时：那两个时刻的剩余时间没有意义，
        // 显示成 0 只会让人以为「已经超时了」
        remainMs={online.autopilot || online.status === 'reconnecting' ? null : online.remainMs}
        autopilot={!spectator && online.autopilot}
        onTakeback={spectator ? undefined : online.takeback}
        spectator={spectator}
        spectatorDelayRounds={online.spectatorDelayRounds}
        reconnecting={online.status === 'reconnecting'}
        retry={online.retry}
        notice={online.notice}
        onClearNotice={online.clearNotice}
        banner={
          // room-strip：和下面的对局状态条同样是 .statusbar，但它是「房间号 + 离开」，
          // 矮屏上要单独收一点（见 goal.css 的 max-height: 700px）
          <div className="statusbar room-strip">
            {/* 观众不显示房间号。实测 360 宽下这条 4 个元素要 384px、可用只有 324px，
                必然折行，而折行与否取决于「延迟」pill 什么时候到 —— 首帧没有它时是 1 行，
                1 秒后它到了就变 2 行，整块内容往下跳 28px。
                观众的房间里没有他的座位，房间号对他是最没用的一颗。 */}
            {!spectator && <span className="pill">房间 {online.room}</span>}
            {spectator ? (
              <span className="pill spec-pill">
                观战中 · 只看公开信息
                {describeSpectatorDelay(online.spectatorDelayRounds) &&
                  ` · ${describeSpectatorDelay(online.spectatorDelayRounds)}`}
              </span>
            ) : (
              <span className="pill">联机</span>
            )}
            {/* 延迟对观众没有意义：观众不能操作，延迟不影响任何操作。
                它也是这条里唯一「晚到」的元素，留着就得为它预留一整行的宽度。 */}
            {!spectator && online.latency !== null && <span className="pill">延迟 {online.latency}ms</span>}
            {online.status === 'reconnecting' && <span className="pill warn">重连中</span>}
            <button className="ghost" onClick={online.leave}>
              {spectator ? '退出观战' : '离开'}
            </button>
          </div>
        }
      />
    );
  }

  // 观众没有座位：如果 room 先到、state 还没到，RoomPage 会显示「等待房主开始」，
  // 那是给玩家看的。这里给观众一个明确的过渡态，避免闪一下看不懂的界面。
  if (spectator && !online.view) {
    return (
      <div className="lobby">
        <div className="lobby-empty">
          <div className="hint">正在进入观战…</div>
        </div>
      </div>
    );
  }

  if (inRoom) return <RoomPage online={online} />;
  return <LobbyPage online={online} />;
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export function BattlePage() {
  const local = useLocalGame();
  const online = useOnlineGame();
  // 刷新页面时如果还有没失效的座位，直接落在联机页 —— 否则 hook 会悄悄回座，
  // 用户却还停在「本地对局」，看起来像是卡住了
  //
  // 邀请链接（`?room=ABCD`）同样要落在联机页，而且这一条比上面那条更硬：
  // 朋友点链接进来时 localStorage 是**空的**，`lastRoom()` 必然为 null，
  // 于是默认落到「本地对局」—— 而 `LobbyPage` 只有在 tab==='online' 时才挂载，
  // 它里面的 `inviteRoomFromUrl()` 一次都不会跑。表现为「点邀请链接，
  // 打开的是单人 AI 陪练的选人页」，房间号连读都没读到。
  // 这条路径以前一直被测试遮着：ui-online / shots-spectate 都是先手动点一下
  // 「联机对局」再断言房间号已填好 —— 测试替用户切了页签，bug 就藏住了。
  const [tab, setTab] = useState<'local' | 'online'>(() =>
    lastRoom() || inviteRoomFromUrl() ? 'online' : 'local',
  );

  // 联机一旦进了对局，就不给切走的机会（切走等于掉线）
  const lockedInOnlineGame = tab === 'online' && online.started && online.view;

  /**
   * 大厅 / 房间 / 对局三屏共用下面那一个滚动容器，换屏时**必须**把滚动位置归零。
   *
   * 滚动是点击自己带进来的：为了够到大厅底部的「创建并进入」，浏览器会先把容器
   * scroll-into-view，**这一下发生在换屏之前**。给容器挂 scroll 监听实测
   * （844×390，点「创建并进入」）：
   *   t=344ms  top 232 / max 1625   screen=lobby   ← 点击前的 scrollIntoView
   *   t=363ms  top   0 / max  248   screen=room    ← 换屏（这一条是归零之后的）
   * 换屏时 React 只换了子节点、没换容器，232 被原样带进房间页（房间页 max 248，
   * 232 不用钳），于是房间页一打开就滚在下半截：「房间号」和「复制邀请链接」
   * 被顶到容器可视区上方（邀请按钮 top = 9，容器可视顶边 113）。
   *
   * 360×640 上更彻底：大厅 max 5810，点击时直接滚到底（top 5810），
   * 换屏后被钳到房间页的 max 286 —— **房间页一打开就是最底下**，
   * 房间号、邀请链接全在屏外，而这正是玩家最需要念给朋友的那两样。
   * 大厅越小（需要滚越多）泄漏越严重，所以这不是横屏专属。
   *
   * 判据不用「当前是第几屏」的字符串 —— 那等于把 OnlineFlow 里的
   * inGame / inRoom / 观战过渡态再抄一遍，抄漏一处就是下一个 bug。
   * 直接拿容器的第一个子元素当身份：`.lobby` / `.room` / `.battle` / `.launch`
   * 是四个不同组件的根节点，换屏时 React 必然换掉这个元素；元素变了就是换屏了。
   * 用 useLayoutEffect 而不是 useEffect：后者在绘制之后才跑，会先闪一帧错误位置
   * （实测归零发生在 t=363ms，也就是 `.room` 挂载的同一帧）。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScreen = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const screen = el.firstElementChild;
    if (!screen || screen === lastScreen.current) return;
    lastScreen.current = screen;
    el.scrollTop = 0;
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {!lockedInOnlineGame && (
        <div className="tabs-line">
          <button
            className={tab === 'local' ? 'primary' : ''}
            onClick={() => setTab('local')}
            style={{ fontSize: 12.5 }}
          >
            本地对局
          </button>
          <button
            className={tab === 'online' ? 'primary' : ''}
            onClick={() => setTab('online')}
            style={{ fontSize: 12.5 }}
          >
            联机对局
          </button>
        </div>
      )}

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'local' ? (
          local.view ? (
            <div style={{ height: '100%' }}>
              <BattleShell
                view={local.view}
                viewerId={local.viewerId}
                onCommand={local.send}
                error={local.error}
                onClearError={local.clearError}
                onRestart={local.reset}
                restartLabel="再来一局"
                banner={
                  <div className="statusbar">
                    <span className="pill">
                      {local.mode === 'ai'
                        ? '单人 + AI'
                        : local.mode === 'hotseat'
                          ? '热座'
                          : '上帝视角'}
                    </span>
                    <button className="ghost" onClick={local.reset}>
                      退出本局
                    </button>
                  </div>
                }
              />
            </div>
          ) : (
            <LaunchLocal onStart={local.start} speed={local.speed} setSpeed={local.setSpeed} />
          )
        ) : (
          <OnlineFlow online={online} />
        )}
      </div>
    </div>
  );
}

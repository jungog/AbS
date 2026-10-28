/**
 * 房间等待页：座位、邀请码、房主开局
 *
 * 座位卡片要能看出三件事：谁在线、谁被托管、谁是机器人。
 * 掉线的人不踢走（保座 5 分钟），只是变灰 + 标「掉线」。
 *
 * 这个页面有两种状态，共用同一套座位表：
 *  1. **等首局**：房主选人数、点开始
 *  2. **等下一局**（`online.gameOver`）：没有「开始对局」按钮，
 *     换成准备进度 —— 否则房主能一键绕过别人已经点过的准备。
 *     会看到这一屏的通常是「上一局打完之后才进来的人」，所以还要说明白
 *     他不是走错房间了。
 *
 * 座位可以点着换：座位顺序 = 行动顺序 = 情报传递方向（密电 / 文本按座位往下传），
 * 所以「谁挨着谁」是有策略意义的，不是纯外观。开局之后锁死。
 */
import { useState } from 'react';
import { inviteLink } from '@net/protocol';
import type { OnlineGame } from '@ui/hooks/useOnlineGame';

export function RoomPage(props: {
  online: OnlineGame;
  /** 从结算页进来时给一条退路；正常进房间时没有这个按钮 */
  onBack?: () => void;
}) {
  const { online } = props;
  const [count, setCount] = useState(5);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const humans = online.seats.filter((s) => !s.isBot);
  const bots = online.seats.filter((s) => s.isBot);
  const mySeat = online.seats.find((s) => s.playerId === online.playerId);
  const needed = Math.max(0, count - humans.length);
  /**
   * 掉线的人还占着座位（5 分钟保座宽限期），开局时**照样算进人数**，
   * 只是由 AI 代打 —— 这是刻意的：刷新页面的人不该被踢出去。
   * 但房主点「开始对局」之前得知道这件事，否则他以为「3 个人打」，
   * 实际是「2 个人 + 1 个 AI」。
   */
  const offline = humans.filter((s) => !s.connected);
  /** 上一局已结束、正在等下一局 */
  const finished = online.gameOver;

  /**
   * 能不能换座：还没开局，或者两局之间。
   * 对局进行中锁死 —— 座位顺序就是行动顺序，中途换等于改规则。
   */
  const canArrange = !online.started || finished;
  const mySeatNo = mySeat?.seat ?? -1;
  const [picked, setPicked] = useState<number | null>(null);
  const [seatHint, setSeatHint] = useState<string | null>(null);

  const onSeatClick = (seat: number) => {
    if (!canArrange) return;

    if (picked === null) {
      // 非房主只能从自己开始：否则两个人可以互相把人踢来踢去
      if (!online.isHost && seat !== mySeatNo) {
        setSeatHint('只有房主可以调整别人的座位 —— 点自己的座位开始换');
        return;
      }
      setSeatHint(null);
      setPicked(seat);
      return;
    }
    if (picked === seat) {
      setPicked(null);
      setSeatHint(null);
      return;
    }
    online.swapSeats(picked, seat);
    setPicked(null);
    setSeatHint(null);
  };

  const copy = async (what: 'code' | 'link') => {
    const text = what === 'code' ? online.room : inviteLink(online.room);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // 非 HTTPS / 无剪贴板权限时 clipboard 会直接抛。
      // 退一步把内容选中，用户按 Ctrl+C 也能拿到。
      setCopied(null);
    }
  };

  return (
    <div className="room">
      <div className="room-head">
        <div>
          <div className="section-label">房间号</div>
          <div className="room-bigcode" onClick={() => copy('code')} title="点击复制房间号">
            {online.room}
          </div>
          <div className="hint">
            {copied === 'code' ? '房间号已复制' : '点一下复制房间号，或直接发邀请链接'}
          </div>
          <div className="room-links">
            <button className="ghost" onClick={() => copy('link')}>
              {copied === 'link' ? '链接已复制' : '复制邀请链接'}
            </button>
            <span className="hint">点开链接的人会自动带入房间号</span>
          </div>
        </div>
        <div className="room-side">
          {finished && <div className="pill over-pill">上一局已结束 · 等下一局</div>}
          <div className="pill">{online.isPublic ? '公开房间' : '私密房间'}</div>
          {online.hasPassword && <div className="pill">有密码</div>}
          <div className="pill">{humans.length} 人在座</div>
          {props.onBack && (
            <button className="ghost" onClick={props.onBack}>
              返回结算
            </button>
          )}
          {online.spectators > 0 && <div className="pill spec-pill">{online.spectators} 人观战</div>}
          {online.latency !== null && <div className="pill">延迟 {online.latency}ms</div>}
          <button className="ghost" onClick={online.leave}>
            离开房间
          </button>
        </div>
      </div>

      {online.error && (
        <div className="error banner-error">
          {online.error}
          <button className="ghost" onClick={online.clearError}>
            知道了
          </button>
        </div>
      )}
      {online.notice && (
        <div className="notice">
          {online.notice}
          <button className="ghost" onClick={online.clearNotice}>
            知道了
          </button>
        </div>
      )}

      <div className="section-label">
        座位
        {canArrange && (
          <span className="seat-hint">
            {picked === null
              ? '点两个座位可以交换位置'
              : `已选中 ${picked + 1} 号位，再点一个座位完成交换`}
          </span>
        )}
      </div>
      {seatHint && <div className="hint seat-hint-warn">{seatHint}</div>}
      <div className="seat-grid">
        {Array.from({ length: 7 }, (_, i) => {
          const s = online.seats.find((x) => x.seat === i);
          if (!s) {
            return (
              <div key={`empty-${i}`} className="seat empty">
                <div className="seat-no">{i + 1}</div>
                <div className="seat-name">空位</div>
                <div className="seat-tags">
                  <span className="tag">等待加入</span>
                </div>
              </div>
            );
          }
          const me = s.playerId === online.playerId;
          const isPicked = picked === i;
          return (
            <div
              key={s.playerId}
              className={`seat${me ? ' me' : ''}${!s.connected && !s.isBot ? ' offline' : ''}${
                s.left ? ' left' : ''
              }${isPicked ? ' picked' : ''}${canArrange ? ' swappable' : ''}`}
              onClick={() => onSeatClick(i)}
              title={canArrange ? '点一下选中，再点另一个座位完成交换' : undefined}
            >
              <div className="seat-no">{i + 1}</div>
              <div className="seat-name">
                {s.name}
                {me && <span className="tag me-tag">你</span>}
              </div>
              <div className="seat-tags">
                {s.playerId === online.hostId && <span className="tag host-tag">房主</span>}
                {s.isBot && <span className="tag">AI</span>}
                {/* 「已离开」和「掉线」必须分开说：掉线的人 5 分钟内会回来，
                    走了的人不会。都标成「掉线」的话，其他人会一直等他重连。 */}
                {s.left ? (
                  <>
                    <span className="tag gone">已离开</span>
                    {s.autopilot && <span className="tag">AI 代打</span>}
                  </>
                ) : (
                  <>
                    {!s.isBot && !s.connected && <span className="tag warn">掉线</span>}
                    {!s.isBot && s.connected && <span className="tag ok">在线</span>}
                    {s.autopilot && <span className="tag warn">托管</span>}
                  </>
                )}
                {finished && s.ready && <span className="tag ok">已准备</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* 换座不是调外观：座位顺序就是行动顺序，也是情报传递方向。
          不说明的话，玩家会以为这只是「把头像摆好看」。 */}
      {canArrange && humans.length > 1 && (
        <div className="seat-why">
          座位顺序 = 行动顺序 = 情报传递方向。想让谁挨着谁，在这里调。
        </div>
      )}

      <div className="room-actions">
        {finished ? (
          <>
            <div className="field-inline">
              <span className="ready-count">
                准备 {online.ready.count} / {online.ready.total}
              </span>
              <span className="hint">
                {online.ready.count >= online.ready.total ? '开局中…' : '全员准备后自动开始'}
              </span>
            </div>
            {online.isHost && (
              <div className="field-inline">
                <label className="inline-label">下一局 AI</label>
                <select
                  value={bots.length}
                  onChange={(e) => online.setBots(Number(e.target.value))}
                  title="调整机器人数会重排座位号，但「谁挨着谁」的相对顺序不变"
                >
                  {[0, 1, 2, 3, 4].map((n) => (
                    <option key={n} value={n} disabled={humans.length + n < 3}>
                      {n} 个
                    </option>
                  ))}
                </select>
                <span className="hint">
                  共 {humans.length + bots.length} 人
                  {humans.length + bots.length < 3 && '（不足 3 人）'}
                </span>
              </div>
            )}
            {mySeat && (
              <button
                className={`primary${online.myReady ? ' is-ready' : ''}`}
                onClick={online.rematch}
              >
                {online.myReady ? '已准备 · 点此取消' : '准备下一局'}
              </button>
            )}
          </>
        ) : online.isHost ? (
          <>
            <div className="field-inline">
              <label className="inline-label">总人数</label>
              <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={n}>
                    {n} 人
                  </option>
                ))}
              </select>
              <span className="hint">
                当前 {humans.length} 人，将补 {needed} 个 AI
              </span>
            </div>
            {offline.length > 0 && (
              <div className="hint warn">
                {offline.length} 人掉线：开局后由 AI 代打，他们回来点「我回来了」就能收回。
              </div>
            )}
            <button
              className="primary"
              onClick={() => online.startGame(count, needed)}
              disabled={count < 3}
            >
              开始对局
            </button>
          </>
        ) : (
          <div className="hint">
            等待房主开始对局…
            {mySeat && ` 你在 ${mySeat.seat + 1} 号位`}
          </div>
        )}
      </div>
    </div>
  );
}

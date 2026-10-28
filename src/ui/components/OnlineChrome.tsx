/**
 * 联机相关的界面零件：倒计时环、托管提示条、重连遮罩
 *
 * 倒计时环只做「显示」。真正的超时判定在服务端 ——
 * 客户端数到 0 只是让用户知道要来不及了，不会自己替玩家行动。
 */
export function CountdownRing(props: { remainMs: number | null; totalMs?: number }) {
  const { remainMs, totalMs = 30_000 } = props;
  if (remainMs === null) return null;

  const secs = Math.ceil(remainMs / 1000);
  const ratio = Math.max(0, Math.min(1, remainMs / totalMs));
  const urgent = secs <= 10;
  const R = 13;
  const C = 2 * Math.PI * R;

  return (
    <span className={`countdown${urgent ? ' urgent' : ''}`} title="超时将交由 AI 托管">
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
        <circle cx="15" cy="15" r={R} fill="none" stroke="var(--rule-2)" strokeWidth="3" />
        <circle
          cx="15"
          cy="15"
          r={R}
          fill="none"
          stroke={urgent ? 'var(--red)' : 'var(--ink3)'}
          strokeWidth="3"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - ratio)}
          strokeLinecap="round"
          transform="rotate(-90 15 15)"
          style={{ transition: 'stroke-dashoffset 0.2s linear' }}
        />
      </svg>
      <b>{secs}</b>
    </span>
  );
}

export function AutopilotBar(props: { onTakeback: () => void }) {
  return (
    <div className="autopilot-bar">
      <span className="ap-dot" />
      <span className="ap-text">
        <b>AI 正在代你操作</b>
        <span className="hint">超时或掉线后会自动托管，你随时可以收回</span>
      </span>
      <button className="primary" onClick={props.onTakeback}>
        我回来了
      </button>
    </div>
  );
}

export function ReconnectOverlay(props: { retry: number }) {
  return (
    <div className="reconnect-overlay">
      <div className="reconnect-box">
        <div className="spinner" />
        <div className="reconnect-title">正在重连…</div>
        <div className="hint">
          第 {props.retry} 次尝试 · 座位会为你保留 5 分钟，回来就能接着打
        </div>
      </div>
    </div>
  );
}

/** 回合切换横幅：只在轮次变化时出现，两秒后自动消失 */
export function RoundBanner(props: { round: number; show: boolean }) {
  if (!props.show) return null;
  return (
    <div className="round-banner" key={props.round}>
      <div className="rb-line" />
      <div className="rb-text">第 {props.round} 轮</div>
      <div className="rb-line" />
    </div>
  );
}

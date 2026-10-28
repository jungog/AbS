/**
 * 大厅：房间列表 + 建房 + 按号加入 + 观战入口
 *
 * 设计取舍：不做登录。朋友局靠 4 位房间号，陌生人局靠大厅。
 * 房间号用去掉 0/O/1/I 的字母表，口头念不会错。
 *
 * 密码只做「不让陌生人进来」这一层，不做账号体系：
 * 有密码的房间在大厅里照常显示（只多一个「密码」标记），
 * 因为藏起来的话，朋友连「我要进哪个房」都不知道。
 *
 * 邀请链接：`?room=ABCD`。已经记住昵称的人点开链接会直接进房（邀请的意图很明确），
 * 第一次来的人停在顶部的邀请提示条上：房间号已经填好，提示条里就有「加入房间」按钮，
 * 手机上不用往下滚去够输入框 —— 但按钮上会写清用的是哪个昵称（默认「玩家」），
 * 不想顶着「玩家」入座的人可以先到下面改名字。
 * 不做「自动用 玩家 入座」：以后在座位表里谁都认不出谁。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { clearInviteParam, inviteRoomFromUrl } from '@net/protocol';
import type { RoomSummary } from '@net/protocol';
import type { OnlineGame } from '@ui/hooks/useOnlineGame';

const NAME_KEY = 'abs:name';

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(n: string): void {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* 隐私模式忽略 */
  }
}

export function LobbyPage(props: { online: OnlineGame }) {
  const { online } = props;
  const [name, setName] = useState(() => rememberedName() || '玩家');
  const [joinCode, setJoinCode] = useState('');
  const [customRoom, setCustomRoom] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  /** 建房时设的密码 */
  const [newPw, setNewPw] = useState('');
  /** 加入 / 观战用的密码 */
  const [joinPw, setJoinPw] = useState('');
  /** 点了有密码的房间但还没填密码时的提示 */
  const [pwHint, setPwHint] = useState<string | null>(null);
  /** 从邀请链接带进来的房间号（用于顶部提示） */
  const [invited, setInvited] = useState<string | null>(null);
  const autoJoinRef = useRef(false);
  const pwRef = useRef<HTMLInputElement | null>(null);

  const connected = online.status === 'lobby' || online.status === 'joined';

  // 首次进入联机页：自动拉一次大厅
  useEffect(() => {
    if (online.status === 'idle') online.openLobby();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 读一次邀请参数，读完立刻从地址栏抹掉 ——
  // 否则用户「返回大厅」后刷新页面，又会被自动拉回同一个房间，看起来像退不出去
  useEffect(() => {
    const code = inviteRoomFromUrl();
    if (!code) return;
    setInvited(code);
    setJoinCode(code);
    clearInviteParam();
  }, []);

  const displayName = useMemo(() => name.trim() || '玩家', [name]);

  const doJoin = (code: string) => {
    rememberName(displayName);
    online.joinRoom(code, displayName, joinPw.trim() || undefined);
  };

  const doSpectate = (code: string) => {
    online.spectate(code, joinPw.trim() || undefined);
  };

  /**
   * 大厅里点房间。有密码但还没填 → 把房间号填好、把焦点送到密码框，
   * 而不是直接发一个注定被拒的请求（用户还得自己猜为什么没反应）。
   */
  const enterRoom = (r: RoomSummary, action: 'join' | 'spectate') => {
    if (r.hasPassword && !joinPw.trim()) {
      setJoinCode(r.id);
      setPwHint(`「${r.id}」有密码，请先在下方填写房间密码`);
      pwRef.current?.focus();
      return;
    }
    setPwHint(null);
    if (action === 'join') doJoin(r.id);
    else doSpectate(r.id);
  };

  const doCreate = () => {
    rememberName(displayName);
    online.createRoom(displayName, {
      room: customRoom.trim().toUpperCase() || undefined,
      isPublic,
      password: newPw.trim() || undefined,
    });
  };

  // 邀请链接 + 已有昵称 → 连上就直接进房
  useEffect(() => {
    if (!invited || autoJoinRef.current) return;
    if (online.status !== 'lobby') return;
    const saved = rememberedName();
    if (!saved) return; // 新用户：留在页面上让他先填昵称
    autoJoinRef.current = true;
    rememberName(saved);
    online.joinRoom(invited, saved);
  }, [invited, online]);

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h1>联机大厅</h1>
        <p className="sub">
          {connected
            ? `已连接 · ${online.rooms.length} 个公开房间${online.latency !== null ? ` · 延迟 ${online.latency}ms` : ''}`
            : online.status === 'reconnecting'
              ? `正在重连…（第 ${online.retry} 次）`
              : online.status === 'connecting'
                ? '正在连接服务端…'
                : '未连接服务端'}
        </p>
      </div>

      {invited && (
        <div className="notice invite-notice">
          <span>
            邀请链接：房间 <strong>{invited}</strong>
            {rememberedName()
              ? '，正在进入…'
              : `，昵称「${displayName}」（可在下方修改）`}
          </span>
          {/* 第一次来的人不会被自动拉进房（他还没有昵称），
              但「用房间号加入」的输入框在手机上是第二屏 —— 提示条里直接给一个按钮，
              点一下就进。按钮文案带上昵称，是因为这里入座用的就是它，
              不能让人稀里糊涂顶着「玩家」进去。 */}
          {!rememberedName() && (
            <button className="primary" onClick={() => doJoin(invited)} disabled={!connected}>
              以「{displayName}」加入
            </button>
          )}
          <button
            className="ghost"
            onClick={() => {
              setInvited(null);
              autoJoinRef.current = true;
            }}
          >
            先不加入
          </button>
        </div>
      )}

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

      {online.status === 'error' && (
        <div className="lobby-connect">
          <div className="hint">
            连不上服务端。请先启动：<code>npm run server</code>（默认 8787 端口）
          </div>
          <button className="primary" onClick={online.openLobby}>
            重试连接
          </button>
        </div>
      )}

      <div className="lobby-grid">
        {/* 左：房间列表 */}
        <section className="lobby-panel">
          <div className="section-label">公开房间</div>
          {online.rooms.length === 0 ? (
            <div className="lobby-empty">
              <div className="hint">还没有公开房间。</div>
              {/* 建房面板在 `.lobby-grid` 的第二列，但那一列在 820px 以下会塌到下面去。
                  一句「在右边建一个」在手机上指向的是空白 —— 而空状态正是新玩家
                  最需要指路的地方。两份文案由 CSS 按同一个断点切换，不引 JS 监听。 */}
              <div className="hint">
                <span className="lobby-empty-wide">在右边建一个，把房间号发给朋友就行。</span>
                <span className="lobby-empty-narrow">在下面建一个，把房间号发给朋友就行。</span>
              </div>
            </div>
          ) : (
            <div className="room-list">
              {online.rooms.map((r) => {
                // 掉线的人还有 5 分钟保座宽限期，这期间房间还在、`players` 也还数着他。
                // 但「一个人都不在线」的房间不该让人点进去 —— 进去只会独自坐着，
                // 还得莫名其妙接管房主（实测过）。
                const nobody = r.online === 0;
                return (
                <div
                  key={r.id}
                  className={`room-row${nobody || (!r.joinable && !r.started) ? ' locked' : ''}`}
                >
                  <div className="room-code">{r.id}</div>
                  <div className="room-meta">
                    <div className="room-host">
                      {r.hostName}
                      {r.hasPassword && <span className="tag lock-tag">密码</span>}
                      {nobody && <span className="tag offline-tag">无人在线</span>}
                    </div>
                    <div className="room-state">
                      {nobody
                        ? `房间还在等他们回来（${r.players} 个座位留着，5 分钟后回收）`
                        : r.gameOver
                          ? `上一局已结束 · ${r.players} / ${r.capacity} 人 · 可加入下一局`
                          : r.started
                            ? `对局中${r.spectators > 0 ? ` · ${r.spectators} 人观战` : ''}`
                            : `${r.players} / ${r.capacity} 人${r.online < r.players ? ` · ${r.online} 在线` : ''}`}
                    </div>
                  </div>
                  {r.gameOver ? (
                    // 上一局结束的房间：能进去打下一局，也能只是看
                    <>
                      <button
                        className={r.joinable && !nobody ? 'primary' : ''}
                        disabled={!r.joinable || nobody}
                        onClick={() => enterRoom(r, 'join')}
                      >
                        加入下一局
                      </button>
                      <button className="ghost" disabled={nobody} onClick={() => enterRoom(r, 'spectate')}>
                        观战
                      </button>
                    </>
                  ) : r.started ? (
                    // 已开局的房间也能进 —— 以观战身份
                    <button disabled={nobody} onClick={() => enterRoom(r, 'spectate')}>
                      观战
                    </button>
                  ) : (
                    <button
                      className={r.joinable && !nobody ? 'primary' : ''}
                      disabled={!r.joinable || nobody}
                      onClick={() => enterRoom(r, 'join')}
                    >
                      加入
                    </button>
                  )}
                </div>
                );
              })}
            </div>
          )}
          <button className="ghost refresh" onClick={online.openLobby} disabled={!connected}>
            刷新列表
          </button>
        </section>

        {/* 右：昵称 + 建房 / 加入 */}
        <section className="lobby-panel">
          <div className="section-label">你的昵称</div>
          <input
            className="nick-input"
            value={name}
            maxLength={12}
            onChange={(e) => setName(e.target.value)}
            placeholder="最多 12 字"
          />

          <div className="section-label" style={{ marginTop: 22 }}>
            创建房间
          </div>
          <div className="field-inline">
            <input
              value={customRoom}
              maxLength={8}
              placeholder="房间号（留空自动分配）"
              onChange={(e) => setCustomRoom(e.target.value.toUpperCase())}
            />
          </div>
          <div className="field-inline" style={{ marginTop: 8 }}>
            <input
              value={newPw}
              maxLength={16}
              placeholder="房间密码（留空表示不设）"
              onChange={(e) => setNewPw(e.target.value)}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            在大厅里公开显示
          </label>
          <button className="primary wide" onClick={doCreate} disabled={!connected}>
            创建并进入
          </button>

          <div className="section-label" style={{ marginTop: 22 }}>
            用房间号加入
          </div>
          <div className="field-inline">
            <input
              value={joinCode}
              maxLength={8}
              placeholder="例如 A3KP"
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && joinCode.trim()) doJoin(joinCode);
              }}
            />
            <button onClick={() => doJoin(joinCode)} disabled={!connected || !joinCode.trim()}>
              加入
            </button>
          </div>
          <div className="field-inline" style={{ marginTop: 8 }}>
            <input
              ref={pwRef}
              value={joinPw}
              maxLength={16}
              placeholder="房间密码（有则填）"
              onChange={(e) => {
                setJoinPw(e.target.value);
                if (e.target.value.trim()) setPwHint(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && joinCode.trim()) doJoin(joinCode);
              }}
            />
          </div>
          {pwHint && <div className="hint pw-hint">{pwHint}</div>}
          <div className="field-inline" style={{ marginTop: 8 }}>
            <button
              className="ghost"
              onClick={() => doSpectate(joinCode)}
              disabled={!connected || !joinCode.trim()}
            >
              以观战身份进入
            </button>
            <span className="hint">对局已经开始时用这个</span>
          </div>
        </section>
      </div>
    </div>
  );
}

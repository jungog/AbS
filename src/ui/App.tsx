import { useState } from 'react';
import { BattlePage } from '@ui/pages/BattlePage';
import { ConfigPage } from '@ui/pages/ConfigPage';

type Tab = 'battle' | 'config';

export function App() {
  const [tab, setTab] = useState<Tab>('battle');

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          风声再临
          <small>ATTACK BY STRATAGEM</small>
        </div>
        <div className="tabs">
          <button className={tab === 'battle' ? 'active' : ''} onClick={() => setTab('battle')}>
            对局
          </button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
            数据配置
          </button>
        </div>
      </div>
      {/*
        两个页面**都保持挂载**，只切换可见性。

        原来是 `tab === 'battle' ? <BattlePage /> : <ConfigPage />` —— 条件渲染会
        **卸载** BattlePage，而这些东西全在它内部：
          · `useOnlineGame` 的 WebSocket（卸载 ⇒ cleanup 里 close ⇒ 服务端判掉线）
          · 大厅/房间的页签状态（`tab`）
          · 昵称输入框（LobbyPage 的 `name`）
        于是「在大厅等朋友时点一下数据配置看牌表」回来就掉回「本地对局」启动页，
        昵称也没了；对局中切走更直接掉线，别人看到「掉线」、座位进托管。

        实测（1280×900，已进大厅并填好昵称）：切到数据配置再切回，
        +500ms 起一直是 `.launch`（本地启动页），到 +10 秒仍然如此，昵称输入框为空。

        用 `hidden` 而不是条件渲染：ConfigPage 没有任何副作用
        （无 useEffect / 无定时器 / 不读 localStorage），挂着不花什么钱。
      */}
      <div className="content">
        <div className="page" hidden={tab !== 'battle'}>
          <BattlePage />
        </div>
        <div className="page" hidden={tab !== 'config'}>
          <ConfigPage />
        </div>
      </div>
    </div>
  );
}

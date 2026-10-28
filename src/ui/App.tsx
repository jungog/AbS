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
      <div className="content">{tab === 'battle' ? <BattlePage /> : <ConfigPage />}</div>
    </div>
  );
}

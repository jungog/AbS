/**
 * UI 渲染冒烟 —— 用 react-dom/server 把页面渲成字符串，
 * 用来抓「组件里有运行期崩溃 / 导入错误」这类 tsc 查不出的问题。
 *
 * 运行：npx tsx scripts/ui-smoke.tsx
 */
import { renderToString } from 'react-dom/server';
import { App } from '../src/ui/App';
import { ActionPanel } from '../src/ui/components/ActionPanel';
import { PlayerCard } from '../src/ui/components/Board';
import { RoomPage } from '../src/ui/pages/RoomPage';
import type { OnlineGame } from '../src/ui/hooks/useOnlineGame';
import { PACK } from '../src/data/pack';
import { createGame } from '../src/core/engine';
import { redactState } from '../src/core/redact';

const html = renderToString(<App />);

const checks: [string, boolean][] = [
  ['渲染出内容', html.length > 500],
  ['含标题「风声再临」', html.includes('风声再临')],
  ['含三种模式入口', html.includes('单人 + AI 陪练') && html.includes('单机热座') && html.includes('上帝视角')],
  ['含人数选择', html.includes('人数')],
  ['含开始按钮', html.includes('开始对局')],
  ['含联机入口', html.includes('联机对局')],
];

/* ---------- 对局内视图：用真实状态渲染一次 ---------- */
const game = createGame({
  pack: PACK,
  seed: 'UISMOKE',
  skipSetup: true,
  players: [
    { name: '你', isBot: false },
    { name: 'AI-1', isBot: true },
    { name: 'AI-2', isBot: true },
  ],
});
const view = redactState(game, PACK, 'p0');
const me = view.players.find((p) => p.id === 'p0')!;

const panel = renderToString(
  <ActionPanel view={view} viewerId="p0" onCommand={() => undefined} error={null} onClearError={() => undefined} />,
);
const card = renderToString(<PlayerCard player={me} acting isSelf />);

checks.push(
  ['对局内渲染出手牌区', panel.includes('我 的 手 牌')],
  ['对局内渲染出阶段操作', panel.includes('出牌阶段') && panel.includes('结束出牌')],
  ['玩家面板渲染出情报计数', card.includes('红') && card.includes('黑')],
  ['玩家面板渲染出角色名', card.includes(me.characterName)],
);

/* ---------- 房间页：结算阶段（新人刚进来，还没拿到对局状态） ---------- */
//
// 这个状态没法用消息流复现：它要求 started=true 且 view=null，
// 而一旦收到过 state，view 就不会再变回 null。所以直接构造一个 OnlineGame 渲染。
// 代价是 OnlineGame 加字段时这里会编译不过 —— 这是好事，说明它没有悄悄过期。
const noop = () => undefined;
const baseSeats = [
  { playerId: 'u1', gamePlayerId: 'p0', name: '甲', seat: 0, connected: true, isBot: false, autopilot: false, ready: true },
  { playerId: 'u2', gamePlayerId: 'p1', name: '乙', seat: 1, connected: true, isBot: false, autopilot: false, ready: true },
  { playerId: 'u3', gamePlayerId: null, name: '丙', seat: 2, connected: true, isBot: false, autopilot: false, ready: true },
];

const finishedGame: OnlineGame = {
  status: 'joined',
  rooms: [],
  role: 'player',
  playerId: 'u3',
  token: 'tk',
  gamePlayerId: null,
  isHost: false,
  hostId: 'u1',
  isPublic: true,
  hasPassword: false,
  room: 'A3KP',
  seats: baseSeats,
  spectators: 0,
  spectatorDelayRounds: 0,
  view: null,
  error: null,
  notice: null,
  started: true,
  deadlineAt: null,
  remainMs: null,
  autopilot: false,
  latency: null,
  retry: 0,
  ready: { count: 3, total: 3, offline: 0 },
  gameOver: true,
  myReady: true,
  openLobby: noop,
  createRoom: noop,
  joinRoom: noop,
  spectate: noop,
  startGame: noop,
  send: noop,
  takeback: noop,
  rematch: noop,
  swapSeats: noop,
  setBots: noop,
  leave: noop,
  clearNotice: noop,
  clearError: noop,
};

// React 会在两个插值之间插入 <!-- --> 分隔符，直接 includes 会匹配不到「准备 3 / 3」
const roomHtml = renderToString(<RoomPage online={finishedGame} />).replace(/<!-- -->/g, '');
checks.push(
  ['结算阶段的房间页标明「上一局已结束」', roomHtml.includes('上一局已结束')],
  ['结算阶段的房间页显示准备进度', roomHtml.includes('准备 3 / 3')],
  ['结算阶段的房间页没有「开始对局」（房主不能一键绕过准备）', !roomHtml.includes('开始对局')],
  ['新人能看到自己是「已准备」', roomHtml.includes('已准备 · 点此取消')],
  ['座位表标出谁是房主', roomHtml.includes('房主')],
);

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '✔' : '✖'} ${name}`);
  if (!pass) ok = false;
}

if (!ok) {
  console.error('\n渲染结果片段：\n', html.slice(0, 800));
  process.exit(1);
}
console.log(`\nUI 渲染冒烟通过（HTML ${html.length} 字符）。`);

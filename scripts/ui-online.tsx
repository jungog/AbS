/**
 * 联机界面交互测试（jsdom + 假 WebSocket）
 *
 * 为什么用假 WebSocket 而不是真服务端：
 *   要验的是**客户端状态机**——大厅渲染、加入、开局、托管条、断线重连的退避与 resume。
 *   真服务端会把这些行为混在一起，还带 5 秒网络抖动；假 socket 能精确控制
 *   「什么时候断、断多久、重连后服务端回什么」。
 *   服务端自己的行为由 scripts/server-test.ts 覆盖，两边分工不重叠。
 *
 * 运行：npx tsx scripts/ui-online.tsx
 */
import { JSDOM } from 'jsdom';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 假 WebSocket                                                        */
/* ------------------------------------------------------------------ */

type Listener = ((ev: unknown) => void) | null;

class MockWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWS[] = [];

  url: string;
  readyState = MockWS.CONNECTING;
  sent: string[] = [];
  onopen: Listener = null;
  onmessage: Listener = null;
  onerror: Listener = null;
  onclose: Listener = null;

  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
    // 下一帧「连上」
    setTimeout(() => {
      if (this.readyState !== MockWS.CONNECTING) return;
      this.readyState = MockWS.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWS.CLOSED) return;
    this.readyState = MockWS.CLOSED;
    this.onclose?.({});
  }

  /** 服务端推一条消息 */
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** 最近一条某种类型的消息（解析后） */
  lastOf<T = Record<string, unknown>>(type: string): T | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      try {
        const m = JSON.parse(this.sent[i]!) as { t?: string };
        if (m.t === type) return m as T;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  static get live(): MockWS | null {
    for (let i = MockWS.instances.length - 1; i >= 0; i--) {
      const ws = MockWS.instances[i]!;
      if (ws.readyState === MockWS.OPEN) return ws;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const results: [string, boolean, string?][] = [];
function check(label: string, ok: boolean, detail?: string): void {
  results.push([label, ok, detail]);
  console.log(`${ok ? '✔' : '✖'} ${label}${!ok && detail ? ` —— ${detail}` : ''}`);
}

async function main(): Promise<void> {
  /* ---------------- DOM ---------------- */
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Window & typeof globalThis;
  const g = globalThis as Record<string, unknown>;
  g.window = w;
  g.document = w.document;
  Object.defineProperty(globalThis, 'navigator', {
    value: w.navigator,
    configurable: true,
    writable: true,
  });
  g.HTMLElement = w.HTMLElement;
  g.HTMLSelectElement = w.HTMLSelectElement;
  g.HTMLInputElement = w.HTMLInputElement;
  g.Element = w.Element;
  g.Node = w.Node;
  g.Event = w.Event;
  g.MouseEvent = w.MouseEvent;
  g.getComputedStyle = w.getComputedStyle.bind(w);
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.IS_REACT_ACT_ENVIRONMENT = false;
  // LobbyPage / protocol 里用的是裸 `localStorage` 和 `location`，
  // 不把全局指向 jsdom 的话，它们会静默走「取不到」分支，邀请链接就测不出来
  Object.defineProperty(globalThis, 'localStorage', {
    value: w.localStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'location', {
    value: w.location,
    configurable: true,
    writable: true,
  });
  // 装假 WebSocket：必须在导入 UI 之前
  g.WebSocket = MockWS as unknown as typeof WebSocket;
  (w as unknown as Record<string, unknown>).WebSocket = MockWS;

  // jsdom 没有布局引擎，getBoundingClientRect 全是 0；而 flyCard 会以
  // 「尺寸为 0 的元素不飞」作为保护。这里给一个几何桩：玩家卡按座位横向排开。
  (w.Element.prototype as unknown as Record<string, unknown>).getBoundingClientRect = function (
    this: Element,
  ) {
    const pid = this.getAttribute('data-player-id') ?? '';
    const idx = pid ? Number(pid.replace(/\D/g, '')) || 0 : 0;
    const left = 20 + idx * 200;
    return {
      left,
      top: 100,
      width: 180,
      height: 90,
      right: left + 180,
      bottom: 190,
      x: left,
      y: 100,
      toJSON() {
        return {};
      },
    };
  };

  // jsdom 没有 Web Animations API。装一个桩，让飞行动画真的走完创建流程，
  // 否则 flyCard 会落到 catch 分支直接清理，动画逻辑等于没被测试覆盖。
  const animCalls: { cls: string; keyframes: unknown; opts: unknown }[] = [];
  (w.Element.prototype as unknown as Record<string, unknown>).animate = function (
    this: Element,
    keyframes: unknown,
    opts: unknown,
  ) {
    animCalls.push({ cls: this.className, keyframes, opts });
    // 不调用 onfinish，幽灵节点留在 DOM 里方便断言
    return { onfinish: null, oncancel: null, cancel() {} };
  };

  // 清掉可能残留的座位存档，保证从「未连接」开始
  w.localStorage.clear();

  const { createRoot } = await import('react-dom/client');
  const { createElement } = await import('react');
  const { App } = await import('../src/ui/App');
  const { loadDefaultPack } = await import('../src/data/load');
  const { createGame } = await import('../src/core/engine');
  const { redactState, redactPublic } = await import('../src/core/redact');

  const container = w.document.getElementById('root')!;
  const root = createRoot(container);
  root.render(createElement(App));
  await sleep(80);

  const $ = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string) => Array.from(w.document.querySelectorAll(sel)) as HTMLElement[];
  const bodyText = () => w.document.body.textContent ?? '';
  const click = async (el: HTMLElement | null) => {
    if (!el) throw new Error('要点击的元素不存在');
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await sleep(60);
  };

  /* ---------------- 1. 切到联机页 ---------------- */
  const onlineTab = $$('.tabs-line button').find((b) => (b.textContent ?? '').includes('联机对局'));
  check('顶部有「联机对局」入口', Boolean(onlineTab));
  await click(onlineTab ?? null);
  await sleep(120);

  check('进入大厅界面', Boolean($('.lobby')));
  check('自动建立连接（不用手动点连接）', MockWS.instances.length >= 1, `实例数 ${MockWS.instances.length}`);

  const ws1 = MockWS.live;
  check('连上后自动拉取大厅列表', Boolean(ws1?.lastOf('lobby')), JSON.stringify(ws1?.sent));

  /* ---------------- 2. 大厅列表渲染 ---------------- */
  ws1!.emit({
    t: 'lobby',
    rooms: [
      { id: 'A3KP', players: 2, online: 2, capacity: 7, started: false, isPublic: true, hostName: '甲', joinable: true, spectators: 0, hasPassword: false },
      { id: 'B7QZ', players: 7, online: 7, capacity: 7, started: true, isPublic: true, hostName: '乙', joinable: false, spectators: 2, hasPassword: false },
      { id: 'C9MX', players: 1, online: 1, capacity: 7, started: false, isPublic: true, hostName: '丙', joinable: true, spectators: 0, hasPassword: true },
      // 上一局打完了：仍然 started，但应该允许新人进来打下一局
      { id: 'D5RT', players: 2, online: 2, capacity: 7, started: true, isPublic: true, hostName: '丁', joinable: true, spectators: 0, hasPassword: false, gameOver: true },
      // 全员掉线：座位还在（5 分钟保座宽限期），但一个人都不在屏幕前。
      // players 还是 2 —— 只报 players 的话这就是个「2/7 人」的幽灵房间，
      // 点进去才会发现是空的（实测：还会莫名其妙接管房主）。
      { id: 'E2NV', players: 2, online: 0, capacity: 7, started: false, isPublic: true, hostName: '戊', joinable: true, spectators: 0, hasPassword: false },
    ],
  });
  await sleep(80);

  const rows = $$('.room-row');
  check('大厅渲染出五个房间', rows.length === 5, `实际 ${rows.length}`);
  check(
    '有密码的房间在大厅里照常显示，只多一个标记',
    Boolean(rows[2]?.querySelector('.lock-tag')),
    rows[2]?.textContent ?? '',
  );
  check('房间号显示正确', bodyText().includes('A3KP') && bodyText().includes('B7QZ'));
  check(
    '已开局的房间给出「观战」入口',
    ((rows[1]?.querySelector('button')?.textContent ?? '').includes('观战')),
    rows[1]?.querySelector('button')?.textContent ?? '',
  );
  check(
    '观战按钮可点（不是禁用）',
    (rows[1]?.querySelector('button') as HTMLButtonElement | null)?.disabled === false,
  );

  const overRow = rows[3];
  check(
    '结算阶段的房间写明「上一局已结束 · 可加入下一局」',
    (overRow?.textContent ?? '').includes('上一局已结束') &&
      (overRow?.textContent ?? '').includes('可加入下一局'),
    overRow?.textContent ?? '',
  );
  const overJoinBtn = overRow?.querySelector('button') as HTMLButtonElement | null;
  check(
    '结算阶段的房间给的是「加入下一局」（不是「观战」）',
    (overJoinBtn?.textContent ?? '').includes('加入下一局'),
    overJoinBtn?.textContent ?? '',
  );
  check('「加入下一局」可点（房间没满）', overJoinBtn?.disabled === false);

  /* 全员掉线的房间：座位还在（保座宽限期），但一个人都不在屏幕前。
     只报 players 的话它就是「2 / 7 人」，点进去才发现是空的 —— 实测还会接管房主。 */
  const ghostRow = rows[4];
  check(
    '无人在线的房间打上「无人在线」标记',
    Boolean(ghostRow?.querySelector('.offline-tag')),
    ghostRow?.textContent ?? '',
  );
  check(
    '说明它为什么还挂在列表上（保座宽限期）',
    (ghostRow?.textContent ?? '').includes('等他们回来'),
    ghostRow?.textContent ?? '',
  );
  const ghostBtn = ghostRow?.querySelector('button') as HTMLButtonElement | null;
  check('无人在线的房间不能点「加入」', ghostBtn?.disabled === true, ghostBtn?.textContent ?? '');
  await click(ghostBtn);
  check(
    '点了也不发 join（别让人独自进空房间）',
    !MockWS.live?.lastOf('join'),
    JSON.stringify(MockWS.live?.sent),
  );

  /* ---------------- 3. 房间密码 ---------------- */
  const pwJoinBtn = rows[2]!.querySelector('button') as HTMLButtonElement;
  await click(pwJoinBtn);
  check(
    '点有密码的房间不发注定被拒的请求',
    !MockWS.live?.lastOf('join'),
    JSON.stringify(MockWS.live?.sent),
  );
  check('提示要填密码', ($('.pw-hint')?.textContent ?? '').includes('密码'), $('.pw-hint')?.textContent ?? '');
  check(
    '自动把房间号填进「用房间号加入」',
    (($('input[placeholder="例如 A3KP"]') as HTMLInputElement | null)?.value ?? '') === 'C9MX',
    ($('input[placeholder="例如 A3KP"]') as HTMLInputElement | null)?.value ?? '',
  );

  const pwInput = $('input[placeholder="房间密码（有则填）"]') as HTMLInputElement | null;
  const setVal = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!;
  setVal.call(pwInput, '8888');
  pwInput!.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(80);
  check('填了密码后提示消失', !$('.pw-hint'));

  await click(pwJoinBtn);
  const pwJoinMsg = MockWS.live?.lastOf<{ t: string; room: string; password?: string }>('join');
  check('填了密码才发 join，且带上密码', pwJoinMsg?.room === 'C9MX' && pwJoinMsg?.password === '8888', JSON.stringify(pwJoinMsg));

  /* ---------------- 4. 加入房间 ---------------- */
  const joinBtn = rows[0]!.querySelector('button') as HTMLButtonElement;
  await click(joinBtn);
  const joinMsg = MockWS.live?.lastOf<{ t: string; room: string; name: string }>('join');
  check('点「加入」发出 join 指令', joinMsg?.room === 'A3KP', JSON.stringify(joinMsg));

  /* ---------------- 4. 房间等待页 ---------------- */
  const ws2 = MockWS.live!;
  ws2.emit({
    t: 'joined',
    playerId: 'u1',
    token: 'tk-abc',
    seat: 0,
    room: 'A3KP',
    host: true,
    resumed: false,
  });
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: [
      { playerId: 'u1', gamePlayerId: null, name: '玩家', seat: 0, connected: true, isBot: false, autopilot: false },
      { playerId: 'u2', gamePlayerId: null, name: '乙', seat: 1, connected: true, isBot: false, autopilot: false },
    ],
    started: false,
    hostId: 'u1',
    isPublic: true,
  });
  await sleep(100);

  check('进入房间等待页', Boolean($('.room')), bodyText().slice(0, 60));
  check('房间号大字显示', $('.room-bigcode')?.textContent === 'A3KP', $('.room-bigcode')?.textContent ?? '');
  check('座位数固定 7 个', $$('.seat').length === 7, `实际 ${$$('.seat').length}`);
  check('空位显示「空位」', $$('.seat.empty').length === 5, `实际 ${$$('.seat.empty').length}`);
  check('自己的座位被标记', $$('.seat.me').length === 1);
  const roomButtons = () =>
    Array.from(w.document.querySelectorAll('.room-actions button')) as HTMLElement[];
  // 必须按按钮文案精确匹配：非房主分支写的是「等待房主开始对局…」，
  // 用 bodyText().includes('开始对局') 等于恒真，房主身份丢了也发现不了。
  check(
    '房主看到「开始对局」按钮',
    roomButtons().some((b) => (b.textContent ?? '').trim() === '开始对局'),
    roomButtons().map((b) => b.textContent).join('|'),
  );
  check('房主身份标签显示', Boolean($('.tag.host-tag')), '');

  /* ---------------- 4a. 有人掉线：房主开局前必须知道他会由 AI 代打 ---------------- */
  // 掉线的人还占着座位（5 分钟保座宽限期），开局时照样算进人数 —— 这是刻意的
  // （刷新页面的人不该被踢出去）。但房主看到的「当前 2 人」里有一个其实不在，
  // 不说清楚他就会以为「2 个人打」，实际是「1 个人 + 1 个 AI」。
  const twoSeats = (guestOnline: boolean) => [
    { playerId: 'u1', gamePlayerId: null, name: '玩家', seat: 0, connected: true, isBot: false, autopilot: false },
    { playerId: 'u2', gamePlayerId: null, name: '乙', seat: 1, connected: guestOnline, isBot: false, autopilot: false },
  ];
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: twoSeats(false),
    started: false,
    hostId: 'u1',
    isPublic: true,
  });
  await sleep(100);
  check('掉线的人座位上标「掉线」', Boolean($('.seat.offline')), bodyText().slice(0, 120));
  check(
    '房主看到「由 AI 代打」的提醒（别以为真有两个人在打）',
    bodyText().includes('由 AI 代打'),
    bodyText().slice(0, 160),
  );

  // 恢复两人在线：后面的换座用例按原状态继续
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: twoSeats(true),
    started: false,
    hostId: 'u1',
    isPublic: true,
  });
  await sleep(100);
  check('两人都在线时不显示这条提醒', !bodyText().includes('由 AI 代打'), bodyText().slice(0, 160));

  /* ---------------- 4b. 点座位换座 ---------------- */
  const swapCount = () => ws2.sent.filter((x) => JSON.parse(x).t === 'swap').length;

  check('有人的座位才可点（空位不参与交换）', $$('.seat.swappable').length === 2, `实际 ${$$('.seat.swappable').length}`);
  check('换座提示可见', ($('.seat-hint')?.textContent ?? '').includes('点两个座位'), $('.seat-hint')?.textContent ?? '');

  // 点自己的座位 → 选中
  const seatEls = () => $$('.seat:not(.empty)');
  await click(seatEls()[0]!);
  check('点一下座位进入选中态', Boolean($('.seat.picked')));
  check(
    '选中后提示变成「再点一个座位」',
    ($('.seat-hint')?.textContent ?? '').includes('已选中 1 号位'),
    $('.seat-hint')?.textContent ?? '',
  );

  // 再点自己 → 取消
  await click(seatEls()[0]!);
  check('再点同一个座位取消选中', !$('.seat.picked'));
  check('取消选中没有发 swap', swapCount() === 0, `发了 ${swapCount()} 次`);

  // 两次点击之间要等 React 提交：不等的话第二次点击读到的还是旧的 picked（闭包），
  // 结果是「第一次点击被覆盖」，一个 swap 都发不出去。
  // 真实浏览器里两次点击是两个任务，React 之间会提交；jsdom 里必须手动让一拍。
  const pickSeat = async (i: number) => {
    await click(seatEls()[i]!);
    await sleep(60);
    if (process.env.DBG_SEAT) {
      const pickedIdx = seatEls().findIndex((e) => e.className.includes('picked'));
      console.log(`    [dbg] 点了 ${i} 号位 → picked=${pickedIdx} swap=${swapCount()} hint=${$('.seat-hint-warn')?.textContent ?? '-'}`);
    }
  };

  // 选中自己 + 点别人 → 发 swap
  await pickSeat(0);
  await pickSeat(1);
  const swapMsg = ws2.lastOf<{ t: string; a: number; b: number }>('swap');
  check('点第二个座位发出 swap', swapMsg?.a === 0 && swapMsg?.b === 1, JSON.stringify(swapMsg));
  check('发完之后选中态清空', !$('.seat.picked'));

  // 房主可以交换任意两个（不是自己的也行）
  await pickSeat(1);
  await pickSeat(0);
  const swapMsg2 = ws2.lastOf<{ t: string; a: number; b: number }>('swap');
  check('房主可以从任意座位开始交换', swapMsg2?.a === 1 && swapMsg2?.b === 0, JSON.stringify(swapMsg2));

  // 清掉残留的选中态：留着的话下一次点击会被当成「完成交换」，
  // 于是「非房主不该发 swap」会假失败。
  if ($('.seat.picked')) {
    const idx = seatEls().findIndex((e) => e.className.includes('picked'));
    await pickSeat(idx);
  }

  // 非房主：点别人的座位只给提示，不发请求
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: [
      { playerId: 'u1', gamePlayerId: null, name: '玩家', seat: 0, connected: true, isBot: false, autopilot: false },
      { playerId: 'u2', gamePlayerId: null, name: '乙', seat: 1, connected: true, isBot: false, autopilot: false },
    ],
    started: false,
    hostId: 'u2',
    isPublic: true,
  });
  await sleep(100);
  const swapBefore = swapCount();
  await pickSeat(1);
  check(
    '非房主点别人的座位只给提示',
    ($('.seat-hint-warn')?.textContent ?? '').includes('只有房主'),
    $('.seat-hint-warn')?.textContent ?? '',
  );
  check('非房主点别人的座位不发 swap', swapCount() === swapBefore, `多了 ${swapCount() - swapBefore} 次`);
  check('提示之后没有误选中', !$('.seat.picked'));

  // 非房主从自己开始，可以换
  await pickSeat(0);
  await pickSeat(1);
  const swapMsg3 = ws2.lastOf<{ t: string; a: number; b: number }>('swap');
  check('非房主可以把自己和一个别人交换', swapMsg3?.a === 0 && swapMsg3?.b === 1, JSON.stringify(swapMsg3));

  // 还原房主身份，后面的用例还要用
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: [
      { playerId: 'u1', gamePlayerId: null, name: '玩家', seat: 0, connected: true, isBot: false, autopilot: false },
      { playerId: 'u2', gamePlayerId: null, name: '乙', seat: 1, connected: true, isBot: false, autopilot: false },
    ],
    started: false,
    hostId: 'u1',
    isPublic: true,
  });
  await sleep(80);

  /* ---------------- 5. 开局 ---------------- */
  const pack = loadDefaultPack();
  const game = createGame({
    pack,
    seed: 'UIONLINE',
    skipSetup: true,
    players: [
      { name: '玩家', isBot: false },
      { name: '乙', isBot: false },
      { name: 'AI', isBot: true },
    ],
  });
  const view = redactState(game, pack, 'p0');

  const seatsInGame = [
    { playerId: 'u1', gamePlayerId: 'p0', name: '玩家', seat: 0, connected: true, isBot: false, autopilot: false, ready: false },
    { playerId: 'u2', gamePlayerId: 'p1', name: '乙', seat: 1, connected: true, isBot: false, autopilot: false, ready: false },
    { playerId: 'bot1', gamePlayerId: 'p2', name: 'AI', seat: 2, connected: true, isBot: true, autopilot: false, ready: false },
  ];
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: seatsInGame,
    started: true,
    hostId: 'u1',
    isPublic: true,
  });
  ws2.emit({
    t: 'state',
    state: view,
    deadlineAt: Date.now() + 30_000,
    autopilot: false,
  });
  await sleep(120);

  check('开局后进入对局界面', Boolean($('.battle')), bodyText().slice(0, 60));
  check('对局界面显示 3 个玩家卡', $$('.pcard').length === 3, `实际 ${$$('.pcard').length}`);
  check('显示倒计时环', Boolean($('.countdown')));
  check('倒计时显示 30 秒', ($('.countdown b')?.textContent ?? '') === '30', $('.countdown b')?.textContent ?? '');
  check('玩家卡带 data-player-id（动效定位用）', $$('.pcard[data-player-id]').length === 3);
  check('状态栏显示房间号', bodyText().includes('A3KP'));

  /* ---------------- 6. 动效触发 ---------------- */
  const flowView = {
    ...view,
    round: view.round + 1,
    flow: {
      source: 'p0',
      current: 'p1',
      method: 'cipher' as const,
      color: 'red' as const,
      locked: false,
      skipped: [],
      remainingPath: ['p2'],
    },
  };
  ws2.emit({ t: 'state', state: flowView, deadlineAt: Date.now() + 30_000, autopilot: false });
  await sleep(120);

  const ghosts = $$('.fly-card');
  check('情报开始传递时生成飞行卡', ghosts.length >= 1, `实际 ${ghosts.length}`);
  check('飞行卡带上情报颜色', (ghosts[0]?.className ?? '').includes('red'), ghosts[0]?.className ?? '');
  check('飞行卡被交给动画引擎', animCalls.length >= 1, `animate 调用 ${animCalls.length} 次`);
  check(
    '飞行动画有起点/中点/终点三段关键帧',
    Array.isArray(animCalls[0]?.keyframes) && (animCalls[0]!.keyframes as unknown[]).length === 3,
  );
  check('回合数变化时出现回合横幅', Boolean($('.round-banner')), bodyText().slice(0, 50));
  // 清掉幽灵，别影响后续断言
  ghosts.forEach((el) => el.remove());

  // 情报落位：给 p0 加一张情报，玩家卡应闪一下
  const p0View = flowView.players.find((p) => p.id === 'p0')!;
  const landedView = {
    ...flowView,
    flow: null,
    players: flowView.players.map((p) =>
      p.id === 'p0'
        ? {
            ...p,
            intel: [...p.intel, { uid: 'anim-1', color: 'red' as const, method: 'cipher' as const, defName: '试探' }],
          }
        : p,
    ),
  };
  void p0View;
  ws2.emit({ t: 'state', state: landedView, deadlineAt: Date.now() + 30_000, autopilot: false });
  await sleep(80);
  check('情报落位时玩家卡高亮', Boolean($('.pcard[data-player-id="p0"].landing')));

  /* ---------------- 7. 结算页的准备制 ---------------- */
  const endView = {
    ...view,
    winner: {
      side: 'red' as const,
      winners: ['p0'],
      reason: '潜伏战线凑齐了 3 张红色情报。',
      by: 'p0',
    },
  };
  ws2.emit({ t: 'room', room: 'A3KP', seats: seatsInGame, started: true, hostId: 'u1', isPublic: true, ready: { count: 1, total: 2, offline: 0 } });
  ws2.emit({ t: 'state', state: endView, deadlineAt: null, autopilot: false });
  await sleep(120);

  check('对局结束弹出结算面板', Boolean($('.result')));
  check('结算页显示准备进度', ($('.ready-count')?.textContent ?? '').includes('1 / 2'), $('.ready-count')?.textContent ?? '');
  check('未准备时按钮是「再来一局」', ($('.result-actions .primary')?.textContent ?? '').includes('再来一局'), $('.result-actions .primary')?.textContent ?? '');
  check('结算页另给一个「返回大厅」出口', ($('.result-actions .ghost')?.textContent ?? '').includes('返回大厅'), $('.result-actions .ghost')?.textContent ?? '');
  check('结算页有「调整座位 / 人数」入口', Boolean($('.ready-arrange')), bodyText().slice(0, 60));

  /* 准备进度只数在线的人：掉线的人虽然按「自动准备」处理，
     但算进分子会出现「2 / 2 已准备」而游戏不开始（服务端那条用例盯着这个）。 */
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: seatsInGame,
    started: true,
    hostId: 'u1',
    isPublic: true,
    ready: { count: 1, total: 2, offline: 1 },
  });
  await sleep(100);
  check(
    '有人掉线时说明「自动算准备」（否则 1/2 看着像算错了）',
    ($('.ready-row .hint')?.textContent ?? '').includes('掉线'),
    $('.ready-row .hint')?.textContent ?? '',
  );
  check(
    '掉线不算「全员已准备」（不能说「开局中…」）',
    !($('.ready-row .hint')?.textContent ?? '').includes('开局中'),
    $('.ready-row .hint')?.textContent ?? '',
  );

  // 全员掉线：0 / 0 不能被当成「满了」——服务端此时不会开局（allReady 有兜底）
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: seatsInGame,
    started: true,
    hostId: 'u1',
    isPublic: true,
    ready: { count: 0, total: 0, offline: 2 },
  });
  await sleep(100);
  check(
    '0 / 0 不显示「开局中…」',
    !($('.ready-row .hint')?.textContent ?? '').includes('开局中'),
    $('.ready-row .hint')?.textContent ?? '',
  );

  // 恢复原状态，后面的换座用例按 1/2 继续
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: seatsInGame,
    started: true,
    hostId: 'u1',
    isPublic: true,
    ready: { count: 1, total: 2, offline: 0 },
  });
  await sleep(100);

  /* ---------------- 7b. 结算页换座与调人数 ---------------- */
  // 结算阶段（started=true + gameOver）座位又能点了
  ws2.emit({
    t: 'room',
    room: 'A3KP',
    seats: seatsInGame,
    started: true,
    hostId: 'u1',
    isPublic: true,
    ready: { count: 1, total: 2, offline: 0 },
    gameOver: true,
  });
  await sleep(120);
  // 结算页不会自动跳回房间（那会把正在复盘的人掀桌），要自己点入口
  await click($('.ready-arrange'));
  await sleep(80);
  check('点「调整座位」进入房间页', Boolean($('.room')) && !$('.result'), bodyText().slice(0, 60));
  check('结算阶段座位重新可点', $$('.seat.swappable').length > 0, `实际 ${$$('.seat.swappable').length}`);
  const roomBtn = (kw: string) =>
    (Array.from(w.document.querySelectorAll('.room button')) as HTMLElement[]).find((b) =>
      (b.textContent ?? '').includes(kw),
    ) ?? null;
  check('房间页给一条「返回结算」的退路', Boolean(roomBtn('返回结算')), '');

  const botsSel = $('.room-actions select') as HTMLSelectElement | null;
  check('房主在结算页能看到「下一局 AI」选择器', Boolean(botsSel), bodyText().slice(0, 80));
  if (botsSel) {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(botsSel, '2');
    botsSel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(80);
    const botsMsg = ws2.lastOf<{ t: string; count: number }>('bots');
    check('改人数发出 bots 指令', botsMsg?.count === 2, JSON.stringify(botsMsg));
  }

  // 回结算面板：补一条 state 是没用的 —— 房间页是靠 showRoom 这个本地状态撑着的，
  // 只有点「返回结算」才会退回去。
  await click(roomBtn('返回结算'));
  await sleep(100);
  check('「返回结算」回到结算面板', Boolean($('.result')), bodyText().slice(0, 40));

  await click($('.result-actions .primary'));
  const rmMsg = ws2.lastOf<{ t: string }>('rematch');
  check('点「再来一局」发出 rematch（不是直接离开）', Boolean(rmMsg), JSON.stringify(ws2.sent.slice(-2)));
  check('rematch 不带 ready 字段（服务端按切换处理）', rmMsg ? !('ready' in rmMsg) : false, JSON.stringify(rmMsg));
  check('点了之后没有直接离开房间（还在结算页）', Boolean($('.result')), bodyText().slice(0, 40));

  // 服务端回推：自己已准备、且两人都准备好了
  const readySeats = seatsInGame.map((x) => (x.playerId === 'u1' ? { ...x, ready: true } : x));
  ws2.emit({ t: 'room', room: 'A3KP', seats: readySeats, started: true, hostId: 'u1', isPublic: true, ready: { count: 2, total: 2 } });
  await sleep(100);
  check('已准备时按钮文案变成可取消', ($('.result-actions .primary')?.textContent ?? '').includes('点此取消'), $('.result-actions .primary')?.textContent ?? '');
  check('已准备的按钮有专属样式（不只是换文字）', ($('.result-actions .primary')?.className ?? '').includes('is-ready'), $('.result-actions .primary')?.className ?? '');
  check('全员准备好时提示「开局中」', ($('.ready-row')?.textContent ?? '').includes('开局中'), $('.ready-row')?.textContent ?? '');

  // 新一局开始：结算面板消失，回到对局
  ws2.emit({ t: 'room', room: 'A3KP', seats: seatsInGame, started: true, hostId: 'u1', isPublic: true, ready: { count: 0, total: 2 } });
  ws2.emit({ t: 'state', state: view, deadlineAt: Date.now() + 30_000, autopilot: false });
  await sleep(120);
  check('新一局开始后结算面板消失', !$('.result'));
  check('新一局回到对局界面', Boolean($('.battle')));

  /* ---------------- 8. 托管与收回 ---------------- */
  ws2.emit({
    t: 'state',
    state: view,
    deadlineAt: null,
    autopilot: true,
  });
  await sleep(100);
  check('被托管时出现托管提示条', Boolean($('.autopilot-bar')));
  check('托管时倒计时环消失', !$('.countdown'));
  check('托管时操作区变成只读', ($('.actionbar')?.className ?? '').includes('autopilot'));

  const backBtn = $$('.autopilot-bar button').find((b) => (b.textContent ?? '').includes('我回来了'));
  check('托管条上有「我回来了」', Boolean(backBtn));
  await click(backBtn ?? null);
  check('点「我回来了」发出 takeback', Boolean(ws2.lastOf('takeback')), JSON.stringify(ws2.sent.slice(-3)));

  ws2.emit({ t: 'state', state: view, deadlineAt: Date.now() + 20_000, autopilot: false });
  await sleep(100);
  check('收回后托管条消失', !$('.autopilot-bar'));
  check('收回后倒计时恢复', Boolean($('.countdown')));

  /* ---------------- 8b. 进房后的普通报错不能把人踢出对局 ---------------- */
  // 实测踩出来的：`intentRef` 进房后恒为 resume，而 error 分支只要看到 resume
  // 就当成「回座失败」→ 清存档 + 回大厅。于是「还没轮到你」这种误点会直接把人踢出局。
  ws2.emit({ t: 'error', msg: '还没轮到你。' });
  await sleep(120);
  check('进房后收到普通报错仍停在对局里', Boolean($('.battle')) && !$('.lobby'));
  check('普通报错显示成错误条', Boolean($('.actionbar .error')), bodyText().slice(0, 60));
  check('普通报错不清掉座位存档', Boolean(w.localStorage.getItem('abs:seat:A3KP')));

  /* ---------------- 8c. 服务端重启通知 ---------------- */
  // 重启通知不能用 error 类型表达：客户端会把 error 理解成「座位没了」。
  ws2.emit({ t: 'restart', msg: '服务器正在重启，稍候会自动重连（座位保留 5 分钟）。' });
  await sleep(120);
  check('收到重启通知仍停在对局里', Boolean($('.battle')) && !$('.lobby'));
  check('重启通知不清座位存档', Boolean(w.localStorage.getItem('abs:seat:A3KP')));
  check('重启通知以提示条形式出现', bodyText().includes('服务器正在重启'), bodyText().slice(0, 60));

  /* ---------------- 9. 断线重连 ---------------- */
  const before = MockWS.instances.length;
  ws2.close();
  await sleep(120);
  check('断线后出现重连遮罩', Boolean($('.reconnect-overlay')));
  check('断线时对局界面仍在（不清空状态）', Boolean($('.battle')));

  // 退避 400ms 后应该自动重连
  await sleep(700);
  check('自动重连新建了连接', MockWS.instances.length > before, `${before} → ${MockWS.instances.length}`);

  const ws3 = MockWS.live;
  const resumeMsg = ws3?.lastOf<{ t: string; room: string; token: string }>('resume');
  check('重连时用 token 回座（不是重新 join）', resumeMsg?.token === 'tk-abc', JSON.stringify(resumeMsg));
  check('重连时没有发 join（不会占新座位）', !ws3?.lastOf('join'));

  ws3!.emit({
    t: 'joined',
    playerId: 'u1',
    token: 'tk-abc',
    seat: 0,
    room: 'A3KP',
    host: true,
    resumed: true,
  });
  ws3!.emit({ t: 'room', room: 'A3KP', seats: seatsInGame, started: true, hostId: 'u1', isPublic: true });
  ws3!.emit({ t: 'state', state: view, deadlineAt: Date.now() + 30_000, autopilot: false });
  await sleep(150);

  check('回座后遮罩消失', !$('.reconnect-overlay'));
  check('回座后回到对局界面', Boolean($('.battle')));
  check('回座后提示「已回到原座位」', bodyText().includes('已回到原座位'), bodyText().slice(0, 80));

  /* ---------------- 10. 座位存档 ---------------- */
  const stored = w.localStorage.getItem('abs:seat:A3KP');
  check('座位凭证写入 localStorage', Boolean(stored && stored.includes('tk-abc')), stored ?? 'null');

  /* ---------------- 11. 房间被回收 ---------------- */
  ws3!.emit({ t: 'room', room: 'A3KP', seats: [], started: false, hostId: '', isPublic: true, closed: true });
  await sleep(150);
  check('房间被回收后回到大厅', Boolean($('.lobby')), bodyText().slice(0, 60));
  check('房间回收后清掉本地凭证', !w.localStorage.getItem('abs:seat:A3KP'));

  /* ---------------- 12. 观战 ---------------- */
  // 房间被回收后我们回到了大厅，正好从大厅走一次「观战」入口
  ws3!.emit({
    t: 'lobby',
    rooms: [
      { id: 'A3KP', players: 2, online: 2, capacity: 7, started: false, isPublic: true, hostName: '甲', joinable: true, spectators: 0, hasPassword: false },
      { id: 'B7QZ', players: 7, online: 7, capacity: 7, started: true, isPublic: true, hostName: '乙', joinable: false, spectators: 2, hasPassword: false },
      { id: 'C9MX', players: 1, online: 1, capacity: 7, started: false, isPublic: true, hostName: '丙', joinable: true, spectators: 0, hasPassword: true },
    ],
  });
  await sleep(120);

  check('大厅显示观战人数', bodyText().includes('2 人观战'), bodyText().slice(0, 120));

  const srows = $$('.room-row');
  const specBtn = srows[1]?.querySelector('button') as HTMLButtonElement | undefined;
  await click(specBtn ?? null);
  const specMsg = ws3!.lastOf<{ t: string; room: string }>('spectate');
  check('点「观战」发出 spectate 指令', specMsg?.room === 'B7QZ', JSON.stringify(specMsg));

  // 服务端下发的是「公开视角」：所有人的 hand 都是 null
  const publicView = redactPublic(game, pack);
  check('公开视角里没有任何手牌', publicView.players.every((p) => p.hand === null));

  ws3!.emit({
    t: 'joined',
    playerId: 'sp1',
    token: '',
    seat: -1,
    room: 'B7QZ',
    host: false,
    resumed: false,
    spectator: true,
    spectatorDelayRounds: 1,
  });
  ws3!.emit({
    t: 'room',
    room: 'B7QZ',
    seats: seatsInGame,
    started: true,
    hostId: 'u1',
    isPublic: true,
    spectators: 3,
  });
  ws3!.emit({ t: 'state', state: publicView, deadlineAt: Date.now() + 30_000, autopilot: false });
  await sleep(160);

  check('观战者进入对局界面', Boolean($('.battle')), bodyText().slice(0, 60));
  check('状态栏显示观战标记', Boolean($('.spec-pill')));
  check(
    '观战标记写明落后几轮（观众知道自己在看过去）',
    ($('.spec-pill')?.textContent ?? '').includes('慢 1 轮'),
    $('.spec-pill')?.textContent ?? '',
  );
  // 状态栏里已经有一个「延迟 12ms」表示网络往返，两个「延迟」并排会让人以为是网络卡了
  check(
    '观战标记不和网络延迟混淆',
    !($('.spec-pill')?.textContent ?? '').includes('延迟'),
    $('.spec-pill')?.textContent ?? '',
  );
  check('观战者没有手牌条', !$('.hand-strip'));
  check('观战者看到的是观战面板（不是操作区）', Boolean($('.spectator-panel')) && !$('.actionbar'));
  check(
    '观战面板用「当时」拉开时态（不让观众以为对局卡住了）',
    ($('.spec-actor')?.textContent ?? '').includes('当时轮到'),
    $('.spec-actor')?.textContent ?? '',
  );
  check(
    '观战面板写明落后几轮',
    ($('.spec-delay')?.textContent ?? '').includes('落后 1 轮'),
    $('.spec-delay')?.textContent ?? '',
  );
  check('观战面板说明看不到什么', ($('.spec-note')?.textContent ?? '').includes('不可见'), $('.spec-note')?.textContent ?? '');
  check('观战者没有托管条', !$('.autopilot-bar'));
  check('退出按钮文案为「退出观战」', bodyText().includes('退出观战'));
  check('观战者不写座位存档', !w.localStorage.getItem('abs:seat:B7QZ'));

  // 观战者断线：重连重放的必须是 spectate，不能是「空 token 回座」
  const beforeSpec = MockWS.instances.length;
  ws3!.close();
  await sleep(800);
  const ws4 = MockWS.live;
  check('观战者断线后自动重连', MockWS.instances.length > beforeSpec, `${beforeSpec} → ${MockWS.instances.length}`);
  check('观战重连发的是 spectate', ws4?.lastOf<{ room: string }>('spectate')?.room === 'B7QZ', JSON.stringify(ws4?.sent));
  check('观战重连不会用空 token 回座', !ws4?.lastOf('resume'));

  /* ---------------- 12b. 观战中房间被回收 ---------------- */
  // 观战者看的房间没人了会被回收，服务端发 { room, closed: true }。
  // 只把 status 切回 lobby 是不够的 —— BattlePage 里「spectator && !view」那个分支
  // 排在 inRoom / LobbyPage 之前，role 不清就会永远停在「正在进入观战…」。
  // 注意不能用 $('.lobby') 判断：那个过渡态自己的根节点也带 class="lobby"，
  // 会把这个 bug 直接盖住。要认大厅里才有的元素（昵称输入框）。
  ws4!.emit({ t: 'room', room: 'B7QZ', seats: [], started: false, hostId: '', isPublic: true, closed: true });
  await sleep(180);
  check('观战的房间被回收后回到大厅', Boolean($('.nick-input')), bodyText().slice(0, 80));
  check(
    '不会卡在「正在进入观战…」',
    !bodyText().includes('正在进入观战'),
    bodyText().slice(0, 80),
  );

  /* ---------------- 12c. 观战被拒（房间刚好没了） ---------------- */
  // 真实会发生的场景：大厅列表是几百毫秒前推的，你点「观战」时房间里的人
  // 可能刚走光、房间已被回收。点按钮那一刻 role 就被乐观设成 spectator 了，
  // 服务端拒绝后不清掉的话，界面会永远停在「正在进入观战…」。
  ws4!.emit({
    t: 'lobby',
    rooms: [
      { id: 'Q1W2', players: 3, capacity: 7, started: true, isPublic: true, hostName: '戊', joinable: false, spectators: 0, hasPassword: false },
    ],
  });
  await sleep(160);

  const specBtn2 = $$('button').find((b) => (b.textContent ?? '').trim() === '观战');
  check('大厅里有「观战」入口', Boolean(specBtn2));
  await click(specBtn2 ?? null);
  await sleep(160);
  check('点「观战」发出了 spectate 指令', Boolean(ws4!.lastOf('spectate')), JSON.stringify(ws4!.sent.slice(-2)));

  ws4!.emit({ t: 'error', msg: '房间 Q1W2 不存在。' });
  await sleep(200);
  check('观战被拒后回到大厅', Boolean($('.nick-input')), bodyText().slice(0, 80));
  check('观战被拒后不会停在「正在进入观战…」', !bodyText().includes('正在进入观战'), bodyText().slice(0, 80));
  check('观战被拒的原因有提示', bodyText().includes('不存在'), bodyText().slice(0, 120));

  /* ---------------- 13. 邀请链接 ---------------- */
  // 重挂一次 App，这次地址栏带 ?room=B7QZ
  root.unmount();
  await sleep(100);
  w.localStorage.clear();
  w.localStorage.setItem('abs:name', '老玩家');
  w.history.replaceState(null, '', '/?room=B7QZ');

  const root2 = createRoot(container);
  root2.render(createElement(App));
  await sleep(140);

  const tab2 = $$('.tabs-line button').find((b) => (b.textContent ?? '').includes('联机对局'));
  await click(tab2 ?? null);
  await sleep(140);

  check('邀请链接带进来的房间号已填好', (($('input[placeholder="例如 A3KP"]') as HTMLInputElement | null)?.value ?? '') === 'B7QZ');
  check('地址栏里的邀请参数被消费掉', w.location.search === '', w.location.search);
  check('顶部显示邀请提示', bodyText().includes('邀请链接'), bodyText().slice(0, 80));

  const ws5 = MockWS.live;
  ws5!.emit({ t: 'lobby', rooms: [] });
  await sleep(220);

  const inviteJoin = ws5!.lastOf<{ room: string; name: string }>('join');
  check('记住过昵称的人点链接直接进房', inviteJoin?.room === 'B7QZ', JSON.stringify(inviteJoin));
  check('自动加入用的是记住的昵称', inviteJoin?.name === '老玩家', inviteJoin?.name);

  /* ---------------- 14. 建房带密码 ---------------- */
  // 重挂一次，回到干净的大厅
  root2.unmount();
  await sleep(100);
  w.localStorage.clear();
  w.history.replaceState(null, '', '/');

  const root3 = createRoot(container);
  root3.render(createElement(App));
  await sleep(140);

  const tab3 = $$('.tabs-line button').find((b) => (b.textContent ?? '').includes('联机对局'));
  await click(tab3 ?? null);
  await sleep(160);

  const ws6 = MockWS.live;
  ws6!.emit({ t: 'lobby', rooms: [] });
  await sleep(100);

  const newPwInput = $('input[placeholder="房间密码（留空表示不设）"]') as HTMLInputElement | null;
  check('大厅有「建房设密码」的输入框', Boolean(newPwInput));
  setVal.call(newPwInput, '  abc  ');
  newPwInput!.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(60);

  const createBtn = $$('button').find((b) => (b.textContent ?? '').includes('创建并进入'));
  await click(createBtn ?? null);
  const createMsg = ws6!.lastOf<{ t: string; password?: string; isPublic?: boolean }>('create');
  check('建房指令带上密码', createMsg?.password === 'abc', JSON.stringify(createMsg));
  check('密码前后空格被去掉', createMsg?.password === 'abc', createMsg?.password);

  // 清空密码再建一次：字段必须是 undefined 而不是空串，
  // 否则服务端会把「空串」当成一个密码，房间变成谁也进不去
  setVal.call(newPwInput, '');
  newPwInput!.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(60);
  await click(createBtn ?? null);
  const createMsg2 = ws6!.lastOf<{ t: string; password?: string }>('create');
  check('密码留空时不下发 password 字段', createMsg2?.password === undefined, JSON.stringify(createMsg2));

  /* ---------------- 15. 主动离开要先打招呼 ---------------- */
  // 只关 socket 的话，服务端分不清「他走了」和「他 wifi 抖了一下」，
  // 只能按掉线给 5 分钟保座 —— 于是走掉的人会白占一个座位，下次开局还多一个 AI 空位。
  // 先让假服务端把「进房成功」补上，否则界面还停在大厅，根本没有「离开房间」按钮。
  ws6!.emit({ t: 'joined', playerId: 'u9', token: 'tk-pw', seat: 0, room: 'PW99', host: true, resumed: false });
  ws6!.emit({
    t: 'room',
    room: 'PW99',
    seats: [
      {
        playerId: 'u9',
        gamePlayerId: null,
        name: '我',
        seat: 0,
        connected: true,
        isBot: false,
        autopilot: false,
        ready: false,
      },
    ],
    started: false,
    hostId: 'u9',
    isPublic: true,
  });
  await sleep(120);

  /* ---------------- 15b. 「已离开」必须和「掉线」分开显示 ---------------- */
  // 服务端能分清这两件事（left 标记），但只下发 connected 的话界面上长得一样：
  // 走了的人被标成「掉线」，其他人会一直等他重连。
  // 这里直接喂一个「一个人走了 + 一个人掉线」的座位表，验标签文案。
  ws6!.emit({
    t: 'room',
    room: 'PW99',
    seats: [
      { playerId: 'u9', gamePlayerId: null, name: '我', seat: 0, connected: true, isBot: false, autopilot: false, ready: false },
      { playerId: 'u8', gamePlayerId: null, name: '走掉的人', seat: 1, connected: false, isBot: false, autopilot: true, left: true, ready: false },
      { playerId: 'u7', gamePlayerId: null, name: '掉线的人', seat: 2, connected: false, isBot: false, autopilot: true, ready: false },
    ],
    started: true,
    hostId: 'u9',
    isPublic: true,
  });
  await sleep(120);

  const seatText = (name: string): string => {
    const el = $$('.seat').find((x) => (x.textContent ?? '').includes(name));
    return el?.textContent ?? '';
  };
  const goneSeat = seatText('走掉的人');
  const offlineSeat = seatText('掉线的人');
  check('主动离开的座位显示「已离开」', goneSeat.includes('已离开'), goneSeat);
  check('主动离开的座位说明由 AI 代打', goneSeat.includes('AI 代打'), goneSeat);
  check('主动离开的座位不再显示「掉线」', !goneSeat.includes('掉线'), goneSeat);
  check('真的掉线的座位仍然显示「掉线」', offlineSeat.includes('掉线'), offlineSeat);
  check('掉线的座位不会被说成「已离开」', !offlineSeat.includes('已离开'), offlineSeat);
  check(
    '两种状态的座位在样式上可区分（.seat.left）',
    $$('.seat.left').length === 1,
    String($$('.seat.left').length),
  );

  const leaveBtn = $$('button').find((b) => (b.textContent ?? '').includes('离开房间'));
  check('房间页有「离开房间」按钮', Boolean(leaveBtn));
  await click(leaveBtn ?? null);
  check('点「离开房间」会先发 leave 指令', Boolean(ws6!.lastOf('leave')), JSON.stringify(ws6!.sent.slice(-3)));
  check('离开后回到未连接状态', !$('.room') && !$('.battle'));

  /* ---------------- 汇总 ---------------- */
  root3.unmount();
  await sleep(50);

  const failed = results.filter((r) => !r[1]);
  console.log(`\n通过 ${results.length - failed.length} / ${results.length} 项`);
  if (failed.length) {
    console.error('失败项：');
    failed.forEach((f) => console.error(`  - ${f[0]}${f[2] ? `：${f[2]}` : ''}`));
    process.exit(1);
  }
  console.log('联机界面交互测试通过。');
  process.exit(0);
}

main().catch((err) => {
  console.error('✖ 联机界面测试异常：');
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

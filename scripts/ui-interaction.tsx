/**
 * UI 交互冒烟 —— 用 jsdom 真正挂载 React、点按钮、把一整局打完。
 *
 * 与 ui-smoke.tsx 的区别：
 *   ui-smoke 只把组件渲成字符串（能抓导入错误 / 渲染崩溃）；
 *   本脚本走真实 DOM + 事件，能抓「按钮点了没反应」「handler 抛异常」
 *   「一局打不到结束」这类只有交互才暴露的问题。
 *
 * 运行：npx tsx scripts/ui-interaction.tsx
 */
import { JSDOM } from 'jsdom';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 收集 console.error，卡住时一起打出来 */
const errLog: string[] = [];
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  errLog.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  origError(...args);
};

async function main(): Promise<void> {
  /* ---------------- 先搭 DOM，再加载 React ---------------- */
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Window & typeof globalThis;
  const g = globalThis as Record<string, unknown>;
  g.window = w;
  g.document = w.document;
  // Node 22 里 globalThis.navigator 是只读 getter，只能用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: w.navigator,
    configurable: true,
    writable: true,
  });
  g.HTMLElement = w.HTMLElement;
  g.HTMLSelectElement = w.HTMLSelectElement;
  g.Element = w.Element;
  g.Node = w.Node;
  g.Event = w.Event;
  g.MouseEvent = w.MouseEvent;
  g.getComputedStyle = w.getComputedStyle.bind(w);
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.IS_REACT_ACT_ENVIRONMENT = false;

  // 必须在 DOM 就绪之后动态导入，否则 React 会判定为「无 DOM 环境」
  const { createRoot } = await import('react-dom/client');
  const { createElement } = await import('react');
  const { App } = await import('../src/ui/App');

  const container = w.document.getElementById('root')!;
  const root = createRoot(container);
  root.render(createElement(App));
  await sleep(80);

  const results: [string, boolean, string?][] = [];
  const check = (name: string, pass: boolean, extra?: string) => results.push([name, pass, extra]);

  /* ---------------- 辅助 ---------------- */
  const $ = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string) => Array.from(w.document.querySelectorAll(sel)) as HTMLElement[];

  const click = async (el: HTMLElement | null) => {
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(12);
    return true;
  };

  const setSelect = async (el: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(12);
  };

  const text = () => w.document.body.textContent ?? '';
  const bar = () => $('.actionbar');
  const barText = () => bar()?.textContent ?? '';
  const barButtons = () => (bar() ? (Array.from(bar()!.querySelectorAll('button')) as HTMLElement[]) : []);
  /** 只找可点击的按钮 */
  const btn = (kw: string) =>
    barButtons().find((b) => (b.textContent ?? '').includes(kw) && !(b as HTMLButtonElement).disabled) ?? null;
  /** 忽略 disabled 找按钮（用于「选够牌才可点」的场景） */
  const btnAny = (kw: string) => barButtons().find((b) => (b.textContent ?? '').includes(kw)) ?? null;
  // 必须限定在 .actionbar 内：页面下方还有一条只读的常驻手牌条，
  // 同样是 .hand .card，不限定范围会点到根本不能点的牌（点了没反应 → 误判卡死）
  const handCards = () => $$('.actionbar .hand .card');
  const selectedCard = () => $('.actionbar .hand .card.selected');

  /* ---------------- 1. 首页 ---------------- */
  check('首页渲染出标题', text().includes('风声再临'));
  check('首页有开始按钮', Boolean(Array.from(w.document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('开始对局'))));

  /* ---------------- 2. 切到单人 + AI，调快速度，开局 ---------------- */
  const hotCard = $$('.mode-card').find((c) => (c.textContent ?? '').includes('单机热座')) ?? null;
  await click(hotCard);
  check('点「单机热座」能切换选中态', (hotCard?.className ?? '').includes('active'));

  const aiCard = $$('.mode-card').find((c) => (c.textContent ?? '').includes('单人 + AI')) ?? null;
  await click(aiCard);
  check('切回「单人 + AI」模式', (aiCard?.className ?? '').includes('active'));

  const selects = $$('.launch select') as HTMLSelectElement[];
  check('启动面板有两个下拉（人数 / AI 速度）', selects.length === 2, `实际 ${selects.length}`);
  if (selects[0]) await setSelect(selects[0], '5');
  if (selects[1]) await setSelect(selects[1], '80');

  const startBtn = Array.from(w.document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('开始对局'),
  ) as HTMLElement | undefined;
  await click(startBtn ?? null);
  await sleep(200);

  check('进入对局界面', Boolean($('.battle')));
  check('开局先进入选角面板', $$('.pick-card').length === 3, `实际 ${$$('.pick-card').length} 张候选卡`);
  check('渲染出 5 个玩家面板', $$('.pcard').length === 5, `实际 ${$$('.pcard').length}`);
  check('渲染出情报日志', Boolean($('.battle-side')));

  /* ---------------- 3. 打完整局 ---------------- */
  let steps = 0;
  let lastLog = -1;
  // 按墙钟判卡死，不按迭代次数：一轮 5 个 AI 各自思考时日志会停很久，
  // 用次数判定会随机器快慢误报（实测同一份代码 148 ~ 733 步都能出现）
  let lastProgressAt = Date.now();
  let discardFix = 0;

  while (steps < 3000) {
    steps += 1;
    if ($('.overlay .result')) break;

    const logCount = $$('.log-item').length;
    if (logCount !== lastLog) {
      lastLog = logCount;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > 25_000) {
      break;
    }

    // 选角阶段：点第一张候选卡
    const pickCards = $$('.pick-card');
    if (pickCards.length > 0) {
      await click(pickCards[0]!);
      continue;
    }

    // 用操作区标题判断阶段（不能用整段文本，等待态的 prompt 里也会出现「情报阶段」）
    const title = $('.actionbar .actionbar-title strong')?.textContent?.trim() ?? '';

    // 出牌阶段
    if (title === '出牌阶段') {
      await click(btn('结束出牌'));
      continue;
    }
    // 接收决策
    if (title === '接收决策') {
      await click(btn('收下'));
      continue;
    }
    // 响应窗口
    if (title === '识破响应' || title === '截获响应') {
      await click(btn('放弃响应'));
      continue;
    }

    // 弃牌阶段：先按提示选够张数，再确认
    if (title === '弃牌阶段') {
      const m = barText().match(/已选\s*(\d+)\s*\/\s*(\d+)/);
      const need = m ? Number(m[2]) : 1;
      const have = m ? Number(m[1]) : 0;
      if (have < need) {
        const cards = handCards();
        if (cards.length === 0) break;
        await click(cards[0]!);
        discardFix += 1;
        if (discardFix > 300) break;
        continue;
      }
      await click(btnAny('确认弃牌'));
      continue;
    }

    // 情报阶段：先选一张手牌，再点「传出」（默认密电，不需要指定目标）
    if (title === '情报阶段') {
      if (!selectedCard()) {
        const cards = handCards();
        if (cards.length === 0) break;
        await click(cards[0]!);
        continue;
      }
      await click(btn('传出这张情报'));
      continue;
    }

    await sleep(30);
  }

  const finished = Boolean($('.overlay .result'));
  if (!finished) {
    console.log('\n--- 卡住现场 ---');
    console.log('状态栏：', $('.statusbar')?.textContent ?? '(无)');
    console.log('操作区：', bar()?.textContent?.slice(0, 300) ?? '(无 actionbar)');
    console.log(
      '按钮：',
      barButtons().map((b) => `${b.textContent}${(b as HTMLButtonElement).disabled ? '(禁用)' : ''}`),
    );
    console.log('手牌数：', handCards().length);
    console.log('错误条：', $('.actionbar .error')?.textContent ?? '(无)');
    console.log('最后日志：', $$('.log-item').slice(-6).map((e) => e.textContent));
    if (errLog.length > 0) console.log('console.error：', errLog.slice(-6));
  }
  check('一局能打到结束', finished, finished ? undefined : `卡在第 ${steps} 步`);
  check('结束后弹出结算面板', text().includes('对 局 结 束'));
  check('结算面板有再来一局按钮', Boolean(Array.from(w.document.querySelectorAll('.result button')).find((b) => (b.textContent ?? '').includes('再来一局'))));

  /* ---------------- 4. 配置页 ---------------- */
  const cfgTab = Array.from(w.document.querySelectorAll('.topbar button')).find((b) =>
    (b.textContent ?? '').includes('数据配置'),
  ) as HTMLElement | undefined;
  await click(cfgTab ?? null);
  await sleep(120);
  check('切到配置页', Boolean($('.config')));
  check('配置页渲染出卡牌表', $$('.config table.grid tbody tr').length > 50, `实际 ${$$('.config table.grid tbody tr').length} 行`);
  check('配置页显示校验通过', (text().includes('无错误')), undefined);

  // 改名：先改一张卡的名称，确认表格可编辑（名称是第 2 个 input，第 1 个是 id）
  const rowInputs = $$('.config table.grid tbody tr:first-child input') as HTMLInputElement[];
  const nameInput = rowInputs[1] ?? null;
  if (nameInput) {
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(nameInput, '改名测试');
    nameInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(60);
    check('卡牌名称可编辑', nameInput.value === '改名测试', `实际 ${nameInput.value}`);
  } else {
    check('卡牌名称可编辑', false, '找不到名称输入框');
  }

  /* ---------------- 输出 ---------------- */
  let ok = true;
  for (const [name, pass, extra] of results) {
    console.log(`${pass ? '✔' : '✖'} ${name}${pass || !extra ? '' : `  —— ${extra}`}`);
    if (!pass) ok = false;
  }
  console.log(`\n共 ${results.length} 项检查，交互 ${steps} 步。`);
  if (!ok) process.exit(1);
  console.log('UI 交互冒烟通过。');
  process.exit(0);
}

main().catch((e) => {
  console.error('交互测试异常：', e);
  process.exit(1);
});

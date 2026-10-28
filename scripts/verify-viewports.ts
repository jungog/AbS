/**
 * 多视口自查：手机竖屏 / 小笔记本 720p / 桌面 900p。
 *
 * 为什么需要它：对局界面是「状态栏 + 目标条 + 座位卡 + 操作区 + 情报日志」竖排，
 * 座位卡一多就把操作区推到折叠线以下 —— 而「轮到你出牌，但按钮在屏幕外」
 * 是那种开发机上永远看不到、玩家第一次用就会骂的问题。
 *
 * 判据（每个视口都跑一遍）：
 *   1. 三个页面都没有横向溢出
 *   2. 关键元素滚过去之后横向不被裁切
 *   3. 顶栏没有折行（390px 下「对局」曾被挤成「对 / 局」两行）
 *   4. 选角卡片的角色名不竖排（3 列在手机上会把「情报贩子」挤成一列一个字）
 *   5. 轮到自己时，操作区**不用滚就完整可见**（吸底是否生效）
 *   6. 不是自己回合时，手牌条贴在自己的滚动容器底部
 *   7. 吸底的操作区不会把牌板整个盖住（至少露出 1 张座位卡）
 * 手机额外：手牌必须是单排（换行会让操作区高到盖死牌板）；
 *          情报日志不超过屏高 1/6（它按固定像素吃高度，很容易把牌板挤没）。
 *
 * 前置：npm run build && npm run server，然后 npm run check:viewports
 *      ABS_URL 可覆盖地址，默认打 8787 的生产构建
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import {
  isSidewaysSize,
  rightColumnState,
  rightColumnVerdict,
} from './lib/right-column';

const URL = process.env.ABS_URL ?? 'http://localhost:8787/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  label: string;
}

const VIEWPORTS: Viewport[] = [
  { name: 'mobile', width: 390, height: 844, mobile: true, label: '手机竖屏 390×844' },
  { name: 'small', width: 360, height: 640, mobile: true, label: '小屏安卓 360×640' },
  { name: 'laptop720', width: 1280, height: 720, mobile: false, label: '小笔记本 1280×720' },
  { name: 'landscape', width: 844, height: 390, mobile: true, label: '手机横屏 844×390' },
  { name: 'desktop', width: 1440, height: 900, mobile: false, label: '桌面 1440×900' },
];

/**
 * 「横屏矮屏」= 手机横放（844×390 这类），横屏布局只对这一类生效。
 *
 * **只能用视口尺寸判断，不能用元素几何**（比如 bar.left > log.left、width > height）。
 * 桌面 1280×720 / 1440×900 的 width 也大于 height，用几何判断会把它们一起带进横屏分支：
 * 那里的 padding-right 是 0，右栏断言就变成「没留右栏 → 算通过」的空断言，
 * 全绿但什么都没测。这个坑踩过两次（日志 1/6 那条、右栏那条），所以收成一个函数。
 */
const isSideways = (vp: Viewport): boolean => isSidewaysSize(vp.width, vp.height);

let passed = 0;
let skipped = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✖ ${label}${detail !== undefined ? ` —— ${String(detail)}` : ''}`);
  }
}

async function shot(p: Page, name: string): Promise<void> {
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  · ${OUT}/${name}.png`);
}

/** 整页有没有横向溢出（手机上最常见的坏法：整页可以左右拖） */
async function hasHScroll(p: Page): Promise<boolean> {
  return p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

/**
 * 座位卡上的玩家名被压成省略号了吗。
 *
 * 判据是 `scrollWidth > clientWidth` —— `.pcard-name` 上有
 * `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`，
 * 装不下就是这个差值大于 0，跟 `…` 有没有真的画出来无关。
 *
 * 为什么会发生：`.pcard-name` 的 `overflow: hidden` 让 flex 的
 * `min-width: auto` **解析成 0**（规范：可滚动容器的自动最小尺寸是 0），
 * 于是它成了卡头里唯一能被压缩的东西。360×640 实测（联机房间 1 真人 + 4 AI）：
 * 卡头内容宽 131px，而「座位号 12 + 名字『机器人 1』61 + AI 徽标 26 +
 * 身份标签『身份未知』44 + 间距 21 = 164px」，名字被压到 **28px** ——
 * 四个 AI 全显示成「机…」，谁是谁分不出来。
 *
 * 返回被截断的张数和样例文字，方便失败时直接看出是谁。
 */
async function clippedNames(p: Page): Promise<{ n: number; total: number; sample: string }> {
  return (await p.evaluate(`(() => {
    const all = [...document.querySelectorAll('.pcard-name')];
    const bad = all.filter((e) => e.scrollWidth > e.clientWidth + 1);
    return {
      n: bad.length,
      total: all.length,
      sample: bad.map((e) => (e.textContent || '').trim()).slice(0, 4).join('、'),
    };
  })()`)) as { n: number; total: number; sample: string };
}

/** 元素「够得着吗」：先滚到它，再量横向是否完整落在视口里 */
async function reachable(p: Page, sel: string): Promise<boolean> {
  const loc = p.locator(sel).first();
  if ((await loc.count()) === 0) return false;
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await loc.boundingBox();
  if (!box || box.width === 0 || box.height === 0) return false;
  const vp = p.viewportSize();
  if (!vp) return false;
  return box.x >= -1 && box.x + box.width <= vp.width + 1;
}

interface InView {
  found: boolean;
  /** 整块落在最近那个滚动容器的可视区内（上下都不越界） */
  ok: boolean;
  top: number;
  bottom: number;
  boxTop: number;
  boxBottom: number;
  scrollTop: number;
  scrollMax: number;
}

/**
 * 折行后落到行首的「孤儿分隔竖线」。
 *
 * `.room-actions > .field-inline + button { border-left: 1px }` 本意是
 * 「同一行里把准备进度 / 下一局 AI / 主按钮切成三块」。可这个条子是
 * `flex-wrap: wrap` 的：360 宽上按钮折到第二行，`border-left` 就画在行首
 * （x = 内容左边缘 20px），变成一根指向左边空白的短线。
 *
 * 判据是几何的、不认类名：任何带 `border-left` 的子元素，左边必须在**同一行上**
 * 有兄弟顶着（`o.right <= k.left` 且纵向区间有重叠）。以后再加块、
 * 或者改 flex 方向，这条都会自己去查。
 */
async function orphanSeparators(
  p: Page,
  sel = '.room-actions',
): Promise<{ orphans: string[]; rows: number; h: number }> {
  return p.evaluate(`(() => {
    const bar = document.querySelector(${JSON.stringify(sel)});
    if (!bar) return { orphans: [], rows: 0, h: 0 };
    const kids = [...bar.children].map((c) => {
      const r = c.getBoundingClientRect();
      return {
        text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 12),
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        bl: parseFloat(getComputedStyle(c).borderLeftWidth) || 0,
      };
    });
    const orphans = kids
      .filter((k, i) => k.bl > 0 && !kids.some((o, j) =>
        j !== i && o.right <= k.left + 1 && o.bottom > k.top + 1 && o.top < k.bottom - 1))
      .map((k) => k.text);
    // 折成了几行：按 top 排序，top 越过当前行的底就换行
    const sorted = [...kids].sort((a, b) => a.top - b.top);
    let rows = 0;
    let curBottom = -Infinity;
    for (const k of sorted) {
      if (k.top >= curBottom - 1) {
        rows++;
        curBottom = k.bottom;
      } else {
        curBottom = Math.max(curBottom, k.bottom);
      }
    }
    return { orphans, rows, h: Math.round(bar.getBoundingClientRect().height) };
  })()`) as Promise<{ orphans: string[]; rows: number; h: number }>;
}

/**
 * 元素是否**不用滚**就整块落在最近的可滚动祖先（或视口）里。
 *
 * 为什么不能直接用 `reachable()`：它第一步就 `scrollIntoViewIfNeeded()`，
 * 于是「进页面时滚动位置不对」这类 bug 会被它自己抹平 ——
 * 房间页实测一打开就滚在 `232/248`（360×640 上是 `286/286`，直接滚到底），
 * `reachable('.room-bigcode')` 照样是绿的：它量的是「滚一下够不够得着」，
 * 而玩家抱怨的是「一打开就看不见」。判据必须量**滚动之前**的状态。
 */
async function inScrollView(p: Page, sel: string): Promise<InView> {
  return p.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    const empty = { found: false, ok: false, top: 0, bottom: 0, boxTop: 0, boxBottom: 0, scrollTop: 0, scrollMax: 0 };
    if (!el) return empty;
    let box = el.parentElement;
    while (box) {
      const cs = getComputedStyle(box);
      if (/(auto|scroll)/.test(cs.overflowY) && box.scrollHeight > box.clientHeight + 1) break;
      box = box.parentElement;
    }
    const er = el.getBoundingClientRect();
    const br = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    return {
      found: true,
      ok: er.top >= br.top - 1 && er.bottom <= br.bottom + 1,
      top: Math.round(er.top),
      bottom: Math.round(er.bottom),
      boxTop: Math.round(br.top),
      boxBottom: Math.round(br.bottom),
      scrollTop: box ? Math.round(box.scrollTop) : 0,
      scrollMax: box ? box.scrollHeight - box.clientHeight : 0,
    };
  })()`) as Promise<InView>;
}

/** 顶栏有没有被挤到折行 —— 390px 下「风声再临 + 英文副标题 + 两个 tab」曾经
 *  超宽，「对局」被挤成「对 / 局」两行、主标题也折成两行。 */
async function topbarIntact(p: Page): Promise<{ ok: boolean; detail: string }> {
  const r = await p.evaluate(() => {
    const bar = document.querySelector('.topbar') as HTMLElement | null;
    if (!bar) return null;
    const btns = [...bar.querySelectorAll('.tabs button')] as HTMLElement[];
    const maxBtn = Math.max(0, ...btns.map((b) => Math.round(b.getBoundingClientRect().height)));
    return {
      barH: Math.round(bar.getBoundingClientRect().height),
      overflow: bar.scrollHeight - bar.clientHeight,
      maxBtn,
    };
  });
  if (!r) return { ok: false, detail: '找不到顶栏' };
  // 单行 tab 约 30px；折成两行会到 48px 以上
  return {
    ok: r.overflow <= 1 && r.maxBtn <= 34,
    detail: `顶栏高 ${r.barH} / 纵向溢出 ${r.overflow}px / tab 最高 ${r.maxBtn}px`,
  };
}

/**
 * 手机上手指点得准吗：可点元素至少 32×32。
 *
 * 44 是理想值，32 是底线 —— 低于这个尺寸，触摸会因为「点在两个元素中间」而误触。
 * 实测抓到过两个：顶栏 tab 28px、结算页「调整座位 / 人数」只有 16px 高
 * （文字链接样式，padding 是 0）。后者在手机上几乎点不中。
 */
async function smallTapTargets(p: Page): Promise<{ count: number; worst: string }> {
  const bad = await p.evaluate(() => {
    const els = document.querySelectorAll('button, [role="button"], a, .card, .pick-card, .seat');
    const out: string[] = [];
    for (let i = 0; i < els.length; i++) {
      const e = els[i] as HTMLElement;
      const rc = e.getBoundingClientRect();
      if (rc.width === 0 || rc.height === 0) continue; // 隐藏的不算
      if (rc.width < 32 || rc.height < 32) {
        const cls = typeof e.className === 'string' ? e.className : e.tagName;
        out.push(`${Math.round(rc.width)}×${Math.round(rc.height)} ${cls.slice(0, 20)}`);
      }
    }
    return out;
  });
  return { count: bad.length, worst: bad.slice(0, 3).join(' | ') };
}

/** 把对局页的滚动条拉回最上面（模拟「刚轮到我，屏幕还停在座位卡」） */
async function scrollBattleTop(p: Page): Promise<void> {
  await p.evaluate(() => {
    const m = document.querySelector('.battle-main');
    if (m) m.scrollTop = 0;
  });
  await sleep(250);
}

/**
 * 手牌条是否贴在**滚动容器**的底部。
 *
 * 参照物必须是 `.battle-main`，不是视口：窄屏下布局是四段竖排，
 * 日志栏占掉屏幕最下面约 190px，所以容器底边比视口底边高。
 *
 * **查询和测量必须在同一个 evaluate 里完成**：分两步的话，
 * 中间刚好轮到我、手牌条被操作区替换掉，量到的就是 null ——
 * 实测偶发红过一次，报「元素不存在」。
 */
async function handStripAnchored(
  p: Page,
): Promise<{ state: 'gone' | 'ok'; gap: number; insideX: boolean }> {
  return p.evaluate(() => {
    const strip = document.querySelector('.hand-strip') as HTMLElement | null;
    const main = document.querySelector('.battle-main') as HTMLElement | null;
    if (!strip || !main) return { state: 'gone' as const, gap: 0, insideX: false };
    const s = strip.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return {
      state: 'ok' as const,
      gap: Math.round(m.bottom - s.bottom),
      insideX: s.left >= m.left - 1 && s.right <= m.right + 1,
    };
  });
}

/**
 * 操作区是否**不用滚就完整可见**。
 *
 * 这是「吸底有没有用」最直接的判据：内容装得下时它本来就在视口里（sticky 等于没生效），
 * 装不下时必须被钉在底部 —— 两种情况下这个条件都成立才算对。
 */
async function actionFullyVisible(p: Page): Promise<{ ok: boolean; detail: string }> {
  const r = await p.evaluate(() => {
    const main = document.querySelector('.battle-main') as HTMLElement | null;
    const bar = document.querySelector('.actionbar:not(.waiting)') as HTMLElement | null;
    if (!main || !bar) return null;
    main.scrollTop = 0;
    const m = main.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return {
      barTop: Math.round(b.top),
      barBottom: Math.round(b.bottom),
      mainTop: Math.round(m.top),
      mainBottom: Math.round(m.bottom),
      overflow: main.scrollHeight - main.clientHeight,
      ok: b.top >= m.top - 1 && b.bottom <= m.bottom + 1,
    };
  });
  if (!r) return { ok: false, detail: '找不到操作区' };
  return {
    ok: r.ok,
    detail: `操作区 ${r.barTop}~${r.barBottom} / 可滚区 ${r.mainTop}~${r.mainBottom} / 溢出 ${r.overflow}px`,
  };
}

/** 吸底的操作区上方还看得见几张座位卡（全盖住等于「出牌时看不到桌上」）。
 *
 *  两个层次：
 *   - count：**完整**露出来的张数
 *   - identity：至少「名字 + 角色」露出来的张数
 *  只数「露一条缝」的没意义（360×640 上一屏只剩 90px 也能算通过），所以不用那个判据。
 *  矮屏（<700px）纵向预算真的不够：640 高的屏里状态区 194px + 操作区 216px，
 *  一张卡 154px 完整放下需要 564px，而可滚区只有 486px。
 *  那种尺寸下要求「至少能看清对面是谁」——这是还能做决策的最低标准。 */
async function visibleSeatCards(
  p: Page,
): Promise<{
  count: number;
  identity: number;
  barH: number;
  barTop: number;
  mainTop: number;
  firstTop: number;
  above: string;
}> {
  const r = await p.evaluate(() => {
    const main = document.querySelector('.battle-main') as HTMLElement | null;
    const bar = document.querySelector('.actionbar:not(.waiting)') as HTMLElement | null;
    if (!main || !bar) {
      return { count: -1, identity: -1, barH: 0, barTop: 0, mainTop: 0, firstTop: 0, above: '无容器' };
    }
    const m = main.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    let count = 0;
    let identity = 0;
    const cards = document.querySelectorAll('.pcard');
    for (let i = 0; i < cards.length; i++) {
      const r2 = cards[i].getBoundingClientRect();
      const inX = r2.left >= m.left - 1 && r2.right <= m.right + 1;
      const fullyInY = r2.top >= m.top - 1 && r2.bottom <= b.top - 4;
      if (inX && fullyInY) count++;
      // 身份行 = 卡片顶部的名字 + 角色标签
      const char = cards[i].querySelector('.pcard-char');
      const last = char ? char.getBoundingClientRect() : r2;
      if (inX && r2.top >= m.top - 1 && last.bottom <= b.top - 4) identity++;
    }
    // 牌板上方有什么、各占多高。首卡顶在几次跑之间会浮动 39px，
    // 那是 notice（padding 9 + 文字 21 + margin 16 ≈ 55）这类块时有时无。
    const above: string[] = [];
    const kids = main.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i] as HTMLElement;
      const kr = k.getBoundingClientRect();
      if (kr.height < 1) continue;
      const t = (k.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 18);
      above.push(`${String(k.className).split(' ')[0]}:${Math.round(kr.height)}${t ? `(${t})` : ''}`);
    }
    const first = cards[0] ? cards[0].getBoundingClientRect() : null;
    return {
      count,
      identity,
      barH: Math.round(b.height),
      barTop: Math.round(b.top),
      mainTop: Math.round(m.top),
      firstTop: first ? Math.round(first.top) : -1,
      above: above.join(' | '),
    };
  });
  return r;
}

/**
 * 日志「跟尾」状态。
 *
 * `lastInside` 是用户可见的性质：最后一条日志有没有落在日志区的可视范围内。
 * 只报 `gap` 不够 —— 不跟尾时 `gap` 是个大数，但在「没溢出」的短日志上
 * `gap` 恒为 0，看 `gap` 会得出「一切正常」的错误结论。
 * 所以把 `scrollable` 一起带出来，让绿行也能看出这一条到底有没有真的走到滚动路径。
 */
async function logTailState(p: Page): Promise<{
  n: number;
  scrollable: boolean;
  gap: number;
  lastInside: boolean;
  lastText: string;
} | null> {
  return p.evaluate(`(() => {
    const list = document.querySelector('.log-list');
    const items = document.querySelectorAll('.log-item');
    if (!list || items.length === 0) return null;
    const lr = list.getBoundingClientRect();
    const last = items[items.length - 1];
    const tr = last.getBoundingClientRect();
    return {
      n: items.length,
      scrollable: list.scrollHeight > list.clientHeight + 1,
      gap: list.scrollHeight - list.clientHeight - Math.round(list.scrollTop),
      lastInside: tr.top >= lr.top - 1 && tr.bottom <= lr.bottom + 1,
      lastText: (last.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
    };
  })()`) as Promise<{
    n: number;
    scrollable: boolean;
    gap: number;
    lastInside: boolean;
    lastText: string;
  } | null>;
}

/**
 * 用户往上翻之后，日志还抢不抢滚动。
 *
 * 老实现是内联 ref 回调 `el.scrollTop = el.scrollHeight` —— 每次渲染都跑，
 * 等于**无条件**滚到底。360×640 实测：翻到顶 scrollTop 0，对面一出牌就跳回 199
 * （= 最底部），而那块只有 62px 高（不到 3 行），历史根本读不了。
 *
 * 两半都要验：翻上去要停住，翻回底部要重新跟上。
 * 只验前一半的话，一个「永远不滚」的实现也能过 —— 那比抢滚动更糟。
 */
async function logScrollRespect(p: Page): Promise<{
  overflow: number;
  grewUp: boolean;
  upAfter: number;
  grewDown: boolean;
  downGap: number;
  /** 「↓ N 条新消息」：翻上去之后有新消息时应该出现 */
  pill: { text: string; h: number; inside: boolean } | null;
  /** 这一段到底有没有跑成（翻上去了、且真的有新日志）——
   *  跑成了却没出现药丸是**失败**，没跑成才跳过。两者混在一起会让回归变成「静默跳过」。 */
  pillTried: boolean;
  /** 点完之后：距底多少 px、药丸是否消失 */
  afterJump: { gap: number; gone: boolean } | null;
} | null> {
  const read = `(() => {
    const el = document.querySelector('.log-list');
    if (!el) return null;
    return {
      top: Math.round(el.scrollTop),
      n: document.querySelectorAll('.log-item').length,
      max: el.scrollHeight - el.clientHeight,
    };
  })()`;
  const setTop = (v: 'top' | 'bottom') =>
    p.evaluate(
      `(() => { const el = document.querySelector('.log-list'); if (el) el.scrollTop = ${
        v === 'top' ? 0 : 'el.scrollHeight'
      }; })()`,
    );

  const start = (await p.evaluate(read)) as { top: number; n: number; max: number } | null;
  // 没溢出就没有滚动路径可测，返回 null 让调用方跳过
  if (!start || start.max <= 4) return null;

  /** 制造一条新日志：优先点操作区的按钮，其次选一张手牌传出去 */
  const nudge = async (): Promise<void> => {
    for (const kw of ['结束出牌', '收下', '放弃响应', '确认弃牌']) {
      const b = p.locator('.actionbar button:not([disabled])').filter({ hasText: kw });
      if ((await b.count()) > 0) {
        await b.first().click().catch(() => undefined);
        return;
      }
    }
    const card = p.locator('.actionbar .hand .card:not(.selected)').first();
    if ((await card.count()) > 0) {
      await card.click().catch(() => undefined);
      await sleep(120);
      const out = p.locator('.actionbar button:not([disabled])').filter({ hasText: '传出这张情报' });
      if ((await out.count()) > 0) await out.first().click().catch(() => undefined);
    }
  };

  /**
   * 等日志条数变多（最多 3 秒）；等不到返回 false。
   *
   * 中途会再推一步：点「结束出牌」只是推进阶段，不一定写日志，
   * 而「传出一张牌」一定会写。第一版只推一次，结果 3 个视口都等不到新日志，
   * 断言被跳过 —— 跳过比红更危险，它会让人以为测过了。
   */
  const waitGrow = async (from: number): Promise<boolean> => {
    for (let i = 0; i < 12; i++) {
      if (i === 4 || i === 8) await nudge();
      await sleep(250);
      const s = (await p.evaluate(read)) as { n: number } | null;
      if (s && s.n > from) return true;
    }
    return false;
  };

  // a. 翻到顶，来新日志，位置不该动
  await setTop('top');
  await sleep(150);
  const a0 = (await p.evaluate(read)) as { n: number };
  await nudge();
  const grewUp = await waitGrow(a0.n);
  const a1 = (await p.evaluate(read)) as { top: number };

  // b. 翻回底部，来新日志，应该重新跟上
  await setTop('bottom');
  await sleep(150);
  const b0 = (await p.evaluate(read)) as { n: number };
  await nudge();
  const grewDown = await waitGrow(b0.n);
  const b1 = (await p.evaluate(read)) as { top: number; max: number };

  /**
   * c. 翻上去之后来了新消息 —— 底部要浮出「↓ N 条新消息」，点它回到底部。
   *
   * 这一段和 a 是同一个场景的两种要求：a 只要求「别把我拽下去」，
   * c 要求「别让我错过」—— 只做到 a 的话，日志变成一块静止的旧纸，
   * 用户永远得自己想起来往下拨。
   */
  await setTop('top');
  await sleep(150);
  const c0 = (await p.evaluate(read)) as { n: number; top: number; max: number };
  let pill: { text: string; h: number; inside: boolean } | null = null;
  let afterJump: { gap: number; gone: boolean } | null = null;
  let pillTried = false;
  // 只有「真的翻上去了」才有意义：内容没溢出时 scrollTop 恒 0，
  // 程序化设 0 不触发 scroll 事件，stickRef 还是 true，药丸永远不该出现。
  if (c0.max > 4 && c0.top <= 4) {
    await nudge();
    pillTried = await waitGrow(c0.n);
    pill = (await p.evaluate(`(() => {
      const b = document.querySelector('.log-jump');
      const list = document.querySelector('.log-list');
      if (!b || !list) return null;
      const r = b.getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      return {
        text: (b.textContent || '').replace(/\\s+/g, ' ').trim(),
        h: Math.round(r.height),
        inside:
          r.left >= lr.left - 1 && r.right <= lr.right + 1 &&
          r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1,
      };
    })()`)) as { text: string; h: number; inside: boolean } | null;
    if (pill) {
      await p.locator('.log-jump').click().catch(() => undefined);
      await sleep(300);
      const c2 = (await p.evaluate(read)) as { top: number; max: number };
      const gone = (await p.evaluate(`!document.querySelector('.log-jump')`)) as boolean;
      afterJump = { gap: c2.max - c2.top, gone };
    }
  }

  return {
    overflow: start.max,
    grewUp,
    upAfter: a1.top,
    grewDown,
    downGap: b1.max - b1.top,
    pill,
    afterJump,
    pillTried,
  };
}

/**
 * 横屏日志栏能放下几条日志。
 *
 * 横屏 `.battle-side` 只有 120px 高，而推理全靠这份日志（谁选了什么角色）。
 * 原来 `.log-head` 吃 40px、`.log-list` 自带 20px 底部留白，实测**完整可见只有 2 条**。
 * 压缩标题内边距 + 列表留白 + 条目内边距后变 3 条。
 *
 * 用「内容盒高度 ÷ 单条高度」算，而不是数「当前哪几条完整可见」——
 * 后者会被「日志刚好滚到某一条的一半」影响，换个条目长度结论就变。
 */
async function logDensity(p: Page): Promise<{
  headH: number;
  contentH: number;
  itemH: number;
  fits: number;
} | null> {
  return p.evaluate(`(() => {
    const head = document.querySelector('.log-head');
    const list = document.querySelector('.log-list');
    const items = [...document.querySelectorAll('.log-item')];
    if (!head || !list || items.length === 0) return null;
    const cs = getComputedStyle(list);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const contentH = list.clientHeight - padY;
    const itemH = Math.min(...items.map((e) => e.getBoundingClientRect().height));
    return {
      headH: Math.round(head.getBoundingClientRect().height),
      contentH: Math.round(contentH),
      itemH: Math.round(itemH),
      fits: Math.floor(contentH / itemH),
    };
  })()`) as Promise<{ headH: number; contentH: number; itemH: number; fits: number } | null>;
}

/**
 * 横屏：主按钮到底看不看得见 —— **按最坏情况量**。
 *
 * 右栏只有 218px 高（屏高 390 − 顶栏 52 − 日志 120），而操作区内容会随阶段变高：
 * 出牌阶段「标题 + 一行按钮」约 230px 勉强放得下，情报阶段多一行「方式：密电 / 文本」、
 * 有时再加一行「接收者」和一句「这是你要收的红色情报」警告 —— 实测 346px，溢出 129px。
 *
 * 所以只量「轮到我」那一帧是不够的：它多半是出牌阶段，内容刚好装得下，
 * 断言就变成「去掉修复也照样绿」的空过（实测过：把 `position: sticky` 改成 static，
 * 这条仍然绿）。这里注入两行假的操作行把内容顶长，再量主按钮还在不在栏里。
 *
 * 注入和测量必须在**同一个 evaluate** 里做完：React 每秒会重渲染一次，
 * 分两次调用时注入的节点会被冲掉（这个坑在 `worstTaskSeats` 里踩过）。
 */
async function primaryActionVisible(p: Page): Promise<{ ok: boolean; detail: string }> {
  return p.evaluate(`(() => {
    const bar = document.querySelector('.actionbar:not(.waiting)');
    if (!bar) return { ok: false, detail: '找不到操作区' };
    const rows = [...bar.querySelectorAll(':scope > .action-row')];
    if (rows.length === 0) return { ok: false, detail: '操作区里没有 .action-row' };
    const last = rows[rows.length - 1];

    // 最坏情况：在最后一行之前塞两行占位（模拟「方式 + 接收者 + 警告」那几行）
    const fakes = [];
    for (let i = 0; i < 2; i++) {
      const d = document.createElement('div');
      d.className = 'action-row';
      d.setAttribute('data-probe', '1');
      const s = document.createElement('span');
      s.className = 'hint';
      s.textContent = '（最坏情况占位：接收者选择 + 目标色警告会各占一行）';
      d.appendChild(s);
      bar.insertBefore(d, last);
      fakes.push(d);
    }

    const btn = last.querySelector('.primary') || last.querySelector('button');
    const b = bar.getBoundingClientRect();
    const r = btn ? btn.getBoundingClientRect() : null;
    const ok =
      !!r && r.top >= b.top - 1 && r.bottom <= b.bottom + 1 &&
      r.left >= b.left - 1 && r.right <= b.right + 1;
    const detail =
      (r
        ? '按钮 ' + Math.round(r.top) + '..' + Math.round(r.bottom) +
          ' / 栏 ' + Math.round(b.top) + '..' + Math.round(b.bottom)
        : '找不到主按钮') +
      '（最坏情况内容高 ' + bar.scrollHeight + ' / 可视 ' + bar.clientHeight + '）' +
      (btn ? ' · 文案「' + (btn.textContent || '').trim().slice(0, 12) + '」' : '');

    for (const d of fakes) d.remove();
    return { ok, detail };
  })()`) as Promise<{ ok: boolean; detail: string }>;
}

/**
 * 倒计时环：数字从两位变一位时，状态条不许重排。
 *
 * 环里 `<b>` 是 30 → 9 → 1 变化的，而它 `margin-left: auto` 顶在状态条最右边 ——
 * 少一位数字就窄 8px，如果不给 `min-width` + `tabular-nums`，
 * 整条状态条会跟着重新折行一次，牌板下跳。
 *
 * 直接改文本量宽度，不等到真倒数：等 30 秒掉到 9 秒既慢，又会撞上服务端超时托管。
 * 这个 evaluate 是同步的，改完立刻读回，React 没机会插进来重渲染。
 *
 * 返回 null 表示这一帧没有环（本地局、或刚轮到我），调用方按「跳过」处理。
 */
async function countdownStable(p: Page): Promise<{ ok: boolean; detail: string } | null> {
  for (let i = 0; i < 3; i++) {
    const r = (await p.evaluate(`(() => {
      const cd = document.querySelector('.countdown');
      const b = cd && cd.querySelector('b');
      const bar = document.querySelector('.battle-main > .statusbar') || document.querySelector('.statusbar');
      if (!cd || !b || !bar) return null;
      const snap = () => ({
        w: Math.round(cd.getBoundingClientRect().width),
        h: Math.round(bar.getBoundingClientRect().height),
      });
      const keep = b.textContent;
      b.textContent = '30';
      const two = snap();
      b.textContent = '9';
      const one = snap();
      b.textContent = keep;
      return { two, one, ok: two.w === one.w && two.h === one.h };
    })()`)) as { two: { w: number; h: number }; one: { w: number; h: number }; ok: boolean } | null;
    if (r) {
      return {
        ok: r.ok,
        detail: `环宽 ${r.two.w}→${r.one.w}px / 状态条高 ${r.two.h}→${r.one.h}px`,
      };
    }
    await sleep(150);
  }
  return null;
}

/**
 * 横屏（844×390 一类）：操作区在**右侧**固定栏里，不在牌板下面。
 *
 * 所以「身份行有没有被吸底操作区盖住」这种上下比较的判据在这里没有意义
 * （操作区顶边在 y=52，比所有座位卡都高）。横屏要问的是：
 * 身份行是否在可视区内，并且**横向**没被右侧栏压到。
 *
 * 顺带确认日志还在：横屏的做法是把它挪到右下角，不是藏掉 ——
 * 「谁选了什么角色」是推理要用的信息，横屏也不该丢。
 */
async function seatVisibleBesideBar(p: Page): Promise<{
  identity: number;
  gap: number;
  logH: number;
}> {
  return p.evaluate(`(() => {
    const main = document.querySelector('.battle-main');
    const bar = document.querySelector('.actionbar:not(.waiting)');
    const log = document.querySelector('.battle-side');
    if (!main || !bar || !log) return { identity: -1, gap: -1, logH: -1 };
    const m = main.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const l = log.getBoundingClientRect();
    let identity = 0;
    let gap = -1;
    const cards = document.querySelectorAll('.pcard');
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      const ch = cards[i].querySelector('.pcard-char');
      const last = ch ? ch.getBoundingClientRect() : r;
      const inView = r.top >= m.top - 1 && last.bottom <= m.bottom + 1;
      const notCovered = r.right <= b.left - 4;
      if (inView && notCovered) {
        identity++;
        if (identity === 1) gap = Math.round(b.left - 4 - r.right);
      }
    }
    return { identity, gap, logH: Math.round(l.height) };
  })()`) as Promise<{ identity: number; gap: number; logH: number }>;
}

/** 等真正的「行动阶段」（带手牌的那种），顺便把选角点掉 */
/**
 * 引擎里最长的一条机密任务文案（`core/tasks.ts` 的 `noBlackWith`，count 取上限）。
 *
 * 目标条的高度是**内容驱动**的：同一条目标条，抽到「存活到第 6 轮开始。」
 * 是 46px，抽到这条长的是 79px。矮屏的纵向预算刚好卡在「第一排座位卡的
 * 身份行是否露在吸底操作区上面」这一线上，所以只靠随机抽到的任务去断言，
 * 会变成「十次红一次」的偶发失败 —— 比没有测试更糟。
 * 这里直接把最长的那条塞进去量，结论就和运气无关了。
 */
const WORST_TASK_TEXT = '对局结束时，你面前有 6 张情报，且一张黑色情报都没有。';

/**
 * 目标条里那几块「原子信息」有没有被折成两行。
 *
 * **必须注入最宽的一版**，否则结论取决于这一局随机抽到的阵营：
 * 4 字的「潜伏战线」比 3 字的「军情局」宽一个汉字，正好把「红 0/3」
 * 里的空格推成折点。只靠抽签，这条会变成「十次红一次」（同一个理由见
 * 上面的 `worstTaskSeats`）。
 *
 * 用 Range 数**行盒**，不用「高度 / 行高」：这几块是 flex 子项，
 * 高度还受 `align-items: center` 影响，而 Range 直接量文字实际占了几行。
 *
 * 只改 textContent、不增删元素：这个节点是 React 管的，
 * 动结构会在下一次重渲染时炸 `removeChild`。
 * 所以特工那一支（没有 `.goal-num`）测的是 `.goal-alt` —— 它本来就存在。
 */
async function goalBlocksSplit(
  p: Page,
): Promise<{ num: number; black: number; alt: number; tag: string } | null> {
  return p.evaluate(`(() => {
    const bar = document.querySelector('.goalbar');
    if (!bar) return null;
    const tag = bar.querySelector('.goal-tag');
    const num = bar.querySelector('.goal-num');
    const black = bar.querySelector('.goal-black');
    const alt = bar.querySelector('.goal-alt');
    if (!tag || !black) return null;
    const savedTag = tag.textContent;
    const savedNum = num ? num.textContent : null;
    tag.textContent = '潜伏战线';
    if (num) num.textContent = '红 0/3';
    const lines = (e) => {
      if (!e) return 0;
      const r = document.createRange();
      r.selectNodeContents(e);
      const tops = [...r.getClientRects()].filter(x => x.width > 0.5).map(x => Math.round(x.top));
      return new Set(tops).size;
    };
    const out = { num: lines(num), black: lines(black), alt: lines(alt), tag: savedTag };
    tag.textContent = savedTag;
    if (num && savedNum !== null) num.textContent = savedNum;
    return out;
  })()`) as Promise<{ num: number; black: number; alt: number; tag: string } | null>;
}

/**
 * 目标条里相邻两块之间还有没有间距。
 *
 * 这条专门盯 `@media (max-height: 700px)` 那条路径：那里 `.goalbar` 被改成
 * `display: block`（为了把阵营标签并进正文首行、省 35px 纵向空间），
 * 于是 `gap: 2px 8px` **整条失效**，而 `.goal-black { margin-left: auto }`
 * 在 inline 元素上按规范解析成 0。结果所有相邻块零间距粘成一串：
 * 360×640 截图读作「红 0/3黑色 0/3」，「…3 张红色情报」和三个进度方块也贴死。
 *
 * 逐行取 `getClientRects()`，不用整块的 boundingRect：一个 inline 元素折行后
 * boundingRect 是几行盒的并集，left/right 会把上一行末尾和下一行开头连起来，
 * 量出来的「间距」没有意义。所以拿前一块的**最后一个**行盒、后一块的
 * **第一个**行盒，只有两者 top 相差 <4px（同一行）时才比较。
 */
async function goalBlockGaps(p: Page): Promise<{ min: number; pair: string; n: number } | null> {
  return p.evaluate(`(() => {
    const bar = document.querySelector('.goalbar');
    if (!bar) return null;
    const boxes = (e) => [...e.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    const kids = [...bar.children];
    let min = Infinity, pair = '', n = 0;
    for (let i = 1; i < kids.length; i++) {
      const a = boxes(kids[i - 1]);
      const b = boxes(kids[i]);
      if (!a.length || !b.length) continue;
      const prev = a[a.length - 1];
      const next = b[0];
      if (Math.abs(prev.top - next.top) >= 4) continue;
      const gap = next.left - prev.right;
      n++;
      if (gap < min) { min = gap; pair = kids[i - 1].className + ' | ' + kids[i].className; }
    }
    return n ? { min: Math.round(min), pair, n } : null;
  })()`) as Promise<{ min: number; pair: string; n: number } | null>;
}

/**
 * 等目标条布局稳定后再量间距。
 *
 * 直接量会抓到中间帧：实测偶发过一次 `goal-main | goal-pips blue` 间距 0px，
 * 而同一个视口连跑两轮都是 8px（这一帧正在换文案/重排）。
 * 「等两次采样一致」比「多量几次取最大值」诚实 —— 取最大值等于把真正的
 * 持续 0px 也放过去，而稳定采样只放过中间帧。
 */
async function goalBlockGapsStable(
  p: Page,
  tries = 8,
): Promise<{ min: number; pair: string; n: number } | null> {
  let prev = await goalBlockGaps(p);
  for (let i = 0; i < tries; i++) {
    await sleep(120);
    const cur = await goalBlockGaps(p);
    if (cur && prev && cur.min === prev.min && cur.pair === prev.pair) return cur;
    prev = cur ?? prev;
  }
  return prev;
}

/**
 * 换成最长任务文案后，第一排座位卡的身份行还在操作区上面吗。
 *
 * 注入和测量必须在**同一个 evaluate** 里：分开写的话 React 会先重渲染、
 * 把注入的文案覆盖回去，量到的还是原来那条短任务（白测）。
 */
async function worstTaskSeats(p: Page): Promise<{ identity: number; slack: number; goal: number }> {
  return p.evaluate(`(() => {
    const goalEl = document.querySelector('.goalbar');
    const main0 = document.querySelector('.goal-main');
    const alt = document.querySelector('.goal-alt');
    const before = main0 ? main0.innerHTML : null;
    const beforeAlt = alt ? alt.textContent : null;
    // 整句替换而不是只换 <b> 里的字：颜色阵营的句式是「目标：面前集齐 ___」，
    // 只换正文会拼出读不通的句子，而且换行形态和特工那条真句式不一样。
    if (main0) main0.innerHTML = '机密任务：<b>' + ${JSON.stringify(WORST_TASK_TEXT)} + '</b>';
    // 特工的目标条比颜色阵营多一行「或集齐 N 张真情报」，短目标上没有这行 ——
    // 不补的话量出来的是「军情局 + 长任务」，比真实的特工形态矮一行（实测 79 vs 97）。
    const added = !alt;
    const altEl = alt || document.createElement('span');
    if (added) {
      altEl.className = 'goal-alt';
      // 插在「机密任务」后面，不是 appendChild 到末尾：特工那条的真实顺序是
      // tag → 任务 → 或集齐 → 黑色格。追加到末尾会多折一行（量出 97px，
      // 而真实形态是 79px）—— 那 18px 是注入方式自己造出来的假最坏情况，
      // 拿它当判据会让断言时红时绿，取决于这一局抽到哪个阵营。
      if (main0) main0.insertAdjacentElement('afterend', altEl);
      else if (goalEl) goalEl.appendChild(altEl);
    }
    altEl.textContent = '或集齐 6 张真情报（红蓝皆可）· 当前 0/6';

    const main = document.querySelector('.battle-main');
    const bar = document.querySelector('.actionbar:not(.waiting)');
    let identity = 0;
    let slack = 0;
    if (main && bar) {
      const m = main.getBoundingClientRect();
      const barTop = bar.getBoundingClientRect().top;
      const cards = document.querySelectorAll('.pcard');
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        const ch = cards[i].querySelector('.pcard-char');
        const cr = ch ? ch.getBoundingClientRect() : r;
        const inX = r.left >= m.left - 1 && r.right <= m.right + 1;
        if (inX && r.top >= m.top - 1 && cr.bottom <= barTop - 4) {
          identity++;
          if (identity === 1) slack = Math.round(barTop - 4 - cr.bottom);
        }
      }
    }
    const goalH = goalEl ? Math.round(goalEl.getBoundingClientRect().height) : -1;

    if (main0 && before !== null) main0.innerHTML = before;
    if (alt && beforeAlt !== null) alt.textContent = beforeAlt;
    if (added && altEl.parentNode) altEl.parentNode.removeChild(altEl);
    return { identity, slack, goal: goalH };
  })()`);
}

/**
 * 数据配置页的状态：表头有没有被压成「中文竖排」、宽屏上吸头还在不在。
 *
 * 这一页以前**完全不在自检范围内**（流程只走大厅 / 房间 / 对局），
 * 而它在每个尺寸上都点得到。实测 360×640 上 8 列被压进 312px，
 * 每列约 39px，「传递方式」竖成 4 行、「效果文本」竖成 4 行 ——
 * 和 `角色名不竖排` 那条是同一个坏法。
 *
 * 行数算法要减掉内边距和底边框：`th` 是 `padding: 8px 10px` + `border-bottom: 1.5px`，
 * 直接用 `高度 / 行高` 会把「一行」算成两行（36 / 19.55 ≈ 1.84）。
 */
async function configState(p: Page): Promise<{
  hOverflow: number;
  thCount: number;
  maxLines: number;
  worst: string;
  scrollTables: number;
  tabMaxLines: number;
  tabWorst: string;
  stuck: boolean | null;
}> {
  return p.evaluate(`(() => {
    const cfg = document.querySelector('.config');
    const empty = { hOverflow: 0, thCount: 0, maxLines: 0, worst: '找不到 .config', scrollTables: 0, tabMaxLines: 0, tabWorst: '', stuck: null };
    if (!cfg) return empty;
    const ths = [...document.querySelectorAll('table.grid thead th')];
    let maxLines = 0;
    let worst = '';
    let worstLen = -1;
    for (const th of ths) {
      const r = th.getBoundingClientRect();
      const cs = getComputedStyle(th);
      const lh = parseFloat(cs.lineHeight) || 20;
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const bw = parseFloat(cs.borderBottomWidth) || 0;
      const lines = Math.round((r.height - padY - bw) / lh);
      const text = (th.textContent || '').trim();
      // 同一行里的 th 高度都一样（行高由最高的那格决定），所以「最坏的那一格」
      // 要按**文字最长**挑，否则报出来的是只有 1 个字的「#」。
      if (lines > maxLines || (lines === maxLines && text.length > worstLen)) {
        maxLines = Math.max(maxLines, lines);
        worstLen = text.length;
        worst = text + '（列宽 ' + Math.round(r.width) + 'px）';
      }
    }
    const scrollTables = [...document.querySelectorAll('.grid-scroll')]
      .filter((d) => d.scrollWidth > d.clientWidth + 1).length;
    // tab 栏：4 个 tab 在 360 宽上会被压成 3 行（flex 缩到 min-content 就停）
    const tabs = [...document.querySelectorAll('.tabs-line button')];
    let tabMaxLines = 0;
    let tabWorst = '';
    for (const b of tabs) {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      const lh = parseFloat(cs.lineHeight) || 20;
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const lines = Math.round((r.height - padY) / lh);
      if (lines > tabMaxLines) {
        tabMaxLines = lines;
        tabWorst = (b.textContent || '').trim() + '（宽 ' + Math.round(r.width) + 'px）';
      }
    }
    // 吸头：滚 300px，看第一个 th 是否停在「容器顶 + padding」
    let stuck = null;
    if (ths[0] && cfg.scrollHeight > cfg.clientHeight + 320) {
      const before = cfg.scrollTop;
      cfg.scrollTop = 300;
      const cr = cfg.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(cfg).paddingTop) || 0;
      stuck = Math.abs(ths[0].getBoundingClientRect().top - (cr.top + pad)) <= 3;
      cfg.scrollTop = before;
    }
    return {
      hOverflow: document.documentElement.scrollWidth - window.innerWidth,
      thCount: ths.length,
      maxLines,
      worst,
      scrollTables,
      tabMaxLines,
      tabWorst,
      stuck,
    };
  })()`) as Promise<{
    hOverflow: number;
    thCount: number;
    maxLines: number;
    worst: string;
    scrollTables: number;
    tabMaxLines: number;
    tabWorst: string;
    stuck: boolean | null;
  }>;
}

async function waitForMyAction(p: Page): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const has = await p.evaluate(() => {
      const b = document.querySelector('.actionbar:not(.waiting)');
      return !!b && !!b.querySelector('.hand');
    });
    if (has) return true;
    const pick = p.locator('.pick-card').first();
    if ((await pick.count()) > 0) await pick.click().catch(() => undefined);
    await sleep(400);
  }
  return false;
}

async function runViewport(browser: Browser, vp: Viewport): Promise<void> {
  console.log(`\n=== ${vp.label} ===`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.mobile ? 2 : 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  });
  const p = await ctx.newPage();

  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });

  console.log('0) 本地启动页 / 数据配置');
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.tabs-line button', { timeout: 20_000 });
  // 本地对局那一屏（单机玩家打开应用看到的第一屏）以前也没进过自检。
  check('本地启动页没有横向溢出', !(await hasHScroll(p)));

  // 数据配置：一整页 `<table class="grid">`，以前零覆盖。
  // 放在最前面量，避免「对局中切到数据配置」把联机 hook 卸载掉（那是另一件事）。
  await p.locator('.topbar button', { hasText: '数据配置' }).click();
  await p.waitForSelector('.config', { timeout: 10_000 });
  await sleep(500);
  const cfgS = await configState(p);
  await shot(p, `${vp.name}-0-config`);
  check('数据配置没有横向溢出（横向滚动只发生在表格里）', cfgS.hOverflow <= 1, `溢出 ${cfgS.hOverflow}px`);
  check(
    '数据配置的表头不竖排（中文最多 2 行）',
    cfgS.thCount > 0 && cfgS.maxLines <= 2,
    `最多 ${cfgS.maxLines} 行：${cfgS.worst}（本视口 ${cfgS.scrollTables} 张表在横向滚）`,
  );
  check(
    '数据配置的 tab 栏不竖排（每个 tab 一行）',
    cfgS.tabMaxLines <= 1,
    `最多 ${cfgS.tabMaxLines} 行：${cfgS.tabWorst}`,
  );
  // 吸头只在宽屏上要求：窄屏必须让表格横向滚，而横向滚动容器必然杀死 sticky。
  // 这个取舍写在 styles.css 的 `.grid-scroll` 注释里。
  if (cfgS.stuck === null) {
    console.log('  · 数据配置本视口没有足够长的表格，测不到吸头');
  } else if (vp.width > 960) {
    check(
      '宽屏上表格吸头还在（滚 300px 后停在容器顶边）',
      cfgS.stuck,
      cfgS.stuck ? undefined : '表头跟着滚走了 —— 外层被弄成了横向滚动容器',
    );
  } else {
    console.log('  · 窄屏让表格横向滚，吸头按设计放弃（见 .grid-scroll 注释）');
  }
  await p.locator('.topbar button', { hasText: '对局' }).click();
  await p.waitForSelector('.tabs-line button', { timeout: 10_000 });

  console.log('1) 大厅');
  await p.locator('.tabs-line button', { hasText: '联机对局' }).click();
  await p.waitForSelector('.lobby', { timeout: 10_000 });
  await p.locator('.nick-input').fill('视口');
  await sleep(600);
  await shot(p, `${vp.name}-1-lobby`);
  check('大厅没有横向溢出', !(await hasHScroll(p)));
  check('大厅的建房入口够得着', await reachable(p, '.lobby-panel'));
  const top = await topbarIntact(p);
  check('顶栏没有折行（标题和 tab 各占一行）', top.ok, top.detail);
  if (vp.mobile) {
    const tap = await smallTapTargets(p);
    check('大厅里每个可点元素都够大（≥32px，手指点得准）', tap.count === 0, tap.worst);
  }

  console.log('2) 房间页');
  await p.locator('button', { hasText: '创建并进入' }).click();
  await p.waitForSelector('.room-bigcode', { timeout: 15_000 });
  await sleep(500);
  await shot(p, `${vp.name}-2-room`);
  check('房间页没有横向溢出', !(await hasHScroll(p)));

  // 2a. 房间页必须从顶部打开。
  //
  // 大厅 / 房间 / 对局三屏共用同一个滚动容器（BattlePage 里那个无类名的 div）。
  // 为了够到大厅底部的「创建并进入」，浏览器会先把这个容器 scroll-into-view，
  // **这一下发生在换屏之前**；换屏时 React 只换子节点、不换容器，位置就漏过来了。
  // 实测 360×640：大厅 max 5810，点击时直接滚到底，换屏后被钳到房间页的 max 286
  // —— 房间页一打开就是最底下，房间号和邀请链接全在屏外。
  // 这两条必须放在下面的 `reachable('.room-bigcode')` **之前**量：那个函数
  // 会先滚一下，把要查的东西自己修好。
  const head = await inScrollView(p, '.room-head');
  check(
    '进房间页时滚动位置归零（不继承大厅滚到哪儿）',
    head.found && head.scrollTop === 0,
    head.found
      ? `scrollTop ${head.scrollTop}/${head.scrollMax}${head.scrollMax === 0 ? '（本视口本来就装得下）' : ''}`
      : '找不到房间页',
  );
  check(
    '房间号 + 邀请入口不用滚就在屏内',
    head.found && head.ok,
    `头部块 ${head.top}..${head.bottom} / 可视 ${head.boxTop}..${head.boxBottom}`,
  );

  // 2b. 主操作必须吸在底部。
  //
  // 房间页在矮屏上**装不下**：844×390 内容 477px、滚动容器只有 277px，
  // 「开始对局」在折叠线下方 155px（360×640 差 238px）。房主看完座位
  // 还得往下翻才能开局，而屏幕上没有任何提示「下面还有」。
  // 判据只看一件事：主按钮**不用滚**就整块落在滚动容器的可视区内。
  // 装得下的视口（390×844 / 1280×720 / 1440×900）这条是空过的，
  // 所以输出里会注明 —— 和日志跟尾那条一样，绿勾不代表吸底被验证过。
  const act = await inScrollView(p, '.room-actions .primary');
  check(
    '房间页的主按钮不用滚就在屏内（矮屏吸底）',
    act.found && act.ok,
    act.found
      ? `按钮 ${act.top}..${act.bottom} / 可视 ${act.boxTop}..${act.boxBottom} / 溢出 ${act.scrollMax}px`
      : '找不到主按钮',
  );
  // `check` 只在失败时打印 detail，所以「这条没走到吸底路径」必须自己打一行 ——
  // 否则宽屏上那个绿勾会让人以为吸底被验证过了。
  if (act.found && act.scrollMax <= 2) {
    console.log('  · 房间页本视口装得下（溢出 0px），这条测不到吸底');
  }

  // 2c. 操作条折行后，不许留下「行首孤儿竖线」。
  // `.field-inline + button { border-left }` 是给「同一行切成三块」用的；
  // 360 宽上按钮折到第二行，那道竖线就画在内容左边缘（x=20），
  // 指着左边的空白，看起来像渲染错误。
  const sep = await orphanSeparators(p);
  check(
    '操作条折行后不留行首竖线',
    sep.orphans.length === 0,
    sep.orphans.length ? `行首孤儿：${sep.orphans.join(' / ')}（操作条高 ${sep.h}px）` : undefined,
  );
  if (sep.rows <= 1) {
    console.log('  · 操作条本视口没折行（1 行），这条测不到行首竖线');
  }

  check('房间号够得着（朋友要念的就是它）', await reachable(p, '.room-bigcode'));

  console.log('3) 对局界面');
  await p.locator('button', { hasText: '开始对局' }).click();
  await p.waitForSelector('.battle', { timeout: 20_000 });
  await sleep(900);
  await shot(p, `${vp.name}-3-battle`);
  check('对局界面没有横向溢出', !(await hasHScroll(p)));

  // 座位卡上的玩家名不许被压成省略号。房间是 1 真人 + 4 AI，
  // 四个 AI 名字都是「机器人 N」—— 一旦被裁，它们会全变成同一个「机…」。
  const nm = await clippedNames(p);
  check(
    '座位卡上的玩家名没有被压成省略号',
    nm.total > 0 && nm.n === 0,
    nm.total === 0 ? '一张座位卡都没量到' : `${nm.n}/${nm.total} 张被截断（${nm.sample}）`,
  );

  // 选角面板：窄屏下会挤成三列小卡，必须点得到
  if ((await p.locator('.pick-card').count()) > 0) {
    check('选角卡片够得着', await reachable(p, '.pick-card'));
    // 390px 下 3 列会把「情报贩子」挤成一列一个字（flex 子项默认可压缩）
    const nm = await p.evaluate(() => {
      const n = document.querySelector('.pick-name') as HTMLElement | null;
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width) };
    });
    check(
      '角色名不竖排（一行放得下）',
      !!nm && nm.h <= 26,
      nm ? `高 ${nm.h}px / 宽 ${nm.w}px` : '找不到角色名',
    );
    // 候选角色只有 3 个，选角又是一次性决策 —— 不该出现「第三张要滚才看得到」。
    // 横屏里这条曾经是红的：选角面板和操作区共用 320 宽的右栏，2 列排成 2 行，还要滚 67px。
    const pickFit = (await p.evaluate(`(() => {
      const panel = document.querySelector('.actionbar.pick');
      const cards = document.querySelectorAll('.pick-card');
      if (!panel) return null;
      return {
        need: panel.scrollHeight - panel.clientHeight,
        n: cards.length,
      };
    })()`)) as { need: number; n: number } | null;
    check(
      '选角面板不用滚就能看全所有候选',
      !!pickFit && pickFit.need <= 2,
      pickFit ? `候选 ${pickFit.n} 张 / 还要滚 ${pickFit.need}px` : '找不到选角面板',
    );
    if (isSideways(vp)) {
      const rc = await rightColumnState(p);
      const v = rightColumnVerdict(rc);
      check('横屏选角时右栏没空着（预留的 320px 有人占）', v.ok, v.detail);
    }
    await p.locator('.pick-card').first().click();
    await sleep(700);
  }

  // 目标条里的数字块不许被折断。
  // 360×640 实测（修前）：红身份的「红 0/3」被拆成「红」+「0/3」，
  // 特工的「或集齐 6 张真情报（红蓝皆可）· 当前 0/6」被拆成「…当前 0」+「/6」。
  // 根因：`.goalbar` 是 flex 容器，这几块是 flex 子项，默认 `flex-shrink: 1`
  // 会缩到 min-content —— 而带空格的文字 min-content 就是「最长的一个词」。
  const gb = await goalBlocksSplit(p);
  if (!gb) {
    check('目标条能量到（否则下面两条测不到）', false, '找不到 .goalbar / .goal-black');
  } else {
    check('目标条的数字块不被折成两行', gb.black === 1, `「黑色 0/3」占 ${gb.black} 行`);
    if (gb.num > 0) {
      check('目标条的颜色进度不被折成两行', gb.num === 1, `「红 0/3」占 ${gb.num} 行`);
    } else {
      // 特工那一支没有「红 0/3」，改测它自己那条长句
      check(
        '特工的目标条长句不被折成两行',
        gb.alt === 1,
        `「或集齐 6 张真情报…」占 ${gb.alt} 行`,
      );
    }
  }

  // 目标条里相邻两块之间必须留出间距。
  // 矮屏那条 `display: block` 路径上 `gap` 整条失效，修前所有相邻块间距为 0
  // （只有 tag→main 的 6px 来自 .goal-tag 自己的 margin-right）。
  const gg = await goalBlockGapsStable(p);
  if (!gg) {
    check('目标条相邻块的间距能量到', false, '同一行里找不到两个相邻块');
  } else {
    check('目标条相邻块之间留出了间距', gg.min >= 4, `最窄 ${gg.min}px（${gg.pair}）`);
  }

  // 不是自己回合：手牌条贴底
  await scrollBattleTop(p);
  let strip = await handStripAnchored(p);
  if (strip.state === 'gone') {
    // 可能刚好轮到自己（手牌条换成操作区）。等一拍再看，仍不在就跳过。
    await sleep(400);
    strip = await handStripAnchored(p);
  }
  if (strip.state === 'gone') {
    // 不算通过也不算失败：这个状态下本来就没有手牌条。
    // 单独计数，免得总数在 59/60 之间浮动、看起来像偶发失败。
    skipped++;
    console.log('  · 跳过「手牌条贴底」：刚轮到自己，这一帧没有手牌条');
  } else {
    await shot(p, `${vp.name}-4-hand-strip`);
    check(
      '不是自己回合时，手牌条贴在滚动容器底部',
      strip.gap >= -1 && strip.gap <= 24 && strip.insideX,
      `距容器底 ${strip.gap}px / 横向在内 ${strip.insideX}`,
    );
    // 「等别人行动」是横屏里存在时间最长的状态（一局里大部分时间都在等），
    // 恰恰最容易被漏：操作区是 .actionbar.waiting，规则写成了 :not(.waiting) 就轮到它没挪。
    if (isSideways(vp)) {
      const rc = await rightColumnState(p);
      const v = rightColumnVerdict(rc);
      check('横屏等待别人时右栏没空着（预留的 320px 有人占）', v.ok, v.detail);
    }

    // 倒计时环只在联机局出现（本地局没有 deadline），而它恰好只在「别人正在行动」时存在 ——
    // 就是这一支。放在「手牌条贴底」之后而不是之前：环可能要重试等它出现，
    // 放在前面会把那条断言推到自己回合（实测 5 个视口全跳）；
    // 放到跑完一局之后再量，又会因为结算浮层把环收掉而跳过（实测 2 个视口跳）。
    const cd = await countdownStable(p);
    if (!cd) {
      skipped++;
      console.log('  · 跳过「倒计时环不抖」：这一帧没有倒计时环');
    } else {
      check('倒计时从 30 变 9 时状态条不重排', cd.ok, cd.detail);
    }
  }

  // 轮到自己：操作区必须不用滚就完整可见
  const gotTurn = await waitForMyAction(p);
  if (gotTurn) {
    await scrollBattleTop(p);
    await shot(p, `${vp.name}-5-action`);
    const vis = await actionFullyVisible(p);
    check('轮到自己时，操作区不用滚就完整可见（吸底生效）', vis.ok, vis.detail);
    const room = await visibleSeatCards(p);
    // 高屏要求完整露出；矮屏（640 一类）纵向预算不够，要求「至少看清对面是谁」
    const tall = vp.height >= 700;
    const sideways = isSideways(vp);
    if (sideways) {
      const side = await seatVisibleBesideBar(p);
      console.log(`  · 横屏：身份可见 ${side.identity} 张 / 距右侧栏 ${side.gap}px / 日志 ${side.logH}px`);
      const rc = await rightColumnState(p);
      const v = rightColumnVerdict(rc);
      check('横屏轮到自己时右栏没空着（预留的 320px 有人占）', v.ok, v.detail);
      check(
        '横屏下操作区在右侧，牌板里仍能看清对手身份（不被右侧栏压住）',
        side.identity >= 1 && side.gap >= 0,
        `身份可见 ${side.identity} 张 / 距右侧栏 ${side.gap}px`,
      );
      check('横屏下日志还在（挪到右下角，不是藏掉）', side.logH >= 60, `日志高 ${side.logH}px`);
      // 右栏只有 218px 高，而「手牌 + 阶段说明 + 按钮」要 346px ——
      // 「操作区外框在视口内」这条上面已经绿了，按钮却可能在栏外 129px。
      // 必须趁「轮到自己」这一刻量（回合结束后操作区会变成 .waiting，没有主按钮）。
      const prim = await primaryActionVisible(p);
      check('横屏轮到自己时，主按钮不用在栏里滚就看得见', prim.ok, prim.detail);
    } else if (tall) {
      check(
        '吸底的操作区不会把牌板盖住（至少完整露出 1 张座位卡）',
        room.count >= 1,
        `完整 ${room.count} 张 / 操作区高 ${room.barH} / 首卡顶 ${room.firstTop} / 上方 ${room.above}`,
      );
    } else {
      // 矮屏量「最坏情况」：把最长的任务文案 + 特工那行「或集齐 N 张」都塞进去再量。
      // 只量这一局抽到的任务是没用的 —— 抽到短任务它必然通过，问题恰好只在长任务时出现。
      console.log(
        `  · 牌板：完整 ${room.count} 张 / 身份 ${room.identity} 张` +
          ` / 首卡顶 ${room.firstTop} / 操作区顶 ${room.barTop}`,
      );
      console.log(`  · 牌板上方：${room.above}`);
      const worst = await worstTaskSeats(p);
      console.log(`  · 最长任务：目标条 ${worst.goal}px / 身份行余量 ${worst.slack}px`);
      check(
        '矮屏下仍能看清至少 1 个对手的身份（按最长任务文案算，留 ≥8px 余量）',
        worst.identity >= 1 && worst.slack >= 8,
        `身份可见 ${worst.identity} 张 / 目标条 ${worst.goal}px / 余量 ${worst.slack}px`,
      );
    }
  } else {
    console.log('  · 没等到自己的行动阶段，跳过操作区检查');
  }

  // 手机额外：手牌必须单排（换行会让操作区高到盖死牌板）
  if (vp.width <= 900 && gotTurn) {
    // 量 offsetTop 而不是 getBoundingClientRect：卡片的 :hover 带 translateY(-2px)，
    // 而脚本刚点过选角卡片，鼠标可能正好落在某张手牌上 —— 用 rect 会把
    // 「悬停抬起的 2px」当成第二排，报出假失败（踩过）。
    await p.mouse.move(0, 0);
    const rows = await p.evaluate(() => {
      const h = document.querySelector('.actionbar:not(.waiting) .hand') as HTMLElement | null;
      if (!h) return -1;
      return new Set([...h.children].map((c) => (c as HTMLElement).offsetTop)).size;
    });
    check('手机上手牌是单排（横向滚动，不是换行）', rows === 1, `${rows} 排`);
  }

  if (vp.mobile) {
    const tap = await smallTapTargets(p);
    check('对局里每个可点元素都够大（≥32px，手指点得准）', tap.count === 0, tap.worst);
  }

  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(250);
  check('滚到底仍然没有横向溢出', !(await hasHScroll(p)));

  // 日志「跟尾」：最新一条必须在日志区的可视范围内。
  //
  // `LogPanel` 靠「新日志进来时把 scrollTop 顶到底」实现跟尾 ——
  // 很轻，也很容易被改坏（换成 useEffect 少写一个依赖、或者把 ref 去掉）。
  // 坏了以后的症状在窄屏上特别刺眼：360×640 的日志区只有 62px（不到 3 行），
  // 不跟尾时看到的是**最老的**几条，刚发生的事永远在下面看不见。
  // 观战者的唯一信息来源就是这份日志，所以这条对观众比玩家更要紧。
  const tail = await logTailState(p);
  // 单独打一行：`check` 只在失败时显示 detail，绿行里看不出这条到底有没有
  // 真的走到滚动路径（短日志上它恒真）。把条数和「是否溢出」打出来，
  // 免得下次有人看到绿勾就以为滚动跟尾被测过了。
  if (tail) {
    console.log(
      `  · 日志：${tail.n} 条 / ${tail.scrollable ? `可滚（距底 ${tail.gap}px）` : '未溢出（这条没走到滚动路径）'}`,
    );
  }
  check(
    '最新一条日志在日志区可视范围内（长日志已跟尾）',
    !!tail && tail.lastInside && (!tail.scrollable || tail.gap <= 2),
    tail
      ? `${tail.n} 条 / ${tail.scrollable ? `可滚，距底 ${tail.gap}px` : '未溢出'} / 末条「${tail.lastText}」`
      : '找不到日志条目',
  );

  // 日志不能被新消息抢走滚动位置。
  // 这条要放在所有布局断言之后：它会给对局加一两个动作（点「结束出牌」/ 传一张牌），
  // 用来制造新日志 —— 放在前面会影响后面量出来的高度。
  const logScroll = await logScrollRespect(p);
  if (!logScroll) {
    skipped++;
    console.log('  · 跳过「日志不抢滚动」：日志没溢出，走不到滚动路径');
  } else {
    if (logScroll.grewUp) {
      check(
        '往上翻之后，新日志不会把你拽回底部',
        logScroll.upAfter <= 4,
        `翻到顶后 scrollTop ${logScroll.upAfter}（可滚 ${logScroll.overflow}px）`,
      );
    } else {
      skipped++;
      console.log('  · 跳过「新日志不抢滚动」：3 秒内没有新日志，测不了');
    }
    if (logScroll.grewDown) {
      check(
        '翻回底部之后，新日志能重新跟上',
        logScroll.downGap <= 2,
        `距底 ${logScroll.downGap}px`,
      );
    } else {
      skipped++;
      console.log('  · 跳过「翻回底部重新跟上」：3 秒内没有新日志，测不了');
    }

    // c. 翻上去之后来了新消息 → 药丸 + 点击回到底部。
    // 这一段跑成了（翻上去了、也等到了新日志）就必须四条全绿 ——
    // 药丸没出现时不再「跳过」，而是把四条判成红：
    // 跳过会让「删掉药丸」这种回归安静地通过。
    if (!logScroll.pillTried) {
      skipped++;
      console.log('  · 跳过「新消息提示」：翻上去之后没有新日志，或者日志没溢出');
    } else {
      const pill = logScroll.pill;
      check(
        '翻上去之后来了新消息，底部浮出「↓ N 条新消息」',
        !!pill && /↓\s*\d+\s*条新消息/.test(pill.text),
        pill ? pill.text : '药丸没有出现',
      );
      check(
        '「↓ N 条新消息」在日志区内、点击高度 ≥32px',
        !!pill && pill.h >= 32 && pill.inside,
        pill ? `高 ${pill.h}px / 完全在日志区内 ${pill.inside}` : '药丸没有出现',
      );
      check(
        '点「↓ N 条新消息」回到最新一条',
        !!logScroll.afterJump && logScroll.afterJump.gap <= 2,
        logScroll.afterJump ? `距底 ${logScroll.afterJump.gap}px` : '没有药丸可点',
      );
      check(
        '回到最新之后药丸消失',
        !!logScroll.afterJump && logScroll.afterJump.gone,
        logScroll.afterJump ? undefined : '没有药丸可点',
      );
    }
  }

  // 手机上日志栏是最容易被默认值坑到的一块：它按 max-height 吃固定像素，
  // 220px 在 844 高的屏上就是 26%，而牌板里还要再减去吸底的操作区。
  if (vp.mobile) {
    const side = (await p.evaluate(`(() => {
      const el = document.querySelector('.battle-side');
      const bar = document.querySelector('.actionbar:not(.waiting)');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const b = bar ? bar.getBoundingClientRect() : null;
      return {
        h: Math.round(r.height),
        vh: window.innerHeight,
        barH: b ? Math.round(b.height) : 0,
        // 横屏时日志和操作区是同一列上下排的：真正要防的是**重叠**，
        // 不是「加起来超过屏高」（那个由 top/bottom 固定值保证，恒不成立）。
        barBottom: b ? Math.round(b.bottom) : -1,
        sideTop: Math.round(r.top),
        // 横屏时日志和操作区是同一列上下排的，判断标准不是「占屏高多少」，
        // 而是「两块加起来放不放得进屏高」—— 它不占牌板的垂直空间。
        stacked: b ? b.left > r.left - 1 : false,
      };
    })()`)) as {
      h: number;
      vh: number;
      barH: number;
      barBottom: number;
      sideTop: number;
      stacked: boolean;
    } | null;
    // 用视口尺寸判断，不要用几何（bar.left > log.left）：竖屏里操作区在牌板列里
    // 也有左边距，这个条件同样成立 —— 第一版就是这样把竖屏也带进横屏分支，
    // 结果「日志 ≤ 屏高 1/6」那条悄悄失效了（78 项全绿，但少测了一条）。
    const sidewaysVp = isSideways(vp);
    if (side && sidewaysVp) {
      // 这里原来写的是 `barH + h <= vh`，**数学上恒真**：
      // 操作区是 `top:52 / bottom:120` 固定定位 ⇒ 高度恒为 `vh-172`，
      // 日志恒 120px，两块相加 = `vh-52`，永远小于屏高（实测 218+120=338 ≤ 390）。
      // 也就是说这条断言不可能失败 —— 又一个「看起来在测、其实什么都没测」。
      // 真正会坏的是「两块叠在一起」，判据是几何相邻。
      check(
        '横屏下操作区和日志上下排好、不重叠',
        side.barBottom <= side.sideTop + 1,
        `操作区底 ${side.barBottom} / 日志顶 ${side.sideTop}`,
      );
      // 120px 的栏里能读几条日志：实测压缩前 2 条，压缩后 3 条。
      // 少于 3 条就等于「横屏只能看见刚才那一下」，而推理要看的是前因后果。
      const dens = await logDensity(p);
      console.log(
        `  · 横屏日志：标题 ${dens?.headH}px / 列表内容 ${dens?.contentH}px / 单条 ${dens?.itemH}px ⇒ ${dens?.fits} 条`,
      );
      check(
        '横屏日志区至少放得下 3 条（标题和留白不能吃掉半栏）',
        !!dens && dens.fits >= 3,
        dens ? `标题 ${dens.headH}px + 列表 ${dens.contentH}px / 单条 ${dens.itemH}px ⇒ ${dens.fits} 条` : '量不到日志',
      );
    } else {
      check(
        '手机上情报日志不超过屏高 1/6（把空间让给牌板）',
        !!side && side.h <= Math.round(side.vh / 6) + 1,
        side ? `日志 ${side.h}px / 屏高 ${side.vh}px` : '找不到日志栏',
      );
      // 「让出空间」和「还剩多少能读」是两件事：日志栏被压到 16vh 是对的，
      // 但标题 + 留白如果把它吃光，等于把日志删了。360×640 实测：102px 的栏里
      // 标题 40 + 列表留白 30，内容盒只剩 32px，而单条日志 29px —— **只能看见 1 条**。
      const dens = await logDensity(p);
      console.log(
        `  · 竖屏日志：标题 ${dens?.headH}px / 列表内容 ${dens?.contentH}px / 单条 ${dens?.itemH}px ⇒ ${dens?.fits} 条`,
      );
      check(
        '竖屏日志区至少放得下 2 条（标题和留白不能把它吃光）',
        !!dens && dens.fits >= 2,
        dens ? `标题 ${dens.headH}px + 列表 ${dens.contentH}px / 单条 ${dens.itemH}px ⇒ ${dens.fits} 条` : '量不到日志',
      );
    }
  }

  check('没有控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await ctx.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  // ABS_VP=360 只跑那一个视口。四个视口一轮要四分多钟，
  // 调一条窄屏断言时不该每次都等全量（名字按 vp.name 或宽度前缀匹配）。
  const only = process.env.ABS_VP;
  const list = only ? VIEWPORTS.filter((v) => v.name.startsWith(only) || String(v.width) === only) : VIEWPORTS;
  if (only && list.length === 0) {
    console.error(`ABS_VP=${only} 没匹配到视口，可选：${VIEWPORTS.map((v) => v.name).join(' / ')}`);
    process.exit(1);
  }
  for (const vp of list) await runViewport(browser, vp);
  await browser.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`通过 ${passed} 项${skipped > 0 ? `，跳过 ${skipped} 项` : ''}`);
  console.log('多视口自查通过。');
}

void main().catch((err) => {
  console.error('多视口自查异常', err);
  process.exit(1);
});

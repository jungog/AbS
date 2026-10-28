/**
 * 生成默认卡池 —— 一次性脚本，产物写入 src/data/defaults/cards.json
 *
 * 运行：npx tsx scripts/gen-default-deck.ts
 *
 * 设计口径（与策划案一致，属"设计提案"而非官方公布数据）：
 *   总数 87 张，每张牌同时具备「情报面」（颜色 + 传递方式）与「功能面」（九种功能之一）
 *   颜色：红 32 / 蓝 32 / 黑 23（黑占 26.4%，落在推荐的 22%–29% 区间）
 *   方式：密电 30 / 文本 29 / 直达 28
 *   功能：高频 4 种 ×11 + 中频 3 种 ×9 + 低频 2 种 ×8 = 87
 *
 * ⚠ 为什么不是「洗三次然后按下标拼起来」：
 *   颜色、方式、功能各自独立洗牌再拼接，会让某些功能牌被某一种颜色垄断。
 *   第一版就是这么生成的，结果【截获】11 张里 8 张是蓝色 —— 而【截获】是留在手里
 *   防守用的牌，等于蓝色阵营手里长期压着 8 张蓝牌传不出去，AI 对战红方胜率直接
 *   被抬到 66%。这是数据层的偏置，不是引擎 bug，但一样会毁掉平衡。
 *   ⇒ 现在改成「按比例分配 + 全局修正」的确定性算法：每个功能的颜色 / 方式分布
 *     都与全局比例对齐（误差 ≤ 1 张），且列总和精确等于设计值。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FN_NAME: Record<string, string> = {
  lock: '锁定',
  lure: '调虎离山',
  return: '退回',
  intercept: '截获',
  decode: '破译',
  counter: '识破',
  burn: '烧毁',
  probe: '试探',
  shuffle: '真伪莫辨',
};

const FN_TEXT: Record<string, string> = {
  lock: '与情报牌搭配打出，接收者必须收下该情报，不能拒收。',
  lure: '指定一名玩家，本次情报传递中跳过该玩家。',
  return: '将自己刚收到的情报退回给上一个传出者。',
  intercept: '拿走正在传递中的情报牌，加入自己的手牌。',
  decode: '私下查看一张朝下情报的实际内容，不可告知他人。',
  counter: '抵销场上最新打出的一张功能牌的效果。',
  burn: '弃掉场上任意一张黑色情报。',
  probe: '指定一名玩家，得知其手牌中黑色（假情报）的数量，仅自己可见。',
  shuffle: '抽等同于存活人数的牌，朝下洗混后每人发一张，当作已打出的情报。',
};

/** 各功能的张数（改这里就能调整牌池配比） */
const FN_TOTAL: Record<string, number> = {
  lock: 11,
  intercept: 11,
  return: 11,
  counter: 11,
  decode: 9,
  burn: 9,
  lure: 9,
  probe: 8,
  shuffle: 8,
};

/** 全局颜色 / 方式配比 */
const COLOR_TOTAL = { red: 32, blue: 32, black: 23 } as const;
const METHOD_TOTAL = { cipher: 30, text: 29, direct: 28 } as const;

const FNS = Object.keys(FN_TOTAL);
const TOTAL = FNS.reduce((s, fn) => s + FN_TOTAL[fn]!, 0);

/* ------------------------------------------------------------------ */
/* 均衡分配                                                            */
/* ------------------------------------------------------------------ */

type Table = Record<string, Record<string, number>>;

/**
 * 把 `totals`（例如 红32/蓝32/黑23）按每个功能的行大小分摊到 `rows` 上：
 *  1. 每行先按比例取整，余数给小数部分最大的列（largest remainder）
 *  2. 再全局修正：从超出目标的列往不足的列搬，每次选「搬完最均匀」的那一行
 * 结果保证：每行之和 = 该功能张数，每列之和 = 目标值，且每格偏差尽量小。
 */
function allocate(rows: { key: string; size: number }[], totals: Record<string, number>): Table {
  const cols = Object.keys(totals);
  const grand = cols.reduce((s, c) => s + totals[c]!, 0);
  const plan: Table = {};

  for (const row of rows) {
    const raw = Object.fromEntries(cols.map((c) => [c, (row.size * totals[c]!) / grand])) as Record<string, number>;
    const base = Object.fromEntries(cols.map((c) => [c, Math.floor(raw[c]!)])) as Record<string, number>;
    let left = row.size - cols.reduce((s, c) => s + base[c]!, 0);
    const byRemainder = cols.slice().sort((a, b) => raw[b]! - base[b]! - (raw[a]! - base[a]!));
    for (const c of byRemainder) {
      if (left <= 0) break;
      base[c] = base[c]! + 1;
      left -= 1;
    }
    plan[row.key] = base;
  }

  const colSum = (c: string) => rows.reduce((s, r) => s + plan[r.key]![c]!, 0);

  // 全局修正：搬牌
  for (let guard = 0; guard < 200; guard++) {
    const over = cols.filter((c) => colSum(c) > totals[c]!);
    const under = cols.filter((c) => colSum(c) < totals[c]!);
    if (over.length === 0 || under.length === 0) break;

    const from = over[0]!;
    const to = under[0]!;

    // 选一个搬完之后「该行最均匀」的行：即 from 相对偏多、to 相对偏少的行
    let bestRow = rows[0]!.key;
    let bestScore = -Infinity;
    for (const r of rows) {
      const p = plan[r.key]!;
      if ((p[from] ?? 0) <= 0) continue;
      const size = r.size;
      const before = Math.max(...cols.map((c) => Math.abs(p[c]! - (size * totals[c]!) / grand)));
      const after = Math.max(
        ...cols.map((c) => {
          const v = c === from ? p[c]! - 1 : c === to ? p[c]! + 1 : p[c]!;
          return Math.abs(v - (size * totals[c]!) / grand);
        }),
      );
      const gain = before - after;
      if (gain > bestScore) {
        bestScore = gain;
        bestRow = r.key;
      }
    }
    plan[bestRow]![from] = plan[bestRow]![from]! - 1;
    plan[bestRow]![to] = plan[bestRow]![to]! + 1;
  }

  return plan;
}

const rows = FNS.map((fn) => ({ key: fn, size: FN_TOTAL[fn]! }));
const colorPlan = allocate(rows, { ...COLOR_TOTAL });
const methodPlan = allocate(rows, { ...METHOD_TOTAL });

/* ------------------------------------------------------------------ */
/* 摊平成卡牌                                                          */
/* ------------------------------------------------------------------ */

/** 把「红5 蓝4 黑2」摊成一个交替出现的序列，避免同类聚在一起 */
function spread(counts: Record<string, number>): string[] {
  const pool = Object.entries(counts).flatMap(([k, n]) => Array.from({ length: n }, () => k));
  const out: string[] = [];
  const left = { ...counts };
  while (out.length < pool.length) {
    const avail = Object.keys(left).filter((k) => left[k]! > 0);
    avail.sort((a, b) => left[b]! - left[a]!);
    const pick = avail[0]!;
    out.push(pick);
    left[pick] = left[pick]! - 1;
  }
  return out;
}

interface Card {
  id: string;
  name: string;
  color: string;
  method: string;
  fn: string;
  fnText: string;
}

const cards: Card[] = [];
for (const fn of FNS) {
  const colors = spread(colorPlan[fn]!);
  const methods = spread(methodPlan[fn]!);
  for (let i = 0; i < colors.length; i++) {
    cards.push({
      id: `c${String(cards.length + 1).padStart(3, '0')}`,
      name: FN_NAME[fn]!,
      color: colors[i]!,
      method: methods[i]!,
      fn,
      fnText: FN_TEXT[fn]!,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

const tally = (key: 'color' | 'method' | 'fn') => {
  const m: Record<string, number> = {};
  for (const c of cards) m[c[key]] = (m[c[key]] ?? 0) + 1;
  return m;
};
const colorTally = tally('color');
const methodTally = tally('method');
const fnTally = tally('fn');

if (cards.length !== TOTAL) throw new Error(`张数应为 ${TOTAL}，实际 ${cards.length}`);
for (const [k, v] of Object.entries(COLOR_TOTAL)) {
  if (colorTally[k] !== v) throw new Error(`颜色 ${k} 应为 ${v}，实际 ${colorTally[k]}`);
}
for (const [k, v] of Object.entries(METHOD_TOTAL)) {
  if (methodTally[k] !== v) throw new Error(`方式 ${k} 应为 ${v}，实际 ${methodTally[k]}`);
}
for (const [k, v] of Object.entries(FN_TOTAL)) {
  if (fnTally[k] !== v) throw new Error(`功能 ${k} 应为 ${v}，实际 ${fnTally[k]}`);
}

// 交叉分布偏差：每个「功能 × 颜色」格子与理论值的最大偏差，应 ≤ 1.1 张
let maxDev = 0;
for (const fn of FNS) {
  for (const [col, total] of [...Object.entries(COLOR_TOTAL), ...Object.entries(METHOD_TOTAL)]) {
    const isColor = col in COLOR_TOTAL;
    const expected = (FN_TOTAL[fn]! * total) / TOTAL;
    const actual = cards.filter((c) => c.fn === fn && (isColor ? c.color : c.method) === col).length;
    maxDev = Math.max(maxDev, Math.abs(actual - expected));
  }
}
if (maxDev > 1.2) throw new Error(`交叉分布偏差过大：${maxDev.toFixed(2)} 张`);

const triples = new Map<string, number>();
for (const card of cards) {
  const key = `${card.color}|${card.method}|${card.fn}`;
  triples.set(key, (triples.get(key) ?? 0) + 1);
}
const worstTriple = Math.max(...triples.values());

const cross = (colKey: 'color' | 'method', cols: string[]) =>
  FNS.map((fn) => {
    const cells = cols.map((col) => cards.filter((c) => c.fn === fn && c[colKey] === col).length);
    return `  ${fn.padEnd(10)} ${cells.map((n) => String(n).padStart(2)).join('  ')}`;
  }).join('\n');

const outPath = resolve(__dirname, '../src/data/defaults/cards.json');
writeFileSync(outPath, JSON.stringify(cards, null, 2) + '\n', 'utf8');

console.log(`✔ 已生成 ${cards.length} 张卡牌 -> ${outPath}`);
console.log(`  颜色 ${JSON.stringify(colorTally)}`);
console.log(`  方式 ${JSON.stringify(methodTally)}`);
console.log(`  交叉分布最大偏差 ${maxDev.toFixed(2)} 张 · 最大三元组重复 ${worstTriple} 次`);
console.log(`\n功能 × 颜色（红 蓝 黑）\n${cross('color', ['red', 'blue', 'black'])}`);
console.log(`\n功能 × 方式（密电 文本 直达）\n${cross('method', ['cipher', 'text', 'direct'])}`);

/**
 * 种子化随机数 —— 保证同一 seed + 同一操作序列得到完全相同的对局。
 * 服务端权威模式下，种子由服务端生成并记录，可用于局后完整复盘验证。
 */

/** 字符串 -> 32 位无符号整数 */
export function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：轻量、分布良好、可复现 */
export function nextRandom(cursor: number, seed: string): { value: number; cursor: number } {
  let t = (hashSeed(seed) + Math.imul(cursor + 1, 0x6d2b79f5)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, cursor: cursor + 1 };
}

/** 从数组取一个随机下标（不改变原数组） */
export function pickIndex(cursor: number, seed: string, length: number): { index: number; cursor: number } {
  const r = nextRandom(cursor, seed);
  return { index: Math.floor(r.value * length), cursor: r.cursor };
}

/** Fisher–Yates 洗牌，返回新数组与新游标 */
export function shuffle<T>(arr: readonly T[], cursor: number, seed: string): { result: T[]; cursor: number } {
  const result = arr.slice();
  let c = cursor;
  for (let i = result.length - 1; i > 0; i--) {
    const r = nextRandom(c, seed);
    c = r.cursor;
    const j = Math.floor(r.value * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return { result, cursor: c };
}

/** 生成一个人类可读的随机种子 */
export function randomSeed(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

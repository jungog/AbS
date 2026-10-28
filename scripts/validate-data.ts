/**
 * CLI 数据校验 —— 进 CI 兜底
 * 运行：npm run validate
 * 退出码：0 通过（可含警告）/ 1 有错误
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, formatIssues } from '../src/data/load';

const __dirname = dirname(fileURLToPath(import.meta.url));
const base = resolve(__dirname, '../src/data/defaults');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(resolve(base, name), 'utf8'));
}

const raw = {
  version: 1,
  config: readJson('gameConfig.json'),
  identities: readJson('identities.json'),
  characters: readJson('characters.json'),
  cards: readJson('cards.json'),
};

const result = parsePack(raw);

if (result.fatal) {
  console.error('✖ 数据结构不合法：');
  console.error(result.fatal);
  process.exit(1);
}

const issues = result.issues;
const errors = issues.filter((i) => i.level === 'error');
const warns = issues.filter((i) => i.level === 'warn');

const pack = result.pack!;
const byColor = { red: 0, blue: 0, black: 0 };
const byMethod = { cipher: 0, text: 0, direct: 0 };
const byFn = new Map<string, number>();
for (const c of pack.cards) {
  byColor[c.color]++;
  byMethod[c.method]++;
  byFn.set(c.fn, (byFn.get(c.fn) ?? 0) + 1);
}

console.log('数据概况');
console.log(`  卡牌 ${pack.cards.length} 张`);
console.log(
  `  颜色：红 ${byColor.red} / 蓝 ${byColor.blue} / 黑 ${byColor.black}（黑占 ${(
    (byColor.black / pack.cards.length) *
    100
  ).toFixed(1)}%）`,
);
console.log(`  方式：密电 ${byMethod.cipher} / 文本 ${byMethod.text} / 直达 ${byMethod.direct}`);
console.log(
  `  功能：${[...byFn.entries()].map(([k, v]) => `${k}×${v}`).join('、')}`,
);
console.log(`  角色 ${pack.characters.length} 个 · 身份 ${pack.identities.length} 个`);
console.log(`  人数配置：${Object.keys(pack.config.seats).sort().join(' / ')} 人`);
console.log('');

if (issues.length > 0) {
  console.log(formatIssues(issues));
  console.log('');
}

if (errors.length > 0) {
  console.error(`✖ 校验失败：${errors.length} 个错误、${warns.length} 个警告`);
  process.exit(1);
}

console.log(`✔ 校验通过（${warns.length} 个警告）`);

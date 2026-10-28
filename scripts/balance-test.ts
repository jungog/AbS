/**
 * 平衡测试 —— 用 AI 跑 N 局，输出阵营胜率与座位胜率。
 *
 * 用途：
 *  1. 改数值后快速看趋势（不是精确平衡结论，AI 策略本身会带来偏差）
 *  2. 检测「引擎是否有阵营偏置」—— 若要排除 AI 策略干扰，
 *     可加 --random 参数改用纯随机策略，此时红蓝应接近 50/50
 *
 * 运行：npx tsx scripts/balance-test.ts [局数] [--random]
 */
import { loadDefaultPack } from '../src/data/load';
import { applyCommand, createGame } from '../src/core/engine';
import { botDecide } from '../src/core/ai';
import type { Command, GameState, PassMethod } from '../src/core/types';

const pack = loadDefaultPack();
const args = process.argv.slice(2);
const rounds = Number(args.find((a) => /^\d+$/.test(a)) ?? 100);
const useRandom = args.includes('--random');
const playerCount = 5;

/** 纯随机策略：用于验证引擎本身无阵营偏置 */
function randomPolicy(state: GameState): Command | null {
  const p = state.pending;
  if (!p || p.kind === 'gameOver') return null;
  const me = state.players.find((x) => x.id === p.player)!;
  const rnd = (n: number) => Math.floor(Math.random() * n);

  if (p.kind === 'action') return { type: 'advancePhase' };
  if (p.kind === 'intelDeclare') {
    const card = me.hand[rnd(me.hand.length)];
    if (!card) return null;
    const methods: PassMethod[] = ['cipher', 'text', 'direct'];
    const method = methods[rnd(3)]!;
    if (method === 'direct') {
      const others = state.players.filter((x) => x.alive && x.id !== me.id);
      if (others.length === 0) return { type: 'transmitIntel', cardUid: card.uid, method: 'cipher' };
      return {
        type: 'transmitIntel',
        cardUid: card.uid,
        method,
        targetId: others[rnd(others.length)]!.id,
      };
    }
    return { type: 'transmitIntel', cardUid: card.uid, method };
  }
  if (p.kind === 'receive') return { type: 'decideReceive', accept: Math.random() < 0.5 };
  if (p.kind === 'response') return { type: 'pass' };
  if (p.kind === 'discard') {
    return { type: 'discard', cardUids: me.hand.slice(0, p.need).map((c) => c.uid) };
  }
  return null;
}

const sideWins = { red: 0, blue: 0, agent: 0 };
const seatWins: number[] = Array.from({ length: playerCount }, () => 0);
let finished = 0;
let totalRounds = 0;
let totalSteps = 0;
let failed = 0;

for (let g = 0; g < rounds; g++) {
  let state: GameState;
  try {
    state = createGame({
      pack,
      seed: `BAL${g}`,
      players: Array.from({ length: playerCount }, (_, i) => ({ name: `P${i}`, isBot: true })),
    });
  } catch {
    failed++;
    continue;
  }

  let steps = 0;
  while (!state.winner && steps < 8000) {
    steps++;
    const cmd = useRandom ? randomPolicy(state) : botDecide(state, pack);
    if (!cmd) break;
    const res = applyCommand(state, pack, cmd);
    if (res.error) {
      failed++;
      break;
    }
    state = res.state;
  }
  totalSteps += steps;

  if (state.winner) {
    finished++;
    sideWins[state.winner.side]++;
    totalRounds += state.round;
    const trigger = state.winner!.by ?? state.winner!.winners[0];
    const seat = state.players.find((p) => p.id === trigger)?.seat;
    if (typeof seat === 'number') seatWins[seat] = (seatWins[seat] ?? 0) + 1;
  }
}

const pct = (n: number) => `${((n / Math.max(1, finished)) * 100).toFixed(1)}%`;

console.log(`策略：${useRandom ? '纯随机（用于验证引擎无偏）' : '启发式 AI'}　人数：${playerCount}`);
console.log(`完成 ${finished}/${rounds} 局${failed ? `，异常 ${failed} 局` : ''}`);
console.log('');
console.log(`阵营胜率　红 ${sideWins.red}（${pct(sideWins.red)}）`);
console.log(`　　　　　蓝 ${sideWins.blue}（${pct(sideWins.blue)}）`);
console.log(`　　　　　特工 ${sideWins.agent}（${pct(sideWins.agent)}）`);
console.log('');
console.log(`平均轮数　${(totalRounds / Math.max(1, finished)).toFixed(2)}`);
console.log(`平均步数　${(totalSteps / Math.max(1, finished)).toFixed(1)}`);
console.log('');
console.log('座位胜场　' + seatWins.map((v, i) => `P${i + 1}:${v}`).join('　'));

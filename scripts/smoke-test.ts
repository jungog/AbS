/**
 * 引擎冒烟测试 —— 让 5 个 AI 打完整局，验证状态机不会卡死、不会崩。
 * 运行：npx tsx scripts/smoke-test.ts [局数]
 */
import { loadDefaultPack } from '../src/data/load';
import { applyCommand, createGame } from '../src/core/engine';
import { botDecide } from '../src/core/ai';
import type { Command, GameState } from '../src/core/types';

const pack = loadDefaultPack();

function runOneGame(seed: string, playerCount: number, verbose: boolean): GameState {
  let state = createGame({
    pack,
    seed,
    players: Array.from({ length: playerCount }, (_, i) => ({
      name: `AI-${i + 1}`,
      isBot: true,
    })),
  });

  let steps = 0;
  const MAX_STEPS = 8000;
  let lastSig = '';

  while (!state.winner && steps < MAX_STEPS) {
    steps++;
    const pending = state.pending;
    if (!pending) throw new Error('pending 为空但游戏未结束');
    if (pending.kind === 'gameOver') break;

    const cmd: Command | null = botDecide(state, pack);
    if (!cmd) {
      throw new Error(`AI 无法在 pending=${pending.kind} 下给出指令`);
    }

    const res = applyCommand(state, pack, cmd);
    if (res.error) {
      throw new Error(
        `指令被拒：${res.error}\n  pending=${pending.kind} cmd=${JSON.stringify(cmd)}\n  最后日志：${
          state.log[state.log.length - 1]?.text
        }`,
      );
    }

    const np = res.state.pending;
    const sig = [
      res.state.logSeq,
      np?.kind,
      np && np.kind !== 'gameOver' ? np.player : '-',
      res.state.window?.passed.length ?? 0,
      res.state.turnIndex,
      res.state.phase,
    ].join('|');
    if (sig === lastSig) throw new Error(`状态无进展，疑似死循环：${sig}`);
    lastSig = sig;

    state = res.state;
    if (verbose) {
      const entry = state.log[state.log.length - 1];
      if (entry) console.log(`  [${entry.seq}] ${entry.text}`);
    }
  }

  if (!state.winner) {
    throw new Error(`超过 ${MAX_STEPS} 步仍未结束，可能卡死。最后 pending=${state.pending?.kind}`);
  }
  return state;
}

function main() {
  const rounds = Number(process.argv[2] ?? 5);
  let ok = 0;
  const sides = { red: 0, blue: 0, agent: 0 };

  for (let i = 0; i < rounds; i++) {
    const seed = `SMOKE${i}`;
    try {
      const state = runOneGame(seed, 5, false);
      ok++;
      sides[state.winner!.side]++;
      console.log(
        `✔ 局 ${i + 1}（seed=${seed}）结束于第 ${state.round} 轮 · ${state.winner!.side} 胜 · ` +
          `落位情报 ${state.stats.intelPlaced} · 死亡 ${state.stats.deaths} · 截获 ${state.stats.intercepted} · 识破 ${state.stats.counters}`,
      );
    } catch (e) {
      console.error(`✖ 局 ${i + 1}（seed=${seed}）失败：`);
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\n通过 ${ok}/${rounds} 局。阵营分布：红 ${sides.red} / 蓝 ${sides.blue} / 特工 ${sides.agent}`);
}

main();

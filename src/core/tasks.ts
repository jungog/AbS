/**
 * 机密任务 —— 描述文案 + 达成判定
 *
 * 只有一个职责：把结构化任务翻译成人话，并在引擎里判定是否达成。
 * 文案和判定写在同一个文件里，就不会出现「文本说 3 张、判定却看 4 张」的漂移。
 */
import type { GameState, PlayerState, SecretTask } from './types';

export const TASK_KINDS: SecretTask['kind'][] = [
  'holdColor',
  'collectTotal',
  'noBlackWith',
  'othersDead',
  'surviveRounds',
];

export const TASK_KIND_LABEL: Record<SecretTask['kind'], string> = {
  holdColor: '持有指定颜色情报',
  collectTotal: '持有情报总数',
  noBlackWith: '保持无黑色情报',
  othersDead: '其他人出局人数',
  surviveRounds: '存活到指定轮次',
};

/** 生成给玩家看的任务描述 */
export function describeTask(task: SecretTask | null): string {
  if (!task) return '（无机密任务：特工按「集齐 6 张真情报」获胜）';
  switch (task.kind) {
    case 'holdColor':
      return `对局结束时，你面前至少有 ${task.count} 张${task.color === 'red' ? '红' : '蓝'}色情报。`;
    case 'collectTotal':
      return `对局结束时，你面前的情报总数达到 ${task.count} 张。`;
    case 'noBlackWith':
      return `对局结束时，你面前有 ${task.count} 张情报，且一张黑色情报都没有。`;
    case 'othersDead':
      return `除你之外，有 ${task.count} 名玩家出局。`;
    case 'surviveRounds':
      return `存活到第 ${task.round} 轮开始。`;
  }
}

/** 该任务是否已达成（引擎每个状态变化后都会问一次） */
export function isTaskDone(task: SecretTask, state: GameState, self: PlayerState): boolean {
  const red = self.intel.filter((s) => s.color === 'red').length;
  const blue = self.intel.filter((s) => s.color === 'blue').length;
  const black = self.intel.filter((s) => s.color === 'black').length;

  switch (task.kind) {
    case 'holdColor':
      return (task.color === 'red' ? red : blue) >= task.count;
    case 'collectTotal':
      return self.intel.length >= task.count;
    case 'noBlackWith':
      return self.intel.length >= task.count && black === 0;
    case 'othersDead':
      return state.players.filter((p) => !p.alive && p.id !== self.id).length >= task.count;
    case 'surviveRounds':
      return self.alive && state.round >= task.round;
  }
}

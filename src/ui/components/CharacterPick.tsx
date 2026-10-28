import { PACK } from '@data/pack';
import { describeTask } from '@core/tasks';
import type { RedactedState } from '@core/redact';
import type { Command } from '@core/types';

/**
 * 选角面板 —— 开局时每人从 3 个候选角色里挑 1 个。
 * 特工会额外看到自己的机密任务（其他人看到的是空）。
 */
export function CharacterPick(props: { view: RedactedState; onCommand: (cmd: Command) => void }) {
  const pending = props.view.pending;
  if (!pending || pending.kind !== 'pickCharacter') return null;

  const options = pending.options ?? [];
  const me = props.view.players.find((p) => p.id === pending.player);
  const isAgent = me?.identity === 'agent';

  return (
    <div className="actionbar pick">
      <div className="actionbar-title">
        <strong>选择角色</strong>
        <span className="hint">
          从 {options.length} 个候选里挑 1 个 —— 角色决定你的技能{isAgent ? '，以及你的机密任务' : ''}
        </span>
      </div>

      <div className="pick-grid">
        {options.map((id) => {
          const def = PACK.characterById.get(id);
          if (!def) return null;
          return (
            <div
              key={id}
              className="pick-card"
              onClick={() => props.onCommand({ type: 'pickCharacter', characterId: id })}
            >
              <div className="pick-head">
                <span className="pick-name">{def.name}</span>
                <span className="pick-diff">
                  {'★'.repeat(def.difficulty)}
                  {'☆'.repeat(Math.max(0, 5 - def.difficulty))}
                </span>
              </div>
              <div className="pick-skill">{def.skillText || '（无技能）'}</div>
              {isAgent && def.task && <div className="pick-task">机密任务：{describeTask(def.task)}</div>}
              {def.hidden && <div className="pick-flag">隐藏角色</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

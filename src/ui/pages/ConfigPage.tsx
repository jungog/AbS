import { useMemo, useState } from 'react';
import { loadRawDefault, parsePack } from '@data/load';
import { SKILLS } from '@core/skills';
import { TASK_KINDS, TASK_KIND_LABEL } from '@core/tasks';
import type { CardDef, CharacterDef, IdentityDef, SecretTask } from '@core/types';

interface RawPack {
  version: 1;
  config: Record<string, unknown>;
  identities: IdentityDef[];
  characters: CharacterDef[];
  cards: CardDef[];
}

const COLORS = ['red', 'blue', 'black'] as const;
const METHODS = ['cipher', 'text', 'direct'] as const;
const FNS = ['lock', 'lure', 'return', 'intercept', 'decode', 'counter', 'burn', 'probe', 'shuffle'] as const;

const COLOR_TEXT: Record<string, string> = { red: '红', blue: '蓝', black: '黑' };
const METHOD_TEXT: Record<string, string> = { cipher: '密电', text: '文本', direct: '直达' };

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 机密任务编辑器：结构化字段，避免「文案说 3 张、判定看 4 张」 */
function TaskEditor(props: { task: SecretTask | null; onChange: (t: SecretTask | null) => void }) {
  const { task, onChange } = props;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <select
        value={task?.kind ?? ''}
        onChange={(e) => {
          const kind = e.target.value;
          if (!kind) return onChange(null);
          if (kind === 'holdColor') return onChange({ kind: 'holdColor', color: 'red', count: 3 });
          if (kind === 'surviveRounds') return onChange({ kind: 'surviveRounds', round: 4 });
          onChange({ kind, count: 3 } as SecretTask);
        }}
        style={{ width: 100 }}
      >
        <option value="">（无）</option>
        {TASK_KINDS.map((k) => (
          <option key={k} value={k}>
            {TASK_KIND_LABEL[k]}
          </option>
        ))}
      </select>

      {task?.kind === 'holdColor' && (
        <>
          <select
            value={task.color}
            onChange={(e) => onChange({ kind: 'holdColor', color: e.target.value as 'red' | 'blue', count: task.count })}
            style={{ width: 56 }}
          >
            <option value="red">红</option>
            <option value="blue">蓝</option>
          </select>
          <input
            type="number"
            min={1}
            value={task.count}
            onChange={(e) => onChange({ kind: 'holdColor', color: task.color, count: Number(e.target.value) })}
            style={{ width: 52 }}
          />
        </>
      )}

      {(task?.kind === 'collectTotal' || task?.kind === 'noBlackWith' || task?.kind === 'othersDead') && (
        <input
          type="number"
          min={1}
          value={task.count}
          onChange={(e) => onChange({ ...task, count: Number(e.target.value) })}
          style={{ width: 52 }}
        />
      )}

      {task?.kind === 'surviveRounds' && (
        <input
          type="number"
          min={1}
          value={task.round}
          onChange={(e) => onChange({ kind: 'surviveRounds', round: Number(e.target.value) })}
          style={{ width: 52 }}
        />
      )}
    </div>
  );
}

export function ConfigPage() {
  const [pack, setPack] = useState<RawPack>(() => loadRawDefault() as RawPack);
  const [tab, setTab] = useState<'cards' | 'characters' | 'identities' | 'json'>('cards');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const result = useMemo(() => parsePack(pack), [pack]);
  const errors = result.issues.filter((i) => i.level === 'error');
  const warns = result.issues.filter((i) => i.level === 'warn');

  const stats = useMemo(() => {
    const byColor: Record<string, number> = { red: 0, blue: 0, black: 0 };
    const byMethod: Record<string, number> = { cipher: 0, text: 0, direct: 0 };
    const byFn: Record<string, number> = {};
    for (const c of pack.cards) {
      byColor[c.color] = (byColor[c.color] ?? 0) + 1;
      byMethod[c.method] = (byMethod[c.method] ?? 0) + 1;
      byFn[c.fn] = (byFn[c.fn] ?? 0) + 1;
    }
    return { byColor, byMethod, byFn, total: pack.cards.length };
  }, [pack.cards]);

  const patchCard = (i: number, patch: Partial<CardDef>) => {
    setPack((p) => {
      const cards = p.cards.slice();
      cards[i] = { ...cards[i]!, ...patch };
      return { ...p, cards };
    });
  };

  const patchChar = (i: number, patch: Partial<CharacterDef>) => {
    setPack((p) => {
      const characters = p.characters.slice();
      characters[i] = { ...characters[i]!, ...patch };
      return { ...p, characters };
    });
  };

  const patchIdentity = (i: number, patch: Partial<IdentityDef>) => {
    setPack((p) => {
      const identities = p.identities.slice();
      identities[i] = { ...identities[i]!, ...patch };
      return { ...p, identities };
    });
  };

  const loadJsonToEditor = () => {
    setJsonText(JSON.stringify(pack, null, 2));
    setJsonError(null);
    setTab('json');
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as RawPack;
      const check = parsePack(parsed);
      if (check.fatal) {
        setJsonError(check.fatal);
        return;
      }
      setPack(parsed);
      setJsonError(null);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="config">
      <div className="config-head">
        <h1>数据配置</h1>
        <span style={{ fontSize: 12, color: 'var(--ink3)' }}>
          {stats.total} 张卡牌 · {pack.characters.length} 个角色 · {pack.identities.length} 个身份
        </span>
      </div>
      <div className="config-desc">
        改动实时通过 zod 校验。导出后覆盖 <code>src/data/defaults/</code> 下的同名文件即可生效；CI 里用{' '}
        <code>npm run validate</code> 兜底。
      </div>

      <div className="toolbar">
        <button
          onClick={() => {
            const next = loadRawDefault() as RawPack;
            setPack(next);
          }}
        >
          恢复默认
        </button>
        <button onClick={loadJsonToEditor}>查看 / 编辑 JSON</button>
        <div className="spacer" />
        <span style={{ fontSize: 12, color: errors.length ? 'var(--red)' : 'var(--green)' }}>
          {errors.length === 0 ? '✔ 无错误' : `✖ ${errors.length} 个错误`}
          {warns.length > 0 && ` · ▲ ${warns.length} 个警告`}
        </span>
      </div>

      {(errors.length > 0 || warns.length > 0) && (
        <div className="issue-list">
          {[...errors, ...warns].slice(0, 12).map((i, k) => (
            <div key={k} className={`issue ${i.level}`}>
              [{i.path}] {i.message}
            </div>
          ))}
          {errors.length + warns.length > 12 && (
            <div className="issue">… 还有 {errors.length + warns.length - 12} 条</div>
          )}
        </div>
      )}

      <div className="stat-row">
        <span>
          红 <b>{stats.byColor.red}</b> / 蓝 <b>{stats.byColor.blue}</b> / 黑{' '}
          <b>{stats.byColor.black}</b>
          <span style={{ marginLeft: 6 }}>
            （黑占 {((stats.byColor.black / stats.total) * 100).toFixed(1)}%）
          </span>
        </span>
        <span>
          密电 <b>{stats.byMethod.cipher}</b> / 文本 <b>{stats.byMethod.text}</b> / 直达{' '}
          <b>{stats.byMethod.direct}</b>
        </span>
        <span>
          功能牌种类 <b>{Object.keys(stats.byFn).length}</b> / 9
        </span>
      </div>

      <div className="tabs-line">
        <button className={tab === 'cards' ? 'active' : ''} onClick={() => setTab('cards')}>
          卡牌（{pack.cards.length}）
        </button>
        <button
          className={tab === 'characters' ? 'active' : ''}
          onClick={() => setTab('characters')}
        >
          角色（{pack.characters.length}）
        </button>
        <button className={tab === 'identities' ? 'active' : ''} onClick={() => setTab('identities')}>
          身份与规则
        </button>
        <button className={tab === 'json' ? 'active' : ''} onClick={() => setTab('json')}>
          JSON
        </button>
      </div>

      {tab === 'cards' && (
        <>
          <div className="toolbar">
            <button
              onClick={() =>
                setPack((p) => ({
                  ...p,
                  cards: [
                    ...p.cards,
                    {
                      id: `c${String(p.cards.length + 1).padStart(3, '0')}`,
                      name: '新功能牌',
                      color: 'red',
                      method: 'cipher',
                      fn: 'lock',
                      fnText: '',
                    },
                  ],
                }))
              }
            >
              + 新增卡牌
            </button>
            <button onClick={() => download('cards.json', JSON.stringify(pack.cards, null, 2))}>
              导出 cards.json
            </button>
          </div>
          <div className="grid-scroll">
            <table className="grid" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ width: 42 }}>#</th>
                <th style={{ width: 90 }}>id</th>
                <th style={{ width: 130 }}>名称</th>
                <th style={{ width: 80 }}>颜色</th>
                <th style={{ width: 90 }}>传递方式</th>
                <th style={{ width: 110 }}>功能</th>
                <th>效果文本</th>
                <th style={{ width: 50 }} />
              </tr>
            </thead>
            <tbody>
              {pack.cards.map((c, i) => (
                <tr key={`${c.id}-${i}`}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <input value={c.id} onChange={(e) => patchCard(i, { id: e.target.value })} />
                  </td>
                  <td>
                    <input value={c.name} onChange={(e) => patchCard(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <select
                      value={c.color}
                      onChange={(e) => patchCard(i, { color: e.target.value as CardDef['color'] })}
                    >
                      {COLORS.map((v) => (
                        <option key={v} value={v}>
                          {COLOR_TEXT[v]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={c.method}
                      onChange={(e) => patchCard(i, { method: e.target.value as CardDef['method'] })}
                    >
                      {METHODS.map((v) => (
                        <option key={v} value={v}>
                          {METHOD_TEXT[v]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={c.fn}
                      onChange={(e) => patchCard(i, { fn: e.target.value as CardDef['fn'] })}
                    >
                      {FNS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      value={c.fnText}
                      onChange={(e) => patchCard(i, { fnText: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      className="ghost"
                      onClick={() =>
                        setPack((p) => ({ ...p, cards: p.cards.filter((_, k) => k !== i) }))
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {tab === 'characters' && (
        <>
          <div className="toolbar">
            <button
              onClick={() =>
                setPack((p) => ({
                  ...p,
                  characters: [
                    ...p.characters,
                    {
                      id: `char${p.characters.length + 1}`,
                      name: '新角色',
                      hidden: false,
                      difficulty: 3,
                      skillId: null,
                      skillText: '',
                      task: null,
                    },
                  ],
                }))
              }
            >
              + 新增角色
            </button>
            <button
              onClick={() => download('characters.json', JSON.stringify(pack.characters, null, 2))}
            >
              导出 characters.json
            </button>
          </div>
          <div className="grid-scroll">
            <table className="grid" style={{ minWidth: 910 }}>
            <thead>
              <tr>
                <th style={{ width: 42 }}>#</th>
                <th style={{ width: 100 }}>id</th>
                <th style={{ width: 100 }}>名称</th>
                <th style={{ width: 60 }}>隐藏</th>
                <th style={{ width: 70 }}>难度</th>
                <th style={{ width: 150 }}>技能实现</th>
                <th>技能文本</th>
                <th style={{ width: 260 }}>机密任务</th>
                <th style={{ width: 50 }} />
              </tr>
            </thead>
            <tbody>
              {pack.characters.map((c, i) => (
                <tr key={`${c.id}-${i}`}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <input value={c.id} onChange={(e) => patchChar(i, { id: e.target.value })} />
                  </td>
                  <td>
                    <input value={c.name} onChange={(e) => patchChar(i, { name: e.target.value })} />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={c.hidden}
                      onChange={(e) => patchChar(i, { hidden: e.target.checked })}
                      style={{ width: 'auto' }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={c.difficulty}
                      onChange={(e) => patchChar(i, { difficulty: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <select
                      value={c.skillId ?? ''}
                      onChange={(e) => patchChar(i, { skillId: e.target.value || null })}
                    >
                      <option value="">（无 / 纯占位）</option>
                      {Object.keys(SKILLS).map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      value={c.skillText}
                      onChange={(e) => patchChar(i, { skillText: e.target.value })}
                    />
                  </td>
                  <td>
                    <TaskEditor task={c.task} onChange={(t) => patchChar(i, { task: t })} />
                  </td>
                  <td>
                    <button
                      className="ghost"
                      onClick={() =>
                        setPack((p) => ({
                          ...p,
                          characters: p.characters.filter((_, k) => k !== i),
                        }))
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {tab === 'identities' && (
        <>
          <div className="toolbar">
            <button
              onClick={() =>
                download('identities.json', JSON.stringify(pack.identities, null, 2))
              }
            >
              导出 identities.json
            </button>
            <button
              onClick={() => download('gameConfig.json', JSON.stringify(pack.config, null, 2))}
            >
              导出 gameConfig.json
            </button>
          </div>
          <div className="grid-scroll">
            <table className="grid" style={{ marginBottom: 24, minWidth: 520 }}>
            <thead>
              <tr>
                <th style={{ width: 90 }}>阵营</th>
                <th style={{ width: 140 }}>名称</th>
                <th>说明</th>
                <th>胜利条件</th>
              </tr>
            </thead>
            <tbody>
              {pack.identities.map((it, i) => (
                <tr key={it.kind}>
                  <td>
                    <code>{it.kind}</code>
                  </td>
                  <td>
                    <input
                      value={it.name}
                      onChange={(e) => patchIdentity(i, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={it.desc}
                      onChange={(e) => patchIdentity(i, { desc: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={it.winText}
                      onChange={(e) => patchIdentity(i, { winText: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className="section-label">规 则 参 数</div>
          <div className="grid-scroll">
            <table className="grid" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th style={{ width: 220 }}>参数</th>
                <th style={{ width: 120 }}>值</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['handLimit', '手牌上限'],
                  ['startHand', '起始手牌'],
                  ['drawPerTurn', '每回合抽牌'],
                  ['winIntelCount', '阵营获胜所需同色情报'],
                  ['agentWinIntelCount', '特工获胜所需真情报'],
                  ['deathBlackCount', '死亡所需黑色情报'],
                ] as const
              ).map(([key, label]) => (
                <tr key={key}>
                  <td>
                    <code>{key}</code>
                  </td>
                  <td>
                    <input
                      type="number"
                      value={Number((pack.config as Record<string, unknown>)[key] ?? 0)}
                      onChange={(e) =>
                        setPack((p) => ({
                          ...p,
                          config: { ...p.config, [key]: Number(e.target.value) },
                        }))
                      }
                    />
                  </td>
                  <td style={{ color: 'var(--ink3)' }}>{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className="section-label" style={{ marginTop: 24 }}>
            身 份 配 置（各人数下红 / 蓝 / 特工）
          </div>
          <div className="grid-scroll">
            <table className="grid" style={{ minWidth: 520 }}>
            <thead>
              <tr>
                <th style={{ width: 90 }}>人数</th>
                <th style={{ width: 100 }}>潜伏（红）</th>
                <th style={{ width: 100 }}>军情（蓝）</th>
                <th style={{ width: 100 }}>特工</th>
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(
                (pack.config as { seats: Record<string, { red: number; blue: number; agent: number }> })
                  .seats,
              ).map(([n, cfg]) => (
                <tr key={n}>
                  <td>
                    <b>{n}</b> 人
                  </td>
                  {(['red', 'blue', 'agent'] as const).map((k) => (
                    <td key={k}>
                      <input
                        type="number"
                        value={cfg[k]}
                        onChange={(e) =>
                          setPack((p) => {
                            const seats = {
                              ...(p.config as { seats: Record<string, { red: number; blue: number; agent: number }> })
                                .seats,
                            };
                            seats[n] = { ...cfg, [k]: Number(e.target.value) };
                            return { ...p, config: { ...p.config, seats } };
                          })
                        }
                      />
                    </td>
                  ))}
                  <td style={{ color: cfg.red + cfg.blue + cfg.agent === Number(n) ? 'var(--green)' : 'var(--red)' }}>
                    {cfg.red + cfg.blue + cfg.agent}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {tab === 'json' && (
        <>
          <div className="toolbar">
            <button onClick={() => setJsonText(JSON.stringify(pack, null, 2))}>从当前数据刷新</button>
            <button className="primary" onClick={applyJson}>
              应用 JSON
            </button>
            <button onClick={() => download('data-pack.json', jsonText || JSON.stringify(pack, null, 2))}>
              导出完整包
            </button>
          </div>
          {jsonError && <div className="error">{jsonError}</div>}
          <textarea
            className="json"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder="点击「从当前数据刷新」载入当前数据，或直接粘贴一份完整的数据包"
          />
        </>
      )}
    </div>
  );
}

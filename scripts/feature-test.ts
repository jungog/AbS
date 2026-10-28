/**
 * 单项功能测试 —— 覆盖冒烟测试不容易碰到的具体规则。
 * 直接构造状态来测，比等随机牌局凑齐条件可靠得多。
 *
 * 运行：npx tsx scripts/feature-test.ts
 */
import { loadDefaultPack } from '../src/data/load';
import { applyCommand } from '../src/core/engine';
import { createGame } from '../src/core/engine';
import { redactState } from '../src/core/redact';
import { describeTask } from '../src/core/tasks';
import type { GameState } from '../src/core/types';

const pack = loadDefaultPack();
const results: [string, boolean, string?][] = [];
const check = (name: string, pass: boolean, extra?: string) => results.push([name, pass, extra]);

function freshGame(seed: string): GameState {
  return createGame({
    pack,
    seed,
    skipSetup: true,
    players: Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, isBot: true })),
  });
}

/* ------------------------------------------------------------------ */
/* 1. 【试探】：只给使用者一条密文日志                                    */
/* ------------------------------------------------------------------ */
{
  const g = freshGame('FEAT1');
  const probeDef = pack.cards.find((c) => c.fn === 'probe')!;
  const actor = g.players[0]!;
  const target = g.players[2]!;

  actor.hand.push({ uid: 'test-probe', defId: probeDef.id });
  g.phase = 'action';
  g.pending = { kind: 'action', player: actor.id, prompt: '' };

  const r = applyCommand(g, pack, { type: 'playFunction', cardUid: 'test-probe', targetId: target.id });
  check('【试探】可以被使用', !r.error, r.error);

  const probeLog = r.state.log.find((e) => e.text.includes('其中黑色'));
  check('【试探】产生了密文日志', Boolean(probeLog), '没找到日志');
  check('【试探】日志只对使用者可见', probeLog?.secretTo === actor.id, `secretTo=${probeLog?.secretTo}`);

  // 别人看不到这条密文
  const otherView = redactState(r.state, pack, target.id);
  check(
    '别人裁剪后看不到这条密文',
    !otherView.log.some((e) => e.text.includes('其中黑色')),
    '泄漏了',
  );
  // 自己看得到
  const selfView = redactState(r.state, pack, actor.id);
  check('自己裁剪后能看到这条密文', selfView.log.some((e) => e.text.includes('其中黑色')));
  // 公开日志里只有「打出了【试探】」，不含内容
  check(
    '公开日志不含试探结果',
    r.state.log.some((e) => e.text.includes('打出【试探】') && !e.secretTo),
  );

  // 目标必填
  const g2 = freshGame('FEAT1');
  const a2 = g2.players[0]!;
  a2.hand.push({ uid: 'p2', defId: probeDef.id });
  g2.phase = 'action';
  g2.pending = { kind: 'action', player: a2.id, prompt: '' };
  const r2 = applyCommand(g2, pack, { type: 'playFunction', cardUid: 'p2' });
  check('【试探】不指定目标会被拒绝', Boolean(r2.error), '居然通过了');
}

/* ------------------------------------------------------------------ */
/* 2. 【锁定】：接收者不能拒收                                           */
/* ------------------------------------------------------------------ */
{
  const g = freshGame('FEAT2');
  const src = g.players[0]!;
  const card = src.hand[0]!;
  const def = pack.cardById.get(card.defId)!;

  g.phase = 'intel';
  g.pending = { kind: 'intelDeclare', player: src.id, prompt: '' };
  const r1 = applyCommand(g, pack, {
    type: 'transmitIntel',
    cardUid: card.uid,
    method: 'cipher',
  });
  check('能正常传出情报', !r1.error, r1.error);

  // 传出后先经过「截获响应窗口」，全部放弃后才会落到接收决策
  let st = r1.state;
  let guard = 0;
  while (st.pending?.kind === 'response' && guard < 20) {
    guard += 1;
    const rp = applyCommand(st, pack, { type: 'pass' });
    if (rp.error) break;
    st = rp.state;
  }
  check('响应窗口走完后进入接收决策', st.pending?.kind === 'receive', `实际 ${st.pending?.kind}`);

  // 让当前接收者处于「被锁定」状态，然后尝试拒收
  if (st.flow && st.pending?.kind === 'receive') {
    st.flow.locked = true;
    const r2 = applyCommand(st, pack, { type: 'decideReceive', accept: false });
    check('被【锁定】时拒收会被拒绝', Boolean(r2.error), '居然允许拒收');
    void def;
  } else {
    check('被【锁定】时拒收会被拒绝', false, '没走到接收决策');
  }
}

/* ------------------------------------------------------------------ */
/* 3. 回合推进：三个基本阶段都能跑通                                      */
/* ------------------------------------------------------------------ */
{
  const g = freshGame('FEAT3');
  check('开局是出牌阶段', g.phase === 'action' && g.pending?.kind === 'action', `${g.phase}/${g.pending?.kind}`);
  const r = applyCommand(g, pack, { type: 'advancePhase' });
  check('出牌阶段 → 情报阶段', r.state.phase === 'intel' && r.state.pending?.kind === 'intelDeclare', `${r.state.phase}/${r.state.pending?.kind}`);
  const r2 = applyCommand(r.state, pack, { type: 'advancePhase' });
  check('情报阶段不能再跳过', Boolean(r2.error), '居然允许跳过');
}

/* ------------------------------------------------------------------ */
/* 4. 身份配置：各人数下红蓝特工数量与人数一致                            */
/* ------------------------------------------------------------------ */
{
  let allOk = true;
  const detail: string[] = [];
  for (const n of [3, 4, 5, 6, 7]) {
    const g = createGame({
      pack,
      seed: `SEAT${n}`,
      players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isBot: true })),
    });
    const counts = { red: 0, blue: 0, agent: 0 };
    for (const p of g.players) counts[p.identity] += 1;
    const cfg = pack.config.seats[String(n)]!;
    const ok =
      g.players.length === n && counts.red === cfg.red && counts.blue === cfg.blue && counts.agent === cfg.agent;
    if (!ok) allOk = false;
    detail.push(`${n}人:${counts.red}/${counts.blue}/${counts.agent}`);
  }
  check('各人数身份分配符合配置', allOk, detail.join(' '));
}

/* ------------------------------------------------------------------ */
/* 5. 选角：3 选 1                                                      */
/* ------------------------------------------------------------------ */
{
  const g = createGame({
    pack,
    seed: 'PICK1',
    players: Array.from({ length: 3 }, (_, i) => ({ name: `P${i}`, isBot: false })),
  });

  check('开局进入选角阶段', g.phase === 'setup' && g.pending?.kind === 'pickCharacter', `${g.phase}/${g.pending?.kind}`);

  const first = g.pending;
  const opts = first && first.kind === 'pickCharacter' ? first.options : [];
  check('每个玩家拿到 3 个候选', opts.length === 3, `实际 ${opts.length}`);

  // 选一个不在候选里的角色
  const outsider = pack.characters.find((c) => !opts.includes(c.id));
  const bad = applyCommand(g, pack, { type: 'pickCharacter', characterId: outsider!.id });
  check('不能选不在候选里的角色', Boolean(bad.error), '居然通过了');

  // 正常选第一个
  const r1 = applyCommand(g, pack, { type: 'pickCharacter', characterId: opts[0]! });
  check('选角后轮到下一位', !r1.error && r1.state.pending?.kind === 'pickCharacter' && r1.state.pending.player === 'p1', r1.error);
  check('已选角色的玩家被标记', r1.state.players[0]!.characterPicked && r1.state.players[0]!.characterId === opts[0]);

  const second = r1.state.pending;
  const opts2 = second && second.kind === 'pickCharacter' ? second.options : [];
  check('别人选走的角色不再出现在候选里', !opts2.includes(opts[0]!), `候选 ${opts2.join(',')}`);

  // 把剩下两人选完
  let st = r1.state;
  for (let i = 0; i < 2; i++) {
    const pd = st.pending;
    if (!pd || pd.kind !== 'pickCharacter') break;
    const rr = applyCommand(st, pack, { type: 'pickCharacter', characterId: pd.options[0]! });
    if (rr.error) break;
    st = rr.state;
  }
  check('三人选完后进入第一回合', st.phase === 'action' && st.pending?.kind === 'action', `${st.phase}/${st.pending?.kind}`);
  check('三人都已选角', st.players.every((p) => p.characterPicked));
}

/* ------------------------------------------------------------------ */
/* 6. 机密任务：特工完成即单独获胜                                       */
/* ------------------------------------------------------------------ */
{
  const redCard = pack.cards.find((c) => c.color === 'red')!;

  const g = createGame({
    pack,
    seed: 'TASK1',
    skipSetup: true,
    players: Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, isBot: false })),
  });

  const agent = g.players[0]!;
  agent.identity = 'agent';
  // 联络员的机密任务：面前至少 3 张红色情报
  agent.characterId = 'courier';
  agent.intel = [0, 1, 2].map((i) => ({ uid: `tk${i}`, defId: redCard.id, color: 'red' as const, method: 'cipher' as const }));
  g.pending = { kind: 'action', player: agent.id, prompt: '' };
  g.phase = 'action';

  const r = applyCommand(g, pack, { type: 'advancePhase' });
  check('特工达成机密任务即获胜', r.state.winner?.side === 'agent', `实际 ${r.state.winner?.side ?? '无'}`);
  check('胜利原因写明是机密任务', (r.state.winner?.reason ?? '').includes('机密任务'), r.state.winner?.reason);

  // 红蓝阵营不做任务判定：同样持有 3 张红的情报员不会因为「任务」赢
  const g2 = createGame({
    pack,
    seed: 'TASK2',
    skipSetup: true,
    players: Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, isBot: false })),
  });
  const red = g2.players[0]!;
  red.identity = 'red';
  red.characterId = 'courier';
  red.intel = [0, 1, 2].map((i) => ({ uid: `tk${i}`, defId: redCard.id, color: 'red' as const, method: 'cipher' as const }));
  g2.pending = { kind: 'action', player: red.id, prompt: '' };
  g2.phase = 'action';
  const r2 = applyCommand(g2, pack, { type: 'advancePhase' });
  check('红方 3 张红情报走的是阵营胜利', r2.state.winner?.side === 'red', `实际 ${r2.state.winner?.side ?? '无'}`);
}

/* ------------------------------------------------------------------ */
/* 7. 任务文案：每种类型都能生成描述                                     */
/* ------------------------------------------------------------------ */
{
  const tasks = [
    { kind: 'holdColor', color: 'red', count: 3 },
    { kind: 'collectTotal', count: 5 },
    { kind: 'noBlackWith', count: 4 },
    { kind: 'othersDead', count: 2 },
    { kind: 'surviveRounds', round: 6 },
  ] as const;
  const texts = tasks.map((t) => describeTask(t));
  check('五种任务类型都有描述文案', texts.every((t) => t.length > 4), texts.join(' | '));
  check('无任务时有兜底文案', describeTask(null).includes('无机密任务'));
  check('8 个角色都配了任务', pack.characters.every((c) => c.task !== null), pack.characters.filter((c) => !c.task).map((c) => c.name).join(','));
}

/* ------------------------------------------------------------------ */
/* 8. 响应窗口只弹给「手里真有牌」的人                                    */
/* ------------------------------------------------------------------ */

/**
 * 用户报的问题：手里没有【截获】也被要求「放弃响应」。
 *
 * 这类「弹了等于没弹」的窗口几乎每回合都会出现 —— 玩家点了放弃，
 * 界面看起来什么都没发生，于是会怀疑自己是不是漏看了什么牌。
 *
 * 这里用固定牌面把两个方向都钉死：
 *  - 全桌都没有【识破】→ 不弹窗口，效果直接生效
 *  - 只有第三家有【识破】→ 弹给第三家，跳过前面没有牌的人（而不是全员弹一遍）
 */
{
  // 用【洗牌】：出牌阶段可用、不需要指定目标、且走识破窗口
  const boardCard = pack.cards.find((c) => c.fn === 'shuffle')!;
  const counterCard = pack.cards.find((c) => c.fn === 'counter')!;
  const junkCard = pack.cards.find((c) => c.fn === 'decode')!;

  const build = (seed: string) => {
    const g = createGame({
      pack,
      seed,
      skipSetup: true,
      players: Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, isBot: false })),
    });
    g.phase = 'action';
    g.round = 1;
    // 全员手牌清空，只留指定的牌，避免随机抽到【识破】把用例弄脏
    for (const pl of g.players) pl.hand = [];
    g.players[0]!.hand = [{ uid: 'lk1', defId: boardCard.id }];
    g.players[1]!.hand = [{ uid: 'jk1', defId: junkCard.id }];
    g.players[2]!.hand = [{ uid: 'jk2', defId: junkCard.id }];
    g.players[3]!.hand = [{ uid: 'jk3', defId: junkCard.id }];
    g.pending = { kind: 'action', player: 'p0', prompt: '' };
    return g;
  };

  // ---- 方向一：全桌都没【识破】 ----
  {
    const g = build('RESP1');
    const r = applyCommand(g, pack, {
      type: 'playFunction',
      cardUid: 'lk1',
      targetId: 'p1',
    });
    check('没有识破时打出功能牌不报错', !r.error, r.error);
    check(
      '全桌都没有【识破】时，不弹任何响应窗口',
      r.state.pending?.kind !== 'response',
      `实际 pending=${r.state.pending?.kind}`,
    );
    check(
      '没有人被误记成「已放弃」以外的状态（窗口直接关闭）',
      r.state.window === null,
      r.state.window ? `窗口仍在，queue=${r.state.window.queue.join(',')}` : '',
    );
    check(
      '效果照常生效（不是被吞掉了）',
      // 【洗牌】的实际卡名是「真伪莫辨」，按卡名判断，别按 fn 猜文案
      r.state.log.some((e) => e.text.includes(boardCard.name)),
      r.state.log.slice(-3).map((e) => e.text).join(' | '),
    );
  }

  // ---- 方向二：只有 p2 有【识破】，p1 没有 ----
  {
    const g = build('RESP2');
    g.players[2]!.hand = [{ uid: 'ct1', defId: counterCard.id }];
    const r = applyCommand(g, pack, {
      type: 'playFunction',
      cardUid: 'lk1',
      targetId: 'p1',
    });
    check('有识破时打出功能牌不报错', !r.error, r.error);
    const pd = r.state.pending;
    const actorId = pd && pd.kind !== 'gameOver' ? pd.player : null;
    check(
      '窗口弹给真正有【识破】的人',
      pd?.kind === 'response' && actorId === 'p2',
      `实际 ${pd?.kind}/${actorId ?? '-'}`,
    );
    check(
      '没有【识破】的人被跳过，而不是轮流弹一遍',
      r.state.window?.passed.includes('p1') === true,
      `passed=${r.state.window?.passed.join(',')}`,
    );
    check('没有【识破】的人不会成为待操作者', actorId !== 'p1', `p1 被要求响应了`);
  }

  // ---- 方向三：情报传递里的【截获】窗口同理 ----
  {
    const intelCard = pack.cards.find((c) => c.color === 'red' && c.method === 'cipher')!;
    const g = createGame({
      pack,
      seed: 'RESP3',
      skipSetup: true,
      players: Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, isBot: false })),
    });
    g.phase = 'intel';
    for (const pl of g.players) pl.hand = [];
    g.players[0]!.hand = [{ uid: 'in1', defId: intelCard.id }];
    g.pending = { kind: 'intelDeclare', player: 'p0', prompt: '' };

    const r = applyCommand(g, pack, {
      type: 'transmitIntel',
      cardUid: 'in1',
      method: 'cipher',
    });
    check('传出密电不报错', !r.error, r.error);
    const pd3 = r.state.pending;
    const actor3 = pd3 && pd3.kind !== 'gameOver' ? pd3.player : null;
    check(
      '全桌都没有【截获】时，密电直接往下传（不弹响应）',
      pd3?.kind !== 'response',
      `实际 pending=${pd3?.kind}/${actor3 ?? '-'}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */
let ok = true;
for (const [name, pass, extra] of results) {
  console.log(`${pass ? '✔' : '✖'} ${name}${pass || !extra ? '' : `  —— ${extra}`}`);
  if (!pass) ok = false;
}
console.log(`\n共 ${results.length} 项。`);
if (!ok) process.exit(1);
console.log('单项功能测试通过。');

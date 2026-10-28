/**
 * 对局动效调度
 *
 * 所有动画都由「状态变化」触发，而不是由点击触发 —— 这样 AI 行动、
 * 热座切换视角、联机对手操作，三种模式下看到的效果完全一致。
 *
 * 只做两件事：
 *  1. flow 的 (source → current) 变化 → 卡牌飞过去
 *  2. 某个玩家的情报列表多了一张 → 那张牌「落位」闪一下
 */
import { useEffect, useRef, useState } from 'react';
import { METHOD_LABEL } from '@data/load';
import type { RedactedState } from '@core/redact';
import { flyCard, playerCardEl, pulseLanding } from '@ui/anim/fly';

export function useBattleAnim(view: RedactedState | null) {
  /** 上一帧的「传递中」指纹 */
  const prevFlowRef = useRef<string | null>(null);
  /** 上一帧每个玩家的情报 uid 集合 */
  const prevIntelRef = useRef<Map<string, Set<string>>>(new Map());
  const prevRoundRef = useRef(0);
  const [banner, setBanner] = useState<{ round: number; show: boolean }>({ round: 0, show: false });

  /* ---------- 卡牌飞行 ---------- */
  useEffect(() => {
    if (!view) return;
    const flow = view.flow;
    const key = flow ? `${flow.source}>${flow.current}` : null;
    if (flow && flow.current && key !== prevFlowRef.current) {
      const from = playerCardEl(flow.source);
      const to = playerCardEl(flow.current);
      if (from && to) {
        flyCard({
          from,
          to,
          color: flow.color,
          methodLabel: METHOD_LABEL[flow.method],
        });
      }
    }
    prevFlowRef.current = key;
  }, [view]);

  /* ---------- 情报落位 ---------- */
  useEffect(() => {
    if (!view) return;
    const prev = prevIntelRef.current;
    const next = new Map<string, Set<string>>();

    for (const p of view.players) {
      const uids = new Set(p.intel.map((s) => s.uid));
      next.set(p.id, uids);
      const before = prev.get(p.id);
      // 首次渲染不闪（否则一进对局所有已有情报都会亮一遍）
      if (!before) continue;
      for (const s of p.intel) {
        if (!before.has(s.uid)) {
          pulseLanding(playerCardEl(p.id), s.color);
          break;
        }
      }
    }
    prevIntelRef.current = next;
  }, [view]);

  /* ---------- 回合横幅 ---------- */
  useEffect(() => {
    if (!view) return;
    if (view.round > prevRoundRef.current) {
      prevRoundRef.current = view.round;
      if (view.round > 1) {
        setBanner({ round: view.round, show: true });
        const t = window.setTimeout(() => setBanner((b) => ({ ...b, show: false })), 1700);
        return () => window.clearTimeout(t);
      }
    }
  }, [view]);

  return { roundBanner: banner.show, bannerRound: banner.round };
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PACK } from '@data/pack';
import { applyCommand, botDecide, createGame, redactState } from '@core/index';
import type { Command, GameState } from '@core/types';
import type { RedactedState } from '@core/redact';

export type Mode = 'ai' | 'hotseat' | 'god';

export interface LocalGame {
  view: RedactedState | null;
  viewerId: string | null;
  mode: Mode;
  error: string | null;
  speed: number;
  setSpeed: (n: number) => void;
  start: (opts: { playerCount: number; mode: Mode }) => void;
  send: (cmd: Command) => void;
  reset: () => void;
  clearError: () => void;
  /** 是否轮到真人操作 */
  isMyTurn: boolean;
}

export function useLocalGame(): LocalGame {
  const [game, setGame] = useState<GameState | null>(null);
  const [mode, setMode] = useState<Mode>('ai');
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState(280);

  const start = useCallback((opts: { playerCount: number; mode: Mode }) => {
    setError(null);
    setMode(opts.mode);
    const players = Array.from({ length: opts.playerCount }, (_, i) => ({
      name: opts.mode === 'ai' ? (i === 0 ? '你' : `AI-${i}`) : `玩家 ${i + 1}`,
      /**
       * 上帝视角下**所有人都是 AI**。
       *
       * 这个模式原来把 `isBot` 一律设成 false，但 `viewerId` 又是 null
       * （`redactState` 用 null 表示全公开），于是：
       *   - `isMyTurn = pending.player === viewerId` 恒为 false ⇒ 没有操作面板
       *   - 下面那个 AI effect 的 `if (!actor?.isBot) return` 也恒为真 ⇒ 没有 AI 代打
       * 两条路都堵死，第一个 pending（选角）永远没人应答。实测 5 人局：
       * t=1s 与 t=9s 的状态完全一致（第 1 轮 / 等待：玩家 1 / 5 张卡全「待选角色」），
       * 而模式文案写着「用来观察规则流程与调试」—— 一个永远停在第一步的流程。
       *
       * 让它全 AI 之后，这个模式才真的等于「看一局自动打完、并且什么都看得见」。
       */
      isBot: opts.mode === 'ai' ? i > 0 : opts.mode === 'god',
    }));
    try {
      setGame(createGame({ pack: PACK, players }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const reset = useCallback(() => {
    setGame(null);
    setError(null);
  }, []);

  const send = useCallback(
    (cmd: Command) => {
      setGame((prev) => {
        if (!prev) return prev;
        const res = applyCommand(prev, PACK, cmd);
        if (res.error) {
          setError(res.error);
          return prev;
        }
        setError(null);
        return res.state;
      });
    },
    [],
  );

  // AI 自动行动
  useEffect(() => {
    if (!game || game.winner) return;
    const pending = game.pending;
    if (!pending || pending.kind === 'gameOver') return;
    const actor = game.players.find((p) => p.id === pending.player);
    if (!actor?.isBot) return;

    const timer = setTimeout(() => {
      const cmd = botDecide(game, PACK);
      if (!cmd) {
        console.error('[AbS] AI 没有可用操作', game.pending, game.phase);
        setError('AI 没有可用操作，对局已暂停（请把这条日志反馈给开发者）。');
        return;
      }
      const res = applyCommand(game, PACK, cmd);
      if (res.error) {
        console.error('[AbS] AI 指令被拒', cmd, res.error, game.pending, game.phase);
        setError(`AI 指令被拒：${res.error}`);
        return;
      }
      setGame(res.state);
    }, speed);
    return () => clearTimeout(timer);
  }, [game, speed]);

  const viewerId = useMemo<string | null>(() => {
    if (mode === 'god') return null;
    if (mode === 'ai') return 'p0';
    if (!game) return 'p0';
    const p = game.pending;
    if (p && p.kind !== 'gameOver') return p.player;
    return 'p0';
  }, [mode, game]);

  const view = useMemo(
    () => (game ? redactState(game, PACK, viewerId) : null),
    [game, viewerId],
  );

  const isMyTurn = Boolean(
    view && view.pending && view.pending.player === viewerId && !view.winner,
  );

  return {
    view,
    viewerId,
    mode,
    error,
    speed,
    setSpeed,
    start,
    send,
    reset,
    clearError: () => setError(null),
    isMyTurn,
  };
}

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
      isBot: opts.mode === 'ai' ? i > 0 : false,
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

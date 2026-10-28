/**
 * 卡牌飞行 —— 用 Web Animations API + 克隆节点，零依赖
 *
 * 为什么不用 React 渲染幽灵元素：
 *  飞行是「一次性、50 毫秒级、不参与状态」的视觉效果。放进 React 会引发
 *  额外的 render + 每帧 setState，而且动画中途组件卸载还要善后。
 *  直接操作 DOM、动画结束自删，最简单也最不容易出 bug。
 */

const FLY_MS = 520;

export interface FlyOptions {
  from: HTMLElement;
  to: HTMLElement;
  /** 情报颜色；null = 牌面朝下（暗牌） */
  color: 'red' | 'blue' | 'black' | null;
  /** 传递方式，显示在幽灵卡上 */
  methodLabel: string;
  duration?: number;
}

/** 从 from 元素飞到 to 元素，落点缩放成目标尺寸 */
export function flyCard(opts: FlyOptions): void {
  if (typeof document === 'undefined') return;
  const { from, to, color, methodLabel } = opts;
  const duration = opts.duration ?? FLY_MS;

  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return;

  const ghost = document.createElement('div');
  ghost.className = `fly-card ${color ?? 'unknown'}`;
  ghost.style.left = `${a.left}px`;
  ghost.style.top = `${a.top}px`;
  ghost.style.width = `${Math.min(a.width, 120)}px`;
  ghost.style.height = `${Math.min(a.height, 72)}px`;

  const bar = document.createElement('i');
  bar.className = 'fly-bar';
  ghost.appendChild(bar);

  const label = document.createElement('span');
  label.className = 'fly-label';
  label.textContent = methodLabel;
  ghost.appendChild(label);

  document.body.appendChild(ghost);

  // 从源卡片中心 → 目标卡片中心
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const scale = Math.max(0.3, Math.min(0.9, b.width / Math.max(a.width, 1)));

  let anim: Animation | null = null;
  try {
    anim = ghost.animate(
      [
        { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1, offset: 0 },
        // 中途上抛，让「传递」有弧线感
        {
          transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 46}px) scale(${(1 + scale) / 2}) rotate(-10deg)`,
          opacity: 1,
          offset: 0.55,
        },
        {
          transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(0deg)`,
          opacity: 0.05,
          offset: 1,
        },
      ],
      { duration, easing: 'cubic-bezier(.34,.72,.32,1)', fill: 'forwards' },
    );
  } catch {
    // 老浏览器不支持 WAAPI：直接清理，不做动画
    ghost.remove();
    return;
  }

  const cleanup = () => {
    ghost.remove();
  };
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
  // 兜底：标签页切后台时动画可能被暂停，别让幽灵卡永远挂在屏幕上
  window.setTimeout(cleanup, duration + 800);
}

/** 情报落位：目标玩家卡短暂高亮 */
export function pulseLanding(el: HTMLElement | null, color: 'red' | 'blue' | 'black' | null): void {
  if (!el) return;
  el.classList.remove('landing');
  // 强制回流，让同一个类名能重新触发动画
  void el.offsetWidth;
  el.classList.add('landing');
  el.dataset.landingColor = color ?? 'unknown';
  window.setTimeout(() => el.classList.remove('landing'), 700);
}

/** 查询玩家卡元素 */
export function playerCardEl(playerId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.pcard[data-player-id="${playerId}"]`);
}

/**
 * 横屏布局的公共判据：「给右栏留了宽度，就必须有东西占着」。
 *
 * 横屏（844×390 这类手机横放）的做法是 `.battle-main { padding-right: 332px }`
 * 把右边 320px 让给固定栏：操作区 / 观战面板在上面，日志在右下角。
 *
 * 这套布局出过三次同一个 bug —— **某个状态下那个位置没有组件**，
 * 于是牌板被白挤掉 320px，看起来「右边空空的」：
 *   1. 选角面板（和操作区共用右栏，2 列排 2 行还要滚 67px）
 *   2. 观战面板（右栏空着，面板被挤到 y=666，屏高只有 390）
 *   3. 结算浮层（卡片 352px 高塞进 330px 视口，上下各裁 11px）
 *
 * 所以判据不认具体类名：遍历 `.battle-main` 的直接子元素和 `.battle-side`，
 * 看有没有哪一块真的盖住了最右侧那 320px。以后再加新面板，忘了挪就会红。
 *
 * 两个坑写在这里，别再踩：
 * - **只能用视口尺寸判断横屏，不能用元素几何**（width > height 连桌面 1440×900 都命中，
 *   那里 padding-right=0，断言就变成「没留右栏 → 通过」的空断言）。
 * - **「没留右栏」不能算通过**。横屏却没留宽度，是布局没生效（真问题），
 *   必须单独报出来，否则这条断言在别的视口上会靠 applicable=false 悄悄变绿。
 */
import type { Page } from 'playwright';

/** 手机横放：宽度大于高度且很矮。横屏布局只对这一类生效。 */
export const isSidewaysSize = (width: number, height: number): boolean =>
  width > height && height < 520;

export interface RightColumnState {
  /** `.battle-main` 的 padding-right，横屏应为 332。 */
  reserved: number;
  /** 是否给右栏留了宽度。false = 横屏布局没生效，本身就是失败。 */
  applicable: boolean;
  /** 右栏那 320px 是否有子元素真的盖住。 */
  covered: boolean;
  /** 占位者的类名（前两个），用于失败时指出是谁。 */
  who: string;
}

export async function rightColumnState(p: Page): Promise<RightColumnState> {
  return p.evaluate(`(() => {
    const main = document.querySelector('.battle-main');
    if (!main) return { reserved: 0, applicable: false, covered: false, who: '无 battle-main' };
    const reserved = Math.round(parseFloat(getComputedStyle(main).paddingRight) || 0);
    if (reserved < 300) return { reserved, applicable: false, covered: false, who: '没留右栏' };
    const vw = window.innerWidth;
    const left = vw - 320;
    const nodes = [...main.children, document.querySelector('.battle-side')];
    let who = '';
    let covered = false;
    for (const n of nodes) {
      if (!n) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 200 || r.height < 80) continue;
      if (r.left <= left + 2 && r.right >= vw - 2) {
        covered = true;
        who = String(n.className).split(' ').slice(0, 2).join('.');
        break;
      }
    }
    return { reserved, applicable: true, covered, who };
  })()`) as Promise<RightColumnState>;
}

/** 统一判据与文案：横屏没留宽度 = 失败；留了没人占 = 失败。 */
export function rightColumnVerdict(rc: RightColumnState): { ok: boolean; detail: string } {
  if (!rc.applicable) {
    return { ok: false, detail: `横屏没给右栏留宽度（padding-right=${rc.reserved}px）` };
  }
  return { ok: rc.covered, detail: `预留 ${rc.reserved}px / 占用者 ${rc.who || '无'}` };
}

/**
 * jsdom 只用于本地测试脚本（scripts/ui-interaction.tsx），
 * 不引入 @types/jsdom 以免多一个依赖，这里给出用到的最小声明。
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    pretendToBeVisual?: boolean;
    [key: string]: unknown;
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}

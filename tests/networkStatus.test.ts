import { describe, test, expect } from 'bun:test';
import { getIsOnline } from '../src/shared/hooks/useNetworkStatus';

/**
 * E1 基础件：useNetworkStatus / getIsOnline
 * bun 运行环境（无 navigator 或 navigator.onLine 存在）下做模块级验证；
 * online/offline 事件的实时同步逻辑依赖浏览器事件循环，真机/浏览器行为由人工回归覆盖。
 */
describe('getIsOnline（E1 网络状态基础件）', () => {
  test('非浏览器环境（无 navigator）恒返回 true，不误拦', () => {
    const g = globalThis as { navigator?: unknown };
    const original = g.navigator;
    // @ts-expect-error 模拟非浏览器环境
    delete g.navigator;
    try {
      expect(getIsOnline()).toBe(true);
    } finally {
      (g as { navigator: unknown }).navigator = original;
    }
  });

  test('浏览器环境下跟随 navigator.onLine 返回布尔值', () => {
    const expected = typeof navigator === 'undefined' ? true : navigator.onLine;
    expect(getIsOnline()).toBe(expected);
  });
});

import type { FloatingLyricsPlugin, ShowOptions, UpdateOptions } from './definitions';

/**
 * Web fallback：浏览器环境不支持桌面悬浮窗，仅打印日志。
 * 真机 Capacitor 运行时会自动替换为原生实现。
 */
export class FloatingLyricsWeb implements FloatingLyricsPlugin {
  async show(options: ShowOptions): Promise<void> {
    console.warn('[FloatingLyrics] Web fallback: show called but not supported in browser', options);
  }

  async update(options: UpdateOptions): Promise<void> {
    console.warn('[FloatingLyrics] Web fallback: update called but not supported in browser', options);
  }

  async hide(): Promise<void> {
    console.warn('[FloatingLyrics] Web fallback: hide called but not supported in browser');
  }

  async isShowing(): Promise<{ showing: boolean }> {
    return { showing: false };
  }
}

import FloatingLyrics from '@plugins/floating-lyrics';
import { playerEngine } from './index';
import { usePlayerStore } from '@shared/store/playerStore';
import { useSettingsStore } from '@shared/store/settingsStore';
import { lyricsManager } from '@modules/music/lyrics';
import { debugLogger } from '@shared/utils/debugLogger';
import type { ParsedLyrics } from '@modules/music/lyrics';

/**
 * 桌面悬浮歌词桥接器
 * 职责：
 * 1. 监听播放进度，驱动悬浮歌词文字更新
 * 2. 监听设置开关，控制悬浮窗显隐
 * 3. 监听切歌，更新歌曲元信息
 * 4. 不侵入播放器核心，仅订阅 store / engine 事件
 *
 * 注意：Android 真机上悬浮窗权限需用户手动授权；
 * Web/无权限时插件自动降级为 no-op。
 */
class FloatingLyricsBridge {
  private unsubProgress?: () => void;
  private unsubSettings?: () => void;
  private unsubStateChange?: () => void;
  private currentLyrics: ParsedLyrics | null = null;
  private lastLineIndex = -1;
  private enabled = false;
  private isShowing = false;
  private currentTrackId: string | null = null;
  // v29-A5: 上一次跨桥发送的文本 —— 文本未变化不重复 update，消除 IPC 倾泻
  private lastText = '';

  /** 启动桥接（App 启动时调用一次） */
  start(): void {
    this.stop();

    // 1. 订阅设置变化
    this.enabled = useSettingsStore.getState().enableFloatingLyrics ?? false;
    this.unsubSettings = useSettingsStore.subscribe((state) => {
      const next = state.enableFloatingLyrics ?? false;
      if (next !== this.enabled) {
        this.enabled = next;
        if (this.enabled) {
          void this.tryShow();
        } else {
          void this.hide();
        }
      }
    });

    // 2. 订阅播放器状态变化（切歌时更新歌曲信息）
    this.unsubStateChange = playerEngine.on('stateChange', ({ track }) => {
      if (!track) {
        this.currentTrackId = null;
        this.currentLyrics = null;
        this.lastLineIndex = -1;
        this.lastText = '';
        if (this.enabled) {
          // v29-A5: 停止播放时清屏 —— updateText 已支持空文本
          void this.updateText('');
        }
        return;
      }
      if (track.id !== this.currentTrackId) {
        this.currentTrackId = track.id;
        this.lastLineIndex = -1;
        this.lastText = '';
        // v29-A5: 歌词竞态防护 —— 记录发起请求时的曲目 id，快速切歌后迟到的
        // 旧歌词响应直接丢弃（否则悬浮窗显示上一首的词）
        const reqTrackId = track.id;
        // 尝试加载歌词
        void lyricsManager.getLyrics(track.sourceSongId, track.sourceId).then((parsed) => {
          if (reqTrackId !== this.currentTrackId) return;
          this.currentLyrics = parsed;
          if (this.enabled) {
            void this.tryShow();
          }
        });
      }
    });

    // 3. 订阅进度变化（驱动歌词更新）
    this.unsubProgress = playerEngine.on('progress', ({ currentTime }) => {
      if (!this.enabled || !this.isShowing) return;

      let text = '';
      if (this.currentLyrics) {
        const idx = lyricsManager.getCurrentLineIndex(this.currentLyrics, currentTime);
        // v29-A5: 仅行变化时才产生文本 —— 旧实现行未变化也重发同一行文本，
        // 每 progress tick 一次跨桥 IPC，造成 IPC 倾泻
        if (idx >= 0 && idx !== this.lastLineIndex) {
          this.lastLineIndex = idx;
          text = this.currentLyrics.lines[idx].text;
        }
      } else {
        // 无歌词时显示歌曲名（lastText 去重保证只发送一次）
        const track = usePlayerStore.getState().currentTrack;
        text = track ? `${track.title} - ${track.artist || '未知歌手'}` : '音流';
      }

      if (text !== this.lastText) {
        this.lastText = text;
        void this.updateText(text);
      }
    });

    // 若启动时已启用，尝试显示
    if (this.enabled) {
      void this.tryShow();
    }

    debugLogger.info('player', '[FloatingLyrics] Bridge started', { enabled: this.enabled });
  }

  /** 停止桥接 */
  stop(): void {
    this.unsubProgress?.();
    this.unsubSettings?.();
    this.unsubStateChange?.();
    this.unsubProgress = undefined;
    this.unsubSettings = undefined;
    this.unsubStateChange = undefined;
    void this.hide();
    debugLogger.info('player', '[FloatingLyrics] Bridge stopped');
  }

  private async tryShow(): Promise<void> {
    const track = usePlayerStore.getState().currentTrack;
    if (!track) return;

    try {
      const text = this.currentLyrics?.lines[0]?.text
        || `${track.title} - ${track.artist || '未知歌手'}`;

      await FloatingLyrics.show({
        text,
        title: track.title,
        artist: track.artist,
        draggable: true,
      });
      this.isShowing = true;
      this.lastText = text; // v29-A5: 与悬浮窗实际内容对齐，避免重复/漏发
      debugLogger.info('player', '[FloatingLyrics] Show', { title: track.title });
    } catch (err) {
      // 权限不足或原生层异常，静默降级
      debugLogger.warn('player', '[FloatingLyrics] Show failed (likely no permission)', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.isShowing = false;
    }
  }

  private async updateText(text: string): Promise<void> {
    // v29-A5: 支持空文本清屏（停止播放时把悬浮窗文字清空）；原生侧
    // FloatingLyricsPlugin.update 对空串照常处理
    try {
      await FloatingLyrics.update({ text });
    } catch (err) {
      debugLogger.warn('player', '[FloatingLyrics] Update failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async hide(): Promise<void> {
    if (!this.isShowing) return;
    try {
      await FloatingLyrics.hide();
      this.isShowing = false;
    } catch (err) {
      debugLogger.warn('player', '[FloatingLyrics] Hide failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const floatingLyricsBridge = new FloatingLyricsBridge();

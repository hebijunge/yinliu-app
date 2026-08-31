/**
 * 系统通知栏媒体控制 / 锁屏显示 / 后台播放保活 集成模块
 *
 * 核心职责：
 * - 通过 @jofr/capacitor-media-session 把当前曲目元数据同步到系统媒体会话
 * - 注册通知栏 / 锁屏的播放控制（play/pause/prev/next/seek）
 * - 周期性把播放进度同步到系统（更新进度条）
 * - 在播放状态变化时通知系统显示或隐藏媒体卡片
 *
 * 兼容性：
 * - Android：通过插件的 Foreground Service 保活音频后台播放
 * - iOS / Web：插件退化为 Web MediaSession API，行为与浏览器一致
 * - 在非 Capacitor 平台（纯 Web/Tauri）：自动降级，仅使用 Web MediaSession
 * - 插件未安装时（开发期 / CI 首次同步前）：自动降级到 Web MediaSession
 */
import { Capacitor } from '@capacitor/core';

interface MediaSessionPluginShape {
  setMetadata(options: {
    title: string;
    artist: string;
    album?: string;
    artwork?: Array<{ src: string; sizes?: string; type?: string }>;
  }): Promise<void>;
  setPlaybackState(options: {
    playbackState: 'none' | 'paused' | 'playing';
  }): Promise<void>;
  setActionHandler(
    options: { action: string; enabled?: boolean },
    handler: ((details: { action: string; seekTime: number | null }) => void) | null
  ): Promise<void>;
  setPositionState(options: {
    duration: number;
    playbackRate?: number;
    position: number;
  }): Promise<void>;
}

type ActionHandler = (details: { action: string; seekTime: number | null }) => void;

const handlers: Record<string, ActionHandler | null> = {
  play: null,
  pause: null,
  previoustrack: null,
  nexttrack: null,
  seekbackward: null,
  seekforward: null,
  seekto: null,
  stop: null,
};

let pluginInstance: MediaSessionPluginShape | null = null;
let nativeMediaSession: any | null = null;
let positionSyncInterval: number | null = null;
let isInitialized = false;
let lastNotifiedPlaybackState: 'none' | 'paused' | 'playing' = 'none';

function getPlugin(): MediaSessionPluginShape | null {
  if (pluginInstance) return pluginInstance;
  try {
    // 动态 require：避免静态导入在插件包缺失时直接抛错
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req: any = (typeof require !== 'undefined' ? require : null);
    let mod: any = null;
    if (req) {
      try {
        mod = req('@jofr/capacitor-media-session');
      } catch {
        mod = null;
      }
    }
    if (!mod) {
      pluginInstance = null;
      return null;
    }
    const candidate = (mod && (mod.MediaSession || mod.default || mod)) || null;
    if (!candidate || typeof candidate.setMetadata !== 'function') {
      pluginInstance = null;
      return null;
    }
    pluginInstance = candidate as MediaSessionPluginShape;
    return pluginInstance;
  } catch (err) {
    pluginInstance = null;
    return null;
  }
}

function getNativeMediaSession(): any | null {
  if (typeof navigator === 'undefined') return null;
  if (nativeMediaSession !== null) return nativeMediaSession;
  nativeMediaSession = (navigator as any).mediaSession || null;
  return nativeMediaSession;
}

/**
 * 初始化媒体会话：注册 action handlers，并把回调转交给上层
 *
 * @param dispatch 收到通知栏/锁屏/硬件按键事件时调用的分发函数
 *                 参数为标准 MediaSession action 名（play/pause/previoustrack/...）
 */
export async function initMediaSession(dispatch: (action: string, details: { seekTime: number | null }) => void): Promise<void> {
  if (isInitialized) return;
  isInitialized = true;

  const plugin = getPlugin();
  const isNative = Capacitor.isNativePlatform();
  const isAndroid = Capacitor.getPlatform() === 'android';

  for (const action of Object.keys(handlers)) {
    const fn: ActionHandler = (details) => dispatch(action, { seekTime: details?.seekTime ?? null });
    handlers[action] = fn;
    if (plugin) {
      try {
        await plugin.setActionHandler({ action, enabled: true }, fn);
      } catch (err) {
        // 部分 action 在某些平台不支持，逐个失败不阻塞整体
        console.warn(`[mediaSession] setActionHandler(${action}) failed:`, err);
      }
    }
  }

  // iOS / Web：使用浏览器内置 MediaSession，作为兜底
  if (!isNative || !isAndroid) {
    const ns = getNativeMediaSession();
    if (ns) {
      try {
        ns.setActionHandler('play', () => dispatch('play', { seekTime: null }));
        ns.setActionHandler('pause', () => dispatch('pause', { seekTime: null }));
        ns.setActionHandler('previoustrack', () => dispatch('previoustrack', { seekTime: null }));
        ns.setActionHandler('nexttrack', () => dispatch('nexttrack', { seekTime: null }));
        ns.setActionHandler('seekbackward', (d: any) => dispatch('seekbackward', { seekTime: d?.seekTime ?? null }));
        ns.setActionHandler('seekforward', (d: any) => dispatch('seekforward', { seekTime: d?.seekTime ?? null }));
        ns.setActionHandler('seekto', (d: any) => dispatch('seekto', { seekTime: d?.seekTime ?? null }));
        ns.setActionHandler('stop', () => dispatch('stop', { seekTime: null }));
      } catch (err) {
        console.warn('[mediaSession] native mediaSession setActionHandler failed:', err);
      }
    }
  }
}

/** 同步当前曲目的元数据到系统媒体会话 */
export async function updateMetadata(meta: {
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
}): Promise<void> {
  const plugin = getPlugin();
  const artwork = meta.artwork
    ? [{ src: meta.artwork, sizes: '512x512', type: guessMime(meta.artwork) }]
    : undefined;

  if (plugin && Capacitor.getPlatform() === 'android') {
    try {
      await plugin.setMetadata({
        title: meta.title || '未知曲目',
        artist: meta.artist || '未知艺术家',
        album: meta.album || '',
        artwork,
      });
      return;
    } catch (err) {
      console.warn('[mediaSession] setMetadata (plugin) failed, fallback to web:', err);
    }
  }

  const ns = getNativeMediaSession();
  if (ns) {
    try {
      // 部分浏览器必须用 new MediaMetadata(...)；部分接受直接赋值
      const Ctor = (window as any).MediaMetadata;
      if (Ctor) {
        ns.metadata = new Ctor({
          title: meta.title || '未知曲目',
          artist: meta.artist || '未知艺术家',
          album: meta.album || '',
          artwork: artwork || [],
        });
      } else {
        ns.metadata = {
          title: meta.title || '未知曲目',
          artist: meta.artist || '未知艺术家',
          album: meta.album || '',
          artwork: artwork || [],
        };
      }
    } catch (err) {
      console.warn('[mediaSession] web setMetadata failed:', err);
    }
  }
}

function guessMime(url: string): string {
  const lower = url.toLowerCase().split('?')[0].split('#')[0];
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

/**
 * 同步播放状态到系统媒体会话
 * - playing: 显示通知栏媒体卡片（Android 上会启动 Foreground Service）
 * - paused / none: 通知栏卡片保留但显示暂停态
 */
export async function updatePlaybackState(state: 'playing' | 'paused' | 'none'): Promise<void> {
  if (state === lastNotifiedPlaybackState) return;
  lastNotifiedPlaybackState = state;

  const plugin = getPlugin();
  if (plugin && Capacitor.getPlatform() === 'android') {
    try {
      await plugin.setPlaybackState({ playbackState: state });
    } catch (err) {
      console.warn('[mediaSession] setPlaybackState (plugin) failed:', err);
    }
  }

  const ns = getNativeMediaSession();
  if (ns) {
    try {
      ns.playbackState = state;
    } catch (err) {
      // ignore
    }
  }
}

/** 同步播放进度；可被频繁调用，内部用节流避免抖动 */
let lastPositionSyncTs = 0;
export async function updatePosition(position: number, duration: number, playbackRate = 1): Promise<void> {
  const now = Date.now();
  if (now - lastPositionSyncTs < 500) return;
  lastPositionSyncTs = now;
  if (!isFinite(position) || !isFinite(duration) || duration <= 0) return;

  const plugin = getPlugin();
  if (plugin && Capacitor.getPlatform() === 'android') {
    try {
      await plugin.setPositionState({
        duration: Math.max(duration, 0.001),
        playbackRate,
        position: Math.max(position, 0),
      });
    } catch (err) {
      // ignore
    }
  }

  const ns = getNativeMediaSession();
  if (ns && typeof ns.setPositionState === 'function') {
    try {
      ns.setPositionState({ duration, playbackRate, position });
    } catch (err) {
      // ignore
    }
  }
}

/**
 * 开启周期进度同步：把 PlayerEngine 的进度定期推送到系统
 * 避免在每个 progress 事件都触发 setPositionState（频繁 IPC）
 */
export function startPositionSync(getter: () => { currentTime: number; duration: number }): void {
  stopPositionSync();
  if (typeof window === 'undefined') return;
  positionSyncInterval = window.setInterval(() => {
    const { currentTime, duration } = getter();
    void updatePosition(currentTime, duration);
  }, 1000);
}

export function stopPositionSync(): void {
  if (positionSyncInterval !== null && typeof window !== 'undefined') {
    window.clearInterval(positionSyncInterval);
    positionSyncInterval = null;
  }
}

/**
 * 主动停止媒体会话（清除通知、退出 Foreground Service）
 * - 在用户停止播放且队列清空时可调用
 */
export async function clearMediaSession(): Promise<void> {
  stopPositionSync();
  await updatePlaybackState('none');
  await updateMetadata({ title: '', artist: '', album: '', artwork: '' });
  const ns = getNativeMediaSession();
  if (ns) {
    try {
      ns.metadata = null;
    } catch (err) {
      // ignore
    }
  }
}

import { Routes, Route } from 'react-router-dom';
import { useEffect, useState, lazy, Suspense } from 'react';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import Layout from './components/layout/Layout';
import SearchPage from './pages/SearchPage';
import { Skeleton, SkeletonText } from './components/ui/Skeleton';
import { scheduleIdle } from './shared/utils/idle';

// v16: 非核心页面懒加载，减少首屏 bundle
const PlaylistPage = lazy(() => import('./pages/PlaylistPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const ZonePage = lazy(() => import('./pages/ZonePage'));
const LibraryPage = lazy(() => import('./pages/LibraryPage'));
const MinePage = lazy(() => import('./pages/MinePage'));
const LocalMusicPage = lazy(() => import('./pages/LocalMusicPage'));
const DownloadPage = lazy(() => import('./pages/DownloadPage'));
const ReadingPage = lazy(() => import('./pages/ReadingPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const EqPage = lazy(() => import('./pages/EqPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const DebugLogPage = lazy(() => import('./pages/DebugLogPage'));
// v21.0 整合：榜单聚合 / 歌单聚合（固定分类口径） / 独立视频播放页
const ChartPage = lazy(() => import('./pages/ChartPage'));
const PlaylistAggregationPage = lazy(() => import('./pages/PlaylistAggregationPage'));
const VideoPlayerPage = lazy(() => import('./pages/VideoPlayerPage'));
// 歌单收藏页
const FavoritePlaylistsPage = lazy(() => import('./pages/FavoritePlaylistsPage'));

// P11 Tab 白闪治理：四个高频 Tab 的路由 chunk 在首挂载后 idle 预取，
// 切 Tab 时 chunk 已在缓存，白闪源（chunk 网络加载）消失。
const HIGH_FREQ_ROUTE_PREFETCH: Array<() => Promise<unknown>> = [
  () => import('./pages/HomePage'),
  () => import('./pages/LibraryPage'),
  () => import('./pages/ZonePage'),
  () => import('./pages/MinePage'),
];
import { playerEngine } from './core/player';
import { downloadEngine } from './core/download';
import { useUiStore } from './shared/store/uiStore';
import { notifyDownloadDone, notifyDownloadFailed } from './shared/utils/notify';
import { usePlayerStore } from './shared/store/playerStore';
import { useDownloadStore } from './shared/store/downloadStore';
import { usePlaylistStore } from './shared/store/playlistStore';
import { usePlayHistoryStore } from './shared/store/playHistoryStore';
import { useFavoritePlaylistStore } from './shared/store/favoritePlaylistStore';
import { useSettingsStore } from './shared/store/settingsStore';
import { configureAudioFocus, updateAudioFocusOptions } from './core/player/audioFocus';
import { floatingLyricsBridge } from './core/player/floatingLyricsBridge';
import { initDatabase } from './shared/database';
import { toast } from './shared/components/Toast';

/**
 * v23 修复走查 #7：启动遮罩。
 * 旧实现（main.tsx LoadingScreen）固定 1400ms 才开始淡出 —— 冷启动人为等待约 2 秒。
 * 现在遮罩跟随 App 内部数据库初始化：initDatabase 完成（成功或失败）后立即淡出 500ms。
 */
function BootOverlay({ visible }: { visible: boolean }) {
  const [render, setRender] = useState(visible);
  useEffect(() => {
    if (!visible) {
      const tm = window.setTimeout(() => setRender(false), 500);
      return () => window.clearTimeout(tm);
    }
    setRender(true);
  }, [visible]);
  if (!render) return null;
  return (
    <div
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--bg-primary)] transition-opacity duration-500 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <svg className="w-14 h-14 mb-8 text-[var(--accent)]" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="6" y="6" width="52" height="52" rx="18" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        <path d="M24 46V22l20-4v20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="20" cy="46" r="5" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="40" cy="42" r="5" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
      <h1 className="text-3xl font-light tracking-[0.2em] mb-3 text-[var(--text-primary)]">音流</h1>
      <p className="text-sm text-[var(--text-tertiary)] tracking-widest font-light">多音源聚合音乐播放器</p>
    </div>
  );
}

/**
 * P11 Tab 白闪治理：路由懒加载期间的骨架屏 fallback。
 * 替换原空白转圈 —— 固定结构占位避免布局塌陷，视觉上与页面骨架连续，
 * 消除切 Tab 时的白闪/白屏观感。
 */
function RouteFallback() {
  return (
    <div className="p-5 space-y-5" aria-busy="true" aria-label="页面加载中">
      <div className="space-y-2">
        <Skeleton className="h-7 w-36" />
        <SkeletonText lines={1} className="w-24" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="w-full aspect-square rounded-2xl" />
            <SkeletonText lines={1} className="w-3/4" />
          </div>
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="w-12 h-12 rounded-lg flex-shrink-0" />
            <div className="flex-1 space-y-1.5">
              <SkeletonText lines={1} className="w-2/3" />
              <SkeletonText lines={1} className="w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [booting, setBooting] = useState(true);

  // P11: 首挂载后 idle 预取四个高频 Tab 的路由 chunk（已加载的 import() 直接返回缓存）
  useEffect(() => {
    scheduleIdle(() => {
      HIGH_FREQ_ROUTE_PREFETCH.forEach((prefetch) => {
        void prefetch().catch(() => {
          /* 预取失败静默：用户切到该 Tab 时仍走正常懒加载 */
        });
      });
    });
  }, []);

  // 启动时同步车机模式到 body class
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (useSettingsStore.getState().carMode) {
      document.body.classList.add('car-mode');
    } else {
      document.body.classList.remove('car-mode');
    }
  }, []);

  // Android 物理返回键：优先收起全屏播放页，其次路由回退，主界面无历史时保持系统默认（退出应用）
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: PluginListenerHandle | null = null;
    let disposed = false;
    CapApp.addListener('backButton', (event) => {
      // 1) 侧边抽屉打开时：先关闭抽屉（v23 修复走查 #17）
      if (useUiStore.getState().sidebarOpen) {
        useUiStore.getState().setSidebarOpen(false);
        return;
      }
      // 2) 全屏播放页打开时：收起播放页回到主界面（收起为迷你条），不退出应用
      if (usePlayerStore.getState().fullscreenOpen) {
        usePlayerStore.getState().setFullscreenOpen(false);
        return;
      }
      // 3) 处于子页面且有路由历史：正常回退上一页
      if (event.canGoBack) {
        window.history.back();
        return;
      }
      // 4) 已在主界面且无历史：遵循系统默认行为（退出应用）
      void CapApp.exitApp();
    })
      .then((h) => {
        if (disposed) void h.remove();
        else handle = h;
      })
      .catch((err) => console.error('[App] backButton listener failed:', err));
    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, []);

  useEffect(() => {
    // P1 冷启动：initDatabase 完成即刻淡出启动遮罩（首帧不等非关键数据），
    // 下载任务/歌单/历史/收藏的恢复全部延后到 idle（首帧之后）异步进行。
    initDatabase().then(() => {
      console.log('[App] Database initialized');
      setBooting(false);

      // 非关键数据恢复：idle 回调中并行 fire-and-forget，各自独立兜错，
      // 任一失败不阻塞其他恢复，也不影响首页可交互
      scheduleIdle(() => {
        // 恢复下载任务列表
        downloadEngine.restoreTasks()
          .then(() => {
            const tasks = downloadEngine.getTasks();
            useDownloadStore.getState().setTasks(tasks);
          })
          .catch((err) => console.error('[App] restore download tasks failed:', err));

        // 从数据库加载歌单与收藏
        usePlaylistStore.getState().loadPlaylists().catch((err) => console.error('[App] load playlists failed:', err));
        usePlaylistStore.getState().loadFavorites().catch((err) => console.error('[App] load favorites failed:', err));

        // 加载播放历史
        usePlayHistoryStore.getState().loadRecords().catch((err) => console.error('[App] load play history failed:', err));

        // 加载收藏歌单
        useFavoritePlaylistStore.getState().loadItems().catch((err) => console.error('[App] load favorite playlists failed:', err));
      });
    }).catch((err) => {
      console.error('[App] Database initialization failed, falling back to memory mode:', err);
      setBooting(false);
    });

    // E1: 下载引擎断网兜底 —— 断网自动暂停全部任务（引擎内监听），此处接入提示、store 标志与恢复入口
    const unsubOffline = downloadEngine.on('offline', ({ pausedCount }) => {
      useDownloadStore.getState().setOfflinePaused(true);
      toast.info('网络已断开', `${pausedCount} 个下载任务已自动暂停，恢复网络后可一键继续`);
    });
    const unsubOfflineRecovered = downloadEngine.on('offlineRecovered', () => {
      toast.info('网络已恢复', '下载任务可一键继续');
    });

    // 初始化媒体会话（通知栏 / 锁屏 / 硬件按键控制）
    void playerEngine.initMediaSessionBridge();

    // 初始化音频焦点管理（让设置项即时生效）
    const s = useSettingsStore.getState();
    configureAudioFocus(playerEngine, { autoResumeOnFocusGain: s.autoResumeOnAudioFocus });
    const unsubSettings = useSettingsStore.subscribe((state) => {
      updateAudioFocusOptions({ autoResumeOnFocusGain: state.autoResumeOnAudioFocus });
    });

    // 初始化桌面悬浮歌词桥接（Android 真机生效，Web 端为 no-op）
    floatingLyricsBridge.start();

    // 绑定播放器事件到 Store
    const unsub1 = playerEngine.on('stateChange', ({ state, track }) => {
      usePlayerStore.getState().setState(state);
      if (track) {
        usePlayerStore.getState().setTrack(track);
      }
    });
    const unsub2 = playerEngine.on('progress', ({ currentTime, duration }) => {
      usePlayerStore.getState().setProgress(currentTime, duration);
    });
    const unsub3 = playerEngine.on('ended', () => {
      // 自动播放下一首（按当前播放模式）
      void playerEngine.playNext();
    });
    const unsub3b = playerEngine.on('trackLoaded', ({ track, result, actualSourceId }) => {
      usePlayerStore.getState().setTrack(track || null);
      usePlayerStore.getState().setActualSourceId(actualSourceId || null);
      usePlayerStore.getState().setActualQuality(result.quality);
      usePlayerStore.getState().setPreview(result.isPreview ?? false);
    });
    const unsub3c = playerEngine.on('mediaAction', ({ action }) => {
      console.log('[App] media action from system control:', action);
    });
    // v23: 播放失败统一 toast 提示（含播放中途失败）—— 此前 error 事件无人订阅，失败零提示
    const unsub3d = playerEngine.on('error', ({ message }) => {
      toast.error('播放失败', message || '播放中途出现错误，可点击重试');
    });
    // v23: 缓冲状态 → store（UI 显示缓冲指示器）
    const unsub3e = playerEngine.on('bufferingChange', ({ buffering }) => {
      usePlayerStore.getState().setBuffering(buffering);
    });

    // 绑定下载事件到 Store
    const unsub4 = downloadEngine.on('stateChange', ({ task }) => {
      // C-P0-7: 已取消任务不同步进 store（任务已被删除，同步会让已删任务在 UI 复活）
      if (task.status === 'cancelled') return;
      // engine 的 task 不带 speed（speed 只在 progress 事件里），如果直接 upsertTask(task)
      // 会把 store 里前一次 progress 写入的 speed 抹成 undefined。保留 speed 让 UI 还能显示。
      const prev = useDownloadStore.getState().tasks.find((t) => t.id === task.id);
      useDownloadStore.getState().upsertTask({
        ...task,
        ...(prev?.speed !== undefined ? { speed: prev.speed } : {}),
      });
    });
    const unsub5 = downloadEngine.on('progress', ({ taskId, progress, downloadedSize, totalSize, speed }) => {
      useDownloadStore.getState().updateTaskStatus(taskId, 'downloading', {
        progress,
        totalSize,
        speed,
        downloadedSize,
      });
    });
    const unsub6 = downloadEngine.on('completed', ({ taskId }) => {
      // 显式把 progress 置 1，兜底某些时序下 stateChange 的 progress 还没刷到 store
      useDownloadStore.getState().updateTaskStatus(taskId, 'completed', { progress: 1 });
      // v23 修复走查 #5：下载完成发系统通知（Web/Android 自适应，见 shared/utils/notify）
      const doneTask = useDownloadStore.getState().tasks.find((t) => t.id === taskId);
      void notifyDownloadDone(doneTask?.title || '新歌曲', doneTask?.artist);
    });
    const unsub7 = downloadEngine.on('failed', ({ taskId, error }) => {
      useDownloadStore.getState().updateTaskStatus(taskId, 'failed', {
        errorMessage: error,
      });
      // v23 修复走查 #5：下载失败发系统通知
      const failTask = useDownloadStore.getState().tasks.find((t) => t.id === taskId);
      void notifyDownloadFailed(failTask?.title || '歌曲', error);
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub3b();
      unsub3c();
      unsub3d();
      unsub3e();
      unsub4();
      unsub5();
      unsub6();
      unsub7();
      unsubOffline();
      unsubOfflineRecovered();
      unsubSettings();
      floatingLyricsBridge.stop();
    };
  }, []);

  return (
    <Layout>
      <BootOverlay visible={booting} />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/zone" element={<ZonePage />} />
          <Route path="/mine" element={<MinePage />} />
          <Route path="/local" element={<LocalMusicPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/playlists" element={<PlaylistPage />} />
            <Route path="/charts" element={<ChartPage />} />
            <Route path="/songlists" element={<PlaylistAggregationPage />} />
            <Route path="/favorite-playlists" element={<FavoritePlaylistsPage />} />
            <Route path="/video" element={<VideoPlayerPage />} />
          <Route path="/downloads" element={<DownloadPage />} />
          <Route path="/reading" element={<ReadingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/eq" element={<EqPage />} />
          <Route path="/debug" element={<DebugLogPage />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default App;

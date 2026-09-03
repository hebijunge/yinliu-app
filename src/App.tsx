import { Routes, Route } from 'react-router-dom';
import { useEffect, lazy, Suspense } from 'react';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import Layout from './components/layout/Layout';
import SearchPage from './pages/SearchPage';

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
import { playerEngine } from './core/player';
import { downloadEngine } from './core/download';
import { usePlayerStore } from './shared/store/playerStore';
import { useDownloadStore } from './shared/store/downloadStore';
import { usePlaylistStore } from './shared/store/playlistStore';
import { usePlayHistoryStore } from './shared/store/playHistoryStore';
import { useFavoritePlaylistStore } from './shared/store/favoritePlaylistStore';
import { useSettingsStore } from './shared/store/settingsStore';
import { configureAudioFocus, updateAudioFocusOptions } from './core/player/audioFocus';
import { floatingLyricsBridge } from './core/player/floatingLyricsBridge';
import { initDatabase } from './shared/database';

function App() {
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
      // 1) 全屏播放页打开时：收起播放页回到主界面（收起为迷你条），不退出应用
      if (usePlayerStore.getState().fullscreenOpen) {
        usePlayerStore.getState().setFullscreenOpen(false);
        return;
      }
      // 2) 处于子页面且有路由历史：正常回退上一页
      if (event.canGoBack) {
        window.history.back();
        return;
      }
      // 3) 已在主界面且无历史：遵循系统默认行为（退出应用）
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
    // 初始化数据库（支持从 IndexedDB 恢复）
    initDatabase().then(async () => {
      console.log('[App] Database initialized');

      // 恢复下载任务列表
      await downloadEngine.restoreTasks();
      const tasks = downloadEngine.getTasks();
      useDownloadStore.getState().setTasks(tasks);

      // 从数据库加载歌单
      await usePlaylistStore.getState().loadPlaylists();
      await usePlaylistStore.getState().loadFavorites();

      // 加载播放历史
      await usePlayHistoryStore.getState().loadRecords();

      // 加载收藏歌单
      await useFavoritePlaylistStore.getState().loadItems();
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

    // 绑定下载事件到 Store
    const unsub4 = downloadEngine.on('stateChange', ({ task }) => {
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
    });
    const unsub7 = downloadEngine.on('failed', ({ taskId, error }) => {
      useDownloadStore.getState().updateTaskStatus(taskId, 'failed', {
        errorMessage: error,
      });
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub3b();
      unsub3c();
      unsub4();
      unsub5();
      unsub6();
      unsub7();
      unsubSettings();
      floatingLyricsBridge.stop();
    };
  }, []);

  return (
    <Layout>
      <Suspense fallback={<div className="flex-1 flex items-center justify-center min-h-[50vh]"><div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" /></div>}>
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

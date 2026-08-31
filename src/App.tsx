import { Routes, Route, useLocation } from 'react-router-dom';
import { useEffect, useCallback, useRef } from 'react';
import Layout from './components/layout/Layout';
import SearchPage from './pages/SearchPage';
import PlaylistPage from './pages/PlaylistPage';
import DownloadPage from './pages/DownloadPage';
import ReadingPage from './pages/ReadingPage';
import SettingsPage from './pages/SettingsPage';
import HistoryPage from './pages/HistoryPage';
import DebugLogPage from './pages/DebugLogPage';
import { playerEngine } from './core/player';
import { downloadEngine } from './core/download';
import { usePlayerStore } from './shared/store/playerStore';
import { useDownloadStore } from './shared/store/downloadStore';
import { usePlaylistStore } from './shared/store/playlistStore';
import { usePlayHistoryStore } from './shared/store/playHistoryStore';
import { useSettingsStore } from './shared/store/settingsStore';
import { configureAudioFocus, updateAudioFocusOptions } from './core/player/audioFocus';
import { initDatabase } from './shared/database';
import { debugLogger } from './shared/utils/debugLogger';

function App() {
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);

  // 全局点击埋点（事件委托，capture 阶段统一拦截，覆盖所有可点击组件）
  const handleGlobalClick = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // 寻找最近的可交互元素
    const el = target.closest('button, a, [role="button"], input, select, textarea, [data-debug-click], label, [tabindex]:not([tabindex="-1"])');
    if (!el) return;

    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 40);
    const ariaLabel = el.getAttribute('aria-label') || '';
    const className = (el.className || '').toString().slice(0, 60);
    // 组件名优先取 data-debug-click，其次 aria-label，再其次 tag+text
    const componentName = el.getAttribute('data-debug-click')
      || ariaLabel
      || (text ? `${tag}:${text}` : tag);
    const route = location.pathname;

    debugLogger.info('click', `[${route}] 点击 ${componentName}`, {
      route,
      tag,
      componentName,
      text: text || undefined,
      ariaLabel: ariaLabel || undefined,
      className: className || undefined,
    });
  }, [location.pathname]);

  useEffect(() => {
    document.addEventListener('click', handleGlobalClick, true);
    return () => {
      document.removeEventListener('click', handleGlobalClick, true);
    };
  }, [handleGlobalClick]);

  // 路由跳转埋点
  useEffect(() => {
    const prev = prevPathRef.current;
    const curr = location.pathname;
    if (prev !== curr) {
      debugLogger.info('navigate', `路由跳转: ${prev} → ${curr}`, {
        from: prev,
        to: curr,
        search: location.search || undefined,
      });
      prevPathRef.current = curr;
    }
  }, [location]);

  useEffect(() => {
    debugLogger.info('init', '应用启动初始化');

    // 初始化数据库（支持从 IndexedDB 恢复）
    initDatabase().then(async () => {
      debugLogger.info('init', '数据库初始化完成');

      // 恢复下载任务列表
      await downloadEngine.restoreTasks();
      const tasks = downloadEngine.getTasks();
      useDownloadStore.getState().setTasks(tasks);
      debugLogger.info('init', `恢复 ${tasks.length} 条下载任务`);

      // 从数据库加载歌单
      await usePlaylistStore.getState().loadPlaylists();
      await usePlaylistStore.getState().loadFavorites();

      // 加载播放历史
      await usePlayHistoryStore.getState().loadRecords();
    });

    // 初始化媒体会话（通知栏 / 锁屏 / 硬件按键控制）
    void playerEngine.initMediaSessionBridge();

    // 初始化音频焦点管理（让设置项即时生效）
    const s = useSettingsStore.getState();
    configureAudioFocus(playerEngine, { autoResumeOnFocusGain: s.autoResumeOnAudioFocus });
    const unsubSettings = useSettingsStore.subscribe((state) => {
      updateAudioFocusOptions({ autoResumeOnFocusGain: state.autoResumeOnAudioFocus });
    });

    // 绑定播放器事件到 Store
    const unsub1 = playerEngine.on('stateChange', ({ state }) => {
      usePlayerStore.getState().setState(state);
    });
    const unsub2 = playerEngine.on('progress', ({ currentTime, duration }) => {
      usePlayerStore.getState().setProgress(currentTime, duration);
    });
    const unsub3 = playerEngine.on('ended', () => {
      // Auto-play next logic would go here
    });
    const unsub3b = playerEngine.on('trackLoaded', ({ track, actualSourceId }) => {
      usePlayerStore.getState().setActualSourceId(actualSourceId || null);
      debugLogger.info('player', `播放取链成功: ${track.title}`, {
        title: track.title,
        artist: track.artist,
        sourceId: actualSourceId,
      });
    });
    const unsub3c = playerEngine.on('mediaAction', ({ action }) => {
      debugLogger.info('player', `系统媒体控制: ${action}`);
    });
    const unsub3d = playerEngine.on('linkFallback', ({ fromSourceId, toSourceId, reason }) => {
      debugLogger.warn('player', `取链降级: ${fromSourceId} → ${toSourceId}`, {
        fromSourceId,
        toSourceId,
        reason,
      });
    });
    const unsub3e = playerEngine.on('error', ({ message }) => {
      debugLogger.error('player', `播放错误: ${message}`);
    });

    // 绑定下载事件到 Store
    const unsub4 = downloadEngine.on('stateChange', ({ task }) => {
      useDownloadStore.getState().upsertTask(task);
    });
    const unsub5 = downloadEngine.on('progress', ({ taskId, progress, downloadedSize, totalSize, speed }) => {
      useDownloadStore.getState().updateTaskStatus(taskId, 'downloading', {
        progress,
        totalSize,
      });
    });
    const unsub6 = downloadEngine.on('completed', ({ taskId }) => {
      useDownloadStore.getState().updateTaskStatus(taskId, 'completed');
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
      unsub3d();
      unsub3e();
      unsub4();
      unsub5();
      unsub6();
      unsub7();
      unsubSettings();
    };
  }, []);

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/playlists" element={<PlaylistPage />} />
        <Route path="/downloads" element={<DownloadPage />} />
        <Route path="/reading" element={<ReadingPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/debug-log" element={<DebugLogPage />} />
      </Routes>
    </Layout>
  );
}

export default App;

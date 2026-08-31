import { Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
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

function App() {
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
    const unsub3b = playerEngine.on('trackLoaded', ({ actualSourceId }) => {
      usePlayerStore.getState().setActualSourceId(actualSourceId || null);
    });
    const unsub3c = playerEngine.on('mediaAction', ({ action }) => {
      console.log('[App] media action from system control:', action);
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
        <Route path="/debug" element={<DebugLogPage />} />
      </Routes>
    </Layout>
  );
}

export default App;

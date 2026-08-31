import { Routes, Route } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import Layout from './components/layout/Layout';
import SearchPage from './pages/SearchPage';
import PlaylistPage from './pages/PlaylistPage';
import ReadingPage from './pages/ReadingPage';
import SettingsPage from './pages/SettingsPage';
import DjPage from './pages/DjPage';
import DownloadPage from './pages/DownloadPage';
import LocalMusicPage from './pages/LocalMusicPage';
import { playerEngine } from './core/player';
import { usePlayerStore } from './shared/store/playerStore';
import { useSettingsStore, isSourceEnabled } from './shared/store/settingsStore';
import { sourceRegistry } from './providers/music/registry';

function App() {
  useEffect(() => {
    // 播放器事件绑定（数据库和Provider已在main.tsx初始化）
    const unsub1 = playerEngine.on('stateChange', ({ state, index }) => {
      usePlayerStore.getState().setState(state);
      if (typeof index === 'number') {
        usePlayerStore.getState().playTrackAtIndex(index);
      }
    });
    const unsub2 = playerEngine.on('progress', ({ currentTime, duration }) => {
      usePlayerStore.getState().setProgress(currentTime, duration);
    });
    const unsub3 = playerEngine.on('ended', () => {
      // Auto-advance handled inside PlayerEngine.handleTrackEnded
    });
    // 取链完成：回写实际生效音质与试听标记（音源降档时如实展示，不假显示）
    const unsub4 = playerEngine.on('trackLoaded', ({ result }) => {
      usePlayerStore.getState().setActualQuality(result.quality);
      usePlayerStore.getState().setPreview(!!result.isPreview);
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
    };
  }, []);

  // 启动时：音源开关 / 音质偏好从设置同步到音源注册表
  useEffect(() => {
    const settings = useSettingsStore.getState();
    // 音质偏好 → 播放器 store（设置页为持久化源头）
    if (settings.preferredQuality) {
      usePlayerStore.getState().setQuality(settings.preferredQuality);
    }
    // 音源开关 → sourceRegistry.enabled
    const applyEnabledSources = (enabledSources: Record<string, boolean>) => {
      sourceRegistry.getAll().forEach((source) => {
        source.enabled = isSourceEnabled(enabledSources, source.id);
      });
    };
    applyEnabledSources(settings.enabledSources);
    const unsub = useSettingsStore.subscribe((state, prev) => {
      if (state.enabledSources !== prev.enabledSources) {
        applyEnabledSources(state.enabledSources);
      }
    });
    return unsub;
  }, []);

  // Sync store queue/mode changes to engine (with diff guard)
  const lastQueueLen = useRef(0);
  const lastIndex = useRef(-1);
  const lastMode = useRef<string>('sequence');

  useEffect(() => {
    const unsub = usePlayerStore.subscribe((state) => {
      const queueLen = state.queue.length;
      const index = state.currentIndex;
      const mode = state.repeatMode;

      // Only sync when queue, index, or mode actually changes
      if (queueLen !== lastQueueLen.current || index !== lastIndex.current || mode !== lastMode.current) {
        lastQueueLen.current = queueLen;
        lastIndex.current = index;
        lastMode.current = mode;

        playerEngine.setQueue(state.queue, state.currentIndex);
        playerEngine.setRepeatMode(state.repeatMode);
      }
    });
    return unsub;
  }, []);

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/playlists" element={<PlaylistPage />} />
        <Route path="/reading" element={<ReadingPage />} />
        <Route path="/dj" element={<DjPage />} />
        <Route path="/downloads" element={<DownloadPage />} />
        <Route path="/local" element={<LocalMusicPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Layout>
  );
}

export default App;

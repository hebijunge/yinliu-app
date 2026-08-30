import { Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
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
import { initializeProviders } from './providers/music/registry';
import { initDatabase } from './shared/database';

function App() {
  useEffect(() => {
    // 初始化数据库
    initDatabase().catch(console.error);

    // 初始化音源Provider
    initializeProviders();

    // 播放器事件绑定
    const unsub1 = playerEngine.on('stateChange', ({ state }) => {
      usePlayerStore.getState().setState(state);
    });
    const unsub2 = playerEngine.on('progress', ({ currentTime, duration }) => {
      usePlayerStore.getState().setProgress(currentTime, duration);
    });
    const unsub3 = playerEngine.on('ended', () => {
      // Auto-play next logic would go here
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
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

import { useState, useEffect, useCallback } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ListMusic, Mic2, Download, Repeat, Repeat1, Shuffle, Heart,
} from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { usePlaylistStore } from '../../shared/store/playlistStore';
import { playerEngine } from '../../core/player';
import { lyricsManager } from '../../modules/music/lyrics';
import { downloadEngine } from '../../core/download';
import { useSettingsStore } from '../../shared/store/settingsStore';
import FullScreenPlayer from './FullScreenPlayer';
import QueuePanel from './QueuePanel';
import type { ParsedLyrics } from '../../modules/music/lyrics';
import type { RepeatMode } from '../../shared/store/playerStore';

interface PlayerBarProps {
  /** 是否为横屏模式（640-840px 设备） */
  isLandscape?: boolean;
}

const MODE_ICONS: Record<RepeatMode, typeof Repeat> = {
  sequence: ListMusic,
  'repeat-all': Repeat,
  'repeat-one': Repeat1,
  shuffle: Shuffle,
};

const MODE_LABELS: Record<RepeatMode, string> = {
  sequence: '顺序播放',
  'repeat-all': '列表循环',
  'repeat-one': '单曲循环',
  shuffle: '随机播放',
};

export default function PlayerBar({ isLandscape = false }: PlayerBarProps) {
  const { state, currentTrack, currentTime, duration, volume, isMuted, queue, repeatMode, actualSourceId } = usePlayerStore();
  // 全屏播放页开关提升到全局 store：Android 返回键需要跨组件读取并关闭播放页
  const showFullScreen = usePlayerStore((s) => s.fullscreenOpen);
  const setShowFullScreen = usePlayerStore((s) => s.setFullscreenOpen);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [lyrics, setLyrics] = useState<ParsedLyrics | null>(null);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const isPlaying = state === 'playing';
  const carMode = useSettingsStore((s) => s.carMode);

  // 加载歌词
  useEffect(() => {
    if (!currentTrack) {
      setLyrics(null);
      return;
    }

    lyricsManager.getLyrics(currentTrack.sourceSongId, currentTrack.sourceId).then((parsed) => {
      setLyrics(parsed);
    });
  }, [currentTrack]);

  // 更新当前歌词行
  useEffect(() => {
    if (!lyrics) return;
    const index = lyricsManager.getCurrentLineIndex(lyrics, currentTime);
    setCurrentLineIndex(index);
  }, [lyrics, currentTime]);

  const formatTime = (t: number) => {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleDownload = useCallback(() => {
    if (!currentTrack) return;
    // 使用设置页的默认下载音质（真实生效）
    const quality = useSettingsStore.getState().downloadQuality;
    downloadEngine.addDownload(
      currentTrack.sourceSongId,
      currentTrack.sourceId,
      quality,
      {
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
      }
    );
  }, [currentTrack]);

  const { toggleFavorite, favorites } = usePlaylistStore();
  const isFav = currentTrack ? favorites.has(currentTrack.sourceSongId) : false;

  const handlePrev = () => playerEngine.playPrevious();
  const handleNext = () => playerEngine.playNext();
  const handleCycleMode = () => usePlayerStore.getState().cycleRepeatMode();

  const handleToggleFavorite = useCallback(() => {
    if (!currentTrack) return;
    const song = {
      songId: currentTrack.sourceSongId,
      title: currentTrack.title,
      artist: currentTrack.artist,
      source: currentTrack.sourceId,
      quality: 'standard',
    };
    void toggleFavorite(song);
  }, [currentTrack, toggleFavorite]);

  const ModeIcon = MODE_ICONS[repeatMode];

  // 横屏模式：简化额外控件，车机模式：弱化歌词入口
  const showExtraControls = !isLandscape;

  return (
    <>
      {/* Lyrics Panel */}
      {showLyrics && (
        lyrics ? (
          <div
            className="fixed inset-x-0 z-50 bg-[var(--bg-secondary)]/95 backdrop-blur-lg border-t border-[var(--border-subtle)] max-h-64 overflow-y-auto"
            style={{ bottom: 'var(--player-height, 72px)' }}
          >
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-sm text-[var(--text-primary)]">歌词</h3>
                <button
                  onClick={() => setShowLyrics(false)}
                  className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-3 py-1.5 rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  关闭
                </button>
              </div>
              <div className="space-y-1 text-center">
                {lyrics.lines.map((line, index) => (
                  <div
                    key={index}
                    onClick={() => {
                      playerEngine.seek(line.time);
                    }}
                    className={`py-1.5 transition-all duration-300 cursor-pointer select-none ${
                      index === currentLineIndex
                        ? 'text-[var(--accent)] font-semibold text-lg scale-[1.02]'
                        : 'text-[var(--text-secondary)] text-sm'
                    }`}
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div
            className="fixed inset-x-0 z-50 bg-[var(--bg-secondary)]/95 backdrop-blur-lg border-t border-[var(--border-subtle)]"
            style={{ bottom: 'var(--player-height, 72px)' }}
          >
            <div className="p-5 flex flex-col items-center justify-center py-8">
              <Mic2 className="w-8 h-8 text-[var(--text-tertiary)] opacity-30 mb-3" />
              <p className="text-[var(--text-tertiary)] text-sm">暂无歌词</p>
              <p className="text-[var(--text-tertiary)] text-xs opacity-60 mt-1">该曲目暂未匹配到歌词</p>
            </div>
          </div>
        )
      )}

      {/* Queue Panel */}
      {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}

      <div
        className={`bg-[var(--bg-secondary)]/95 backdrop-blur-md border-t border-[var(--border-subtle)] px-5 ${
          isLandscape ? 'py-3.5 landscape-player' : 'py-2.5'
        }`}
      >
        {/* Progress bar — 44px 触控热区 */}
        <div
          className="w-full rounded-full mb-1 cursor-pointer group relative"
          style={{ height: '44px', display: 'flex', alignItems: 'center' }}
          onClick={(e) => {
            const bar = e.currentTarget.querySelector('.progress-visual-bar') as HTMLElement;
            if (!bar) return;
            const rect = bar.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            playerEngine.seek(percent * duration);
          }}
        >
          <div className="w-full h-[3px] bg-[var(--bg-tertiary)] rounded-full progress-visual-bar relative">
            <div
              className="h-full bg-[var(--accent)] rounded-full group-hover:bg-[var(--accent-hover)] progress-bar-smooth relative"
              style={{ width: `${progressPercent}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full border-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Track info */}
          <div
            className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer group"
            onClick={() => setShowFullScreen(true)}
          >
            <div
              key={currentTrack?.id || 'no-track'}
              className={`cover-crossfade rounded-2xl bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden border border-[var(--border-subtle)] group-hover:border-[var(--accent)]/30 transition-all ${
                isLandscape ? 'w-12 h-12' : 'w-10 h-10'
              }`}
            >
              {currentTrack?.coverUrl ? (
                <img src={currentTrack.coverUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ListMusic className={`text-[var(--text-tertiary)] ${isLandscape ? 'w-6 h-6' : 'w-5 h-5'}`} />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <div
                className={`font-semibold truncate group-hover:text-[var(--accent)] transition-colors text-[var(--text-primary)] ${
                  isLandscape ? 'text-base' : 'text-sm'
                }`}
              >
                {currentTrack?.title || '未在播放'}
              </div>
              <div className="text-xs text-[var(--text-tertiary)] truncate flex items-center gap-1.5">
                <span>{currentTrack?.artist || '选择一首歌开始播放'}</span>
                {actualSourceId && (
                  <span className="px-1 py-0.5 rounded text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {actualSourceId}
                  </span>
                )}
              </div>
            </div>
            {/* 收藏按钮 */}
            {currentTrack && (
              <button
                onClick={handleToggleFavorite}
                className={`p-2 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
                  isFav ? 'text-red-500' : 'text-[var(--text-tertiary)]'
                }`}
                title={isFav ? '取消收藏' : '收藏'}
              >
                <Heart className={`w-4 h-4 ${isFav ? 'fill-current' : ''}`} />
              </button>
            )}
          </div>

          {/* Main Controls — 上一首/播放/下一首 — 始终显示 */}
          <div className="player-main-controls flex items-center gap-1.5">
            <button
              onClick={handlePrev}
              className="player-control-btn p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
              title="上一首"
            >
              <SkipBack className={isLandscape ? 'w-5 h-5' : 'w-4 h-4'} />
            </button>
            <button
              onClick={() => {
                if (isPlaying) playerEngine.pause();
                else if (currentTrack) playerEngine.resume();
              }}
              className="player-control-btn p-2.5 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] play-btn-transition focus-ring"
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? (
                <Pause className={`${isLandscape ? 'w-6 h-6' : 'w-5 h-5'} transition-transform duration-200`} />
              ) : (
                <Play className={`${isLandscape ? 'w-6 h-6' : 'w-5 h-5'} ml-0.5 transition-transform duration-200`} />
              )}
            </button>
            <button
              onClick={handleNext}
              className="player-control-btn p-2 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
              title="下一首"
            >
              <SkipForward className={isLandscape ? 'w-5 h-5' : 'w-4 h-4'} />
            </button>
          </div>

          {/* Extra Controls — 桌面/手机横屏时不显示次要控件，简化层级 */}
          {showExtraControls && (
            <div className="hidden md:flex items-center gap-1.5">
              {/* Playback mode */}
              <button
                onClick={handleCycleMode}
                className={`p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
                  repeatMode !== 'sequence' ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)]'
                }`}
                title={MODE_LABELS[repeatMode]}
              >
                <ModeIcon className="w-4 h-4" />
              </button>

              {/* Queue */}
              <button
                onClick={() => setShowQueue(!showQueue)}
                className={`p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring relative ${
                  showQueue ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)]'
                }`}
                title="播放队列"
              >
                <ListMusic className="w-4 h-4" />
                {queue.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 bg-[var(--accent)] text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                    {queue.length}
                  </span>
                )}
              </button>

              {/* 车机模式下弱化歌词入口，强化播放/下载核心操作 */}
              {!carMode && (
                <button
                  onClick={() => setShowLyrics(!showLyrics)}
                  className={`p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] transition-colors focus-ring ${
                    showLyrics ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)]'
                  }`}
                  title="歌词"
                >
                  <Mic2 className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={handleDownload}
                className="p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
                title="下载"
              >
                <Download className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  if (isMuted) playerEngine.setVolume(volume);
                  else playerEngine.setVolume(0);
                  usePlayerStore.getState().toggleMute();
                }}
                className="p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring"
                title={isMuted || volume === 0 ? '取消静音' : '静音'}
              >
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <span className="text-xs text-[var(--text-tertiary)] tabular-nums min-w-[4.5rem] text-right">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
          )}

          {/* 横屏模式：仅显示时间 */}
          {isLandscape && (
            <span className="text-xs text-[var(--text-tertiary)] tabular-nums min-w-[5rem] text-right">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          )}
        </div>
      </div>

      {/* Full Screen Player */}
      {showFullScreen && <FullScreenPlayer onClose={() => setShowFullScreen(false)} />}
    </>
  );
}

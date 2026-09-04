import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ListMusic, Mic2, Download, Repeat, Repeat1, Shuffle, Heart,
  Loader2, RotateCcw,
} from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { usePlaylistStore } from '../../shared/store/playlistStore';
import { playerEngine } from '../../core/player';
import { PLATFORM_DISPLAY_NAMES } from '../../core/platformPriority';
import { lyricsManager } from '../../modules/music/lyrics';
import { downloadEngine } from '../../core/download';
import { useSettingsStore } from '../../shared/store/settingsStore';
import { useGuardedAction } from '../../shared/hooks/useGuardedAction';
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
  const { state, currentTrack, currentTime, duration, volume, isMuted, queue, repeatMode, actualSourceId, isBuffering } = usePlayerStore();
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

  // E4: 下载守卫（300ms 防抖，防狂点重复下发同一任务）
  const { run: guardedDownload, busy: downloadBusy } = useGuardedAction(handleDownload);

  const { toggleFavorite, isFavorite } = usePlaylistStore();
  const isFav = currentTrack ? isFavorite({ title: currentTrack.title, artist: currentTrack.artist }) : false;

  // ===== v23: 进度条拖动（pointer 事件，拖动中仅更新视觉，松手才 seek）=====
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const progressVisualRef = useRef<HTMLDivElement>(null);

  const percentFromClientX = useCallback((clientX: number): number | null => {
    const bar = progressVisualRef.current;
    if (!bar || !isFinite(duration) || duration <= 0) return null;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, [duration]);

  const handleProgressPointerDown = useCallback((e: React.PointerEvent) => {
    const percent = percentFromClientX(e.clientX);
    if (percent === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragPercent(percent);
  }, [percentFromClientX]);

  const handleProgressPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragPercent === null) return;
    const percent = percentFromClientX(e.clientX);
    if (percent !== null) setDragPercent(percent);
  }, [dragPercent, percentFromClientX]);

  const handleProgressPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragPercent === null) return;
    const percent = percentFromClientX(e.clientX) ?? dragPercent;
    setDragPercent(null);
    playerEngine.seek(percent * duration);
  }, [dragPercent, percentFromClientX, duration]);

  // 拖动中显示拖动位置，否则显示实际进度
  const shownPercent = dragPercent !== null ? dragPercent * 100 : progressPercent;
  const shownTime = dragPercent !== null ? dragPercent * duration : currentTime;
  // 音源友好名（v23: 降级换源后用户可感知当前音源）
  const sourceName = actualSourceId
    ? (PLATFORM_DISPLAY_NAMES[actualSourceId] || actualSourceId)
    : null;

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
        {/* Progress bar — 44px 触控热区（v23: 支持拖动 seek，拖动中仅更新视觉，松手生效） */}
        <div
          className="w-full rounded-full mb-1 group relative"
          style={{ height: '44px', display: 'flex', alignItems: 'center', touchAction: 'none' }}
          onPointerDown={handleProgressPointerDown}
          onPointerMove={handleProgressPointerMove}
          onPointerUp={handleProgressPointerUp}
          onPointerCancel={handleProgressPointerUp}
        >
          <div ref={progressVisualRef} className="w-full h-[2px] bg-[var(--bg-tertiary)] rounded-full relative">
            <div
              className="h-full bg-[var(--accent)] rounded-full relative"
              style={{ width: `${shownPercent}%`, transition: dragPercent !== null ? 'none' : undefined }}
            >
              {/* 拖动时始终显示拇指 + 拖动位置气泡（拖动视觉反馈） */}
              <div
                className={`absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full border-2 border-[var(--accent)] transition-opacity ${
                  dragPercent !== null ? 'opacity-100 scale-110' : 'opacity-0 group-hover:opacity-100'
                }`}
              />
            </div>
            {/* v23: 缓冲指示器 —— 进度条轻微闪烁 + 右上角"缓冲中"轻提示 */}
            {isBuffering && dragPercent === null && (
              <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)] opacity-20 animate-pulse" style={{ width: '100%' }} />
            )}
          </div>
          {isBuffering && dragPercent === null && (
            <span className="absolute -top-0.5 right-0 flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]">
              <Loader2 className="w-3 h-3 animate-spin" />
              缓冲中
            </span>
          )}
          {dragPercent !== null && (
            <span
              className="absolute -top-1 px-1.5 py-0.5 rounded-md bg-[var(--bg-tertiary)] text-[10px] tabular-nums text-[var(--text-primary)] pointer-events-none"
              style={{ left: `clamp(0px, calc(${shownPercent}% - 14px), calc(100% - 34px))` }}
            >
              {formatTime(shownTime)}
            </span>
          )}
        </div>

        {/* v23: 播放失败提示 + 重试入口 */}
        {state === 'error' && currentTrack && (
          <button
            onClick={() => void playerEngine.retry()}
            className="w-full mb-1 flex items-center justify-center gap-1.5 py-1.5 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-500 hover:bg-red-500/15 transition-colors focus-ring"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            播放失败，点击重试
          </button>
        )}

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
                {sourceName && (
                  <span className="px-1 py-0.5 rounded text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {sourceName}
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
                if (state === 'loading') return; // v23: 起播中忽略重复点击
                if (state === 'error') {
                  void playerEngine.retry();
                  return;
                }
                if (isPlaying) playerEngine.pause();
                else if (currentTrack) playerEngine.resume();
              }}
              className="player-control-btn p-2.5 rounded-full bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] play-btn-transition focus-ring disabled:opacity-80"
              title={
                state === 'loading' ? '加载中' : state === 'error' ? '播放失败，点击重试' : isPlaying ? '暂停' : '播放'
              }
            >
              {state === 'loading' ? (
                <Loader2 className={`${isLandscape ? 'w-6 h-6' : 'w-5 h-5'} animate-spin`} />
              ) : state === 'error' ? (
                <RotateCcw className={`${isLandscape ? 'w-6 h-6' : 'w-5 h-5'}`} />
              ) : isPlaying ? (
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
                onClick={guardedDownload}
                disabled={downloadBusy}
                className="p-1.5 rounded-full hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors focus-ring disabled:opacity-40"
                title="下载"
              >
                {downloadBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
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

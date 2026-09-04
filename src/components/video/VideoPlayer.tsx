import { useRef, useEffect, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play, Pause, RotateCcw, SkipBack, SkipForward, Volume2, VolumeX,
  Maximize, Minimize, Lock, Unlock, Settings, X, ChevronLeft,
  Sun, Gauge, Film,
} from 'lucide-react';
import { useVideoPlayerStore, PLAYBACK_RATES, type PlaybackRate } from '../../shared/store/videoPlayerStore';
import type { MvQuality } from '../../core/types';
import { MV_QUALITY_LABELS } from '../../core/types';
import { playerEngine } from '../../core/player';
import { toast } from '../../shared/components/Toast';

/** v21.0 适配：MV 包采用字符串画质联合类型，这里对齐标签/分辨率映射 */
const MvQualityLabel = MV_QUALITY_LABELS;
const MvQualityResolution: Record<MvQuality, string> = {
  '240p': '240P',
  '480p': '480P',
  '720p': '720P',
  '1080p': '1080P',
  '4k': '2160P',
};

interface Props {
  src: string;
  poster?: string;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onLoadStart?: () => void;
  onCanPlay?: () => void;
  /** v22 D3: 画质切换回调（参数：目标画质、切换时的播放进度秒）——由父组件重载对应画质流 */
  onQualityChange?: (quality: MvQuality, resumeAt: number) => void;
  /** v22 D3: 换流后需恢复的播放进度（秒），loadedmetadata 时一次性 seek */
  restoreTime?: number;
}

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VideoPlayer({ src, poster, onEnded, onError, onLoadStart, onCanPlay, onQualityChange, restoreTime }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const gestureTypeRef = useRef<'none' | 'seek' | 'volume' | 'brightness'>('none');
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  // v22 D3: currentTime 的 ref 镜像——保存进度的 interval / 画质切换不再依赖高频变化的 store currentTime
  const currentTimeRef = useRef(0);
  // v22 D3: 手势 seek 的基准时间 ref（store currentTime 有滞后，逐帧用它累加会造成触摸 seek 回跳）
  const gestureSeekTimeRef = useRef(0);
  // v22 D3: 换流后待恢复的进度（restoreTime prop 变化时写入）
  const restoreTimeRef = useRef(0);

  const navigate = useNavigate();

  const {
    state, currentTime, duration, buffered, volume, isMuted, playbackRate,
    isFullscreen, isLocked, isControlsVisible, showQualitySelector, showRateSelector,
    currentQuality, availableQualities, errorMessage, gestureHint, isGesturing,
    setState, setProgress, setBuffered, setVolume, toggleMute, setPlaybackRate,
    setFullscreen, toggleFullscreen, toggleLocked, setControlsVisible,
    setShowQualitySelector, setShowRateSelector, setErrorMessage,
    setIsGesturing, setGestureHint, currentMv, saveProgress,
  } = useVideoPlayerStore();

  const isPlaying = state === 'playing';

  // === 视频元素事件绑定 ===
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setState('playing');
    const handlePause = () => setState('paused');
    const handleWaiting = () => setState('buffering');
    const handleCanPlay = () => {
      // v22 D3: 暂停状态下 seek 缓冲完成不应自动恢复播放；
      // 仅在视频本身在播（等待缓冲）或处于初始加载态时才升格为 playing
      const storeState = useVideoPlayerStore.getState().state;
      if (!video.paused || storeState !== 'paused') {
        setState('playing');
      }
      onCanPlay?.();
    };
    const handleTimeUpdate = () => {
      currentTimeRef.current = video.currentTime;
      setProgress(video.currentTime, video.duration || 0);
      // 缓冲进度
      if (video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        setBuffered(end);
      }
    };
    const handleLoadedMetadata = () => {
      // v22 D3: 换流（画质切换）后一次性恢复播放进度
      if (restoreTimeRef.current > 0 && isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(restoreTimeRef.current, Math.max(0, video.duration - 1));
        setProgress(video.currentTime, video.duration || 0);
        currentTimeRef.current = video.currentTime;
        restoreTimeRef.current = 0;
      }
      setProgress(video.currentTime, video.duration || 0);
    };
    const handleEnded = () => {
      setState('idle');
      onEnded?.();
    };
    const handleError = () => {
      const msg = '视频加载失败';
      setState('error');
      setErrorMessage(msg);
      onError?.(msg);
    };
    const handleLoadStart = () => {
      setState('loading');
      onLoadStart?.();
    };
    const handleProgress = () => {
      if (video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        setBuffered(end);
      }
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('canplaythrough', handleCanPlay);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);
    video.addEventListener('loadstart', handleLoadStart);
    video.addEventListener('progress', handleProgress);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('canplaythrough', handleCanPlay);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
      video.removeEventListener('loadstart', handleLoadStart);
      video.removeEventListener('progress', handleProgress);
    };
  }, [setState, setProgress, setBuffered, setErrorMessage, onEnded, onError, onLoadStart, onCanPlay]);

  // === 同步 src ===
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (video.src !== src) {
      video.src = src;
      video.load();
    }
  }, [src]);

  // === v22 D3: 换流进度恢复 —— restoreTime prop 变化时记入 ref，loadedmetadata 时一次性 seek ===
  useEffect(() => {
    restoreTimeRef.current = restoreTime && restoreTime > 0 ? restoreTime : 0;
  }, [restoreTime]);

  // === 同步播放状态 ===
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (state === 'playing' && video.paused) {
      video.play().catch(() => {
        // 自动播放策略限制，忽略
      });
    } else if (state === 'paused' && !video.paused) {
      video.pause();
    }
  }, [state]);

  // === 同步倍速 ===
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = playbackRate;
  }, [playbackRate]);

  // === 同步音量 ===
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = isMuted ? 0 : volume;
      video.muted = isMuted;
    }
  }, [volume, isMuted]);

  // === 全屏切换 ===
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (isFullscreen) {
      container.requestFullscreen?.().catch(() => {
        // 部分环境不支持
      });
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, [isFullscreen]);

  // 监听系统全屏变化
  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [setFullscreen]);

  // === 切后台处理 ===
  useEffect(() => {
    const handleVisibilityChange = () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.hidden) {
        // 切后台：视频暂停音频延续（保留视频当前进度）
        if (state === 'playing') {
          // 继续播放音频（视频元素在后台会自动暂停，这是浏览器行为）
          // 用户切回前台后需要手动继续
        }
      } else {
        // 切回前台：自动恢复播放
        if (state === 'playing' && video.paused) {
          video.play().catch(() => {});
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [state]);

  // === 自动隐藏控制栏 ===
  const resetControlsTimer = useCallback(() => {
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current);
    }
    setControlsVisible(true);
    controlsTimerRef.current = window.setTimeout(() => {
      if (!isLocked && !showQualitySelector && !showRateSelector && !isGesturing) {
        setControlsVisible(false);
      }
    }, 3000);
  }, [isLocked, showQualitySelector, showRateSelector, isGesturing, setControlsVisible]);

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [resetControlsTimer]);

  // === 保存播放进度 ===
  // v22 D3: 改用 currentTimeRef——原实现把高频变化的 currentTime 放进 deps，
  // interval 每 250ms 被重建、永远到不了 5s 触发点，进度记忆实际失效
  useEffect(() => {
    if (!currentMv) return;
    const interval = setInterval(() => {
      const t = currentTimeRef.current;
      if (t > 5) {
        saveProgress(currentMv.id, t);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [currentMv, saveProgress]);

  // === 进度条拖动 ===
  const handleSeek = useCallback((clientX: number, rect: DOMRect) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetTime = percent * duration;
    video.currentTime = targetTime;
    setProgress(targetTime, duration);
  }, [duration, setProgress]);

  // === 手势处理 ===
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (isLocked) return;
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
    gestureTypeRef.current = 'none';
  }, [isLocked]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (isLocked || !touchStartRef.current || !lastTouchRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const touch = e.touches[0];
    const start = touchStartRef.current;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (gestureTypeRef.current === 'none') {
      if (absDx > 10 || absDy > 10) {
        if (absDx > absDy) {
          gestureTypeRef.current = 'seek';
          // v22 D3: 以视频实际 currentTime 为基准起算，避免 store 滞后导致的回跳
          gestureSeekTimeRef.current = video.currentTime;
        } else {
          // 左侧亮度，右侧音量
          gestureTypeRef.current = start.x < window.innerWidth / 2 ? 'brightness' : 'volume';
        }
        setIsGesturing(true);
      }
    }

    if (gestureTypeRef.current === 'seek') {
      const deltaX = touch.clientX - lastTouchRef.current.x;
      const seekAmount = deltaX * 0.15;
      const newTime = Math.max(0, Math.min(duration, gestureSeekTimeRef.current + seekAmount));
      gestureSeekTimeRef.current = newTime;
      setGestureHint(`${seekAmount > 0 ? '快进' : '快退'} ${Math.abs(Math.round(seekAmount))}秒`);
      video.currentTime = newTime;
      setProgress(newTime, duration);
    } else if (gestureTypeRef.current === 'volume') {
      const deltaY = lastTouchRef.current.y - touch.clientY;
      const deltaVol = deltaY * 0.003;
      const newVol = Math.max(0, Math.min(1, volume + deltaVol));
      setVolume(newVol);
      setGestureHint(`音量 ${Math.round(newVol * 100)}%`);
    } else if (gestureTypeRef.current === 'brightness') {
      const deltaY = lastTouchRef.current.y - touch.clientY;
      const deltaBright = deltaY * 0.003;
      const newBright = Math.max(0.1, Math.min(1, (useVideoPlayerStore.getState().brightness || 1) + deltaBright));
      useVideoPlayerStore.getState().setBrightness(newBright);
      setGestureHint(`亮度 ${Math.round(newBright * 100)}%`);
      // 实际亮度通过 CSS filter 实现
      if (videoRef.current) {
        videoRef.current.style.filter = `brightness(${newBright})`;
      }
    }

    lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
  }, [isLocked, duration, currentTime, volume, setVolume, setProgress, setIsGesturing, setGestureHint]);

  const handleTouchEnd = useCallback(() => {
    touchStartRef.current = null;
    lastTouchRef.current = null;
    gestureTypeRef.current = 'none';
    setIsGesturing(false);
    setGestureHint(null);
  }, [setIsGesturing, setGestureHint]);

  // === 点击切换播放/暂停 ===
  const handleContainerClick = useCallback(() => {
    // v22 D3: 锁定状态下点击视频区不响应（锁定只留顶部解锁按钮）
    if (isLocked) return;
    if (isGesturing) return;
    resetControlsTimer();
    if (isControlsVisible) {
      // 如果控制栏已显示，点击视频区域切换播放/暂停
      if (state === 'playing') {
        videoRef.current?.pause();
        setState('paused');
      } else {
        videoRef.current?.play().catch(() => {});
        setState('playing');
      }
    }
  }, [isGesturing, isControlsVisible, state, setState, resetControlsTimer]);

  // === 返回/关闭 ===
  const handleClose = useCallback(() => {
    videoRef.current?.pause();
    setState('idle');
    // 保存进度
    if (currentMv && currentTimeRef.current > 0) {
      saveProgress(currentMv.id, currentTimeRef.current);
    }
    // 恢复音乐播放（如果之前有在播放）
    navigate(-1);
  }, [currentMv, currentTime, saveProgress, setState, navigate]);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[60] bg-black flex flex-col select-none"
      onClick={handleContainerClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseMove={resetControlsTimer}
    >
      {/* 视频层 */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        poster={poster}
        playsInline
        webkit-playsinline="true"
        x5-playsinline="true"
        crossOrigin="anonymous"
        preload="auto"
      />

      {/* 加载中 */}
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
        </div>
      )}

      {/* 缓冲中 */}
      {state === 'buffering' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-10 h-10 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          <span className="absolute mt-16 text-white/70 text-sm">缓冲中...</span>
        </div>
      )}

      {/* 错误提示 */}
      {state === 'error' && errorMessage && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-white/80 text-center">
            <p className="text-lg mb-2">播放失败</p>
            <p className="text-sm text-white/50">{errorMessage}</p>
          </div>
        </div>
      )}

      {/* 手势提示 */}
      {gestureHint && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/60 text-white px-4 py-2 rounded-lg text-lg font-medium">
            {gestureHint}
          </div>
        </div>
      )}

      {/* 顶部控制栏 */}
      <div
        className={`absolute top-0 left-0 right-0 px-4 py-3 flex items-center gap-3 bg-gradient-to-b from-black/60 to-transparent transition-opacity duration-300 ${
          isControlsVisible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={handleClose} className="p-2 rounded-full hover:bg-white/10 text-white">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-medium truncate">{currentMv?.title || '正在播放'}</p>
          {currentMv?.artist && (
            <p className="text-white/60 text-xs truncate">{currentMv.artist}</p>
          )}
        </div>
        {/* 锁定按钮 */}
        <button
          onClick={() => toggleLocked()}
          className={`p-2 rounded-full hover:bg-white/10 text-white ${isLocked ? 'text-amber-400' : ''}`}
          title={isLocked ? '解锁' : '锁定'}
        >
          {isLocked ? <Lock className="w-5 h-5" /> : <Unlock className="w-5 h-5" />}
        </button>
      </div>

      {/* 中间大播放按钮（暂停时显示；锁定时不显示） */}
      {!isPlaying && !isLocked && state !== 'loading' && state !== 'error' && isControlsVisible && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <button
            onClick={(e) => {
              e.stopPropagation();
              videoRef.current?.play().catch(() => {});
              setState('playing');
            }}
            className="p-6 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm transition-colors pointer-events-auto"
          >
            <Play className="w-10 h-10 text-white ml-1" />
          </button>
        </div>
      )}

      {/* 底部控制栏（锁定时隐藏——锁定只保留顶部解锁入口） */}
      <div
        className={`absolute bottom-0 left-0 right-0 px-4 pb-6 pt-8 bg-gradient-to-t from-black/70 via-black/40 to-transparent transition-opacity duration-300 ${
          isControlsVisible && !isLocked ? 'opacity-100' : 'opacity-0'
        } ${isLocked ? 'pointer-events-none' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 进度条 */}
        <div className="mb-3">
          <div
            className="relative w-full h-1.5 bg-white/20 rounded-full cursor-pointer group"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              handleSeek(e.clientX, rect);
            }}
          >
            {/* 缓冲进度 */}
            <div
              className="absolute h-full bg-white/30 rounded-full"
              style={{ width: `${bufferedPercent}%` }}
            />
            {/* 播放进度 */}
            <div
              className="absolute h-full bg-[var(--accent)] rounded-full"
              style={{ width: `${progressPercent}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full border-2 border-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <div className="flex justify-between text-xs text-white/60 mt-1.5 tabular-nums">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* 控制按钮 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* 画质 */}
            <button
              onClick={() => setShowQualitySelector(!showQualitySelector)}
              className="px-2 py-1 rounded text-xs text-white/80 hover:bg-white/10 flex items-center gap-1"
            >
              <Film className="w-3.5 h-3.5" />
              {MvQualityLabel[currentQuality]}
            </button>
            {/* 倍速 */}
            <button
              onClick={() => setShowRateSelector(!showRateSelector)}
              className="px-2 py-1 rounded text-xs text-white/80 hover:bg-white/10 flex items-center gap-1"
            >
              <Gauge className="w-3.5 h-3.5" />
              {playbackRate}x
            </button>
          </div>

          <div className="flex items-center gap-4">
            {/* 快退 */}
            <button
              onClick={() => {
                const video = videoRef.current;
                if (video) {
                  video.currentTime = Math.max(0, video.currentTime - 10);
                  setProgress(video.currentTime, duration);
                }
              }}
              className="p-2 rounded-full hover:bg-white/10 text-white"
            >
              <SkipBack className="w-5 h-5" />
            </button>

            {/* 播放/暂停 */}
            <button
              onClick={() => {
                if (isPlaying) {
                  videoRef.current?.pause();
                  setState('paused');
                } else {
                  videoRef.current?.play().catch(() => {});
                  setState('playing');
                }
              }}
              className="p-3 rounded-full bg-white/20 hover:bg-white/30 text-white"
            >
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
            </button>

            {/* 快进 */}
            <button
              onClick={() => {
                const video = videoRef.current;
                if (video) {
                  video.currentTime = Math.min(duration, video.currentTime + 10);
                  setProgress(video.currentTime, duration);
                }
              }}
              className="p-2 rounded-full hover:bg-white/10 text-white"
            >
              <SkipForward className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {/* 音量 */}
            <button
              onClick={() => toggleMute()}
              className="p-2 rounded-full hover:bg-white/10 text-white"
            >
              {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
            {/* 全屏 */}
            <button
              onClick={() => toggleFullscreen()}
              className="p-2 rounded-full hover:bg-white/10 text-white"
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* 画质选择弹窗 */}
      {showQualitySelector && (
        <div
          className="absolute bottom-20 left-4 right-4 max-w-xs mx-auto bg-black/80 backdrop-blur-md rounded-xl border border-white/10 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 border-b border-white/10 text-white/60 text-xs">选择画质</div>
          {availableQualities.length > 0 ? (
            availableQualities.map((q) => (
              <button
                key={q}
                onClick={() => {
                  useVideoPlayerStore.getState().setCurrentQuality(q);
                  setShowQualitySelector(false);
                  // v22 D3: 画质切换不再只是改 store——通知父组件以目标画质重载流，并携带断点进度
                  if (q !== currentQuality) {
                    onQualityChange?.(q, currentTimeRef.current);
                  }
                  toast.info('切换画质', `${MvQualityLabel[q]} (${MvQualityResolution[q]})`);
                }}
                className={`w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-white/10 ${
                  currentQuality === q ? 'text-[var(--accent)]' : 'text-white'
                }`}
              >
                <span>{MvQualityLabel[q]} <span className="text-white/40 text-xs">{MvQualityResolution[q]}</span></span>
                {currentQuality === q && <span className="text-[var(--accent)] text-xs">当前</span>}
              </button>
            ))
          ) : (
            <div className="px-4 py-3 text-white/40 text-sm">暂无可用画质</div>
          )}
        </div>
      )}

      {/* 倍速选择弹窗 */}
      {showRateSelector && (
        <div
          className="absolute bottom-20 left-4 right-4 max-w-xs mx-auto bg-black/80 backdrop-blur-md rounded-xl border border-white/10 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 border-b border-white/10 text-white/60 text-xs">播放速度</div>
          {PLAYBACK_RATES.map((rate) => (
            <button
              key={rate}
              onClick={() => {
                setPlaybackRate(rate);
                setShowRateSelector(false);
              }}
              className={`w-full px-4 py-3 text-sm hover:bg-white/10 text-left ${
                playbackRate === rate ? 'text-[var(--accent)]' : 'text-white'
              }`}
            >
              {rate}x {playbackRate === rate && <span className="float-right text-[var(--accent)] text-xs">当前</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

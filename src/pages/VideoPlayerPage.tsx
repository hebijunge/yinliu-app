import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import VideoPlayer from '../components/video/VideoPlayer';
import { useVideoPlayerStore } from '../shared/store/videoPlayerStore';
import type { MvInfo, MvQuality } from '../core/types';
import { sourceRegistry } from '../providers/music/registry';
import { playerEngine } from '../core/player';
import { toast } from '../shared/components/Toast';
import { toUserMessage } from '../shared/utils/errorCopy';

export default function VideoPlayerPage() {
  const [searchParams] = useSearchParams();
  const mvId = searchParams.get('id');
  const sourceId = searchParams.get('source') || 'qq';

  const {
    setCurrentMv, setState, setCurrentQuality, setAvailableQualities,
    setProgress, currentQuality, currentMv, getSavedProgress, saveProgress,
  } = useVideoPlayerStore();

  const [mvUrl, setMvUrl] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // v22 D8: 换流进度恢复走 restoreTime prop（VideoPlayer 在 loadedmetadata 一次性 seek），
  // 替代原 setTimeout + querySelector('video') 的竞态写法
  const [restoreTime, setRestoreTime] = useState(0);
  const initialRestoredRef = useRef(false);

  // === 加载MV信息并取链 ===
  const loadMv = useCallback(async () => {
    if (!mvId) {
      setError('缺少MV ID');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    setState('loading');

    try {
      const source = sourceRegistry.get(sourceId);
      if (!source) {
        throw new Error(`找不到音源: ${sourceId}`);
      }

      // 1. 获取可用画质
      let qualities: MvQuality[] = [];
      const anySource = source as any;
      if (typeof anySource.getMvQualities === 'function') {
        try {
          qualities = await anySource.getMvQualities(mvId);
        } catch (e) {
          console.warn('[VideoPlayerPage] getMvQualities failed:', e);
        }
      }
      // 兜底：如果没有获取到画质列表，默认提供常用画质
      if (qualities.length === 0) {
        qualities = ['240p', '480p', '720p'];
      }
      setAvailableQualities(qualities);

      // 2. 构建 MV 信息（如果 provider 支持 searchMv，可以尝试获取详情）
      const mvInfo: MvInfo = {
        id: `${sourceId}_${mvId}`,
        vid: mvId,
        title: 'MV',
        sourceId,
        availableQualities: qualities,
      };
      setCurrentMv(mvInfo);

      // 3. 取链（优先当前选中的画质，失败则降级）
      await resolveAndPlay(mvId, sourceId, qualities, currentQuality);

    } catch (err) {
      const msg = toUserMessage(err, '加载失败');
      setError(msg);
      setState('error');
      toast.error('MV加载失败', msg);
    } finally {
      setIsLoading(false);
    }
  }, [mvId, sourceId, currentQuality, setCurrentMv, setState, setAvailableQualities]);

  // === 取链并播放 ===
  const resolveAndPlay = useCallback(async (
    vid: string,
    sid: string,
    qualities: MvQuality[],
    preferredQuality: MvQuality
  ) => {
    const source = sourceRegistry.get(sid);
    if (!source || typeof (source as any).getMvUrl !== 'function') {
      throw new Error('该音源暂不支持MV播放');
    }

    // 按画质优先级排序：首选 preferredQuality，然后降序
    const qualityOrder = [preferredQuality, ...qualities.filter((q) => q !== preferredQuality)];

    let lastError: unknown = null;
    for (const q of qualityOrder) {
      try {
        const result = await (source as any).getMvUrl(vid, q);
        if (result && result.url) {
          setMvUrl(result.url);
          setCurrentQuality(q);
          setState('loading');
          return;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[VideoPlayerPage] getMvUrl failed for ${q}:`, err);
      }
    }

    throw new Error(
      lastError instanceof Error ? lastError.message : '所有画质均无法播放'
    );
  }, [setCurrentQuality, setState]);

  // === 初始加载 ===
  useEffect(() => {
    loadMv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mvId, sourceId]);

  // === 暂停音乐播放（视频优先）===
  useEffect(() => {
    // 进入视频页时暂停音乐
    const audioState = playerEngine.getState();
    if (audioState === 'playing') {
      playerEngine.pause();
    }

    return () => {
      // 离开视频页时保存进度
      if (currentMv) {
        const store = useVideoPlayerStore.getState();
        if (store.currentTime > 0) {
          saveProgress(currentMv.id, store.currentTime);
        }
      }
    };
  }, [currentMv, saveProgress]);

  // === 画质切换（由 VideoPlayer 的 onQualityChange 直调，不再监听 store 订阅） ===
  // v22 D8: 原 store.subscribe 监听 currentQuality 形成反馈环——
  // 切画质 → setCurrentQuality → 订阅触发 → 再取链再 setCurrentQuality，重复取链
  const handleQualityChange = useCallback(async (quality: MvQuality, resumeAt: number) => {
    if (!mvId || !currentMv) return;

    setState('loading');
    setRestoreTime(resumeAt > 0 ? resumeAt : 0);
    try {
      await resolveAndPlay(mvId, sourceId, currentMv.availableQualities, quality);
    } catch (err) {
      const msg = toUserMessage(err, '切换失败');
      toast.error('画质切换失败', msg);
      setRestoreTime(0);
      setState('error');
    }
  }, [mvId, currentMv, sourceId, resolveAndPlay, setState]);

  // === 恢复上次播放进度（初始一次） ===
  useEffect(() => {
    if (!currentMv || !mvUrl || initialRestoredRef.current) return;
    initialRestoredRef.current = true;
    const saved = getSavedProgress(currentMv.id);
    if (saved > 5) {
      setRestoreTime(saved);
      toast.info('已恢复上次播放进度', `跳转至 ${Math.floor(saved / 60)}:${String(Math.floor(saved % 60)).padStart(2, '0')}`);
    }
  }, [currentMv, mvUrl, getSavedProgress]);

  if (isLoading && !mvUrl) {
    return (
      <div className="fixed inset-0 z-[60] bg-black flex flex-col items-center justify-center">
        <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin mb-4" />
        <p className="text-white/60 text-sm">正在加载MV...</p>
      </div>
    );
  }

  if (error && !mvUrl) {
    return (
      <div className="fixed inset-0 z-[60] bg-black flex flex-col items-center justify-center px-8">
        <p className="text-white text-lg mb-2">加载失败</p>
        <p className="text-white/50 text-sm text-center mb-6">{error}</p>
        <button
          onClick={() => window.history.back()}
          className="px-6 py-2 rounded-full bg-white/10 text-white text-sm hover:bg-white/20"
        >
          返回
        </button>
      </div>
    );
  }

  return (
    <VideoPlayer
      src={mvUrl}
      poster={currentMv?.coverUrl}
      restoreTime={restoreTime}
      onQualityChange={handleQualityChange}
      onLoadStart={() => setState('loading')}
      onCanPlay={() => setState('playing')}
      onEnded={() => {
        setState('idle');
        if (currentMv) {
          saveProgress(currentMv.id, 0); // 播放完重置进度
        }
      }}
      onError={(msg) => {
        setState('error');
        toast.error('播放失败', msg);
      }}
    />
  );
}

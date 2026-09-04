import { useEffect, useRef } from 'react';
import { X, Loader2, AlertCircle, MonitorPlay } from 'lucide-react';
import { useMvPlayerStore } from '../shared/store/mvPlayerStore';
import { MV_QUALITY_LABELS, MV_QUALITY_ORDER } from '../core/types';
import type { MvQuality } from '../core/types';
// mvQualityRank available from '../core/types' if needed for quality sorting

export default function MvPlayerPage() {
  const {
    isOpen, title, artist, coverUrl, sources, currentSourceId, currentQuality,
    videoUrl, isLoading, isFetchingQualities, error, closeMv, switchSource, switchQuality,
  } = useMvPlayerStore();

  const videoRef = useRef<HTMLVideoElement>(null);

  // 视频地址变化时自动播放
  useEffect(() => {
    if (videoUrl && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [videoUrl]);

  if (!isOpen) return null;

  const currentSource = sources.find((s) => s.sourceId === currentSourceId);
  const availableQualities = currentSource?.availableQualities || [];

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur-sm shrink-0">
        <div className="min-w-0 flex-1 mr-4">
          <h3 className="text-white font-medium truncate text-base">{title}</h3>
          {artist && <p className="text-white/60 text-sm truncate">{artist}</p>}
        </div>
        <button
          onClick={closeMv}
          className="p-2 rounded-full hover:bg-white/10 text-white transition-colors shrink-0"
          aria-label="关闭"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* 视频播放区 */}
      <div className="flex-1 flex items-center justify-center bg-black relative overflow-hidden">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            poster={coverUrl || undefined}
            controls
            className="max-w-full max-h-full w-full h-full object-contain"
            playsInline
            preload="auto"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-white/40 px-6 text-center">
            {isLoading || isFetchingQualities ? (
              <>
                <Loader2 className="w-12 h-12 animate-spin mb-4" />
                <p className="text-sm">
                  {isFetchingQualities ? '正在获取画质信息…' : '正在加载视频…'}
                </p>
              </>
            ) : error ? (
              <>
                <AlertCircle className="w-12 h-12 mb-4 text-red-400" />
                <p className="text-red-400 mb-2 text-sm">{error}</p>
                {sources.length > 1 && (
                  <p className="text-xs text-white/50">可尝试切换其他来源</p>
                )}
              </>
            ) : (
              <>
                <MonitorPlay className="w-12 h-12 mb-4" />
                <p className="text-sm">准备播放</p>
              </>
            )}
          </div>
        )}
      </div>

      {/* 底部控制栏：来源 + 画质 */}
      <div className="bg-black/90 backdrop-blur-sm px-4 py-3 space-y-3 shrink-0">
        {/* 来源切换 */}
        {sources.length > 1 && (
          <div>
            <p className="text-white/50 text-xs mb-2">来源</p>
            <div className="flex gap-2 overflow-x-auto scrollbar-hide">
              {sources.map((s) => (
                <button
                  key={s.sourceId}
                  onClick={() => switchSource(s.sourceId)}
                  className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors shrink-0 ${
                    s.sourceId === currentSourceId
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-white/10 text-white/80 hover:bg-white/20'
                  }`}
                >
                  {s.sourceName}
                  {!s.qualitiesFetched && (
                    <span className="ml-1 inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 画质选择 */}
        {availableQualities.length > 0 && (
          <div>
            <p className="text-white/50 text-xs mb-2">画质</p>
            <div className="flex gap-2 flex-wrap">
              {MV_QUALITY_ORDER.filter((q) => availableQualities.includes(q)).map((q) => (
                <button
                  key={q}
                  onClick={() => switchQuality(q)}
                  className={`px-3 py-1 rounded-lg text-xs transition-colors ${
                    q === currentQuality
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-white/10 text-white/80 hover:bg-white/20'
                  }`}
                >
                  {MV_QUALITY_LABELS[q]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 该来源无可用画质 */}
        {currentSource?.qualitiesFetched && availableQualities.length === 0 && !isLoading && (
          <p className="text-white/40 text-xs">该来源暂无可用画质，请尝试切换其他来源</p>
        )}
      </div>
    </div>
  );
}

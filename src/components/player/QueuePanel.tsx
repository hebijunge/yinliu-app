import { useEffect, useRef, useState } from 'react';
import { X, Trash2, ChevronUp, ChevronDown, Play, GripVertical } from 'lucide-react';
import { usePlayerStore } from '../../shared/store/playerStore';
import { playerEngine } from '../../core/player';
import { useGuardedAction } from '../../shared/hooks/useGuardedAction';

interface Props {
  onClose: () => void;
}

export default function QueuePanel({ onClose }: Props) {
  const { queue, currentIndex } = usePlayerStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Auto-scroll to current track
  useEffect(() => {
    const el = itemRefs.current[currentIndex];
    const container = scrollRef.current;
    if (el && container) {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const relativeTop = elRect.top - containerRect.top;
      const target = container.scrollTop + relativeTop - containerRect.height / 3;
      container.scrollTo({ top: target, behavior: 'smooth' });
    }
  }, [currentIndex]);

  const handlePlay = (index: number) => {
    usePlayerStore.getState().playTrackAtIndex(index);
    const track = queue[index];
    if (track) {
      // 使用播放器当前音质（与设置页音质偏好同一持久化）
      playerEngine.playTrack(track, usePlayerStore.getState().currentQuality).catch(() => {
        // 错误已经由 error 事件上报
      });
    }
  };

  const handleRemove = (index: number) => {
    usePlayerStore.getState().removeFromQueue(index);
  };

  const handleMoveUp = (index: number) => {
    if (index > 0) {
      usePlayerStore.getState().moveQueueItem(index, index - 1);
    }
  };

  const handleMoveDown = (index: number) => {
    if (index < queue.length - 1) {
      usePlayerStore.getState().moveQueueItem(index, index + 1);
    }
  };

  // E4：清空队列入口守卫——进行中禁用 + 300ms 防抖
  const doClear = () => {
    usePlayerStore.getState().clearQueue();
  };
  const { run: handleClear } = useGuardedAction(doClear);

  const handleDragStart = (index: number) => {
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    usePlayerStore.getState().moveQueueItem(dragIndex, index);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] bg-[var(--bg-secondary)] rounded-t-[2rem] shadow-lg border-t border-[var(--border-subtle)] max-h-[70vh] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-subtle)]">
        <div>
          <h3 className="font-semibold text-[var(--text-primary)]">播放队列</h3>
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{queue.length} 首歌曲</p>
        </div>
        <div className="flex items-center gap-2">
          {queue.length > 0 && (
            <button
              onClick={handleClear}
              className="p-2 rounded-xl hover:bg-red-500/10 text-[var(--text-tertiary)] hover:text-red-400 transition-colors focus-ring"
              title="清空队列"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] transition-colors focus-ring"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* List */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2 scrollbar-hide">
        {queue.length === 0 ? (
          <div className="text-center py-12 text-[var(--text-tertiary)] text-sm">
            队列为空，从搜索结果中添加歌曲
          </div>
        ) : (
          <div className="space-y-1">
            {queue.map((track, index) => {
              const isCurrent = index === currentIndex;
              return (
                <div
                  key={`${track.id}-${index}`}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  draggable={!isCurrent}
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={() => handleDrop(index)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
                    isCurrent
                      ? 'bg-[var(--accent-soft)]'
                      : dragOverIndex === index
                      ? 'bg-[var(--accent-soft)]/50'
                      : 'hover:bg-[var(--bg-tertiary)]'
                  } ${dragIndex === index ? 'opacity-50' : ''}`}
                >
                  {/* Drag handle / Index / Playing indicator */}
                  <div className="w-6 flex-shrink-0 text-center">
                    {!isCurrent ? (
                      <div className="flex items-center justify-center h-4 cursor-grab active:cursor-grabbing" title="拖动排序">
                        <GripVertical className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                      </div>
                    ) : (
                      <div className="flex items-end justify-center gap-[2px] h-4">
                        <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[bounce_0.6s_ease-in-out_infinite]" style={{ height: '40%', animationDelay: '0ms' }} />
                        <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[bounce_0.6s_ease-in-out_infinite]" style={{ height: '70%', animationDelay: '150ms' }} />
                        <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[bounce_0.6s_ease-in-out_infinite]" style={{ height: '50%', animationDelay: '300ms' }} />
                      </div>
                    )}
                  </div>

                  {/* Track info */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => handlePlay(index)}
                  >
                    <div className={`text-sm truncate ${isCurrent ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-primary)]'}`}>
                      {track.title}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)] truncate">
                      {track.artist || '未知歌手'}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0}
                      className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] disabled:opacity-30 transition-colors focus-ring"
                      title="上移"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleMoveDown(index)}
                      disabled={index === queue.length - 1}
                      className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] disabled:opacity-30 transition-colors focus-ring"
                      title="下移"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    {!isCurrent && (
                      <button
                        onClick={() => handleRemove(index)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-[var(--text-tertiary)] hover:text-red-400 transition-colors focus-ring"
                        title="移除"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Play button on hover */}
                  {!isCurrent && (
                    <button
                      onClick={() => handlePlay(index)}
                      className="p-1.5 rounded-full bg-[var(--accent)] text-white opacity-0 hover:opacity-100 transition-opacity focus-ring"
                      title="播放"
                    >
                      <Play className="w-3 h-3 ml-0.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

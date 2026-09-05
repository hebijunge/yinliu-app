import { MoreVertical } from 'lucide-react';
import { memo } from 'react';
import { SOURCE_COLORS } from './sourceColors';
import { PLATFORM_SHORT_NAMES } from '../../core/platformPriority';
import { usePlayerStore } from '@shared/store/playerStore';
import SmartCover from '../ui/SmartCover';
import type { AggregatedSearchResult } from '@core/search';

/**
 * D9: 行数据契约直接复用聚合搜索结果类型 ——
 * 所有列表页传的就是 AggregatedSearchResult，收敛为别名后
 * 页面可把 handlePlay / setState 直传给行组件（类型自洽 + 引用稳定），
 * 配合 memo 让父组件重渲染不再连带全列表重绘。
 */
export type SongRowData = AggregatedSearchResult;

interface SongRowProps {
  song: SongRowData;
  onPlay: (song: SongRowData) => void;
  /** ⋮ 更多按钮回调（打开音质弹窗） */
  onMore: (song: SongRowData) => void;
}

/**
 * 统一歌曲行（v18）：与搜索列表展示完全一致，
 * 供 首页热歌榜 / 曲库榜单 / 曲库歌单 / 搜索结果 复用。
 * 整行点击播放；右侧 ⋮ 打开音质弹窗。
 */
function SongRowImpl({ song, onPlay, onMore }: SongRowProps) {
  // v23：标识「正在播放」曲目 —— 与播放器当前曲目按 sourceSongId+sourceId（兜底 id）比对
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isCurrentTrack = !!currentTrack && (
    song.sourceSongId
      ? currentTrack.sourceSongId === song.sourceSongId
        && (!song.sourceId || currentTrack.sourceId === song.sourceId)
      : currentTrack.id === song.id
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPlay(song)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay(song);
        }
      }}
      className={`relative flex items-center gap-3 p-3 rounded-lg w-full hover:bg-[var(--bg-tertiary)] transition-all duration-150 cursor-pointer active:scale-[0.97] active:bg-[var(--bg-tertiary)] ${
        isCurrentTrack
          ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
          : 'bg-[var(--bg-secondary)]'
      }`}
    >
      <div className="w-12 h-12 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden">
        <SmartCover src={song.coverUrl} className="w-full h-full" />
      </div>

      <div className="flex-1 min-w-0">
        <div className={`font-medium truncate flex items-center gap-1.5 ${isCurrentTrack ? 'text-[var(--accent)]' : ''}`}>
          {isCurrentTrack && (
            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-label="正在播放">
              <rect x="1" y="6" width="2.5" height="4" rx="1"><animate attributeName="height" values="2;7;2" dur="0.9s" repeatCount="indefinite"/><animate attributeName="y" values="7;4.5;7" dur="0.9s" repeatCount="indefinite"/></rect>
              <rect x="6.5" y="4" width="2.5" height="8" rx="1"><animate attributeName="height" values="8;3;8" dur="0.9s" repeatCount="indefinite"/><animate attributeName="y" values="4;6.5;4" dur="0.9s" repeatCount="indefinite"/></rect>
              <rect x="12" y="6" width="2.5" height="4" rx="1"><animate attributeName="height" values="3;7;3" dur="0.9s" repeatCount="indefinite"/><animate attributeName="y" values="6.5;4.5;6.5" dur="0.9s" repeatCount="indefinite"/></rect>
            </svg>
          )}
          <span className="truncate">{song.title}</span>
        </div>
        <div className="text-sm text-[var(--text-secondary)] truncate">
          {song.artist} {song.album && `· ${song.album}`}
        </div>
        {/* D5: 徽章行 flex-wrap + overflow-hidden，4 个源时小屏不撑破行宽 */}
        <div className="flex flex-wrap gap-1 mt-1 min-w-0 max-w-full overflow-hidden">
          {(song.sources || []).map((s) => (
            <span
              key={s.sourceId}
              className={`text-[10px] px-1.5 py-0.5 rounded text-white ${SOURCE_COLORS[s.sourceId] || 'bg-gray-500'}`}
            >
              {PLATFORM_SHORT_NAMES[s.sourceId] || s.sourceName}
            </span>
          ))}
        </div>
      </div>

      <div className="text-xs text-[var(--text-tertiary)] hidden sm:block">
        {song.bitrate && `${song.bitrate}kbps`}
      </div>

      {/* ⋮ 更多按钮：打开音质弹窗 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMore(song);
        }}
        className="p-2 rounded-full flex-shrink-0 text-[var(--text-tertiary)] hover:bg-[var(--border)] hover:text-[var(--text-primary)]"
        title="更多"
        aria-label="更多操作"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
    </div>
  );
}


/** D9: memo 化 —— song 引用与回调稳定时，父组件重渲染不触发本行重绘 */
export default memo(SongRowImpl);

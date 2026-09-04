import { Music, MoreVertical } from 'lucide-react';
import { SOURCE_COLORS } from './sourceColors';
import { PLATFORM_SHORT_NAMES } from '../../core/platformPriority';
import { usePlayerStore } from '@shared/store/playerStore';
import SmartCover from '../ui/SmartCover';

export interface SongRowData {
  id: string;
  /** 当前播放判定：聚合结果带 sourceSongId/sourceId，优先用二者与播放器当前曲目比对 */
  sourceSongId?: string;
  sourceId?: string;
  title: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  bitrate?: number;
  /** 源徽章（展示优先级顺序已在聚合层排好） */
  sources: { sourceId: string; sourceName: string }[];
}

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
export default function SongRow({ song, onPlay, onMore }: SongRowProps) {
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
      className={`relative flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-tertiary)] transition-all duration-150 cursor-pointer active:scale-[0.97] active:bg-[var(--bg-tertiary)] ${
        isCurrentTrack
          ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
          : 'bg-[var(--bg-secondary)]'
      }`}
    >
      <div className="w-12 h-12 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden">
        <SmartCover src={song.coverUrl} />
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
        <div className="flex gap-1 mt-1">
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

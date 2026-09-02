import { useState } from 'react';
import { Music, MoreVertical } from 'lucide-react';
import { SOURCE_COLORS } from './sourceColors';
import { PLATFORM_SHORT_NAMES } from '../../core/platformPriority';

/** v16 封面加载失败兜底：死链/防盗链图片自动回退占位图标，避免空白块 */
function CoverImg({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export interface SongRowData {
  id: string;
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
      className="relative flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer active:scale-[0.99]"
    >
      <div className="w-12 h-12 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden">
        <CoverImg src={song.coverUrl || ''} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{song.title}</div>
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

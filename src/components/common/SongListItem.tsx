import { useState, useRef, useEffect } from 'react';
import { Music, MoreVertical, Play } from 'lucide-react';
import { PLATFORM_ABBREVS, PLATFORM_COLORS } from '@core/platformPriority';
import type { AggregatedSearchResult } from '@core/search';
import type { AggregatedSearchSource } from '@core/search';

export interface SongListItemProps {
  result: AggregatedSearchResult;
  index?: number;
  showIndex?: boolean;
  onPlay: (result: AggregatedSearchResult) => void;
  onMore?: (result: AggregatedSearchResult, anchorEl: HTMLElement) => void;
  extraAction?: React.ReactNode;
}

/** 按「支持源越多越靠前，同源数按 qi→kw→mg→wy→qq→kg」排序的权重 */
const DISPLAY_PRIORITY: Record<string, number> = {
  qishui: 0,
  kuwo: 1,
  migu: 2,
  netease: 3,
  qq: 4,
  kugou: 5,
};

function getDisplayPriority(sourceId: string): number {
  return DISPLAY_PRIORITY[sourceId] ?? 99;
}

function sortSourcesForDisplay(sources: AggregatedSearchSource[]): AggregatedSearchSource[] {
  return [...sources].sort((a, b) => getDisplayPriority(a.sourceId) - getDisplayPriority(b.sourceId));
}

export default function SongListItem({
  result,
  index,
  showIndex = false,
  onPlay,
  onMore,
  extraAction,
}: SongListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const displaySources = sortSourcesForDisplay(result.sources);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPlay(result)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay(result);
        }
      }}
      className="relative flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer active:scale-[0.99] group"
    >
      {/* 序号 / 封面 */}
      {showIndex && index !== undefined ? (
        <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
          <span className={`text-sm font-semibold ${index <= 3 ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'}`}>
            {index}
          </span>
        </div>
      ) : null}

      <div className="w-12 h-12 rounded-xl bg-[var(--bg-tertiary)] flex-shrink-0 overflow-hidden relative">
        {result.coverUrl ? (
          <img src={result.coverUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music className="w-5 h-5 text-[var(--text-tertiary)]" />
          </div>
        )}
        {/* hover 播放图标 */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
          <Play className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-medium truncate text-[var(--text-primary)]">{result.title}</div>
        <div className="text-sm text-[var(--text-secondary)] truncate">
          {result.artist} {result.album && `· ${result.album}`}
        </div>
        <div className="flex gap-1 mt-1 flex-wrap">
          {displaySources.map((s) => (
            <span
              key={s.sourceId}
              className={`text-[10px] px-1.5 py-0.5 rounded text-white ${PLATFORM_COLORS[s.sourceId] || 'bg-gray-500'}`}
            >
              {PLATFORM_ABBREVS[s.sourceId] || s.sourceId}
            </span>
          ))}
        </div>
      </div>

      {/* 码率 */}
      <div className="text-xs text-[var(--text-tertiary)] hidden sm:block">
        {result.bitrate && `${result.bitrate}kbps`}
      </div>

      {/* 额外操作区 */}
      {extraAction && <div className="flex-shrink-0">{extraAction}</div>}

      {/* 「更多」菜单 */}
      <div className="relative flex-shrink-0" ref={menuRef}>
        <button
          ref={menuBtnRef}
          onClick={(e) => {
            e.stopPropagation();
            if (onMore) {
              onMore(result, e.currentTarget);
            } else {
              setMenuOpen(!menuOpen);
            }
          }}
          className="p-2 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--border)] hover:text-[var(--text-primary)]"
          title="更多"
          aria-label="更多操作"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && !onMore && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-full mt-1 z-20 min-w-[140px] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated,var(--bg-secondary))] shadow-lg overflow-hidden"
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                // 默认行为：触发播放（已由整行 click 处理，这里兜底）
                onPlay(result);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
            >
              <Play className="w-4 h-4" />
              播放
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from 'react';
import { Music, MoreVertical, Play, ChevronDown, ChevronUp } from 'lucide-react';
import SmartCover from '../ui/SmartCover';
import { PLATFORM_ABBREVS, PLATFORM_COLORS } from '@core/platformPriority';
import type { AggregatedSearchResult } from '@core/search';
import type { AggregatedSearchSource } from '@core/search';

export interface SongListItemProps {
  result: AggregatedSearchResult;
  index?: number;
  showIndex?: boolean;
  onPlay: (result: AggregatedSearchResult, sourceId?: string) => void;
  onMore?: (result: AggregatedSearchResult, anchorEl: HTMLElement) => void;
  extraAction?: React.ReactNode;
  /** 是否启用「主条目 + 可展开子条目」模式（搜索同曲归并场景） */
  expandable?: boolean;
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

/** 从 quality 值生成可读标签 */
function formatQualityLabel(maxQuality?: string): string {
  if (!maxQuality) return '';
  const map: Record<string, string> = {
    standard: '标准',
    high: '高品',
    lossless: '无损',
    hires: 'Hi-Res',
  };
  return map[maxQuality] || maxQuality;
}

export default function SongListItem({
  result,
  index,
  showIndex = false,
  onPlay,
  onMore,
  extraAction,
  expandable = false,
}: SongListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
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
  const hasMultipleSources = result.sources.length > 1;
  const bestSource = displaySources[0];

  const handleRowClick = () => {
    onPlay(result, bestSource?.sourceId);
  };

  const handleSourcePlay = (e: React.MouseEvent, sourceId: string) => {
    e.stopPropagation();
    onPlay(result, sourceId);
  };

  return (
    <div className="rounded-xl bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] last:border-b-0 overflow-hidden">
      {/* ===== 主条目 ===== */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleRowClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleRowClick();
          }
        }}
        className="relative flex items-center gap-3 p-3 hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer active:scale-[0.99] group"
        style={{ minHeight: '64px' }}
      >
        {/* 序号 / 封面 */}
        {showIndex && index !== undefined ? (
          <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
            <span className={`text-sm font-semibold ${index <= 3 ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'}`}>
              {index}
            </span>
          </div>
        ) : null}

        {/* 封面 48×48 dp，圆角 4 dp */}
        <div className="w-12 h-12 rounded flex-shrink-0 overflow-hidden relative bg-[var(--bg-tertiary)]">
          <SmartCover src={result.coverUrl} />
          {/* hover 播放图标 */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
            <Play className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>

        {/* 歌曲信息 */}
        <div className="flex-1 min-w-0">
          {/* 歌曲名 16 sp 主色 */}
          <div className="font-medium truncate text-[var(--text-primary)]" style={{ fontSize: '16px' }}>
            {result.title}
          </div>
          {/* 歌手名 13 sp 灰色 */}
          <div className="truncate text-[var(--text-secondary)]" style={{ fontSize: '13px' }}>
            {result.artist} {result.album && `· ${result.album}`}
          </div>
          {/* 来源标签区 */}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {/* 优先展示最佳源 */}
            {bestSource && (
              <span
                className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full text-white font-medium ${PLATFORM_COLORS[bestSource.sourceId] || 'bg-gray-500'}`}
              >
                {PLATFORM_ABBREVS[bestSource.sourceId] || bestSource.sourceId}
              </span>
            )}
            {/* 展开按钮 / 多源计数 */}
            {expandable && hasMultipleSources && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
                className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)] transition-colors"
              >
                {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {result.sources.length} 个来源
              </button>
            )}
            {/* 非展开模式下展示其余源标签（最多再展示2个） */}
            {!expandable && displaySources.slice(1, 3).map((s) => (
              <span
                key={s.sourceId}
                className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full text-white font-medium ${PLATFORM_COLORS[s.sourceId] || 'bg-gray-500'}`}
              >
                {PLATFORM_ABBREVS[s.sourceId] || s.sourceId}
              </span>
            ))}
            {!expandable && displaySources.length > 3 && (
              <span className="text-[10px] text-[var(--text-tertiary)]">
                +{displaySources.length - 3}
              </span>
            )}
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
            style={{ minWidth: '40px', minHeight: '40px' }}
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

      {/* ===== 展开子条目（各源详情） ===== */}
      {expandable && expanded && hasMultipleSources && (
        <div className="px-3 pb-3">
          <div className="ml-14 space-y-1">
            {displaySources.map((source) => (
              <div
                key={source.sourceId}
                role="button"
                tabIndex={0}
                onClick={(e) => handleSourcePlay(e, source.sourceId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPlay(result, source.sourceId);
                  }
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] cursor-pointer transition-colors"
              >
                <span
                  className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full text-white font-medium ${PLATFORM_COLORS[source.sourceId] || 'bg-gray-500'}`}
                >
                  {PLATFORM_ABBREVS[source.sourceId] || source.sourceId}
                </span>
                <span className="text-sm text-[var(--text-primary)] flex-1 truncate">
                  {source.sourceName}
                </span>
                <span className="text-xs text-[var(--text-tertiary)]">
                  {formatQualityLabel(source.maxQuality)}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${source.available ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {source.available ? '可用' : '不可用'}
                </span>
                <Play className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

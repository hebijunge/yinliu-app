import { useEffect, useState } from 'react';
import { lyricsManager } from '@modules/music/lyrics';
import type { ParsedLyrics } from '@modules/music/lyrics';

/**
 * v29-A7: 歌词加载 hook —— 统一 PlayerBar / FullScreenPlayer 的复制粘贴实现
 * （两处代码 60% 重复），并内置 cancelled 标记修复歌词加载竞态：
 * 快速切歌时上一首的迟到歌词响应不会写入状态、覆盖新歌歌词。
 * 同时补上旧实现缺失的 .catch，取词失败时回落为 null 而非 unhandled rejection。
 */
export function useLyrics(
  track: {
    sourceSongId: string;
    sourceId: string;
    title?: string;
    artist?: string;
  } | null | undefined
): ParsedLyrics | null {
  const [lyrics, setLyrics] = useState<ParsedLyrics | null>(null);
  const sourceSongId = track?.sourceSongId;
  const sourceId = track?.sourceId;
  // C4: 跨源回退需要 title/artist 做搜索命中校验，由调用方透传
  const title = track?.title;
  const artist = track?.artist;

  useEffect(() => {
    if (!sourceSongId || !sourceId) {
      setLyrics(null);
      return;
    }
    let cancelled = false;
    lyricsManager
      .getLyrics(sourceSongId, sourceId, { title: title || '', artist })
      .then((parsed) => {
        if (!cancelled) setLyrics(parsed);
      })
      .catch(() => {
        if (!cancelled) setLyrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceSongId, sourceId, title, artist]);

  return lyrics;
}

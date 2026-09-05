import { sourceRegistry } from '@providers/music/registry';

/**
 * 歌词行数据结构
 */
export interface LyricLine {
  time: number;      // 时间（秒）
  text: string;      // 歌词文本
  translation?: string; // 翻译文本
}

/**
 * 解析后的歌词数据
 */
export interface ParsedLyrics {
  lines: LyricLine[];
  hasTranslation: boolean;
  source: string;
}

/**
 * 歌词管理器
 * 功能：搜索获取歌词、LRC解析、时间轴匹配、同步显示
 */
export class LyricsManager {
  private cache = new Map<string, ParsedLyrics>();
  /** F6(v27 P2-1)：同曲歌词在途请求去重（single-flight），避免重复网络请求 */
  private pending = new Map<string, Promise<ParsedLyrics | null>>();

  /**
   * 获取歌曲歌词
   * 优先从当前播放源获取，失败则尝试其他源。
   * C4: 跨源回退必须先按 title+artist 在目标平台搜索并确认命中，再用命中 id 取词；
   * 禁止把原平台 songId 直接喂给其他源（不同源 id 体系不互通，会取到错词并写入缓存）。
   * 命中失败不写缓存。
   */
  async getLyrics(
    songId: string,
    sourceId: string,
    track?: { title: string; artist?: string }
  ): Promise<ParsedLyrics | null> {
    const cacheKey = `${sourceId}_${songId}`;

    // 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // F6(v27)：single-flight —— 同曲歌词请求在途时直接复用，不重复发起
    const pending = this.pending.get(cacheKey);
    if (pending) return pending;

    const task = this.fetchLyrics(songId, sourceId, cacheKey, track).finally(() => {
      this.pending.delete(cacheKey);
    });
    this.pending.set(cacheKey, task);
    return task;
  }

  private async fetchLyrics(
    songId: string,
    sourceId: string,
    cacheKey: string,
    track?: { title: string; artist?: string }
  ): Promise<ParsedLyrics | null> {
    // 从指定源获取
    const source = sourceRegistry.get(sourceId);
    if (source && source.getLyrics) {
      try {
        const lrcText = await source.getLyrics(songId);
        if (lrcText) {
          const parsed = this.parseLrc(lrcText, source.name);
          this.cache.set(cacheKey, parsed);
          return parsed;
        }
      } catch {
        // 继续尝试其他源
      }
    }

    // 尝试从其他源获取歌词（C4: 搜索验证式回退 —— 先搜索命中再用命中 id 取词）
    const fallbackSources = ['netease', 'kugou', 'kuwo'];
    for (const fallbackId of fallbackSources) {
      if (fallbackId === sourceId) continue;
      const fallbackSource = sourceRegistry.get(fallbackId);
      if (!fallbackSource?.getLyrics) continue;

      try {
        let fallbackSongId: string | null = null;

        if (track?.title && typeof fallbackSource.search === 'function') {
          // 1) 先按「歌名 歌手」在目标平台搜索
          const hits = await fallbackSource.search({
            keyword: `${track.title} ${track.artist || ''}`.trim(),
            type: 'song',
            pageSize: 10,
          });
          const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, '');
          // 2) 歌名精确命中优先，其次前缀命中（允许少量后缀差异）；命中失败 → 跳过该源，绝不写缓存
          const hit =
            hits.find((r) => r.type === 'song' && norm(r.title) === norm(track.title)) ||
            hits.find((r) => r.type === 'song' && norm(r.title).startsWith(norm(track.title)) && norm(r.title).length - norm(track.title).length <= 4);
          if (hit) fallbackSongId = hit.sourceSongId;
        }

        if (!fallbackSongId) continue;

        const lrcText = await fallbackSource.getLyrics(fallbackSongId);
        if (lrcText) {
          const parsed = this.parseLrc(lrcText, fallbackSource.name);
          // C4: 只以目标平台自己的 songId 作缓存键，避免错键/错词污染原始键
          this.cache.set(`${fallbackId}_${fallbackSongId}`, parsed);
          return parsed;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 解析LRC格式歌词
   */
  parseLrc(lrcText: string, source: string): ParsedLyrics {
    const lines: LyricLine[] = [];
    const timeTagRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;

    const rawLines = lrcText.split('\n');

    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (!line) continue;

      // 提取所有时间标签
      const timeTags: number[] = [];
      let match;
      let textStart = 0;

      while ((match = timeTagRegex.exec(line)) !== null) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const millis = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
        timeTags.push(minutes * 60 + seconds + millis / 1000);
        textStart = match.index + match[0].length;
      }

      // 重置正则
      timeTagRegex.lastIndex = 0;

      if (timeTags.length === 0) {
        // 可能是元数据行（[ti:xxx]、[ar:xxx]等）或翻译行
        if (line.startsWith('[') && line.includes(':')) {
          // 元数据行，跳过
          continue;
        }
        continue;
      }

      // 提取歌词文本
      const text = line.slice(textStart).trim();
      if (!text) continue;

      // 为每个时间标签创建一行
      for (const time of timeTags) {
        lines.push({ time, text });
      }
    }

    // 按时间排序
    lines.sort((a, b) => a.time - b.time);

    // 检测是否有翻译（通过重复时间标签的文本）
    const hasTranslation = this.detectTranslation(lines);

    return {
      lines,
      hasTranslation,
      source,
    };
  }

  /**
   * 检测歌词是否包含翻译
   * 策略：检查是否存在时间非常接近但文本不同的行
   */
  private detectTranslation(lines: LyricLine[]): boolean {
    for (let i = 1; i < lines.length; i++) {
      if (Math.abs(lines[i].time - lines[i - 1].time) < 0.1) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取当前时间对应的歌词行索引
   */
  getCurrentLineIndex(lyrics: ParsedLyrics, currentTime: number): number {
    const { lines } = lyrics;
    if (lines.length === 0) return -1;

    // 二分查找当前行
    let left = 0;
    let right = lines.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (lines[mid].time <= currentTime) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return right;
  }

  /**
   * 获取当前时间附近的歌词行（用于滚动显示）
   */
  getVisibleLines(lyrics: ParsedLyrics, currentTime: number, contextLines: number = 3): LyricLine[] {
    const currentIndex = this.getCurrentLineIndex(lyrics, currentTime);
    if (currentIndex === -1) return [];

    const start = Math.max(0, currentIndex - contextLines);
    const end = Math.min(lyrics.lines.length, currentIndex + contextLines + 1);

    return lyrics.lines.slice(start, end);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}

export const lyricsManager = new LyricsManager();

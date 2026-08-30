import { sourceRegistry } from '@providers/music/registry';
import type { PlaylistDetail } from '@core/types';
import { YinliuError, ErrorCode } from '@core/types';

/**
 * 支持的歌单URL平台
 */
export type SupportedPlatform = 'qq' | 'netease' | 'kugou' | 'kuwo' | 'migu' | 'spotify';

export interface ParsedPlaylistInfo {
  platform: SupportedPlatform;
  playlistId: string;
  url: string;
}

export interface ImportResult {
  playlist: PlaylistDetail;
  platform: SupportedPlatform;
  matched: number;
  unmatched: number;
  errors: string[];
}

/**
 * 多平台歌单URL解析导入器
 * 支持：QQ音乐/网易云/酷狗/酷我/咪咕/Spotify
 */
export class PlaylistImporter {
  /**
   * URL正则匹配规则
   */
  private readonly urlPatterns: Array<{
    platform: SupportedPlatform;
    patterns: RegExp[];
  }> = [
    {
      platform: 'qq',
      patterns: [
        /y\.qq\.com.*playlist[\/](\d+)/,
        /y\.qq\.com.*n\/ryqq\/playlist\/(\d+)/,
        /i\.y\.qq\.com.*id=(\d+)/,
      ],
    },
    {
      platform: 'netease',
      patterns: [
        /music\.163\.com.*playlist[\/\?].*id=(\d+)/,
        /music\.163\.com.*#\/playlist\?id=(\d+)/,
        /163cn\.tv\/(\w+)/,
      ],
    },
    {
      platform: 'kugou',
      patterns: [
        /kugou\.com.*special[\/]single[\/](\d+)/,
        /kugou\.com.*yy\/special\/single\/(\d+)/,
      ],
    },
    {
      platform: 'kuwo',
      patterns: [
        /kuwo\.cn.*playlist_detail\/(\d+)/,
        /kuwo\.cn.*playlists\/(\d+)/,
      ],
    },
    {
      platform: 'migu',
      patterns: [
        /migu\.cn.*playlist[\/](\d+)/,
        /music\.migu\.cn.*playlist\/(\d+)/,
      ],
    },
    {
      platform: 'spotify',
      patterns: [
        /open\.spotify\.com\/playlist\/(\w+)/,
        /spotify\.com\/playlist\/(\w+)/,
      ],
    },
  ];

  /**
   * 解析歌单URL
   */
  parseUrl(url: string): ParsedPlaylistInfo | null {
    for (const { platform, patterns } of this.urlPatterns) {
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
          return {
            platform,
            playlistId: match[1],
            url,
          };
        }
      }
    }
    return null;
  }

  /**
   * 导入歌单
   */
  async importPlaylist(url: string): Promise<ImportResult> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      throw new YinliuError(
        ErrorCode.VALIDATION_ERROR,
        '不支持的歌单URL格式，目前支持：QQ音乐、网易云、酷狗、酷我、咪咕、Spotify',
        400
      );
    }

    const source = sourceRegistry.get(parsed.platform);
    if (!source) {
      throw new YinliuError(
        ErrorCode.SOURCE_UNAVAILABLE,
        `未找到${parsed.platform}音源Provider`,
        403
      );
    }

    if (!source.parsePlaylistUrl) {
      throw new YinliuError(
        ErrorCode.SOURCE_UNAVAILABLE,
        `${source.name}暂不支持歌单导入`,
        403
      );
    }

    try {
      const playlist = await source.parsePlaylistUrl(url);

      // 统计匹配/不匹配
      const matched = playlist.songs.length;
      const unmatched = 0;
      const errors: string[] = [];

      return {
        playlist,
        platform: parsed.platform,
        matched,
        unmatched,
        errors,
      };
    } catch (err) {
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(
        ErrorCode.SOURCE_ERROR,
        `导入歌单失败: ${err instanceof Error ? err.message : '未知错误'}`,
        502
      );
    }
  }

  /**
   * 批量导入歌单
   */
  async importBatch(urls: string[]): Promise<ImportResult[]> {
    const results: ImportResult[] = [];
    const errors: Array<{ url: string; error: string }> = [];

    for (const url of urls) {
      try {
        const result = await this.importPlaylist(url);
        results.push(result);
      } catch (err) {
        errors.push({
          url,
          error: err instanceof Error ? err.message : '导入失败',
        });
      }
    }

    if (errors.length > 0 && results.length === 0) {
      throw new YinliuError(
        ErrorCode.SOURCE_ERROR,
        `所有歌单导入失败: ${errors.map((e) => `${e.url}: ${e.error}`).join('; ')}`,
        502
      );
    }

    return results;
  }

  /**
   * 检查URL是否支持
   */
  isSupported(url: string): boolean {
    return this.parseUrl(url) !== null;
  }

  /**
   * 获取支持的平台列表
   */
  getSupportedPlatforms(): Array<{ id: SupportedPlatform; name: string }> {
    return [
      { id: 'qq', name: 'QQ音乐' },
      { id: 'netease', name: '网易云音乐' },
      { id: 'kugou', name: '酷狗音乐' },
      { id: 'kuwo', name: '酷我音乐' },
      { id: 'migu', name: '咪咕音乐' },
      { id: 'spotify', name: 'Spotify' },
    ];
  }
}

export const playlistImporter = new PlaylistImporter();

import { sourceRegistry } from '@providers/music/registry';
import { playlistService } from '@shared/services/PlaylistService';
import { playlistMatcher, type MatchReport, type MatchedTrack } from './playlistMatcher';
import type { PlaylistDetail, SearchResult } from '@core/types';
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

/** 导入报告：用于 UI 展示 */
export interface ImportReport {
  /** 新建的歌单 ID（已持久化到本地） */
  playlistId: string;
  /** 导入的歌单元信息（来自源平台） */
  sourcePlaylist: PlaylistDetail;
  /** 匹配降级报告（每首曲目状态） */
  match: MatchReport;
  /** UI 提示用平台名 */
  platformName: string;
}

/** 仅解析 + 返回的旧 API（不落库），用于预览 */
export interface PreviewResult {
  playlist: PlaylistDetail;
  platform: SupportedPlatform;
  matched: number;
  unmatched: number;
  errors: string[];
}

/**
 * 多平台歌单URL解析导入器
 * 支持：QQ音乐/网易云/酷狗/酷我/咪咕
 *
 * v14 强化：
 * - 每首曲目走 PlaylistMatcher 做取链探活 + 跨平台降级匹配
 * - 全部歌曲入库到本地 sql.js（playlist_songs 表）
 * - 失败曲目不阻塞导入，标 failureReason 供 UI 灰显
 */
export class PlaylistImporter {
  private readonly urlPatterns: Array<{
    platform: SupportedPlatform;
    patterns: RegExp[];
  }> = [
    {
      platform: 'qq',
      patterns: [
        /y\.qq\.com.*playlist[\/](\d+)/,
        /y\.qq\.com.*n\/ryqq\/playlist\/(\d+)/,
        /i2?\.y\.qq\.com.*id=(\d+)/,
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
        /kugou\.com.*songlist[\/]gcid[_]?(\w+)/,
      ],
    },
    {
      platform: 'kuwo',
      patterns: [
        /kuwo\.cn.*playlist_detail\/(\d+)/,
        /kuwo\.cn.*playlists\/(\d+)/,
        /kuwo\.cn.*newh5app\/playlist_detail\/(\d+)/,
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
   * 从整段分享文本中提取 URL（含前缀、标题、@后缀等噪音）
   */
  extractUrl(raw: string): string {
    // 先检测汽水音乐并保留原样，让上层抛明确提示
    if (/qishui\.douyin\.com/i.test(raw)) return raw;
    // 匹配 http/https URL
    const urlMatch = raw.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) return urlMatch[1];
    // 纯数字歌单码（酷狗）
    if (/^\d{6,10}$/.test(raw.trim())) return raw.trim();
    return raw;
  }

  parseUrl(url: string): ParsedPlaylistInfo | null {
    // 汽水音乐：明确提示不支持
    if (/qishui\.douyin\.com/i.test(url)) {
      throw new YinliuError(
        ErrorCode.VALIDATION_ERROR,
        '暂不支持汽水音乐歌单导入',
        400
      );
    }
    // 酷狗纯数字歌单码（6-10位）
    const numericCode = url.trim().match(/^(\d{6,10})$/);
    if (numericCode) {
      return { platform: 'kugou', playlistId: numericCode[1], url };
    }
    for (const { platform, patterns } of this.urlPatterns) {
      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
          return { platform, playlistId: match[1], url };
        }
      }
    }
    return null;
  }

  /**
   * 仅解析歌单并返回元信息（不落库）—— 用于导入前预览
   */
  async preview(raw: string): Promise<PreviewResult> {
    const url = this.extractUrl(raw);
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
      return {
        playlist,
        platform: parsed.platform,
        matched: playlist.songs.length,
        unmatched: 0,
        errors: [],
      };
    } catch (err) {
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(
        ErrorCode.SOURCE_ERROR,
        `预览歌单失败: ${err instanceof Error ? err.message : '未知错误'}`,
        502
      );
    }
  }

  /**
   * 完整导入：解析 → 匹配降级 → 落库
   *
   * 落库策略：
   * - 新建本地歌单（名：{源平台}·{源歌单名}）
   * - 每首曲目（matched/fallback）写入 playlist_songs
   * - 失败曲目不写入；UI 通过 match.tracks[].status 展示
   * - 全部失败也不回滚已写入的曲目（用户至少能拿到部分）
   */
  async importAndPersist(raw: string): Promise<ImportReport> {
    const url = this.extractUrl(raw);
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

    // 1. 抓源歌单
    let sourcePlaylist: PlaylistDetail;
    try {
      sourcePlaylist = await source.parsePlaylistUrl(url);
    } catch (err) {
      if (err instanceof YinliuError) throw err;
      throw new YinliuError(
        ErrorCode.SOURCE_ERROR,
        `解析歌单失败: ${err instanceof Error ? err.message : '未知错误'}`,
        502
      );
    }
    if (!sourcePlaylist.songs || sourcePlaylist.songs.length === 0) {
      throw new YinliuError(
        ErrorCode.SOURCE_ERROR,
        '歌单为空或无法读取曲目',
        422
      );
    }

    // 2. 匹配降级（核心：原平台取链 → 失败搜其他平台）
    const match = await playlistMatcher.matchAll(sourcePlaylist, { concurrency: 4 });

    // 3. 创建本地歌单
    const localName = `${source.name}·${sourcePlaylist.name}`.slice(0, 50);
    const local = await playlistService.createPlaylist(
      localName,
      `导入自 ${source.name}（${match.matched + match.fallback}/${match.total} 首可播放）`
    );

    // 4. 落库：所有曲目都写（包括 failed），失败项标 match_status=failed + failure_reason
    // 这样用户在歌单里能看到完整曲目列表，失败的标灰
    for (const t of match.tracks) {
      const target = t.resolved;
      const status = t.status;
      if (target) {
        // matched / fallback
        await playlistService.addSongToPlaylist(local.id, this.toPlaylistSong(target, status));
      } else {
        // failed：用原始曲目元数据写入，标 status + reason
        await playlistService.addSongToPlaylist(local.id, this.toFailedSong(t.original, t.failureReason || '全平台暂无版权或匹配'));
      }
    }

    return {
      playlistId: local.id,
      sourcePlaylist,
      match,
      platformName: source.name,
    };
  }

  /**
   * 把 SearchResult 转成 playlist_songs 入库形态
   */
  private toPlaylistSong(r: SearchResult, matchStatus: 'matched' | 'fallback' | 'failed' = 'matched') {
    return {
      songId: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      duration: r.duration,
      coverUrl: r.coverUrl,
      source: r.sourceId,
      quality: (r.quality as string) || 'standard',
      matchStatus,
    };
  }

  /**
   * 失败曲目：仍写入歌单（保留元数据），但 matchStatus='failed' + failureReason
   * UI 看到 matchStatus==='failed' 应标灰且禁用播放
   */
  private toFailedSong(r: SearchResult, reason: string) {
    return {
      songId: r.id || `failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: r.title || '未知曲目',
      artist: r.artist,
      album: r.album,
      duration: r.duration,
      coverUrl: r.coverUrl,
      source: r.sourceId || 'unknown',
      quality: 'failed',
      matchStatus: 'failed',
      failureReason: reason,
    };
  }

  isSupported(raw: string): boolean {
    try {
      const url = this.extractUrl(raw);
      return this.parseUrl(url) !== null;
    } catch {
      // 汽水音乐等明确抛错也算“识别到”
      return true;
    }
  }

  getSupportedPlatforms(): Array<{ id: SupportedPlatform; name: string }> {
    return [
      { id: 'qq', name: 'QQ音乐' },
      { id: 'netease', name: '网易云音乐' },
      { id: 'kugou', name: '酷狗音乐' },
      { id: 'kuwo', name: '酷我音乐' },
      { id: 'migu', name: '咪咕音乐' },
    ];
  }
}

export const playlistImporter = new PlaylistImporter();
export type { MatchedTrack };

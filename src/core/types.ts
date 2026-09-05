// === 音质枚举（12档：基础9档 + 酷我至臻2.0/全景声/母带）===
export enum Quality {
  LOW = 'low',
  STANDARD = 'standard',
  HIGHER = 'higher',
  HIGH = 'high',
  LOSSLESS = 'lossless',
  HIRES = 'hires',
  SKY = 'sky',
  JYEFFECT = 'jyeffect',
  HIFI = 'hifi',
  ZHIZHEN = 'zhizhen',
  DOLBY = 'dolby',
  MASTER = 'master',
}

export const QualityRank: Record<Quality, number> = {
  [Quality.LOW]: 1,
  [Quality.STANDARD]: 2,
  [Quality.HIGHER]: 3,
  [Quality.HIGH]: 4,
  [Quality.LOSSLESS]: 5,
  [Quality.HIRES]: 6,
  [Quality.SKY]: 7,
  [Quality.JYEFFECT]: 8,
  [Quality.HIFI]: 9,
  [Quality.ZHIZHEN]: 10,
  [Quality.DOLBY]: 11,
  [Quality.MASTER]: 12,
};

export function qualityRank(q: Quality): number {
  return QualityRank[q] ?? 0;
}

// === 音质弹窗（v18：下载音质多平台弹窗） ===
export type QualityTier = 'master' | 'dolby' | 'zhizhen' | 'hires' | 'lossless' | '320k' | '192k' | '128k';

export const QUALITY_TIER_LABELS: Record<QualityTier, string> = {
  master: '超无损母带',
  dolby: '至臻全景声',
  zhizhen: '至臻音质 2.0',
  hires: 'Hi-Res',
  lossless: '无损',
  '320k': '320K',
  '192k': '192K',
  '128k': '128K',
};

/** 音质分组展示顺序（从高到低） */
export const QUALITY_TIER_ORDER: QualityTier[] = ['master', 'dolby', 'zhizhen', 'hires', 'lossless', '320k', '192k', '128k'];

export function tierToQuality(tier: QualityTier): Quality {
  switch (tier) {
    case 'master': return Quality.MASTER;
    case 'dolby': return Quality.DOLBY;
    case 'zhizhen': return Quality.ZHIZHEN;
    case 'hires': return Quality.HIRES;
    case 'lossless': return Quality.LOSSLESS;
    case '320k': return Quality.HIGH;
    case '192k': return Quality.HIGHER;
    case '128k': return Quality.STANDARD;
  }
}

export function qualityToTier(q: Quality): QualityTier | null {
  const rank = qualityRank(q);
  if (rank >= qualityRank(Quality.MASTER)) return 'master';
  if (rank >= qualityRank(Quality.DOLBY)) return 'dolby';
  if (rank >= qualityRank(Quality.ZHIZHEN)) return 'zhizhen';
  if (rank >= qualityRank(Quality.HIRES)) return 'hires';
  if (rank >= qualityRank(Quality.LOSSLESS)) return 'lossless';
  if (rank >= qualityRank(Quality.HIGH)) return '320k';
  if (rank >= qualityRank(Quality.HIGHER)) return '192k';
  if (rank >= qualityRank(Quality.STANDARD)) return '128k';
  return null;
}

/** 每个音质档位的文件大小（字节） */
export type TierSizes = Partial<Record<QualityTier, number>>;

/** 弹窗中单个可选块：某个源在某个音质档位下的可选下载项 */
export interface QualityOption {
  sourceId: string;
  sourceName: string;
  tier: QualityTier;
  format?: string;
  sizeBytes?: number;
  isPreview?: boolean;
}

// === 搜索相关 ===
export type SearchType = 'song' | 'album' | 'artist' | 'playlist' | 'mv';

export interface SearchParams {
  keyword: string;
  page?: number;
  pageSize?: number;
  type?: SearchType;
}

export interface SearchResult {
  id: string;
  type: SearchType;
  title: string;
  subtitle?: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string;
  sourceId: string;
  sourceSongId: string;
  quality?: Quality;
  bitrate?: number;
  availableQualities?: Quality[];
  /** 各音质档位文件大小（字节），用于音质弹窗展示 */
  sizes?: TierSizes;
  /** MV 播放链接（仅 type='mv' 时使用，单源原始链接） */
  mvUrl?: string;
  /** MV 多源聚合信息（搜索引擎聚合后填充） */
  mvSources?: MvSourceInfo[];
}

export interface SourceAvailability {
  sourceId: string;
  available: boolean;
  maxQuality: Quality;
  requiresAuth: boolean;
  isPreview: boolean;
}

// === 播放相关 ===
export interface PlayUrlResult {
  url: string;
  quality: Quality;
  bitrate: number;
  format: string;
  headers?: Record<string, string>;
  expiresAt?: number;
  isEncrypted?: boolean;
  /** 是否为试听片段（VIP歌曲非会员只能试听30秒等） */
  isPreview?: boolean;
  /** 实际音质是否与请求音质一致 */
  accurate?: boolean;
  /**
   * v25 B6 全源音质诚实性：真实音质档位。
   * 取链成功后经 Content-Length 探测（HEAD/Range）推断，或由源给确定性判定（如 QQ 按 purl 前缀）。
   * 与 quality 不同即「源降级供货」（如标称 Hi-Res 实际 128k）；探测失败时留空（UI 不显示实际档位）。
   */
  actualQuality?: Quality;
  /** v25 B6: 探测到的直链文件大小（字节），支撑真实音质展示与验证 */
  contentLength?: number;
  /** 加密文件的 ekey（酷我 mflac/mgg 需要） */
  ekey?: string;
  /** CENC 解密密钥（汽水音乐 track.php 返回的 decrypt_key） */
  decryptKey?: string;
  /**
   * v21.4: 咪咕 Z3D 解密信息（流式播放/下载时通过 3D60 已知明文攻击提取密钥）
   */
  z3dDecryptInfo?: {
    /** Z3D 加密音频直链 */
    z3dUrl: string;
    /** 3D60 明文试听直链（用于已知明文攻击提取密钥） */
    p3dUrl: string;
  };
}

export interface SongDetail {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string;
  lyrics?: string;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  songs: SearchResult[];
  total: number;
}

export interface Chart {
  id: string;
  name: string;
  description?: string;
}

export interface ChartDetail extends Chart {
  songs: SearchResult[];
}

/** 歌单广场列表项（歌单融合分类用） */

// === MV 画质（v19.2 / v21.0 整合）===
export type MvQuality = '240p' | '480p' | '720p' | '1080p' | '4k';

export const MV_QUALITY_RANK: Record<MvQuality, number> = {
  '240p': 1,
  '480p': 2,
  '720p': 3,
  '1080p': 4,
  '4k': 5,
};

export const MV_QUALITY_LABELS: Record<MvQuality, string> = {
  '240p': '标清 240P',
  '480p': '高清 480P',
  '720p': '超清 720P',
  '1080p': '蓝光 1080P',
  '4k': '4K',
};

/** MV 画质展示顺序（从高到低） */
export const MV_QUALITY_ORDER: MvQuality[] = ['4k', '1080p', '720p', '480p', '240p'];

export function mvQualityRank(q: MvQuality): number {
  return MV_QUALITY_RANK[q] ?? 0;
}

/** MV 播放地址结果 */
export interface MvUrlResult {
  url: string;
  quality: MvQuality;
  size?: number;
  duration?: number;
}

/** MV 单源信息（聚合后使用） */
export interface MvSourceInfo {
  sourceId: string;
  sourceName: string;
  sourceMvId: string;
  /** 该源支持的画质列表（从低到高） */
  availableQualities: MvQuality[];
}

/** MV 详情（独立视频播放页使用） */
export interface MvInfo {
  id: string;
  vid: string;
  title: string;
  artist?: string;
  coverUrl?: string;
  duration?: number;
  sourceId: string;
  availableQualities: MvQuality[];
}

export interface PlaylistSummary {
  id: string;
  title: string;
  coverUrl?: string;
  playCount?: number;
  trackCount?: number;
  creator?: string;
}

export interface HealthStatus {
  healthy: boolean;
  message: string;
  latency?: number;
}

// === 下载相关 ===
export type DownloadStatus = 'pending' | 'downloading' | 'paused' | 'completed' | 'failed';

export interface DownloadTask {
  id: string;
  songId: string;
  sourceId: string;
  quality: Quality;
  url?: string;
  filePath?: string;
  status: DownloadStatus;
  progress: number;
  totalSize: number;
  speed?: number;
  /** v16: 歌名/歌手（下载页展示用；老任务可能缺失，回退显示 songId） */
  title?: string;
  artist?: string;
  /** v16: 已下载字节数（content-length 缺失时 UI 用它显示实时进度） */
  downloadedSize?: number;
  localPath?: string;
  errorMessage?: string;
  isFallback?: boolean;
  /** v25 B6: 取链探测出的真实音质档位（与 quality 不同表示源降级供货；探测失败留空） */
  actualQuality?: Quality;
  /** 音源不支持 Range 时整包回退：进度无法实时统计，UI 显示不确定态进度条 */
  indeterminate?: boolean;
  createdAt: number;
}

// === 取链平台优先级 ===
// v18 起双优先级表统一定义在 platformPriority.ts，此处保留兼容导出（v25 B0 播放优先级：酷我→咪咕→网易云→汽水→酷狗→QQ）
export { PLATFORM_PRIORITY as SourcePlayPriorityTable, getPriorityRank as getSourcePriority } from './platformPriority';

// === 错误码 ===
export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  SOURCE_UNAVAILABLE = 'SOURCE_UNAVAILABLE',
  SONG_NOT_FOUND = 'SONG_NOT_FOUND',
  QUALITY_UNAVAILABLE = 'QUALITY_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  SOURCE_ERROR = 'SOURCE_ERROR',
  LINK_RACE_FAILED = 'LINK_RACE_FAILED',
  DECRYPT_FAILED = 'DECRYPT_FAILED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class YinliuError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 500,
    public detail?: string
  ) {
    super(message);
    this.name = 'YinliuError';
  }
}

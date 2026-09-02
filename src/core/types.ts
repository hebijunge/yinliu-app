// === 音质枚举（9档）===
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
};

export function qualityRank(q: Quality): number {
  return QualityRank[q] ?? 0;
}

// === 音质弹窗（v18：下载音质多平台弹窗） ===
export type QualityTier = 'hires' | 'lossless' | '320k' | '192k' | '128k';

export const QUALITY_TIER_LABELS: Record<QualityTier, string> = {
  hires: 'Hi-Res',
  lossless: '无损',
  '320k': '320K',
  '192k': '192K',
  '128k': '128K',
};

/** 音质分组展示顺序（从高到低） */
export const QUALITY_TIER_ORDER: QualityTier[] = ['hires', 'lossless', '320k', '192k', '128k'];

export function tierToQuality(tier: QualityTier): Quality {
  switch (tier) {
    case 'hires': return Quality.HIRES;
    case 'lossless': return Quality.LOSSLESS;
    case '320k': return Quality.HIGH;
    case '192k': return Quality.HIGHER;
    case '128k': return Quality.STANDARD;
  }
}

export function qualityToTier(q: Quality): QualityTier | null {
  const rank = qualityRank(q);
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
export interface SearchParams {
  keyword: string;
  page?: number;
  pageSize?: number;
  type?: 'song' | 'album' | 'artist' | 'playlist';
}

export interface SearchResult {
  id: string;
  type: 'song' | 'album' | 'artist' | 'playlist';
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
  /** 加密文件的 ekey（酷我 mflac/mgg 需要） */
  ekey?: string;
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
  createdAt: number;
}

// === 取链平台优先级 ===
// v18 起双优先级表统一定义在 platformPriority.ts，此处保留兼容导出（播放优先级：酷我→咪咕→网易云→QQ→酷狗→汽水）
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

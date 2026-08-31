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
  localPath?: string;
  errorMessage?: string;
  isFallback?: boolean;
  createdAt: number;
}

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

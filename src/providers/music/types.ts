import type {
  SearchParams,
  SearchResult,
  PlayUrlResult,
  SongDetail,
  PlaylistDetail,
  Chart,
  ChartDetail,
  PlaylistSummary,
  HealthStatus,
  Quality,
  QualityOption,
} from '@core/types';

export interface MusicSource {
  readonly id: string;
  readonly name: string;
  readonly maxQuality: Quality;
  enabled: boolean;

  search(params: SearchParams): Promise<SearchResult[]>;
  getPlayUrl(songId: string, quality: Quality): Promise<PlayUrlResult>;
  getSongDetail(songId: string): Promise<SongDetail>;
  getLyrics?(songId: string): Promise<string | null>;
  getPlaylist?(playlistId: string): Promise<PlaylistDetail>;
  parsePlaylistUrl?(url: string): Promise<PlaylistDetail>;
  getCharts?(): Promise<Chart[]>;
  getChartDetail?(chartId: string): Promise<ChartDetail>;
  /** 按融合固定分类拉取歌单列表（分类名由 core 传入，源内部映射到自家标签；仅实现有对应能力的源） */
  getPlaylistsByCategory?(categoryName: string, page?: number): Promise<PlaylistSummary[]>;
  /** 获取歌曲在各音质档位的可选下载项（用于音质弹窗；无则回退搜索结果里的 sizes） */
  getQualityOptions?(songId: string): Promise<QualityOption[]>;
  healthCheck(): Promise<HealthStatus>;
}

export interface EndpointCandidate {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeout: number;
  priority: number;
}

export interface DecryptDataSource {
  decrypt(encryptedUrl: string, fileKey: string, ekey: string): Promise<ReadableStream>;
}

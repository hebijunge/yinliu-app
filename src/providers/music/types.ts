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
  SearchType,
} from '@core/types';

export interface FileSizeResult {
  size: number;
  url?: string;
}

export interface MusicSource {
  readonly id: string;
  readonly name: string;
  readonly maxQuality: Quality;
  enabled: boolean;
  /** 该源支持的搜索类型（缺省仅 song）；搜索引擎按此过滤不支持该类型的源 */
  readonly supportedSearchTypes?: SearchType[];

  search(params: SearchParams): Promise<SearchResult[]>;
  getPlayUrl(songId: string, quality: Quality, signal?: AbortSignal): Promise<PlayUrlResult>;
  getSongDetail(songId: string): Promise<SongDetail>;
  getLyrics?(songId: string): Promise<string | null>;
  getPlaylist?(playlistId: string): Promise<PlaylistDetail>;
  parsePlaylistUrl?(url: string): Promise<PlaylistDetail>;
  getCharts?(): Promise<Chart[]>;
  /**
   * P0-perf：opts.maxSongs 传入时限制榜单拉取条数（各源据此少翻页/少请求数据），
   * 供首页聚合等只需头部条目的场景提速；不传时行为不变（全量拉取）。
   */
  getChartDetail?(chartId: string, opts?: { maxSongs?: number }): Promise<ChartDetail>;
  /** 按融合固定分类拉取歌单列表（分类名由 core 传入，源内部映射到自家标签；仅实现有对应能力的源） */
  getPlaylistsByCategory?(categoryName: string, page?: number): Promise<PlaylistSummary[]>;
  /** 获取歌曲在各音质档位的可选下载项（用于音质弹窗；无则回退搜索结果里的 sizes） */
  getQualityOptions?(songId: string): Promise<QualityOption[]>;
  healthCheck(): Promise<HealthStatus>;
  /**
   * 预检该源该音质档的文件大小。
   * 默认实现基于 buildEndpointCandidates 做 HEAD 探测，取第一个成功候选的 Content-Length。
   * 子类可覆写以提供更精确的大小接口调用。
   */
  getFileSize?(songId: string, quality: Quality, signal?: AbortSignal): Promise<FileSizeResult | null>;
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

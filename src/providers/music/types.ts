import type {
  SearchParams,
  SearchResult,
  PlayUrlResult,
  SongDetail,
  PlaylistDetail,
  Chart,
  ChartDetail,
  HealthStatus,
  Quality,
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

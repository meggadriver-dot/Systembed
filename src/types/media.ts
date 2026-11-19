export type MediaType = 'movie' | 'tv';
export type StreamFormat = 'hls' | 'mp4' | 'ts' | 'dash' | 'embed';
export type MediaStatus = 'published' | 'draft';
export type SourceOrigin = 'm3u' | 'external_api' | 'manual' | 'tmdb_import' | 'seed';

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  role: 'admin' | 'developer';
  plan: 'Developer' | 'Enterprise';
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  ownerId: string;
  label: string;
  apiKey: string;
  allowedDomains: string;
  requestsCount: number;
  status: 'active' | 'revoked';
  createdAt: string;
}

export interface MediaSourceRecord {
  id: string;
  mediaKey: string;
  ownerId: string;
  parentStatus: MediaStatus;
  season: number;
  episode: number;
  episodeTitle: string;
  streamUrl: string;
  quality: string;
  format: StreamFormat;
  language: string;
  isWorking: boolean;
  originProvider: string;
  createdAt: string;
}

export interface MediaItemRecord {
  id: string;
  ownerId: string;
  tmdbId: number;
  imdbId: string;
  type: MediaType;
  title: string;
  originalTitle: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number;
  rating: number;
  genres: string[];
  runtime: number;
  status: MediaStatus;
  sourceOrigin: SourceOrigin;
  sourcesCount: number;
  sources?: MediaSourceRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ImportJobRecord {
  id: string;
  ownerId: string;
  sourceType: 'm3u_url' | 'm3u_text' | 'external_api' | 'xtream_codes';
  sourceName: string;
  sourceUrl: string;
  totalFound: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  status: 'completed' | 'failed';
  logs: string[];
  createdAt: string;
}

export interface DashboardStats {
  totalMovies: number;
  totalSeries: number;
  totalSources: number;
  totalEmbedRequests: number;
  totalImportJobs: number;
  activeApiKeys: number;
}

export interface PlatformSettings {
  tmdbConfigured: boolean;
  tmdbKeyPreview: string;
  defaultPlayerColor: string;
  allowPublicRegistration: boolean;
  requireApiKeyForEmbed: boolean;
  embedWatermarkText: string;
}

export interface TmdbSearchResult {
  tmdbId: number;
  type: MediaType;
  title: string;
  originalTitle: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number | null;
  rating: number | null;
  genres: string[];
}

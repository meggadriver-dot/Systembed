export type MediaType = 'movie' | 'tv';
export type StreamFormat = 'hls' | 'mp4' | 'ts' | 'dash' | 'embed';
export type MediaStatus = 'published' | 'draft';
export type SourceOrigin = 'm3u' | 'external_api' | 'manual' | 'tmdb_import' | 'seed';

export interface UserProfile {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'developer';
  plan: string;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: number;
  userId: number;
  label: string;
  apiKey: string;
  allowedDomains: string;
  requestsCount: number;
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MediaSourceRecord {
  id: number;
  mediaId: number;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  streamUrl: string;
  quality: string;
  format: StreamFormat;
  language: string;
  isWorking: boolean;
  lastCheckedAt: string | null;
  originProvider: string;
  createdAt: string;
}

export interface MediaItemRecord {
  id: number;
  tmdbId: number;
  imdbId: string | null;
  type: MediaType;
  title: string;
  originalTitle: string | null;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number | null;
  rating: number | null;
  genres: string[];
  runtime: number | null;
  status: MediaStatus;
  sourceOrigin: SourceOrigin;
  sourcesCount?: number;
  sources?: MediaSourceRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ImportJobRecord {
  id: number;
  userId: number | null;
  sourceType: 'm3u_url' | 'm3u_text' | 'external_api' | 'xtream_codes';
  sourceName: string;
  sourceUrl: string | null;
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
  workingSources: number;
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

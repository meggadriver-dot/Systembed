import type { MediaType, StreamFormat } from '../types/media.ts';
import { detectQuality, detectStreamFormat } from './m3uParser.ts';

export interface ExternalFieldMapping {
  itemsPath: string;
  titleField: string;
  tmdbIdField: string;
  imdbIdField: string;
  typeField: string;
  streamUrlField: string;
  posterField: string;
  backdropField: string;
  overviewField: string;
  yearField: string;
  ratingField: string;
  seasonField: string;
  episodeField: string;
  episodeTitleField: string;
  qualityField: string;
  languageField: string;
}

export const DEFAULT_EXTERNAL_MAPPING: ExternalFieldMapping = {
  itemsPath: '',
  titleField: 'title',
  tmdbIdField: 'tmdb_id',
  imdbIdField: 'imdb_id',
  typeField: 'type',
  streamUrlField: 'stream_url',
  posterField: 'poster_url',
  backdropField: 'backdrop_url',
  overviewField: 'overview',
  yearField: 'year',
  ratingField: 'rating',
  seasonField: 'season',
  episodeField: 'episode',
  episodeTitleField: 'episode_title',
  qualityField: 'quality',
  languageField: 'language',
};

export interface ExtractedMediaRecord {
  title: string;
  tmdbId: number | null;
  imdbId: string | null;
  type: MediaType;
  streamUrl: string;
  posterUrl: string;
  backdropUrl: string;
  overview: string;
  releaseYear: number | null;
  rating: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  quality: string;
  language: string;
  format: StreamFormat;
}

export interface ExtractedMediaBatch {
  items: ExtractedMediaRecord[];
  skipped: number;
  errors: string[];
}

function getByPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function pickFirstString(record: Record<string, unknown>, candidates: string[]): string {
  for (const key of candidates) {
    if (!key) continue;
    const val = getByPath(record, key);
    if (typeof val === 'string' && val.trim().length > 0) return val.trim();
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  }
  return '';
}

function pickFirstNumber(record: Record<string, unknown>, candidates: string[]): number | null {
  for (const key of candidates) {
    if (!key) continue;
    const val = getByPath(record, key);
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && val.trim().length > 0) {
      const parsed = Number.parseFloat(val.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function generateDeterministicTmdbFallback(title: string, year?: number | null): number {
  const normalized = `${title.toLowerCase().trim()}|${year ?? ''}`;
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Keep synthetic IDs in 9000000..9999999 so they never collide with standard low TMDB IDs
  return 9000000 + (Math.abs(hash) % 999999);
}

export function extractFromExternalPayload(
  payload: unknown,
  mapping: Partial<ExternalFieldMapping> = {},
  defaultType: MediaType = 'movie'
): ExtractedMediaBatch {
  const m = { ...DEFAULT_EXTERNAL_MAPPING, ...mapping };
  let rawItems: unknown[] = [];

  if (Array.isArray(payload)) {
    rawItems = payload;
  } else if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>;
    if (m.itemsPath) {
      const target = getByPath(root, m.itemsPath);
      if (Array.isArray(target)) rawItems = target;
    } else {
      const autoKeys = ['results', 'data', 'items', 'movies', 'series', 'streams', 'catalog'];
      for (const k of autoKeys) {
        if (Array.isArray(root[k])) {
          rawItems = root[k] as unknown[];
          break;
        }
      }
      if (rawItems.length === 0 && ('title' in root || 'name' in root || m.titleField in root)) {
        rawItems = [root];
      }
    }
  }

  const items: ExtractedMediaRecord[] = [];
  const errors: string[] = [];
  let skipped = 0;

  rawItems.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      skipped++;
      return;
    }
    const rec = raw as Record<string, unknown>;

    const title = pickFirstString(rec, [m.titleField, 'title', 'name', 'original_title', 'movie_name']);
    const streamUrl = pickFirstString(rec, [m.streamUrlField, 'stream_url', 'url', 'video_url', 'hls', 'src', 'link']);

    if (!title || !streamUrl || !/^https?:\/\/.+/i.test(streamUrl)) {
      skipped++;
      errors.push(`Item #${idx + 1} ignorado: título ou stream_url HTTP(S) ausente.`);
      return;
    }

    const rawType = pickFirstString(rec, [m.typeField, 'type', 'media_type', 'category']).toLowerCase();
    const seasonNum = pickFirstNumber(rec, [m.seasonField, 'season', 'temporada', 'season_number']);
    const episodeNum = pickFirstNumber(rec, [m.episodeField, 'episode', 'episodio', 'episode_number']);

    let type: MediaType = defaultType;
    if (['tv', 'serie', 'series', 'show', 'anime'].includes(rawType)) {
      type = 'tv';
    } else if (['movie', 'filme', 'film'].includes(rawType)) {
      type = 'movie';
    } else if (seasonNum !== null && episodeNum !== null) {
      type = 'tv';
    }

    const tmdbRaw = pickFirstNumber(rec, [m.tmdbIdField, 'tmdb_id', 'tmdbId', 'tmdb']);
    const tmdbId = tmdbRaw && tmdbRaw > 0 ? Math.trunc(tmdbRaw) : null;
    const imdbId = pickFirstString(rec, [m.imdbIdField, 'imdb_id', 'imdbId']) || null;

    const posterUrl = pickFirstString(rec, [m.posterField, 'poster_url', 'poster', 'poster_path', 'cover']);
    const backdropUrl = pickFirstString(rec, [m.backdropField, 'backdrop_url', 'backdrop', 'backdrop_path']);
    const overview = pickFirstString(rec, [m.overviewField, 'overview', 'description', 'synopsis', 'sinopse']);
    const yearVal = pickFirstNumber(rec, [m.yearField, 'year', 'release_year', 'ano']);
    const releaseYear = yearVal && yearVal >= 1900 && yearVal <= 2100 ? Math.trunc(yearVal) : null;
    const ratingVal = pickFirstNumber(rec, [m.ratingField, 'rating', 'vote_average', 'nota']);
    const rating = ratingVal !== null ? Math.min(10, Math.max(0, Number(ratingVal.toFixed(1)))) : null;

    const quality = pickFirstString(rec, [m.qualityField, 'quality', 'resolution']) || detectQuality(streamUrl);
    const language = pickFirstString(rec, [m.languageField, 'language', 'audio', 'idioma']) || 'PT-BR';
    const episodeTitle =
      type === 'tv'
        ? pickFirstString(rec, [m.episodeTitleField, 'episode_title', 'ep_name']) ||
          (episodeNum ? `Episódio ${Math.trunc(episodeNum)}` : null)
        : null;

    items.push({
      title,
      tmdbId,
      imdbId,
      type,
      streamUrl,
      posterUrl,
      backdropUrl,
      overview,
      releaseYear,
      rating,
      season: type === 'tv' ? Math.max(1, Math.trunc(seasonNum ?? 1)) : null,
      episode: type === 'tv' ? Math.max(1, Math.trunc(episodeNum ?? 1)) : null,
      episodeTitle,
      quality,
      language,
      format: detectStreamFormat(streamUrl),
    });
  });

  return { items, skipped, errors };
}

export function generateEmbedSnippets(params: {
  baseUrl: string;
  type: MediaType;
  tmdbId: number;
  season?: number;
  episode?: number;
  apiKey: string;
  color?: string;
}) {
  const cleanBase = params.baseUrl.replace(/\/+$/, '');
  const colorHex = (params.color || '2563EB').replace('#', '');
  const path =
    params.type === 'tv'
      ? `/embed/tv/${params.tmdbId}/${params.season ?? 1}/${params.episode ?? 1}`
      : `/embed/movie/${params.tmdbId}`;

  const query = new URLSearchParams();
  if (params.apiKey) query.set('key', params.apiKey);
  if (colorHex) query.set('color', colorHex);

  const embedUrl = `${cleanBase}${path}?${query.toString()}`;
  const apiUrl = `${cleanBase}/api/v1/media/${params.type}/${params.tmdbId}`;

  const iframeHtml = `<iframe
  src="${embedUrl}"
  width="100%"
  height="540"
  frameborder="0"
  allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
  allowfullscreen
></iframe>`;

  const reactComponent = `export function CineVaultPlayer() {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
      <iframe
        src="${embedUrl}"
        className="h-full w-full border-0"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}`;

  const curlCommand = `curl -s "${apiUrl}" \\
  -H "x-api-key: ${params.apiKey || 'SUA_CHAVE_API'}"`;

  return {
    embedUrl,
    apiUrl,
    iframeHtml,
    reactComponent,
    curlCommand,
  };
}

import type {
  MediaItemRecord,
  MediaSourceRecord,
  MediaType,
  TmdbSearchResult,
} from '../types/media';
import {
  DEFAULT_MOVIE_EMBED_TEMPLATE,
  DEFAULT_TV_EMBED_TEMPLATE,
  expandEmbedTemplate,
} from './embedSourceParser';

/**
 * Merges persisted Cloud Firestore catalog items with live EmbedMaster API items.
 * Firestore items always take precedence and appear first; API items with matching IDs are deduplicated.
 */
export function mergeCatalogSources(
  firestoreItems: MediaItemRecord[],
  apiItems: MediaItemRecord[]
): MediaItemRecord[] {
  const merged: MediaItemRecord[] = [];
  const seenIds = new Set<string>();

  for (const item of firestoreItems) {
    if (!item?.id || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    merged.push(item);
  }

  for (const item of apiItems) {
    if (!item?.id || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    merged.push(item);
  }

  return merged;
}

/**
 * Converts TMDB/API search results into ready-to-render MediaItemRecord entries
 * backed by the primary EmbedMaster source.
 */
export function apiSearchResultsToMediaItems(results: TmdbSearchResult[]): MediaItemRecord[] {
  const nowIso = new Date().toISOString();
  return results.map((r) => ({
    id: `${r.type}_${r.tmdbId}`,
    ownerId: 'embedmaster-api',
    tmdbId: r.tmdbId,
    imdbId: '',
    type: r.type,
    title: r.title,
    originalTitle: r.originalTitle || '',
    overview:
      r.overview ||
      `Disponível via API Principal EmbedMaster (${
        r.type === 'tv' ? 'embedmaster.link/tv' : 'embedmaster.link/movie'
      }/${r.tmdbId}).`,
    posterUrl: r.posterUrl || '',
    backdropUrl: r.backdropUrl || r.posterUrl || '',
    releaseYear: r.releaseYear ?? 0,
    rating: r.rating ?? 0,
    genres: r.genres || [],
    runtime: 0,
    status: 'published',
    sourceOrigin: 'external_api',
    sourcesCount: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
}

/**
 * Builds deterministic EmbedMaster playback sources for a movie or TV episode/episodes list
 * when the item is streamed directly from the API before being saved to Cloud Firestore.
 */
export function buildFallbackEmbedSources(
  type: MediaType,
  tmdbId: number,
  episodes?: Array<{ season: number; episode: number; episodeTitle?: string }>
): MediaSourceRecord[] {
  const nowIso = new Date().toISOString();
  const mediaKey = `${type}_${tmdbId}`;

  if (type === 'movie') {
    return [
      {
        id: `embedmaster_movie_${tmdbId}`,
        mediaKey,
        ownerId: 'embedmaster-api',
        parentStatus: 'published',
        season: 0,
        episode: 0,
        episodeTitle: '',
        streamUrl: expandEmbedTemplate(DEFAULT_MOVIE_EMBED_TEMPLATE, {
          type: 'movie',
          tmdbId,
        }),
        quality: '1080p',
        format: 'embed',
        language: 'PT-BR',
        isWorking: true,
        originProvider: 'EmbedMaster (API Principal)',
        createdAt: nowIso,
      },
    ];
  }

  const epList =
    episodes && episodes.length > 0
      ? episodes
      : [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];

  return epList.map((ep) => {
    const sNum = Math.max(1, Math.trunc(ep.season || 1));
    const eNum = Math.max(1, Math.trunc(ep.episode || 1));
    return {
      id: `embedmaster_tv_${tmdbId}_${sNum}_${eNum}`,
      mediaKey,
      ownerId: 'embedmaster-api',
      parentStatus: 'published',
      season: sNum,
      episode: eNum,
      episodeTitle: ep.episodeTitle || `Episódio ${eNum}`,
      streamUrl: expandEmbedTemplate(DEFAULT_TV_EMBED_TEMPLATE, {
        type: 'tv',
        tmdbId,
        season: sNum,
        episode: eNum,
      }),
      quality: '1080p',
      format: 'embed',
      language: 'PT-BR',
      isWorking: true,
      originProvider: 'EmbedMaster (API Principal)',
      createdAt: nowIso,
    };
  });
}

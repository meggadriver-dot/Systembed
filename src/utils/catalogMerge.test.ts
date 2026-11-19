import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiSearchResultsToMediaItems,
  buildFallbackEmbedSources,
  mergeCatalogSources,
} from './catalogMerge';
import type { MediaItemRecord } from '../types/media';

function makeItem(overrides: Partial<MediaItemRecord>): MediaItemRecord {
  return {
    id: 'movie_550',
    ownerId: 'user_1',
    tmdbId: 550,
    imdbId: '',
    type: 'movie',
    title: 'Clube da Luta',
    originalTitle: 'Fight Club',
    overview: 'Sinopse',
    posterUrl: '',
    backdropUrl: '',
    releaseYear: 1999,
    rating: 8.8,
    genres: [],
    runtime: 139,
    status: 'published',
    sourceOrigin: 'seed',
    sourcesCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('mergeCatalogSources prioritizes Firestore items and deduplicates matching API IDs', () => {
  const firestore = [makeItem({ id: 'movie_550', title: 'Clube da Luta (Firestore)', sourceOrigin: 'seed' })];
  const api = [
    makeItem({ id: 'movie_550', title: 'Clube da Luta (API)', sourceOrigin: 'external_api' }),
    makeItem({ id: 'movie_603', tmdbId: 603, title: 'Matrix', sourceOrigin: 'external_api' }),
    makeItem({ id: 'tv_1399', tmdbId: 1399, type: 'tv', title: 'Game of Thrones', sourceOrigin: 'external_api' }),
  ];

  const merged = mergeCatalogSources(firestore, api);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].title, 'Clube da Luta (Firestore)');
  assert.equal(merged[1].id, 'movie_603');
  assert.equal(merged[2].id, 'tv_1399');
});

test('apiSearchResultsToMediaItems maps search results into EmbedMaster MediaItemRecords', () => {
  const items = apiSearchResultsToMediaItems([
    {
      tmdbId: 603,
      type: 'movie',
      title: 'Matrix',
      originalTitle: 'The Matrix',
      overview: '',
      posterUrl: 'https://media.themoviedb.org/t/p/w500/abc.jpg',
      backdropUrl: '',
      releaseYear: 1999,
      rating: 8.7,
      genres: ['Ação'],
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'movie_603');
  assert.equal(items[0].sourceOrigin, 'external_api');
  assert.equal(items[0].sourcesCount, 1);
  assert.ok(items[0].overview.includes('embedmaster.link/movie/603'));
});

test('buildFallbackEmbedSources constructs EmbedMaster movie and TV episode URLs', () => {
  const movieSources = buildFallbackEmbedSources('movie', 550);
  assert.equal(movieSources.length, 1);
  assert.equal(movieSources[0].streamUrl, 'https://embedmaster.link/movie/550');
  assert.equal(movieSources[0].format, 'embed');

  const tvSources = buildFallbackEmbedSources('tv', 1399, [
    { season: 1, episode: 1, episodeTitle: 'O Inverno Está Chegando' },
    { season: 1, episode: 2, episodeTitle: 'A Estrada do Rei' },
  ]);
  assert.equal(tvSources.length, 2);
  assert.equal(tvSources[0].streamUrl, 'https://embedmaster.link/tv/1399/1/1');
  assert.equal(tvSources[1].streamUrl, 'https://embedmaster.link/tv/1399/1/2');
  assert.equal(tvSources[1].episodeTitle, 'A Estrada do Rei');
});

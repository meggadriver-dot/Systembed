import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFromExternalPayload,
  generateDeterministicTmdbFallback,
  generateEmbedSnippets,
} from './externalExtractor.ts';

test('extractFromExternalPayload normalizes nested API JSON feeds', () => {
  const payload = {
    status: 'ok',
    results: [
      {
        title: 'Horizonte Orbital',
        tmdb_id: 603,
        type: 'movie',
        stream_url: 'https://cdn.example.com/orbital.m3u8',
        year: 2025,
        rating: 8.6,
        quality: '4K',
      },
      {
        title: 'Distrito Chuva',
        tmdb_id: 94997,
        type: 'tv',
        season: 1,
        episode: 3,
        stream_url: 'https://cdn.example.com/rain-s1e3.mp4',
      },
      {
        title: 'Sem URL Válida',
        stream_url: 'not-a-url',
      },
    ],
  };

  const batch = extractFromExternalPayload(payload);
  assert.equal(batch.items.length, 2);
  assert.equal(batch.skipped, 1);
  assert.equal(batch.items[0].format, 'hls');
  assert.equal(batch.items[0].tmdbId, 603);
  assert.equal(batch.items[1].type, 'tv');
  assert.equal(batch.items[1].season, 1);
  assert.equal(batch.items[1].episode, 3);
  assert.equal(batch.items[1].format, 'mp4');
});

test('generateEmbedSnippets creates working movie and TV embed URLs and code', () => {
  const movieSnip = generateEmbedSnippets({
    baseUrl: 'https://api.cinevault.dev/',
    type: 'movie',
    tmdbId: 550,
    apiKey: 'cv_live_abc123',
    color: '#2563EB',
  });

  assert.equal(
    movieSnip.embedUrl,
    'https://api.cinevault.dev/embed/movie/550?key=cv_live_abc123&color=2563EB'
  );
  assert.ok(movieSnip.iframeHtml.includes('<iframe'));
  assert.ok(movieSnip.curlCommand.includes('x-api-key: cv_live_abc123'));

  const tvSnip = generateEmbedSnippets({
    baseUrl: 'https://api.cinevault.dev',
    type: 'tv',
    tmdbId: 1396,
    season: 2,
    episode: 4,
    apiKey: 'cv_live_abc123',
  });
  assert.ok(tvSnip.embedUrl.includes('/embed/tv/1396/2/4?'));
});

test('generateDeterministicTmdbFallback generates stable synthetic TMDB IDs', () => {
  const idA = generateDeterministicTmdbFallback('Filme Teste', 2024);
  const idB = generateDeterministicTmdbFallback('Filme Teste', 2024);
  const idC = generateDeterministicTmdbFallback('Outro Filme', 2024);

  assert.equal(idA, idB);
  assert.notEqual(idA, idC);
  assert.ok(idA >= 9000000);
});

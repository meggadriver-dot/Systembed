import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3uPlaylist } from './m3uParser.ts';

test('parseM3uPlaylist parses movies and TV series episodes with TMDB IDs and attributes', () => {
  const sampleM3u = `#EXTM3U
#EXTINF:-1 tvg-logo="https://example.com/poster1.jpg" group-title="Filmes 4K" tmdb-id="550",Clube da Luta (1999) [1080p] [DUAL]
https://cdn.example.com/streams/fight-club.m3u8
#EXTINF:-1 tvg-logo="https://example.com/poster2.jpg" group-title="Séries" tmdb-id="1396",Breaking Bad S01E01 [720p] [LEG]
https://cdn.example.com/streams/bb-s01e01.mp4
#EXTINF:-1 tvg-logo="https://example.com/poster2.jpg" group-title="Séries" tmdb-id="1396",Breaking Bad S01E02 [1080p] [DUB]
https://cdn.example.com/streams/bb-s01e02.m3u8
invalid-non-url-line
`;

  const result = parseM3uPlaylist(sampleM3u);

  assert.equal(result.entries.length, 3);
  assert.equal(result.moviesCount, 1);
  assert.equal(result.seriesCount, 1);
  assert.equal(result.episodesCount, 2);
  assert.equal(result.invalidLines, 1);

  const movie = result.entries[0];
  assert.equal(movie.type, 'movie');
  assert.equal(movie.cleanTitle, 'Clube da Luta');
  assert.equal(movie.releaseYear, 1999);
  assert.equal(movie.tmdbId, 550);
  assert.equal(movie.quality, '1080p');
  assert.equal(movie.language, 'DUAL');
  assert.equal(movie.format, 'hls');

  const ep1 = result.entries[1];
  assert.equal(ep1.type, 'tv');
  assert.equal(ep1.cleanTitle, 'Breaking Bad');
  assert.equal(ep1.season, 1);
  assert.equal(ep1.episode, 1);
  assert.equal(ep1.format, 'mp4');
  assert.equal(ep1.language, 'LEG');
});

test('parseM3uPlaylist handles Portuguese episode notation T02E05 and strips [PT-BR]', () => {
  const m3u = `#EXTM3U
#EXTINF:-1 group-title="Animes",Frieren T02E05 (2024) [FHD]
https://media.example.org/frieren/t2e5.m3u8
#EXTINF:-1 group-title="Filmes Ficção" tmdb-id="603",Matrix (1999) [4K] [PT-BR]
https://media.example.org/matrix.m3u8`;

  const res = parseM3uPlaylist(m3u);
  assert.equal(res.entries.length, 2);
  assert.equal(res.entries[0].type, 'tv');
  assert.equal(res.entries[0].cleanTitle, 'Frieren');
  assert.equal(res.entries[0].season, 2);
  assert.equal(res.entries[0].episode, 5);
  assert.equal(res.entries[0].quality, '1080p');

  assert.equal(res.entries[1].cleanTitle, 'Matrix');
  assert.equal(res.entries[1].quality, '4K');
  assert.equal(res.entries[1].language, 'PT-BR');
});

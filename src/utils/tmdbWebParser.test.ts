import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTmdbWebCatalogHtml,
  parseTmdbWebEpisodesHtml,
  parseTmdbWebSeasonsHtml,
} from './tmdbWebParser';

test('parseTmdbWebCatalogHtml extracts movies with upgraded w500 posters and years', () => {
  const sampleHtml = `
    <div class="card">
      <a href="/movie/1368337-the-odyssey?language=pt-BR">
        <img alt="A Odisseia" class="poster w-full block" src="https://media.themoviedb.org/t/p/w220_and_h330_face/m0ehGErq8GTLK4WZxaq9QLGAR3u.jpg" />
      </a>
      <div class="options" data-id="1368337" data-object-id="abc" data-media-type="movie" data-name="A Odisseia"></div>
      <div class="info">
        <h2>A Odisseia</h2>
        <span class="release_date w-full font-light">17 de julho de 2026</span>
      </div>
    </div>
    <div class="card">
      <a href="/movie/550-fight-club">
        <img alt="Clube da Luta" class="poster w-full" src="https://media.themoviedb.org/t/p/w220_and_h330_face/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg" />
      </a>
      <div class="options" data-id="550" data-object-id="def" data-media-type="movie" data-name="Clube da Luta &amp; Mais"></div>
      <span class="release_date">15 de outubro de 1999</span>
    </div>
  `;

  const movies = parseTmdbWebCatalogHtml(sampleHtml, 'movie');
  assert.equal(movies.length, 2);
  assert.equal(movies[0].tmdbId, 1368337);
  assert.equal(movies[0].title, 'A Odisseia');
  assert.equal(movies[0].releaseYear, 2026);
  assert.equal(
    movies[0].posterUrl,
    'https://media.themoviedb.org/t/p/w500/m0ehGErq8GTLK4WZxaq9QLGAR3u.jpg'
  );
  assert.equal(movies[1].tmdbId, 550);
  assert.equal(movies[1].title, 'Clube da Luta & Mais');
  assert.equal(movies[1].releaseYear, 1999);
});

test('parseTmdbWebSeasonsHtml and parseTmdbWebEpisodesHtml parse seasons and clean Portuguese titles', () => {
  const seasonsHtml = `
    <a href="/tv/5920-the-mentalist/season/0?language=pt-BR">Especiais</a>
    <a href="/tv/5920-the-mentalist/season/1?language=pt-BR">Temporada 1</a>
    <a href="/tv/5920-the-mentalist/season/2?language=pt-BR">Temporada 2</a>
    <a href="/tv/5920-the-mentalist/season/1?language=pt-BR">Temporada 1</a>
  `;
  const seasons = parseTmdbWebSeasonsHtml(seasonsHtml, 5920);
  assert.deepEqual(seasons, [1, 2]);

  const episodesHtml = `
    <a data-episode-number="1" data-season-number="1" href="/tv/5920-the-mentalist/season/1/episode/1" title="O Mentalista: Temporada 1 (2008): Episode 1 - Piloto">Ep 1</a>
    <a data-episode-number="1" data-season-number="1" href="/tv/5920-the-mentalist/season/1/episode/1" title="O Mentalista: Temporada 1 (2008): Episode 1 - Piloto">Ep 1 dup</a>
    <a data-episode-number="2" data-season-number="1" href="/tv/5920-the-mentalist/season/1/episode/2" title="O Mentalista: Temporada 1 (2008): Episode 2 - Cabelo Ruivo e Fita Prateada">Ep 2</a>
  `;
  const eps = parseTmdbWebEpisodesHtml(episodesHtml, 1);
  assert.equal(eps.length, 2);
  assert.deepEqual(eps[0], { season: 1, episode: 1, episodeTitle: 'Piloto' });
  assert.deepEqual(eps[1], { season: 1, episode: 2, episodeTitle: 'Cabelo Ruivo e Fita Prateada' });
});

test('parseTmdbWebSearchHtml extracts titles, posters, years and overviews from TMDB search HTML', async () => {
  const { parseTmdbWebSearchHtml, parseTmdbWebDetailsHtml } = await import('./tmdbWebParser');
  const searchHtml = `
    <div class="card">
      <a class="flex w-full" data-id="abc" data-media-type="movie" href="/movie/603-the-matrix?language=pt-BR">
        <img alt="Matrix" class="poster w-full block" src="https://media.themoviedb.org/t/p/w94_and_h141_face/lDqMDI3xpbB9UQRyeXfei0MXhqb.jpg" />
      </a>
      <a data-id="abc" data-media-type="movie" href="/movie/603-the-matrix?language=pt-BR">
        <h2><span>Matrix</span><span class="font-light"> (The Matrix)</span></h2>
      </a>
      <span class="release_date w-full font-light">31 de março de 1999</span>
      <div class="mt-4 **:m-0"><p>O jovem programador Thomas Anderson é atormentado por estranhos pesadelos.</p></div>
    </div>
  `;

  const items = parseTmdbWebSearchHtml(searchHtml, 'movie');
  assert.equal(items.length, 1);
  assert.equal(items[0].tmdbId, 603);
  assert.equal(items[0].title, 'Matrix');
  assert.equal(items[0].originalTitle, 'The Matrix');
  assert.equal(items[0].releaseYear, 1999);
  assert.equal(items[0].posterUrl, 'https://media.themoviedb.org/t/p/w500/lDqMDI3xpbB9UQRyeXfei0MXhqb.jpg');
  assert.ok(items[0].overview.includes('Thomas Anderson'));

  const detailHtml = `
    <html>
      <head>
        <meta property="og:title" content="Clube da Luta">
        <meta property="og:description" content="Um homem deprimido forma um clube clandestino.">
        <meta property="og:image" content="https://media.themoviedb.org/t/p/w500/poster.jpg">
        <meta property="og:image" content="https://media.themoviedb.org/t/p/w780/backdrop.jpg">
      </head>
      <body><span class="tag release_date">(1999)</span></body>
    </html>
  `;
  const details = parseTmdbWebDetailsHtml(detailHtml, 'movie', 550);
  assert.ok(details);
  assert.equal(details.title, 'Clube da Luta');
  assert.equal(details.releaseYear, 1999);
  assert.equal(details.posterUrl, 'https://media.themoviedb.org/t/p/w500/poster.jpg');
  assert.equal(details.backdropUrl, 'https://media.themoviedb.org/t/p/w780/backdrop.jpg');
});


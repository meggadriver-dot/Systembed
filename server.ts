import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { firestoreRestGetDoc, firestoreRestRunQuery } from './src/server/firestoreRest.ts';
import { renderEmbedErrorHtml, renderEmbedPlayerHtml } from './src/server/embedHtml.ts';
import { parseM3uPlaylist } from './src/utils/m3uParser.ts';
import {
  extractFromExternalPayload,
  generateDeterministicTmdbFallback,
  type ExternalFieldMapping,
} from './src/utils/externalExtractor.ts';
import {
  buildPrimarySourceEntries,
  DEFAULT_MOVIE_EMBED_TEMPLATE,
  DEFAULT_TV_EMBED_TEMPLATE,
  expandEmbedTemplate,
  extractMediaStreamsFromDocument,
  parseEmbedTargetsInput,
  type CatalogSyncSeedItem,
  type EmbedCrawlTarget,
  type ExtractedStreamCandidate,
} from './src/utils/embedSourceParser.ts';
import {
  parseTmdbWebCatalogHtml,
  parseTmdbWebDetailsHtml,
  parseTmdbWebEpisodesHtml,
  parseTmdbWebSearchHtml,
  parseTmdbWebSeasonsHtml,
} from './src/utils/tmdbWebParser.ts';
import { buildFallbackEmbedSources } from './src/utils/catalogMerge.ts';

dotenv.config();

const execFileAsync = promisify(execFile);
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchTmdbWebHtml(url: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sL',
        '--max-time',
        '10',
        '-A',
        BROWSER_UA,
        '-H',
        'Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8',
        url,
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    if (!stdout || /Just a moment\.\.\.|cf-browser-verification/i.test(stdout)) {
      return null;
    }
    return stdout;
  } catch {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// CORS headers so external sites/apps can consume /api/v1/*
app.use('/api/v1', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Serve hls.js locally for standalone /embed/* endpoints
app.get('/vendor/hls.min.js', (_req, res) => {
  const hlsPath = path.resolve(process.cwd(), 'node_modules/hls.js/dist/hls.min.js');
  if (fs.existsSync(hlsPath)) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(hlsPath);
    return;
  }
  res.status(404).send('// hls.js not found');
});

// Serve local demo MP4 and HLS test streams
app.get('/demo/stream.mp4', (_req, res) => {
  const mp4Path = path.resolve(process.cwd(), 'data/demo_stream.mp4');
  if (!fs.existsSync(mp4Path)) {
    res.sendStatus(404);
    return;
  }
  res.sendFile(mp4Path);
});

app.use(
  '/demo/hls',
  express.static(path.resolve(process.cwd(), 'data/demo_hls'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
      }
    },
  })
);

// Built-in multi-layer Demo Embed Pages (for testing real HTML + iframe + JS + Base64 stream extraction)
app.get('/demo/mock-embed/movie/:tmdbId', (req, res) => {
  const tmdbId = Number(req.params.tmdbId) || 550;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Demo Embed Movie ${tmdbId}</title></head>
<body style="margin:0;background:#000">
  <iframe src="/demo/mock-embed/inner/movie/${tmdbId}" allowfullscreen style="width:100%;height:100vh;border:0"></iframe>
</body>
</html>`);
});

app.get('/demo/mock-embed/tv/:tmdbId/:season/:episode', (req, res) => {
  const tmdbId = Number(req.params.tmdbId) || 1399;
  const season = Number(req.params.season) || 1;
  const episode = Number(req.params.episode) || 1;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Demo Embed TV ${tmdbId} S${season}E${episode}</title></head>
<body style="margin:0;background:#000">
  <iframe src="/demo/mock-embed/inner/tv/${tmdbId}?s=${season}&e=${episode}" allowfullscreen style="width:100%;height:100vh;border:0"></iframe>
</body>
</html>`);
});

app.get('/demo/mock-embed/inner/:type/:tmdbId', (_req, res) => {
  const mp4B64 = Buffer.from('/demo/stream.mp4', 'utf8').toString('base64');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Player Inner Stage</title></head>
<body>
  <div id="player"></div>
  <script>
    const backupSrc = atob("${mp4B64}");
    const playerConfig = {
      sources: [
        { "file": "\\/demo\\/hls\\/master.m3u8", "label": "1080p DUAL", "type": "hls" }
      ],
      fallbackMp4: backupSrc
    };
  </script>
</body>
</html>`);
});

async function fetchTmdbDetails(type: 'movie' | 'tv', tmdbId: number, apiKey: string) {
  if (!apiKey) return null;
  try {
    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${encodeURIComponent(
      apiKey
    )}&language=pt-BR&append_to_response=external_ids`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const dateStr = String(data.release_date || data.first_air_date || '');
    const year = dateStr.length >= 4 ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
    const genresArr = Array.isArray(data.genres)
      ? (data.genres as Array<{ name?: string }>).map((g) => String(g.name || '')).filter(Boolean)
      : [];
    const runtimeVal =
      typeof data.runtime === 'number'
        ? data.runtime
        : Array.isArray(data.episode_run_time) && typeof data.episode_run_time[0] === 'number'
          ? data.episode_run_time[0]
          : null;
    const extIds = (data.external_ids as Record<string, unknown> | undefined) || {};
    return {
      tmdbId,
      imdbId: extIds.imdb_id ? String(extIds.imdb_id) : data.imdb_id ? String(data.imdb_id) : '',
      title: String(data.title || data.name || `TMDB #${tmdbId}`),
      originalTitle: String(data.original_title || data.original_name || ''),
      overview: String(data.overview || ''),
      posterUrl: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : '',
      backdropUrl: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : '',
      releaseYear: Number.isFinite(year) ? year : null,
      rating: typeof data.vote_average === 'number' ? Number(data.vote_average.toFixed(1)) : null,
      genres: genresArr,
      runtime: runtimeVal,
    };
  } catch {
    return null;
  }
}

async function searchTmdbFirstMatch(query: string, type: 'movie' | 'tv', year: number | null, apiKey: string) {
  if (!apiKey || !query) return null;
  try {
    const yearParam = year ? (type === 'movie' ? `&year=${year}` : `&first_air_date_year=${year}`) : '';
    const url = `https://api.themoviedb.org/3/search/${type}?api_key=${encodeURIComponent(
      apiKey
    )}&language=pt-BR&query=${encodeURIComponent(query)}${yearParam}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const first = data.results?.[0];
    if (!first || typeof first.id !== 'number') return null;
    return await fetchTmdbDetails(type, first.id, apiKey);
  } catch {
    return null;
  }
}

// In-memory TTL caches for fast API catalog & embed resolution
const CACHE_TTL_MS = 10 * 60 * 1000;
const embedMasterCatalogCache = new Map<string, { expiresAt: number; payload: unknown }>();
const publicDetailsCache = new Map<
  string,
  {
    expiresAt: number;
    data: {
      tmdbId: number;
      type: 'movie' | 'tv';
      title: string;
      overview: string;
      posterUrl: string;
      backdropUrl: string;
      releaseYear: number | null;
      episodes?: Array<{ season: number; episode: number; episodeTitle: string }>;
    };
  }
>();

async function discoverEmbedMasterCatalogPage(
  page: number,
  typeFilter: 'all' | 'movie' | 'tv',
  apiKey: string
) {
  const safePage = Math.max(1, Math.min(500, Math.trunc(page || 1)));
  const cacheKey = `${typeFilter}:${safePage}:${apiKey ? 'key' : 'keyless'}`;
  const cached = embedMasterCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload as {
      page: number;
      discoveryMode: string;
      moviesCount: number;
      seriesCount: number;
      total: number;
      hasMorePages: boolean;
      items: Array<Record<string, unknown>>;
    };
  }

  const includeMovies = typeFilter === 'all' || typeFilter === 'movie';
  const includeSeries = typeFilter === 'all' || typeFilter === 'tv';
  const itemsById = new Map<string, Record<string, unknown>>();
  const nowIso = new Date().toISOString();

  const buildApiCard = (raw: {
    tmdbId: number;
    type: 'movie' | 'tv';
    title: string;
    originalTitle?: string;
    overview?: string;
    posterUrl?: string;
    backdropUrl?: string;
    releaseYear?: number | null;
    rating?: number | null;
    genres?: string[];
  }) => {
    const id = `${raw.type}_${raw.tmdbId}`;
    if (itemsById.has(id)) return;
    const directStreamUrl = expandEmbedTemplate(
      raw.type === 'tv' ? DEFAULT_TV_EMBED_TEMPLATE : DEFAULT_MOVIE_EMBED_TEMPLATE,
      { type: raw.type, tmdbId: raw.tmdbId, season: 1, episode: 1 }
    );
    itemsById.set(id, {
      id,
      ownerId: 'embedmaster-api',
      tmdbId: raw.tmdbId,
      imdbId: '',
      type: raw.type,
      title: raw.title || `TMDB #${raw.tmdbId}`,
      originalTitle: raw.originalTitle || '',
      overview:
        raw.overview ||
        `Catálogo principal EmbedMaster conectado (${directStreamUrl}). Clique em Embed para reproduzir imediatamente.`,
      posterUrl: raw.posterUrl || '',
      backdropUrl: raw.backdropUrl || raw.posterUrl || '',
      releaseYear: raw.releaseYear ?? 0,
      rating: raw.rating ?? 0,
      genres: raw.genres || [],
      runtime: 0,
      status: 'published',
      sourceOrigin: 'external_api',
      sourcesCount: 1,
      embedSourceUrl: directStreamUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  };

  if (apiKey) {
    const [movieGenres, tvGenres] = await Promise.all([
      includeMovies ? fetchTmdbGenreMap('movie', apiKey) : Promise.resolve(new Map<number, string>()),
      includeSeries ? fetchTmdbGenreMap('tv', apiKey) : Promise.resolve(new Map<number, string>()),
    ]);
    const tasks: Array<Promise<void>> = [];

    if (includeMovies) {
      for (const cat of ['popular', 'top_rated', 'now_playing']) {
        tasks.push(
          (async () => {
            try {
              const r = await fetch(
                `https://api.themoviedb.org/3/movie/${cat}?api_key=${encodeURIComponent(
                  apiKey
                )}&language=pt-BR&page=${safePage}`,
                { signal: AbortSignal.timeout(7000) }
              );
              if (!r.ok) return;
              const data = (await r.json()) as { results?: Array<Record<string, unknown>> };
              for (const raw of data.results || []) {
                const tmdbId = Number(raw.id);
                if (!tmdbId) continue;
                const dateStr = String(raw.release_date || '');
                const year = dateStr.length >= 4 ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
                const gIds = Array.isArray(raw.genre_ids) ? (raw.genre_ids as number[]) : [];
                buildApiCard({
                  tmdbId,
                  type: 'movie',
                  title: String(raw.title || `TMDB #${tmdbId}`),
                  originalTitle: String(raw.original_title || ''),
                  overview: String(raw.overview || ''),
                  posterUrl: raw.poster_path ? `https://image.tmdb.org/t/p/w500${raw.poster_path}` : '',
                  backdropUrl: raw.backdrop_path ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}` : '',
                  releaseYear: Number.isFinite(year) ? year : null,
                  rating: typeof raw.vote_average === 'number' ? Number(raw.vote_average.toFixed(1)) : null,
                  genres: gIds.map((gid) => movieGenres.get(gid) || '').filter(Boolean),
                });
              }
            } catch {
              // ignore single category failure
            }
          })()
        );
      }
    }

    if (includeSeries) {
      for (const cat of ['popular', 'top_rated', 'on_the_air']) {
        tasks.push(
          (async () => {
            try {
              const r = await fetch(
                `https://api.themoviedb.org/3/tv/${cat}?api_key=${encodeURIComponent(
                  apiKey
                )}&language=pt-BR&page=${safePage}`,
                { signal: AbortSignal.timeout(7000) }
              );
              if (!r.ok) return;
              const data = (await r.json()) as { results?: Array<Record<string, unknown>> };
              for (const raw of data.results || []) {
                const tmdbId = Number(raw.id);
                if (!tmdbId) continue;
                const dateStr = String(raw.first_air_date || '');
                const year = dateStr.length >= 4 ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
                const gIds = Array.isArray(raw.genre_ids) ? (raw.genre_ids as number[]) : [];
                buildApiCard({
                  tmdbId,
                  type: 'tv',
                  title: String(raw.name || `TMDB #${tmdbId}`),
                  originalTitle: String(raw.original_name || ''),
                  overview: String(raw.overview || ''),
                  posterUrl: raw.poster_path ? `https://image.tmdb.org/t/p/w500${raw.poster_path}` : '',
                  backdropUrl: raw.backdrop_path ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}` : '',
                  releaseYear: Number.isFinite(year) ? year : null,
                  rating: typeof raw.vote_average === 'number' ? Number(raw.vote_average.toFixed(1)) : null,
                  genres: gIds.map((gid) => tvGenres.get(gid) || '').filter(Boolean),
                });
              }
            } catch {
              // ignore single category failure
            }
          })()
        );
      }
    }

    await Promise.all(tasks);
  } else {
    const slugs: Array<{ slug: string; mediaType: 'movie' | 'tv' }> = [];
    if (includeMovies) {
      slugs.push(
        { slug: 'movie', mediaType: 'movie' },
        { slug: 'movie/top-rated', mediaType: 'movie' },
        { slug: 'movie/now-playing', mediaType: 'movie' }
      );
    }
    if (includeSeries) {
      slugs.push(
        { slug: 'tv', mediaType: 'tv' },
        { slug: 'tv/top-rated', mediaType: 'tv' },
        { slug: 'tv/on-the-air', mediaType: 'tv' }
      );
    }

    const pagesHtml = await Promise.all(
      slugs.map(async ({ slug, mediaType }) => {
        const html = await fetchTmdbWebHtml(`https://www.themoviedb.org/${slug}?language=pt-BR&page=${safePage}`);
        return { mediaType, html };
      })
    );

    // Interleave movies and series cleanly so the user sees both immediately at the top
    const movieBuckets: Array<ReturnType<typeof parseTmdbWebCatalogHtml>> = [];
    const tvBuckets: Array<ReturnType<typeof parseTmdbWebCatalogHtml>> = [];
    for (const entry of pagesHtml) {
      if (!entry.html) continue;
      const parsed = parseTmdbWebCatalogHtml(entry.html, entry.mediaType);
      if (entry.mediaType === 'movie') movieBuckets.push(parsed);
      else tvBuckets.push(parsed);
    }

    const allMovies = movieBuckets.flat();
    const allTv = tvBuckets.flat();
    const maxLen = Math.max(allMovies.length, allTv.length);
    for (let i = 0; i < maxLen; i++) {
      if (allMovies[i]) buildApiCard(allMovies[i]);
      if (allTv[i]) buildApiCard(allTv[i]);
    }
  }

  const items = Array.from(itemsById.values());
  const moviesCount = items.filter((i) => i.type === 'movie').length;
  const seriesCount = items.filter((i) => i.type === 'tv').length;

  const payload = {
    page: safePage,
    discoveryMode: apiKey ? 'tmdb_api' : 'tmdb_public_keyless',
    moviesCount,
    seriesCount,
    total: items.length,
    hasMorePages: items.length > 0 && safePage < 500,
    items,
  };

  if (items.length > 0) {
    embedMasterCatalogCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
  }
  return payload;
}

async function resolvePublicMediaMetaAndEpisodes(
  type: 'movie' | 'tv',
  tmdbId: number,
  targetSeason = 1,
  apiKey = ''
) {
  const cacheKey = `${type}:${tmdbId}:s${type === 'tv' ? targetSeason : 0}`;
  const cached = publicDetailsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  let title = `${type === 'tv' ? 'Série' : 'Filme'} TMDB #${tmdbId}`;
  let overview = '';
  let posterUrl = '';
  let backdropUrl = '';
  let releaseYear: number | null = null;
  let episodes: Array<{ season: number; episode: number; episodeTitle: string }> = [];

  if (apiKey) {
    const details = await fetchTmdbDetails(type, tmdbId, apiKey);
    if (details) {
      title = details.title;
      overview = details.overview;
      posterUrl = details.posterUrl;
      backdropUrl = details.backdropUrl;
      releaseYear = details.releaseYear;
    }
    if (type === 'tv') {
      try {
        const epRes = await fetch(
          `https://api.themoviedb.org/3/tv/${tmdbId}/season/${targetSeason}?api_key=${encodeURIComponent(
            apiKey
          )}&language=pt-BR`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (epRes.ok) {
          const epData = (await epRes.json()) as {
            episodes?: Array<{ episode_number: number; name?: string }>;
          };
          episodes = (epData.episodes || []).map((ep) => ({
            season: targetSeason,
            episode: ep.episode_number,
            episodeTitle: ep.name || `Episódio ${ep.episode_number}`,
          }));
        }
      } catch {
        // fallback below
      }
    }
  } else {
    const detailHtml = await fetchTmdbWebHtml(`https://www.themoviedb.org/${type}/${tmdbId}?language=pt-BR`);
    if (detailHtml) {
      const parsed = parseTmdbWebDetailsHtml(detailHtml, type, tmdbId);
      if (parsed) {
        title = parsed.title;
        overview = parsed.overview;
        posterUrl = parsed.posterUrl;
        backdropUrl = parsed.backdropUrl;
        releaseYear = parsed.releaseYear;
      }
    }
    if (type === 'tv') {
      const epHtml = await fetchTmdbWebHtml(
        `https://www.themoviedb.org/tv/${tmdbId}/season/${targetSeason}?language=pt-BR`
      );
      if (epHtml) {
        episodes = parseTmdbWebEpisodesHtml(epHtml, targetSeason);
      }
    }
  }

  if (type === 'tv' && episodes.length === 0) {
    episodes = [{ season: targetSeason, episode: 1, episodeTitle: `Episódio 1` }];
  }

  const data = {
    tmdbId,
    type,
    title,
    overview,
    posterUrl,
    backdropUrl,
    releaseYear,
    episodes: type === 'tv' ? episodes : undefined,
  };
  publicDetailsCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, data });
  return data;
}

// =======================
// TMDB, EMBEDMASTER LIVE CATALOG & STREAM PROXIES
// =======================
app.get('/api/catalog/embedmaster', async (req, res) => {
  const page = Math.max(1, Math.min(500, Number(req.query.page || 1)));
  const rawType = String(req.query.type || 'all');
  const typeFilter: 'all' | 'movie' | 'tv' =
    rawType === 'movie' ? 'movie' : rawType === 'tv' ? 'tv' : 'all';
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || process.env.TMDB_API_KEY || '';

  try {
    const payload = await discoverEmbedMasterCatalogPage(page, typeFilter, apiKey);
    res.json(payload);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Falha ao carregar catálogo da API EmbedMaster.',
      items: [],
    });
  }
});

app.get('/api/tmdb/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const rawType = String(req.query.type || 'all');
  const searchTypes: Array<'movie' | 'tv'> =
    rawType === 'movie' ? ['movie'] : rawType === 'tv' ? ['tv'] : ['movie', 'tv'];
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || process.env.TMDB_API_KEY || '';

  if (!query) {
    res.json({ configured: true, keyless: !apiKey, results: [] });
    return;
  }

  if (!apiKey) {
    try {
      const batches = await Promise.all(
        searchTypes.map(async (t) => {
          const html = await fetchTmdbWebHtml(
            `https://www.themoviedb.org/search/${t}?query=${encodeURIComponent(query)}&language=pt-BR`
          );
          if (!html) return [];
          return parseTmdbWebSearchHtml(html, t).map((item) => ({
            tmdbId: item.tmdbId,
            type: item.type,
            title: item.title,
            originalTitle: item.originalTitle,
            overview: item.overview,
            posterUrl: item.posterUrl,
            backdropUrl: item.backdropUrl,
            releaseYear: item.releaseYear,
            rating: null,
            genres: [],
          }));
        })
      );

      const merged: Array<Record<string, unknown>> = [];
      const movies = batches[0] || [];
      const series = batches[1] || [];
      const max = Math.max(movies.length, series.length);
      for (let i = 0; i < max; i++) {
        if (movies[i]) merged.push(movies[i]);
        if (series[i]) merged.push(series[i]);
      }

      res.json({ configured: true, keyless: true, results: merged.slice(0, 24) });
      return;
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro ao buscar no catálogo público TMDB.',
      });
      return;
    }
  }

  try {
    const batches = await Promise.all(
      searchTypes.map(async (t) => {
        const url = `https://api.themoviedb.org/3/search/${t}?api_key=${encodeURIComponent(
          apiKey
        )}&language=pt-BR&query=${encodeURIComponent(query)}`;
        const tmdbRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!tmdbRes.ok) return [];
        const payload = (await tmdbRes.json()) as { results?: Array<Record<string, unknown>> };
        return (payload.results || []).slice(0, 12).map((item) => {
          const dateStr = String(item.release_date || item.first_air_date || '');
          const releaseYear = dateStr.length >= 4 ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
          return {
            tmdbId: Number(item.id),
            type: t,
            title: String(item.title || item.name || ''),
            originalTitle: String(item.original_title || item.original_name || ''),
            overview: String(item.overview || ''),
            posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
            backdropUrl: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : '',
            releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
            rating: typeof item.vote_average === 'number' ? Number(item.vote_average.toFixed(1)) : null,
            genres: [],
          };
        });
      })
    );

    const results = batches.flat().slice(0, 24);
    res.json({ configured: true, keyless: false, results });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Erro de conexão com o TMDB.' });
  }
});

app.get('/api/tmdb/details/:type/:tmdbId', async (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const tmdbId = Number(req.params.tmdbId);
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || process.env.TMDB_API_KEY || '';
  const details = await resolvePublicMediaMetaAndEpisodes(type, tmdbId, 1, apiKey);
  if (!details) {
    res.status(404).json({ error: 'Título não encontrado no TMDB.' });
    return;
  }
  res.json(details);
});

app.get('/api/tmdb/discover', async (req, res) => {
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const rawCategory = String(req.query.category || 'popular');
  const allowedCategory =
    rawCategory === 'top_rated'
      ? 'top_rated'
      : rawCategory === 'now_playing'
        ? type === 'tv'
          ? 'on_the_air'
          : 'now_playing'
        : 'popular';
  const page = Math.max(1, Math.min(500, Number(req.query.page || 1)));
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || process.env.TMDB_API_KEY || '';

  if (!apiKey) {
    const webSlug =
      type === 'movie'
        ? allowedCategory === 'top_rated'
          ? 'movie/top-rated'
          : allowedCategory === 'now_playing'
            ? 'movie/now-playing'
            : 'movie'
        : allowedCategory === 'top_rated'
          ? 'tv/top-rated'
          : allowedCategory === 'on_the_air'
            ? 'tv/on-the-air'
            : 'tv';
    const html = await fetchTmdbWebHtml(`https://www.themoviedb.org/${webSlug}?language=pt-BR&page=${page}`);
    if (!html) {
      res.status(502).json({ error: 'Não foi possível carregar o catálogo público do TMDB no momento.' });
      return;
    }
    const parsed = parseTmdbWebCatalogHtml(html, type).map((item) => ({
      tmdbId: item.tmdbId,
      type: item.type,
      title: item.title,
      originalTitle: '',
      overview: '',
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      releaseYear: item.releaseYear,
      rating: null,
      genres: [],
    }));
    res.json({ configured: true, keyless: true, results: parsed });
    return;
  }

  try {
    const url = `https://api.themoviedb.org/3/${type}/${allowedCategory}?api_key=${encodeURIComponent(
      apiKey
    )}&language=pt-BR&page=${page}`;
    const tmdbRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!tmdbRes.ok) {
      res.status(tmdbRes.status).json({ error: `Erro ao consultar TMDB (${tmdbRes.status}).` });
      return;
    }
    const payload = (await tmdbRes.json()) as { results?: Array<Record<string, unknown>> };
    const results = (payload.results || []).slice(0, 20).map((item) => {
      const dateStr = String(item.release_date || item.first_air_date || '');
      const releaseYear = dateStr.length >= 4 ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
      return {
        tmdbId: Number(item.id),
        type,
        title: String(item.title || item.name || ''),
        originalTitle: String(item.original_title || item.original_name || ''),
        overview: String(item.overview || ''),
        posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
        backdropUrl: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : '',
        releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
        rating: typeof item.vote_average === 'number' ? Number(item.vote_average.toFixed(1)) : null,
        genres: [],
      };
    });
    res.json({ configured: true, results });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Erro de conexão com o TMDB.' });
  }
});

app.get('/api/tmdb/tv/:tmdbId/seasons', async (req, res) => {
  const tmdbId = Number(req.params.tmdbId);
  const seasonParam = req.query.season ? Number(req.query.season) : null;
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || process.env.TMDB_API_KEY || '';

  if (!apiKey) {
    const seasonsHtml = await fetchTmdbWebHtml(`https://www.themoviedb.org/tv/${tmdbId}/seasons?language=pt-BR`);
    if (!seasonsHtml) {
      res.status(502).json({ error: 'Não foi possível carregar as temporadas públicas do TMDB.' });
      return;
    }
    const seasonNums = parseTmdbWebSeasonsHtml(seasonsHtml, tmdbId);
    const seasons = (seasonNums.length > 0 ? seasonNums : [1]).map((s) => ({
      seasonNumber: s,
      episodeCount: 0,
      name: `Temporada ${s}`,
    }));
    const selectedSeason = seasonParam || seasons[0].seasonNumber;
    const epHtml = await fetchTmdbWebHtml(
      `https://www.themoviedb.org/tv/${tmdbId}/season/${selectedSeason}?language=pt-BR`
    );
    const episodes = epHtml
      ? parseTmdbWebEpisodesHtml(epHtml, selectedSeason)
      : [{ season: selectedSeason, episode: 1, episodeTitle: 'Episódio 1' }];

    const titleMatch = seasonsHtml.match(/<title>([^<—&#]+)/i);
    res.json({
      tmdbId,
      title: titleMatch ? titleMatch[1].trim() : `Série TMDB #${tmdbId}`,
      overview: '',
      posterUrl: '',
      backdropUrl: '',
      seasons,
      selectedSeason,
      episodes,
    });
    return;
  }

  try {
    const showUrl = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=pt-BR`;
    const showRes = await fetch(showUrl, { signal: AbortSignal.timeout(8000) });
    if (!showRes.ok) {
      res.status(showRes.status).json({ error: 'Série não encontrada no TMDB.' });
      return;
    }
    const showData = (await showRes.json()) as {
      id: number;
      name?: string;
      overview?: string;
      poster_path?: string;
      backdrop_path?: string;
      first_air_date?: string;
      vote_average?: number;
      seasons?: Array<{ season_number: number; episode_count: number; name?: string }>;
    };

    const seasons = (showData.seasons || [])
      .filter((s) => s.season_number >= 1 && s.episode_count > 0)
      .map((s) => ({
        seasonNumber: s.season_number,
        episodeCount: s.episode_count,
        name: s.name || `Temporada ${s.season_number}`,
      }));

    const selectedSeason = seasonParam || (seasons[0]?.seasonNumber ?? 1);
    let episodes: Array<{ season: number; episode: number; episodeTitle: string }> = [];

    if (seasons.length > 0) {
      const epUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${selectedSeason}?api_key=${encodeURIComponent(
        apiKey
      )}&language=pt-BR`;
      const epRes = await fetch(epUrl, { signal: AbortSignal.timeout(8000) });
      if (epRes.ok) {
        const epData = (await epRes.json()) as {
          episodes?: Array<{ episode_number: number; name?: string }>;
        };
        episodes = (epData.episodes || []).map((ep) => ({
          season: selectedSeason,
          episode: ep.episode_number,
          episodeTitle: ep.name || `Episódio ${ep.episode_number}`,
        }));
      }
    }

    res.json({
      tmdbId: showData.id,
      title: showData.name || `TMDB #${tmdbId}`,
      overview: showData.overview || '',
      posterUrl: showData.poster_path ? `https://image.tmdb.org/t/p/w500${showData.poster_path}` : '',
      backdropUrl: showData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${showData.backdrop_path}` : '',
      seasons,
      selectedSeason,
      episodes,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Erro ao consultar episódios no TMDB.' });
  }
});

app.post('/api/sources/check-url', async (req, res) => {
  const { streamUrl } = req.body as { streamUrl?: string };
  if (!streamUrl) {
    res.status(400).json({ error: 'URL ausente.' });
    return;
  }
  const target = streamUrl.startsWith('/') ? `http://127.0.0.1:${PORT}${streamUrl}` : streamUrl;
  let ok = false;
  let statusCode = 0;
  try {
    const head = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    statusCode = head.status;
    ok = head.ok || head.status === 405;
    if (head.status === 405) {
      const getRes = await fetch(target, {
        method: 'GET',
        headers: { Range: 'bytes=0-1024' },
        signal: AbortSignal.timeout(5000),
      });
      statusCode = getRes.status;
      ok = getRes.ok || getRes.status === 206;
    }
  } catch {
    ok = false;
  }
  res.json({ isWorking: ok, statusCode });
});

app.post('/api/proxy/parse-m3u', async (req, res) => {
  const { m3uUrl, m3uContent, sourceName, enrichWithTmdb, tmdbApiKey } = req.body as {
    m3uUrl?: string;
    m3uContent?: string;
    sourceName?: string;
    enrichWithTmdb?: boolean;
    tmdbApiKey?: string;
  };

  let rawText = m3uContent || '';
  if (m3uUrl?.trim()) {
    try {
      const fetchRes = await fetch(m3uUrl.trim(), { signal: AbortSignal.timeout(12000) });
      if (!fetchRes.ok) {
        res.status(400).json({ error: `Erro ao baixar lista M3U (HTTP ${fetchRes.status}).` });
        return;
      }
      rawText = await fetchRes.text();
    } catch (err) {
      res.status(400).json({
        error: `Não foi possível acessar a URL M3U: ${err instanceof Error ? err.message : 'erro de rede'}`,
      });
      return;
    }
  }

  if (!rawText.trim()) {
    res.status(400).json({ error: 'Cole o conteúdo M3U ou informe uma URL válida.' });
    return;
  }

  const parsed = parseM3uPlaylist(rawText);
  if (parsed.entries.length === 0) {
    res.status(400).json({ error: 'Nenhuma URL de stream válida foi encontrada na lista M3U.' });
    return;
  }

  const effectiveTmdbKey = (tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
  const shouldEnrich = Boolean(enrichWithTmdb && effectiveTmdbKey);
  const tmdbCache = new Map<string, Awaited<ReturnType<typeof fetchTmdbDetails>>>();
  let tmdbLookups = 0;

  const normalized = [];
  for (const entry of parsed.entries) {
    let tmdbMeta: Awaited<ReturnType<typeof fetchTmdbDetails>> = null;
    const cacheKey = `${entry.type}:${entry.tmdbId || entry.cleanTitle.toLowerCase()}:${entry.releaseYear || ''}`;
    if (shouldEnrich) {
      if (tmdbCache.has(cacheKey)) {
        tmdbMeta = tmdbCache.get(cacheKey) || null;
      } else if (tmdbLookups < 25) {
        tmdbLookups++;
        tmdbMeta = entry.tmdbId
          ? await fetchTmdbDetails(entry.type, entry.tmdbId, effectiveTmdbKey)
          : await searchTmdbFirstMatch(entry.cleanTitle, entry.type, entry.releaseYear, effectiveTmdbKey);
        tmdbCache.set(cacheKey, tmdbMeta);
      }
    }

    const finalTmdbId =
      tmdbMeta?.tmdbId || entry.tmdbId || generateDeterministicTmdbFallback(entry.cleanTitle, entry.releaseYear);

    normalized.push({
      tmdbId: finalTmdbId,
      imdbId: tmdbMeta?.imdbId || '',
      type: entry.type,
      title: tmdbMeta?.title || entry.cleanTitle,
      originalTitle: tmdbMeta?.originalTitle || '',
      overview: tmdbMeta?.overview || `Extraído automaticamente via lista M3U (${entry.groupTitle}).`,
      posterUrl: tmdbMeta?.posterUrl || entry.posterUrl || '',
      backdropUrl: tmdbMeta?.backdropUrl || entry.posterUrl || '',
      releaseYear: tmdbMeta?.releaseYear ?? entry.releaseYear,
      rating: tmdbMeta?.rating ?? null,
      genres: tmdbMeta?.genres || [entry.groupTitle],
      runtime: tmdbMeta?.runtime ?? null,
      sourceOrigin: 'm3u',
      season: entry.season ?? 0,
      episode: entry.episode ?? 0,
      episodeTitle: entry.episodeTitle || '',
      streamUrl: entry.streamUrl,
      quality: entry.quality,
      format: entry.format,
      language: entry.language,
      originProvider: sourceName?.trim() || 'Lista M3U Extraída',
    });
  }

  res.json({
    totalFound: parsed.entries.length,
    failedCount: parsed.invalidLines,
    tmdbLookups,
    entries: normalized,
  });
});

app.post('/api/proxy/parse-external', async (req, res) => {
  const {
    apiUrl,
    jsonPayload,
    sourceName,
    mapping,
    defaultType,
    authHeaderName,
    authHeaderValue,
    enrichWithTmdb,
    tmdbApiKey,
  } = req.body as {
    apiUrl?: string;
    jsonPayload?: string;
    sourceName?: string;
    mapping?: Partial<ExternalFieldMapping>;
    defaultType?: 'movie' | 'tv';
    authHeaderName?: string;
    authHeaderValue?: string;
    enrichWithTmdb?: boolean;
    tmdbApiKey?: string;
  };

  let parsedPayload: unknown = null;
  if (apiUrl?.trim()) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (authHeaderName?.trim() && authHeaderValue?.trim()) {
        headers[authHeaderName.trim()] = authHeaderValue.trim();
      }
      const extRes = await fetch(apiUrl.trim(), { headers, signal: AbortSignal.timeout(12000) });
      if (!extRes.ok) {
        res.status(400).json({ error: `API externa retornou HTTP ${extRes.status}.` });
        return;
      }
      parsedPayload = await extRes.json();
    } catch (err) {
      res.status(400).json({
        error: `Falha ao consultar API externa: ${err instanceof Error ? err.message : 'erro de rede'}`,
      });
      return;
    }
  } else if (jsonPayload?.trim()) {
    try {
      parsedPayload = JSON.parse(jsonPayload);
    } catch {
      res.status(400).json({ error: 'O JSON informado não é válido.' });
      return;
    }
  } else {
    res.status(400).json({ error: 'Informe uma URL de API externa ou cole um JSON.' });
    return;
  }

  const batch = extractFromExternalPayload(parsedPayload, mapping, defaultType === 'tv' ? 'tv' : 'movie');
  if (batch.items.length === 0) {
    res.status(400).json({
      error: 'Nenhum item válido extraído com o mapeamento atual.',
      details: batch.errors.slice(0, 5),
    });
    return;
  }

  const effectiveTmdbKey = (tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
  const shouldEnrich = Boolean(enrichWithTmdb && effectiveTmdbKey);
  let tmdbLookups = 0;

  const normalized = [];
  for (const item of batch.items) {
    let tmdbMeta: Awaited<ReturnType<typeof fetchTmdbDetails>> = null;
    if (shouldEnrich && tmdbLookups < 25) {
      tmdbLookups++;
      tmdbMeta = item.tmdbId
        ? await fetchTmdbDetails(item.type, item.tmdbId, effectiveTmdbKey)
        : await searchTmdbFirstMatch(item.title, item.type, item.releaseYear, effectiveTmdbKey);
    }

    const finalTmdbId =
      tmdbMeta?.tmdbId || item.tmdbId || generateDeterministicTmdbFallback(item.title, item.releaseYear);

    normalized.push({
      tmdbId: finalTmdbId,
      imdbId: tmdbMeta?.imdbId || item.imdbId || '',
      type: item.type,
      title: tmdbMeta?.title || item.title,
      originalTitle: tmdbMeta?.originalTitle || '',
      overview: tmdbMeta?.overview || item.overview || 'Extraído de API externa para o Cloud Firestore.',
      posterUrl: tmdbMeta?.posterUrl || item.posterUrl || '',
      backdropUrl: tmdbMeta?.backdropUrl || item.backdropUrl || item.posterUrl || '',
      releaseYear: tmdbMeta?.releaseYear ?? item.releaseYear,
      rating: tmdbMeta?.rating ?? item.rating,
      genres: tmdbMeta?.genres || [],
      runtime: tmdbMeta?.runtime ?? null,
      sourceOrigin: 'external_api',
      season: item.season ?? 0,
      episode: item.episode ?? 0,
      episodeTitle: item.episodeTitle || '',
      streamUrl: item.streamUrl,
      quality: item.quality,
      format: item.format,
      language: item.language,
      originProvider: sourceName?.trim() || 'API Externa Extraída',
    });
  }

  res.json({
    totalFound: batch.items.length + batch.skipped,
    failedCount: batch.errors.length,
    tmdbLookups,
    entries: normalized,
  });
});

function normalizeCrawlerFetchUrl(rawUrl: string): string {
  if (rawUrl.startsWith('/')) {
    return `http://127.0.0.1:${PORT}${rawUrl}`;
  }
  try {
    const parsed = new URL(rawUrl);
    if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && Number(parsed.port || 80) === PORT) {
      return `http://127.0.0.1:${PORT}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Keep original
  }
  return rawUrl;
}

function normalizeSavedStreamUrl(rawUrl: string): string {
  const localPrefix = `http://127.0.0.1:${PORT}/demo/`;
  if (rawUrl.startsWith(localPrefix)) {
    return `/demo/${rawUrl.slice(localPrefix.length)}`;
  }
  return rawUrl;
}

async function crawlEmbedUrlForStreams(
  entryUrl: string,
  maxDepth = 2
): Promise<{
  streams: ExtractedStreamCandidate[];
  httpStatus: number;
  blockedReason?: string;
  hopsVisited: number;
}> {
  const visited = new Set<string>();
  const queue: Array<{ url: string; referer: string; depth: number }> = [
    { url: normalizeCrawlerFetchUrl(entryUrl), referer: entryUrl, depth: 0 },
  ];
  const collected = new Map<string, ExtractedStreamCandidate>();
  let firstHttpStatus = 0;
  let blockedReason: string | undefined;
  let hopsVisited = 0;

  while (queue.length > 0 && hopsVisited < 8) {
    const current = queue.shift()!;
    if (visited.has(current.url)) continue;
    visited.add(current.url);
    hopsVisited++;

    let originReferer = current.referer;
    try {
      originReferer = new URL(current.referer).origin + '/';
    } catch {
      originReferer = current.referer;
    }

    let response: Response;
    try {
      response = await fetch(current.url, {
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          Referer: originReferer,
        },
        signal: AbortSignal.timeout(9000),
      });
    } catch (err) {
      if (hopsVisited === 1) {
        blockedReason = err instanceof Error ? err.message : 'Erro de conexão com o servidor de origem';
      }
      continue;
    }

    if (hopsVisited === 1) {
      firstHttpStatus = response.status;
    }

    if (!response.ok) {
      if (hopsVisited === 1) {
        blockedReason =
          response.status === 403 || response.status === 503
            ? `HTTP ${response.status} (Bloqueio anti-bot / Cloudflare no provedor de origem)`
            : `HTTP ${response.status}`;
      }
      continue;
    }

    const bodyText = await response.text();
    const resolvedBase = response.url || current.url;

    if (
      hopsVisited === 1 &&
      /Just a moment\.\.\.|cf-browser-verification|challenges\.cloudflare\.com/i.test(bodyText)
    ) {
      blockedReason = 'Proteção Cloudflare / Challenge detectada no embed de origem';
    }

    const artifacts = extractMediaStreamsFromDocument(bodyText, resolvedBase);
    for (const st of artifacts.streams) {
      const cleanUrl = normalizeSavedStreamUrl(st.url);
      if (!collected.has(cleanUrl)) {
        collected.set(cleanUrl, { ...st, url: cleanUrl });
      }
    }

    if (current.depth < maxDepth) {
      for (const nextJson of artifacts.jsonCandidates) {
        const target = normalizeCrawlerFetchUrl(nextJson);
        if (!visited.has(target)) {
          queue.push({ url: target, referer: resolvedBase, depth: current.depth + 1 });
        }
      }
      for (const nextIframe of artifacts.iframeHops) {
        const target = normalizeCrawlerFetchUrl(nextIframe);
        if (!visited.has(target)) {
          queue.push({ url: target, referer: resolvedBase, depth: current.depth + 1 });
        }
      }
    }
  }

  return {
    streams: Array.from(collected.values()),
    httpStatus: firstHttpStatus,
    blockedReason,
    hopsVisited,
  };
}

app.post('/api/proxy/extract-embeds', async (req, res) => {
  const {
    targetsInput,
    targets: explicitTargets,
    movieTemplate,
    tvTemplate,
    sourceName,
    enrichWithTmdb,
    tmdbApiKey,
    allowEmbedFallback,
  } = req.body as {
    targetsInput?: string;
    targets?: Array<{
      type: 'movie' | 'tv';
      tmdbId: number;
      season?: number;
      episode?: number;
      episodeTitle?: string;
      url?: string;
    }>;
    movieTemplate?: string;
    tvTemplate?: string;
    sourceName?: string;
    enrichWithTmdb?: boolean;
    tmdbApiKey?: string;
    allowEmbedFallback?: boolean;
  };

  const effMovieTpl = (movieTemplate || DEFAULT_MOVIE_EMBED_TEMPLATE).trim();
  const effTvTpl = (tvTemplate || DEFAULT_TV_EMBED_TEMPLATE).trim();

  let crawlTargets: EmbedCrawlTarget[] = [];
  if (Array.isArray(explicitTargets) && explicitTargets.length > 0) {
    crawlTargets = explicitTargets.map((t) => {
      const type = t.type === 'tv' ? 'tv' : 'movie';
      const season = type === 'tv' ? Math.max(1, Number(t.season || 1)) : 0;
      const episode = type === 'tv' ? Math.max(1, Number(t.episode || 1)) : 0;
      return {
        type,
        tmdbId: Math.max(1, Math.trunc(Number(t.tmdbId))),
        season,
        episode,
        episodeTitle: t.episodeTitle,
        url: t.url?.trim() || expandEmbedTemplate(type === 'tv' ? effTvTpl : effMovieTpl, {
          type,
          tmdbId: Number(t.tmdbId),
          season,
          episode,
        }),
      };
    });
  } else if (targetsInput?.trim()) {
    crawlTargets = parseEmbedTargetsInput(targetsInput, effMovieTpl, effTvTpl);
  }

  if (crawlTargets.length === 0) {
    res.status(400).json({
      error: 'Informe ao menos uma URL de embed (ex: https://embedmaster.link/movie/550) ou IDs TMDB válidos.',
    });
    return;
  }

  const boundedTargets = crawlTargets.slice(0, 40);
  const effectiveTmdbKey = (tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
  const shouldEnrich = Boolean(enrichWithTmdb && effectiveTmdbKey);
  const tmdbCache = new Map<string, Awaited<ReturnType<typeof fetchTmdbDetails>>>();
  let tmdbLookups = 0;

  const entries: Array<Record<string, unknown>> = [];
  const results: Array<{
    targetUrl: string;
    type: 'movie' | 'tv';
    tmdbId: number;
    season: number;
    episode: number;
    title: string;
    status: 'extracted' | 'fallback' | 'blocked_or_empty' | 'error';
    streamsFound: number;
    message: string;
  }> = [];

  let extractedDirectCount = 0;
  let fallbackCount = 0;
  let failedCount = 0;

  for (const target of boundedTargets) {
    let tmdbMeta: Awaited<ReturnType<typeof fetchTmdbDetails>> = null;
    const cacheKey = `${target.type}:${target.tmdbId}`;
    if (shouldEnrich) {
      if (tmdbCache.has(cacheKey)) {
        tmdbMeta = tmdbCache.get(cacheKey) || null;
      } else if (tmdbLookups < 25) {
        tmdbLookups++;
        tmdbMeta = await fetchTmdbDetails(target.type, target.tmdbId, effectiveTmdbKey);
        tmdbCache.set(cacheKey, tmdbMeta);
      }
    }

    const mediaTitle = tmdbMeta?.title || `${target.type === 'tv' ? 'Série' : 'Filme'} TMDB #${target.tmdbId}`;
    const crawl = await crawlEmbedUrlForStreams(target.url, 2);

    if (crawl.streams.length > 0) {
      extractedDirectCount++;
      for (const st of crawl.streams) {
        entries.push({
          tmdbId: target.tmdbId,
          imdbId: tmdbMeta?.imdbId || '',
          type: target.type,
          title: mediaTitle,
          originalTitle: tmdbMeta?.originalTitle || '',
          overview:
            tmdbMeta?.overview || `Stream extraído diretamente para o banco próprio (TMDB ${target.tmdbId}).`,
          posterUrl: tmdbMeta?.posterUrl || '',
          backdropUrl: tmdbMeta?.backdropUrl || tmdbMeta?.posterUrl || '',
          releaseYear: tmdbMeta?.releaseYear ?? null,
          rating: tmdbMeta?.rating ?? null,
          genres: tmdbMeta?.genres || [],
          runtime: tmdbMeta?.runtime ?? null,
          sourceOrigin: 'external_api',
          season: target.type === 'tv' ? target.season : 0,
          episode: target.type === 'tv' ? target.episode : 0,
          episodeTitle:
            target.type === 'tv' ? target.episodeTitle || `Episódio ${target.episode}` : '',
          streamUrl: st.url,
          quality: st.quality,
          format: st.format,
          language: st.language,
          originProvider: sourceName?.trim() || 'Extrator Embed Direto',
        });
      }
      results.push({
        targetUrl: target.url,
        type: target.type,
        tmdbId: target.tmdbId,
        season: target.season,
        episode: target.episode,
        title: mediaTitle,
        status: 'extracted',
        streamsFound: crawl.streams.length,
        message: `${crawl.streams.length} stream(s) direto(s) extraído(s) (${crawl.streams
          .map((s) => s.format.toUpperCase())
          .join(', ')}) em ${crawl.hopsVisited} etapa(s).`,
      });
    } else if (allowEmbedFallback && /^https?:\/\//i.test(target.url)) {
      fallbackCount++;
      entries.push({
        tmdbId: target.tmdbId,
        imdbId: tmdbMeta?.imdbId || '',
        type: target.type,
        title: mediaTitle,
        originalTitle: tmdbMeta?.originalTitle || '',
        overview:
          tmdbMeta?.overview || `Importado com player embed fallback (TMDB ${target.tmdbId}).`,
        posterUrl: tmdbMeta?.posterUrl || '',
        backdropUrl: tmdbMeta?.backdropUrl || tmdbMeta?.posterUrl || '',
        releaseYear: tmdbMeta?.releaseYear ?? null,
        rating: tmdbMeta?.rating ?? null,
        genres: tmdbMeta?.genres || [],
        runtime: tmdbMeta?.runtime ?? null,
        sourceOrigin: 'external_api',
        season: target.type === 'tv' ? target.season : 0,
        episode: target.type === 'tv' ? target.episode : 0,
        episodeTitle:
          target.type === 'tv' ? target.episodeTitle || `Episódio ${target.episode}` : '',
        streamUrl: target.url,
        quality: '1080p',
        format: 'embed',
        language: 'PT-BR',
        originProvider: sourceName?.trim() || 'Embed Fallback',
      });
      results.push({
        targetUrl: target.url,
        type: target.type,
        tmdbId: target.tmdbId,
        season: target.season,
        episode: target.episode,
        title: mediaTitle,
        status: 'fallback',
        streamsFound: 1,
        message: crawl.blockedReason
          ? `Stream direto bloqueado (${crawl.blockedReason}); salvo via fallback embed.`
          : 'Nenhum .m3u8/.mp4 exposto; salvo via fallback embed.',
      });
    } else {
      failedCount++;
      results.push({
        targetUrl: target.url,
        type: target.type,
        tmdbId: target.tmdbId,
        season: target.season,
        episode: target.episode,
        title: mediaTitle,
        status: crawl.blockedReason ? 'blocked_or_empty' : 'error',
        streamsFound: 0,
        message:
          crawl.blockedReason ||
          'Nenhum stream direto (.m3u8/.mp4) encontrado no HTML/JS deste embed.',
      });
    }
  }

  res.json({
    totalTargets: boundedTargets.length,
    extractedDirectCount,
    fallbackCount,
    failedCount,
    tmdbLookups,
    results,
    entries,
  });
});

async function fetchTmdbGenreMap(type: 'movie' | 'tv', apiKey: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/genre/${type}/list?api_key=${encodeURIComponent(apiKey)}&language=pt-BR`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return map;
    const data = (await res.json()) as { genres?: Array<{ id: number; name: string }> };
    for (const g of data.genres || []) {
      if (g.id && g.name) map.set(g.id, g.name);
    }
  } catch {
    // Non-fatal
  }
  return map;
}

app.post('/api/proxy/sync-catalog', async (req, res) => {
  const {
    movieTemplate,
    tvTemplate,
    sourceName,
    tmdbApiKey,
    includeMovies = true,
    includeSeries = true,
    movieCategories = ['popular', 'top_rated', 'now_playing'],
    tvCategories = ['popular', 'top_rated', 'on_the_air'],
    pagesPerCategory = 1,
    startPage,
    endPage,
    maxSeasonsPerSeries = 1,
    tryDirectExtraction = true,
    allowEmbedFallback = true,
    skipDirectProbe = false,
  } = req.body as {
    movieTemplate?: string;
    tvTemplate?: string;
    sourceName?: string;
    tmdbApiKey?: string;
    includeMovies?: boolean;
    includeSeries?: boolean;
    movieCategories?: string[];
    tvCategories?: string[];
    pagesPerCategory?: number;
    startPage?: number;
    endPage?: number;
    maxSeasonsPerSeries?: number;
    tryDirectExtraction?: boolean;
    allowEmbedFallback?: boolean;
    skipDirectProbe?: boolean;
  };

  const effectiveTmdbKey = (tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
  const effMovieTpl = (movieTemplate || DEFAULT_MOVIE_EMBED_TEMPLATE).trim();
  const effTvTpl = (tvTemplate || DEFAULT_TV_EMBED_TEMPLATE).trim();
  const effSourceName = (sourceName || 'EmbedMaster (Fonte Principal)').trim();

  const pStart = Math.max(1, Math.min(500, Number(startPage) || 1));
  const pEnd = endPage
    ? Math.max(pStart, Math.min(pStart + 4, Number(endPage)))
    : Math.max(pStart, Math.min(pStart + 4, pStart + Math.max(1, Number(pagesPerCategory) || 1) - 1));
  // 0 = all seasons (capped safely at 20 seasons per show)
  const rawMaxSeasons = Number(maxSeasonsPerSeries);
  const maxSeasons = rawMaxSeasons === 0 ? 20 : Math.max(1, Math.min(20, rawMaxSeasons || 1));

  const discoveryMode: 'tmdb_api' | 'tmdb_public_keyless' = effectiveTmdbKey
    ? 'tmdb_api'
    : 'tmdb_public_keyless';

  try {
    const discoveredMovies = new Map<number, CatalogSyncSeedItem>();
    const discoveredSeries = new Map<number, CatalogSyncSeedItem>();

    if (effectiveTmdbKey) {
      const [movieGenreMap, tvGenreMap] = await Promise.all([
        includeMovies ? fetchTmdbGenreMap('movie', effectiveTmdbKey) : Promise.resolve(new Map<number, string>()),
        includeSeries ? fetchTmdbGenreMap('tv', effectiveTmdbKey) : Promise.resolve(new Map<number, string>()),
      ]);

      if (includeMovies) {
        const validMovieCats = movieCategories.filter((c) =>
          ['popular', 'top_rated', 'now_playing'].includes(c)
        );
        const tasks: Array<Promise<void>> = [];
        for (const cat of validMovieCats) {
          for (let p = pStart; p <= pEnd; p++) {
            tasks.push(
              (async () => {
                const url = `https://api.themoviedb.org/3/movie/${cat}?api_key=${encodeURIComponent(
                  effectiveTmdbKey
                )}&language=pt-BR&page=${p}`;
                const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
                if (!r.ok) {
                  if (r.status === 401) throw new Error('TMDB_INVALID_KEY');
                  return;
                }
                const data = (await r.json()) as { results?: Array<Record<string, unknown>> };
                for (const raw of data.results || []) {
                  const id = Number(raw.id);
                  if (!id || discoveredMovies.has(id)) continue;
                  const dateStr = String(raw.release_date || '');
                  const year = dateStr.length >= 4 ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
                  const gIds = Array.isArray(raw.genre_ids) ? (raw.genre_ids as number[]) : [];
                  discoveredMovies.set(id, {
                    tmdbId: id,
                    type: 'movie',
                    title: String(raw.title || `TMDB #${id}`),
                    originalTitle: String(raw.original_title || ''),
                    overview: String(raw.overview || ''),
                    posterUrl: raw.poster_path ? `https://image.tmdb.org/t/p/w500${raw.poster_path}` : '',
                    backdropUrl: raw.backdrop_path ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}` : '',
                    releaseYear: Number.isFinite(year) ? year : null,
                    rating: typeof raw.vote_average === 'number' ? Number(raw.vote_average.toFixed(1)) : null,
                    genres: gIds.map((gid) => movieGenreMap.get(gid) || '').filter(Boolean),
                  });
                }
              })()
            );
          }
        }
        await Promise.all(tasks);
      }

      if (includeSeries) {
        const validTvCats = tvCategories.filter((c) => ['popular', 'top_rated', 'on_the_air'].includes(c));
        const tvTasks: Array<Promise<void>> = [];
        for (const cat of validTvCats) {
          for (let p = pStart; p <= pEnd; p++) {
            tvTasks.push(
              (async () => {
                const url = `https://api.themoviedb.org/3/tv/${cat}?api_key=${encodeURIComponent(
                  effectiveTmdbKey
                )}&language=pt-BR&page=${p}`;
                const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
                if (!r.ok) {
                  if (r.status === 401) throw new Error('TMDB_INVALID_KEY');
                  return;
                }
                const data = (await r.json()) as { results?: Array<Record<string, unknown>> };
                for (const raw of data.results || []) {
                  const id = Number(raw.id);
                  if (!id || discoveredSeries.has(id)) continue;
                  const dateStr = String(raw.first_air_date || '');
                  const year = dateStr.length >= 4 ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
                  const gIds = Array.isArray(raw.genre_ids) ? (raw.genre_ids as number[]) : [];
                  discoveredSeries.set(id, {
                    tmdbId: id,
                    type: 'tv',
                    title: String(raw.name || `TMDB #${id}`),
                    originalTitle: String(raw.original_name || ''),
                    overview: String(raw.overview || ''),
                    posterUrl: raw.poster_path ? `https://image.tmdb.org/t/p/w500${raw.poster_path}` : '',
                    backdropUrl: raw.backdrop_path ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}` : '',
                    releaseYear: Number.isFinite(year) ? year : null,
                    rating: typeof raw.vote_average === 'number' ? Number(raw.vote_average.toFixed(1)) : null,
                    genres: gIds.map((gid) => tvGenreMap.get(gid) || '').filter(Boolean),
                    episodes: [],
                  });
                }
              })()
            );
          }
        }
        await Promise.all(tvTasks);

        // Fetch real seasons & episodes for discovered TV series (bounded wave concurrency)
        const seriesList = Array.from(discoveredSeries.values());
        for (let w = 0; w < seriesList.length; w += 8) {
          const wave = seriesList.slice(w, w + 8);
          await Promise.all(
            wave.map(async (show) => {
              try {
                const showRes = await fetch(
                  `https://api.themoviedb.org/3/tv/${show.tmdbId}?api_key=${encodeURIComponent(
                    effectiveTmdbKey
                  )}&language=pt-BR`,
                  { signal: AbortSignal.timeout(7000) }
                );
                if (!showRes.ok) {
                  show.episodes = [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];
                  return;
                }
                const showData = (await showRes.json()) as {
                  seasons?: Array<{ season_number: number; episode_count: number }>;
                };
                const targetSeasons = (showData.seasons || [])
                  .filter((s) => s.season_number >= 1 && s.episode_count > 0)
                  .slice(0, maxSeasons);

                const episodes: Array<{ season: number; episode: number; episodeTitle: string }> = [];
                for (let sw = 0; sw < targetSeasons.length; sw += 4) {
                  const seasonWave = targetSeasons.slice(sw, sw + 4);
                  const seasonChunks = await Promise.all(
                    seasonWave.map(async (s) => {
                      const sRes = await fetch(
                        `https://api.themoviedb.org/3/tv/${show.tmdbId}/season/${s.season_number}?api_key=${encodeURIComponent(
                          effectiveTmdbKey
                        )}&language=pt-BR`,
                        { signal: AbortSignal.timeout(7000) }
                      );
                      if (!sRes.ok) return [];
                      const sData = (await sRes.json()) as {
                        episodes?: Array<{ episode_number: number; name?: string }>;
                      };
                      return (sData.episodes || []).map((ep) => ({
                        season: s.season_number,
                        episode: ep.episode_number,
                        episodeTitle: ep.name || `Episódio ${ep.episode_number}`,
                      }));
                    })
                  );
                  for (const chunk of seasonChunks) {
                    episodes.push(...chunk);
                  }
                }
                show.episodes =
                  episodes.length > 0 ? episodes : [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];
              } catch {
                show.episodes = [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];
              }
            })
          );
        }
      }
    } else {
      // Keyless Public Catalog Mode (TMDB public pt-BR catalog pages -> real IDs, titles, posters, seasons, episodes)
      const movieCatSlugs: Record<string, string> = {
        popular: 'movie',
        top_rated: 'movie/top-rated',
        now_playing: 'movie/now-playing',
      };
      const tvCatSlugs: Record<string, string> = {
        popular: 'tv',
        top_rated: 'tv/top-rated',
        on_the_air: 'tv/on-the-air',
      };

      const movieTasks: Array<Promise<void>> = [];
      if (includeMovies) {
        for (const cat of movieCategories) {
          const slug = movieCatSlugs[cat];
          if (!slug) continue;
          for (let p = pStart; p <= pEnd; p++) {
            movieTasks.push(
              (async () => {
                const html = await fetchTmdbWebHtml(`https://www.themoviedb.org/${slug}?language=pt-BR&page=${p}`);
                if (!html) return;
                for (const item of parseTmdbWebCatalogHtml(html, 'movie')) {
                  if (!discoveredMovies.has(item.tmdbId)) {
                    discoveredMovies.set(item.tmdbId, {
                      tmdbId: item.tmdbId,
                      type: 'movie',
                      title: item.title,
                      originalTitle: '',
                      overview: `Catálogo ${effSourceName} sincronizado pelo TMDB #${item.tmdbId}.`,
                      posterUrl: item.posterUrl,
                      backdropUrl: item.backdropUrl,
                      releaseYear: item.releaseYear,
                      rating: null,
                      genres: [],
                    });
                  }
                }
              })()
            );
          }
        }
      }

      const tvTasks: Array<Promise<void>> = [];
      if (includeSeries) {
        for (const cat of tvCategories) {
          const slug = tvCatSlugs[cat];
          if (!slug) continue;
          for (let p = pStart; p <= pEnd; p++) {
            tvTasks.push(
              (async () => {
                const html = await fetchTmdbWebHtml(`https://www.themoviedb.org/${slug}?language=pt-BR&page=${p}`);
                if (!html) return;
                for (const item of parseTmdbWebCatalogHtml(html, 'tv')) {
                  if (!discoveredSeries.has(item.tmdbId)) {
                    discoveredSeries.set(item.tmdbId, {
                      tmdbId: item.tmdbId,
                      type: 'tv',
                      title: item.title,
                      originalTitle: '',
                      overview: `Série ${effSourceName} sincronizada pelo TMDB #${item.tmdbId}.`,
                      posterUrl: item.posterUrl,
                      backdropUrl: item.backdropUrl,
                      releaseYear: item.releaseYear,
                      rating: null,
                      genres: [],
                      episodes: [],
                    });
                  }
                }
              })()
            );
          }
        }
      }

      await Promise.all([...movieTasks, ...tvTasks]);

      // Fetch real seasons & episodes for discovered TV series (keyless)
      if (includeSeries && discoveredSeries.size > 0) {
        const seriesList = Array.from(discoveredSeries.values());
        for (let w = 0; w < seriesList.length; w += 6) {
          const wave = seriesList.slice(w, w + 6);
          await Promise.all(
            wave.map(async (show) => {
              try {
                const seasonsHtml = await fetchTmdbWebHtml(
                  `https://www.themoviedb.org/tv/${show.tmdbId}/seasons?language=pt-BR`
                );
                const parsedSeasons = seasonsHtml
                  ? parseTmdbWebSeasonsHtml(seasonsHtml, show.tmdbId)
                  : [1];
                const targetSeasons = (parsedSeasons.length > 0 ? parsedSeasons : [1]).slice(0, maxSeasons);

                const episodes: Array<{ season: number; episode: number; episodeTitle: string }> = [];
                for (let sw = 0; sw < targetSeasons.length; sw += 4) {
                  const sWave = targetSeasons.slice(sw, sw + 4);
                  const epBatches = await Promise.all(
                    sWave.map(async (sNum) => {
                      const epHtml = await fetchTmdbWebHtml(
                        `https://www.themoviedb.org/tv/${show.tmdbId}/season/${sNum}?language=pt-BR`
                      );
                      return epHtml ? parseTmdbWebEpisodesHtml(epHtml, sNum) : [];
                    })
                  );
                  for (const batch of epBatches) {
                    episodes.push(...batch);
                  }
                }

                show.episodes =
                  episodes.length > 0 ? episodes : [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];
              } catch {
                show.episodes = [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];
              }
            })
          );
        }
      }
    }

    const seedItems: CatalogSyncSeedItem[] = [
      ...Array.from(discoveredMovies.values()),
      ...Array.from(discoveredSeries.values()),
    ];

    if (seedItems.length === 0) {
      res.status(400).json({ error: 'Nenhum filme ou série encontrado para este intervalo de páginas.' });
      return;
    }

    // Probe primary embed provider first with fast Cloudflare circuit breaker
    const extractedStreamsByTarget = new Map<string, ExtractedStreamCandidate[]>();
    let cloudflareDetected = false;
    let providerProbeMessage =
      discoveryMode === 'tmdb_public_keyless'
        ? 'Catálogo descoberto automaticamente (Modo Sem Chave) e vinculado à Fonte Principal Embed.'
        : 'Sincronizado via Fonte Principal Embed.';
    let directExtractedCount = 0;

    if (tryDirectExtraction && !skipDirectProbe) {
      const firstMovie = discoveredMovies.values().next().value as CatalogSyncSeedItem | undefined;
      const firstSeries = discoveredSeries.values().next().value as CatalogSyncSeedItem | undefined;
      const probeTarget = firstMovie
        ? {
            key: `movie:${firstMovie.tmdbId}:0:0`,
            url: expandEmbedTemplate(effMovieTpl, { type: 'movie', tmdbId: firstMovie.tmdbId }),
          }
        : firstSeries
          ? {
              key: `tv:${firstSeries.tmdbId}:1:1`,
              url: expandEmbedTemplate(effTvTpl, {
                type: 'tv',
                tmdbId: firstSeries.tmdbId,
                season: 1,
                episode: 1,
              }),
            }
          : null;

      if (probeTarget) {
        const probe = await crawlEmbedUrlForStreams(probeTarget.url, 1);
        if (probe.streams.length > 0) {
          extractedStreamsByTarget.set(probeTarget.key, probe.streams);
          directExtractedCount++;
          providerProbeMessage = 'Provedor expôs streams diretos (.m3u8/.mp4); extraindo links independentes.';

          const remainingProbes: Array<{ key: string; url: string }> = [];
          for (const item of seedItems) {
            if (item.type === 'movie') {
              const k = `movie:${item.tmdbId}:0:0`;
              if (k !== probeTarget.key) {
                remainingProbes.push({
                  key: k,
                  url: expandEmbedTemplate(effMovieTpl, { type: 'movie', tmdbId: item.tmdbId }),
                });
              }
            } else {
              for (const ep of item.episodes || []) {
                const k = `tv:${item.tmdbId}:${ep.season}:${ep.episode}`;
                if (k !== probeTarget.key) {
                  remainingProbes.push({
                    key: k,
                    url: expandEmbedTemplate(effTvTpl, {
                      type: 'tv',
                      tmdbId: item.tmdbId,
                      season: ep.season,
                      episode: ep.episode,
                    }),
                  });
                }
              }
            }
          }

          const boundedRemaining = remainingProbes.slice(0, 40);
          for (let w = 0; w < boundedRemaining.length; w += 6) {
            const wave = boundedRemaining.slice(w, w + 6);
            await Promise.all(
              wave.map(async (t) => {
                const r = await crawlEmbedUrlForStreams(t.url, 1);
                if (r.streams.length > 0) {
                  extractedStreamsByTarget.set(t.key, r.streams);
                  directExtractedCount++;
                }
              })
            );
          }
        } else if (probe.blockedReason && /403|Cloudflare|Challenge/i.test(probe.blockedReason)) {
          cloudflareDetected = true;
          providerProbeMessage = allowEmbedFallback
            ? `A origem (${probe.blockedReason}) bloqueou extração server-side; os títulos foram vinculados via Fonte Principal Embed para reprodução direta no navegador.`
            : `A origem bloqueou extração server-side (${probe.blockedReason}).`;
        } else {
          providerProbeMessage =
            probe.blockedReason || 'Nenhum .m3u8/.mp4 direto no HTML; vínculos salvos via Fonte Principal Embed.';
        }
      }
    } else if (skipDirectProbe) {
      cloudflareDetected = true;
      providerProbeMessage =
        'Lote sincronizado diretamente via Fonte Principal Embed (circuit-breaker ativo).';
    }

    const entries = buildPrimarySourceEntries(seedItems, {
      movieTemplate: effMovieTpl,
      tvTemplate: effTvTpl,
      sourceName: effSourceName,
      extractedStreamsByTarget,
      allowEmbedFallback,
    });

    const moviesCount = discoveredMovies.size;
    const seriesListSynced = Array.from(discoveredSeries.values());
    const episodesCount = seriesListSynced.reduce((acc, s) => acc + (s.episodes?.length || 0), 0);
    const embedFallbackCount = entries.filter((e) => e.format === 'embed').length;

    res.json({
      discoveryMode,
      startPage: pStart,
      endPage: pEnd,
      hasMorePages: seedItems.length > 0,
      moviesCount,
      seriesCount: seriesListSynced.length,
      episodesCount,
      totalEntries: entries.length,
      directExtractedCount,
      embedFallbackCount,
      cloudflareDetected,
      providerProbeMessage,
      entries,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'TMDB_INVALID_KEY') {
      res.status(401).json({ error: 'Chave API do TMDB inválida. Verifique sua chave v3 e tente novamente.' });
      return;
    }
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Erro ao sincronizar catálogos.',
    });
  }
});

// =======================
// PROPRIETARY PUBLIC API v1 (Backed directly by Cloud Firestore)
// =======================
async function validateFirestoreApiKey(providedKey: string) {
  if (!providedKey || !/^[a-zA-Z0-9_\-]+$/.test(providedKey)) return null;
  const doc = await firestoreRestGetDoc(`api_keys/${providedKey}`);
  if (!doc || doc.status !== 'active') return null;
  return doc;
}

app.get('/api/v1/catalog', async (req, res) => {
  const providedKey = String(req.headers['x-api-key'] || req.query.api_key || req.query.key || '').trim();
  const keyDoc = await validateFirestoreApiKey(providedKey);
  if (!keyDoc) {
    res.status(401).json({
      error: 'API Key inválida ou ausente. Envie via header x-api-key ou query ?api_key=...',
    });
    return;
  }

  const typeFilter = req.query.type === 'movie' || req.query.type === 'tv' ? req.query.type : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const page = Math.max(1, Number(req.query.page || 1));

  const filters: Array<{ field: string; value: string | number | boolean }> = [
    { field: 'status', value: 'published' },
  ];
  if (typeFilter) {
    filters.push({ field: 'type', value: typeFilter });
  }

  const firestoreRows = await firestoreRestRunQuery('', 'media_items', filters, 1000);
  const apiKey = process.env.TMDB_API_KEY || '';
  const apiCatalog = await discoverEmbedMasterCatalogPage(
    page,
    typeFilter || 'all',
    apiKey
  ).catch(() => ({ items: [] as Array<Record<string, unknown>> }));

  const seenIds = new Set<string>();
  const combined: Array<Record<string, unknown>> = [];
  for (const r of firestoreRows) {
    const id = String(r.id || `${r.type}_${r.tmdbId}`);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    combined.push(r);
  }
  for (const r of apiCatalog.items) {
    const id = String(r.id || `${r.type}_${r.tmdbId}`);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    combined.push(r);
  }

  const start = page === 1 ? 0 : 0;
  const sliced =
    firestoreRows.length >= page * limit
      ? combined.slice((page - 1) * limit, page * limit)
      : combined.slice(start, start + limit);
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.json({
    source: 'firebase-firestore+embedmaster-api',
    page,
    limit,
    total: combined.length,
    results: sliced.map((r) => ({
      id: r.id,
      tmdbId: r.tmdbId,
      type: r.type,
      title: r.title,
      overview: r.overview,
      posterUrl: r.posterUrl,
      releaseYear: r.releaseYear || null,
      rating: r.rating || null,
      sourcesCount: r.sourcesCount || 1,
      embedUrl:
        r.type === 'tv'
          ? `${baseUrl}/embed/tv/${r.tmdbId}/1/1`
          : `${baseUrl}/embed/movie/${r.tmdbId}`,
    })),
  });
});

app.get('/api/v1/media/:type/:tmdbId', async (req, res) => {
  const providedKey = String(req.headers['x-api-key'] || req.query.api_key || req.query.key || '').trim();
  const keyDoc = await validateFirestoreApiKey(providedKey);
  if (!keyDoc) {
    res.status(401).json({
      error: 'API Key inválida ou ausente. Envie via header x-api-key ou query ?api_key=...',
    });
    return;
  }

  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const tmdbId = Number(req.params.tmdbId);
  if (!tmdbId || tmdbId < 1) {
    res.status(400).json({ error: 'TMDB ID inválido.' });
    return;
  }

  const mediaKey = `${type}_${tmdbId}`;
  const mediaDoc = await firestoreRestGetDoc(`media_items/${mediaKey}`);
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  if (mediaDoc && mediaDoc.status === 'published') {
    const sources = await firestoreRestRunQuery(`media_items/${mediaKey}`, 'sources', [
      { field: 'parentStatus', value: 'published' },
    ]);
    res.json({
      source: 'firebase-firestore',
      ...mediaDoc,
      sources:
        sources.length > 0 ? sources : buildFallbackEmbedSources(type, tmdbId),
      embedUrl:
        type === 'tv'
          ? `${baseUrl}/embed/tv/${tmdbId}/1/1`
          : `${baseUrl}/embed/movie/${tmdbId}`,
    });
    return;
  }

  const apiKey = process.env.TMDB_API_KEY || '';
  const meta = await resolvePublicMediaMetaAndEpisodes(type, tmdbId, 1, apiKey);
  const dynamicSources = buildFallbackEmbedSources(type, tmdbId, meta.episodes);

  res.json({
    source: 'embedmaster-api',
    id: mediaKey,
    tmdbId,
    type,
    title: meta.title,
    overview: meta.overview,
    posterUrl: meta.posterUrl,
    backdropUrl: meta.backdropUrl,
    releaseYear: meta.releaseYear,
    status: 'published',
    sourcesCount: dynamicSources.length,
    sources: dynamicSources,
    embedUrl:
      type === 'tv'
        ? `${baseUrl}/embed/tv/${tmdbId}/1/1`
        : `${baseUrl}/embed/movie/${tmdbId}`,
  });
});

// =======================
// STANDALONE EMBED PLAYER ENDPOINTS (Firestore + EmbedMaster Live Fallback)
// =======================
async function handleEmbedRequest(req: express.Request, res: express.Response, type: 'movie' | 'tv') {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  const tmdbId = Number(req.params.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId < 1) {
    res
      .status(400)
      .send(renderEmbedErrorHtml('ID TMDB inválido', 'Informe um TMDB ID numérico válido.', 400));
    return;
  }

  const season = type === 'tv' ? Math.max(1, Number(req.params.season || 1)) : 0;
  const episode = type === 'tv' ? Math.max(1, Number(req.params.episode || 1)) : 0;
  const apiKeyParam = String(req.query.key || req.query.api_key || '').trim();

  const platformSettings = await firestoreRestGetDoc('settings/platform');
  const defaultColor = String(platformSettings?.defaultPlayerColor || '#2563EB');
  const watermarkText = String(platformSettings?.embedWatermarkText || 'CineVault Player');
  const requireKey = Boolean(platformSettings?.requireApiKeyForEmbed);
  const colorParam = String(req.query.color || defaultColor);

  const keyDoc = apiKeyParam ? await validateFirestoreApiKey(apiKeyParam) : null;

  if (requireKey && !keyDoc) {
    res
      .status(403)
      .send(
        renderEmbedErrorHtml(
          'Chave API obrigatória',
          'Informe uma chave ativa no parâmetro ?key=SUA_CHAVE para reproduzir este embed.',
          403
        )
      );
    return;
  }

  const referer = String(req.headers.referer || '');
  let refererHost = '';
  try {
    if (referer) refererHost = new URL(referer).hostname.toLowerCase();
  } catch {
    refererHost = '';
  }

  const allowedDomainsStr = String(keyDoc?.allowedDomains || '*');
  if (keyDoc && allowedDomainsStr !== '*' && refererHost) {
    const allowed = allowedDomainsStr
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const currentHost = (req.get('host') || '').split(':')[0].toLowerCase();
    if (refererHost !== currentHost && !allowed.some((d) => refererHost === d || refererHost.endsWith(`.${d}`))) {
      res
        .status(403)
        .send(
          renderEmbedErrorHtml(
            'Domínio não autorizado',
            `O domínio "${refererHost}" não está na lista de domínios permitidos desta chave.`,
            403
          )
        );
      return;
    }
  }

  const mediaKey = `${type}_${tmdbId}`;
  const mediaDoc = await firestoreRestGetDoc(`media_items/${mediaKey}`);
  const isPublishedInFirestore = Boolean(mediaDoc && mediaDoc.status === 'published');

  const allSources = isPublishedInFirestore
    ? await firestoreRestRunQuery(`media_items/${mediaKey}`, 'sources', [
        { field: 'parentStatus', value: 'published' },
      ])
    : [];

  let matchingSources =
    type === 'tv'
      ? allSources.filter((s) => Number(s.season || 1) === season && Number(s.episode || 1) === episode)
      : allSources;

  let resolvedTitle = isPublishedInFirestore ? String(mediaDoc?.title || `TMDB ${tmdbId}`) : '';
  let resolvedOverview = isPublishedInFirestore ? String(mediaDoc?.overview || '') : '';
  let resolvedPoster = isPublishedInFirestore ? String(mediaDoc?.posterUrl || '') : '';
  let resolvedBackdrop = isPublishedInFirestore ? String(mediaDoc?.backdropUrl || '') : '';
  let resolvedYear = isPublishedInFirestore && mediaDoc?.releaseYear ? Number(mediaDoc.releaseYear) : null;

  const episodesMap = new Map<string, { season: number; episode: number; episodeTitle: string | null }>();
  if (type === 'tv') {
    for (const s of allSources) {
      const sNum = Number(s.season || 1);
      const eNum = Number(s.episode || 1);
      const k = `${sNum}:${eNum}`;
      if (!episodesMap.has(k)) {
        episodesMap.set(k, {
          season: sNum,
          episode: eNum,
          episodeTitle: s.episodeTitle ? String(s.episodeTitle) : null,
        });
      }
    }
  }

  // Fallback directly to EmbedMaster Primary API + TMDB public metadata when not saved in Firestore yet
  if (!isPublishedInFirestore || matchingSources.length === 0) {
    const publicMeta = await resolvePublicMediaMetaAndEpisodes(
      type,
      tmdbId,
      type === 'tv' ? season : 1,
      process.env.TMDB_API_KEY || ''
    );
    if (!resolvedTitle) resolvedTitle = publicMeta.title;
    if (!resolvedOverview) resolvedOverview = publicMeta.overview;
    if (!resolvedPoster) resolvedPoster = publicMeta.posterUrl;
    if (!resolvedBackdrop) resolvedBackdrop = publicMeta.backdropUrl;
    if (!resolvedYear) resolvedYear = publicMeta.releaseYear;

    if (type === 'tv' && publicMeta.episodes) {
      for (const ep of publicMeta.episodes) {
        const k = `${ep.season}:${ep.episode}`;
        if (!episodesMap.has(k)) {
          episodesMap.set(k, {
            season: ep.season,
            episode: ep.episode,
            episodeTitle: ep.episodeTitle || null,
          });
        }
      }
    }

    if (matchingSources.length === 0) {
      const fallbackUrl = expandEmbedTemplate(
        type === 'tv' ? DEFAULT_TV_EMBED_TEMPLATE : DEFAULT_MOVIE_EMBED_TEMPLATE,
        { type, tmdbId, season, episode }
      );
      const matchedEpTitle =
        type === 'tv' ? episodesMap.get(`${season}:${episode}`)?.episodeTitle || `Episódio ${episode}` : null;
      matchingSources = [
        {
          id: 'embedmaster_live',
          season: type === 'tv' ? season : 0,
          episode: type === 'tv' ? episode : 0,
          episodeTitle: matchedEpTitle || '',
          streamUrl: fallbackUrl,
          quality: '1080p',
          format: 'embed',
          language: 'PT-BR',
          originProvider: 'EmbedMaster (API Principal)',
        },
      ];
    }
  }

  const episodesList = Array.from(episodesMap.values()).sort(
    (a, b) => a.season - b.season || a.episode - b.episode
  );

  const html = renderEmbedPlayerHtml(
    {
      id: 0,
      tmdbId,
      type,
      title: resolvedTitle || `TMDB ${tmdbId}`,
      overview: resolvedOverview,
      posterUrl: resolvedPoster,
      backdropUrl: resolvedBackdrop,
      releaseYear: resolvedYear,
      season: type === 'tv' ? season : null,
      episode: type === 'tv' ? episode : null,
      accentColor: colorParam,
      watermarkText,
      sources: matchingSources.map((s, idx) => ({
        id: idx + 1,
        season: s.season !== undefined ? Number(s.season) : null,
        episode: s.episode !== undefined ? Number(s.episode) : null,
        episodeTitle: s.episodeTitle ? String(s.episodeTitle) : null,
        streamUrl: String(s.streamUrl || ''),
        quality: String(s.quality || '1080p'),
        format: String(s.format || 'hls'),
        language: String(s.language || 'PT-BR'),
        originProvider: String(s.originProvider || 'Firestore'),
      })),
      episodes: episodesList,
    },
    apiKeyParam
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get('/embed/movie/:tmdbId', (req, res) => handleEmbedRequest(req, res, 'movie'));
app.get('/embed/tv/:tmdbId/:season/:episode', (req, res) => handleEmbedRequest(req, res, 'tv'));

// =======================
// VITE DEV / PROD STATIC MOUNTING
// =======================
async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CineVault API server listening on http://localhost:${PORT} (Firebase Firestore backend)`);
  });
}

startServer();

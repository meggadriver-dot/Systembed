import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { firestoreRestGetDoc, firestoreRestRunQuery } from './src/server/firestoreRest.ts';
import { renderEmbedErrorHtml, renderEmbedPlayerHtml } from './src/server/embedHtml.ts';
import { parseM3uPlaylist } from './src/utils/m3uParser.ts';
import {
  extractFromExternalPayload,
  generateDeterministicTmdbFallback,
  type ExternalFieldMapping,
} from './src/utils/externalExtractor.ts';

dotenv.config();

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

// =======================
// TMDB & STREAM PROXIES (Stateless — data persists in Firestore)
// =======================
app.get('/api/tmdb/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || process.env.TMDB_API_KEY || '';

  if (!apiKey) {
    res.json({
      configured: false,
      message: 'Configure sua chave TMDB v3 em Chaves API & Conta para buscar na base oficial do TMDB.',
      results: [],
    });
    return;
  }

  if (!query) {
    res.json({ configured: true, results: [] });
    return;
  }

  try {
    const url = `https://api.themoviedb.org/3/search/${type}?api_key=${encodeURIComponent(
      apiKey
    )}&language=pt-BR&query=${encodeURIComponent(query)}`;
    const tmdbRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!tmdbRes.ok) {
      res.status(tmdbRes.status).json({ error: 'Falha ao consultar API do TMDB. Verifique sua chave.' });
      return;
    }
    const payload = (await tmdbRes.json()) as { results?: Array<Record<string, unknown>> };
    const results = (payload.results || []).slice(0, 12).map((item) => {
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

app.get('/api/tmdb/details/:type/:tmdbId', async (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const tmdbId = Number(req.params.tmdbId);
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || process.env.TMDB_API_KEY || '';
  if (!apiKey) {
    res.status(400).json({ error: 'Chave API do TMDB não configurada.' });
    return;
  }
  const details = await fetchTmdbDetails(type, tmdbId, apiKey);
  if (!details) {
    res.status(404).json({ error: 'Título não encontrado no TMDB.' });
    return;
  }
  res.json(details);
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

  const allRows = await firestoreRestRunQuery('', 'media_items', filters, 200);
  const start = (page - 1) * limit;
  const sliced = allRows.slice(start, start + limit);
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.json({
    source: 'firebase-firestore',
    page,
    limit,
    total: allRows.length,
    results: sliced.map((r) => ({
      id: r.id,
      tmdbId: r.tmdbId,
      type: r.type,
      title: r.title,
      overview: r.overview,
      posterUrl: r.posterUrl,
      releaseYear: r.releaseYear || null,
      rating: r.rating || null,
      sourcesCount: r.sourcesCount || 0,
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
  const mediaKey = `${type}_${tmdbId}`;
  const mediaDoc = await firestoreRestGetDoc(`media_items/${mediaKey}`);

  if (!mediaDoc || mediaDoc.status !== 'published') {
    res.status(404).json({ error: 'Título não encontrado no Cloud Firestore.' });
    return;
  }

  const sources = await firestoreRestRunQuery(`media_items/${mediaKey}`, 'sources', [
    { field: 'parentStatus', value: 'published' },
  ]);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    source: 'firebase-firestore',
    ...mediaDoc,
    sources,
    embedUrl:
      type === 'tv'
        ? `${baseUrl}/embed/tv/${tmdbId}/1/1`
        : `${baseUrl}/embed/movie/${tmdbId}`,
  });
});

// =======================
// STANDALONE EMBED PLAYER ENDPOINTS (Backed directly by Cloud Firestore)
// =======================
async function handleEmbedRequest(req: express.Request, res: express.Response, type: 'movie' | 'tv') {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  const tmdbId = Number(req.params.tmdbId);
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
  if (!mediaDoc || mediaDoc.status !== 'published') {
    res
      .status(404)
      .send(
        renderEmbedErrorHtml(
          'Conteúdo não encontrado',
          `O ${type === 'tv' ? 'seriado' : 'filme'} com TMDB ID ${tmdbId} ainda não foi cadastrado no Firebase Firestore.`,
          404
        )
      );
    return;
  }

  const allSources = await firestoreRestRunQuery(`media_items/${mediaKey}`, 'sources', [
    { field: 'parentStatus', value: 'published' },
  ]);

  const matchingSources =
    type === 'tv'
      ? allSources.filter((s) => Number(s.season || 1) === season && Number(s.episode || 1) === episode)
      : allSources;

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

  const episodesList = Array.from(episodesMap.values()).sort(
    (a, b) => a.season - b.season || a.episode - b.episode
  );

  const html = renderEmbedPlayerHtml(
    {
      id: 0,
      tmdbId,
      type,
      title: String(mediaDoc.title || `TMDB ${tmdbId}`),
      overview: String(mediaDoc.overview || ''),
      posterUrl: String(mediaDoc.posterUrl || ''),
      backdropUrl: String(mediaDoc.backdropUrl || ''),
      releaseYear: mediaDoc.releaseYear ? Number(mediaDoc.releaseYear) : null,
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

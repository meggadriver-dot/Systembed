import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  db,
  initDatabase,
  hashPassword,
  verifyPassword,
  generateApiKey,
  getSetting,
  setSetting,
} from './src/server/db.ts';
import { renderEmbedErrorHtml, renderEmbedPlayerHtml } from './src/server/embedHtml.ts';
import { parseM3uPlaylist } from './src/utils/m3uParser.ts';
import {
  extractFromExternalPayload,
  generateDeterministicTmdbFallback,
  type ExternalFieldMapping,
} from './src/utils/externalExtractor.ts';

dotenv.config();
initDatabase();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// CORS headers so external sites/apps can call the proprietary API
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

// Serve hls.js locally for standalone /embed/* endpoints (zero external CDN dependency)
app.get('/vendor/hls.min.js', (_req, res) => {
  const hlsPath = path.resolve(process.cwd(), 'node_modules/hls.js/dist/hls.min.js');
  if (fs.existsSync(hlsPath)) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(hlsPath);
    return;
  }
  res.status(404).send('// hls.js not found');
});

// Serve local demo MP4 and HLS test streams (excluding cinevault.db)
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

interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'developer';
  plan: string;
  createdAt: string;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      out[k] = v;
    }
  }
  return out;
}

function getAuthenticatedUser(req: express.Request): AuthUser | null {
  const authHeader = req.headers.authorization;
  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.cv_session || '';
  }
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.plan, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token) as
    | { id: number; name: string; email: string; role: string; plan: string; created_at: string }
    | undefined;

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === 'admin' ? 'admin' : 'developer',
    plan: row.plan,
    createdAt: row.created_at,
  };
}

function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`
  ).run(userId, token);
  return token;
}

function mapMediaRow(row: Record<string, unknown>, includeSources = false) {
  let genres: string[] = [];
  try {
    genres = JSON.parse(String(row.genres_json || '[]'));
  } catch {
    genres = [];
  }

  const base = {
    id: Number(row.id),
    tmdbId: Number(row.tmdb_id),
    imdbId: row.imdb_id ? String(row.imdb_id) : null,
    type: String(row.type) as 'movie' | 'tv',
    title: String(row.title),
    originalTitle: row.original_title ? String(row.original_title) : null,
    overview: String(row.overview || ''),
    posterUrl: String(row.poster_url || ''),
    backdropUrl: String(row.backdrop_url || ''),
    releaseYear: row.release_year !== null && row.release_year !== undefined ? Number(row.release_year) : null,
    rating: row.rating !== null && row.rating !== undefined ? Number(row.rating) : null,
    genres,
    runtime: row.runtime !== null && row.runtime !== undefined ? Number(row.runtime) : null,
    status: String(row.status) as 'published' | 'draft',
    sourceOrigin: String(row.source_origin),
    sourcesCount: row.sources_count !== undefined ? Number(row.sources_count) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };

  if (includeSources) {
    const sourcesRows = db
      .prepare(
        `SELECT * FROM media_sources WHERE media_id = ? ORDER BY COALESCE(season, 0) ASC, COALESCE(episode, 0) ASC, id ASC`
      )
      .all(base.id) as Array<Record<string, unknown>>;

    return {
      ...base,
      sources: sourcesRows.map((s) => ({
        id: Number(s.id),
        mediaId: Number(s.media_id),
        season: s.season !== null && s.season !== undefined ? Number(s.season) : null,
        episode: s.episode !== null && s.episode !== undefined ? Number(s.episode) : null,
        episodeTitle: s.episode_title ? String(s.episode_title) : null,
        streamUrl: String(s.stream_url),
        quality: String(s.quality),
        format: String(s.format),
        language: String(s.language),
        isWorking: Boolean(s.is_working),
        lastCheckedAt: s.last_checked_at ? String(s.last_checked_at) : null,
        originProvider: String(s.origin_provider),
        createdAt: String(s.created_at),
      })),
    };
  }

  return base;
}

async function fetchTmdbDetails(
  type: 'movie' | 'tv',
  tmdbId: number,
  apiKey: string
): Promise<{
  tmdbId: number;
  imdbId: string | null;
  title: string;
  originalTitle: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number | null;
  rating: number | null;
  genres: string[];
  runtime: number | null;
} | null> {
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
      imdbId: extIds.imdb_id ? String(extIds.imdb_id) : data.imdb_id ? String(data.imdb_id) : null,
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

async function searchTmdbFirstMatch(
  query: string,
  type: 'movie' | 'tv',
  year: number | null,
  apiKey: string
) {
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

function upsertMediaAndSource(params: {
  tmdbId: number;
  imdbId?: string | null;
  type: 'movie' | 'tv';
  title: string;
  originalTitle?: string | null;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  releaseYear?: number | null;
  rating?: number | null;
  genres?: string[];
  runtime?: number | null;
  sourceOrigin: string;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  streamUrl: string;
  quality: string;
  format: string;
  language: string;
  originProvider: string;
}) {
  const existing = db
    .prepare('SELECT id FROM media_items WHERE tmdb_id = ? AND type = ?')
    .get(params.tmdbId, params.type) as { id: number } | undefined;

  let mediaId: number;
  if (existing) {
    mediaId = existing.id;
    db.prepare(
      `UPDATE media_items
       SET title = COALESCE(NULLIF(?, ''), title),
           overview = CASE WHEN overview = '' THEN ? ELSE overview END,
           poster_url = CASE WHEN poster_url = '' THEN ? ELSE poster_url END,
           backdrop_url = CASE WHEN backdrop_url = '' THEN ? ELSE backdrop_url END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      params.title,
      params.overview || '',
      params.posterUrl || '',
      params.backdropUrl || '',
      mediaId
    );
  } else {
    const res = db
      .prepare(
        `INSERT INTO media_items (
          tmdb_id, imdb_id, type, title, original_title, overview,
          poster_url, backdrop_url, release_year, rating, genres_json, runtime, status, source_origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`
      )
      .run(
        params.tmdbId,
        params.imdbId || null,
        params.type,
        params.title,
        params.originalTitle || null,
        params.overview || '',
        params.posterUrl || '',
        params.backdropUrl || params.posterUrl || '',
        params.releaseYear ?? null,
        params.rating ?? null,
        JSON.stringify(params.genres || []),
        params.runtime ?? null,
        params.sourceOrigin
      );
    mediaId = Number(res.lastInsertRowid);
  }

  // Deduplicate exact same stream URL for the same media/season/episode
  const dup = db
    .prepare(
      `SELECT id FROM media_sources
       WHERE media_id = ? AND COALESCE(season, -1) = COALESCE(?, -1)
         AND COALESCE(episode, -1) = COALESCE(?, -1) AND stream_url = ?`
    )
    .get(mediaId, params.season, params.episode, params.streamUrl) as { id: number } | undefined;

  if (!dup) {
    db.prepare(
      `INSERT INTO media_sources (
        media_id, season, episode, episode_title, stream_url, quality, format, language, is_working, origin_provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      mediaId,
      params.season,
      params.episode,
      params.episodeTitle,
      params.streamUrl,
      params.quality || '1080p',
      params.format || 'hls',
      params.language || 'PT-BR',
      params.originProvider
    );
    return { mediaId, sourceAdded: true };
  }

  return { mediaId, sourceAdded: false };
}

// =======================
// AUTH ROUTES
// =======================
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body as { name?: string; email?: string; password?: string };
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    res.status(400).json({ error: 'Nome, e-mail válido e senha (mínimo 6 caracteres) são obrigatórios.' });
    return;
  }

  const allowReg = getSetting('allow_public_registration') !== 'false';
  if (!allowReg) {
    res.status(403).json({ error: 'Cadastro público desativado pelo administrador.' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (exists) {
    res.status(409).json({ error: 'Já existe uma conta cadastrada com este e-mail.' });
    return;
  }

  const userRes = db
    .prepare('INSERT INTO users (name, email, password_hash, role, plan) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), normalizedEmail, hashPassword(password), 'developer', 'Developer');

  const userId = Number(userRes.lastInsertRowid);
  const defaultKey = generateApiKey();
  db.prepare(
    'INSERT INTO api_keys (user_id, label, api_key, allowed_domains, status) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, 'Chave Padrão Embed', defaultKey, '*', 'active');

  const token = createSession(userId);
  res.setHeader('Set-Cookie', `cv_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.status(201).json({
    token,
    user: {
      id: userId,
      name: name.trim(),
      email: normalizedEmail,
      role: 'developer',
      plan: 'Developer',
    },
    initialApiKey: defaultKey,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    return;
  }

  const user = db
    .prepare('SELECT id, name, email, password_hash, role, plan, created_at FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as
    | { id: number; name: string; email: string; password_hash: string; role: string; plan: string; created_at: string }
    | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Credenciais inválidas.' });
    return;
  }

  const token = createSession(user.id);
  res.setHeader('Set-Cookie', `cv_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      plan: user.plan,
      createdAt: user.created_at,
    },
  });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  const cookies = parseCookies(req.headers.cookie);
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : cookies.cv_session;
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.setHeader('Set-Cookie', 'cv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getAuthenticatedUser(req);
  res.json({ user });
});

// =======================
// API KEYS ROUTES
// =======================
app.get('/api/keys', (req, res) => {
  const user = getAuthenticatedUser(req);
  const rows = user
    ? db
        .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC')
        .all(user.id)
    : db
        .prepare('SELECT * FROM api_keys WHERE user_id = 1 ORDER BY id DESC')
        .all();

  res.json({
    isDemoFallback: !user,
    keys: (rows as Array<Record<string, unknown>>).map((k) => ({
      id: Number(k.id),
      userId: Number(k.user_id),
      label: String(k.label),
      apiKey: String(k.api_key),
      allowedDomains: String(k.allowed_domains),
      requestsCount: Number(k.requests_count),
      status: String(k.status),
      createdAt: String(k.created_at),
      lastUsedAt: k.last_used_at ? String(k.last_used_at) : null,
    })),
  });
});

app.post('/api/keys', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Faça login ou cadastre-se para criar novas chaves de API.' });
    return;
  }
  const { label, allowedDomains } = req.body as { label?: string; allowedDomains?: string };
  if (!label?.trim()) {
    res.status(400).json({ error: 'Informe um rótulo para identificar sua chave.' });
    return;
  }
  const newKey = generateApiKey();
  const resInsert = db
    .prepare('INSERT INTO api_keys (user_id, label, api_key, allowed_domains, status) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, label.trim(), newKey, allowedDomains?.trim() || '*', 'active');

  const created = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(resInsert.lastInsertRowid)) as Record<
    string,
    unknown
  >;
  res.status(201).json({
    key: {
      id: Number(created.id),
      userId: Number(created.user_id),
      label: String(created.label),
      apiKey: String(created.api_key),
      allowedDomains: String(created.allowed_domains),
      requestsCount: Number(created.requests_count),
      status: String(created.status),
      createdAt: String(created.created_at),
      lastUsedAt: null,
    },
  });
});

app.patch('/api/keys/:id', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Autenticação necessária.' });
    return;
  }
  const id = Number(req.params.id);
  const { status, allowedDomains } = req.body as { status?: string; allowedDomains?: string };
  const existing = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as
    | { id: number; user_id: number }
    | undefined;
  if (!existing || (existing.user_id !== user.id && user.role !== 'admin')) {
    res.status(404).json({ error: 'Chave não encontrada.' });
    return;
  }
  if (status === 'active' || status === 'revoked') {
    db.prepare('UPDATE api_keys SET status = ? WHERE id = ?').run(status, id);
  }
  if (typeof allowedDomains === 'string') {
    db.prepare('UPDATE api_keys SET allowed_domains = ? WHERE id = ?').run(allowedDomains.trim() || '*', id);
  }
  res.json({ ok: true });
});

app.delete('/api/keys/:id', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Autenticação necessária.' });
    return;
  }
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as
    | { id: number; user_id: number }
    | undefined;
  if (!existing || (existing.user_id !== user.id && user.role !== 'admin')) {
    res.status(404).json({ error: 'Chave não encontrada.' });
    return;
  }
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  res.json({ ok: true });
});

// =======================
// STATS & SETTINGS
// =======================
app.get('/api/stats', (_req, res) => {
  const totalMovies = (db.prepare("SELECT COUNT(*) as c FROM media_items WHERE type = 'movie'").get() as { c: number }).c;
  const totalSeries = (db.prepare("SELECT COUNT(*) as c FROM media_items WHERE type = 'tv'").get() as { c: number }).c;
  const totalSources = (db.prepare('SELECT COUNT(*) as c FROM media_sources').get() as { c: number }).c;
  const workingSources = (db.prepare('SELECT COUNT(*) as c FROM media_sources WHERE is_working = 1').get() as { c: number }).c;
  const totalEmbedRequests = (db.prepare('SELECT COALESCE(SUM(requests_count), 0) as c FROM api_keys').get() as { c: number }).c;
  const totalImportJobs = (db.prepare('SELECT COUNT(*) as c FROM import_jobs').get() as { c: number }).c;
  const activeApiKeys = (db.prepare("SELECT COUNT(*) as c FROM api_keys WHERE status = 'active'").get() as { c: number }).c;

  res.json({
    totalMovies,
    totalSeries,
    totalSources,
    workingSources,
    totalEmbedRequests,
    totalImportJobs,
    activeApiKeys,
  });
});

app.get('/api/settings', (_req, res) => {
  const tmdbKey = getSetting('tmdb_api_key');
  res.json({
    tmdbConfigured: Boolean(tmdbKey),
    tmdbKeyPreview: tmdbKey ? `${tmdbKey.slice(0, 4)}••••${tmdbKey.slice(-4)}` : '',
    defaultPlayerColor: getSetting('default_player_color') || '#2563EB',
    allowPublicRegistration: getSetting('allow_public_registration') !== 'false',
    requireApiKeyForEmbed: getSetting('require_api_key_for_embed') === 'true',
    embedWatermarkText: getSetting('embed_watermark_text') || 'CineVault Player',
  });
});

app.put('/api/settings', (req, res) => {
  const {
    tmdbApiKey,
    defaultPlayerColor,
    allowPublicRegistration,
    requireApiKeyForEmbed,
    embedWatermarkText,
  } = req.body as {
    tmdbApiKey?: string;
    defaultPlayerColor?: string;
    allowPublicRegistration?: boolean;
    requireApiKeyForEmbed?: boolean;
    embedWatermarkText?: string;
  };

  if (typeof tmdbApiKey === 'string') {
    setSetting('tmdb_api_key', tmdbApiKey.trim());
  }
  if (typeof defaultPlayerColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(defaultPlayerColor.trim())) {
    setSetting('default_player_color', defaultPlayerColor.trim());
  }
  if (typeof allowPublicRegistration === 'boolean') {
    setSetting('allow_public_registration', String(allowPublicRegistration));
  }
  if (typeof requireApiKeyForEmbed === 'boolean') {
    setSetting('require_api_key_for_embed', String(requireApiKeyForEmbed));
  }
  if (typeof embedWatermarkText === 'string' && embedWatermarkText.trim()) {
    setSetting('embed_watermark_text', embedWatermarkText.trim().slice(0, 40));
  }
  res.json({ ok: true });
});

// =======================
// TMDB INTEGRATION PROXY
// =======================
app.get('/api/tmdb/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || getSetting('tmdb_api_key');

  if (!apiKey) {
    res.json({
      configured: false,
      message: 'Configure sua chave TMDB v3 em Configurações para buscar diretamente na base oficial do TMDB.',
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
  const apiKey = String(req.headers['x-tmdb-key'] || '').trim() || getSetting('tmdb_api_key');

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

// =======================
// CATALOG & MEDIA CRUD
// =======================
app.get('/api/media', (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  const typeFilter = req.query.type === 'movie' || req.query.type === 'tv' ? req.query.type : null;
  const originFilter = String(req.query.origin || '').trim();

  let sql = `
    SELECT m.*, COUNT(s.id) as sources_count
    FROM media_items m
    LEFT JOIN media_sources s ON s.media_id = m.id
    WHERE 1=1
  `;
  const args: Array<string | number> = [];

  if (typeFilter) {
    sql += ' AND m.type = ?';
    args.push(typeFilter);
  }
  if (originFilter) {
    sql += ' AND m.source_origin = ?';
    args.push(originFilter);
  }
  if (search) {
    sql += ' AND (LOWER(m.title) LIKE ? OR CAST(m.tmdb_id AS TEXT) = ?)';
    args.push(`%${search}%`, search);
  }

  sql += ' GROUP BY m.id ORDER BY m.updated_at DESC, m.id DESC';
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  res.json({ items: rows.map((r) => mapMediaRow(r, false)) });
});

app.get('/api/media/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(
      `SELECT m.*, COUNT(s.id) as sources_count
       FROM media_items m
       LEFT JOIN media_sources s ON s.media_id = m.id
       WHERE m.id = ?
       GROUP BY m.id`
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!row) {
    res.status(404).json({ error: 'Mídia não encontrada.' });
    return;
  }
  res.json({ item: mapMediaRow(row, true) });
});

app.post('/api/media', async (req, res) => {
  const body = req.body as {
    tmdbId?: number;
    imdbId?: string;
    type?: 'movie' | 'tv';
    title?: string;
    overview?: string;
    posterUrl?: string;
    backdropUrl?: string;
    releaseYear?: number | null;
    rating?: number | null;
    genres?: string[];
    streamUrl?: string;
    season?: number | null;
    episode?: number | null;
    episodeTitle?: string | null;
    quality?: string;
    format?: string;
    language?: string;
    originProvider?: string;
    enrichFromTmdb?: boolean;
  };

  const type = body.type === 'tv' ? 'tv' : 'movie';
  let tmdbId = Number(body.tmdbId);
  let title = body.title?.trim() || '';
  let overview = body.overview?.trim() || '';
  let posterUrl = body.posterUrl?.trim() || '';
  let backdropUrl = body.backdropUrl?.trim() || '';
  let releaseYear = body.releaseYear ?? null;
  let rating = body.rating ?? null;
  let genres = Array.isArray(body.genres) ? body.genres : [];
  let imdbId = body.imdbId?.trim() || null;
  let runtime: number | null = null;

  if (!tmdbId || !Number.isFinite(tmdbId)) {
    if (!title) {
      res.status(400).json({ error: 'Informe um TMDB ID ou um Título.' });
      return;
    }
    tmdbId = generateDeterministicTmdbFallback(title, releaseYear);
  }

  const tmdbKey = getSetting('tmdb_api_key');
  if ((body.enrichFromTmdb !== false) && tmdbKey && tmdbId < 9000000) {
    const tmdb = await fetchTmdbDetails(type, tmdbId, tmdbKey);
    if (tmdb) {
      title = title || tmdb.title;
      overview = overview || tmdb.overview;
      posterUrl = posterUrl || tmdb.posterUrl;
      backdropUrl = backdropUrl || tmdb.backdropUrl;
      releaseYear = releaseYear ?? tmdb.releaseYear;
      rating = rating ?? tmdb.rating;
      genres = genres.length > 0 ? genres : tmdb.genres;
      imdbId = imdbId || tmdb.imdbId;
      runtime = tmdb.runtime;
    }
  }

  if (!title) {
    res.status(400).json({ error: 'Título obrigatório quando não encontrado automaticamente no TMDB.' });
    return;
  }

  const streamUrl = body.streamUrl?.trim();
  if (!streamUrl || !/^https?:\/\/.+/i.test(streamUrl)) {
    res.status(400).json({ error: 'Informe uma URL de stream HTTP/HTTPS válida (MP4, HLS .m3u8, etc.).' });
    return;
  }

  const result = upsertMediaAndSource({
    tmdbId,
    imdbId,
    type,
    title,
    overview,
    posterUrl,
    backdropUrl,
    releaseYear,
    rating,
    genres,
    runtime,
    sourceOrigin: tmdbKey ? 'tmdb_import' : 'manual',
    season: type === 'tv' ? Math.max(1, Number(body.season || 1)) : null,
    episode: type === 'tv' ? Math.max(1, Number(body.episode || 1)) : null,
    episodeTitle: type === 'tv' ? body.episodeTitle || `Episódio ${body.episode || 1}` : null,
    streamUrl,
    quality: body.quality || '1080p',
    format: body.format || (streamUrl.includes('.m3u8') ? 'hls' : 'mp4'),
    language: body.language || 'PT-BR',
    originProvider: body.originProvider || 'Cadastro Manual + TMDB',
  });

  const saved = db.prepare('SELECT * FROM media_items WHERE id = ?').get(result.mediaId) as Record<string, unknown>;
  res.status(201).json({ item: mapMediaRow(saved, true) });
});

app.delete('/api/media/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM media_items WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/media/:id/sources', (req, res) => {
  const mediaId = Number(req.params.id);
  const media = db.prepare('SELECT id, type FROM media_items WHERE id = ?').get(mediaId) as
    | { id: number; type: 'movie' | 'tv' }
    | undefined;
  if (!media) {
    res.status(404).json({ error: 'Mídia não encontrada.' });
    return;
  }
  const { streamUrl, quality, format, language, season, episode, episodeTitle, originProvider } = req.body as {
    streamUrl?: string;
    quality?: string;
    format?: string;
    language?: string;
    season?: number | null;
    episode?: number | null;
    episodeTitle?: string | null;
    originProvider?: string;
  };
  if (!streamUrl || !/^https?:\/\/.+/i.test(streamUrl.trim())) {
    res.status(400).json({ error: 'URL de stream inválida.' });
    return;
  }

  const ins = db
    .prepare(
      `INSERT INTO media_sources (
        media_id, season, episode, episode_title, stream_url, quality, format, language, is_working, origin_provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      mediaId,
      media.type === 'tv' ? Math.max(1, Number(season || 1)) : null,
      media.type === 'tv' ? Math.max(1, Number(episode || 1)) : null,
      media.type === 'tv' ? episodeTitle || `Episódio ${episode || 1}` : null,
      streamUrl.trim(),
      quality || '1080p',
      format || (streamUrl.includes('.m3u8') ? 'hls' : 'mp4'),
      language || 'PT-BR',
      originProvider || 'Manual'
    );

  db.prepare("UPDATE media_items SET updated_at = datetime('now') WHERE id = ?").run(mediaId);
  res.status(201).json({ sourceId: Number(ins.lastInsertRowid) });
});

app.delete('/api/sources/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM media_sources WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/sources/:id/check', async (req, res) => {
  const id = Number(req.params.id);
  const src = db.prepare('SELECT id, stream_url FROM media_sources WHERE id = ?').get(id) as
    | { id: number; stream_url: string }
    | undefined;
  if (!src) {
    res.status(404).json({ error: 'Fonte não encontrada.' });
    return;
  }
  let ok = false;
  let statusCode = 0;
  try {
    const head = await fetch(src.stream_url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    statusCode = head.status;
    ok = head.ok || head.status === 405;
    if (head.status === 405) {
      const getRes = await fetch(src.stream_url, {
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

  db.prepare("UPDATE media_sources SET is_working = ?, last_checked_at = datetime('now') WHERE id = ?").run(
    ok ? 1 : 0,
    id
  );
  res.json({ id, isWorking: ok, statusCode });
});

// =======================
// INGESTION ENGINE (M3U + EXTERNAL API)
// =======================
app.post('/api/ingest/m3u', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const { m3uUrl, m3uContent, sourceName, enrichWithTmdb } = req.body as {
    m3uUrl?: string;
    m3uContent?: string;
    sourceName?: string;
    enrichWithTmdb?: boolean;
  };

  let rawText = m3uContent || '';
  let sourceType: 'm3u_url' | 'm3u_text' = 'm3u_text';

  if (m3uUrl?.trim()) {
    sourceType = 'm3u_url';
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
    res.status(400).json({ error: 'Nenhuma URL de stream válida foi encontrada na lista M3U informada.' });
    return;
  }

  const tmdbKey = getSetting('tmdb_api_key');
  const shouldEnrich = Boolean(enrichWithTmdb && tmdbKey);
  const tmdbCache = new Map<string, Awaited<ReturnType<typeof fetchTmdbDetails>>>();
  const logs: string[] = [];

  let importedCount = 0;
  let skippedCount = 0;

  // Cap per-job TMDB lookups to keep bulk imports fast
  let tmdbLookups = 0;

  for (const entry of parsed.entries) {
    let tmdbMeta: Awaited<ReturnType<typeof fetchTmdbDetails>> = null;
    const cacheKey = `${entry.type}:${entry.tmdbId || entry.cleanTitle.toLowerCase()}:${entry.releaseYear || ''}`;

    if (shouldEnrich) {
      if (tmdbCache.has(cacheKey)) {
        tmdbMeta = tmdbCache.get(cacheKey) || null;
      } else if (tmdbLookups < 25) {
        tmdbLookups++;
        tmdbMeta = entry.tmdbId
          ? await fetchTmdbDetails(entry.type, entry.tmdbId, tmdbKey)
          : await searchTmdbFirstMatch(entry.cleanTitle, entry.type, entry.releaseYear, tmdbKey);
        tmdbCache.set(cacheKey, tmdbMeta);
      }
    }

    const finalTmdbId =
      tmdbMeta?.tmdbId || entry.tmdbId || generateDeterministicTmdbFallback(entry.cleanTitle, entry.releaseYear);

    const outcome = upsertMediaAndSource({
      tmdbId: finalTmdbId,
      imdbId: tmdbMeta?.imdbId || null,
      type: entry.type,
      title: tmdbMeta?.title || entry.cleanTitle,
      originalTitle: tmdbMeta?.originalTitle || null,
      overview: tmdbMeta?.overview || `Extraído automaticamente via lista M3U (${entry.groupTitle}).`,
      posterUrl: tmdbMeta?.posterUrl || entry.posterUrl || '',
      backdropUrl: tmdbMeta?.backdropUrl || entry.posterUrl || '',
      releaseYear: tmdbMeta?.releaseYear ?? entry.releaseYear,
      rating: tmdbMeta?.rating ?? null,
      genres: tmdbMeta?.genres || [entry.groupTitle],
      runtime: tmdbMeta?.runtime ?? null,
      sourceOrigin: 'm3u',
      season: entry.season,
      episode: entry.episode,
      episodeTitle: entry.episodeTitle,
      streamUrl: entry.streamUrl,
      quality: entry.quality,
      format: entry.format,
      language: entry.language,
      originProvider: sourceName?.trim() || 'Lista M3U Extraída',
    });

    if (outcome.sourceAdded) {
      importedCount++;
    } else {
      skippedCount++;
    }
  }

  logs.push(
    `Analisados ${parsed.entries.length} itens (${parsed.moviesCount} filmes, ${parsed.episodesCount} episódios em ${parsed.seriesCount} séries).`
  );
  logs.push(`Salvos no banco próprio: ${importedCount} novos streams, ${skippedCount} duplicados ignorados.`);
  if (shouldEnrich) {
    logs.push(`Enriquecimento TMDB executado para ${tmdbLookups} títulos distintos.`);
  }

  const jobRes = db
    .prepare(
      `INSERT INTO import_jobs (
        user_id, source_type, source_name, source_url, total_found, imported_count, skipped_count, failed_count, status, log_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`
    )
    .run(
      user?.id || null,
      sourceType,
      sourceName?.trim() || 'Importação M3U',
      m3uUrl?.trim() || null,
      parsed.entries.length,
      importedCount,
      skippedCount,
      parsed.invalidLines,
      JSON.stringify(logs)
    );

  res.status(201).json({
    jobId: Number(jobRes.lastInsertRowid),
    totalFound: parsed.entries.length,
    importedCount,
    skippedCount,
    failedCount: parsed.invalidLines,
    logs,
  });
});

app.post('/api/ingest/external-api', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const {
    apiUrl,
    jsonPayload,
    sourceName,
    mapping,
    defaultType,
    authHeaderName,
    authHeaderValue,
    enrichWithTmdb,
  } = req.body as {
    apiUrl?: string;
    jsonPayload?: string;
    sourceName?: string;
    mapping?: Partial<ExternalFieldMapping>;
    defaultType?: 'movie' | 'tv';
    authHeaderName?: string;
    authHeaderValue?: string;
    enrichWithTmdb?: boolean;
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

  const tmdbKey = getSetting('tmdb_api_key');
  const shouldEnrich = Boolean(enrichWithTmdb && tmdbKey);
  let tmdbLookups = 0;
  let importedCount = 0;
  let skippedCount = batch.skipped;

  for (const item of batch.items) {
    let tmdbMeta: Awaited<ReturnType<typeof fetchTmdbDetails>> = null;
    if (shouldEnrich && tmdbLookups < 25) {
      tmdbLookups++;
      tmdbMeta = item.tmdbId
        ? await fetchTmdbDetails(item.type, item.tmdbId, tmdbKey)
        : await searchTmdbFirstMatch(item.title, item.type, item.releaseYear, tmdbKey);
    }

    const finalTmdbId =
      tmdbMeta?.tmdbId || item.tmdbId || generateDeterministicTmdbFallback(item.title, item.releaseYear);

    const outcome = upsertMediaAndSource({
      tmdbId: finalTmdbId,
      imdbId: tmdbMeta?.imdbId || item.imdbId,
      type: item.type,
      title: tmdbMeta?.title || item.title,
      originalTitle: tmdbMeta?.originalTitle || null,
      overview: tmdbMeta?.overview || item.overview || 'Extraído de API externa para banco próprio.',
      posterUrl: tmdbMeta?.posterUrl || item.posterUrl || '',
      backdropUrl: tmdbMeta?.backdropUrl || item.backdropUrl || item.posterUrl || '',
      releaseYear: tmdbMeta?.releaseYear ?? item.releaseYear,
      rating: tmdbMeta?.rating ?? item.rating,
      genres: tmdbMeta?.genres || [],
      runtime: tmdbMeta?.runtime ?? null,
      sourceOrigin: 'external_api',
      season: item.season,
      episode: item.episode,
      episodeTitle: item.episodeTitle,
      streamUrl: item.streamUrl,
      quality: item.quality,
      format: item.format,
      language: item.language,
      originProvider: sourceName?.trim() || 'API Externa Extraída',
    });

    if (outcome.sourceAdded) {
      importedCount++;
    } else {
      skippedCount++;
    }
  }

  const logs = [
    `Extraídos ${batch.items.length} registros válidos da fonte externa.`,
    `${importedCount} streams gravados diretamente no banco próprio CineVault.`,
    ...(skippedCount > 0 ? [`${skippedCount} registros duplicados ou sem URL HTTP ignorados.`] : []),
  ];

  const jobRes = db
    .prepare(
      `INSERT INTO import_jobs (
        user_id, source_type, source_name, source_url, total_found, imported_count, skipped_count, failed_count, status, log_json
      ) VALUES (?, 'external_api', ?, ?, ?, ?, ?, ?, 'completed', ?)`
    )
    .run(
      user?.id || null,
      sourceName?.trim() || 'Extração API Externa',
      apiUrl?.trim() || null,
      batch.items.length + batch.skipped,
      importedCount,
      skippedCount,
      batch.errors.length,
      JSON.stringify(logs)
    );

  res.status(201).json({
    jobId: Number(jobRes.lastInsertRowid),
    totalFound: batch.items.length + batch.skipped,
    importedCount,
    skippedCount,
    logs,
  });
});

app.get('/api/import-jobs', (_req, res) => {
  const rows = db.prepare('SELECT * FROM import_jobs ORDER BY id DESC LIMIT 30').all() as Array<
    Record<string, unknown>
  >;
  res.json({
    jobs: rows.map((j) => {
      let logs: string[] = [];
      try {
        logs = JSON.parse(String(j.log_json || '[]'));
      } catch {
        logs = [];
      }
      return {
        id: Number(j.id),
        userId: j.user_id ? Number(j.user_id) : null,
        sourceType: String(j.source_type),
        sourceName: String(j.source_name),
        sourceUrl: j.source_url ? String(j.source_url) : null,
        totalFound: Number(j.total_found),
        importedCount: Number(j.imported_count),
        skippedCount: Number(j.skipped_count),
        failedCount: Number(j.failed_count),
        status: String(j.status),
        logs,
        createdAt: String(j.created_at),
      };
    }),
  });
});

// =======================
// PROPRIETARY PUBLIC API v1 (FOR EXTERNAL SITES/APPS)
// =======================
function validatePublicApiKey(req: express.Request): { valid: boolean; keyRow?: { id: number; allowed_domains: string } } {
  const providedKey = String(req.headers['x-api-key'] || req.query.api_key || req.query.key || '').trim();
  if (!providedKey) return { valid: false };
  const row = db
    .prepare("SELECT id, allowed_domains FROM api_keys WHERE api_key = ? AND status = 'active'")
    .get(providedKey) as { id: number; allowed_domains: string } | undefined;
  if (!row) return { valid: false };
  return { valid: true, keyRow: row };
}

app.get('/api/v1/catalog', (req, res) => {
  const auth = validatePublicApiKey(req);
  if (!auth.valid || !auth.keyRow) {
    res.status(401).json({
      error: 'API Key inválida ou ausente. Envie via header x-api-key ou query ?api_key=...',
    });
    return;
  }

  db.prepare("UPDATE api_keys SET requests_count = requests_count + 1, last_used_at = datetime('now') WHERE id = ?").run(
    auth.keyRow.id
  );

  const type = req.query.type === 'movie' || req.query.type === 'tv' ? req.query.type : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const page = Math.max(1, Number(req.query.page || 1));
  const offset = (page - 1) * limit;

  let where = "WHERE status = 'published'";
  const args: Array<string | number> = [];
  if (type) {
    where += ' AND type = ?';
    args.push(type);
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM media_items ${where}`).get(...args) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT m.*, COUNT(s.id) as sources_count
       FROM media_items m
       LEFT JOIN media_sources s ON s.media_id = m.id
       ${where}
       GROUP BY m.id
       ORDER BY m.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as Array<Record<string, unknown>>;

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    page,
    limit,
    total,
    results: rows.map((r) => {
      const item = mapMediaRow(r, false);
      return {
        ...item,
        embedUrl:
          item.type === 'tv'
            ? `${baseUrl}/embed/tv/${item.tmdbId}/1/1`
            : `${baseUrl}/embed/movie/${item.tmdbId}`,
      };
    }),
  });
});

app.get('/api/v1/media/:type/:tmdbId', (req, res) => {
  const auth = validatePublicApiKey(req);
  if (!auth.valid || !auth.keyRow) {
    res.status(401).json({
      error: 'API Key inválida ou ausente. Envie via header x-api-key ou query ?api_key=...',
    });
    return;
  }

  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const tmdbId = Number(req.params.tmdbId);
  const row = db
    .prepare('SELECT * FROM media_items WHERE tmdb_id = ? AND type = ?')
    .get(tmdbId, type) as Record<string, unknown> | undefined;

  if (!row) {
    res.status(404).json({ error: 'Título não encontrado no banco próprio.' });
    return;
  }

  db.prepare("UPDATE api_keys SET requests_count = requests_count + 1, last_used_at = datetime('now') WHERE id = ?").run(
    auth.keyRow.id
  );

  const item = mapMediaRow(row, true);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    ...item,
    embedUrl:
      item.type === 'tv'
        ? `${baseUrl}/embed/tv/${item.tmdbId}/1/1`
        : `${baseUrl}/embed/movie/${item.tmdbId}`,
  });
});

// =======================
// STANDALONE EMBED PLAYER ENDPOINTS
// =======================
function handleEmbedRequest(req: express.Request, res: express.Response, type: 'movie' | 'tv') {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  const tmdbId = Number(req.params.tmdbId);
  const season = type === 'tv' ? Math.max(1, Number(req.params.season || 1)) : null;
  const episode = type === 'tv' ? Math.max(1, Number(req.params.episode || 1)) : null;
  const apiKeyParam = String(req.query.key || req.query.api_key || '').trim();
  const colorParam = String(req.query.color || getSetting('default_player_color') || '#2563EB');

  const requireKey = getSetting('require_api_key_for_embed') === 'true';
  let keyRecord: { id: number; allowed_domains: string } | undefined;

  if (apiKeyParam) {
    keyRecord = db
      .prepare("SELECT id, allowed_domains FROM api_keys WHERE api_key = ? AND status = 'active'")
      .get(apiKeyParam) as { id: number; allowed_domains: string } | undefined;
  }

  if (requireKey && !keyRecord) {
    res
      .status(403)
      .send(renderEmbedErrorHtml('Chave API obrigatória', 'Informe uma chave ativa no parâmetro ?key=SUA_CHAVE para reproduzir este embed.', 403));
    return;
  }

  const referer = String(req.headers.referer || '');
  let refererHost = '';
  try {
    if (referer) refererHost = new URL(referer).hostname.toLowerCase();
  } catch {
    refererHost = '';
  }

  if (keyRecord && keyRecord.allowed_domains !== '*' && refererHost) {
    const allowed = keyRecord.allowed_domains
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    const currentHost = (req.get('host') || '').split(':')[0].toLowerCase();
    if (refererHost !== currentHost && !allowed.some((d) => refererHost === d || refererHost.endsWith(`.${d}`))) {
      res
        .status(403)
        .send(renderEmbedErrorHtml('Domínio não autorizado', `O domínio "${refererHost}" não está na lista de domínios permitidos desta chave.`, 403));
      return;
    }
  }

  const mediaRow = db
    .prepare('SELECT * FROM media_items WHERE tmdb_id = ? AND type = ?')
    .get(tmdbId, type) as Record<string, unknown> | undefined;

  if (!mediaRow) {
    res
      .status(404)
      .send(
        renderEmbedErrorHtml(
          'Conteúdo não encontrado',
          `O ${type === 'tv' ? 'seriado' : 'filme'} com TMDB ID ${tmdbId} ainda não foi extraído para o banco próprio.`,
          404
        )
      );
    return;
  }

  const mediaId = Number(mediaRow.id);
  const sources =
    type === 'tv'
      ? (db
          .prepare(
            'SELECT * FROM media_sources WHERE media_id = ? AND season = ? AND episode = ? ORDER BY is_working DESC, id ASC'
          )
          .all(mediaId, season, episode) as Array<Record<string, unknown>>)
      : (db
          .prepare('SELECT * FROM media_sources WHERE media_id = ? ORDER BY is_working DESC, id ASC')
          .all(mediaId) as Array<Record<string, unknown>>);

  const episodes =
    type === 'tv'
      ? (db
          .prepare(
            `SELECT season, episode, MAX(episode_title) as episode_title
             FROM media_sources
             WHERE media_id = ? AND season IS NOT NULL AND episode IS NOT NULL
             GROUP BY season, episode
             ORDER BY season ASC, episode ASC`
          )
          .all(mediaId) as Array<{ season: number; episode: number; episode_title: string | null }>)
      : [];

  if (keyRecord) {
    db.prepare("UPDATE api_keys SET requests_count = requests_count + 1, last_used_at = datetime('now') WHERE id = ?").run(
      keyRecord.id
    );
  }
  db.prepare(
    'INSERT INTO embed_logs (api_key_id, media_id, tmdb_id, type, season, episode, referer_domain) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(keyRecord?.id || null, mediaId, tmdbId, type, season, episode, refererHost || 'direct');

  const html = renderEmbedPlayerHtml(
    {
      id: mediaId,
      tmdbId,
      type,
      title: String(mediaRow.title),
      overview: String(mediaRow.overview || ''),
      posterUrl: String(mediaRow.poster_url || ''),
      backdropUrl: String(mediaRow.backdrop_url || ''),
      releaseYear: mediaRow.release_year ? Number(mediaRow.release_year) : null,
      season,
      episode,
      accentColor: colorParam,
      watermarkText: getSetting('embed_watermark_text') || 'CineVault Player',
      sources: sources.map((s) => ({
        id: Number(s.id),
        season: s.season !== null ? Number(s.season) : null,
        episode: s.episode !== null ? Number(s.episode) : null,
        episodeTitle: s.episode_title ? String(s.episode_title) : null,
        streamUrl: String(s.stream_url),
        quality: String(s.quality),
        format: String(s.format),
        language: String(s.language),
        originProvider: String(s.origin_provider),
      })),
      episodes: episodes.map((e) => ({
        season: Number(e.season),
        episode: Number(e.episode),
        episodeTitle: e.episode_title ? String(e.episode_title) : null,
      })),
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
    console.log(`CineVault API server listening on http://localhost:${PORT}`);
  });
}

startServer();

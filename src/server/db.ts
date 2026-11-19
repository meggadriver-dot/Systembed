import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'cinevault.db');
export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function generateApiKey(): string {
  return `cv_live_${crypto.randomBytes(16).toString('hex')}`;
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      plan TEXT NOT NULL DEFAULT 'Pro',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      allowed_domains TEXT NOT NULL DEFAULT '*',
      requests_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER NOT NULL,
      imdb_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('movie', 'tv')),
      title TEXT NOT NULL,
      original_title TEXT,
      overview TEXT NOT NULL DEFAULT '',
      poster_url TEXT NOT NULL DEFAULT '',
      backdrop_url TEXT NOT NULL DEFAULT '',
      release_year INTEGER,
      rating REAL,
      genres_json TEXT NOT NULL DEFAULT '[]',
      runtime INTEGER,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'draft')),
      source_origin TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tmdb_id, type)
    );

    CREATE TABLE IF NOT EXISTS media_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      season INTEGER,
      episode INTEGER,
      episode_title TEXT,
      stream_url TEXT NOT NULL,
      quality TEXT NOT NULL DEFAULT '1080p',
      format TEXT NOT NULL DEFAULT 'hls',
      language TEXT NOT NULL DEFAULT 'PT-BR',
      is_working INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      origin_provider TEXT NOT NULL DEFAULT 'Próprio',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT,
      total_found INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      log_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embed_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      media_id INTEGER,
      tmdb_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      season INTEGER,
      episode INTEGER,
      referer_domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const defaultSettings: Array<[string, string]> = [
    ['tmdb_api_key', process.env.TMDB_API_KEY || ''],
    ['default_player_color', '#2563EB'],
    ['allow_public_registration', 'true'],
    ['require_api_key_for_embed', 'false'],
    ['embed_watermark_text', 'CineVault Player'],
  ];

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  for (const [k, v] of defaultSettings) {
    insertSetting.run(k, v);
  }

  const userCountRow = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (userCountRow.count === 0) {
    const adminRes = db
      .prepare(
        'INSERT INTO users (name, email, password_hash, role, plan) VALUES (?, ?, ?, ?, ?)'
      )
      .run('Administrador CineVault', 'admin@cinevault.dev', hashPassword('admin123'), 'admin', 'Enterprise');

    const adminId = Number(adminRes.lastInsertRowid);
    db.prepare(
      'INSERT INTO api_keys (user_id, label, api_key, allowed_domains, requests_count, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(adminId, 'Chave Principal Portal', 'cv_live_demo_9f8a2c4e1b7d3a6f', '*', 142, 'active');
  }

  const mediaCountRow = db.prepare('SELECT COUNT(*) as count FROM media_items').get() as { count: number };
  if (mediaCountRow.count === 0) {
    seedInitialCatalog();
  } else {
    // Ensure seeded demo sources use reliable local /demo streams
    db.prepare(
      "UPDATE media_sources SET stream_url = '/demo/hls/master.m3u8' WHERE stream_url LIKE '%test-streams.mux.dev%'"
    ).run();
    db.prepare(
      "UPDATE media_sources SET stream_url = '/demo/stream.mp4' WHERE stream_url LIKE '%commondatastorage.googleapis.com%'"
    ).run();
  }
}

function seedInitialCatalog() {
  const insertMedia = db.prepare(`
    INSERT INTO media_items (
      tmdb_id, imdb_id, type, title, original_title, overview,
      poster_url, backdrop_url, release_year, rating, genres_json, runtime, status, source_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'seed')
  `);

  const insertSource = db.prepare(`
    INSERT INTO media_sources (
      media_id, season, episode, episode_title, stream_url, quality, format, language, is_working, origin_provider
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  const orbitalId = Number(
    insertMedia.run(
      157336,
      'tt0816692',
      'movie',
      'Horizonte Orbital',
      'Orbital Horizon',
      'Em um futuro onde a órbita terrestre entra em colapso, uma equipe de engenharia atravessa um corredor gravitacional próximo a Saturno para resgatar uma estação de transmissão perdida.',
      '/src/assets/images/poster_orbital_horizon_1795045402968.jpg',
      '/src/assets/images/poster_orbital_horizon_1795045402968.jpg',
      2025,
      8.7,
      JSON.stringify(['Ficção Científica', 'Drama', 'Aventura']),
      148
    ).lastInsertRowid
  );

  insertSource.run(
    orbitalId,
    null,
    null,
    null,
    '/demo/hls/master.m3u8',
    '1080p',
    'hls',
    'DUAL',
    'CDN Próprio HLS'
  );
  insertSource.run(
    orbitalId,
    null,
    null,
    null,
    '/demo/stream.mp4',
    '1080p',
    'mp4',
    'PT-BR',
    'Storage S3 MP4'
  );

  const precinctId = Number(
    insertMedia.run(
      1396,
      'tt0903747',
      'tv',
      'Distrito da Chuva',
      'Rain Precinct',
      'Um inspetor veterano investiga uma rede clandestina de transmissões piratas nas docas europeias, descobrindo que cada sinal esconde um desaparecimento não resolvido.',
      '/src/assets/images/poster_rain_precinct_1795045402586.jpg',
      '/src/assets/images/poster_rain_precinct_1795045402586.jpg',
      2024,
      9.1,
      JSON.stringify(['Crime', 'Mistério', 'Drama']),
      52
    ).lastInsertRowid
  );

  insertSource.run(
    precinctId,
    1,
    1,
    'Sinal Interrompido',
    '/demo/hls/master.m3u8',
    '1080p',
    'hls',
    'PT-BR',
    'M3U Extraído'
  );
  insertSource.run(
    precinctId,
    1,
    2,
    'Cais Sete',
    '/demo/stream.mp4',
    '1080p',
    'mp4',
    'LEG',
    'M3U Extraído'
  );
  insertSource.run(
    precinctId,
    1,
    3,
    'Frequência Oculta',
    '/demo/stream.mp4',
    '720p',
    'mp4',
    'PT-BR',
    'API Externa'
  );

  const abyssalId = Number(
    insertMedia.run(
      299536,
      'tt4154756',
      'movie',
      'Corrente Abissal',
      'Abyssal Current',
      'Expedição documental pelas florestas submersas de algas gigantes e fossas oceânicas do Pacífico Sul, registrando ecossistemas nunca filmados em 4K.',
      '/src/assets/images/poster_abyssal_current_1795045402804.jpg',
      '/src/assets/images/poster_abyssal_current_1795045402804.jpg',
      2025,
      8.4,
      JSON.stringify(['Documentário', 'Natureza']),
      104
    ).lastInsertRowid
  );

  insertSource.run(
    abyssalId,
    null,
    null,
    null,
    '/demo/stream.mp4',
    '4K',
    'mp4',
    'PT-BR',
    'Storage S3 MP4'
  );

  const monolithId = Number(
    insertMedia.run(
      94997,
      'tt11198330',
      'tv',
      'Monólito de Vidro',
      'Glass Monolith',
      'Pesquisadores isolados em um observatório brutalista na costa nórdica monitoram anomalias acústicas submarinas que alteram a percepção do tempo.',
      '/src/assets/images/poster_glass_monolith_1795045403215.jpg',
      '/src/assets/images/poster_glass_monolith_1795045403215.jpg',
      2026,
      8.9,
      JSON.stringify(['Suspense', 'Mistério', 'Ficção Científica']),
      48
    ).lastInsertRowid
  );

  insertSource.run(
    monolithId,
    1,
    1,
    'O Observatório',
    '/demo/hls/master.m3u8',
    '1080p',
    'hls',
    'DUAL',
    'CDN Próprio HLS'
  );
  insertSource.run(
    monolithId,
    1,
    2,
    'Maré Baixa',
    '/demo/stream.mp4',
    '1080p',
    'mp4',
    'PT-BR',
    'CDN Próprio HLS'
  );

  db.prepare(`
    INSERT INTO import_jobs (
      user_id, source_type, source_name, source_url, total_found, imported_count, skipped_count, failed_count, status, log_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    'm3u_url',
    'Catálogo Inicial Multi-Fontes',
    'https://internal-seed.local/playlist.m3u8',
    4,
    4,
    0,
    0,
    'completed',
    JSON.stringify([
      '4 títulos extraídos e indexados por TMDB ID no banco próprio.',
      '8 links de stream (HLS + MP4) validados e vinculados.',
    ])
  );
}

export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  );
}

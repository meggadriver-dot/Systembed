import type { MediaType, StreamFormat } from '../types/media';

export const DEFAULT_MOVIE_EMBED_TEMPLATE = 'https://embedmaster.link/movie/{id}';
export const DEFAULT_TV_EMBED_TEMPLATE = 'https://embedmaster.link/tv/{id}/{season}/{episode}';

export interface EmbedCrawlTarget {
  type: MediaType;
  tmdbId: number;
  season: number;
  episode: number;
  episodeTitle?: string;
  url: string;
}

export interface ExtractedStreamCandidate {
  url: string;
  format: StreamFormat;
  quality: string;
  language: string;
}

export interface ExtractedDocumentArtifacts {
  streams: ExtractedStreamCandidate[];
  iframeHops: string[];
  jsonCandidates: string[];
}

export function expandEmbedTemplate(
  template: string,
  params: { type: MediaType; tmdbId: number; season?: number; episode?: number }
): string {
  const season = params.type === 'tv' ? Math.max(1, Math.trunc(params.season || 1)) : 0;
  const episode = params.type === 'tv' ? Math.max(1, Math.trunc(params.episode || 1)) : 0;
  return template
    .trim()
    .replace(/\{type\}/gi, params.type)
    .replace(/\{tmdb_?id\}|\{id\}/gi, String(Math.trunc(params.tmdbId)))
    .replace(/\{season\}|\{s\}/gi, String(season))
    .replace(/\{episode\}|\{e\}/gi, String(episode));
}

function expandRangeToken(token: string, maxItems = 50): number[] {
  const clean = token.trim().replace(/^[se]/i, '');
  const rangeMatch = clean.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const start = Number.parseInt(rangeMatch[1], 10);
    const end = Number.parseInt(rangeMatch[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return [];
    const list: number[] = [];
    for (let i = start; i <= end && list.length < maxItems; i++) {
      list.push(i);
    }
    return list;
  }
  const single = Number.parseInt(clean, 10);
  if (Number.isFinite(single) && single >= 1) return [single];
  return [];
}

/**
 * Parses multiline embed URLs, template range specs, or batch TMDB IDs into structured crawl targets.
 * Supported syntaxes per line:
 * - https://embedmaster.link/movie/550
 * - https://embedmaster.link/tv/1399/1/2
 * - https://embedmaster.link/tv/1399/1/1-5
 * - http://localhost:3000/demo/mock-embed/tv/1399/1/1-3
 * - tv:1399:S01:E01-E05  (or tv:1399:1:1-5)
 * - movie:550, 603, 27205 (or 550, 603)
 */
export function parseEmbedTargetsInput(
  rawInput: string,
  movieTemplate = DEFAULT_MOVIE_EMBED_TEMPLATE,
  tvTemplate = DEFAULT_TV_EMBED_TEMPLATE
): EmbedCrawlTarget[] {
  const targets: EmbedCrawlTarget[] = [];
  const seen = new Set<string>();

  const pushTarget = (t: EmbedCrawlTarget) => {
    const key = `${t.type}:${t.tmdbId}:${t.season}:${t.episode}:${t.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(t);
    }
  };

  const lines = rawInput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));

  for (const line of lines) {
    // 1. Full or relative URL
    if (/^(https?:\/\/|\/)/i.test(line)) {
      // Check TV URL with optional episode range at end: .../tv/1399/1/1-5 or .../tv/1399/1/2
      const tvRangeMatch = line.match(/^(.*\/tv\/(\d+)\/(\d+)\/(\d+(?:\s*-\s*\d+)?))(\?.*)?$/i);
      if (tvRangeMatch) {
        const prefixBeforeEp = tvRangeMatch[1].replace(/\/\d+(?:\s*-\s*\d+)?$/, '');
        const tmdbId = Number.parseInt(tvRangeMatch[2], 10);
        const season = Number.parseInt(tvRangeMatch[3], 10);
        const episodes = expandRangeToken(tvRangeMatch[4]);
        const querySuffix = tvRangeMatch[5] || '';
        for (const ep of episodes) {
          pushTarget({
            type: 'tv',
            tmdbId,
            season,
            episode: ep,
            url: `${prefixBeforeEp}/${ep}${querySuffix}`,
          });
        }
        continue;
      }

      // Check Movie URL: .../movie/550
      const movieMatch = line.match(/\/movie\/(\d+)/i);
      if (movieMatch) {
        const tmdbId = Number.parseInt(movieMatch[1], 10);
        pushTarget({
          type: 'movie',
          tmdbId,
          season: 0,
          episode: 0,
          url: line,
        });
        continue;
      }

      // Check query-param style URL (?tmdb=1399&s=1&e=2 or ?id=550)
      try {
        const parsedUrl = new URL(line, 'http://localhost');
        const idParam = parsedUrl.searchParams.get('tmdb') || parsedUrl.searchParams.get('id');
        const sParam = parsedUrl.searchParams.get('season') || parsedUrl.searchParams.get('s');
        const eParam = parsedUrl.searchParams.get('episode') || parsedUrl.searchParams.get('e');
        const tmdbId = idParam ? Number.parseInt(idParam, 10) : 0;
        if (tmdbId > 0) {
          if (sParam || eParam || /\/tv\b|serie/i.test(line)) {
            const season = Math.max(1, Number.parseInt(sParam || '1', 10) || 1);
            const episode = Math.max(1, Number.parseInt(eParam || '1', 10) || 1);
            pushTarget({ type: 'tv', tmdbId, season, episode, url: line });
          } else {
            pushTarget({ type: 'movie', tmdbId, season: 0, episode: 0, url: line });
          }
          continue;
        }
      } catch {
        // Fallback below
      }

      // Fallback URL with deterministic ID hash if numeric ID wasn't in path
      const anyNum = line.match(/(\d{2,9})/);
      const fallbackId = anyNum ? Number.parseInt(anyNum[1], 10) : 900001;
      pushTarget({ type: 'movie', tmdbId: fallbackId, season: 0, episode: 0, url: line });
      continue;
    }

    // 2. Shorthand TV syntax: tv:1399:S01:E01-E05 or tv:1399:1:1-5 or 1399 S01E01-E05
    const tvSpec =
      line.match(/^tv[:\s]+(\d+)[:\s]+s?(\d+)[:\s]+e?(\d+(?:\s*-\s*e?\d+)?)$/i) ||
      line.match(/^(\d+)\s+s(\d{1,2})\s*e(\d{1,3}(?:\s*-\s*e?\d{1,3})?)$/i);
    if (tvSpec) {
      const tmdbId = Number.parseInt(tvSpec[1], 10);
      const season = Number.parseInt(tvSpec[2], 10);
      const episodes = expandRangeToken(tvSpec[3].replace(/e/gi, ''));
      for (const ep of episodes) {
        pushTarget({
          type: 'tv',
          tmdbId,
          season,
          episode: ep,
          url: expandEmbedTemplate(tvTemplate, { type: 'tv', tmdbId, season, episode: ep }),
        });
      }
      continue;
    }

    // 3. Movie ID(s): "movie:550,603" or "550, 603, 27205"
    const cleanedMovieLine = line.replace(/^movie[:\s]+/i, '');
    const idTokens = cleanedMovieLine.split(/[,\s;]+/).filter(Boolean);
    for (const tok of idTokens) {
      if (/^\d{1,9}$/.test(tok)) {
        const tmdbId = Number.parseInt(tok, 10);
        pushTarget({
          type: 'movie',
          tmdbId,
          season: 0,
          episode: 0,
          url: expandEmbedTemplate(movieTemplate, { type: 'movie', tmdbId }),
        });
      }
    }
  }

  return targets;
}

const IGNORED_URL_PATTERNS = [
  /googlesyndication|doubleclick|googletagmanager|google-analytics|facebook\.net/i,
  /histats|yandex\.ru\/metrika|popads|propellerads|adsterra|exoclick|juicyads/i,
  /cloudflare\.com\/cdn-cgi|challenges\.cloudflare\.com|hcaptcha\.com|recaptcha/i,
  /\.(css|js|png|jpg|jpeg|webp|svg|woff2?|ico|gif)(\?|$)/i,
];

function isNoiseUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (!lower || lower === 'about:blank' || lower.startsWith('javascript:') || lower.startsWith('data:')) {
    return true;
  }
  return IGNORED_URL_PATTERNS.some((rx) => rx.test(lower));
}

function resolveCandidateUrl(raw: string, baseUrl: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  if (!cleaned || isNoiseUrl(cleaned)) return null;

  try {
    const resolved = new URL(cleaned, baseUrl).toString();
    if (!/^https?:\/\//i.test(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function detectFormatFromUrl(url: string, hint = ''): StreamFormat | null {
  const combined = `${url} ${hint}`.toLowerCase();
  if (/\.m3u8(\?|$|#|&)/i.test(url) || /application\/vnd\.apple\.mpegurl|application\/x-mpegurl|hls/i.test(combined)) {
    return 'hls';
  }
  if (/\.mp4(\?|$|#|&)/i.test(url) || /video\/mp4/i.test(combined)) {
    return 'mp4';
  }
  if (/\.mpd(\?|$|#|&)/i.test(url) || /application\/dash\+xml/i.test(combined)) {
    return 'dash';
  }
  if (/\.ts(\?|$|#|&)/i.test(url)) {
    return 'ts';
  }
  return null;
}

function inferQuality(textAround: string): string {
  const upper = textAround.toUpperCase();
  if (upper.includes('2160') || upper.includes('4K') || upper.includes('UHD')) return '4K';
  if (upper.includes('1080')) return '1080p';
  if (upper.includes('720')) return '720p';
  if (upper.includes('480')) return '480p';
  if (upper.includes('360')) return '360p';
  return '1080p';
}

function inferLanguage(textAround: string): string {
  const upper = textAround.toUpperCase();
  if (upper.includes('DUAL')) return 'DUAL';
  if (upper.includes('DUBLAD') || upper.includes('PT-BR') || upper.includes('PTBR')) return 'PT-BR';
  if (upper.includes('LEGEND') || upper.includes('LEG') || upper.includes('SUB')) return 'LEG';
  return 'PT-BR';
}

function tryDecodeBase64Chunks(text: string): string[] {
  const decoded: string[] = [];
  // Look for atob("...") or long base64 strings
  const atobRegex = /atob\(\s*['"]([A-Za-z0-9+/=]{16,})['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = atobRegex.exec(text)) !== null) {
    try {
      const value = Buffer.from(match[1], 'base64').toString('utf8');
      if (value && /https?:|\/|\.m3u8|\.mp4/i.test(value)) {
        decoded.push(value);
      }
    } catch {
      // Ignore malformed base64
    }
  }

  // Standalone quoted base64 strings starting with common prefixes ("aHR0c" = "http", "L2RlbW" = "/dem", "Ly8" = "//")
  const standaloneRegex = /['"]((?:aHR0c|L2RlbW|Ly9)[A-Za-z0-9+/=]{12,})['"]/g;
  while ((match = standaloneRegex.exec(text)) !== null) {
    try {
      const value = Buffer.from(match[1], 'base64').toString('utf8');
      if (value && /\.m3u8|\.mp4|\.mpd|https?:\/\//i.test(value)) {
        decoded.push(value);
      }
    } catch {
      // Ignore
    }
  }

  return decoded;
}

/**
 * Deeply inspects raw HTML, inline JS, JSON payloads, and decoded base64 blocks from an embed page
 * to extract direct playable streams (.m3u8, .mp4, .mpd, .ts) as well as nested iframe/API hops.
 */
export function extractMediaStreamsFromDocument(
  rawContent: string,
  baseUrl: string
): ExtractedDocumentArtifacts {
  const decodedChunks = tryDecodeBase64Chunks(rawContent);
  const combinedSource = [rawContent, ...decodedChunks].join('\n');
  const unescaped = combinedSource
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  const streamMap = new Map<string, ExtractedStreamCandidate>();
  const iframeSet = new Set<string>();
  const jsonSet = new Set<string>();

  const registerStream = (rawUrl: string, context = '') => {
    const resolved = resolveCandidateUrl(rawUrl, baseUrl);
    if (!resolved) return;
    const format = detectFormatFromUrl(resolved, context);
    if (!format) return;
    // Skip tiny HLS segment .ts chunks when we already have a master .m3u8 playlist, unless no playlist exists
    if (!streamMap.has(resolved)) {
      streamMap.set(resolved, {
        url: resolved,
        format,
        quality: inferQuality(`${resolved} ${context}`),
        language: inferLanguage(`${resolved} ${context}`),
      });
    }
  };

  // 1. Direct media URLs anywhere in HTML/JS/JSON (absolute or quoted relative /path/...m3u8|mp4)
  const absoluteMediaRx = /https?:\/\/[^\s"'`<>()\\]+\.(?:m3u8|mp4|mpd)(?:\?[^\s"'`<>()\\]*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = absoluteMediaRx.exec(unescaped)) !== null) {
    const start = Math.max(0, m.index - 80);
    const end = Math.min(unescaped.length, m.index + m[0].length + 80);
    registerStream(m[0], unescaped.slice(start, end));
  }

  const quotedMediaRx = /['"`]((?:https?:)?\/\/[^\s"'`<>]+|\/[^\s"'`<>]+\.(?:m3u8|mp4|mpd)(?:\?[^\s"'`<>]*)?)['"`]/gi;
  while ((m = quotedMediaRx.exec(unescaped)) !== null) {
    const start = Math.max(0, m.index - 80);
    const end = Math.min(unescaped.length, m.index + m[0].length + 80);
    registerStream(m[1], unescaped.slice(start, end));
  }

  // 2. Player config keys: file: "...", src: "...", streamUrl: "...", url: "..."
  const configPropRx = /(?:file|src|source|stream_?url|hls|mp4|video_?url|playlist)\s*[:=]\s*['"`]([^'"`\s]+)['"`]/gi;
  while ((m = configPropRx.exec(unescaped)) !== null) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(unescaped.length, m.index + m[0].length + 80);
    const ctx = unescaped.slice(start, end);
    registerStream(m[1], ctx);
  }

  // 3. HTML <source src="..."> and <video src="...">
  const htmlTagSrcRx = /<(?:source|video)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((m = htmlTagSrcRx.exec(unescaped)) !== null) {
    registerStream(m[1], m[0]);
  }

  // 4. Nested <iframe src="..."> / data-src / redirect scripts
  const iframeRx = /<iframe\b[^>]*\b(?:src|data-src)=["']([^"']+)["'][^>]*>/gi;
  while ((m = iframeRx.exec(unescaped)) !== null) {
    const resolved = resolveCandidateUrl(m[1], baseUrl);
    if (resolved && resolved !== baseUrl && !detectFormatFromUrl(resolved)) {
      iframeSet.add(resolved);
    }
  }

  // 5. JS redirect or API fetch endpoints embedded in player scripts
  const jsRedirectRx = /(?:window\.location(?:\.href)?|location\.replace)\s*(?:=|\()\s*['"]([^'"]+)['"]/gi;
  while ((m = jsRedirectRx.exec(unescaped)) !== null) {
    const resolved = resolveCandidateUrl(m[1], baseUrl);
    if (resolved && resolved !== baseUrl) {
      iframeSet.add(resolved);
    }
  }

  const apiCandidateRx = /['"`]((?:https?:\/\/|\/)[^'"`\s]*(?:api\/source|\/ajax\/|sources\.json|get_?source|player_?api)[^'"`\s]*)['"`]/gi;
  while ((m = apiCandidateRx.exec(unescaped)) !== null) {
    const resolved = resolveCandidateUrl(m[1], baseUrl);
    if (resolved && resolved !== baseUrl) {
      jsonSet.add(resolved);
    }
  }

  // Prefer .m3u8/.mp4/.mpd over raw .ts segments when playlists are present
  const allStreams = Array.from(streamMap.values());
  const nonTs = allStreams.filter((s) => s.format !== 'ts');
  const finalStreams = nonTs.length > 0 ? nonTs : allStreams;

  // Sort HLS first, then MP4, then DASH
  const formatWeight: Record<StreamFormat, number> = { hls: 0, mp4: 1, dash: 2, ts: 3, embed: 4 };
  finalStreams.sort((a, b) => formatWeight[a.format] - formatWeight[b.format]);

  return {
    streams: finalStreams,
    iframeHops: Array.from(iframeSet).slice(0, 6),
    jsonCandidates: Array.from(jsonSet).slice(0, 4),
  };
}

export interface CatalogSyncSeedItem {
  tmdbId: number;
  imdbId?: string;
  type: MediaType;
  title: string;
  originalTitle?: string;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  releaseYear?: number | null;
  rating?: number | null;
  genres?: string[];
  runtime?: number | null;
  episodes?: Array<{ season: number; episode: number; episodeTitle: string }>;
}

export interface PrimarySourceEntry {
  tmdbId: number;
  imdbId: string;
  type: MediaType;
  title: string;
  originalTitle: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number | null;
  rating: number | null;
  genres: string[];
  runtime: number | null;
  sourceOrigin: 'tmdb_import' | 'external_api';
  season: number;
  episode: number;
  episodeTitle: string;
  streamUrl: string;
  quality: string;
  format: StreamFormat;
  language: string;
  originProvider: string;
}

/**
 * Expands a list of discovered movies & TV shows (with episodes) into normalized catalog entries
 * wired to the primary embed template or extracted direct streams.
 */
export function buildPrimarySourceEntries(
  items: CatalogSyncSeedItem[],
  options: {
    movieTemplate: string;
    tvTemplate: string;
    sourceName: string;
    extractedStreamsByTarget?: Map<string, ExtractedStreamCandidate[]>;
    allowEmbedFallback?: boolean;
  }
): PrimarySourceEntry[] {
  const results: PrimarySourceEntry[] = [];
  const allowFallback = options.allowEmbedFallback !== false;

  for (const item of items) {
    if (!item.tmdbId || item.tmdbId < 1) continue;

    if (item.type === 'movie') {
      const targetUrl = expandEmbedTemplate(options.movieTemplate, {
        type: 'movie',
        tmdbId: item.tmdbId,
      });
      const targetKey = `movie:${item.tmdbId}:0:0`;
      const directStreams = options.extractedStreamsByTarget?.get(targetKey) || [];

      if (directStreams.length > 0) {
        for (const st of directStreams) {
          results.push({
            tmdbId: item.tmdbId,
            imdbId: item.imdbId || '',
            type: 'movie',
            title: item.title || `TMDB #${item.tmdbId}`,
            originalTitle: item.originalTitle || '',
            overview: item.overview || '',
            posterUrl: item.posterUrl || '',
            backdropUrl: item.backdropUrl || item.posterUrl || '',
            releaseYear: item.releaseYear ?? null,
            rating: item.rating ?? null,
            genres: item.genres || [],
            runtime: item.runtime ?? null,
            sourceOrigin: 'tmdb_import',
            season: 0,
            episode: 0,
            episodeTitle: '',
            streamUrl: st.url,
            quality: st.quality,
            format: st.format,
            language: st.language,
            originProvider: options.sourceName,
          });
        }
      } else if (allowFallback) {
        results.push({
          tmdbId: item.tmdbId,
          imdbId: item.imdbId || '',
          type: 'movie',
          title: item.title || `TMDB #${item.tmdbId}`,
          originalTitle: item.originalTitle || '',
          overview: item.overview || '',
          posterUrl: item.posterUrl || '',
          backdropUrl: item.backdropUrl || item.posterUrl || '',
          releaseYear: item.releaseYear ?? null,
          rating: item.rating ?? null,
          genres: item.genres || [],
          runtime: item.runtime ?? null,
          sourceOrigin: 'tmdb_import',
          season: 0,
          episode: 0,
          episodeTitle: '',
          streamUrl: targetUrl,
          quality: '1080p',
          format: 'embed',
          language: 'PT-BR',
          originProvider: options.sourceName,
        });
      }
    } else {
      const episodesList =
        item.episodes && item.episodes.length > 0
          ? item.episodes
          : [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];

      for (const ep of episodesList) {
        const sNum = Math.max(1, Math.trunc(ep.season || 1));
        const eNum = Math.max(1, Math.trunc(ep.episode || 1));
        const targetUrl = expandEmbedTemplate(options.tvTemplate, {
          type: 'tv',
          tmdbId: item.tmdbId,
          season: sNum,
          episode: eNum,
        });
        const targetKey = `tv:${item.tmdbId}:${sNum}:${eNum}`;
        const directStreams = options.extractedStreamsByTarget?.get(targetKey) || [];

        if (directStreams.length > 0) {
          for (const st of directStreams) {
            results.push({
              tmdbId: item.tmdbId,
              imdbId: item.imdbId || '',
              type: 'tv',
              title: item.title || `TMDB #${item.tmdbId}`,
              originalTitle: item.originalTitle || '',
              overview: item.overview || '',
              posterUrl: item.posterUrl || '',
              backdropUrl: item.backdropUrl || item.posterUrl || '',
              releaseYear: item.releaseYear ?? null,
              rating: item.rating ?? null,
              genres: item.genres || [],
              runtime: item.runtime ?? null,
              sourceOrigin: 'tmdb_import',
              season: sNum,
              episode: eNum,
              episodeTitle: ep.episodeTitle || `Episódio ${eNum}`,
              streamUrl: st.url,
              quality: st.quality,
              format: st.format,
              language: st.language,
              originProvider: options.sourceName,
            });
          }
        } else if (allowFallback) {
          results.push({
            tmdbId: item.tmdbId,
            imdbId: item.imdbId || '',
            type: 'tv',
            title: item.title || `TMDB #${item.tmdbId}`,
            originalTitle: item.originalTitle || '',
            overview: item.overview || '',
            posterUrl: item.posterUrl || '',
            backdropUrl: item.backdropUrl || item.posterUrl || '',
            releaseYear: item.releaseYear ?? null,
            rating: item.rating ?? null,
            genres: item.genres || [],
            runtime: item.runtime ?? null,
            sourceOrigin: 'tmdb_import',
            season: sNum,
            episode: eNum,
            episodeTitle: ep.episodeTitle || `Episódio ${eNum}`,
            streamUrl: targetUrl,
            quality: '1080p',
            format: 'embed',
            language: 'PT-BR',
            originProvider: options.sourceName,
          });
        }
      }
    }
  }

  return results;
}


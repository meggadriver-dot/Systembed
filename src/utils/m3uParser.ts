import type { MediaType, StreamFormat } from '../types/media.ts';

export interface ParsedM3uEntry {
  rawTitle: string;
  cleanTitle: string;
  type: MediaType;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  releaseYear: number | null;
  tmdbId: number | null;
  posterUrl: string;
  groupTitle: string;
  quality: string;
  language: string;
  format: StreamFormat;
  streamUrl: string;
}

export interface ParsedM3uResult {
  entries: ParsedM3uEntry[];
  moviesCount: number;
  seriesCount: number;
  episodesCount: number;
  invalidLines: number;
}

const SERIES_PATTERNS = [
  /(?:^|[\s._-])S(\d{1,2})[\s._-]*E(\d{1,3})(?:$|[\s._-])/i,
  /(?:^|[\s._-])T(\d{1,2})[\s._-]*E(\d{1,3})(?:$|[\s._-])/i,
  /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:$|[\s._-])/i,
  /Temporada\s*(\d{1,2})\s*(?:Ep(?:is[oó]dio)?\.?\s*)?(\d{1,3})/i,
];

function extractAttr(extinfLine: string, attrName: string): string {
  const regex = new RegExp(`${attrName}=["']([^"']*)["']`, 'i');
  const match = extinfLine.match(regex);
  return match ? match[1].trim() : '';
}

export function detectStreamFormat(url: string): StreamFormat {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v') || lower.endsWith('.mkv') || lower.endsWith('.webm')) {
    return 'mp4';
  }
  if (lower.endsWith('.ts')) return 'ts';
  if (lower.endsWith('.mpd')) return 'dash';
  if (lower.includes('m3u8')) return 'hls';
  return 'mp4';
}

export function detectQuality(raw: string): string {
  if (/\b(4K|2160p|UHD)\b/i.test(raw)) return '4K';
  if (/\b(1080p|FHD|FULL\s*HD)\b/i.test(raw)) return '1080p';
  if (/\b(720p|HD)\b/i.test(raw)) return '720p';
  if (/\b(480p|SD)\b/i.test(raw)) return '480p';
  return '1080p';
}

export function detectLanguage(raw: string, groupTitle: string): string {
  const combined = `${raw} ${groupTitle}`;
  if (/\b(DUAL|MULTI)\b/i.test(combined)) return 'DUAL';
  if (/\b(LEG|LEGENDADO|SUB)\b/i.test(combined)) return 'LEG';
  if (/\b(DUB|DUBLADO|PT-BR|PTBR|NACIONAL)\b/i.test(combined)) return 'PT-BR';
  if (/\b(EN|ENG|INGLES)\b/i.test(combined)) return 'EN';
  if (/\b(ES|ESP|LAT)\b/i.test(combined)) return 'ES';
  return 'PT-BR';
}

export function parseM3uPlaylist(content: string): ParsedM3uResult {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const entries: ParsedM3uEntry[] = [];
  let invalidLines = 0;

  let currentExtinf: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXTM3U')) {
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      currentExtinf = line;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const isUrl = /^https?:\/\/.+/i.test(line);
    if (!isUrl) {
      invalidLines++;
      currentExtinf = null;
      continue;
    }

    const extinf = currentExtinf ?? '';
    currentExtinf = null;

    const commaIndex = extinf.lastIndexOf(',');
    const commaTitle = commaIndex >= 0 ? extinf.slice(commaIndex + 1).trim() : '';
    const tvgName = extractAttr(extinf, 'tvg-name');
    const rawTitle = commaTitle || tvgName || `Conteúdo ${entries.length + 1}`;
    const posterUrl = extractAttr(extinf, 'tvg-logo');
    const groupTitle = extractAttr(extinf, 'group-title') || 'Geral';

    const tmdbAttr = extractAttr(extinf, 'tmdb-id') || extractAttr(extinf, 'tvg-tmdb');
    const tmdbFromTitle = rawTitle.match(/\[tmdb[:=](\d+)\]/i)?.[1];
    const parsedTmdb = Number.parseInt(tmdbAttr || tmdbFromTitle || '', 10);
    const tmdbId = Number.isFinite(parsedTmdb) && parsedTmdb > 0 ? parsedTmdb : null;

    let season: number | null = null;
    let episode: number | null = null;
    let type: MediaType = 'movie';
    let workingTitle = rawTitle
      .replace(/\[tmdb[:=]\d+\]/gi, '')
      .replace(/\[[^\]]*(4K|2160p|1080p|720p|480p|FHD|UHD|HD|SD|DUB|LEG|DUAL|PT-BR|PTBR|NACIONAL|EN|ES)[^\]]*\]/gi, '')
      .trim();

    for (const pattern of SERIES_PATTERNS) {
      const match = workingTitle.match(pattern);
      if (match) {
        type = 'tv';
        season = Number.parseInt(match[1], 10);
        episode = Number.parseInt(match[2], 10);
        workingTitle = workingTitle
          .slice(0, match.index)
          .replace(/[-–|:.\s]+$/, '')
          .trim();
        break;
      }
    }

    if (type === 'movie' && /\b(s[eé]ries?|tv shows?|animes?|novelas?)\b/i.test(groupTitle)) {
      // Only treat as TV if we also found season/episode or group explicitly says series
      // Default to season 1 episode 1 if group explicitly indicates series without episode marker
      if (!season && !episode) {
        type = 'tv';
        season = 1;
        episode = 1;
      }
    }

    const yearMatch = workingTitle.match(/[\[(](\d{4})[\])]/);
    const releaseYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;
    const cleanTitle = workingTitle
      .replace(/[\[(]\d{4}[\])]/g, '')
      .replace(/\b(4K|2160p|1080p|720p|480p|FHD|UHD|HD|SD|DUBLADO|LEGENDADO|DUB|LEG|DUAL)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[-–|:\s]+$/, '')
      .trim() || rawTitle;

    const explicitTitleQuality = /\b(4K|2160p|UHD|1080p|FHD|FULL\s*HD|720p|HD|480p|SD)\b/i.test(rawTitle);
    const quality = detectQuality(explicitTitleQuality ? rawTitle : extinf);
    const language = detectLanguage(rawTitle, groupTitle);
    const format = detectStreamFormat(line);

    entries.push({
      rawTitle,
      cleanTitle,
      type,
      season,
      episode,
      episodeTitle: type === 'tv' && season && episode ? `Episódio ${episode}` : null,
      releaseYear,
      tmdbId,
      posterUrl,
      groupTitle,
      quality,
      language,
      format,
      streamUrl: line,
    });
  }

  const uniqueSeries = new Set<string>();
  let moviesCount = 0;
  let episodesCount = 0;

  for (const entry of entries) {
    if (entry.type === 'movie') {
      moviesCount++;
    } else {
      episodesCount++;
      uniqueSeries.add(entry.cleanTitle.toLowerCase());
    }
  }

  return {
    entries,
    moviesCount,
    seriesCount: uniqueSeries.size,
    episodesCount,
    invalidLines,
  };
}

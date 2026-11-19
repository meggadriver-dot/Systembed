import type { MediaType } from '../types/media';

export interface TmdbWebDiscoveredItem {
  tmdbId: number;
  type: MediaType;
  title: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number | null;
}

export interface TmdbWebEpisodeItem {
  season: number;
  episode: number;
  episodeTitle: string;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    })
    .trim();
}

function upgradeTmdbPosterUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  let clean = rawUrl.trim();
  if (clean.startsWith('//')) clean = `https:${clean}`;
  if (clean.startsWith('/t/p/')) clean = `https://media.themoviedb.org${clean}`;
  // Upgrade thumbnail width to w500 for crisp catalog posters
  return clean.replace(/\/t\/p\/w\d+_and_h\d+_face\//i, '/t/p/w500/');
}

/**
 * Extracts movies or TV shows from TMDB's public HTML catalog pages
 * (/movie, /movie/top-rated, /movie/now-playing, /tv, /tv/top-rated, /tv/on-the-air)
 * without requiring an API key.
 */
export function parseTmdbWebCatalogHtml(html: string, mediaType: MediaType): TmdbWebDiscoveredItem[] {
  const results: TmdbWebDiscoveredItem[] = [];
  const seen = new Set<number>();

  // Each card carries a `data-id="12345" ... data-media-type="movie|tv" data-name="Title"` attribute block
  const cardMarkerRx = /data-id=["'](\d+)["'][^>]*data-media-type=["'](movie|tv)["'][^>]*data-name=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = cardMarkerRx.exec(html)) !== null) {
    const tmdbId = Number.parseInt(match[1], 10);
    const detectedType: MediaType = match[2] === 'tv' ? 'tv' : 'movie';
    if (!tmdbId || seen.has(tmdbId)) continue;
    if (detectedType !== mediaType) continue;

    seen.add(tmdbId);
    const title = decodeHtmlEntities(match[3]) || `TMDB #${tmdbId}`;

    // Look backwards up to 900 chars for the poster <img> and forwards up to 900 chars for <span class="release_date">
    const beforeSlice = html.slice(Math.max(0, match.index - 900), match.index);
    const afterSlice = html.slice(match.index, Math.min(html.length, match.index + 900));

    let posterUrl = '';
    const imgMatches = Array.from(
      beforeSlice.matchAll(/<img[^>]+class=["'][^"']*poster[^"']*["'][^>]+src=["']([^"']+)["']/gi)
    );
    if (imgMatches.length > 0) {
      posterUrl = upgradeTmdbPosterUrl(imgMatches[imgMatches.length - 1][1]);
    } else {
      const anyTmdbImg = Array.from(beforeSlice.matchAll(/https:\/\/(?:media\.themoviedb\.org|image\.tmdb\.org)\/t\/p\/[^"'\s]+/gi));
      if (anyTmdbImg.length > 0) {
        posterUrl = upgradeTmdbPosterUrl(anyTmdbImg[anyTmdbImg.length - 1][0]);
      }
    }

    let releaseYear: number | null = null;
    const dateMatch = afterSlice.match(/<span[^>]*class=["'][^"']*release_date[^"']*["'][^>]*>([^<]+)<\/span>/i);
    if (dateMatch) {
      const yearMatch = dateMatch[1].match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch) {
        releaseYear = Number.parseInt(yearMatch[1], 10);
      }
    }

    results.push({
      tmdbId,
      type: mediaType,
      title,
      posterUrl,
      backdropUrl: posterUrl,
      releaseYear,
    });
  }

  return results;
}

/**
 * Extracts distinct positive season numbers from a TMDB `/tv/{id}/seasons` page.
 */
export function parseTmdbWebSeasonsHtml(html: string, tmdbId: number): number[] {
  const seasons = new Set<number>();
  const rx = new RegExp(`/tv/${tmdbId}[^"']*?/season/(\\d+)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    const sNum = Number.parseInt(m[1], 10);
    if (Number.isFinite(sNum) && sNum >= 1 && sNum <= 100) {
      seasons.add(sNum);
    }
  }
  return Array.from(seasons).sort((a, b) => a - b);
}

/**
 * Extracts episode numbers and clean titles from a TMDB `/tv/{id}/season/{n}` page.
 */
export function parseTmdbWebEpisodesHtml(html: string, fallbackSeason = 1): TmdbWebEpisodeItem[] {
  const byEpisode = new Map<string, TmdbWebEpisodeItem>();

  const anchorTagRx = /<a\b[^>]*\bdata-episode-number=["'](\d+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorTagRx.exec(html)) !== null) {
    const tag = m[0];
    const episode = Number.parseInt(m[1], 10);
    const seasonMatch = tag.match(/\bdata-season-number=["'](\d+)["']/i);
    const season = seasonMatch ? Number.parseInt(seasonMatch[1], 10) : fallbackSeason;
    if (!episode || episode < 1 || season < 1) continue;

    const titleMatch = tag.match(/\btitle=["']([^"']*)["']/i);
    const rawTitle = decodeHtmlEntities(titleMatch ? titleMatch[1] : '');
    // Strip "Show: Temporada 1 (2008): Episode 1 - Piloto" -> "Piloto"
    const dashMatch = rawTitle.match(/Episode\s+\d+\s*-\s*(.+)$/i);
    const cleanTitle = dashMatch ? dashMatch[1].trim() : rawTitle || `Episódio ${episode}`;

    const key = `${season}:${episode}`;
    if (!byEpisode.has(key)) {
      byEpisode.set(key, {
        season,
        episode,
        episodeTitle: cleanTitle,
      });
    }
  }

    if (byEpisode.size === 0) {
    // Fallback: extract episode links /season/{s}/episode/{e}
    const linkRx = /\/season\/(\d+)\/episode\/(\d+)/gi;
    while ((m = linkRx.exec(html)) !== null) {
      const season = Number.parseInt(m[1], 10) || fallbackSeason;
      const episode = Number.parseInt(m[2], 10);
      if (!episode || episode < 1) continue;
      const key = `${season}:${episode}`;
      if (!byEpisode.has(key)) {
        byEpisode.set(key, {
          season,
          episode,
          episodeTitle: `Episódio ${episode}`,
        });
      }
    }
  }

  return Array.from(byEpisode.values()).sort((a, b) => a.season - b.season || a.episode - b.episode);
}

export interface TmdbWebSearchItem extends TmdbWebDiscoveredItem {
  originalTitle: string;
  overview: string;
}

/**
 * Extracts movies or TV series from TMDB public HTML search pages
 * (/search/movie?query=... or /search/tv?query=...) without an API key.
 */
export function parseTmdbWebSearchHtml(html: string, mediaType?: MediaType): TmdbWebSearchItem[] {
  const results: TmdbWebSearchItem[] = [];
  const seen = new Set<string>();

  // Match links like: data-media-type="movie" ... href="/movie/603-the-matrix?language=pt-BR"
  const cardRx =
    /<a\b[^>]*\bdata-media-type=["'](movie|tv)["'][^>]*\bhref=["']\/(movie|tv)\/(\d+)[^"']*["'][^>]*>/gi;
  let m: RegExpExecArray | null;

  while ((m = cardRx.exec(html)) !== null) {
    const type: MediaType = m[2] === 'tv' ? 'tv' : 'movie';
    if (mediaType && type !== mediaType) continue;
    const tmdbId = Number.parseInt(m[3], 10);
    if (!tmdbId) continue;

    const dedupeKey = `${type}_${tmdbId}`;
    if (seen.has(dedupeKey)) continue;

    const windowSlice = html.slice(m.index, Math.min(html.length, m.index + 2200));

    // Only treat the card block containing poster/heading, avoiding bare duplicate link matches
    const h2Match = windowSlice.match(
      /<h2[^>]*>([\s\S]*?)<\/h2>/i
    );
    const imgMatch = windowSlice.match(
      /<img[^>]+class=["'][^"']*poster[^"']*["'][^>]+(?:src|data-src)=["']([^"']+)["']/i
    );
    const altMatch = windowSlice.match(/<img[^>]+alt=["']([^"']+)["'][^>]+class=["'][^"']*poster/i);

    let title = '';
    let originalTitle = '';
    if (h2Match) {
      const spans = Array.from(h2Match[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)).map((s) =>
        decodeHtmlEntities(s[1].replace(/<[^>]+>/g, ''))
      );
      if (spans.length > 0) {
        title = spans[0];
        if (spans[1]) {
          originalTitle = spans[1].replace(/^\s*\(|\)\s*$/g, '').trim();
        }
      } else {
        title = decodeHtmlEntities(h2Match[1].replace(/<[^>]+>/g, ''));
      }
    } else if (altMatch) {
      title = decodeHtmlEntities(altMatch[1]);
    }

    if (!title) continue;

    seen.add(dedupeKey);

    const posterUrl = imgMatch
      ? upgradeTmdbPosterUrl(imgMatch[1]).replace(/\/t\/p\/w\d+_and_h\d+_face\//i, '/t/p/w500/')
      : '';

    let releaseYear: number | null = null;
    const dateMatch = windowSlice.match(/<span[^>]*class=["'][^"']*release_date[^"']*["'][^>]*>([^<]+)<\/span>/i);
    if (dateMatch) {
      const yearMatch = dateMatch[1].match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch) {
        releaseYear = Number.parseInt(yearMatch[1], 10);
      }
    }

    let overview = '';
    const overviewMatch = windowSlice.match(/<div[^>]*class=["'][^"']*mt-4[^"']*["'][^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    if (overviewMatch) {
      overview = decodeHtmlEntities(overviewMatch[1].replace(/<[^>]+>/g, ''));
    }

    results.push({
      tmdbId,
      type,
      title,
      originalTitle,
      overview,
      posterUrl,
      backdropUrl: posterUrl,
      releaseYear,
    });
  }

  return results;
}

export interface TmdbWebDetails {
  tmdbId: number;
  type: MediaType;
  title: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number | null;
}

/**
 * Extracts title, overview, poster, and backdrop from TMDB's public /movie/{id} or /tv/{id} page.
 */
export function parseTmdbWebDetailsHtml(
  html: string,
  mediaType: MediaType,
  tmdbId: number
): TmdbWebDetails | null {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const ogImages = Array.from(
    html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi)
  ).map((m) => upgradeTmdbPosterUrl(m[1]));

  const fallbackTitleMatch = html.match(/<title>([^<—&#|(]+)/i);
  const title = decodeHtmlEntities(ogTitle || fallbackTitleMatch?.[1] || '');
  if (!title) return null;

  const yearMatch = html.match(/<span[^>]*class=["'][^"']*tag release_date[^"']*["'][^>]*>\s*\((\d{4})\)/i);
  const releaseYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;

  return {
    tmdbId,
    type: mediaType,
    title,
    overview: decodeHtmlEntities(ogDesc || ''),
    posterUrl: ogImages[0] || '',
    backdropUrl: ogImages[1] || ogImages[0] || '',
    releaseYear,
  };
}


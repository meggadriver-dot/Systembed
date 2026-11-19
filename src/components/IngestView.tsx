import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileCode2,
  Globe,
  Film,
  CheckCircle2,
  AlertCircle,
  Search,
  LogIn,
  Layers,
  Tv,
  Database,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react';
import { parseM3uPlaylist } from '../utils/m3uParser';
import {
  DEFAULT_EXTERNAL_MAPPING,
  extractFromExternalPayload,
  generateDeterministicTmdbFallback,
  type ExternalFieldMapping,
} from '../utils/externalExtractor';
import {
  DEFAULT_MOVIE_EMBED_TEMPLATE,
  DEFAULT_TV_EMBED_TEMPLATE,
  expandEmbedTemplate,
  parseEmbedTargetsInput,
} from '../utils/embedSourceParser';
import {
  saveIngestedBatchToFirestore,
  saveUserTmdbSecret,
  type IngestEntryPayload,
} from '../services/firestoreCatalog';
import type { MediaType, TmdbSearchResult, UserProfile } from '../types/media';

interface IngestViewProps {
  user: UserProfile | null;
  tmdbApiKey: string;
  tmdbConfigured: boolean;
  onTmdbKeyUpdated: (newKey: string) => void;
  onGoToCatalog: () => void;
  onSignInGoogle: () => void;
}

function getSampleM3u() {
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  return `#EXTM3U
#EXTINF:-1 group-title="Filmes Ação" tmdb-id="550",Clube da Luta (1999) [1080p] [DUAL]
${base}/demo/stream.mp4
#EXTINF:-1 group-title="Filmes Ficção" tmdb-id="603",Matrix (1999) [4K] [PT-BR]
${base}/demo/hls/master.m3u8
#EXTINF:-1 group-title="Séries Drama" tmdb-id="1399",Guerra dos Tronos S01E01 [1080p] [LEG]
${base}/demo/stream.mp4
#EXTINF:-1 group-title="Séries Drama" tmdb-id="1399",Guerra dos Tronos S01E02 [1080p] [PT-BR]
${base}/demo/hls/master.m3u8`;
}

function getSampleJson() {
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  return JSON.stringify(
    {
      results: [
        {
          title: 'A Origem',
          tmdb_id: 27205,
          type: 'movie',
          year: 2010,
          rating: 8.8,
          quality: '4K',
          language: 'DUAL',
          overview:
            'Um ladrão especializado em extrair segredos do subconsciente recebe uma missão inversa: plantar uma ideia.',
          stream_url: `${base}/demo/hls/master.m3u8`,
        },
        {
          title: 'O Mandaloriano',
          tmdb_id: 82856,
          type: 'tv',
          season: 1,
          episode: 1,
          episode_title: 'Capítulo 1',
          year: 2019,
          quality: '1080p',
          language: 'PT-BR',
          stream_url: `${base}/demo/stream.mp4`,
        },
      ],
    },
    null,
    2
  );
}

export function IngestView({
  user,
  tmdbApiKey,
  tmdbConfigured,
  onTmdbKeyUpdated,
  onGoToCatalog,
  onSignInGoogle,
}: IngestViewProps) {
  const [activeTab, setActiveTab] = useState<'embed' | 'm3u' | 'external' | 'manual'>('embed');

  // Embed & Provider Extractor state
  const [embedSubMode, setEmbedSubMode] = useState<'sync_all' | 'batch' | 'tmdb_auto'>('sync_all');
  const [embedSourceName, setEmbedSourceName] = useState('EmbedMaster (Fonte Principal)');
  const [embedMovieTpl, setEmbedMovieTpl] = useState(DEFAULT_MOVIE_EMBED_TEMPLATE);
  const [embedTvTpl, setEmbedTvTpl] = useState(DEFAULT_TV_EMBED_TEMPLATE);
  const [embedBatchInput, setEmbedBatchInput] = useState(
    'https://embedmaster.link/movie/550\nhttps://embedmaster.link/tv/1399/1/1-3'
  );
  const [embedEnrichTmdb, setEmbedEnrichTmdb] = useState(true);
  const [embedAllowFallback, setEmbedAllowFallback] = useState(true);

  // Full Catalog Sync options (Continuous & Resumable)
  const [syncIncludeMovies, setSyncIncludeMovies] = useState(true);
  const [syncIncludeSeries, setSyncIncludeSeries] = useState(true);
  const [syncPages, setSyncPages] = useState(15);
  const [syncMaxSeasons, setSyncMaxSeasons] = useState(1);
  const [syncTryDirect, setSyncTryDirect] = useState(true);
  const [inlineTmdbInput, setInlineTmdbInput] = useState('');
  const [savingInlineTmdb, setSavingInlineTmdb] = useState(false);
  const [showOptionalTmdbBox, setShowOptionalTmdbBox] = useState(false);
  const [syncNextPage, setSyncNextPage] = useState(1);
  const [syncCurrentPage, setSyncCurrentPage] = useState<number | null>(null);
  const [syncPaused, setSyncPaused] = useState(false);
  const pauseRequestedRef = useRef(false);
  const [syncSummary, setSyncSummary] = useState<{
    moviesCount: number;
    seriesCount: number;
    episodesCount: number;
    directExtractedCount: number;
    embedFallbackCount: number;
    savedCount: number;
    skippedCount: number;
    pagesCompleted: number;
    cloudflareDetected: boolean;
    providerProbeMessage: string;
  } | null>(null);

  const [embedReport, setEmbedReport] = useState<{
    totalTargets: number;
    extractedDirectCount: number;
    fallbackCount: number;
    failedCount: number;
    results: Array<{
      targetUrl: string;
      type: MediaType;
      tmdbId: number;
      season: number;
      episode: number;
      title: string;
      status: 'extracted' | 'fallback' | 'blocked_or_empty' | 'error';
      streamsFound: number;
      message: string;
    }>;
  } | null>(null);

  // TMDB Auto Batch Discovery (inside Embed Extractor)
  const [autoType, setAutoType] = useState<MediaType>('tv');
  const [autoCategory, setAutoCategory] = useState<'popular' | 'top_rated'>('popular');
  const [autoMovies, setAutoMovies] = useState<TmdbSearchResult[]>([]);
  const [autoSelectedMovieIds, setAutoSelectedMovieIds] = useState<number[]>([]);
  const [autoTvTmdbId, setAutoTvTmdbId] = useState('1399');
  const [autoTvInfo, setAutoTvInfo] = useState<{
    tmdbId: number;
    title: string;
    seasons: Array<{ seasonNumber: number; episodeCount: number; name: string }>;
    selectedSeason: number;
    episodes: Array<{ season: number; episode: number; episodeTitle: string }>;
  } | null>(null);
  const [autoLoadingTmdb, setAutoLoadingTmdb] = useState(false);

  // M3U state
  const [m3uMode, setM3uMode] = useState<'text' | 'url'>('text');
  const [m3uUrl, setM3uUrl] = useState('');
  const [m3uText, setM3uText] = useState('');
  const [m3uSourceName, setM3uSourceName] = useState('Lista M3U Principal');
  const [m3uEnrichTmdb, setM3uEnrichTmdb] = useState(true);

  // External API state
  const [extMode, setExtMode] = useState<'json' | 'url'>('json');
  const [extUrl, setExtUrl] = useState('');
  const [extJson, setExtJson] = useState('');
  const [extSourceName, setExtSourceName] = useState('Provedor API Externo');
  const [extDefaultType, setExtDefaultType] = useState<MediaType>('movie');
  const [extAuthHeaderName, setExtAuthHeaderName] = useState('');
  const [extAuthHeaderValue, setExtAuthHeaderValue] = useState('');
  const [extMapping, setExtMapping] = useState<ExternalFieldMapping>(DEFAULT_EXTERNAL_MAPPING);
  const [extEnrichTmdb, setExtEnrichTmdb] = useState(true);

  // Manual + TMDB state
  const [tmdbQuery, setTmdbQuery] = useState('');
  const [tmdbSearchType, setTmdbSearchType] = useState<MediaType>('movie');
  const [tmdbResults, setTmdbResults] = useState<TmdbSearchResult[]>([]);
  const [tmdbSearching, setTmdbSearching] = useState(false);
  const [manualTmdbId, setManualTmdbId] = useState('');
  const [manualType, setManualType] = useState<MediaType>('movie');
  const [manualTitle, setManualTitle] = useState('');
  const [manualYear, setManualYear] = useState('');
  const [manualOverview, setManualOverview] = useState('');
  const [manualPoster, setManualPoster] = useState('');
  const [manualStreamUrl, setManualStreamUrl] = useState('');
  const [manualQuality, setManualQuality] = useState('1080p');
  const [manualLanguage, setManualLanguage] = useState('PT-BR');
  const [manualSeason, setManualSeason] = useState('1');
  const [manualEpisode, setManualEpisode] = useState('1');

  // Shared job status feedback
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    title: string;
    details: string[];
  } | null>(null);

  const hasTmdbAccess = Boolean(tmdbApiKey || tmdbConfigured);
  const syncCursorStorageKey = user ? `cinevault_sync_cursor_${user.uid}` : 'cinevault_sync_cursor_guest';

  useEffect(() => {
    try {
      const raw = localStorage.getItem(syncCursorStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        nextPage?: number;
        totalPages?: number;
        summary?: typeof syncSummary;
      };
      if (typeof parsed.nextPage === 'number' && parsed.nextPage >= 1) {
        setSyncNextPage(parsed.nextPage);
      }
      if (typeof parsed.totalPages === 'number' && parsed.totalPages >= 1) {
        setSyncPages(parsed.totalPages);
      }
      if (parsed.summary) {
        setSyncSummary(parsed.summary);
      }
    } catch {
      // Ignore invalid localStorage state
    }
  }, [syncCursorStorageKey]);

  function persistSyncCursor(nextPageVal: number, summaryVal: typeof syncSummary) {
    try {
      localStorage.setItem(
        syncCursorStorageKey,
        JSON.stringify({ nextPage: nextPageVal, totalPages: syncPages, summary: summaryVal })
      );
    } catch {
      // Non-fatal
    }
  }

  function handleResetSyncCursor() {
    setSyncNextPage(1);
    setSyncCurrentPage(null);
    setSyncPaused(false);
    setSyncSummary(null);
    setFeedback(null);
    try {
      localStorage.removeItem(syncCursorStorageKey);
    } catch {
      // Non-fatal
    }
  }

  const embedTargetsPreview = useMemo(() => {
    if (!embedBatchInput.trim()) return [];
    return parseEmbedTargetsInput(embedBatchInput, embedMovieTpl, embedTvTpl).slice(0, 40);
  }, [embedBatchInput, embedMovieTpl, embedTvTpl]);

  const m3uPreview = useMemo(() => {
    if (m3uMode !== 'text' || !m3uText.trim()) return null;
    return parseM3uPlaylist(m3uText);
  }, [m3uMode, m3uText]);

  const jsonPreview = useMemo(() => {
    if (extMode !== 'json' || !extJson.trim()) return null;
    try {
      const parsed = JSON.parse(extJson);
      return extractFromExternalPayload(parsed, extMapping, extDefaultType);
    } catch {
      return null;
    }
  }, [extMode, extJson, extMapping, extDefaultType]);

  function loadEmbedDemoPreset() {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    setEmbedSubMode('batch');
    setEmbedSourceName('Demo Multi-Camadas Local');
    setEmbedMovieTpl(`${base}/demo/mock-embed/movie/{id}`);
    setEmbedTvTpl(`${base}/demo/mock-embed/tv/{id}/{season}/{episode}`);
    setEmbedBatchInput(
      `${base}/demo/mock-embed/movie/550\n${base}/demo/mock-embed/tv/1399/1/1-2`
    );
    setEmbedReport(null);
    setFeedback(null);
  }

  function loadEmbedMasterPreset() {
    setEmbedSourceName('EmbedMaster (Fonte Principal)');
    setEmbedMovieTpl(DEFAULT_MOVIE_EMBED_TEMPLATE);
    setEmbedTvTpl(DEFAULT_TV_EMBED_TEMPLATE);
    setEmbedBatchInput(
      'https://embedmaster.link/movie/550\nhttps://embedmaster.link/tv/1399/1/1-3'
    );
    setEmbedAllowFallback(true);
    setEmbedReport(null);
    setSyncSummary(null);
    setFeedback(null);
  }

  async function handleSaveInlineTmdbKey() {
    if (!user || !inlineTmdbInput.trim()) return;
    setSavingInlineTmdb(true);
    setFeedback(null);
    try {
      const cleaned = inlineTmdbInput.trim();
      await saveUserTmdbSecret(user.uid, cleaned);
      onTmdbKeyUpdated(cleaned);
      setInlineTmdbInput('');
      setFeedback({
        type: 'success',
        title: 'Chave TMDB v3 salva com segurança no Firebase',
        details: ['Agora você já pode puxar todos os catálogos de filmes, séries e episódios em 1 clique.'],
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        title: 'Não foi possível salvar a chave TMDB',
        details: [err instanceof Error ? err.message : 'Erro desconhecido.'],
      });
    } finally {
      setSavingInlineTmdb(false);
    }
  }

  async function handleLoadTmdbDiscover() {
    setAutoLoadingTmdb(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/tmdb/discover?type=movie&category=${autoCategory}&page=1`, {
        headers: tmdbApiKey ? { 'x-tmdb-key': tmdbApiKey } : {},
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'error', title: data.error || 'Erro ao consultar TMDB.', details: [] });
        return;
      }
      const list = (data.results || []) as TmdbSearchResult[];
      setAutoMovies(list);
      setAutoSelectedMovieIds(list.slice(0, 6).map((m) => m.tmdbId));
    } finally {
      setAutoLoadingTmdb(false);
    }
  }

  async function handleLoadTmdbTvSeasons(seasonNum?: number) {
    const cleanId = Number(autoTvTmdbId);
    if (!cleanId) return;
    setAutoLoadingTmdb(true);
    setFeedback(null);
    try {
      const qs = seasonNum ? `?season=${seasonNum}` : '';
      const res = await fetch(`/api/tmdb/tv/${cleanId}/seasons${qs}`, {
        headers: tmdbApiKey ? { 'x-tmdb-key': tmdbApiKey } : {},
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'error', title: data.error || 'Erro ao carregar série no TMDB.', details: [] });
        return;
      }
      setAutoTvInfo(data);
    } finally {
      setAutoLoadingTmdb(false);
    }
  }

  async function handleEmbedExtractSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      setFeedback({
        type: 'error',
        title: 'Autenticação necessária',
        details: ['Faça login com sua conta Google antes de extrair e gravar conteúdos no Cloud Firestore.'],
      });
      return;
    }

    if (embedSubMode === 'sync_all') {
      if (!syncIncludeMovies && !syncIncludeSeries) {
        setFeedback({
          type: 'error',
          title: 'Selecione ao menos um tipo de catálogo',
          details: ['Marque Filmes e/ou Séries para sincronizar com a Fonte Principal.'],
        });
        return;
      }

      const startFrom = syncNextPage > syncPages ? 1 : syncNextPage;
      pauseRequestedRef.current = false;
      setSyncPaused(false);
      setFeedback(null);
      setEmbedReport(null);
      setSubmitting(true);

      let cumulative = syncSummary && startFrom > 1
        ? { ...syncSummary }
        : {
            moviesCount: 0,
            seriesCount: 0,
            episodesCount: 0,
            directExtractedCount: 0,
            embedFallbackCount: 0,
            savedCount: 0,
            skippedCount: 0,
            pagesCompleted: 0,
            cloudflareDetected: false,
            providerProbeMessage: 'Sincronizando lotes contínuos com a Fonte Principal...',
          };

      let knownCloudflare = cumulative.cloudflareDetected;
      let stoppedByPause = false;
      let lastCompletedPage = startFrom - 1;

      try {
        for (let page = startFrom; page <= syncPages; page++) {
          if (pauseRequestedRef.current) {
            stoppedByPause = true;
            break;
          }

          setSyncCurrentPage(page);

          const res = await fetch('/api/proxy/sync-catalog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              movieTemplate: embedMovieTpl,
              tvTemplate: embedTvTpl,
              sourceName: embedSourceName,
              tmdbApiKey,
              includeMovies: syncIncludeMovies,
              includeSeries: syncIncludeSeries,
              startPage: page,
              endPage: page,
              maxSeasonsPerSeries: syncMaxSeasons,
              tryDirectExtraction: syncTryDirect,
              allowEmbedFallback: embedAllowFallback,
              skipDirectProbe: knownCloudflare,
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            setFeedback({
              type: 'error',
              title: data.error || `Erro ao sincronizar página ${page}.`,
              details: ['O progresso anterior já foi salvo no Cloud Firestore. Clique em Continuar para retomar.'],
            });
            return;
          }

          if (data.cloudflareDetected) {
            knownCloudflare = true;
          }

          const entries = (data.entries || []) as IngestEntryPayload[];
          if (entries.length === 0) {
            setSyncSummary({
              ...cumulative,
              providerProbeMessage: String(data.providerProbeMessage || cumulative.providerProbeMessage),
            });
            if (page === startFrom) {
              setFeedback({
                type: 'error',
                title: 'Nenhum título salvo (extração direta bloqueada)',
                details: [String(data.providerProbeMessage || 'A origem bloqueou extração server-side.')],
              });
              return;
            }
            break;
          }

          const saved = await saveIngestedBatchToFirestore(user.uid, entries, {
            sourceType: 'external_api',
            sourceName: `${embedSourceName.trim() || 'EmbedMaster'} (Pág. ${page})`,
            sourceUrl: embedMovieTpl.trim(),
            totalFound: Number(data.totalEntries || entries.length),
            failedCount: 0,
            extraLogs: [
              `Página ${page}: ${data.moviesCount} filmes, ${data.seriesCount} séries (${data.episodesCount} episódios).`,
              String(data.providerProbeMessage || '').slice(0, 220),
            ],
          });

          cumulative = {
            moviesCount: cumulative.moviesCount + Number(data.moviesCount || 0),
            seriesCount: cumulative.seriesCount + Number(data.seriesCount || 0),
            episodesCount: cumulative.episodesCount + Number(data.episodesCount || 0),
            directExtractedCount: cumulative.directExtractedCount + Number(data.directExtractedCount || 0),
            embedFallbackCount: cumulative.embedFallbackCount + Number(data.embedFallbackCount || 0),
            savedCount: cumulative.savedCount + saved.importedCount,
            skippedCount: cumulative.skippedCount + saved.skippedCount,
            pagesCompleted: page,
            cloudflareDetected: knownCloudflare,
            providerProbeMessage: String(data.providerProbeMessage || cumulative.providerProbeMessage),
          };
          lastCompletedPage = page;
          const nextCursor = page + 1;
          setSyncSummary(cumulative);
          setSyncNextPage(nextCursor);
          persistSyncCursor(nextCursor, cumulative);

          if (pauseRequestedRef.current) {
            stoppedByPause = true;
            break;
          }
        }

        setSyncPaused(stoppedByPause);
        setFeedback({
          type: 'success',
          title: stoppedByPause
            ? `Importação pausada na página ${lastCompletedPage}: ${cumulative.savedCount} fonte(s) já gravadas`
            : `Importação concluída até a página ${lastCompletedPage}: ${cumulative.savedCount} fonte(s) no Firebase`,
          details: [
            `${cumulative.moviesCount} filmes e ${cumulative.seriesCount} séries (${cumulative.episodesCount} episódios) processados com ${embedSourceName}.`,
            stoppedByPause
              ? `Você pode retomar imediatamente da página ${lastCompletedPage + 1} clicando em "Continuar Importação".`
              : `${cumulative.savedCount} novas fontes gravadas no Firestore; ${cumulative.skippedCount} duplicadas ignoradas.`,
          ],
        });
      } catch (err) {
        setFeedback({
          type: 'error',
          title: 'Erro ao sincronizar catálogos no Firebase.',
          details: [
            err instanceof Error ? err.message : 'Erro desconhecido.',
            lastCompletedPage >= 1
              ? `As páginas até ${lastCompletedPage} já foram salvas. Clique em Continuar Importação para retomar.`
              : '',
          ].filter(Boolean),
        });
      } finally {
        setSyncCurrentPage(null);
        setSubmitting(false);
      }
      return;
    }

    let requestBody: Record<string, unknown> = {
      movieTemplate: embedMovieTpl,
      tvTemplate: embedTvTpl,
      sourceName: embedSourceName,
      enrichWithTmdb: embedEnrichTmdb,
      tmdbApiKey,
      allowEmbedFallback: embedAllowFallback,
    };

    if (embedSubMode === 'batch') {
      requestBody.targetsInput = embedBatchInput;
    } else if (autoType === 'movie') {
      if (autoSelectedMovieIds.length === 0) {
        setFeedback({
          type: 'error',
          title: 'Selecione ao menos um filme',
          details: ['Carregue os filmes do TMDB e marque os títulos que deseja extrair.'],
        });
        return;
      }
      requestBody.targets = autoSelectedMovieIds.map((id) => ({
        type: 'movie',
        tmdbId: id,
        url: expandEmbedTemplate(embedMovieTpl, { type: 'movie', tmdbId: id }),
      }));
    } else {
      if (!autoTvInfo || autoTvInfo.episodes.length === 0) {
        setFeedback({
          type: 'error',
          title: 'Carregue os episódios da série',
          details: ['Informe o TMDB ID da série e clique em "Carregar Temporadas" antes de extrair.'],
        });
        return;
      }
      requestBody.targets = autoTvInfo.episodes.slice(0, 40).map((ep) => ({
        type: 'tv',
        tmdbId: autoTvInfo.tmdbId,
        season: ep.season,
        episode: ep.episode,
        episodeTitle: ep.episodeTitle,
        url: expandEmbedTemplate(embedTvTpl, {
          type: 'tv',
          tmdbId: autoTvInfo.tmdbId,
          season: ep.season,
          episode: ep.episode,
        }),
      }));
    }

    setFeedback(null);
    setEmbedReport(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/proxy/extract-embeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'error', title: data.error || 'Erro ao extrair dos embeds.', details: [] });
        return;
      }

      setEmbedReport({
        totalTargets: Number(data.totalTargets || 0),
        extractedDirectCount: Number(data.extractedDirectCount || 0),
        fallbackCount: Number(data.fallbackCount || 0),
        failedCount: Number(data.failedCount || 0),
        results: data.results || [],
      });

      const entries = (data.entries || []) as IngestEntryPayload[];
      if (entries.length === 0) {
        setFeedback({
          type: 'error',
          title: 'Nenhum stream direto foi exposto pelas URLs informadas',
          details: [
            'Os links retornaram bloqueio anti-bot (Cloudflare/403) ou player ofuscado sem .m3u8/.mp4 direto no HTML.',
            'Você pode testar o extrator completo clicando em "Testar Demo Local (Multi-Camadas)" ou habilitar o fallback embed se o provedor exigir iframe.',
          ],
        });
        return;
      }

      const saved = await saveIngestedBatchToFirestore(user.uid, entries, {
        sourceType: 'external_api',
        sourceName: embedSourceName.trim() || 'Extrator Embed & Provedores',
        sourceUrl: embedMovieTpl.trim(),
        totalFound: Number(data.totalTargets || entries.length),
        failedCount: Number(data.failedCount || 0),
        extraLogs: [
          `Streams diretos extraídos: ${data.extractedDirectCount} alvo(s), fallback: ${data.fallbackCount}.`,
        ],
      });

      setFeedback({
        type: 'success',
        title: `Extração independente gravada no Cloud Firestore: ${saved.importedCount} stream(s)`,
        details: [
          `${data.extractedDirectCount} alvo(s) com stream direto (.m3u8/.mp4) salvo(s) sem depender mais da origem externa.`,
          `${saved.importedCount} gravados no Firestore; ${saved.skippedCount} duplicados ignorados.`,
        ],
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        title: 'Erro ao executar extração de embeds.',
        details: [err instanceof Error ? err.message : 'Erro desconhecido.'],
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleM3uSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      setFeedback({
        type: 'error',
        title: 'Autenticação necessária',
        details: ['Faça login com sua conta Google antes de salvar conteúdos no Cloud Firestore.'],
      });
      return;
    }

    setFeedback(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/proxy/parse-m3u', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          m3uUrl: m3uMode === 'url' ? m3uUrl.trim() : undefined,
          m3uContent: m3uMode === 'text' ? m3uText : undefined,
          sourceName: m3uSourceName,
          enrichWithTmdb: m3uEnrichTmdb,
          tmdbApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'error', title: data.error || 'Erro ao analisar lista M3U.', details: [] });
        return;
      }

      const saved = await saveIngestedBatchToFirestore(user.uid, data.entries as IngestEntryPayload[], {
        sourceType: m3uMode === 'url' ? 'm3u_url' : 'm3u_text',
        sourceName: m3uSourceName.trim() || 'Importação M3U',
        sourceUrl: m3uMode === 'url' ? m3uUrl.trim() : '',
        totalFound: Number(data.totalFound || 0),
        failedCount: Number(data.failedCount || 0),
        extraLogs: data.tmdbLookups
          ? [`Enriquecimento TMDB executado para ${data.tmdbLookups} títulos.`]
          : [],
      });

      setFeedback({
        type: 'success',
        title: `Extração salva no Cloud Firestore: ${saved.importedCount} stream(s) gravados`,
        details: [
          `Analisados ${data.totalFound} registros da lista M3U.`,
          `${saved.importedCount} novo(s) stream(s) salvos, ${saved.skippedCount} duplicado(s) ignorados.`,
        ],
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        title: 'Falha ao salvar extração no Firebase.',
        details: [err instanceof Error ? err.message : 'Erro desconhecido.'],
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleExternalSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      setFeedback({
        type: 'error',
        title: 'Autenticação necessária',
        details: ['Faça login com sua conta Google antes de salvar conteúdos no Cloud Firestore.'],
      });
      return;
    }

    setFeedback(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/proxy/parse-external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiUrl: extMode === 'url' ? extUrl.trim() : undefined,
          jsonPayload: extMode === 'json' ? extJson : undefined,
          sourceName: extSourceName,
          mapping: extMapping,
          defaultType: extDefaultType,
          authHeaderName: extAuthHeaderName,
          authHeaderValue: extAuthHeaderValue,
          enrichWithTmdb: extEnrichTmdb,
          tmdbApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({
          type: 'error',
          title: data.error || 'Erro ao extrair da API externa.',
          details: data.details || [],
        });
        return;
      }

      const saved = await saveIngestedBatchToFirestore(user.uid, data.entries as IngestEntryPayload[], {
        sourceType: 'external_api',
        sourceName: extSourceName.trim() || 'Extração API Externa',
        sourceUrl: extMode === 'url' ? extUrl.trim() : '',
        totalFound: Number(data.totalFound || 0),
        failedCount: Number(data.failedCount || 0),
        extraLogs: data.tmdbLookups
          ? [`Enriquecimento TMDB executado para ${data.tmdbLookups} títulos.`]
          : [],
      });

      setFeedback({
        type: 'success',
        title: `Extração salva no Cloud Firestore: ${saved.importedCount} stream(s) gravados`,
        details: [
          `Extraídos ${data.totalFound} registros válidos da API externa.`,
          `${saved.importedCount} gravados no Firestore; ${saved.skippedCount} duplicados ignorados.`,
        ],
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        title: 'Erro ao gravar extração externa no Firestore.',
        details: [err instanceof Error ? err.message : 'Erro desconhecido.'],
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTmdbSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!tmdbQuery.trim()) return;
    setTmdbSearching(true);
    setFeedback(null);
    try {
      const res = await fetch(
        `/api/tmdb/search?q=${encodeURIComponent(tmdbQuery.trim())}&type=${tmdbSearchType}`,
        {
          headers: tmdbApiKey ? { 'x-tmdb-key': tmdbApiKey } : {},
        }
      );
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'error', title: data.error || 'Falha na busca TMDB.', details: [] });
        return;
      }
      if (!data.configured) {
        setFeedback({
          type: 'error',
          title: 'Chave TMDB não configurada',
          details: [
            'Você ainda pode cadastrar manualmente informando o TMDB ID e Título abaixo, ou configurar sua chave TMDB v3 na aba Chaves API & Conta.',
          ],
        });
      }
      setTmdbResults(data.results || []);
    } finally {
      setTmdbSearching(false);
    }
  }

  function applyTmdbResult(item: TmdbSearchResult) {
    setManualTmdbId(String(item.tmdbId));
    setManualType(item.type);
    setManualTitle(item.title);
    setManualYear(item.releaseYear ? String(item.releaseYear) : '');
    setManualOverview(item.overview);
    setManualPoster(item.posterUrl);
  }

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      setFeedback({
        type: 'error',
        title: 'Autenticação necessária',
        details: ['Faça login com sua conta Google antes de cadastrar títulos no Cloud Firestore.'],
      });
      return;
    }

    setFeedback(null);
    setSubmitting(true);
    try {
      const parsedYear = manualYear ? Number(manualYear) : null;
      let tmdbIdNum = manualTmdbId ? Number(manualTmdbId) : 0;
      let title = manualTitle.trim();
      let overview = manualOverview.trim();
      let posterUrl = manualPoster.trim();
      let backdropUrl = posterUrl;
      let releaseYear = parsedYear;
      let rating: number | null = null;
      let genres: string[] = [];
      let imdbId = '';
      let runtime: number | null = null;

      if (!tmdbIdNum && title) {
        tmdbIdNum = generateDeterministicTmdbFallback(title, parsedYear);
      }

      if (tmdbIdNum > 0 && tmdbApiKey && tmdbIdNum < 9000000) {
        const detRes = await fetch(`/api/tmdb/details/${manualType}/${tmdbIdNum}`, {
          headers: { 'x-tmdb-key': tmdbApiKey },
        });
        if (detRes.ok) {
          const tmdb = await detRes.json();
          title = title || String(tmdb.title || '');
          overview = overview || String(tmdb.overview || '');
          posterUrl = posterUrl || String(tmdb.posterUrl || '');
          backdropUrl = backdropUrl || String(tmdb.backdropUrl || '');
          releaseYear = releaseYear ?? (tmdb.releaseYear ?? null);
          rating = tmdb.rating ?? null;
          genres = Array.isArray(tmdb.genres) ? tmdb.genres : [];
          imdbId = String(tmdb.imdbId || '');
          runtime = tmdb.runtime ?? null;
        }
      }

      if (!tmdbIdNum || !title) {
        setFeedback({
          type: 'error',
          title: 'Dados incompletos',
          details: ['Informe pelo menos o Título e o TMDB ID (ou selecione uma mídia da busca TMDB).'],
        });
        return;
      }

      const streamUrl = manualStreamUrl.trim();
      if (!/^(https?:\/\/|\/demo\/).+/i.test(streamUrl)) {
        setFeedback({
          type: 'error',
          title: 'URL de stream inválida',
          details: ['Informe uma URL HTTP/HTTPS válida (.m3u8 ou .mp4).'],
        });
        return;
      }

      const entry: IngestEntryPayload = {
        tmdbId: tmdbIdNum,
        imdbId,
        type: manualType,
        title,
        overview,
        posterUrl,
        backdropUrl: backdropUrl || posterUrl,
        releaseYear,
        rating,
        genres,
        runtime,
        sourceOrigin: tmdbApiKey ? 'tmdb_import' : 'manual',
        season: manualType === 'tv' ? Math.max(1, Number(manualSeason) || 1) : 0,
        episode: manualType === 'tv' ? Math.max(1, Number(manualEpisode) || 1) : 0,
        episodeTitle: manualType === 'tv' ? `Episódio ${manualEpisode || 1}` : '',
        streamUrl,
        quality: manualQuality,
        format: streamUrl.toLowerCase().includes('.m3u8') ? 'hls' : 'mp4',
        language: manualLanguage,
        originProvider: 'Cadastro Manual + TMDB',
      };

      const saved = await saveIngestedBatchToFirestore(user.uid, [entry], {
        sourceType: 'external_api',
        sourceName: 'Cadastro Direto + TMDB',
        totalFound: 1,
        failedCount: 0,
      });

      setManualStreamUrl('');
      setFeedback({
        type: 'success',
        title: `"${title}" salvo no Cloud Firestore (TMDB ${tmdbIdNum})`,
        details: [
          `${saved.importedCount} fonte adicionada. O título já está disponível na sua API REST e /embed/.`,
        ],
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        title: 'Erro ao salvar título no Firestore.',
        details: [err instanceof Error ? err.message : 'Erro desconhecido.'],
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {!user && (
        <div className="flex flex-col gap-3 rounded-xl border border-blue-900/60 bg-blue-950/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-blue-100">
            <strong className="font-semibold">Conecte-se ao Firebase Auth:</strong> entre com sua conta Google para gravar listas M3U, APIs externas e títulos TMDB diretamente no seu banco Cloud Firestore.
          </div>
          <button
            type="button"
            onClick={onSignInGoogle}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500 shrink-0"
          >
            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
            Entrar com Google
          </button>
        </div>
      )}

      {/* Mode Switcher */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-[#111827] p-2">
        <button
          type="button"
          onClick={() => {
            setActiveTab('embed');
            setFeedback(null);
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'embed' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Layers className="h-4 w-4" aria-hidden="true" />
          Extrator Embed &amp; Provedores
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('m3u');
            setFeedback(null);
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'm3u' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <FileCode2 className="h-4 w-4" aria-hidden="true" />
          Extrator Lista M3U / M3U8
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('external');
            setFeedback(null);
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'external' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Globe className="h-4 w-4" aria-hidden="true" />
          Extrator API Externa / JSON
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('manual');
            setFeedback(null);
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'manual' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <Film className="h-4 w-4" aria-hidden="true" />
          Cadastro Direto + TMDB
        </button>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          className={`rounded-xl border p-4 ${
            feedback.type === 'success'
              ? 'border-emerald-800/70 bg-emerald-950/30 text-emerald-200'
              : 'border-red-800/70 bg-red-950/30 text-red-200'
          }`}
          role="status"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              {feedback.type === 'success' ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 h-5 w-5 text-red-400 shrink-0" />
              )}
              <div className="space-y-1">
                <div className="text-sm font-semibold">{feedback.title}</div>
                {feedback.details.map((d, idx) => (
                  <p key={idx} className="text-xs opacity-90">
                    {d}
                  </p>
                ))}
              </div>
            </div>
            {feedback.type === 'success' && (
              <button
                type="button"
                onClick={onGoToCatalog}
                className="rounded-lg border border-emerald-700 bg-emerald-900/50 px-3 py-1.5 text-xs font-medium text-emerald-100 hover:bg-emerald-800 whitespace-nowrap shrink-0"
              >
                Ver no Catálogo
              </button>
            )}
          </div>
        </div>
      )}

      {/* TAB 0: EMBED & TEMPLATE EXTRACTOR */}
      {activeTab === 'embed' && (
        <form onSubmit={handleEmbedExtractSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 space-y-4 rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Extrair Streams Diretos de Provedores Embed &amp; Templates
                </h2>
                <p className="text-xs text-slate-400">
                  Percorre iframes e scripts da origem (ex: embedmaster.link), extrai o vídeo real (.m3u8 / .mp4) e salva tudo no Cloud Firestore sem depender mais da fonte externa.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={loadEmbedMasterPreset}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
                >
                  Padrão EmbedMaster
                </button>
                <button
                  type="button"
                  onClick={loadEmbedDemoPreset}
                  className="rounded-lg border border-blue-800 bg-blue-950/60 px-3 py-1.5 text-xs font-medium text-blue-200 hover:bg-blue-900/60 whitespace-nowrap shrink-0"
                >
                  Testar Demo Local (Multi-Camadas)
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="embed-source-name" className="block text-xs font-medium text-slate-400 mb-1">
                  Nome da Origem
                </label>
                <input
                  id="embed-source-name"
                  type="text"
                  value={embedSourceName}
                  onChange={(e) => setEmbedSourceName(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="embed-movie-tpl" className="block text-xs font-medium text-slate-400 mb-1">
                    Template Filmes (&#123;id&#125;)
                  </label>
                  <input
                    id="embed-movie-tpl"
                    type="text"
                    value={embedMovieTpl}
                    onChange={(e) => setEmbedMovieTpl(e.target.value)}
                    placeholder="https://embedmaster.link/movie/{id}"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label htmlFor="embed-tv-tpl" className="block text-xs font-medium text-slate-400 mb-1">
                    Template Séries (&#123;id&#125;/&#123;season&#125;/&#123;episode&#125;)
                  </label>
                  <input
                    id="embed-tv-tpl"
                    type="text"
                    value={embedTvTpl}
                    onChange={(e) => setEmbedTvTpl(e.target.value)}
                    placeholder="https://embedmaster.link/tv/{id}/{season}/{episode}"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
              <button
                type="button"
                onClick={() => setEmbedSubMode('sync_all')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                  embedSubMode === 'sync_all' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Database className="h-3.5 w-3.5" aria-hidden="true" />
                Puxar Todos os Catálogos
              </button>
              <button
                type="button"
                onClick={() => setEmbedSubMode('batch')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                  embedSubMode === 'batch' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                URLs ou IDs em Lote
              </button>
              <button
                type="button"
                onClick={() => setEmbedSubMode('tmdb_auto')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                  embedSubMode === 'tmdb_auto' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Tv className="h-3.5 w-3.5" aria-hidden="true" />
                Série / Lista Específica (TMDB)
              </button>
            </div>

            {embedSubMode === 'sync_all' ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-emerald-200">
                      <strong>Descoberta Automática Ativa:</strong>{' '}
                      {hasTmdbAccess
                        ? 'TMDB API v3 conectada (sinopses e gêneros completos).'
                        : 'modo automático sem chave TMDB habilitado (títulos, pôsteres, temporadas e episódios em PT-BR).'}
                    </span>
                    {!hasTmdbAccess && (
                      <button
                        type="button"
                        onClick={() => setShowOptionalTmdbBox((prev) => !prev)}
                        className="text-[11px] font-medium text-emerald-300 underline hover:text-emerald-200 whitespace-nowrap"
                      >
                        {showOptionalTmdbBox ? 'Ocultar chave opcional' : 'Usar chave TMDB própria (opcional)'}
                      </button>
                    )}
                  </div>
                  {!hasTmdbAccess && showOptionalTmdbBox && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={inlineTmdbInput}
                        onChange={(e) => setInlineTmdbInput(e.target.value)}
                        placeholder="Cole sua TMDB API Key v3 opcional..."
                        aria-label="Chave API TMDB v3 opcional"
                        className="flex-1 min-w-[200px] rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-1.5 text-xs font-mono text-slate-100"
                      />
                      <button
                        type="button"
                        onClick={handleSaveInlineTmdbKey}
                        disabled={savingInlineTmdb || !user || !inlineTmdbInput.trim()}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        {savingInlineTmdb ? 'Salvando...' : 'Salvar Chave TMDB'}
                      </button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-4">
                  <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={syncIncludeMovies}
                      onChange={(e) => setSyncIncludeMovies(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded accent-blue-600"
                    />
                    <span>
                      <strong className="block font-semibold">Catálogos de Filmes</strong>
                      <span className="text-[11px] text-slate-400">Populares, Em Alta &amp; Melhores Avaliados</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={syncIncludeSeries}
                      onChange={(e) => setSyncIncludeSeries(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded accent-blue-600"
                    />
                    <span>
                      <strong className="block font-semibold">Catálogos de Séries</strong>
                      <span className="text-[11px] text-slate-400">Populares, Na TV, Melhores Avaliadas &amp; Episódios</span>
                    </span>
                  </label>

                  <div>
                    <label htmlFor="sync-pages" className="block text-[11px] font-medium text-slate-400 mb-1">
                      Alcance Contínuo (Páginas/Cat.)
                    </label>
                    <select
                      id="sync-pages"
                      value={syncPages}
                      onChange={(e) => setSyncPages(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-700 bg-[#111827] px-2.5 py-2 text-xs text-slate-100"
                    >
                      <option value={5}>Até 5 páginas (~500 títulos)</option>
                      <option value={15}>Até 15 páginas (~1.500 títulos)</option>
                      <option value={30}>Até 30 páginas (~3.000 títulos)</option>
                      <option value={50}>Até 50 páginas (~5.000+ títulos)</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="sync-seasons" className="block text-[11px] font-medium text-slate-400 mb-1">
                      Temporadas por Série
                    </label>
                    <select
                      id="sync-seasons"
                      value={syncMaxSeasons}
                      onChange={(e) => setSyncMaxSeasons(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-700 bg-[#111827] px-2.5 py-2 text-xs text-slate-100"
                    >
                      <option value={1}>1ª Temporada completa</option>
                      <option value={3}>Até 3 Temporadas</option>
                      <option value={0}>Todas as Temporadas (Completas)</option>
                    </select>
                  </div>
                </div>
              </div>
            ) : embedSubMode === 'batch' ? (
              <div>
                <label htmlFor="embed-batch-textarea" className="block text-xs font-medium text-slate-400 mb-1">
                  URLs de Embed, Faixas de Episódios ou IDs TMDB (1 por linha)
                </label>
                <textarea
                  id="embed-batch-textarea"
                  rows={8}
                  required
                  value={embedBatchInput}
                  onChange={(e) => setEmbedBatchInput(e.target.value)}
                  placeholder={`https://embedmaster.link/movie/550\nhttps://embedmaster.link/tv/1399/1/1-5\ntv:94997:S01:E01-E04\n603, 27205`}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] p-3 font-mono text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                />
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Suporta links completos, intervalos de episódios (<code className="text-slate-300">/1-10</code>), ou apenas IDs (<code className="text-slate-300">550, 603</code> / <code className="text-slate-300">tv:1399:S01:E01-E08</code>) expandidos pelo template acima.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setAutoType('tv')}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                      autoType === 'tv'
                        ? 'border-blue-600 bg-blue-950/50 text-blue-200'
                        : 'border-slate-700 bg-[#0B0F17] text-slate-300'
                    }`}
                  >
                    Extrair Temporada de Série (TMDB)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoType('movie')}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                      autoType === 'movie'
                        ? 'border-blue-600 bg-blue-950/50 text-blue-200'
                        : 'border-slate-700 bg-[#0B0F17] text-slate-300'
                    }`}
                  >
                    Extrair Catálogo de Filmes (TMDB)
                  </button>
                </div>

                {autoType === 'tv' ? (
                  <div className="space-y-3 rounded-lg border border-slate-800 bg-[#0B0F17] p-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex-1 min-w-[160px]">
                        <label htmlFor="auto-tv-id" className="block text-xs text-slate-400 mb-1">
                          TMDB ID da Série (ex: 1399, 1396, 94997)
                        </label>
                        <input
                          id="auto-tv-id"
                          type="number"
                          value={autoTvTmdbId}
                          onChange={(e) => setAutoTvTmdbId(e.target.value)}
                          className="w-full rounded-lg border border-slate-700 bg-[#111827] px-3 py-2 text-xs font-mono text-slate-100 tabular-nums"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleLoadTmdbTvSeasons()}
                        disabled={autoLoadingTmdb}
                        className="rounded-lg bg-slate-800 border border-slate-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-700 whitespace-nowrap shrink-0"
                      >
                        {autoLoadingTmdb ? 'Buscando...' : 'Carregar Temporadas'}
                      </button>
                    </div>

                    {autoTvInfo && (
                      <div className="space-y-2 border-t border-slate-800 pt-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-100">
                            {autoTvInfo.title} · {autoTvInfo.episodes.length} episódio(s) na T{String(autoTvInfo.selectedSeason).padStart(2, '0')}
                          </span>
                          <select
                            aria-label="Selecionar Temporada"
                            value={autoTvInfo.selectedSeason}
                            onChange={(e) => handleLoadTmdbTvSeasons(Number(e.target.value))}
                            className="rounded-md border border-slate-700 bg-[#111827] px-2.5 py-1 text-xs text-slate-100"
                          >
                            {autoTvInfo.seasons.map((s) => (
                              <option key={s.seasonNumber} value={s.seasonNumber}>
                                {s.name} ({s.episodeCount} eps)
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="max-h-40 overflow-y-auto divide-y divide-slate-800/70 rounded border border-slate-800 bg-[#111827] text-[11px]">
                          {autoTvInfo.episodes.slice(0, 40).map((ep) => (
                            <div key={ep.episode} className="flex items-center justify-between px-3 py-1.5">
                              <span className="text-slate-200 truncate">
                                T{String(ep.season).padStart(2, '0')}E{String(ep.episode).padStart(2, '0')} · {ep.episodeTitle}
                              </span>
                              <span className="font-mono text-slate-400 truncate max-w-[220px]">
                                {expandEmbedTemplate(embedTvTpl, {
                                  type: 'tv',
                                  tmdbId: autoTvInfo.tmdbId,
                                  season: ep.season,
                                  episode: ep.episode,
                                })}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3 rounded-lg border border-slate-800 bg-[#0B0F17] p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <select
                        aria-label="Lista TMDB"
                        value={autoCategory}
                        onChange={(e) => setAutoCategory(e.target.value === 'top_rated' ? 'top_rated' : 'popular')}
                        className="rounded-lg border border-slate-700 bg-[#111827] px-3 py-2 text-xs text-slate-100"
                      >
                        <option value="popular">Filmes Populares (TMDB)</option>
                        <option value="top_rated">Melhores Avaliados (TMDB)</option>
                      </select>
                      <button
                        type="button"
                        onClick={handleLoadTmdbDiscover}
                        disabled={autoLoadingTmdb}
                        className="rounded-lg bg-slate-800 border border-slate-700 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-700 whitespace-nowrap shrink-0"
                      >
                        {autoLoadingTmdb ? 'Carregando...' : 'Listar Filmes do TMDB'}
                      </button>
                    </div>

                    {autoMovies.length > 0 && (
                      <div className="max-h-48 overflow-y-auto divide-y divide-slate-800 rounded border border-slate-800 bg-[#111827]">
                        {autoMovies.map((m) => {
                          const checked = autoSelectedMovieIds.includes(m.tmdbId);
                          return (
                            <label
                              key={m.tmdbId}
                              className="flex items-center justify-between gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-slate-800/40"
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setAutoSelectedMovieIds((prev) => [...prev, m.tmdbId]);
                                    } else {
                                      setAutoSelectedMovieIds((prev) => prev.filter((id) => id !== m.tmdbId));
                                    }
                                  }}
                                  className="h-3.5 w-3.5 rounded accent-blue-600"
                                />
                                <span className="truncate text-slate-100 font-medium">{m.title}</span>
                              </span>
                              <span className="font-mono text-[11px] text-slate-400 shrink-0 tabular-nums">
                                TMDB {m.tmdbId} {m.releaseYear ? `· ${m.releaseYear}` : ''}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2 border-t border-slate-800 pt-3">
              {embedSubMode === 'sync_all' ? (
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={syncTryDirect}
                    onChange={(e) => setSyncTryDirect(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-blue-600"
                  />
                  Tentar extrair stream direto (.m3u8/.mp4) da origem antes de vincular embed
                </label>
              ) : (
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={embedEnrichTmdb}
                    onChange={(e) => setEmbedEnrichTmdb(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-blue-600"
                  />
                  Enriquecer título, sinopse, gêneros e pôster automaticamente via TMDB{' '}
                  {hasTmdbAccess ? '(Chave Ativa)' : '(Sem chave TMDB)'}
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={embedAllowFallback}
                  onChange={(e) => setEmbedAllowFallback(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-blue-600"
                />
                Usar URL da Fonte Principal (Embed) caso a origem bloqueie extração direta (Cloudflare/anti-bot)
              </label>
            </div>

            {embedSubMode === 'sync_all' ? (
              <div className="space-y-3">
                {(submitting || syncNextPage > 1) && (
                  <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs tabular-nums">
                      <span className="text-slate-300 font-medium">
                        {submitting
                          ? `Importando Página ${syncCurrentPage ?? syncNextPage} de ${syncPages}...`
                          : syncPaused
                            ? `Pausado — próximo lote: Página ${syncNextPage} de ${syncPages}`
                            : syncNextPage > syncPages
                              ? `Concluído (${syncPages} de ${syncPages} páginas)`
                              : `Pronto para continuar da Página ${syncNextPage} até ${syncPages}`}
                      </span>
                      <span className="font-mono text-blue-400">
                        {Math.min(100, Math.round((((syncCurrentPage ? syncCurrentPage - 1 : syncNextPage - 1)) / Math.max(1, syncPages)) * 100))}%
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full bg-blue-600 transition-all duration-300"
                        style={{
                          width: `${Math.min(100, Math.round((((syncCurrentPage ? syncCurrentPage - 1 : syncNextPage - 1)) / Math.max(1, syncPages)) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex-1 min-w-[220px] inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                  >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    {submitting
                      ? `Sincronizando Pág. ${syncCurrentPage ?? syncNextPage} de ${syncPages}...`
                      : syncNextPage > 1 && syncNextPage <= syncPages
                        ? `Continuar Importação (Pág. ${syncNextPage} → ${syncPages})`
                        : syncNextPage > syncPages
                          ? 'Importar Próximo Ciclo / Atualizar Catálogo'
                          : 'Importar Todos os Catálogos para o Banco Firebase'}
                  </button>

                  {submitting ? (
                    <button
                      type="button"
                      onClick={() => {
                        pauseRequestedRef.current = true;
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-700 bg-amber-950/50 px-3.5 py-2.5 text-xs font-semibold text-amber-200 hover:bg-amber-900/50 whitespace-nowrap shrink-0"
                    >
                      <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                      Pausar
                    </button>
                  ) : syncNextPage > 1 ? (
                    <button
                      type="button"
                      onClick={handleResetSyncCursor}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      Reiniciar (Pág. 1)
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
              >
                {submitting
                  ? 'Rastreando Embeds e Salvando no Cloud Firestore...'
                  : 'Extrair Streams Diretos para Cloud Firestore'}
              </button>
            )}
          </div>

          {/* Right Panel: Live Target Preview OR Real Extraction Report */}
          <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111827] p-6 flex flex-col space-y-4">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-100">
                {syncSummary
                  ? 'Resumo da Sincronização Completa'
                  : embedReport
                    ? 'Relatório da Extração Real'
                    : embedSubMode === 'sync_all'
                      ? 'Como Funciona a Fonte Principal'
                      : 'Alvos Prontos para Extração'}
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">
                {syncSummary
                  ? 'Catálogos sincronizados página a página no Cloud Firestore'
                  : embedReport
                    ? 'Resultado real de varredura HTML, iframes e scripts por URL'
                    : embedSubMode === 'sync_all'
                      ? 'Importação massiva contínua de filmes, séries e episódios'
                      : 'URLs resolvidas pelo template antes de iniciar a extração'}
              </p>
            </div>

            {syncSummary ? (
              <div className="space-y-4 flex-1">
                <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-center tabular-nums">
                  <div>
                    <div className="font-display text-lg font-bold text-slate-100">
                      {syncSummary.moviesCount}
                    </div>
                    <div className="text-[11px] text-slate-400">Filmes</div>
                  </div>
                  <div>
                    <div className="font-display text-lg font-bold text-slate-100">
                      {syncSummary.seriesCount}
                    </div>
                    <div className="text-[11px] text-slate-400">Séries</div>
                  </div>
                  <div>
                    <div className="font-display text-lg font-bold text-blue-400">
                      {syncSummary.episodesCount}
                    </div>
                    <div className="text-[11px] text-slate-400">Episódios</div>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3.5 text-xs space-y-2">
                  <div className="flex items-center justify-between tabular-nums">
                    <span className="text-slate-400">Páginas concluídas:</span>
                    <span className="font-mono font-semibold text-slate-100">{syncSummary.pagesCompleted}</span>
                  </div>
                  <div className="flex items-center justify-between tabular-nums">
                    <span className="text-slate-400">Fontes gravadas no Firebase:</span>
                    <span className="font-mono font-semibold text-emerald-400">{syncSummary.savedCount}</span>
                  </div>
                  <div className="flex items-center justify-between tabular-nums">
                    <span className="text-slate-400">Streams diretos extraídos:</span>
                    <span className="font-mono font-semibold text-emerald-400">{syncSummary.directExtractedCount}</span>
                  </div>
                  <div className="flex items-center justify-between tabular-nums">
                    <span className="text-slate-400">Fontes via Embed Principal:</span>
                    <span className="font-mono font-semibold text-blue-400">{syncSummary.embedFallbackCount}</span>
                  </div>
                  <p className="border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-300">
                    {syncSummary.providerProbeMessage}
                  </p>
                </div>
              </div>
            ) : embedReport ? (
              <div className="space-y-4 flex-1">
                <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-center tabular-nums">
                  <div>
                    <div className="font-display text-lg font-bold text-emerald-400">
                      {embedReport.extractedDirectCount}
                    </div>
                    <div className="text-[11px] text-slate-400">Diretos (.m3u8/mp4)</div>
                  </div>
                  <div>
                    <div className="font-display text-lg font-bold text-amber-400">
                      {embedReport.fallbackCount}
                    </div>
                    <div className="text-[11px] text-slate-400">Fallback Embed</div>
                  </div>
                  <div>
                    <div className="font-display text-lg font-bold text-red-400">
                      {embedReport.failedCount}
                    </div>
                    <div className="text-[11px] text-slate-400">Bloqueados/Vazios</div>
                  </div>
                </div>

                <div className="max-h-80 overflow-y-auto divide-y divide-slate-800 rounded-lg border border-slate-800 bg-[#0B0F17]">
                  {embedReport.results.map((r, idx) => (
                    <div key={idx} className="p-3 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-100 truncate">
                          {r.title}
                          {r.type === 'tv'
                            ? ` · T${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`
                            : ''}
                        </span>
                        <span
                          className={`font-mono text-[11px] shrink-0 ${
                            r.status === 'extracted'
                              ? 'text-emerald-400'
                              : r.status === 'fallback'
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }`}
                        >
                          {r.status === 'extracted'
                            ? 'EXTRAÍDO'
                            : r.status === 'fallback'
                              ? 'FALLBACK'
                              : 'BLOQUEADO'}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 truncate">{r.targetUrl}</div>
                      <div className="text-[11px] text-slate-300">{r.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : embedSubMode === 'sync_all' ? (
              <div className="flex-1 rounded-lg border border-slate-800 bg-[#0B0F17] p-4 text-xs text-slate-300 space-y-3 leading-relaxed">
                <p>
                  <strong className="text-slate-100">1. Descoberta de Catálogos TMDB:</strong> busca dezenas de filmes (Populares, Em Alta, Bem Avaliados) e séries com temporadas e episódios reais.
                </p>
                <p>
                  <strong className="text-slate-100">2. Extração Inteligente da Origem:</strong> verifica se o provedor (<code className="text-blue-300">embedmaster.link</code> ou template customizado) expõe streams <code className="text-slate-200">.m3u8</code>/<code className="text-slate-200">.mp4</code> diretos.
                </p>
                <p>
                  <strong className="text-slate-100">3. Garantia no Player Próprio:</strong> se o provedor exigir validação no navegador (ex: Cloudflare), salva a URL da Fonte Principal como player integrado para funcionar no seu <code className="text-slate-200">/embed/movie/&#123;id&#125;</code> e <code className="text-slate-200">/embed/tv/&#123;id&#125;/&#123;s&#125;/&#123;e&#125;</code>.
                </p>
              </div>
            ) : embedSubMode === 'batch' ? (
              embedTargetsPreview.length === 0 ? (
                <div className="flex-1 flex items-center justify-center py-12 text-center text-xs text-slate-500">
                  Cole URLs de embed (ex: https://embedmaster.link/movie/550) ou IDs TMDB para visualizar os alvos detectados.
                </div>
              ) : (
                <div className="space-y-3 flex-1">
                  <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#0B0F17] px-3 py-2 text-xs tabular-nums">
                    <span className="text-slate-400">Alvos na fila (máx. 40/lote)</span>
                    <span className="font-mono font-semibold text-blue-400">{embedTargetsPreview.length}</span>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-800 rounded-lg border border-slate-800 bg-[#0B0F17]">
                    {embedTargetsPreview.map((t, i) => (
                      <div key={i} className="p-2.5 text-xs space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-slate-200">
                            {t.type === 'tv'
                              ? `SÉRIE TMDB ${t.tmdbId} · T${String(t.season).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}`
                              : `FILME TMDB ${t.tmdbId}`}
                          </span>
                          <span className="text-[11px] text-blue-400">HLS/MP4 Crawl</span>
                        </div>
                        <div className="truncate font-mono text-[11px] text-slate-500">{t.url}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            ) : (
              <div className="flex-1 rounded-lg border border-slate-800 bg-[#0B0F17] p-4 text-xs text-slate-400 space-y-2">
                <p className="text-slate-200 font-medium">Fluxo Automático TMDB:</p>
                <p>1. Carregue os episódios da série ou a lista de filmes populares do TMDB.</p>
                <p>2. Cada item será expandido nos templates configurados (ex: embedmaster.link/tv/&#123;id&#125;/&#123;season&#125;/&#123;episode&#125;).</p>
                <p>3. Os streams extraídos serão gravados no seu Cloud Firestore para o seu próprio player e API.</p>
              </div>
            )}
          </div>
        </form>
      )}

      {/* TAB 1: M3U */}
      {activeTab === 'm3u' && (
        <form onSubmit={handleM3uSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 space-y-4 rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Importar Playlist M3U / M3U8
                </h2>
                <p className="text-xs text-slate-400">
                  Extrai filmes, séries (S01E01 / T01E01), qualidades e idiomas direto para o Cloud Firestore.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setM3uMode('text');
                  setM3uText(getSampleM3u());
                }}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                Carregar Exemplo M3U
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <button
                type="button"
                onClick={() => setM3uMode('text')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  m3uMode === 'text' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Colar Conteúdo M3U
              </button>
              <button
                type="button"
                onClick={() => setM3uMode('url')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  m3uMode === 'url' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Importar via URL Remota
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="m3u-source-name" className="block text-xs font-medium text-slate-400 mb-1">
                  Nome da Origem
                </label>
                <input
                  id="m3u-source-name"
                  type="text"
                  value={m3uSourceName}
                  onChange={(e) => setM3uSourceName(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={m3uEnrichTmdb}
                    onChange={(e) => setM3uEnrichTmdb(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-blue-600"
                  />
                  Enriquecer metadados via TMDB {hasTmdbAccess ? '(Chave Ativa)' : '(Sem chave TMDB)'}
                </label>
              </div>
            </div>

            {m3uMode === 'url' ? (
              <div>
                <label htmlFor="m3u-url-input" className="block text-xs font-medium text-slate-400 mb-1">
                  URL da Lista M3U / M3U8
                </label>
                <input
                  id="m3u-url-input"
                  type="url"
                  required
                  value={m3uUrl}
                  onChange={(e) => setM3uUrl(e.target.value)}
                  placeholder="https://servidor.com/playlist.m3u8"
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2.5 text-sm font-mono text-slate-100"
                />
              </div>
            ) : (
              <div>
                <label htmlFor="m3u-textarea" className="block text-xs font-medium text-slate-400 mb-1">
                  Conteúdo #EXTM3U
                </label>
                <textarea
                  id="m3u-textarea"
                  rows={10}
                  required
                  value={m3uText}
                  onChange={(e) => setM3uText(e.target.value)}
                  placeholder={`#EXTM3U\n#EXTINF:-1 group-title="Filmes" tmdb-id="550",Clube da Luta (1999) [1080p]\nhttps://cdn.exemplo.com/filme.m3u8`}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] p-3 font-mono text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? 'Extraindo e Salvando no Firebase...' : 'Extrair Lista M3U para Cloud Firestore'}
            </button>
          </div>

          {/* Live M3U Preview Panel */}
          <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111827] p-6 flex flex-col">
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Pré-visualização do Parser M3U
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Análise instantânea antes de gravar no Cloud Firestore
            </p>

            {!m3uPreview ? (
              <div className="flex-1 flex items-center justify-center py-12 text-center text-xs text-slate-500">
                Cole uma lista M3U ou clique em &ldquo;Carregar Exemplo M3U&rdquo; para visualizar os filmes e episódios detectados.
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-3 text-center tabular-nums">
                  <div>
                    <div className="font-display text-lg font-bold text-slate-100">{m3uPreview.moviesCount}</div>
                    <div className="text-[11px] text-slate-400">Filmes</div>
                  </div>
                  <div>
                    <div className="font-display text-lg font-bold text-slate-100">{m3uPreview.seriesCount}</div>
                    <div className="text-[11px] text-slate-400">Séries</div>
                  </div>
                  <div>
                    <div className="font-display text-lg font-bold text-slate-100">{m3uPreview.episodesCount}</div>
                    <div className="text-[11px] text-slate-400">Episódios</div>
                  </div>
                </div>

                <div className="max-h-72 overflow-y-auto divide-y divide-slate-800 rounded-lg border border-slate-800 bg-[#0B0F17]">
                  {m3uPreview.entries.map((entry, i) => (
                    <div key={i} className="p-3 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-100 truncate">{entry.cleanTitle}</span>
                        <span className="font-mono text-[11px] text-blue-400 shrink-0">
                          {entry.type === 'tv'
                            ? `T${String(entry.season ?? 1).padStart(2, '0')}E${String(entry.episode ?? 1).padStart(2, '0')}`
                            : 'FILME'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 tabular-nums">
                        <span>{entry.quality}</span>
                        <span aria-hidden="true">·</span>
                        <span>{entry.format.toUpperCase()}</span>
                        <span aria-hidden="true">·</span>
                        <span>{entry.language}</span>
                        {entry.tmdbId && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">TMDB {entry.tmdbId}</span>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </form>
      )}

      {/* TAB 2: EXTERNAL API */}
      {activeTab === 'external' && (
        <form onSubmit={handleExternalSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 space-y-4 rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Extrair de API Externa ou Feed JSON
                </h2>
                <p className="text-xs text-slate-400">
                  Conecte qualquer API JSON de terceiros, mapeie os campos e importe tudo para o Cloud Firestore.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setExtMode('json');
                  setExtJson(getSampleJson());
                }}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                Carregar Exemplo JSON
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <button
                type="button"
                onClick={() => setExtMode('json')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  extMode === 'json' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Colar JSON
              </button>
              <button
                type="button"
                onClick={() => setExtMode('url')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  extMode === 'url' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Consultar Endpoint HTTP
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="ext-source-name" className="block text-xs font-medium text-slate-400 mb-1">
                  Nome do Provedor
                </label>
                <input
                  id="ext-source-name"
                  type="text"
                  value={extSourceName}
                  onChange={(e) => setExtSourceName(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="ext-default-type" className="block text-xs font-medium text-slate-400 mb-1">
                  Tipo Padrão (se omitido)
                </label>
                <select
                  id="ext-default-type"
                  value={extDefaultType}
                  onChange={(e) => setExtDefaultType(e.target.value === 'tv' ? 'tv' : 'movie')}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                >
                  <option value="movie">Filme</option>
                  <option value="tv">Série</option>
                </select>
              </div>
            </div>

            {extMode === 'url' ? (
              <div className="space-y-3">
                <div>
                  <label htmlFor="ext-url-input" className="block text-xs font-medium text-slate-400 mb-1">
                    URL da API Externa (GET JSON)
                  </label>
                  <input
                    id="ext-url-input"
                    type="url"
                    required
                    value={extUrl}
                    onChange={(e) => setExtUrl(e.target.value)}
                    placeholder="https://api.provedor-externo.com/v1/catalogo"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2.5 text-sm font-mono text-slate-100"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="ext-auth-name" className="block text-xs font-medium text-slate-400 mb-1">
                      Header Auth (opcional)
                    </label>
                    <input
                      id="ext-auth-name"
                      type="text"
                      value={extAuthHeaderName}
                      onChange={(e) => setExtAuthHeaderName(e.target.value)}
                      placeholder="Authorization ou x-api-key"
                      className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
                    />
                  </div>
                  <div>
                    <label htmlFor="ext-auth-val" className="block text-xs font-medium text-slate-400 mb-1">
                      Valor do Token / Chave
                    </label>
                    <input
                      id="ext-auth-val"
                      type="text"
                      value={extAuthHeaderValue}
                      onChange={(e) => setExtAuthHeaderValue(e.target.value)}
                      placeholder="Bearer ..."
                      className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="ext-json-textarea" className="block text-xs font-medium text-slate-400 mb-1">
                  Payload JSON da Fonte Externa
                </label>
                <textarea
                  id="ext-json-textarea"
                  rows={9}
                  required
                  value={extJson}
                  onChange={(e) => setExtJson(e.target.value)}
                  placeholder='{"results": [{"title": "Filme", "tmdb_id": 550, "stream_url": "https://..."}]}'
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] p-3 font-mono text-xs text-slate-100"
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={extEnrichTmdb}
                onChange={(e) => setExtEnrichTmdb(e.target.checked)}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-blue-600"
              />
              Completar sinopse, pôster e gêneros automaticamente pelo TMDB
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? 'Extraindo e Salvando no Firebase...' : 'Extrair da API Externa para Cloud Firestore'}
            </button>
          </div>

          {/* Field Mapping + Live JSON Preview */}
          <div className="lg:col-span-5 space-y-4 rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-100">
                Mapeamento de Campos JSON
              </h3>
              <p className="text-xs text-slate-400">
                Adapte os nomes de chaves caso a API externa use estrutura diferente
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label htmlFor="map-items-path" className="block text-slate-400 mb-1">
                  Caminho da Lista (ex: data.items)
                </label>
                <input
                  id="map-items-path"
                  type="text"
                  value={extMapping.itemsPath}
                  onChange={(e) => setExtMapping({ ...extMapping, itemsPath: e.target.value })}
                  placeholder="auto (results, data...)"
                  className="w-full rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="map-title" className="block text-slate-400 mb-1">
                  Campo Título
                </label>
                <input
                  id="map-title"
                  type="text"
                  value={extMapping.titleField}
                  onChange={(e) => setExtMapping({ ...extMapping, titleField: e.target.value })}
                  className="w-full rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="map-tmdb" className="block text-slate-400 mb-1">
                  Campo TMDB ID
                </label>
                <input
                  id="map-tmdb"
                  type="text"
                  value={extMapping.tmdbIdField}
                  onChange={(e) => setExtMapping({ ...extMapping, tmdbIdField: e.target.value })}
                  className="w-full rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="map-stream" className="block text-slate-400 mb-1">
                  Campo Stream URL
                </label>
                <input
                  id="map-stream"
                  type="text"
                  value={extMapping.streamUrlField}
                  onChange={(e) => setExtMapping({ ...extMapping, streamUrlField: e.target.value })}
                  className="w-full rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1.5 font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="border-t border-slate-800 pt-4">
              <div className="text-xs font-medium text-slate-300 mb-2">
                Prévia de Extração ({jsonPreview?.items.length ?? 0} válidos)
              </div>
              {jsonPreview && jsonPreview.items.length > 0 ? (
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-800 rounded-lg border border-slate-800 bg-[#0B0F17]">
                  {jsonPreview.items.map((item, idx) => (
                    <div key={idx} className="p-2.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-100">{item.title}</span>
                        <span className="font-mono text-[11px] text-blue-400">
                          TMDB {item.tmdbId || 'Auto'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400 truncate">
                        {item.type.toUpperCase()} · {item.quality} · {item.streamUrl}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-4 text-center text-xs text-slate-500">
                  Cole um JSON ou clique em &ldquo;Carregar Exemplo JSON&rdquo; para validar o mapeamento.
                </div>
              )}
            </div>
          </div>
        </form>
      )}

      {/* TAB 3: MANUAL + TMDB */}
      {activeTab === 'manual' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* TMDB Search Box */}
          <div className="lg:col-span-5 space-y-4 rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Buscar no TMDB
              </h2>
              <p className="text-xs text-slate-400">
                Localize filmes ou séries no TMDB para preencher ID, sinopse e pôster automaticamente.
              </p>
            </div>

            <form onSubmit={handleTmdbSearch} className="space-y-3">
              <div className="flex gap-2">
                <select
                  aria-label="Tipo na busca TMDB"
                  value={tmdbSearchType}
                  onChange={(e) => setTmdbSearchType(e.target.value === 'tv' ? 'tv' : 'movie')}
                  className="rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
                >
                  <option value="movie">Filme</option>
                  <option value="tv">Série</option>
                </select>
                <input
                  type="search"
                  value={tmdbQuery}
                  onChange={(e) => setTmdbQuery(e.target.value)}
                  placeholder="Nome do filme ou série..."
                  aria-label="Nome do filme ou série no TMDB"
                  className="flex-1 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                />
                <button
                  type="submit"
                  disabled={tmdbSearching}
                  aria-label="Pesquisar TMDB"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700"
                >
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                  {tmdbSearching ? '...' : 'Buscar'}
                </button>
              </div>
            </form>

            <div className="max-h-96 overflow-y-auto divide-y divide-slate-800 rounded-lg border border-slate-800 bg-[#0B0F17]">
              {tmdbResults.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  {hasTmdbAccess
                    ? 'Digite um título acima para buscar metadados oficiais no TMDB.'
                    : 'Você pode preencher o formulário ao lado diretamente com o TMDB ID ou configurar sua chave TMDB em Chaves API & Conta.'}
                </div>
              ) : (
                tmdbResults.map((r) => (
                  <div key={r.tmdbId} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-slate-100">{r.title}</div>
                      <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                        TMDB {r.tmdbId} {r.releaseYear ? `· ${r.releaseYear}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => applyTmdbResult(r)}
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 shrink-0"
                    >
                      Selecionar
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Direct Registration Form */}
          <form onSubmit={handleManualSubmit} className="lg:col-span-7 space-y-4 rounded-xl border border-slate-800 bg-[#111827] p-6">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Cadastrar Título & Fonte Própria
            </h2>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="manual-tmdb-id" className="block text-xs font-medium text-slate-400 mb-1">
                  TMDB ID
                </label>
                <input
                  id="manual-tmdb-id"
                  type="number"
                  value={manualTmdbId}
                  onChange={(e) => setManualTmdbId(e.target.value)}
                  placeholder="Ex: 550"
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm font-mono text-slate-100 tabular-nums"
                />
              </div>
              <div>
                <label htmlFor="manual-type" className="block text-xs font-medium text-slate-400 mb-1">
                  Tipo
                </label>
                <select
                  id="manual-type"
                  value={manualType}
                  onChange={(e) => setManualType(e.target.value === 'tv' ? 'tv' : 'movie')}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                >
                  <option value="movie">Filme</option>
                  <option value="tv">Série</option>
                </select>
              </div>
              <div>
                <label htmlFor="manual-year" className="block text-xs font-medium text-slate-400 mb-1">
                  Ano
                </label>
                <input
                  id="manual-year"
                  type="number"
                  value={manualYear}
                  onChange={(e) => setManualYear(e.target.value)}
                  placeholder="2025"
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm font-mono text-slate-100 tabular-nums"
                />
              </div>
            </div>

            <div>
              <label htmlFor="manual-title" className="block text-xs font-medium text-slate-400 mb-1">
                Título (obrigatório se não houver chave TMDB)
              </label>
              <input
                id="manual-title"
                type="text"
                required={!manualTmdbId || !hasTmdbAccess}
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Ex: Clube da Luta"
                className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="manual-stream-url" className="block text-xs font-medium text-slate-400 mb-1">
                URL do Stream Próprio (.m3u8, .mp4)
              </label>
              <input
                id="manual-stream-url"
                type="text"
                required
                value={manualStreamUrl}
                onChange={(e) => setManualStreamUrl(e.target.value)}
                placeholder="https://cdn.seudominio.com/filmes/550/master.m3u8"
                className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm font-mono text-slate-100"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label htmlFor="manual-quality" className="block text-xs font-medium text-slate-400 mb-1">
                  Qualidade
                </label>
                <select
                  id="manual-quality"
                  value={manualQuality}
                  onChange={(e) => setManualQuality(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100"
                >
                  <option value="4K">4K</option>
                  <option value="1080p">1080p</option>
                  <option value="720p">720p</option>
                </select>
              </div>
              <div>
                <label htmlFor="manual-language" className="block text-xs font-medium text-slate-400 mb-1">
                  Idioma
                </label>
                <select
                  id="manual-language"
                  value={manualLanguage}
                  onChange={(e) => setManualLanguage(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100"
                >
                  <option value="PT-BR">PT-BR</option>
                  <option value="DUAL">Dual Áudio</option>
                  <option value="LEG">Legendado</option>
                </select>
              </div>
              {manualType === 'tv' && (
                <>
                  <div>
                    <label htmlFor="manual-season" className="block text-xs font-medium text-slate-400 mb-1">
                      Temporada
                    </label>
                    <input
                      id="manual-season"
                      type="number"
                      min={1}
                      value={manualSeason}
                      onChange={(e) => setManualSeason(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100 tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor="manual-episode" className="block text-xs font-medium text-slate-400 mb-1">
                      Episódio
                    </label>
                    <input
                      id="manual-episode"
                      type="number"
                      min={1}
                      value={manualEpisode}
                      onChange={(e) => setManualEpisode(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100 tabular-nums"
                    />
                  </div>
                </>
              )}
            </div>

            <div>
              <label htmlFor="manual-overview" className="block text-xs font-medium text-slate-400 mb-1">
                Sinopse (opcional)
              </label>
              <textarea
                id="manual-overview"
                rows={2}
                value={manualOverview}
                onChange={(e) => setManualOverview(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? 'Salvando no Cloud Firestore...' : 'Salvar no Cloud Firestore'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

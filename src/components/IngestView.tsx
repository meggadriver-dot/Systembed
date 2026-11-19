import { useMemo, useState } from 'react';
import { FileCode2, Globe, Film, CheckCircle2, AlertCircle, Search, LogIn } from 'lucide-react';
import { parseM3uPlaylist } from '../utils/m3uParser';
import {
  DEFAULT_EXTERNAL_MAPPING,
  extractFromExternalPayload,
  generateDeterministicTmdbFallback,
  type ExternalFieldMapping,
} from '../utils/externalExtractor';
import { saveIngestedBatchToFirestore, type IngestEntryPayload } from '../services/firestoreCatalog';
import type { MediaType, TmdbSearchResult, UserProfile } from '../types/media';

interface IngestViewProps {
  user: UserProfile | null;
  tmdbApiKey: string;
  tmdbConfigured: boolean;
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
  onGoToCatalog,
  onSignInGoogle,
}: IngestViewProps) {
  const [activeTab, setActiveTab] = useState<'m3u' | 'external' | 'manual'>('m3u');

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
            setActiveTab('m3u');
            setFeedback(null);
          }}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
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
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
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
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
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

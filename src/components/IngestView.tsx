import { useMemo, useState } from 'react';
import { FileCode2, Globe, Film, CheckCircle2, AlertCircle, Search } from 'lucide-react';
import { parseM3uPlaylist } from '../utils/m3uParser';
import {
  DEFAULT_EXTERNAL_MAPPING,
  extractFromExternalPayload,
  type ExternalFieldMapping,
} from '../utils/externalExtractor';
import type { MediaType, TmdbSearchResult } from '../types/media';

interface IngestViewProps {
  tmdbConfigured: boolean;
  onIngestSuccess: () => void;
  onGoToCatalog: () => void;
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

export function IngestView({ tmdbConfigured, onIngestSuccess, onGoToCatalog }: IngestViewProps) {
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
    setFeedback(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/ingest/m3u', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          m3uUrl: m3uMode === 'url' ? m3uUrl.trim() : undefined,
          m3uContent: m3uMode === 'text' ? m3uText : undefined,
          sourceName: m3uSourceName,
          enrichWithTmdb: m3uEnrichTmdb,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'error', title: data.error || 'Erro ao extrair lista M3U.', details: [] });
        return;
      }
      setFeedback({
        type: 'success',
        title: `Extração concluída: ${data.importedCount} stream(s) salvos no banco próprio`,
        details: data.logs || [],
      });
      onIngestSuccess();
    } catch {
      setFeedback({ type: 'error', title: 'Falha de comunicação com o servidor.', details: [] });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleExternalSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/ingest/external-api', {
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
      setFeedback({
        type: 'success',
        title: `Extração concluída: ${data.importedCount} stream(s) gravados no banco próprio`,
        details: data.logs || [],
      });
      onIngestSuccess();
    } catch {
      setFeedback({ type: 'error', title: 'Erro ao conectar com o servidor.', details: [] });
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
        `/api/tmdb/search?q=${encodeURIComponent(tmdbQuery.trim())}&type=${tmdbSearchType}`
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
    setFeedback(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tmdbId: manualTmdbId ? Number(manualTmdbId) : undefined,
          type: manualType,
          title: manualTitle.trim(),
          releaseYear: manualYear ? Number(manualYear) : null,
          overview: manualOverview.trim(),
          posterUrl: manualPoster.trim(),
          streamUrl: manualStreamUrl.trim(),
          quality: manualQuality,
          language: manualLanguage,
          season: manualType === 'tv' ? Number(manualSeason) : null,
          episode: manualType === 'tv' ? Number(manualEpisode) : null,
          enrichFromTmdb: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'error', title: data.error || 'Erro ao cadastrar título.', details: [] });
        return;
      }
      setManualStreamUrl('');
      setFeedback({
        type: 'success',
        title: `"${data.item.title}" salvo no banco próprio (TMDB ${data.item.tmdbId})`,
        details: ['O título já está disponível na sua API REST e nos endpoints /embed/.'],
      });
      onIngestSuccess();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
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
                  Extrai filmes, séries (S01E01 / T01E01), qualidades e idiomas direto para o banco próprio.
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
                  Enriquecer metadados via TMDB {tmdbConfigured ? '(Chave Ativa)' : '(Sem chave TMDB)'}
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
              {submitting ? 'Extraindo para Banco Próprio...' : 'Extrair Lista M3U para Banco Próprio'}
            </button>
          </div>

          {/* Live M3U Preview Panel */}
          <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111827] p-6 flex flex-col">
            <h3 className="font-display text-sm font-semibold text-slate-100">
              Pré-visualização do Parser M3U
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Análise instantânea antes de gravar no banco de dados
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
                  Conecte qualquer API JSON de terceiros, mapeie os campos e importe tudo para seu banco próprio.
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
              {submitting ? 'Extraindo e Salvando...' : 'Extrair da API Externa para Banco Próprio'}
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
                  {tmdbConfigured
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
                required={!manualTmdbId || !tmdbConfigured}
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
                type="url"
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
              {submitting ? 'Salvando...' : 'Salvar no Banco Próprio'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

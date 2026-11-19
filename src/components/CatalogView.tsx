import { useState } from 'react';
import {
  Search,
  Play,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  X,
  ExternalLink,
} from 'lucide-react';
import type { MediaItemRecord, MediaType } from '../types/media';
import { MediaPoster } from './MediaPoster';

interface CatalogViewProps {
  items: MediaItemRecord[];
  loading: boolean;
  onRefresh: () => void;
  onSelectForEmbed: (item: MediaItemRecord, season?: number, episode?: number) => void;
  onNavigateIngest: () => void;
}

export function CatalogView({
  items,
  loading,
  onRefresh,
  onSelectForEmbed,
  onNavigateIngest,
}: CatalogViewProps) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | MediaType>('all');
  const [selectedItem, setSelectedItem] = useState<MediaItemRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Add Source Form inside Drawer
  const [newStreamUrl, setNewStreamUrl] = useState('');
  const [newQuality, setNewQuality] = useState('1080p');
  const [newLanguage, setNewLanguage] = useState('PT-BR');
  const [newSeason, setNewSeason] = useState('1');
  const [newEpisode, setNewEpisode] = useState('1');
  const [newEpTitle, setNewEpTitle] = useState('');
  const [savingSource, setSavingSource] = useState(false);
  const [checkingSourceId, setCheckingSourceId] = useState<number | null>(null);
  const [drawerError, setDrawerError] = useState('');

  const filtered = items.filter((item) => {
    if (typeFilter !== 'all' && item.type !== typeFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      String(item.tmdbId).includes(q) ||
      (item.originalTitle && item.originalTitle.toLowerCase().includes(q))
    );
  });

  async function openInspector(id: number) {
    setDetailLoading(true);
    setDrawerError('');
    try {
      const res = await fetch(`/api/media/${id}`);
      const data = await res.json();
      if (res.ok && data.item) {
        setSelectedItem(data.item);
      }
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleAddSource(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedItem) return;
    setDrawerError('');
    if (!/^https?:\/\/.+/i.test(newStreamUrl.trim())) {
      setDrawerError('Informe uma URL HTTP/HTTPS válida (.m3u8 ou .mp4).');
      return;
    }

    setSavingSource(true);
    try {
      const res = await fetch(`/api/media/${selectedItem.id}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamUrl: newStreamUrl.trim(),
          quality: newQuality,
          language: newLanguage,
          season: selectedItem.type === 'tv' ? Number(newSeason) : null,
          episode: selectedItem.type === 'tv' ? Number(newEpisode) : null,
          episodeTitle: selectedItem.type === 'tv' ? newEpTitle.trim() || `Episódio ${newEpisode}` : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDrawerError(data.error || 'Falha ao adicionar fonte.');
        return;
      }
      setNewStreamUrl('');
      setNewEpTitle('');
      await openInspector(selectedItem.id);
      onRefresh();
    } finally {
      setSavingSource(false);
    }
  }

  async function handleCheckSource(sourceId: number) {
    if (!selectedItem) return;
    setCheckingSourceId(sourceId);
    try {
      await fetch(`/api/sources/${sourceId}/check`, { method: 'POST' });
      await openInspector(selectedItem.id);
    } finally {
      setCheckingSourceId(null);
    }
  }

  async function handleDeleteSource(sourceId: number) {
    if (!selectedItem) return;
    await fetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
    await openInspector(selectedItem.id);
    onRefresh();
  }

  async function handleDeleteMedia(mediaId: number) {
    await fetch(`/api/media/${mediaId}`, { method: 'DELETE' });
    setSelectedItem(null);
    onRefresh();
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-[#111827] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por título ou TMDB ID..."
              aria-label="Buscar por título ou TMDB ID"
              className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1 border border-slate-800">
            {(['all', 'movie', 'tv'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setTypeFilter(tab)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  typeFilter === tab
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {tab === 'all' ? 'Todos' : tab === 'movie' ? 'Filmes' : 'Séries'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Atualizar catálogo"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Atualizar
          </button>
          <button
            type="button"
            onClick={onNavigateIngest}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Adicionar / Extrair
          </button>
        </div>
      </div>

      {/* Catalog Grid */}
      {loading && items.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-80 animate-pulse rounded-xl border border-slate-800 bg-[#111827]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#111827] py-16 px-6 text-center">
          <h3 className="font-display text-base font-semibold text-slate-100">
            Nenhum conteúdo encontrado no banco próprio
          </h3>
          <p className="mt-1 text-sm text-slate-400">
            Ajuste os filtros ou importe novos filmes e séries de listas M3U, APIs externas ou TMDB.
          </p>
          <button
            type="button"
            onClick={onNavigateIngest}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Extrair Conteúdos Agora
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="catalog-grid">
          {filtered.map((item) => (
            <article
              key={item.id}
              className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#111827] transition-colors hover:border-slate-700"
            >
              <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-950">
                <MediaPoster
                  src={item.posterUrl}
                  title={item.title}
                  type={item.type}
                  tmdbId={item.tmdbId}
                  className="h-full w-full"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#111827] via-[#111827]/75 to-transparent" />
                <div className="absolute bottom-3 left-3.5 right-3.5">
                  <div className="text-[11px] font-medium text-slate-300 tabular-nums">
                    {item.type === 'tv' ? 'Série' : 'Filme'}
                    {item.releaseYear ? ` · ${item.releaseYear}` : ''}
                    {item.rating ? ` · ★ ${item.rating}` : ''}
                  </div>
                  <h3 className="mt-0.5 truncate font-display text-base font-bold text-white">
                    {item.title}
                  </h3>
                </div>
              </div>

              <div className="flex flex-1 flex-col justify-between p-4 gap-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-slate-400 tabular-nums">
                    <span className="font-mono">TMDB {item.tmdbId}</span>
                    <span>{item.sourcesCount ?? 0} fonte(s)</span>
                  </div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">
                    {item.overview || 'Conteúdo indexado no banco próprio CineVault.'}
                  </p>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => openInspector(item.id)}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 whitespace-nowrap"
                  >
                    Fontes & Detalhes
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectForEmbed(item)}
                    aria-label={`Abrir embed de ${item.title}`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    Embed
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Inspector Modal / Slide-over */}
      {selectedItem && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-label={`Detalhes de ${selectedItem.title}`}
        >
          <div className="flex h-full w-full max-w-2xl flex-col border-l border-slate-800 bg-[#0F1520] shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <div className="min-w-0">
                <div className="text-xs font-mono text-slate-400 tabular-nums">
                  {selectedItem.type === 'tv' ? 'SÉRIE' : 'FILME'} · TMDB {selectedItem.tmdbId}
                </div>
                <h2 className="truncate font-display text-lg font-bold text-slate-50">
                  {selectedItem.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                aria-label="Fechar detalhes"
                className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {detailLoading ? (
                <div className="py-12 text-center text-sm text-slate-400">Carregando fontes...</div>
              ) : (
                <>
                  <div className="flex gap-4">
                    <MediaPoster
                      src={selectedItem.posterUrl}
                      title={selectedItem.title}
                      type={selectedItem.type}
                      tmdbId={selectedItem.tmdbId}
                      className="h-32 w-24 rounded-lg shrink-0"
                    />
                    <div className="space-y-2 text-xs text-slate-300">
                      <p className="leading-relaxed text-slate-300">
                        {selectedItem.overview || 'Sem sinopse cadastrada.'}
                      </p>
                      <div className="flex flex-wrap items-center gap-3 text-slate-400 tabular-nums">
                        {selectedItem.releaseYear && <span>Ano: {selectedItem.releaseYear}</span>}
                        {selectedItem.rating && <span>Nota: {selectedItem.rating}/10</span>}
                        <span>Origem: {selectedItem.sourceOrigin}</span>
                      </div>
                      <div className="pt-1 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const firstSource = selectedItem.sources?.[0];
                            onSelectForEmbed(
                              selectedItem,
                              firstSource?.season ?? 1,
                              firstSource?.episode ?? 1
                            );
                            setSelectedItem(null);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          Testar no Player Embed
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteMedia(selectedItem.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          Excluir Título
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Streams List */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-slate-100">
                      Fontes Armazenadas no Banco ({selectedItem.sources?.length ?? 0})
                    </h3>
                    <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#111827]">
                      {(selectedItem.sources || []).length === 0 ? (
                        <div className="p-4 text-xs text-slate-400">
                          Nenhuma fonte de vídeo cadastrada ainda.
                        </div>
                      ) : (
                        selectedItem.sources?.map((src) => (
                          <div key={src.id} className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                {selectedItem.type === 'tv' && (
                                  <span className="font-mono font-semibold text-blue-400 tabular-nums">
                                    T{String(src.season ?? 1).padStart(2, '0')}E{String(src.episode ?? 1).padStart(2, '0')}
                                  </span>
                                )}
                                <span className="font-medium text-slate-100">
                                  {src.quality} · {src.format.toUpperCase()} · {src.language}
                                </span>
                                <span aria-hidden="true" className="text-slate-600">·</span>
                                <span className="text-slate-400">{src.originProvider}</span>
                                <span aria-hidden="true" className="text-slate-600">·</span>
                                <span className={`inline-flex items-center gap-1 ${src.isWorking ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {src.isWorking ? (
                                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                                  ) : (
                                    <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                  )}
                                  {src.isWorking ? 'Online' : 'Offline'}
                                </span>
                              </div>
                              <div className="truncate font-mono text-[11px] text-slate-400">
                                {src.streamUrl}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleCheckSource(src.id)}
                                disabled={checkingSourceId === src.id}
                                className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                              >
                                {checkingSourceId === src.id ? 'Testando...' : 'Testar Link'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteSource(src.id)}
                                aria-label={`Remover fonte ${src.id}`}
                                className="rounded-md border border-slate-700 p-1.5 text-slate-400 hover:border-red-800 hover:text-red-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Add Source Form */}
                  <form onSubmit={handleAddSource} className="space-y-3 rounded-xl border border-slate-800 bg-[#111827] p-4">
                    <h3 className="text-sm font-semibold text-slate-100">
                      Vincular Nova Fonte Direta (MP4 / HLS .m3u8)
                    </h3>
                    {drawerError && (
                      <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                        {drawerError}
                      </div>
                    )}
                    <div>
                      <label htmlFor="drawer-stream-url" className="block text-xs font-medium text-slate-400 mb-1">
                        URL do Stream (.m3u8 ou .mp4)
                      </label>
                      <input
                        id="drawer-stream-url"
                        type="url"
                        required
                        value={newStreamUrl}
                        onChange={(e) => setNewStreamUrl(e.target.value)}
                        placeholder="https://cdn.seudominio.com/stream.m3u8"
                        className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div>
                        <label htmlFor="drawer-quality" className="block text-xs font-medium text-slate-400 mb-1">
                          Qualidade
                        </label>
                        <select
                          id="drawer-quality"
                          value={newQuality}
                          onChange={(e) => setNewQuality(e.target.value)}
                          className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100"
                        >
                          <option value="4K">4K</option>
                          <option value="1080p">1080p</option>
                          <option value="720p">720p</option>
                          <option value="480p">480p</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="drawer-language" className="block text-xs font-medium text-slate-400 mb-1">
                          Áudio / Legenda
                        </label>
                        <select
                          id="drawer-language"
                          value={newLanguage}
                          onChange={(e) => setNewLanguage(e.target.value)}
                          className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100"
                        >
                          <option value="PT-BR">PT-BR (Dublado)</option>
                          <option value="DUAL">Dual Áudio</option>
                          <option value="LEG">Legendado</option>
                          <option value="EN">Inglês</option>
                        </select>
                      </div>
                      {selectedItem.type === 'tv' && (
                        <>
                          <div>
                            <label htmlFor="drawer-season" className="block text-xs font-medium text-slate-400 mb-1">
                              Temporada
                            </label>
                            <input
                              id="drawer-season"
                              type="number"
                              min={1}
                              value={newSeason}
                              onChange={(e) => setNewSeason(e.target.value)}
                              className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100 tabular-nums"
                            />
                          </div>
                          <div>
                            <label htmlFor="drawer-episode" className="block text-xs font-medium text-slate-400 mb-1">
                              Episódio
                            </label>
                            <input
                              id="drawer-episode"
                              type="number"
                              min={1}
                              value={newEpisode}
                              onChange={(e) => setNewEpisode(e.target.value)}
                              className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-2.5 py-2 text-xs text-slate-100 tabular-nums"
                            />
                          </div>
                        </>
                      )}
                    </div>
                    {selectedItem.type === 'tv' && (
                      <div>
                        <label htmlFor="drawer-ep-title" className="block text-xs font-medium text-slate-400 mb-1">
                          Nome do Episódio (opcional)
                        </label>
                        <input
                          id="drawer-ep-title"
                          type="text"
                          value={newEpTitle}
                          onChange={(e) => setNewEpTitle(e.target.value)}
                          placeholder="Ex: O Início"
                          className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
                        />
                      </div>
                    )}
                    <button
                      type="submit"
                      disabled={savingSource}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                    >
                      {savingSource ? 'Salvando...' : 'Adicionar Fonte ao Banco'}
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

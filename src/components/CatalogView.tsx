import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Play,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  X,
  ExternalLink,
  CloudUpload,
  Loader2,
} from 'lucide-react';
import type {
  MediaItemRecord,
  MediaSourceRecord,
  MediaType,
  TmdbSearchResult,
  UserProfile,
} from '../types/media';
import { MediaPoster } from './MediaPoster';
import {
  addSourceToMedia,
  deleteMediaItem,
  deleteSourceFromMedia,
  getMediaItemWithSources,
  saveIngestedBatchToFirestore,
  updateSourceHealth,
  type IngestEntryPayload,
} from '../services/firestoreCatalog';
import {
  apiSearchResultsToMediaItems,
  buildFallbackEmbedSources,
  mergeCatalogSources,
} from '../utils/catalogMerge';

interface CatalogViewProps {
  user: UserProfile | null;
  items: MediaItemRecord[];
  firestoreIds: Set<string>;
  firestoreCount: number;
  tmdbApiKey: string;
  loading: boolean;
  apiPage: number;
  apiHasMore: boolean;
  apiLoadingMore: boolean;
  onLoadMoreApi: () => void;
  onSelectForEmbed: (item: MediaItemRecord, season?: number, episode?: number) => void;
  onNavigateIngest: () => void;
  onSignInGoogle: () => void;
}

export function CatalogView({
  user,
  items,
  firestoreIds,
  firestoreCount,
  tmdbApiKey,
  loading,
  apiPage,
  apiHasMore,
  apiLoadingMore,
  onLoadMoreApi,
  onSelectForEmbed,
  onNavigateIngest,
  onSignInGoogle,
}: CatalogViewProps) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | MediaType>('all');
  const [visibleCount, setVisibleCount] = useState(48);

  // Live API search state
  const [apiSearchItems, setApiSearchItems] = useState<MediaItemRecord[]>([]);
  const [searchingApi, setSearchingApi] = useState(false);

  // Batch / single Firestore persistence feedback
  const [savingToFirebase, setSavingToFirebase] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState('');

  // Inspector Drawer
  const [selectedItem, setSelectedItem] = useState<MediaItemRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tvSeasons, setTvSeasons] = useState<Array<{ seasonNumber: number; name: string }>>([]);
  const [selectedTvSeason, setSelectedTvSeason] = useState<number>(1);
  const [loadingSeasonEps, setLoadingSeasonEps] = useState(false);

  // Add Source Form inside Drawer
  const [newStreamUrl, setNewStreamUrl] = useState('');
  const [newQuality, setNewQuality] = useState('1080p');
  const [newLanguage, setNewLanguage] = useState('PT-BR');
  const [newSeason, setNewSeason] = useState('1');
  const [newEpisode, setNewEpisode] = useState('1');
  const [newEpTitle, setNewEpTitle] = useState('');
  const [savingSource, setSavingSource] = useState(false);
  const [checkingSourceId, setCheckingSourceId] = useState<string | null>(null);
  const [drawerError, setDrawerError] = useState('');

  // Debounced live search against EmbedMaster / TMDB public catalog
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setApiSearchItems([]);
      setSearchingApi(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchingApi(true);
      try {
        const headers: Record<string, string> = {};
        if (tmdbApiKey) headers['x-tmdb-key'] = tmdbApiKey;
        const res = await fetch(
          `/api/tmdb/search?type=${typeFilter}&q=${encodeURIComponent(q)}`,
          { headers, signal: controller.signal }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { results?: TmdbSearchResult[] };
        setApiSearchItems(apiSearchResultsToMediaItems(data.results || []));
      } catch {
        // ignore abort or transient failure
      } finally {
        setSearchingApi(false);
      }
    }, 320);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, typeFilter, tmdbApiKey]);

  const combinedCatalog = useMemo(() => {
    if (search.trim().length >= 2 && apiSearchItems.length > 0) {
      return mergeCatalogSources(items, apiSearchItems);
    }
    return items;
  }, [items, apiSearchItems, search]);

  const filtered = useMemo(() => {
    return combinedCatalog.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (
        item.title.toLowerCase().includes(q) ||
        String(item.tmdbId).includes(q) ||
        (item.originalTitle && item.originalTitle.toLowerCase().includes(q))
      );
    });
  }, [combinedCatalog, typeFilter, search]);

  const unsavedVisibleCount = useMemo(() => {
    return filtered.slice(0, visibleCount).filter((i) => !firestoreIds.has(i.id)).length;
  }, [filtered, visibleCount, firestoreIds]);

  const isSelectedPersisted = Boolean(selectedItem && firestoreIds.has(selectedItem.id));
  const canManageSelected = Boolean(
    user &&
      selectedItem &&
      isSelectedPersisted &&
      (user.role === 'admin' || user.uid === selectedItem.ownerId)
  );

  async function loadTvSeasonEpisodes(tmdbId: number, seasonNum?: number) {
    setLoadingSeasonEps(true);
    try {
      const headers: Record<string, string> = {};
      if (tmdbApiKey) headers['x-tmdb-key'] = tmdbApiKey;
      const queryStr = seasonNum ? `?season=${seasonNum}` : '';
      const res = await fetch(`/api/tmdb/tv/${tmdbId}/seasons${queryStr}`, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        title?: string;
        overview?: string;
        posterUrl?: string;
        backdropUrl?: string;
        seasons?: Array<{ seasonNumber: number; name: string }>;
        selectedSeason?: number;
        episodes?: Array<{ season: number; episode: number; episodeTitle: string }>;
      };
      if (data.seasons && data.seasons.length > 0) {
        setTvSeasons(data.seasons);
      }
      if (data.selectedSeason) {
        setSelectedTvSeason(data.selectedSeason);
      }
      return data;
    } catch {
      return null;
    } finally {
      setLoadingSeasonEps(false);
    }
  }

  async function openInspector(item: MediaItemRecord) {
    setDetailLoading(true);
    setDrawerError('');
    setTvSeasons([]);
    setSelectedTvSeason(1);
    setSelectedItem({ ...item, sources: item.sources || [] });

    try {
      if (firestoreIds.has(item.id)) {
        const persisted = await getMediaItemWithSources(item.id);
        if (persisted) {
          setSelectedItem(persisted);
          return;
        }
      }

      // Live EmbedMaster API item: populate EmbedMaster playback sources + seasons/episodes dynamically
      if (item.type === 'movie') {
        setSelectedItem({
          ...item,
          sources: buildFallbackEmbedSources('movie', item.tmdbId),
        });
      } else {
        const tvData = await loadTvSeasonEpisodes(item.tmdbId);
        const episodes = tvData?.episodes?.length
          ? tvData.episodes
          : [{ season: 1, episode: 1, episodeTitle: 'Episódio 1' }];
        setSelectedItem({
          ...item,
          title: item.title || tvData?.title || `Série TMDB #${item.tmdbId}`,
          overview: item.overview || tvData?.overview || item.overview,
          sources: buildFallbackEmbedSources('tv', item.tmdbId, episodes),
        });
      }
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : 'Erro ao carregar fontes do título.');
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleChangeTvSeason(seasonNum: number) {
    if (!selectedItem || selectedItem.type !== 'tv') return;
    setSelectedTvSeason(seasonNum);
    const tvData = await loadTvSeasonEpisodes(selectedItem.tmdbId, seasonNum);
    if (tvData?.episodes && tvData.episodes.length > 0) {
      const apiSeasonSources = buildFallbackEmbedSources('tv', selectedItem.tmdbId, tvData.episodes);
      setSelectedItem((prev) => (prev ? { ...prev, sources: apiSeasonSources } : null));
    }
  }

  async function handleSaveMediaListToFirestore(itemsToSave: MediaItemRecord[], label: string) {
    if (!user) {
      onSignInGoogle();
      return;
    }
    if (itemsToSave.length === 0) return;

    setSavingToFirebase(true);
    setCatalogNotice('');
    setDrawerError('');
    try {
      const entries: IngestEntryPayload[] = [];
      for (const item of itemsToSave) {
        const sourcesToPersist =
          item.sources && item.sources.length > 0
            ? item.sources
            : buildFallbackEmbedSources(item.type, item.tmdbId);

        for (const src of sourcesToPersist) {
          entries.push({
            tmdbId: item.tmdbId,
            imdbId: item.imdbId || '',
            type: item.type,
            title: item.title,
            originalTitle: item.originalTitle || '',
            overview: item.overview || '',
            posterUrl: item.posterUrl || '',
            backdropUrl: item.backdropUrl || item.posterUrl || '',
            releaseYear: item.releaseYear || null,
            rating: item.rating || null,
            genres: item.genres || [],
            runtime: item.runtime || null,
            sourceOrigin: 'external_api',
            season: item.type === 'tv' ? Math.max(1, src.season || 1) : 0,
            episode: item.type === 'tv' ? Math.max(1, src.episode || 1) : 0,
            episodeTitle:
              item.type === 'tv' ? src.episodeTitle || `Episódio ${src.episode || 1}` : '',
            streamUrl: src.streamUrl,
            quality: src.quality || '1080p',
            format: src.format || 'embed',
            language: src.language || 'PT-BR',
            originProvider: src.originProvider || 'EmbedMaster (API Principal)',
          });
        }
      }

      const result = await saveIngestedBatchToFirestore(user.uid, entries, {
        sourceType: 'external_api',
        sourceName: label,
        sourceUrl: 'https://embedmaster.link',
        totalFound: itemsToSave.length,
        failedCount: 0,
      });

      setCatalogNotice(
        `${itemsToSave.length} título(s) gravado(s) no Cloud Firestore (+${result.importedCount} fontes).`
      );
      if (selectedItem && itemsToSave.some((i) => i.id === selectedItem.id)) {
        const refreshed = await getMediaItemWithSources(selectedItem.id);
        if (refreshed) setSelectedItem(refreshed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao salvar títulos no Firebase.';
      setCatalogNotice(msg);
      setDrawerError(msg);
    } finally {
      setSavingToFirebase(false);
    }
  }

  async function handleAddSource(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedItem) return;
    setDrawerError('');

    if (!user) {
      setDrawerError('Conecte sua conta Google para adicionar fontes no Cloud Firestore.');
      return;
    }
    if (!isSelectedPersisted) {
      setDrawerError('Salve primeiro este título no Cloud Firestore usando o botão acima.');
      return;
    }
    if (!canManageSelected) {
      setDrawerError('Apenas o proprietário deste título ou um administrador pode adicionar fontes.');
      return;
    }

    const trimmedUrl = newStreamUrl.trim();
    if (!/^(https?:\/\/|\/demo\/).+/i.test(trimmedUrl)) {
      setDrawerError('Informe uma URL HTTP/HTTPS válida (.m3u8 ou .mp4).');
      return;
    }

    setSavingSource(true);
    try {
      await addSourceToMedia(user.uid, selectedItem, {
        streamUrl: trimmedUrl,
        quality: newQuality,
        language: newLanguage,
        season: selectedItem.type === 'tv' ? Number(newSeason) || 1 : 0,
        episode: selectedItem.type === 'tv' ? Number(newEpisode) || 1 : 0,
        episodeTitle: selectedItem.type === 'tv' ? newEpTitle.trim() || `Episódio ${newEpisode}` : '',
      });
      setNewStreamUrl('');
      setNewEpTitle('');
      await openInspector(selectedItem);
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : 'Falha ao salvar fonte no Firestore.');
    } finally {
      setSavingSource(false);
    }
  }

  async function handleCheckSource(src: MediaSourceRecord) {
    if (!selectedItem) return;
    setCheckingSourceId(src.id);
    setDrawerError('');
    try {
      const res = await fetch('/api/sources/check-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamUrl: src.streamUrl }),
      });
      const data = (await res.json()) as { isWorking?: boolean };
      const isWorking = Boolean(data.isWorking);

      if (canManageSelected && isSelectedPersisted) {
        await updateSourceHealth(selectedItem.id, src.id, isWorking);
        await openInspector(selectedItem);
      } else {
        setSelectedItem((prev) =>
          prev
            ? {
                ...prev,
                sources: prev.sources?.map((s) => (s.id === src.id ? { ...s, isWorking } : s)),
              }
            : null
        );
      }
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : 'Erro ao testar link de stream.');
    } finally {
      setCheckingSourceId(null);
    }
  }

  async function handleDeleteSource(sourceId: string) {
    if (!selectedItem || !canManageSelected) return;
    setDrawerError('');
    try {
      await deleteSourceFromMedia(selectedItem, sourceId);
      await openInspector(selectedItem);
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : 'Erro ao remover fonte.');
    }
  }

  async function handleDeleteMedia(mediaItem: MediaItemRecord) {
    if (!canManageSelected) return;
    setDrawerError('');
    try {
      await deleteMediaItem(mediaItem.id, mediaItem.status);
      setSelectedItem(null);
    } catch (err) {
      setDrawerError(err instanceof Error ? err.message : 'Erro ao excluir título.');
    }
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-[#111827] p-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar filmes ou séries na API EmbedMaster / TMDB..."
              aria-label="Buscar por título ou TMDB ID"
              className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center self-start sm:self-auto gap-1 rounded-lg bg-[#0B0F17] p-1 border border-slate-800">
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

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {unsavedVisibleCount > 0 && (
            <button
              type="button"
              onClick={() => {
                const unsaved = filtered.slice(0, visibleCount).filter((i) => !firestoreIds.has(i.id));
                handleSaveMediaListToFirestore(unsaved, 'Sincronização Direta do Catálogo');
              }}
              disabled={savingToFirebase}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              {savingToFirebase ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <CloudUpload className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
              )}
              {user ? `Salvar Lote no Firebase (${unsavedVisibleCount})` : 'Entrar para Salvar no Firebase'}
            </button>
          )}
          <button
            type="button"
            onClick={onNavigateIngest}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Importador em Massa
          </button>
        </div>
      </div>

      {/* Compact Live Catalog Status Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-400">
        <div className="tabular-nums">
          <span className="font-semibold text-slate-200">{filtered.length}</span> títulos no catálogo ·{' '}
          <span className="text-emerald-400">{firestoreCount} salvos no Firebase</span> · API EmbedMaster ativa
          (Página {apiPage})
          {searchingApi && <span className="ml-2 text-blue-400">Buscando na API...</span>}
        </div>
        {catalogNotice && <div className="text-emerald-400 font-medium">{catalogNotice}</div>}
      </div>

      {/* Catalog Grid */}
      {loading && items.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <div key={n} className="h-80 animate-pulse rounded-xl border border-slate-800 bg-[#111827]" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#111827] py-16 px-6 text-center">
          <h3 className="font-display text-base font-semibold text-slate-100">
            {searchingApi ? 'Consultando catálogo EmbedMaster / TMDB...' : 'Nenhum conteúdo encontrado para este filtro'}
          </h3>
          <p className="mt-1 text-sm text-slate-400">
            Tente outro termo de busca ou explore as páginas do catálogo principal EmbedMaster.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="catalog-grid">
            {filtered.slice(0, visibleCount).map((item) => {
              const isInFirestore = firestoreIds.has(item.id);
              return (
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
                        {item.releaseYear > 0 ? ` · ${item.releaseYear}` : ''}
                        {item.rating > 0 ? ` · ★ ${item.rating}` : ''}
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
                        <span className={isInFirestore ? 'text-emerald-400 font-medium' : 'text-blue-400 font-medium'}>
                          {isInFirestore
                            ? `Firebase · ${item.sourcesCount ?? 1} fonte(s)`
                            : 'API EmbedMaster'}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">
                        {item.overview || 'Disponível via fonte principal EmbedMaster.'}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => openInspector(item)}
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
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            {filtered.length > visibleCount && (
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + 48)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-5 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700"
              >
                Exibir mais carregados (+48)
              </button>
            )}
            {apiHasMore && !search.trim() && (
              <button
                type="button"
                onClick={() => {
                  setVisibleCount((prev) => prev + 120);
                  onLoadMoreApi();
                }}
                disabled={apiLoadingMore}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {apiLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {apiLoadingMore
                  ? `Carregando página ${apiPage + 1}...`
                  : `Carregar Mais da API (Página ${apiPage + 1})`}
              </button>
            )}
          </div>
        </>
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
                  {selectedItem.type === 'tv' ? 'SÉRIE' : 'FILME'} · TMDB {selectedItem.tmdbId} ·{' '}
                  {isSelectedPersisted ? 'Firebase Firestore' : 'API EmbedMaster'}
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
                <div className="py-12 text-center text-sm text-slate-400">
                  Carregando temporadas, episódios e fontes EmbedMaster...
                </div>
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
                        {selectedItem.overview || 'Conteúdo disponível na fonte principal EmbedMaster.'}
                      </p>
                      <div className="flex flex-wrap items-center gap-3 text-slate-400 tabular-nums">
                        {selectedItem.releaseYear > 0 && <span>Ano: {selectedItem.releaseYear}</span>}
                        {selectedItem.rating > 0 && <span>Nota: {selectedItem.rating}/10</span>}
                        <span>
                          Origem: {isSelectedPersisted ? selectedItem.sourceOrigin : 'API EmbedMaster'}
                        </span>
                      </div>
                      <div className="pt-1 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const firstSource = selectedItem.sources?.[0];
                            onSelectForEmbed(
                              selectedItem,
                              firstSource?.season || selectedTvSeason || 1,
                              firstSource?.episode || 1
                            );
                            setSelectedItem(null);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          Testar no Player Embed
                        </button>
                        {!isSelectedPersisted && (
                          <button
                            type="button"
                            onClick={() =>
                              handleSaveMediaListToFirestore(
                                [selectedItem],
                                `Importação Unitária: ${selectedItem.title}`
                              )
                            }
                            disabled={savingToFirebase}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-800/70 bg-emerald-950/40 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-60"
                          >
                            <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />
                            {user ? 'Salvar Título + Fontes no Firebase' : 'Entrar para Salvar'}
                          </button>
                        )}
                        {canManageSelected && (
                          <button
                            type="button"
                            onClick={() => handleDeleteMedia(selectedItem)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/50"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Excluir Título
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Season Switcher for API-sourced TV series */}
                  {selectedItem.type === 'tv' && !isSelectedPersisted && tvSeasons.length > 0 && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#111827] px-4 py-2.5">
                      <label htmlFor="drawer-season-select" className="text-xs font-medium text-slate-300">
                        Navegar por Temporada (EmbedMaster API)
                      </label>
                      <div className="flex items-center gap-2">
                        {loadingSeasonEps && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />}
                        <select
                          id="drawer-season-select"
                          value={selectedTvSeason}
                          onChange={(e) => handleChangeTvSeason(Number(e.target.value))}
                          className="rounded-md border border-slate-700 bg-[#0B0F17] px-2.5 py-1 text-xs text-slate-100"
                        >
                          {tvSeasons.map((s) => (
                            <option key={s.seasonNumber} value={s.seasonNumber}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Streams List */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-slate-100">
                      {isSelectedPersisted
                        ? `Fontes Armazenadas no Firestore (${selectedItem.sources?.length ?? 0})`
                        : `Links Prontos da API EmbedMaster (${selectedItem.sources?.length ?? 0})`}
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
                                    T{String(src.season || 1).padStart(2, '0')}E{String(src.episode || 1).padStart(2, '0')}
                                  </span>
                                )}
                                {src.episodeTitle && (
                                  <span className="font-medium text-slate-200">{src.episodeTitle}</span>
                                )}
                                <span className="font-medium text-slate-400">
                                  {src.quality} · {src.format.toUpperCase()} · {src.language}
                                </span>
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
                                onClick={() => {
                                  onSelectForEmbed(
                                    selectedItem,
                                    src.season || 1,
                                    src.episode || 1
                                  );
                                  setSelectedItem(null);
                                }}
                                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-500"
                              >
                                <Play className="h-3 w-3" aria-hidden="true" />
                                Embed
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCheckSource(src)}
                                disabled={checkingSourceId === src.id}
                                className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                              >
                                {checkingSourceId === src.id ? 'Testando...' : 'Testar Link'}
                              </button>
                              {canManageSelected && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSource(src.id)}
                                  aria-label={`Remover fonte ${src.id}`}
                                  className="rounded-md border border-slate-700 p-1.5 text-slate-400 hover:border-red-800 hover:text-red-400"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
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
                    {!user && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-900/60 bg-blue-950/30 px-3 py-2 text-xs text-blue-200">
                        <span>Entre com sua conta Google para editar fontes neste título.</span>
                        <button
                          type="button"
                          onClick={onSignInGoogle}
                          className="rounded bg-blue-600 px-2.5 py-1 font-semibold text-white hover:bg-blue-500"
                        >
                          Entrar com Google
                        </button>
                      </div>
                    )}
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
                        type="text"
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
                      disabled={savingSource || !canManageSelected}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                    >
                      {savingSource ? 'Salvando no Firestore...' : 'Adicionar Fonte ao Firestore'}
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

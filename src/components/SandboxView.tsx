import { useEffect, useMemo, useState } from 'react';
import { Copy, Check, ExternalLink, RefreshCw } from 'lucide-react';
import type { ApiKeyRecord, MediaItemRecord, MediaType } from '../types/media';
import { generateEmbedSnippets } from '../utils/externalExtractor';

interface SandboxViewProps {
  catalog: MediaItemRecord[];
  apiKeys: ApiKeyRecord[];
  initialMedia?: MediaItemRecord | null;
  initialSeason?: number;
  initialEpisode?: number;
}

export function SandboxView({
  catalog,
  apiKeys,
  initialMedia,
  initialSeason = 1,
  initialEpisode = 1,
}: SandboxViewProps) {
  const defaultItem = initialMedia || catalog[0] || null;
  const activeKeyDefault = apiKeys.find((k) => k.status === 'active')?.apiKey || '';

  const [selectedMediaId, setSelectedMediaId] = useState<string>(defaultItem ? defaultItem.id : '');
  const [mediaType, setMediaType] = useState<MediaType>(defaultItem?.type || 'movie');
  const [tmdbId, setTmdbId] = useState<string>(defaultItem ? String(defaultItem.tmdbId) : '157336');
  const [season, setSeason] = useState<string>(String(initialSeason));
  const [episode, setEpisode] = useState<string>(String(initialEpisode));
  const [selectedKey, setSelectedKey] = useState<string>(activeKeyDefault);
  const [playerColor, setPlayerColor] = useState<string>('#2563EB');
  const [codeTab, setCodeTab] = useState<'iframe' | 'react' | 'curl'>('iframe');
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (initialMedia) {
      setSelectedMediaId(initialMedia.id);
      setMediaType(initialMedia.type);
      setTmdbId(String(initialMedia.tmdbId));
      setSeason(String(initialSeason));
      setEpisode(String(initialEpisode));
    }
  }, [initialMedia, initialSeason, initialEpisode]);

  useEffect(() => {
    if (!selectedMediaId && !initialMedia && catalog.length > 0) {
      setSelectedMediaId(catalog[0].id);
      setMediaType(catalog[0].type);
      setTmdbId(String(catalog[0].tmdbId));
    }
  }, [catalog, selectedMediaId, initialMedia]);

  useEffect(() => {
    if (!selectedKey && apiKeys.length > 0) {
      const firstActive = apiKeys.find((k) => k.status === 'active') || apiKeys[0];
      if (firstActive) setSelectedKey(firstActive.apiKey);
    }
  }, [apiKeys, selectedKey]);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const effectiveKey = selectedKey || 'SUA_API_KEY_FIRESTORE';

  const snippets = useMemo(() => {
    const parsedTmdb = Number.parseInt(tmdbId, 10) || 157336;
    return generateEmbedSnippets({
      baseUrl: origin,
      type: mediaType,
      tmdbId: parsedTmdb,
      season: Number.parseInt(season, 10) || 1,
      episode: Number.parseInt(episode, 10) || 1,
      apiKey: effectiveKey,
      color: playerColor,
    });
  }, [origin, mediaType, tmdbId, season, episode, effectiveKey, playerColor]);

  const relativeEmbedSrc = useMemo(() => {
    const parsedTmdb = Number.parseInt(tmdbId, 10) || 157336;
    const path =
      mediaType === 'tv'
        ? `/embed/tv/${parsedTmdb}/${Number.parseInt(season, 10) || 1}/${Number.parseInt(episode, 10) || 1}`
        : `/embed/movie/${parsedTmdb}`;
    const q = new URLSearchParams();
    if (selectedKey) q.set('key', selectedKey);
    q.set('color', playerColor.replace('#', ''));
    q.set('_r', String(reloadNonce));
    return `${path}?${q.toString()}`;
  }, [mediaType, tmdbId, season, episode, selectedKey, playerColor, reloadNonce]);

  function handleSelectCatalogItem(idStr: string) {
    setSelectedMediaId(idStr);
    const found = catalog.find((c) => c.id === idStr);
    if (found) {
      setMediaType(found.type);
      setTmdbId(String(found.tmdbId));
      setSeason('1');
      setEpisode('1');
    }
  }

  function copyText(id: string, text: string) {
    navigator.clipboard?.writeText(text);
    setCopiedBlock(id);
    setTimeout(() => setCopiedBlock(null), 1800);
  }

  const activeSnippetCode =
    codeTab === 'iframe'
      ? snippets.iframeHtml
      : codeTab === 'react'
        ? snippets.reactComponent
        : snippets.curlCommand;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Controls Column */}
        <section className="lg:col-span-4 space-y-4 rounded-xl border border-slate-800 bg-[#111827] p-5">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-100">
              Gerador de Embed & Sandbox
            </h2>
            <p className="text-xs text-slate-400">
              Configure os parâmetros para testar o player direto do Cloud Firestore e copiar o código para seu site ou app.
            </p>
          </div>

          <div>
            <label htmlFor="sandbox-catalog-pick" className="block text-xs font-medium text-slate-400 mb-1">
              Selecionar do Catálogo Próprio
            </label>
            <select
              id="sandbox-catalog-pick"
              value={selectedMediaId}
              onChange={(e) => handleSelectCatalogItem(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
            >
              <option value="">Personalizado por TMDB ID</option>
              {catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  [{item.type === 'tv' ? 'SÉRIE' : 'FILME'}] {item.title} (TMDB {item.tmdbId})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sandbox-type" className="block text-xs font-medium text-slate-400 mb-1">
                Tipo
              </label>
              <select
                id="sandbox-type"
                value={mediaType}
                onChange={(e) => setMediaType(e.target.value === 'tv' ? 'tv' : 'movie')}
                className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
              >
                <option value="movie">Filme</option>
                <option value="tv">Série</option>
              </select>
            </div>
            <div>
              <label htmlFor="sandbox-tmdb-id" className="block text-xs font-medium text-slate-400 mb-1">
                TMDB ID
              </label>
              <input
                id="sandbox-tmdb-id"
                type="number"
                value={tmdbId}
                onChange={(e) => setTmdbId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100 tabular-nums"
              />
            </div>
          </div>

          {mediaType === 'tv' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="sandbox-season" className="block text-xs font-medium text-slate-400 mb-1">
                  Temporada
                </label>
                <input
                  id="sandbox-season"
                  type="number"
                  min={1}
                  value={season}
                  onChange={(e) => setSeason(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100 tabular-nums"
                />
              </div>
              <div>
                <label htmlFor="sandbox-episode" className="block text-xs font-medium text-slate-400 mb-1">
                  Episódio
                </label>
                <input
                  id="sandbox-episode"
                  type="number"
                  min={1}
                  value={episode}
                  onChange={(e) => setEpisode(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100 tabular-nums"
                />
              </div>
            </div>
          )}

          <div>
            <label htmlFor="sandbox-apikey" className="block text-xs font-medium text-slate-400 mb-1">
              Chave API (Embed Key)
            </label>
            <select
              id="sandbox-apikey"
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
            >
              {apiKeys.map((k) => (
                <option key={k.id} value={k.apiKey}>
                  {k.label} ({k.apiKey.slice(0, 14)}...)
                </option>
              ))}
              {apiKeys.length === 0 && (
                <option value="">Sem chave conectada (modo público)</option>
              )}
            </select>
          </div>

          <div>
            <label htmlFor="sandbox-color" className="block text-xs font-medium text-slate-400 mb-1">
              Cor de Destaque do Player
            </label>
            <div className="flex items-center gap-2">
              <input
                id="sandbox-color"
                type="color"
                value={playerColor}
                onChange={(e) => setPlayerColor(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-slate-700 bg-[#0B0F17] p-1"
              />
              <input
                type="text"
                aria-label="Código hexadecimal da cor"
                value={playerColor}
                onChange={(e) => setPlayerColor(e.target.value)}
                className="flex-1 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
              />
            </div>
          </div>

          <div className="pt-2 flex flex-col gap-2">
            <div className="text-xs font-medium text-slate-400">URL Direta do Embed</div>
            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0B0F17] p-2.5">
              <span className="flex-1 truncate font-mono text-[11px] text-slate-200">
                {snippets.embedUrl}
              </span>
              <button
                type="button"
                onClick={() => copyText('url', snippets.embedUrl)}
                aria-label="Copiar URL direta do embed"
                className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 shrink-0"
              >
                {copiedBlock === 'url' ? 'Copiado' : 'Copiar'}
              </button>
            </div>
          </div>
        </section>

        {/* Live Iframe Player Column */}
        <section className="lg:col-span-8 space-y-4">
          <div className="rounded-xl border border-slate-800 bg-[#111827] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-xs font-medium text-slate-200 whitespace-nowrap">
                  Prévia Real do Player
                </span>
                <span className="truncate font-mono text-[11px] text-slate-400 tabular-nums">
                  {mediaType === 'tv' ? `/embed/tv/${tmdbId}/${season}/${episode}` : `/embed/movie/${tmdbId}`}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  Recarregar
                </button>
                <a
                  href={relativeEmbedSrc}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
                >
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  Abrir Aba
                </a>
              </div>
            </div>

            <div className="aspect-video w-full bg-black">
              <iframe
                key={relativeEmbedSrc}
                src={relativeEmbedSrc}
                title="CineVault Live Embed Preview"
                className="h-full w-full border-0"
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              />
            </div>
          </div>

          {/* Code Snippet Box */}
          <div className="rounded-xl border border-slate-800 bg-[#111827] overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
              <div className="flex items-center gap-1">
                {(['iframe', 'react', 'curl'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setCodeTab(t)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      codeTab === t ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {t === 'iframe' ? 'HTML Iframe' : t === 'react' ? 'React / Next.js' : 'API JSON (cURL)'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => copyText('snippet', activeSnippetCode)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                {copiedBlock === 'snippet' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedBlock === 'snippet' ? 'Copiado' : 'Copiar Código'}
              </button>
            </div>
            <pre className="overflow-x-auto bg-[#0B0F17] p-4 font-mono text-xs leading-relaxed text-slate-200">
              <code>{activeSnippetCode}</code>
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
}

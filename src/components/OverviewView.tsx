import { ArrowUpRight, Copy, Check, Database, Film, Tv, Play, Server, KeyRound, LogIn } from 'lucide-react';
import { useState } from 'react';
import type { DashboardStats, ImportJobRecord, MediaItemRecord, UserProfile } from '../types/media';
import { MediaPoster } from './MediaPoster';

interface OverviewViewProps {
  user: UserProfile | null;
  stats: DashboardStats;
  recentMedia: MediaItemRecord[];
  importJobs: ImportJobRecord[];
  activeApiKey: string;
  onNavigate: (tab: 'catalog' | 'ingest' | 'sandbox' | 'keys' | 'docs') => void;
  onSelectMediaForEmbed: (item: MediaItemRecord) => void;
  onSignInGoogle: () => void;
}

export function OverviewView({
  user,
  stats,
  recentMedia,
  importJobs,
  activeApiKey,
  onNavigate,
  onSelectMediaForEmbed,
  onSignInGoogle,
}: OverviewViewProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://seu-dominio.com';
  const sampleItem = recentMedia[0];
  const keyQuery = activeApiKey ? `?key=${activeApiKey}` : '';
  const sampleEmbedUrl = sampleItem
    ? sampleItem.type === 'tv'
      ? `${origin}/embed/tv/${sampleItem.tmdbId}/1/1${keyQuery}`
      : `${origin}/embed/movie/${sampleItem.tmdbId}${keyQuery}`
    : `${origin}/embed/movie/157336${keyQuery}`;

  function handleCopySample() {
    navigator.clipboard?.writeText(sampleEmbedUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1800);
  }

  const metricCards = [
    {
      label: 'Filmes Disponíveis',
      value: stats.totalMovies,
      detail: 'Firestore + API EmbedMaster',
      icon: Film,
    },
    {
      label: 'Séries Disponíveis',
      value: stats.totalSeries,
      detail: 'Temporadas e episódios integrados',
      icon: Tv,
    },
    {
      label: 'Fontes / Streams Prontos',
      value: stats.totalSources,
      detail: `${stats.totalImportJobs} extração(ões) no Firebase`,
      icon: Server,
    },
    {
      label: 'Requisições Embed / API',
      value: stats.totalEmbedRequests,
      detail: `${stats.activeApiKeys} chave(s) ativa(s)`,
      icon: KeyRound,
    },
  ];

  return (
    <div className="space-y-8">
      {/* Hero Summary & Quick Actions */}
      <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 lg:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl space-y-2">
            <p className="text-xs font-medium tracking-wide text-blue-400">
              Infraestrutura Própria no Firebase Cloud Firestore & API EmbedMaster
            </p>
            <h1 className="font-display text-2xl font-bold tracking-tight text-slate-50 lg:text-3xl">
              Catálogo completo pronto para Embed e sincronização no Firebase
            </h1>
            <p className="text-sm leading-relaxed text-slate-400">
              Navegue imediatamente por filmes e séries da fonte principal EmbedMaster, teste players por TMDB ID e persista títulos e fontes diretamente no Cloud Firestore.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {!user && (
              <button
                type="button"
                onClick={onSignInGoogle}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                Entrar com Google
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('catalog')}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 ${
                user
                  ? 'bg-blue-600 text-white hover:bg-blue-500'
                  : 'border border-slate-700 bg-slate-800/70 text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Database className="h-4 w-4" aria-hidden="true" />
              Abrir Catálogo Próprio
            </button>
            <button
              type="button"
              onClick={() => onNavigate('sandbox')}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/70 px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              Testar Player Embed
            </button>
          </div>
        </div>

        {/* Quick Embed Endpoint Strip */}
        <div className="mt-6 flex flex-col gap-3 rounded-lg border border-slate-800 bg-[#0B0F17] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-400">Endpoint Embed Pronto para Uso</div>
            <div className="mt-1 truncate font-mono text-xs text-slate-200 sm:text-sm">
              {sampleEmbedUrl}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleCopySample}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 whitespace-nowrap shrink-0"
            >
              {copiedUrl ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedUrl ? 'Copiado' : 'Copiar URL'}
            </button>
            <button
              type="button"
              onClick={() => onNavigate('docs')}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap shrink-0"
            >
              Documentação
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>

      {/* KPI Metrics Row */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="rounded-xl border border-slate-800 bg-[#111827] p-5"
            >
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-xs font-medium">{card.label}</span>
                <Icon className="h-4 w-4 text-slate-500" aria-hidden="true" />
              </div>
              <div className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-50 tabular-nums">
                {card.value.toLocaleString('pt-BR')}
              </div>
              <div className="mt-1 text-xs text-slate-400">{card.detail}</div>
            </div>
          );
        })}
      </section>

      {/* Two-Column Recent Content + Import Jobs */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Recent Media */}
        <section className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#111827] p-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Catálogo Integrado (Firebase + EmbedMaster)
              </h2>
              <p className="text-xs text-slate-400">
                Clique em qualquer título para abrir o player embed correspondente
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('catalog')}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap shrink-0"
            >
              Ver todos
            </button>
          </div>

          {recentMedia.length === 0 ? (
            <div className="py-12 text-center space-y-3">
              <p className="text-sm text-slate-400">
                {user
                  ? 'Nenhum conteúdo no catálogo ainda. Use o Extrator para importar M3U ou API externa.'
                  : 'Conecte sua conta Google para inicializar o catálogo no Cloud Firestore e gerar sua API Key.'}
              </p>
              {!user && (
                <button
                  type="button"
                  onClick={onSignInGoogle}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                  Conectar com Google
                </button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-800/80">
              {recentMedia.slice(0, 5).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-4 py-3.5"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <MediaPoster
                      src={item.posterUrl}
                      title={item.title}
                      type={item.type}
                      tmdbId={item.tmdbId}
                      className="h-14 w-10 rounded-md shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-100">
                        {item.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400 tabular-nums">
                        <span>{item.type === 'tv' ? 'Série' : 'Filme'}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">TMDB {item.tmdbId}</span>
                        {item.releaseYear > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{item.releaseYear}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>{item.sourcesCount ?? 0} fonte(s)</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelectMediaForEmbed(item)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-blue-500 hover:text-white whitespace-nowrap shrink-0"
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    Abrir Embed
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent Extraction Jobs */}
        <section className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111827] p-6">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">
                Histórico de Extrações
              </h2>
              <p className="text-xs text-slate-400">
                Sincronizações de listas M3U e APIs externas
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('ingest')}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap shrink-0"
            >
              Nova extração
            </button>
          </div>

          {importJobs.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-400">
              {user
                ? 'Nenhuma importação executada nesta conta ainda.'
                : 'Entre com sua conta Google para acompanhar o histórico de extrações.'}
            </div>
          ) : (
            <div className="divide-y divide-slate-800/80">
              {importJobs.slice(0, 5).map((job) => (
                <div key={job.id} className="py-3.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-100">
                      {job.sourceName}
                    </span>
                    <span className="font-mono text-xs text-emerald-400 tabular-nums shrink-0">
                      +{job.importedCount} salvos
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400 tabular-nums">
                    <span>{job.sourceType === 'external_api' ? 'API Externa' : 'Lista M3U'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{job.totalFound} analisados</span>
                    {job.skippedCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{job.skippedCount} ignorados</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

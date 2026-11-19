import { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Film,
  Download,
  PlaySquare,
  KeyRound,
  BookOpen,
  Menu,
  X,
  UserCheck,
} from 'lucide-react';
import type {
  ApiKeyRecord,
  DashboardStats,
  ImportJobRecord,
  MediaItemRecord,
  PlatformSettings,
  UserProfile,
} from './types/media';
import { OverviewView } from './components/OverviewView';
import { CatalogView } from './components/CatalogView';
import { IngestView } from './components/IngestView';
import { SandboxView } from './components/SandboxView';
import { ApiKeysView } from './components/ApiKeysView';
import { ApiDocsView } from './components/ApiDocsView';

type TabId = 'overview' | 'catalog' | 'ingest' | 'sandbox' | 'keys' | 'docs';

const NAV_ITEMS: Array<{ id: TabId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Visão Geral', icon: LayoutDashboard },
  { id: 'catalog', label: 'Catálogo Próprio', icon: Film },
  { id: 'ingest', label: 'Extrator & M3U', icon: Download },
  { id: 'sandbox', label: 'Player Embed', icon: PlaySquare },
  { id: 'keys', label: 'Chaves API & Conta', icon: KeyRound },
  { id: 'docs', label: 'Documentação API', icon: BookOpen },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [user, setUser] = useState<UserProfile | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [catalog, setCatalog] = useState<MediaItemRecord[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [importJobs, setImportJobs] = useState<ImportJobRecord[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalMovies: 0,
    totalSeries: 0,
    totalSources: 0,
    workingSources: 0,
    totalEmbedRequests: 0,
    totalImportJobs: 0,
    activeApiKeys: 0,
  });
  const [settings, setSettings] = useState<PlatformSettings>({
    tmdbConfigured: false,
    tmdbKeyPreview: '',
    defaultPlayerColor: '#2563EB',
    allowPublicRegistration: true,
    requireApiKeyForEmbed: false,
    embedWatermarkText: 'CineVault Player',
  });

  const [sandboxTarget, setSandboxTarget] = useState<{
    media: MediaItemRecord | null;
    season: number;
    episode: number;
  }>({ media: null, season: 1, episode: 1 });

  const getAuthHeaders = useCallback((): HeadersInit => {
    const token = localStorage.getItem('cv_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const fetchUser = useCallback(async () => {
    const res = await fetch('/api/auth/me', { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      setUser(data.user || null);
    }
  }, [getAuthHeaders]);

  const fetchApiKeys = useCallback(async () => {
    const res = await fetch('/api/keys', { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      setApiKeys(data.keys || []);
    }
  }, [getAuthHeaders]);

  const fetchCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const res = await fetch('/api/media');
      if (res.ok) {
        const data = await res.json();
        setCatalog(data.items || []);
      }
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const fetchStatsAndJobs = useCallback(async () => {
    const [statsRes, jobsRes] = await Promise.all([fetch('/api/stats'), fetch('/api/import-jobs')]);
    if (statsRes.ok) {
      setStats(await statsRes.json());
    }
    if (jobsRes.ok) {
      const j = await jobsRes.json();
      setImportJobs(j.jobs || []);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    const res = await fetch('/api/settings');
    if (res.ok) {
      setSettings(await res.json());
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchUser(), fetchApiKeys(), fetchCatalog(), fetchStatsAndJobs(), fetchSettings()]);
  }, [fetchUser, fetchApiKeys, fetchCatalog, fetchStatsAndJobs, fetchSettings]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  function handleAuthChange(token: string | null) {
    if (token) {
      localStorage.setItem('cv_token', token);
    } else {
      localStorage.removeItem('cv_token');
    }
    fetchUser();
    fetchApiKeys();
    fetchStatsAndJobs();
  }

  function handleSelectMediaForEmbed(item: MediaItemRecord, season = 1, episode = 1) {
    setSandboxTarget({ media: item, season, episode });
    setActiveTab('sandbox');
  }

  const activeApiKey = apiKeys.find((k) => k.status === 'active')?.apiKey || 'cv_live_demo_9f8a2c4e1b7d3a6f';
  const currentNavLabel = NAV_ITEMS.find((n) => n.id === activeTab)?.label || 'Visão Geral';

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-slate-800/90 bg-[#0D131F]">
        <div className="flex h-16 items-center px-6 border-b border-slate-800/90">
          <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
            CineVault API
          </span>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-blue-600/15 text-blue-400 border border-blue-500/20'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100 border border-transparent'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-800/90 p-4">
          <div className="rounded-lg border border-slate-800 bg-[#111827] p-3 text-xs space-y-1">
            <div className="font-medium text-slate-200">
              {user ? user.name : 'Modo Visitante / Demo'}
            </div>
            <div className="text-slate-400 truncate">
              {user ? user.email : 'Cadastre-se para gerar chaves'}
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative z-10 flex w-64 flex-col bg-[#0D131F] border-r border-slate-800">
            <div className="flex h-16 items-center justify-between px-5 border-b border-slate-800">
              <span className="font-display text-lg font-bold text-white">CineVault API</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Fechar menu"
                className="rounded-lg p-1.5 text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1" aria-label="Menu mobile">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium ${
                      isActive ? 'bg-blue-600/15 text-blue-400' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb — Clean space — Single Primary Action */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-slate-800/90 bg-[#0B0F17]/95 backdrop-blur-sm px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Abrir menu de navegação"
              className="rounded-lg border border-slate-800 p-2 text-slate-300 hover:text-white lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">CineVault</span>
              <span className="text-slate-600 hidden sm:inline" aria-hidden="true">/</span>
              <span className="font-semibold text-slate-100 truncate">{currentNavLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('keys')}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {user ? 'Minha Conta & Chaves' : 'Cadastrar / Pegar API'}
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 max-w-[1440px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewView
              stats={stats}
              recentMedia={catalog}
              importJobs={importJobs}
              activeApiKey={activeApiKey}
              onNavigate={(tab) => setActiveTab(tab)}
              onSelectMediaForEmbed={handleSelectMediaForEmbed}
            />
          )}

          {activeTab === 'catalog' && (
            <CatalogView
              items={catalog}
              loading={catalogLoading}
              onRefresh={() => {
                fetchCatalog();
                fetchStatsAndJobs();
              }}
              onSelectForEmbed={handleSelectMediaForEmbed}
              onNavigateIngest={() => setActiveTab('ingest')}
            />
          )}

          {activeTab === 'ingest' && (
            <IngestView
              tmdbConfigured={settings.tmdbConfigured}
              onIngestSuccess={() => {
                fetchCatalog();
                fetchStatsAndJobs();
              }}
              onGoToCatalog={() => setActiveTab('catalog')}
            />
          )}

          {activeTab === 'sandbox' && (
            <SandboxView
              catalog={catalog}
              apiKeys={apiKeys}
              initialMedia={sandboxTarget.media}
              initialSeason={sandboxTarget.season}
              initialEpisode={sandboxTarget.episode}
            />
          )}

          {activeTab === 'keys' && (
            <ApiKeysView
              user={user}
              apiKeys={apiKeys}
              settings={settings}
              onAuthChange={handleAuthChange}
              onRefreshKeys={() => {
                fetchApiKeys();
                fetchStatsAndJobs();
              }}
              onRefreshSettings={fetchSettings}
            />
          )}

          {activeTab === 'docs' && <ApiDocsView activeApiKey={activeApiKey} />}
        </main>
      </div>
    </div>
  );
}

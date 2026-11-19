import { useState } from 'react';
import { KeyRound, Copy, Check, Trash2, Plus, LogOut, ShieldCheck } from 'lucide-react';
import type { ApiKeyRecord, PlatformSettings, UserProfile } from '../types/media';

interface ApiKeysViewProps {
  user: UserProfile | null;
  apiKeys: ApiKeyRecord[];
  settings: PlatformSettings;
  onAuthChange: (token: string | null) => void;
  onRefreshKeys: () => void;
  onRefreshSettings: () => void;
}

export function ApiKeysView({
  user,
  apiKeys,
  settings,
  onAuthChange,
  onRefreshKeys,
  onRefreshSettings,
}: ApiKeysViewProps) {
  const [authMode, setAuthMode] = useState<'register' | 'login'>('register');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // Create API Key state
  const [keyLabel, setKeyLabel] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('*');
  const [creatingKey, setCreatingKey] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Settings form state
  const [tmdbKeyInput, setTmdbKeyInput] = useState('');
  const [playerColor, setPlayerColor] = useState(settings.defaultPlayerColor || '#2563EB');
  const [watermarkText, setWatermarkText] = useState(settings.embedWatermarkText || 'CineVault Player');
  const [requireKeyEmbed, setRequireKeyEmbed] = useState(settings.requireApiKeyForEmbed);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState('');

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    try {
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const payload = authMode === 'register' ? { name, email, password } : { email, password };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Erro ao autenticar.');
        return;
      }
      onAuthChange(data.token);
      setName('');
      setEmail('');
      setPassword('');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleDemoLogin() {
    setAuthError('');
    setAuthBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@cinevault.dev', password: 'admin123' }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        onAuthChange(data.token);
      } else {
        setAuthError(data.error || 'Falha no login demo.');
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    const token = localStorage.getItem('cv_token');
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    onAuthChange(null);
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyError('');
    if (!keyLabel.trim()) {
      setKeyError('Informe um nome para sua chave de API.');
      return;
    }
    setCreatingKey(true);
    try {
      const token = localStorage.getItem('cv_token');
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ label: keyLabel.trim(), allowedDomains: allowedDomains.trim() || '*' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setKeyError(data.error || 'Não foi possível criar a chave.');
        return;
      }
      setKeyLabel('');
      onRefreshKeys();
    } finally {
      setCreatingKey(false);
    }
  }

  async function handleToggleKeyStatus(key: ApiKeyRecord) {
    const token = localStorage.getItem('cv_token');
    const nextStatus = key.status === 'active' ? 'revoked' : 'active';
    await fetch(`/api/keys/${key.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ status: nextStatus }),
    });
    onRefreshKeys();
  }

  async function handleDeleteKey(id: number) {
    const token = localStorage.getItem('cv_token');
    await fetch(`/api/keys/${id}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    onRefreshKeys();
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsSavedMsg('');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(tmdbKeyInput.trim() ? { tmdbApiKey: tmdbKeyInput.trim() } : {}),
          defaultPlayerColor: playerColor,
          embedWatermarkText: watermarkText,
          requireApiKeyForEmbed: requireKeyEmbed,
        }),
      });
      if (res.ok) {
        setTmdbKeyInput('');
        setSettingsSavedMsg('Configurações salvas com sucesso.');
        onRefreshSettings();
      }
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Account / Auth Column */}
        <section className="lg:col-span-5 space-y-5 rounded-xl border border-slate-800 bg-[#111827] p-6">
          {!user ? (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-display text-base font-semibold text-slate-100">
                    {authMode === 'register' ? 'Criar Conta de Desenvolvedor' : 'Entrar no Portal'}
                  </h2>
                  <p className="text-xs text-slate-400">
                    Cadastre-se para gerar suas chaves exclusivas da API Embed e REST.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1 border border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError('');
                  }}
                  className={`flex-1 rounded-md py-1.5 text-xs font-medium ${
                    authMode === 'register' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  Cadastrar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError('');
                  }}
                  className={`flex-1 rounded-md py-1.5 text-xs font-medium ${
                    authMode === 'login' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  Já tenho conta
                </button>
              </div>

              {authError && (
                <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                  {authError}
                </div>
              )}

              <form onSubmit={handleAuthSubmit} className="space-y-3">
                {authMode === 'register' && (
                  <div>
                    <label htmlFor="auth-name" className="block text-xs font-medium text-slate-400 mb-1">
                      Nome Completo ou Projeto
                    </label>
                    <input
                      id="auth-name"
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ex: João Silva / CineApp"
                      className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                    />
                  </div>
                )}
                <div>
                  <label htmlFor="auth-email" className="block text-xs font-medium text-slate-400 mb-1">
                    E-mail
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="dev@seudominio.com"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                  />
                </div>
                <div>
                  <label htmlFor="auth-password" className="block text-xs font-medium text-slate-400 mb-1">
                    Senha (mín. 6 caracteres)
                  </label>
                  <input
                    id="auth-password"
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                  />
                </div>
                <button
                  type="submit"
                  disabled={authBusy}
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {authBusy
                    ? 'Processando...'
                    : authMode === 'register'
                      ? 'Cadastrar e Gerar Chave API'
                      : 'Entrar na Conta'}
                </button>
              </form>

              <div className="border-t border-slate-800 pt-4">
                <button
                  type="button"
                  onClick={handleDemoLogin}
                  disabled={authBusy}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
                >
                  Entrar com Conta Admin Demo (admin@cinevault.dev)
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    Sessão Ativa · Plano {user.plan}
                  </div>
                  <h2 className="font-display text-lg font-bold text-slate-100">{user.name}</h2>
                  <div className="text-xs text-slate-400">{user.email}</div>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  Sair
                </button>
              </div>

              {/* Create New API Key Form */}
              <form onSubmit={handleCreateKey} className="space-y-3 border-t border-slate-800 pt-4">
                <h3 className="text-sm font-semibold text-slate-100">Gerar Nova Chave de API</h3>
                {keyError && (
                  <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                    {keyError}
                  </div>
                )}
                <div>
                  <label htmlFor="new-key-label" className="block text-xs font-medium text-slate-400 mb-1">
                    Identificação do Site / App
                  </label>
                  <input
                    id="new-key-label"
                    type="text"
                    required
                    value={keyLabel}
                    onChange={(e) => setKeyLabel(e.target.value)}
                    placeholder="Ex: Meu Portal de Filmes"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-sm text-slate-100"
                  />
                </div>
                <div>
                  <label htmlFor="new-key-domains" className="block text-xs font-medium text-slate-400 mb-1">
                    Domínios Permitidos (separados por vírgula ou * para todos)
                  </label>
                  <input
                    id="new-key-domains"
                    type="text"
                    value={allowedDomains}
                    onChange={(e) => setAllowedDomains(e.target.value)}
                    placeholder="meusite.com, app.meusite.com ou *"
                    className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
                  />
                </div>
                <button
                  type="submit"
                  disabled={creatingKey}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {creatingKey ? 'Gerando...' : 'Gerar Nova Chave Embed'}
                </button>
              </form>
            </div>
          )}
        </section>

        {/* API Keys Table Column */}
        <section className="lg:col-span-7 space-y-6">
          <div className="rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  {user ? 'Suas Chaves de API Embed & REST' : 'Chaves de Demonstração Disponíveis'}
                </h2>
                <p className="text-xs text-slate-400">
                  Use no parâmetro ?key= do iframe ou no header x-api-key das chamadas REST.
                </p>
              </div>
              <KeyRound className="h-5 w-5 text-slate-500" aria-hidden="true" />
            </div>

            {apiKeys.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">
                Nenhuma chave criada nesta conta ainda.
              </div>
            ) : (
              <div className="divide-y divide-slate-800">
                {apiKeys.map((k) => (
                  <div key={k.id} className="py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                        <span>{k.label}</span>
                        <span aria-hidden="true" className="text-slate-600">·</span>
                        <span className={`text-xs ${k.status === 'active' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {k.status === 'active' ? 'Ativa' : 'Revogada'}
                        </span>
                      </div>
                      <div className="font-mono text-xs text-blue-400 break-all">{k.apiKey}</div>
                      <div className="text-xs text-slate-400 tabular-nums">
                        Domínios: {k.allowedDomains} · {k.requestsCount.toLocaleString('pt-BR')} requisições
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(k.apiKey);
                          setCopiedId(k.id);
                          setTimeout(() => setCopiedId(null), 1600);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                      >
                        {copiedId === k.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copiedId === k.id ? 'Copiada' : 'Copiar'}
                      </button>
                      {user && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleToggleKeyStatus(k)}
                            className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
                          >
                            {k.status === 'active' ? 'Revogar' : 'Reativar'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteKey(k.id)}
                            aria-label={`Excluir chave ${k.label}`}
                            className="rounded-md border border-slate-700 p-1.5 text-slate-400 hover:border-red-800 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* TMDB & Player Global Settings */}
          <form onSubmit={handleSaveSettings} className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h2 className="font-display text-base font-semibold text-slate-100">
                Integração TMDB & Configurações do Player
              </h2>
              <p className="text-xs text-slate-400">
                Conecte sua chave v3 do TheMovieDB para buscar e enriquecer filmes e séries automaticamente durante extrações.
              </p>
            </div>

            {settingsSavedMsg && (
              <div className="rounded-lg border border-emerald-800/70 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                {settingsSavedMsg}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="settings-tmdb-key" className="block text-xs font-medium text-slate-400 mb-1">
                  TMDB API Key (v3){' '}
                  {settings.tmdbConfigured && (
                    <span className="font-mono text-emerald-400">({settings.tmdbKeyPreview})</span>
                  )}
                </label>
                <input
                  id="settings-tmdb-key"
                  type="password"
                  value={tmdbKeyInput}
                  onChange={(e) => setTmdbKeyInput(e.target.value)}
                  placeholder={settings.tmdbConfigured ? 'Deixe vazio para manter atual' : 'Cole sua TMDB API Key v3'}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="settings-watermark" className="block text-xs font-medium text-slate-400 mb-1">
                  Marca d&apos;água do Player
                </label>
                <input
                  id="settings-watermark"
                  type="text"
                  value={watermarkText}
                  onChange={(e) => setWatermarkText(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={requireKeyEmbed}
                  onChange={(e) => setRequireKeyEmbed(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-blue-600"
                />
                Exigir parâmetro ?key= válido para abrir qualquer /embed/
              </label>

              <div className="flex items-center gap-2">
                <label htmlFor="settings-color" className="text-xs text-slate-400">
                  Cor padrão:
                </label>
                <input
                  id="settings-color"
                  type="color"
                  value={playerColor}
                  onChange={(e) => setPlayerColor(e.target.value)}
                  className="h-8 w-10 cursor-pointer rounded border border-slate-700 bg-[#0B0F17] p-0.5"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={savingSettings}
              className="rounded-lg bg-slate-800 border border-slate-700 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {savingSettings ? 'Salvando...' : 'Salvar Configurações'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

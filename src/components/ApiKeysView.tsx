import { useEffect, useState } from 'react';
import { KeyRound, Copy, Check, Trash2, Plus, LogOut, ShieldCheck, LogIn } from 'lucide-react';
import type { ApiKeyRecord, PlatformSettings, UserProfile } from '../types/media';
import {
  createUserApiKey,
  deleteUserApiKey,
  savePlatformSettings,
  saveUserTmdbSecret,
  toggleUserApiKeyStatus,
} from '../services/firestoreCatalog';

interface ApiKeysViewProps {
  user: UserProfile | null;
  apiKeys: ApiKeyRecord[];
  settings: PlatformSettings;
  tmdbApiKey: string;
  authBusy: boolean;
  authError: string;
  onSignInGoogle: () => void;
  onSignOut: () => void;
  onTmdbKeyUpdated: (newKey: string) => void;
  onRefreshSettings: () => void;
}

export function ApiKeysView({
  user,
  apiKeys,
  settings,
  tmdbApiKey,
  authBusy,
  authError,
  onSignInGoogle,
  onSignOut,
  onTmdbKeyUpdated,
  onRefreshSettings,
}: ApiKeysViewProps) {
  // Create API Key state
  const [keyLabel, setKeyLabel] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('*');
  const [creatingKey, setCreatingKey] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Personal TMDB Secret state
  const [tmdbKeyInput, setTmdbKeyInput] = useState('');
  const [savingTmdb, setSavingTmdb] = useState(false);
  const [tmdbSavedMsg, setTmdbSavedMsg] = useState('');

  // Global Platform Settings state (admin only)
  const [playerColor, setPlayerColor] = useState(settings.defaultPlayerColor || '#2563EB');
  const [watermarkText, setWatermarkText] = useState(settings.embedWatermarkText || 'CineVault Player');
  const [requireKeyEmbed, setRequireKeyEmbed] = useState(settings.requireApiKeyForEmbed);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState('');
  const [settingsError, setSettingsError] = useState('');

  useEffect(() => {
    setPlayerColor(settings.defaultPlayerColor || '#2563EB');
    setWatermarkText(settings.embedWatermarkText || 'CineVault Player');
    setRequireKeyEmbed(Boolean(settings.requireApiKeyForEmbed));
  }, [settings]);

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setKeyError('');
    if (!keyLabel.trim()) {
      setKeyError('Informe um nome para sua chave de API.');
      return;
    }
    setCreatingKey(true);
    try {
      await createUserApiKey(user.uid, keyLabel.trim(), allowedDomains.trim() || '*');
      setKeyLabel('');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Não foi possível criar a chave no Firestore.');
    } finally {
      setCreatingKey(false);
    }
  }

  async function handleToggleKeyStatus(key: ApiKeyRecord) {
    try {
      await toggleUserApiKeyStatus(key);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Erro ao atualizar status da chave.');
    }
  }

  async function handleDeleteKey(id: string) {
    try {
      await deleteUserApiKey(id);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Erro ao remover chave.');
    }
  }

  async function handleSaveTmdbKey(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSavingTmdb(true);
    setTmdbSavedMsg('');
    try {
      const cleaned = tmdbKeyInput.trim();
      await saveUserTmdbSecret(user.uid, cleaned);
      onTmdbKeyUpdated(cleaned);
      setTmdbKeyInput('');
      setTmdbSavedMsg(
        cleaned
          ? 'Chave TMDB v3 salva com segurança na sua coleção privada do Firestore.'
          : 'Chave TMDB removida.'
      );
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Falha ao salvar chave TMDB.');
    } finally {
      setSavingTmdb(false);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!user || user.role !== 'admin') return;
    setSavingSettings(true);
    setSettingsSavedMsg('');
    setSettingsError('');
    try {
      await savePlatformSettings({
        defaultPlayerColor: playerColor,
        allowPublicRegistration: true,
        requireApiKeyForEmbed: requireKeyEmbed,
        embedWatermarkText: watermarkText,
        tmdbConfigured: Boolean(tmdbApiKey || settings.tmdbConfigured),
      });
      setSettingsSavedMsg('Configurações globais salvas no Firestore (/settings/platform).');
      onRefreshSettings();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Erro ao salvar configurações globais.');
    } finally {
      setSavingSettings(false);
    }
  }

  const maskedTmdb = tmdbApiKey
    ? `${tmdbApiKey.slice(0, 4)}••••${tmdbApiKey.slice(-4)}`
    : '';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Account / Auth Column */}
        <section className="lg:col-span-5 space-y-5 rounded-xl border border-slate-800 bg-[#111827] p-6">
          {!user ? (
            <div className="space-y-4">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Entrar com Google (Firebase Auth)
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  Autentique-se com sua conta Google para provisionar automaticamente suas chaves da API Embed e REST no Cloud Firestore.
                </p>
              </div>

              {authError && (
                <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                  {authError}
                </div>
              )}

              <button
                type="button"
                onClick={onSignInGoogle}
                disabled={authBusy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                {authBusy ? 'Conectando ao Google...' : 'Continuar com Google'}
              </button>

              <div className="rounded-lg border border-slate-800 bg-[#0B0F17] p-3.5 text-xs text-slate-400 space-y-1">
                <div className="font-medium text-slate-200">Provisionamento Automático</div>
                <p>
                  Ao entrar, sua conta recebe uma chave <code className="text-blue-400">cv_live_...</code> vinculada ao seu UID no Firebase para integrar em qualquer site ou aplicativo.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    Sessão Firebase · {user.role === 'admin' ? 'Administrador' : `Plano ${user.plan}`}
                  </div>
                  <h2 className="font-display text-lg font-bold text-slate-100">{user.name}</h2>
                  <div className="text-xs text-slate-400">{user.email}</div>
                </div>
                <button
                  type="button"
                  onClick={onSignOut}
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
                  {creatingKey ? 'Gerando no Firestore...' : 'Gerar Nova Chave Embed'}
                </button>
              </form>
            </div>
          )}
        </section>

        {/* API Keys Table + Settings Column */}
        <section className="lg:col-span-7 space-y-6">
          <div className="rounded-xl border border-slate-800 bg-[#111827] p-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Suas Chaves de API Embed & REST
                </h2>
                <p className="text-xs text-slate-400">
                  Use no parâmetro ?key= do iframe ou no header x-api-key das chamadas REST.
                </p>
              </div>
              <KeyRound className="h-5 w-5 text-slate-500" aria-hidden="true" />
            </div>

            {!user ? (
              <div className="py-10 text-center text-xs text-slate-400">
                Conecte sua conta Google ao lado para visualizar e gerenciar suas chaves exclusivas no Cloud Firestore.
              </div>
            ) : apiKeys.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">
                Provisionando chave inicial na sua conta...
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
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Personal TMDB v3 Key (Owner-Isolated) */}
          <form onSubmit={handleSaveTmdbKey} className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h2 className="font-display text-base font-semibold text-slate-100">
                Sua Chave TMDB API (v3)
              </h2>
              <p className="text-xs text-slate-400">
                Salva de forma privada apenas para sua conta em <code className="text-slate-300">/users/uid/secrets/tmdb</code> para enriquecer filmes e séries durante extrações.
              </p>
            </div>

            {tmdbSavedMsg && (
              <div className="rounded-lg border border-emerald-800/70 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                {tmdbSavedMsg}
              </div>
            )}

            <div>
              <label htmlFor="settings-tmdb-key" className="block text-xs font-medium text-slate-400 mb-1">
                TMDB API Key (v3){' '}
                {maskedTmdb && <span className="font-mono text-emerald-400">({maskedTmdb})</span>}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="settings-tmdb-key"
                  type="password"
                  value={tmdbKeyInput}
                  onChange={(e) => setTmdbKeyInput(e.target.value)}
                  placeholder={maskedTmdb ? 'Cole uma nova chave para substituir' : 'Cole sua TMDB API Key v3'}
                  disabled={!user}
                  className="flex-1 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs font-mono text-slate-100 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!user || savingTmdb}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50 shrink-0"
                >
                  {savingTmdb ? 'Salvando...' : 'Salvar Chave TMDB'}
                </button>
              </div>
            </div>
          </form>

          {/* Global Platform Settings (Admin Only) */}
          <form onSubmit={handleSaveSettings} className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <h2 className="font-display text-base font-semibold text-slate-100">
                Configurações Globais do Player Embed
              </h2>
              <p className="text-xs text-slate-400">
                Parâmetros padrão aplicados em todos os endpoints <code className="text-slate-300">/embed/</code>. Apenas administradores podem alterar.
              </p>
            </div>

            {settingsSavedMsg && (
              <div className="rounded-lg border border-emerald-800/70 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                {settingsSavedMsg}
              </div>
            )}
            {settingsError && (
              <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {settingsError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="settings-watermark" className="block text-xs font-medium text-slate-400 mb-1">
                  Marca d&apos;água do Player
                </label>
                <input
                  id="settings-watermark"
                  type="text"
                  value={watermarkText}
                  onChange={(e) => setWatermarkText(e.target.value)}
                  disabled={user?.role !== 'admin'}
                  className="w-full rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2 text-xs text-slate-100 disabled:opacity-60"
                />
              </div>
              <div className="flex items-end gap-3 pb-1">
                <label htmlFor="settings-color" className="text-xs text-slate-400">
                  Cor padrão do player:
                </label>
                <input
                  id="settings-color"
                  type="color"
                  value={playerColor}
                  onChange={(e) => setPlayerColor(e.target.value)}
                  disabled={user?.role !== 'admin'}
                  className="h-8 w-10 cursor-pointer rounded border border-slate-700 bg-[#0B0F17] p-0.5 disabled:opacity-60"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={requireKeyEmbed}
                onChange={(e) => setRequireKeyEmbed(e.target.checked)}
                disabled={user?.role !== 'admin'}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-blue-600"
              />
              Exigir parâmetro ?key= válido para abrir qualquer /embed/
            </label>

            {user?.role === 'admin' ? (
              <button
                type="submit"
                disabled={savingSettings}
                className="rounded-lg bg-slate-800 border border-slate-700 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {savingSettings ? 'Salvando...' : 'Salvar Configurações Globais'}
              </button>
            ) : (
              <div className="text-[11px] text-slate-500">
                Visualização somente leitura para contas Developer padrão.
              </div>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}

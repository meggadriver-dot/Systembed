import { useState } from 'react';
import { Play, Copy, Check } from 'lucide-react';

interface ApiDocsViewProps {
  activeApiKey: string;
}

export function ApiDocsView({ activeApiKey }: ApiDocsViewProps) {
  const [testEndpoint, setTestEndpoint] = useState('/api/v1/catalog');
  const [responseJson, setResponseJson] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://seu-dominio.com';
  const displayKey = activeApiKey || 'SUA_CHAVE_API_FIRESTORE';

  const endpoints = [
    {
      method: 'EMBED',
      path: '/embed/movie/{tmdb_id}?key={api_key}',
      title: 'Player Embed de Filme',
      description:
        'Retorna o player HTML5/HLS completo e responsivo pronto para ser incorporado via <iframe> em qualquer site ou app.',
    },
    {
      method: 'EMBED',
      path: '/embed/tv/{tmdb_id}/{season}/{episode}?key={api_key}',
      title: 'Player Embed de Série / Episódio',
      description:
        'Abre diretamente na temporada e episódio especificados, incluindo seletor de servidores e troca de episódios.',
    },
    {
      method: 'GET',
      path: '/api/v1/catalog',
      title: 'Listar Catálogo Próprio (JSON)',
      description:
        'Retorna filmes e séries armazenados no Firebase Cloud Firestore com paginação (?page=1&limit=25&type=movie|tv). Requer header x-api-key.',
    },
    {
      method: 'GET',
      path: '/api/v1/media/{type}/{tmdb_id}',
      title: 'Consultar Fontes & Episódios por TMDB ID',
      description:
        'Retorna metadados completos e todas as URLs de stream (HLS, MP4) vinculadas ao TMDB ID informado no Firestore.',
    },
  ];

  async function runLiveTest() {
    if (!activeApiKey) {
      setResponseJson(
        JSON.stringify(
          {
            error: 'Nenhuma API Key ativa detectada na sessão.',
            action: 'Entre com sua conta Google na aba "Chaves API & Conta" para gerar sua chave automaticamente.',
          },
          null,
          2
        )
      );
      return;
    }
    setTesting(true);
    try {
      const res = await fetch(testEndpoint, {
        headers: { 'x-api-key': activeApiKey },
      });
      const data = await res.json();
      setResponseJson(JSON.stringify(data, null, 2));
    } catch (err) {
      setResponseJson(JSON.stringify({ error: err instanceof Error ? err.message : 'Erro' }, null, 2));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
        <div>
          <h2 className="font-display text-lg font-bold text-slate-100">
            Documentação da API Própria (REST & Embed)
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Todos os endpoints leem exclusivamente do seu banco Firebase Cloud Firestore — zero dependência de servidores externos após a extração.
          </p>
        </div>

        <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#0B0F17]">
          {endpoints.map((ep) => (
            <div key={ep.path} className="p-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-blue-400">{ep.method}</span>
                  <code className="font-mono text-xs text-slate-100 break-all">{ep.path}</code>
                </div>
                <div className="text-xs font-medium text-slate-200">{ep.title}</div>
                <p className="text-xs text-slate-400">{ep.description}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(`${origin}${ep.path.replace('{api_key}', displayKey)}`);
                  setCopiedPath(ep.path);
                  setTimeout(() => setCopiedPath(null), 1600);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 shrink-0"
              >
                {copiedPath === ep.path ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedPath === ep.path ? 'Copiado' : 'Copiar URL'}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Live API Explorer */}
      <section className="rounded-xl border border-slate-800 bg-[#111827] p-6 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-100">
              Testar Endpoint REST ao Vivo
            </h3>
            <p className="text-xs text-slate-400">
              {activeApiKey ? (
                <>
                  Executa uma chamada real autenticada com sua chave{' '}
                  <code className="text-blue-400">{activeApiKey}</code>.
                </>
              ) : (
                'Entre com sua conta Google na aba Chaves API & Conta para gerar sua chave e testar os endpoints REST.'
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <select
            aria-label="Selecionar endpoint REST para testar"
            value={testEndpoint}
            onChange={(e) => setTestEndpoint(e.target.value)}
            className="flex-1 rounded-lg border border-slate-700 bg-[#0B0F17] px-3 py-2.5 text-xs font-mono text-slate-100"
          >
            <option value="/api/v1/catalog">GET /api/v1/catalog</option>
            <option value="/api/v1/catalog?type=movie">GET /api/v1/catalog?type=movie</option>
            <option value="/api/v1/catalog?type=tv">GET /api/v1/catalog?type=tv</option>
            <option value="/api/v1/media/movie/157336">GET /api/v1/media/movie/157336</option>
            <option value="/api/v1/media/tv/1396">GET /api/v1/media/tv/1396</option>
          </select>
          <button
            type="button"
            onClick={runLiveTest}
            disabled={testing}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            {testing ? 'Consultando...' : 'Executar Requisição'}
          </button>
        </div>

        {responseJson && (
          <pre className="max-h-96 overflow-auto rounded-xl border border-slate-800 bg-[#0B0F17] p-4 font-mono text-xs leading-relaxed text-emerald-300">
            <code>{responseJson}</code>
          </pre>
        )}
      </section>
    </div>
  );
}

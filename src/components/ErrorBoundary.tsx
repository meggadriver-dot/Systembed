import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message || 'Erro inesperado na aplicação.' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      let friendly = this.state.message;
      try {
        const parsed = JSON.parse(this.state.message) as { error?: string; operationType?: string; path?: string };
        if (parsed.error) {
          friendly = `${parsed.error} (Operação: ${parsed.operationType || 'desconhecida'}, Caminho: ${parsed.path || '-'})`;
        }
      } catch {
        // plain string message
      }

      return (
        <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-xl border border-red-900/60 bg-[#111827] p-6 space-y-4">
            <h1 className="font-display text-lg font-bold text-red-300">
              Erro de Permissão ou Conexão no Firebase
            </h1>
            <p className="text-xs font-mono text-slate-300 break-words bg-[#0B0F17] p-3 rounded-lg border border-slate-800">
              {friendly}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
            >
              Recarregar Aplicação
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

import { useState } from 'react';
import { Film, Tv } from 'lucide-react';
import type { MediaType } from '../types/media';

interface MediaPosterProps {
  src?: string;
  title: string;
  type: MediaType;
  tmdbId: number;
  className?: string;
}

export function MediaPoster({ src, title, type, tmdbId, className = '' }: MediaPosterProps) {
  const [failed, setFailed] = useState(false);
  const showFallback = !src || failed;

  if (showFallback) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-slate-800 via-slate-900 to-slate-950 p-4 text-center border border-slate-800 ${className}`}
      >
        {type === 'tv' ? (
          <Tv className="h-7 w-7 text-slate-500 mb-2" aria-hidden="true" />
        ) : (
          <Film className="h-7 w-7 text-slate-500 mb-2" aria-hidden="true" />
        )}
        <span className="text-xs font-medium text-slate-300 line-clamp-2 leading-snug">{title}</span>
        <span className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">TMDB {tmdbId}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={`Pôster de ${title}`}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`object-cover bg-slate-900 ${className}`}
    />
  );
}

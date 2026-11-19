export interface EmbedPlayerMedia {
  id: number;
  tmdbId: number;
  type: 'movie' | 'tv';
  title: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseYear: number | null;
  season?: number | null;
  episode?: number | null;
  accentColor: string;
  watermarkText: string;
  sources: Array<{
    id: number;
    season: number | null;
    episode: number | null;
    episodeTitle: string | null;
    streamUrl: string;
    quality: string;
    format: string;
    language: string;
    originProvider: string;
  }>;
  episodes?: Array<{
    season: number;
    episode: number;
    episodeTitle: string | null;
  }>;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmbedErrorHtml(title: string, message: string, statusCode = 404): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — CineVault Embed</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #070A10;
      color: #E2E8F0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .box {
      max-width: 440px;
      width: 100%;
      background: #111827;
      border: 1px solid #1F2937;
      border-radius: 12px;
      padding: 28px;
      text-align: center;
    }
    .code {
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 12px;
      color: #94A3B8;
      margin-bottom: 10px;
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #F8FAFC; }
    p { font-size: 14px; line-height: 1.5; color: #94A3B8; }
  </style>
</head>
<body>
  <div class="box">
    <div class="code">HTTP ${statusCode}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

export function renderEmbedPlayerHtml(media: EmbedPlayerMedia, apiKeyParam: string): string {
  const safeColor = /^#?[0-9a-fA-F]{6}$/.test(media.accentColor)
    ? media.accentColor.startsWith('#')
      ? media.accentColor
      : `#${media.accentColor}`
    : '#2563EB';

  const serializedSources = JSON.stringify(media.sources).replace(/</g, '\\u003c');
  const serializedEpisodes = JSON.stringify(media.episodes || []).replace(/</g, '\\u003c');

  const subtitleLabel =
    media.type === 'tv' && media.season && media.episode
      ? `T${String(media.season).padStart(2, '0')} · E${String(media.episode).padStart(2, '0')} · TMDB ${media.tmdbId}`
      : `${media.releaseYear ? `${media.releaseYear} · ` : ''}TMDB ${media.tmdbId}`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(media.title)} — ${escapeHtml(media.watermarkText)}</title>
  <script src="/vendor/hls.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      background: #05070B;
      color: #F8FAFC;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    .player-shell {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: #05070B;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      background: rgba(11, 15, 23, 0.94);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      z-index: 20;
      flex-wrap: wrap;
    }
    .meta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      color: #F8FAFC;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sub {
      font-size: 11px;
      color: #94A3B8;
      font-family: ui-monospace, SFMono-Regular, monospace;
    }
    .controls-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    select, button {
      background: #161F2E;
      color: #F1F5F9;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      outline: none;
    }
    select:hover, button:hover {
      border-color: ${safeColor};
    }
    button.active {
      background: ${safeColor};
      border-color: ${safeColor};
      color: #FFFFFF;
      font-weight: 600;
    }
    .video-stage {
      position: relative;
      flex: 1;
      background: #000000;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000000;
    }
    .watermark {
      position: absolute;
      right: 14px;
      bottom: 52px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.45);
      pointer-events: none;
      letter-spacing: 0.02em;
    }
    .status-banner {
      position: absolute;
      left: 14px;
      bottom: 52px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      color: #CBD5E1;
      display: none;
    }
    .status-banner.visible { display: block; }
  </style>
</head>
<body>
  <div class="player-shell">
    <div class="topbar">
      <div class="meta">
        <div class="title">${escapeHtml(media.title)}</div>
        <div class="sub">${escapeHtml(subtitleLabel)}</div>
      </div>
      <div class="controls-row">
        <div id="server-buttons" class="controls-row"></div>
        <select id="episode-select" style="display:none" aria-label="Selecionar Episódio"></select>
      </div>
    </div>
    <div class="video-stage">
      <video id="cv-video" controls playsinline preload="metadata" poster="${escapeHtml(media.backdropUrl || media.posterUrl)}"></video>
      <div id="status-banner" class="status-banner"></div>
      <div class="watermark">${escapeHtml(media.watermarkText)}</div>
    </div>
  </div>
  <script>
    (function() {
      const sources = ${serializedSources};
      const episodes = ${serializedEpisodes};
      const mediaType = ${JSON.stringify(media.type)};
      const tmdbId = ${JSON.stringify(media.tmdbId)};
      const currentSeason = ${JSON.stringify(media.season ?? 1)};
      const currentEpisode = ${JSON.stringify(media.episode ?? 1)};
      const apiKeyParam = ${JSON.stringify(apiKeyParam)};
      const accentColor = ${JSON.stringify(safeColor.replace('#', ''))};

      const video = document.getElementById('cv-video');
      const serverButtonsEl = document.getElementById('server-buttons');
      const episodeSelect = document.getElementById('episode-select');
      const statusBanner = document.getElementById('status-banner');
      let hlsInstance = null;
      let activeIndex = 0;

      function showStatus(msg) {
        if (!msg) {
          statusBanner.classList.remove('visible');
          statusBanner.textContent = '';
          return;
        }
        statusBanner.textContent = msg;
        statusBanner.classList.add('visible');
      }

      if (mediaType === 'tv' && episodes.length > 0) {
        episodeSelect.style.display = 'inline-block';
        episodes.forEach(function(ep) {
          const opt = document.createElement('option');
          opt.value = ep.season + ':' + ep.episode;
          opt.textContent = 'T' + String(ep.season).padStart(2, '0') + 'E' + String(ep.episode).padStart(2, '0') + (ep.episodeTitle ? ' - ' + ep.episodeTitle : '');
          if (ep.season === currentSeason && ep.episode === currentEpisode) {
            opt.selected = true;
          }
          episodeSelect.appendChild(opt);
        });
        episodeSelect.addEventListener('change', function() {
          const parts = episodeSelect.value.split(':');
          const nextUrl = '/embed/tv/' + tmdbId + '/' + parts[0] + '/' + parts[1] + '?key=' + encodeURIComponent(apiKeyParam) + '&color=' + encodeURIComponent(accentColor);
          window.location.href = nextUrl;
        });
      }

      function loadSource(index) {
        activeIndex = index;
        const src = sources[index];
        if (!src) {
          showStatus('Nenhuma fonte de vídeo disponível no banco para este título.');
          return;
        }
        Array.from(serverButtonsEl.children).forEach(function(btn, i) {
          btn.classList.toggle('active', i === index);
        });
        showStatus('');

        if (hlsInstance) {
          hlsInstance.destroy();
          hlsInstance = null;
        }

        const isHls = src.format === 'hls' || src.streamUrl.toLowerCase().includes('.m3u8');
        if (isHls && window.Hls && window.Hls.isSupported()) {
          hlsInstance = new window.Hls({ enableWorker: true });
          hlsInstance.loadSource(src.streamUrl);
          hlsInstance.attachMedia(video);
          hlsInstance.on(window.Hls.Events.ERROR, function(_, data) {
            if (data && data.fatal) {
              if (index + 1 < sources.length) {
                showStatus('Fonte ' + (index + 1) + ' indisponível, alternando para servidor reserva...');
                loadSource(index + 1);
              } else {
                showStatus('Falha ao carregar stream HLS (' + (data.details || 'erro de rede') + ').');
              }
            }
          });
        } else {
          video.src = src.streamUrl;
          video.onerror = function() {
            if (index + 1 < sources.length) {
              showStatus('Servidor ' + (index + 1) + ' falhou, tentando servidor reserva...');
              loadSource(index + 1);
            } else {
              showStatus('Não foi possível reproduzir o vídeo a partir desta origem.');
            }
          };
        }
      }

      sources.forEach(function(src, idx) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Servidor ' + (idx + 1) + ' · ' + src.quality + ' · ' + src.language;
        btn.addEventListener('click', function() {
          loadSource(idx);
        });
        serverButtonsEl.appendChild(btn);
      });

      if (sources.length > 0) {
        loadSource(0);
      } else {
        showStatus('Nenhuma fonte cadastrada para este episódio/filme.');
      }
    })();
  </script>
</body>
</html>`;
}

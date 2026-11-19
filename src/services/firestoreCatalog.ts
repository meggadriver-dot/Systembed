import type { User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  ApiKeyRecord,
  ImportJobRecord,
  MediaItemRecord,
  MediaSourceRecord,
  MediaStatus,
  MediaType,
  PlatformSettings,
  SourceOrigin,
  StreamFormat,
  UserProfile,
} from '../types/media';

const ADMIN_EMAIL = 'diogosandro07@gmail.com';

function timestampToIso(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

function clampString(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

function generateClientApiKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `cv_live_${hex}`;
}

function makeSourceId(streamUrl: string, season: number, episode: number): string {
  const raw = `${season}_${episode}_${streamUrl}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `src_${season}_${episode}_${Math.abs(hash).toString(36)}`;
}

function mapMediaDoc(id: string, data: Record<string, unknown>): MediaItemRecord {
  return {
    id,
    ownerId: String(data.ownerId || ''),
    tmdbId: Number(data.tmdbId || 0),
    imdbId: String(data.imdbId || ''),
    type: data.type === 'tv' ? 'tv' : 'movie',
    title: String(data.title || ''),
    originalTitle: String(data.originalTitle || ''),
    overview: String(data.overview || ''),
    posterUrl: String(data.posterUrl || ''),
    backdropUrl: String(data.backdropUrl || ''),
    releaseYear: Number(data.releaseYear || 0),
    rating: Number(data.rating || 0),
    genres: Array.isArray(data.genres) ? data.genres.map(String) : [],
    runtime: Number(data.runtime || 0),
    status: data.status === 'draft' ? 'draft' : 'published',
    sourceOrigin: (data.sourceOrigin as SourceOrigin) || 'manual',
    sourcesCount: Number(data.sourcesCount || 0),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

function mapSourceDoc(id: string, data: Record<string, unknown>): MediaSourceRecord {
  return {
    id,
    mediaKey: String(data.mediaKey || ''),
    ownerId: String(data.ownerId || ''),
    parentStatus: data.parentStatus === 'draft' ? 'draft' : 'published',
    season: Number(data.season || 0),
    episode: Number(data.episode || 0),
    episodeTitle: String(data.episodeTitle || ''),
    streamUrl: String(data.streamUrl || ''),
    quality: String(data.quality || '1080p'),
    format: (data.format as StreamFormat) || 'hls',
    language: String(data.language || 'PT-BR'),
    isWorking: Boolean(data.isWorking),
    originProvider: String(data.originProvider || 'Próprio'),
    createdAt: timestampToIso(data.createdAt),
  };
}

export async function ensureUserProfileAndKeys(fbUser: FirebaseUser): Promise<UserProfile> {
  const userPath = `users/${fbUser.uid}`;
  const userRef = doc(db, 'users', fbUser.uid);
  const isAdminUser = fbUser.email?.toLowerCase() === ADMIN_EMAIL && fbUser.emailVerified;

  try {
    const snap = await getDoc(userRef);
    let profile: UserProfile;
    if (!snap.exists()) {
      const name = clampString(fbUser.displayName || fbUser.email?.split('@')[0] || 'Desenvolvedor', 120);
      const email = clampString(fbUser.email || 'user@cinevault.dev', 180);
      const plan: 'Developer' | 'Enterprise' = isAdminUser ? 'Enterprise' : 'Developer';
      await setDoc(userRef, {
        uid: fbUser.uid,
        name,
        email,
        plan,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      profile = {
        uid: fbUser.uid,
        name,
        email,
        role: isAdminUser ? 'admin' : 'developer',
        plan,
        createdAt: new Date().toISOString(),
      };
    } else {
      const d = snap.data();
      profile = {
        uid: fbUser.uid,
        name: String(d.name || fbUser.displayName || 'Desenvolvedor'),
        email: String(d.email || fbUser.email || ''),
        role: isAdminUser ? 'admin' : 'developer',
        plan: d.plan === 'Enterprise' ? 'Enterprise' : 'Developer',
        createdAt: timestampToIso(d.createdAt),
      };
    }

    // Ensure user has at least 1 API key in /api_keys
    const keysQuery = query(collection(db, 'api_keys'), where('ownerId', '==', fbUser.uid));
    const keysSnap = await getDocs(keysQuery);
    if (keysSnap.empty) {
      const newKey = generateClientApiKey();
      await setDoc(doc(db, 'api_keys', newKey), {
        ownerId: fbUser.uid,
        label: 'Chave Padrão Embed',
        apiKey: newKey,
        allowedDomains: '*',
        requestsCount: 0,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    return profile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function seedInitialCatalogIfEmpty(uid: string): Promise<boolean> {
  const path = 'media_items';
  try {
    const existingSnap = await getDocs(
      query(collection(db, 'media_items'), where('status', '==', 'published'))
    );
    if (!existingSnap.empty) return false;

    const seeds = [
      {
        mediaKey: 'movie_157336',
        tmdbId: 157336,
        imdbId: 'tt0816692',
        type: 'movie' as MediaType,
        title: 'Horizonte Orbital',
        originalTitle: 'Orbital Horizon',
        overview:
          'Em um futuro onde a órbita terrestre entra em colapso, uma equipe de engenharia atravessa um corredor gravitacional próximo a Saturno para resgatar uma estação de transmissão perdida.',
        posterUrl: '/src/assets/images/poster_orbital_horizon_1795045402968.jpg',
        backdropUrl: '/src/assets/images/poster_orbital_horizon_1795045402968.jpg',
        releaseYear: 2025,
        rating: 8.7,
        genres: ['Ficção Científica', 'Drama', 'Aventura'],
        runtime: 148,
        sources: [
          { season: 0, episode: 0, episodeTitle: '', streamUrl: '/demo/hls/master.m3u8', quality: '1080p', format: 'hls' as StreamFormat, language: 'DUAL', originProvider: 'CDN Próprio HLS' },
          { season: 0, episode: 0, episodeTitle: '', streamUrl: '/demo/stream.mp4', quality: '1080p', format: 'mp4' as StreamFormat, language: 'PT-BR', originProvider: 'Storage S3 MP4' },
        ],
      },
      {
        mediaKey: 'tv_1396',
        tmdbId: 1396,
        imdbId: 'tt0903747',
        type: 'tv' as MediaType,
        title: 'Distrito da Chuva',
        originalTitle: 'Rain Precinct',
        overview:
          'Um inspetor veterano investiga uma rede clandestina de transmissões piratas nas docas europeias, descobrindo que cada sinal esconde um desaparecimento não resolvido.',
        posterUrl: '/src/assets/images/poster_rain_precinct_1795045402586.jpg',
        backdropUrl: '/src/assets/images/poster_rain_precinct_1795045402586.jpg',
        releaseYear: 2024,
        rating: 9.1,
        genres: ['Crime', 'Mistério', 'Drama'],
        runtime: 52,
        sources: [
          { season: 1, episode: 1, episodeTitle: 'Sinal Interrompido', streamUrl: '/demo/hls/master.m3u8', quality: '1080p', format: 'hls' as StreamFormat, language: 'PT-BR', originProvider: 'M3U Extraído' },
          { season: 1, episode: 2, episodeTitle: 'Cais Sete', streamUrl: '/demo/stream.mp4', quality: '1080p', format: 'mp4' as StreamFormat, language: 'LEG', originProvider: 'M3U Extraído' },
        ],
      },
      {
        mediaKey: 'movie_299536',
        tmdbId: 299536,
        imdbId: 'tt4154756',
        type: 'movie' as MediaType,
        title: 'Corrente Abissal',
        originalTitle: 'Abyssal Current',
        overview:
          'Expedição documental pelas florestas submersas de algas gigantes e fossas oceânicas do Pacífico Sul, registrando ecossistemas nunca filmados em 4K.',
        posterUrl: '/src/assets/images/poster_abyssal_current_1795045402804.jpg',
        backdropUrl: '/src/assets/images/poster_abyssal_current_1795045402804.jpg',
        releaseYear: 2025,
        rating: 8.4,
        genres: ['Documentário', 'Natureza'],
        runtime: 104,
        sources: [
          { season: 0, episode: 0, episodeTitle: '', streamUrl: '/demo/stream.mp4', quality: '4K', format: 'mp4' as StreamFormat, language: 'PT-BR', originProvider: 'Storage S3 MP4' },
        ],
      },
      {
        mediaKey: 'tv_94997',
        tmdbId: 94997,
        imdbId: 'tt11198330',
        type: 'tv' as MediaType,
        title: 'Monólito de Vidro',
        originalTitle: 'Glass Monolith',
        overview:
          'Pesquisadores isolados em um observatório brutalista na costa nórdica monitoram anomalias acústicas submarinas que alteram a percepção do tempo.',
        posterUrl: '/src/assets/images/poster_glass_monolith_1795045403215.jpg',
        backdropUrl: '/src/assets/images/poster_glass_monolith_1795045403215.jpg',
        releaseYear: 2026,
        rating: 8.9,
        genres: ['Suspense', 'Mistério', 'Ficção Científica'],
        runtime: 48,
        sources: [
          { season: 1, episode: 1, episodeTitle: 'O Observatório', streamUrl: '/demo/hls/master.m3u8', quality: '1080p', format: 'hls' as StreamFormat, language: 'DUAL', originProvider: 'CDN Próprio HLS' },
          { season: 1, episode: 2, episodeTitle: 'Maré Baixa', streamUrl: '/demo/stream.mp4', quality: '1080p', format: 'mp4' as StreamFormat, language: 'PT-BR', originProvider: 'CDN Próprio HLS' },
        ],
      },
    ];

    const parentsBatch = writeBatch(db);
    for (const item of seeds) {
      parentsBatch.set(doc(db, 'media_items', item.mediaKey), {
        ownerId: uid,
        tmdbId: item.tmdbId,
        imdbId: item.imdbId,
        type: item.type,
        title: item.title,
        originalTitle: item.originalTitle,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        releaseYear: item.releaseYear,
        rating: item.rating,
        genres: item.genres,
        runtime: item.runtime,
        status: 'published',
        sourceOrigin: 'seed',
        sourcesCount: item.sources.length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await parentsBatch.commit();

    const childrenBatch = writeBatch(db);
    for (const item of seeds) {
      for (const s of item.sources) {
        const srcId = makeSourceId(s.streamUrl, s.season, s.episode);
        childrenBatch.set(doc(db, 'media_items', item.mediaKey, 'sources', srcId), {
          mediaKey: item.mediaKey,
          ownerId: uid,
          parentStatus: 'published',
          season: s.season,
          episode: s.episode,
          episodeTitle: s.episodeTitle,
          streamUrl: s.streamUrl,
          quality: s.quality,
          format: s.format,
          language: s.language,
          isWorking: true,
          originProvider: s.originProvider,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    childrenBatch.set(doc(db, 'import_jobs', `seed_${Date.now()}`), {
      ownerId: uid,
      sourceType: 'm3u_url',
      sourceName: 'Catálogo Inicial Multi-Fontes',
      sourceUrl: '',
      totalFound: 4,
      importedCount: 7,
      skippedCount: 0,
      failedCount: 0,
      status: 'completed',
      logs: ['4 títulos iniciais sincronizados no Cloud Firestore.'],
      createdAt: serverTimestamp(),
    });

    await childrenBatch.commit();
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribePublishedCatalog(
  onData: (items: MediaItemRecord[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = 'media_items';
  const q = query(collection(db, path), where('status', '==', 'published'));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs
        .map((d) => mapMediaDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      onData(items);
    },
    (error) => {
      if (onError) onError(error);
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeUserApiKeys(
  uid: string,
  onData: (keys: ApiKeyRecord[]) => void
): Unsubscribe {
  const path = 'api_keys';
  const q = query(collection(db, path), where('ownerId', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const keys: ApiKeyRecord[] = snapshot.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ownerId: String(data.ownerId || ''),
            label: String(data.label || ''),
            apiKey: String(data.apiKey || d.id),
            allowedDomains: String(data.allowedDomains || '*'),
            requestsCount: Number(data.requestsCount || 0),
            status: (data.status === 'revoked' ? 'revoked' : 'active') as 'active' | 'revoked',
            createdAt: timestampToIso(data.createdAt),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(keys);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeUserImportJobs(
  uid: string,
  onData: (jobs: ImportJobRecord[]) => void
): Unsubscribe {
  const path = 'import_jobs';
  const q = query(collection(db, path), where('ownerId', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const jobs: ImportJobRecord[] = snapshot.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ownerId: String(data.ownerId || ''),
            sourceType: (data.sourceType as ImportJobRecord['sourceType']) || 'm3u_text',
            sourceName: String(data.sourceName || ''),
            sourceUrl: String(data.sourceUrl || ''),
            totalFound: Number(data.totalFound || 0),
            importedCount: Number(data.importedCount || 0),
            skippedCount: Number(data.skippedCount || 0),
            failedCount: Number(data.failedCount || 0),
            status: (data.status === 'failed' ? 'failed' : 'completed') as 'completed' | 'failed',
            logs: Array.isArray(data.logs) ? data.logs.map(String) : [],
            createdAt: timestampToIso(data.createdAt),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(jobs);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function getMediaItemWithSources(mediaKey: string): Promise<MediaItemRecord | null> {
  const itemPath = `media_items/${mediaKey}`;
  try {
    const snap = await getDoc(doc(db, 'media_items', mediaKey));
    if (!snap.exists()) return null;
    const item = mapMediaDoc(snap.id, snap.data() as Record<string, unknown>);

    const sourcesSnap = await getDocs(
      query(collection(db, 'media_items', mediaKey, 'sources'), where('parentStatus', '==', item.status))
    );
    item.sources = sourcesSnap.docs
      .map((s) => mapSourceDoc(s.id, s.data() as Record<string, unknown>))
      .sort((a, b) => a.season - b.season || a.episode - b.episode);

    return item;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, itemPath);
  }
}

export interface IngestEntryPayload {
  tmdbId: number;
  imdbId?: string;
  type: MediaType;
  title: string;
  originalTitle?: string;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
  releaseYear?: number | null;
  rating?: number | null;
  genres?: string[];
  runtime?: number | null;
  sourceOrigin: SourceOrigin;
  season: number;
  episode: number;
  episodeTitle: string;
  streamUrl: string;
  quality: string;
  format: StreamFormat;
  language: string;
  originProvider: string;
}

export async function saveIngestedBatchToFirestore(
  uid: string,
  entries: IngestEntryPayload[],
  jobMeta: {
    sourceType: ImportJobRecord['sourceType'];
    sourceName: string;
    sourceUrl?: string;
    totalFound: number;
    failedCount: number;
    extraLogs?: string[];
  }
): Promise<{ importedCount: number; skippedCount: number }> {
  const path = 'media_items';
  try {
    // Group entries by mediaKey
    const grouped = new Map<string, { meta: IngestEntryPayload; entries: IngestEntryPayload[] }>();
    for (const entry of entries) {
      const key = `${entry.type}_${entry.tmdbId}`;
      const existingGroup = grouped.get(key);
      if (existingGroup) {
        existingGroup.entries.push(entry);
      } else {
        grouped.set(key, { meta: entry, entries: [entry] });
      }
    }

    let importedCount = 0;
    let skippedCount = 0;

    const groupList = Array.from(grouped.entries());
    const CONCURRENCY = 10;

    for (let w = 0; w < groupList.length; w += CONCURRENCY) {
      const wave = groupList.slice(w, w + CONCURRENCY);
      const waveCounts = await Promise.all(
        wave.map(async ([mediaKey, group]) => {
          let localImported = 0;
          let localSkipped = 0;

          const mediaRef = doc(db, 'media_items', mediaKey);
          const existingMedia = await getDoc(mediaRef);
          const existingSourcesSnap = existingMedia.exists()
            ? await getDocs(
                query(
                  collection(db, 'media_items', mediaKey, 'sources'),
                  where('parentStatus', '==', String(existingMedia.data().status || 'published'))
                )
              )
            : null;

          const existingIds = new Set<string>(
            existingSourcesSnap ? existingSourcesSnap.docs.map((d) => d.id) : []
          );
          const newSources: Array<{ id: string; entry: IngestEntryPayload }> = [];

          for (const entry of group.entries) {
            const srcId = makeSourceId(entry.streamUrl, entry.season, entry.episode);
            if (existingIds.has(srcId)) {
              localSkipped++;
            } else {
              existingIds.add(srcId);
              newSources.push({ id: srcId, entry });
            }
          }

          const m = group.meta;
          const totalSourcesForItem = existingIds.size;

          if (!existingMedia.exists()) {
            await setDoc(mediaRef, {
              ownerId: uid,
              tmdbId: Math.max(1, Math.trunc(m.tmdbId)),
              imdbId: clampString(m.imdbId, 32),
              type: m.type,
              title: clampString(m.title, 200) || `TMDB ${m.tmdbId}`,
              originalTitle: clampString(m.originalTitle, 200),
              overview: clampString(m.overview, 2000),
              posterUrl: clampString(m.posterUrl, 500),
              backdropUrl: clampString(m.backdropUrl || m.posterUrl, 500),
              releaseYear:
                m.releaseYear && m.releaseYear >= 1900 && m.releaseYear <= 2100
                  ? Math.trunc(m.releaseYear)
                  : 0,
              rating:
                typeof m.rating === 'number'
                  ? Math.min(10, Math.max(0, Number(m.rating.toFixed(1))))
                  : 0,
              genres: (m.genres || []).slice(0, 10).map((g) => clampString(g, 40)).filter(Boolean),
              runtime: m.runtime && m.runtime >= 0 ? Math.min(2000, Math.trunc(m.runtime)) : 0,
              status: 'published',
              sourceOrigin: m.sourceOrigin,
              sourcesCount: totalSourcesForItem,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } else if (newSources.length > 0) {
            const prev = existingMedia.data();
            await updateDoc(mediaRef, {
              title: clampString(m.title, 200) || String(prev.title || ''),
              overview: String(prev.overview || '') || clampString(m.overview, 2000),
              posterUrl: String(prev.posterUrl || '') || clampString(m.posterUrl, 500),
              backdropUrl: String(prev.backdropUrl || '') || clampString(m.backdropUrl || m.posterUrl, 500),
              sourcesCount: totalSourcesForItem,
              updatedAt: serverTimestamp(),
            });
          }

          if (newSources.length > 0) {
            const CHUNK_SIZE = 400;
            for (let i = 0; i < newSources.length; i += CHUNK_SIZE) {
              const chunk = newSources.slice(i, i + CHUNK_SIZE);
              const batch = writeBatch(db);
              for (const { id: srcId, entry } of chunk) {
                batch.set(doc(db, 'media_items', mediaKey, 'sources', srcId), {
                  mediaKey,
                  ownerId: uid,
                  parentStatus: 'published',
                  season: entry.type === 'tv' ? Math.max(1, Math.trunc(entry.season || 1)) : 0,
                  episode: entry.type === 'tv' ? Math.max(1, Math.trunc(entry.episode || 1)) : 0,
                  episodeTitle: clampString(entry.episodeTitle, 200),
                  streamUrl: clampString(entry.streamUrl, 1000),
                  quality: clampString(entry.quality || '1080p', 20),
                  format: entry.format || 'hls',
                  language: clampString(entry.language || 'PT-BR', 20),
                  isWorking: true,
                  originProvider: clampString(entry.originProvider || jobMeta.sourceName, 100),
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                });
                localImported++;
              }
              await batch.commit();
            }
          }

          return { localImported, localSkipped };
        })
      );

      for (const c of waveCounts) {
        importedCount += c.localImported;
        skippedCount += c.localSkipped;
      }
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const logs = [
      `Processados ${entries.length} registros para o Cloud Firestore.`,
      `${importedCount} novos streams salvos; ${skippedCount} duplicados ignorados.`,
      ...(jobMeta.extraLogs || []),
    ]
      .slice(0, 20)
      .map((l) => clampString(l, 240));

    await setDoc(doc(db, 'import_jobs', jobId), {
      ownerId: uid,
      sourceType: jobMeta.sourceType,
      sourceName: clampString(jobMeta.sourceName || 'Importação', 120),
      sourceUrl: clampString(jobMeta.sourceUrl, 600),
      totalFound: Math.max(0, jobMeta.totalFound),
      importedCount,
      skippedCount,
      failedCount: Math.max(0, jobMeta.failedCount),
      status: 'completed',
      logs,
      createdAt: serverTimestamp(),
    });

    return { importedCount, skippedCount };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function addSourceToMedia(
  uid: string,
  mediaItem: MediaItemRecord,
  input: {
    streamUrl: string;
    quality: string;
    language: string;
    season: number;
    episode: number;
    episodeTitle: string;
  }
): Promise<void> {
  const mediaKey = mediaItem.id;
  const season = mediaItem.type === 'tv' ? Math.max(1, input.season) : 0;
  const episode = mediaItem.type === 'tv' ? Math.max(1, input.episode) : 0;
  const srcId = makeSourceId(input.streamUrl.trim(), season, episode);
  const srcPath = `media_items/${mediaKey}/sources/${srcId}`;

  try {
    const format: StreamFormat = input.streamUrl.toLowerCase().includes('.m3u8') ? 'hls' : 'mp4';
    const srcRef = doc(db, 'media_items', mediaKey, 'sources', srcId);
    const existingSrc = await getDoc(srcRef);
    if (existingSrc.exists()) {
      await updateDoc(srcRef, {
        parentStatus: mediaItem.status,
        season,
        episode,
        episodeTitle: clampString(input.episodeTitle, 200),
        streamUrl: clampString(input.streamUrl.trim(), 1000),
        quality: clampString(input.quality || '1080p', 20),
        format,
        language: clampString(input.language || 'PT-BR', 20),
        isWorking: true,
        originProvider: 'Manual',
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(srcRef, {
        mediaKey,
        ownerId: uid,
        parentStatus: mediaItem.status,
        season,
        episode,
        episodeTitle: clampString(input.episodeTitle, 200),
        streamUrl: clampString(input.streamUrl.trim(), 1000),
        quality: clampString(input.quality || '1080p', 20),
        format,
        language: clampString(input.language || 'PT-BR', 20),
        isWorking: true,
        originProvider: 'Manual',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const sourcesSnap = await getDocs(
      query(collection(db, 'media_items', mediaKey, 'sources'), where('parentStatus', '==', mediaItem.status))
    );
    await updateDoc(doc(db, 'media_items', mediaKey), {
      sourcesCount: sourcesSnap.size,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, srcPath);
  }
}

export async function deleteSourceFromMedia(mediaItem: MediaItemRecord, sourceId: string): Promise<void> {
  const mediaKey = mediaItem.id;
  const srcPath = `media_items/${mediaKey}/sources/${sourceId}`;
  try {
    await deleteDoc(doc(db, 'media_items', mediaKey, 'sources', sourceId));
    const sourcesSnap = await getDocs(
      query(collection(db, 'media_items', mediaKey, 'sources'), where('parentStatus', '==', mediaItem.status))
    );
    await updateDoc(doc(db, 'media_items', mediaKey), {
      sourcesCount: sourcesSnap.size,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, srcPath);
  }
}

export async function updateSourceHealth(
  mediaKey: string,
  sourceId: string,
  isWorking: boolean
): Promise<void> {
  const srcPath = `media_items/${mediaKey}/sources/${sourceId}`;
  try {
    await updateDoc(doc(db, 'media_items', mediaKey, 'sources', sourceId), {
      isWorking,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, srcPath);
  }
}

export async function deleteMediaItem(mediaKey: string, status: MediaStatus): Promise<void> {
  const mediaPath = `media_items/${mediaKey}`;
  try {
    const sourcesSnap = await getDocs(
      query(collection(db, 'media_items', mediaKey, 'sources'), where('parentStatus', '==', status))
    );
    const batch = writeBatch(db);
    for (const s of sourcesSnap.docs) {
      batch.delete(s.ref);
    }
    batch.delete(doc(db, 'media_items', mediaKey));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, mediaPath);
  }
}

export async function createUserApiKey(
  uid: string,
  label: string,
  allowedDomains: string
): Promise<string> {
  const newKey = generateClientApiKey();
  const path = `api_keys/${newKey}`;
  try {
    await setDoc(doc(db, 'api_keys', newKey), {
      ownerId: uid,
      label: clampString(label, 80),
      apiKey: newKey,
      allowedDomains: clampString(allowedDomains || '*', 300),
      requestsCount: 0,
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return newKey;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function toggleUserApiKeyStatus(key: ApiKeyRecord): Promise<void> {
  const path = `api_keys/${key.id}`;
  try {
    await updateDoc(doc(db, 'api_keys', key.id), {
      status: key.status === 'active' ? 'revoked' : 'active',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteUserApiKey(keyId: string): Promise<void> {
  const path = `api_keys/${keyId}`;
  try {
    await deleteDoc(doc(db, 'api_keys', keyId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function loadUserTmdbSecret(uid: string): Promise<string> {
  const path = `users/${uid}/secrets/tmdb`;
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'secrets', 'tmdb'));
    if (!snap.exists()) return '';
    return String(snap.data().tmdbApiKey || '');
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveUserTmdbSecret(uid: string, tmdbApiKey: string): Promise<void> {
  const path = `users/${uid}/secrets/tmdb`;
  try {
    await setDoc(doc(db, 'users', uid, 'secrets', 'tmdb'), {
      ownerId: uid,
      tmdbApiKey: clampString(tmdbApiKey, 200),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadPlatformSettings(): Promise<PlatformSettings> {
  const path = 'settings/platform';
  try {
    const snap = await getDoc(doc(db, 'settings', 'platform'));
    if (!snap.exists()) {
      return {
        tmdbConfigured: false,
        tmdbKeyPreview: '',
        defaultPlayerColor: '#2563EB',
        allowPublicRegistration: true,
        requireApiKeyForEmbed: false,
        embedWatermarkText: 'CineVault Player',
      };
    }
    const d = snap.data();
    return {
      tmdbConfigured: Boolean(d.tmdbConfigured),
      tmdbKeyPreview: '',
      defaultPlayerColor: String(d.defaultPlayerColor || '#2563EB'),
      allowPublicRegistration: d.allowPublicRegistration !== false,
      requireApiKeyForEmbed: Boolean(d.requireApiKeyForEmbed),
      embedWatermarkText: String(d.embedWatermarkText || 'CineVault Player'),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function savePlatformSettings(input: {
  defaultPlayerColor: string;
  allowPublicRegistration: boolean;
  requireApiKeyForEmbed: boolean;
  embedWatermarkText: string;
  tmdbConfigured: boolean;
}): Promise<void> {
  const path = 'settings/platform';
  try {
    await setDoc(doc(db, 'settings', 'platform'), {
      defaultPlayerColor: clampString(input.defaultPlayerColor, 7) || '#2563EB',
      allowPublicRegistration: input.allowPublicRegistration,
      requireApiKeyForEmbed: input.requireApiKeyForEmbed,
      embedWatermarkText: clampString(input.embedWatermarkText, 40) || 'CineVault Player',
      tmdbConfigured: input.tmdbConfigured,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrimarySourceEntries,
  DEFAULT_MOVIE_EMBED_TEMPLATE,
  DEFAULT_TV_EMBED_TEMPLATE,
  expandEmbedTemplate,
  extractMediaStreamsFromDocument,
  parseEmbedTargetsInput,
} from './embedSourceParser.ts';

test('expandEmbedTemplate replaces movie and tv placeholders cleanly', () => {
  assert.equal(
    expandEmbedTemplate(DEFAULT_MOVIE_EMBED_TEMPLATE, { type: 'movie', tmdbId: 550 }),
    'https://embedmaster.link/movie/550'
  );
  assert.equal(
    expandEmbedTemplate(DEFAULT_TV_EMBED_TEMPLATE, {
      type: 'tv',
      tmdbId: 1399,
      season: 2,
      episode: 9,
    }),
    'https://embedmaster.link/tv/1399/2/9'
  );
});

test('parseEmbedTargetsInput parses embedmaster URLs, episode ranges, and shorthand specs', () => {
  const input = `
    # Filmes e séries
    https://embedmaster.link/movie/550
    https://embedmaster.link/tv/1399/1/1-3
    tv:94997:S01:E01-E02
    603, 27205
  `;
  const targets = parseEmbedTargetsInput(input);
  assert.equal(targets.length, 8);

  assert.deepEqual(targets[0], {
    type: 'movie',
    tmdbId: 550,
    season: 0,
    episode: 0,
    url: 'https://embedmaster.link/movie/550',
  });

  assert.equal(targets[1].type, 'tv');
  assert.equal(targets[1].tmdbId, 1399);
  assert.equal(targets[1].season, 1);
  assert.equal(targets[1].episode, 1);
  assert.equal(targets[3].episode, 3);
  assert.equal(targets[3].url, 'https://embedmaster.link/tv/1399/1/3');

  assert.equal(targets[4].tmdbId, 94997);
  assert.equal(targets[4].url, 'https://embedmaster.link/tv/94997/1/1');
  assert.equal(targets[5].episode, 2);

  assert.equal(targets[6].type, 'movie');
  assert.equal(targets[6].tmdbId, 603);
  assert.equal(targets[6].url, 'https://embedmaster.link/movie/603');
  assert.equal(targets[7].tmdbId, 27205);
});

test('extractMediaStreamsFromDocument extracts escaped HLS, base64 MP4, and ignores ad iframes', () => {
  const b64Mp4 = Buffer.from('https://cdn.example.org/videos/clube-da-luta-4k.mp4?sig=99', 'utf8').toString('base64');
  const html = `
    <html>
      <body>
        <iframe src="https://ads.googlesyndication.com/banner.html"></iframe>
        <iframe src="//player-inner.example.org/e/550?lang=ptbr"></iframe>
        <script>
          const decoded = atob("${b64Mp4}");
          jwplayer("player").setup({
            sources: [
              {"file":"https:\\/\\/edge1.example.org\\/streams\\/550\\/master.m3u8?token=xyz","label":"1080p DUAL","type":"hls"}
            ]
          });
        </script>
      </body>
    </html>
  `;

  const artifacts = extractMediaStreamsFromDocument(html, 'https://embedmaster.link/movie/550');

  assert.equal(artifacts.streams.length, 2);
  assert.equal(artifacts.streams[0].format, 'hls');
  assert.equal(artifacts.streams[0].url, 'https://edge1.example.org/streams/550/master.m3u8?token=xyz');
  assert.equal(artifacts.streams[0].quality, '1080p');
  assert.equal(artifacts.streams[0].language, 'DUAL');

  assert.equal(artifacts.streams[1].format, 'mp4');
  assert.equal(artifacts.streams[1].url, 'https://cdn.example.org/videos/clube-da-luta-4k.mp4?sig=99');
  assert.equal(artifacts.streams[1].quality, '4K');

  assert.deepEqual(artifacts.iframeHops, ['https://player-inner.example.org/e/550?lang=ptbr']);
});

test('extractMediaStreamsFromDocument resolves relative streams and api source hints', () => {
  const html = `
    <video controls><source src="/demo/stream.mp4" type="video/mp4"></video>
    <script>
      fetch('/api/source/1399-1-1').then(r => r.json());
    </script>
  `;
  const artifacts = extractMediaStreamsFromDocument(html, 'http://localhost:3000/demo/mock-embed/tv/1399/1/1');
  assert.equal(artifacts.streams.length, 1);
  assert.equal(artifacts.streams[0].url, 'http://localhost:3000/demo/stream.mp4');
  assert.equal(artifacts.streams[0].format, 'mp4');
  assert.deepEqual(artifacts.jsonCandidates, ['http://localhost:3000/api/source/1399-1-1']);
});

test('buildPrimarySourceEntries wires discovered movies and series episodes to extracted streams or primary embed URLs', () => {
  const directMap = new Map([
    [
      'movie:550:0:0',
      [{ url: 'https://cdn.example.org/550/master.m3u8', format: 'hls' as const, quality: '4K', language: 'DUAL' }],
    ],
  ]);

  const entries = buildPrimarySourceEntries(
    [
      {
        tmdbId: 550,
        type: 'movie',
        title: 'Clube da Luta',
        genres: ['Drama'],
      },
      {
        tmdbId: 1399,
        type: 'tv',
        title: 'Game of Thrones',
        episodes: [
          { season: 1, episode: 1, episodeTitle: 'Winter Is Coming' },
          { season: 1, episode: 2, episodeTitle: 'The Kingsroad' },
        ],
      },
    ],
    {
      movieTemplate: DEFAULT_MOVIE_EMBED_TEMPLATE,
      tvTemplate: DEFAULT_TV_EMBED_TEMPLATE,
      sourceName: 'EmbedMaster (Fonte Principal)',
      extractedStreamsByTarget: directMap,
      allowEmbedFallback: true,
    }
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[0].format, 'hls');
  assert.equal(entries[0].streamUrl, 'https://cdn.example.org/550/master.m3u8');

  assert.equal(entries[1].type, 'tv');
  assert.equal(entries[1].season, 1);
  assert.equal(entries[1].episode, 1);
  assert.equal(entries[1].format, 'embed');
  assert.equal(entries[1].streamUrl, 'https://embedmaster.link/tv/1399/1/1');

  assert.equal(entries[2].episode, 2);
  assert.equal(entries[2].streamUrl, 'https://embedmaster.link/tv/1399/1/2');
});


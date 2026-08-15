jest.mock('axios');
const axios = require('axios');
const { mapSpotifyTrack, sanitizeSpotifyTrack, searchTracks } = require('../spotifyService');

function spotifyApiItem(overrides = {}) {
  return {
    id: '3n3Ppam7vgaVa1iaRUc9Lp',
    name: 'Mr. Brightside',
    preview_url: 'https://p.scdn.co/mp3-preview/abc123',
    duration_ms: 222973,
    artists: [{ name: 'The Killers' }],
    album: {
      name: 'Hot Fuss',
      images: [
        { url: 'https://i.scdn.co/image/large' },
        { url: 'https://i.scdn.co/image/small' },
      ],
    },
    external_urls: { spotify: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp' },
    ...overrides,
  };
}

describe('spotifyService — mapSpotifyTrack', () => {
  test('normalise un item de recherche Spotify vers notre forme', () => {
    const track = mapSpotifyTrack(spotifyApiItem());
    expect(track).toEqual({
      id: '3n3Ppam7vgaVa1iaRUc9Lp',
      name: 'Mr. Brightside',
      artist: 'The Killers',
      albumName: 'Hot Fuss',
      albumArt: 'https://i.scdn.co/image/small',
      previewUrl: 'https://p.scdn.co/mp3-preview/abc123',
      externalUrl: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp',
      durationMs: 222973,
    });
  });

  test('joint plusieurs artistes avec une virgule', () => {
    const track = mapSpotifyTrack(spotifyApiItem({
      artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
    }));
    expect(track.artist).toBe('Artist A, Artist B');
  });

  test('gère un item sans pochette', () => {
    const track = mapSpotifyTrack(spotifyApiItem({ album: { name: 'Single', images: [] } }));
    expect(track.albumArt).toBeNull();
  });

  test('renvoie null pour une entrée invalide', () => {
    expect(mapSpotifyTrack(null)).toBeNull();
    expect(mapSpotifyTrack(undefined)).toBeNull();
  });
});

describe('spotifyService — sanitizeSpotifyTrack', () => {
  test('accepte un morceau bien formé venant du client', () => {
    const clean = sanitizeSpotifyTrack({
      id: '3n3Ppam7vgaVa1iaRUc9Lp',
      name: 'Mr. Brightside',
      artist: 'The Killers',
      albumName: 'Hot Fuss',
      albumArt: 'https://i.scdn.co/image/small',
      previewUrl: 'https://p.scdn.co/mp3-preview/abc123',
      externalUrl: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp',
      durationMs: 222973,
    });
    expect(clean).not.toBeNull();
    expect(clean.id).toBe('3n3Ppam7vgaVa1iaRUc9Lp');
  });

  test('rejette un externalUrl qui ne pointe pas vers Spotify', () => {
    const clean = sanitizeSpotifyTrack({
      id: '1',
      name: 'Track',
      externalUrl: 'https://evil.example.com/track/1',
    });
    expect(clean).toBeNull();
  });

  test('neutralise une albumArt/previewUrl hors des domaines Spotify au lieu de la stocker', () => {
    const clean = sanitizeSpotifyTrack({
      id: '1',
      name: 'Track',
      externalUrl: 'https://open.spotify.com/track/1',
      albumArt: 'https://evil.example.com/tracker.png',
      previewUrl: 'https://evil.example.com/tracker.mp3',
    });
    expect(clean).not.toBeNull();
    expect(clean.albumArt).toBeNull();
    expect(clean.previewUrl).toBeNull();
  });

  test('rejette une entrée sans id ni name', () => {
    expect(sanitizeSpotifyTrack({ externalUrl: 'https://open.spotify.com/track/1' })).toBeNull();
    expect(sanitizeSpotifyTrack(null)).toBeNull();
    expect(sanitizeSpotifyTrack('not an object')).toBeNull();
  });

  test('accepte un previewUrl iTunes (repli quand Spotify n\'en fournit pas)', () => {
    const clean = sanitizeSpotifyTrack({
      id: '1',
      name: 'Track',
      externalUrl: 'https://open.spotify.com/track/1',
      previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/abc.m4a',
    });
    expect(clean).not.toBeNull();
    expect(clean.previewUrl).toBe('https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/abc.m4a');
  });
});

describe('spotifyService — searchTracks (repli iTunes)', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...OLD_ENV, SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('complète previewUrl via iTunes quand Spotify ne le fournit pas', async () => {
    axios.post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 3600 } });
    axios.get.mockImplementation((url) => {
      if (url === 'https://api.spotify.com/v1/search') {
        return Promise.resolve({
          data: {
            tracks: {
              items: [spotifyApiItem({ preview_url: null })],
            },
          },
        });
      }
      if (url === 'https://itunes.apple.com/search') {
        return Promise.resolve({
          data: { results: [{ previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/x.m4a' }] },
        });
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const tracks = await searchTracks('mr brightside');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].previewUrl).toBe('https://audio-ssl.itunes.apple.com/itunes-assets/x.m4a');
  });

  test('ne casse pas la recherche si le repli iTunes échoue', async () => {
    axios.post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 3600 } });
    axios.get.mockImplementation((url) => {
      if (url === 'https://api.spotify.com/v1/search') {
        return Promise.resolve({
          data: { tracks: { items: [spotifyApiItem({ preview_url: null })] } },
        });
      }
      if (url === 'https://itunes.apple.com/search') {
        return Promise.reject(new Error('timeout'));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const tracks = await searchTracks('mr brightside');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].previewUrl).toBeNull();
  });
});

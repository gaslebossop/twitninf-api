const { mapSpotifyTrack, sanitizeSpotifyTrack } = require('../spotifyService');

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
});

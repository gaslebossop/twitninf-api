/**
 * La place dessinée doit rester SCANNABLE.
 *
 * Ce test rend le SVG en image (sharp/librsvg, la même conversion que la route
 * PNG) et relit le code avec un décodeur indépendant. C'est le seul garde-fou
 * qui attrape les régressions d'esthétique : la première version colorait les
 * pupilles des motifs de repérage en or pour le palier VIP, ce qui rendait la
 * place indétectable sans que rien ne se voie à l'œil.
 */

const sharp = require('sharp');
const jsQR = require('jsqr');
const { renderPassSvg, renderQrOnlySvg, TIERS } = require('../passArt');

const PAYLOAD = 'HTTPS://TWITNINF.DUCKDNS.ORG/I/NINF7K3D9QW2H4X8M2';

const BASE_PASS = {
  code: 'NINF-7K3D-9QW2',
  serial: 42,
  guest_name: 'Théo Mabiala',
  tier: 'standard',
  event_name: 'Nuit TwitNinf · Brazzaville',
  event_date: 'Sam. 12 sept. · 20h00',
  event_place: 'Institut français',
};

async function decodeSvg(svg, width = 720) {
  const png = await sharp(Buffer.from(svg)).resize({ width }).png().toBuffer();
  const { data, info } = await sharp(png)
    .flatten({ background: '#ffffff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return result ? result.data : null;
}

describe('place d’invitation', () => {
  jest.setTimeout(30000);

  test.each(Object.keys(TIERS))('reste lisible au palier %s', async (tier) => {
    const svg = renderPassSvg({ ...BASE_PASS, tier }, PAYLOAD);
    await expect(decodeSvg(svg)).resolves.toBe(PAYLOAD);
  });

  it('reste lisible imprimée en petit', async () => {
    const svg = renderPassSvg(BASE_PASS, PAYLOAD);
    await expect(decodeSvg(svg, 420)).resolves.toBe(PAYLOAD);
  });

  it('reste lisible sans invité ni lieu', async () => {
    const svg = renderPassSvg(
      { ...BASE_PASS, guest_name: null, event_place: null, event_date: null },
      PAYLOAD
    );
    await expect(decodeSvg(svg)).resolves.toBe(PAYLOAD);
  });

  it('rend le code seul, pour l’affichage plein écran', async () => {
    await expect(decodeSvg(renderQrOnlySvg(PAYLOAD), 560)).resolves.toBe(PAYLOAD);
  });

  /**
   * Le nom de l'invité vient d'un formulaire. Le SVG est servi tel quel par
   * l'API : un nom contenant du balisage ne doit pas en devenir.
   */
  it('échappe les textes saisis par un humain', () => {
    const svg = renderPassSvg(
      { ...BASE_PASS, guest_name: '<script>x</script>', event_name: 'Soirée "R&D" <b>' },
      PAYLOAD
    );
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp;');
  });

  it('ne dépasse jamais deux lignes de titre', () => {
    const svg = renderPassSvg(
      { ...BASE_PASS, event_name: 'Un nom d’événement particulièrement long qui ne tient pas sur deux lignes du tout' },
      PAYLOAD
    );
    const titles = svg.match(/font-size="52"/g) || [];
    expect(titles.length).toBeLessThanOrEqual(2);
  });
});

const { computeEffectiveViews } = require('../exploreViewsHelpers');

describe('exploreViewsHelpers — computeEffectiveViews', () => {
  test('vue seule (fil) : aucune vue Explorer, aucun clic', () => {
    const views = computeEffectiveViews({ rawViews: 42, exploreViews: 0, exploreClicks: 0 });
    expect(views).toBe(42);
  });

  test('clic seul (Explorer) : un clic compte double une vue normale', () => {
    // 10 vues Explorer parmi 10 vues totales, converties en 3 clics :
    // (10 - 10) + 3*2 = 6
    const views = computeEffectiveViews({ rawViews: 10, exploreViews: 10, exploreClicks: 3 });
    expect(views).toBe(6);
  });

  test('mélange fil + Explorer : les vues hors Explorer restent comptées normalement', () => {
    // 100 vues totales dont 30 via Explorer, 5 clics Explorer :
    // (100 - 30) + 5*2 = 80
    const views = computeEffectiveViews({ rawViews: 100, exploreViews: 30, exploreClicks: 5 });
    expect(views).toBe(80);
  });

  test('compteurs incohérents (explore_view_count > view_count) : jamais négatif', () => {
    // Course entre deux requêtes concurrentes : exploreViews dépasse rawViews.
    const views = computeEffectiveViews({ rawViews: 5, exploreViews: 12, exploreClicks: 0 });
    expect(views).toBe(0);
  });

  test('valeurs manquantes/undefined traitées comme zéro', () => {
    const views = computeEffectiveViews({});
    expect(views).toBe(0);
  });
});

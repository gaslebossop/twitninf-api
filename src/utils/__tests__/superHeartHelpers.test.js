const { TIER } = require('../subscriptionHelpers');
const {
  SUPER_HEART_CAPS,
  isSuperHeartEligible,
  maybeRenewSuperHearts,
} = require('../superHeartHelpers');

function makeUser(overrides = {}) {
  return {
    subscription_tier: TIER.FREE,
    subscription_expires_at: null,
    super_hearts_remaining: 0,
    super_hearts_renew_at: null,
    save: jest.fn(async function save() { return this; }),
    ...overrides,
  };
}

describe('superHeartHelpers — plafonds par palier', () => {
  test('Pro et Plus sont éligibles, Free ne l’est pas', () => {
    const future = new Date(Date.now() + 86400000);
    expect(isSuperHeartEligible(makeUser({ subscription_tier: TIER.PRO, subscription_expires_at: future }))).toBe(true);
    expect(isSuperHeartEligible(makeUser({ subscription_tier: TIER.PLUS, subscription_expires_at: future }))).toBe(true);
    expect(isSuperHeartEligible(makeUser({ subscription_tier: TIER.FREE }))).toBe(false);
  });

  test('le renouvellement Pro pose 10, Plus pose 3', async () => {
    const future = new Date(Date.now() + 86400000);

    const pro = makeUser({ subscription_tier: TIER.PRO, subscription_expires_at: future });
    await maybeRenewSuperHearts(pro);
    expect(pro.super_hearts_remaining).toBe(10);
    expect(pro.super_hearts_remaining).toBe(SUPER_HEART_CAPS[TIER.PRO]);

    const plus = makeUser({ subscription_tier: TIER.PLUS, subscription_expires_at: future });
    await maybeRenewSuperHearts(plus);
    expect(plus.super_hearts_remaining).toBe(3);
    expect(plus.super_hearts_remaining).toBe(SUPER_HEART_CAPS[TIER.PLUS]);
  });

  test('un compte Free retombe à 0 sans date de renouvellement', async () => {
    const user = makeUser({
      subscription_tier: TIER.FREE,
      super_hearts_remaining: 5,
      super_hearts_renew_at: new Date(Date.now() + 86400000),
    });
    const changed = await maybeRenewSuperHearts(user);
    expect(changed).toBe(true);
    expect(user.super_hearts_remaining).toBe(0);
    expect(user.super_hearts_renew_at).toBeNull();
  });

  test('pas encore l’heure du renouvellement -> rien ne bouge', async () => {
    const future = new Date(Date.now() + 86400000);
    const user = makeUser({
      subscription_tier: TIER.PRO,
      subscription_expires_at: new Date(Date.now() + 30 * 86400000),
      super_hearts_remaining: 4,
      super_hearts_renew_at: future,
    });
    const changed = await maybeRenewSuperHearts(user);
    expect(changed).toBe(false);
    expect(user.super_hearts_remaining).toBe(4);
  });
});

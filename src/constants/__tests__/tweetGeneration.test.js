'use strict';

const {
  SUBSCRIPTION_TWEET_CREDITS,
  TWEET_GENERATION_COST,
  creditsAfterSubscriptionPurchase,
} = require('../tweetGeneration');

describe('tweet generation credits', () => {
  test('chaque achat confirmé ajoute exactement cinq crédits', () => {
    expect(SUBSCRIPTION_TWEET_CREDITS).toBe(5);
    expect(creditsAfterSubscriptionPurchase(0)).toBe(5);
    expect(creditsAfterSubscriptionPurchase(3)).toBe(8);
  });

  test('une génération coûte exactement un crédit', () => {
    expect(TWEET_GENERATION_COST).toBe(1);
  });

  test('un ancien solde absent ou invalide repart de zéro', () => {
    expect(creditsAfterSubscriptionPurchase(null)).toBe(5);
    expect(creditsAfterSubscriptionPurchase(-4)).toBe(5);
    expect(creditsAfterSubscriptionPurchase('invalide')).toBe(5);
  });
});

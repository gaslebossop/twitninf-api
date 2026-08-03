const transactionAuthorizationService = require('../transactionAuthorizationService');

function decision(overrides = {}) {
  return {
    authorization_id: 'auth-1',
    request_hash: 'hash-1',
    decision: 'REVIEW',
    risk_score: 90,
    confidence: 0.6,
    wallet_action: 'RESTRICT',
    valid_for_seconds: 0,
    reasons: ['wallet_drain_pattern', 'shared_network_cluster'],
    signals: [],
    engine_version: 'transaction-guard-1.0.0',
    ...overrides,
  };
}

describe('TransactionAuthorizationService manual trust', () => {
  test('authorizes reviewed statistical risk during an active manual trust window', () => {
    const result = transactionAuthorizationService._applyManualTrustOverride(
      decision(),
      { manual_trust_active: true }
    );

    expect(result.decision).toBe('APPROVE');
    expect(result.wallet_action).toBe('NONE');
    expect(result.risk_score).toBe(0);
    expect(result.reasons).toEqual(['manual_review_approved']);
  });

  test('keeps integrity blocks even during an active manual trust window', () => {
    const original = decision({
      decision: 'DECLINE',
      reasons: ['coordinated_payment_fraud'],
    });
    const result = transactionAuthorizationService._applyManualTrustOverride(
      original,
      { manual_trust_active: true }
    );

    expect(result).toBe(original);
  });

  test('does not change decisions outside the manual trust window', () => {
    const original = decision();
    const result = transactionAuthorizationService._applyManualTrustOverride(
      original,
      { manual_trust_active: false }
    );

    expect(result).toBe(original);
  });
});

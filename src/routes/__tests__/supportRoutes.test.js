const express = require('express');
const request = require('supertest');

const mockFindAll = jest.fn();
const mockLiteral = jest.fn((value) => ({ value }));

jest.mock('../../middleware/authMiddleware', () => ({
  authenticateToken: (req, _res, next) => {
    req.user = { id: 'staff-1', role: 'moderateur' };
    next();
  },
  requireModeratorRole: (_req, _res, next) => next(),
}));

jest.mock('../../models', () => ({
  SupportTicket: { findAll: mockFindAll },
  SupportTicketMessage: {},
  User: {},
  Notification: {},
  sequelize: { literal: mockLiteral },
}));

jest.mock('../../utils/subscriptionHelpers', () => ({
  maybeExpireSubscription: jest.fn(),
  isSubscriptionActive: jest.fn(() => false),
}));

const supportRoutes = require('../supportRoutes');

describe('GET /api/support/admin/queue', () => {
  beforeEach(() => {
    mockFindAll.mockReset();
    mockFindAll.mockResolvedValue([]);
    mockLiteral.mockClear();
  });

  it('qualifie les colonnes de tri du ticket quand la requête contient des jointures', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/support', supportRoutes);

    const response = await request(app).get('/api/support/admin/queue?status=open&limit=100');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { tickets: [] } });
    expect(mockFindAll).toHaveBeenCalledTimes(1);

    const options = mockFindAll.mock.calls[0][0];
    expect(options.include).toHaveLength(2);
    expect(options.order).toEqual([
      [{ value: 'CASE WHEN "SupportTicket"."priority" = \'high\' THEN 0 ELSE 1 END' }, 'ASC'],
      [{ value: 'COALESCE("SupportTicket"."last_message_at", "SupportTicket"."created_at")' }, 'ASC'],
    ]);
  });
});

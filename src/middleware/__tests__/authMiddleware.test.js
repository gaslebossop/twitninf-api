jest.mock('../../services/authService', () => ({ verifyToken: jest.fn() }));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../models/User', () => ({ findByPk: jest.fn() }));
jest.mock('../fraudMiddleware', () => ({ isTrustedFirstPartyClient: jest.fn(() => false) }));

const User = require('../../models/User');
const { requireAdmin, requireAdminRole } = require('../authMiddleware');

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('database-backed administrator authorization', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([requireAdmin, requireAdminRole])(
    'rejects a stale administrator JWT after the account is demoted',
    async (middleware) => {
      User.findByPk.mockResolvedValue({ id: 'user-1', role: 'user', moderation_permissions: {} });
      const req = { user: { id: 'user-1', role: 'superadmin', isAdmin: true } };
      const res = response();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  );

  test('accepts the current administrator role from the database', async () => {
    User.findByPk.mockResolvedValue({ id: 'user-1', role: 'admin', moderation_permissions: {} });
    const req = { user: { id: 'user-1', role: 'user' } };
    const res = response();
    const next = jest.fn();

    await requireAdminRole(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.role).toBe('admin');
  });
});

import { describe, it, expect } from 'vitest';
import { matchRoute, ROUTES } from '../src/domain/routes-table.js';

describe('route matching', () => {
  it.each([
    ['/api/shipments', '/api/shipments'],
    ['/api/shipments/abc-123', '/api/shipments'],
    ['/api/tracking/abc/latest', '/api/tracking'],
    ['/api/auth/login', '/api/auth'],
    ['/api/users/abc', '/api/users'],
  ])('%s -> %s', (path, prefix) => {
    expect(matchRoute(path)?.prefix).toBe(prefix);
  });

  it('returns nothing for an unmapped path', () => {
    expect(matchRoute('/api/unknown')).toBeUndefined();
    expect(matchRoute('/healthz')).toBeUndefined();
  });

  /**
   * Order matters. /api/payments/webhook is public while /api/payments needs a
   * token, so the specific prefix must be listed first. If the generic one won,
   * Paystack would be rejected 401 on every webhook and payments would silently
   * never settle.
   */
  it('matches the webhook before the authenticated payments prefix', () => {
    const rule = matchRoute('/api/payments/webhook');
    expect(rule?.prefix).toBe('/api/payments/webhook');
    expect(rule?.roles).toBe('public');
  });

  it('still requires auth for other payment paths', () => {
    expect(matchRoute('/api/payments/LTPAY-ABC')?.roles).toEqual([]);
  });

  // A prefix must not match a path that merely starts with the same letters.
  it('does not match a partial segment', () => {
    expect(matchRoute('/api/shipmentsfoo')).toBeUndefined();
  });

  it('keeps auth public, since you cannot present a token to get one', () => {
    expect(matchRoute('/api/auth/login')?.roles).toBe('public');
  });

  it('restricts user administration to ADMIN', () => {
    expect(matchRoute('/api/users')?.roles).toEqual(['ADMIN']);
  });

  it('routes every prefix to a distinct backend', () => {
    const authed = ROUTES.filter((r) => r.prefix !== '/api/payments/webhook');
    expect(new Set(authed.map((r) => r.target)).size).toBe(6);
  });
});

export type Role = 'ADMIN' | 'DISPATCHER' | 'SUPPORT' | 'DRIVER' | 'CUSTOMER';

export const ROLES: readonly Role[] = ['ADMIN', 'DISPATCHER', 'SUPPORT', 'DRIVER', 'CUSTOMER'];

// Back-office roles: see every shipment, never own one.
export const STAFF: readonly Role[] = ['ADMIN', 'DISPATCHER', 'SUPPORT'];

export interface RouteRule {
  prefix: string;
  // Omitted means every method. Lets a read be wider than a write on one prefix.
  methods?: readonly string[];
  target: string;
  // Empty means any authenticated user; 'public' means no token required.
  roles: readonly Role[] | 'public';
}

const svc = (name: string, port: number): string =>
  process.env[`${name.toUpperCase().replace(/-/g, '_')}_URL`] ?? `http://${name}:${port}`;

const READ = ['GET', 'HEAD'] as const;

// The gateway is the coarse gate - who may touch a prefix at all. Ownership
// ("only YOUR shipment") needs the row, so each service enforces that itself
// from the identity headers set below.
//
// Order matters: the first matching rule wins, so more specific paths (and
// method-narrowed rules) must come before the prefixes that contain them.
export const ROUTES: readonly RouteRule[] = [
  // These two sit under /api/auth but act on the caller, so they need a token.
  { prefix: '/api/auth/me', target: svc('user-service', 3001), roles: [] },
  { prefix: '/api/auth/change-password', target: svc('user-service', 3001), roles: [] },
  // The rest of auth is necessarily public - you cannot present a token to obtain one.
  { prefix: '/api/auth', target: svc('user-service', 3001), roles: 'public' },

  // Paystack signs its webhook and has no LogiTrack token to present.
  { prefix: '/api/payments/webhook', target: svc('payment-service', 3006), roles: 'public' },

  { prefix: '/api/users', methods: READ, target: svc('user-service', 3001), roles: STAFF },
  { prefix: '/api/users', target: svc('user-service', 3001), roles: ['ADMIN'] },
  { prefix: '/api/audit', target: svc('user-service', 3001), roles: ['ADMIN'] },

  // Poison-message queues are an operations concern.
  { prefix: '/api/tracking/dead-letters', target: svc('tracking-service', 3004), roles: ['ADMIN'] },
  { prefix: '/api/notifications/dead-letters', target: svc('notification-service', 3005), roles: ['ADMIN'] },

  { prefix: '/api/shipments', target: svc('shipment-service', 3002), roles: [] },
  { prefix: '/api/drivers', target: svc('driver-service', 3003), roles: [] },
  { prefix: '/api/tracking', target: svc('tracking-service', 3004), roles: [] },
  { prefix: '/api/notifications', target: svc('notification-service', 3005), roles: [] },
  // Earnings live in payment-service: it owns money, and the amount is derived
  // from the customer's payment for the shipment. Customers have none.
  { prefix: '/api/earnings', target: svc('payment-service', 3006), roles: ['ADMIN', 'SUPPORT', 'DRIVER'] },
  { prefix: '/api/payments', target: svc('payment-service', 3006), roles: [] },
];

export const matchRoute = (path: string, method = 'GET'): RouteRule | undefined =>
  ROUTES.find(
    (r) =>
      (path === r.prefix || path.startsWith(`${r.prefix}/`)) &&
      (!r.methods || r.methods.includes(method.toUpperCase())),
  );

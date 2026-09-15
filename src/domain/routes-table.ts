export interface RouteRule {
  prefix: string;
  target: string;
  // Empty means any authenticated user; 'public' means no token required.
  roles: readonly string[] | 'public';
}

const svc = (name: string, port: number): string =>
  process.env[`${name.toUpperCase().replace(/-/g, '_')}_URL`] ?? `http://${name}:${port}`;

// Order matters: the first matching prefix wins, so more specific paths must
// come before the prefixes that contain them.
export const ROUTES: readonly RouteRule[] = [
  // Auth is necessarily public - you cannot present a token to obtain one.
  { prefix: '/api/auth', target: svc('user-service', 3001), roles: 'public' },

  // Paystack signs its webhook and has no LogiTrack token to present.
  { prefix: '/api/payments/webhook', target: svc('payment-service', 3006), roles: 'public' },

  { prefix: '/api/users', target: svc('user-service', 3001), roles: ['ADMIN'] },
  { prefix: '/api/shipments', target: svc('shipment-service', 3002), roles: [] },
  { prefix: '/api/drivers', target: svc('driver-service', 3003), roles: [] },
  { prefix: '/api/tracking', target: svc('tracking-service', 3004), roles: [] },
  { prefix: '/api/notifications', target: svc('notification-service', 3005), roles: [] },
  { prefix: '/api/payments', target: svc('payment-service', 3006), roles: [] },
];

export const matchRoute = (path: string): RouteRule | undefined =>
  ROUTES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));

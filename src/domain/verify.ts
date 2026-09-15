import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const ISSUER = 'logitrack-user-service';
const AUDIENCE = 'logitrack';

export interface Identity {
  userId: string;
  email: string;
  role: string;
}

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

let jwkSet: ReturnType<typeof createRemoteJWKSet> | null = null;

// Fetched from user-service, cached, and refreshed on an unknown kid. Only the
// public key ever reaches this service, so a gateway compromise cannot mint
// tokens - it can only verify them.
export function initJwks(url?: string): void {
  const target = url ?? process.env['JWKS_URL'] ?? 'http://user-service:3001/.well-known/jwks.json';
  jwkSet = createRemoteJWKSet(new URL(target), {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
}

export const jwksReady = (): boolean => jwkSet !== null;

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function verifyToken(authorization: string | undefined): Promise<Identity> {
  if (!jwkSet) throw new UnauthorizedError('verification unavailable');

  const [scheme, token] = (authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedError('Missing bearer token');

  let payload: JWTPayload;
  try {
    // Issuer and audience are checked here, not just the signature. A validly
    // signed token minted for another audience must not be accepted.
    ({ payload } = await jwtVerify(token, jwkSet, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'],
    }));
  } catch {
    // Never echo the underlying reason: it tells an attacker whether the
    // signature, expiry or claims failed.
    throw new UnauthorizedError('Invalid token');
  }

  const userId = asString(payload.sub);
  const email = asString(payload['email']);
  const role = asString(payload['role']);
  if (!userId || !email || !role) throw new UnauthorizedError('Token is missing required claims');

  return { userId, email, role };
}

export function requireRole(identity: Identity, allowed: readonly string[]): void {
  if (!allowed.includes(identity.role)) throw new ForbiddenError();
}

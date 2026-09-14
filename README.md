# logitrack-api-gateway

Single entry point. Routes /api/* to backend services, verifies JWTs, enforces Redis-backed rate limits.

Part of the [LogiTrack](https://github.com/Echelon-Luxe) platform. See
[logitrack-infrastructure](https://github.com/Echelon-Luxe/logitrack-infrastructure)
for deployment, Helm charts and the ArgoCD configuration.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /healthz` | Liveness. Never checks dependencies - failing it kills the container. |
| `GET /readyz` | Readiness. Checks dependencies - failing it only removes the pod from the Service. |
| `GET /metrics` | Prometheus exposition. |

## Local development

```bash
npm ci
npm run dev        # tsx watch, listens on 8080
npm test           # vitest + coverage
npm run lint       # eslint, zero warnings tolerated
npm run typecheck  # tsc --noEmit
```

## Branches

`dev` (default) -> `staging` -> `production`. Never commit directly to any of them;
open a PR from `feature/*`, `bugfix/*` or `hotfix/*`. See CONTRIBUTING.md in the
infrastructure repo.

## Images

Built by CI on GitHub runners and pushed to
`ghcr.io/echelon-luxe/logitrack-api-gateway:<git-sha>`.
The image tag deployed to each environment is controlled by the infrastructure
repository, not by this one.
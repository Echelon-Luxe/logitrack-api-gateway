# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts

# debian13, not debian12: the debian12 variant ships libssl3 3.0.18, which
# Trivy blocks on six OpenSSL CVEs fixed in 3.0.19.
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build     --chown=nonroot:nonroot /app/dist ./dist
COPY --from=build     --chown=nonroot:nonroot /app/package.json ./

# Must match runAsUser: 1000 in the Helm chart.
USER nonroot
EXPOSE 8080

CMD ["dist/index.js"]

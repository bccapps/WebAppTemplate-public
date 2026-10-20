# syntax=docker/dockerfile:1
# Shared front Dockerfile (canonical, TK-based). Builds the SPA then serves it
# via nginx. The backend upstream is baked into nginx.conf at build time.
# NOTE: the automated deploy (deploy-full.sh) rewrites this with a prebuilt
# variant; this file is the source of truth for local builds (run.sh) and the
# template the deploy starts from.
# Node major: see back/Dockerfile (24 everywhere, ships npm 11).
FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .
COPY .env .env

ARG VITE_API_URL=/api/v1

RUN npm run build

FROM nginx:1.30-alpine

# Backend port baked into the nginx config at build time (upstream = back:${NODE_PORT}).
# Only ${NODE_PORT} is substituted; nginx runtime vars ($host, $uri, …) are preserved.
# NOTE: nginx.conf goes through /tmp, NOT /etc/nginx/templates/ — that directory
# triggers the Docker nginx entrypoint's runtime envsubst which would fail because
# NODE_PORT is a build arg, not a runtime env var.
ARG NODE_PORT=4301
COPY nginx.conf /tmp/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
RUN envsubst '${NODE_PORT}' < /tmp/nginx.conf.template > /etc/nginx/conf.d/default.conf

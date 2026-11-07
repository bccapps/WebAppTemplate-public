# syntax=docker/dockerfile:1.6
# vx-voice-engine, hub mode — image of the `voice-engine` compose service (profile `voice`, template scripts/docker-compose.yml).
# Does NOT compile anything: it downloads the linux-amd64 payload of a published release of the private repository
# svax974/vx-voice-engine with the BuildKit secret `gh_token` (VOICE_ENGINE_GH_TOKEN of the deploying shell), then installs it on
# debian:bookworm-slim, non-root, with no model inside (models are downloaded into the /models volume at first use).
# Copy of the `fetch` and `runtime` stages of vx-voice-engine/engine/Dockerfile: keep them in step when that file changes.
FROM debian:bookworm-slim AS payload
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq && rm -rf /var/lib/apt/lists/*
ARG VOICE_ENGINE_VERSION
ARG VOICE_ENGINE_REPO=svax974/vx-voice-engine
RUN --mount=type=secret,id=gh_token set -eu; \
    test -n "${VOICE_ENGINE_VERSION}" || { echo "VOICE_ENGINE_VERSION is required"; exit 1; }; \
    TOKEN="$(cat /run/secrets/gh_token)"; \
    ASSET="vx-voice-engine-${VOICE_ENGINE_VERSION}-linux-amd64.tar.gz"; \
    ID="$(curl -fsSL -H "Authorization: Bearer ${TOKEN}" "https://api.github.com/repos/${VOICE_ENGINE_REPO}/releases/tags/v${VOICE_ENGINE_VERSION}" | jq -r ".assets[] | select(.name==\"${ASSET}\") | .id")"; \
    test -n "$ID"; \
    curl -fsSL -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/octet-stream" -o /tmp/engine.tgz "https://api.github.com/repos/${VOICE_ENGINE_REPO}/releases/assets/${ID}"; \
    mkdir -p /out && tar -xzf /tmp/engine.tgz -C /out && rm /tmp/engine.tgz


# ---- runtime -------------------------------------------------------------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 vvengine && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin vvengine \
    && mkdir -p /models /cache && chown vvengine:vvengine /models /cache
COPY --from=payload /out/ /opt/vx-voice-engine/
ENV VOICE_ENGINE_MODE=hub VOICE_ENGINE_LISTEN=0.0.0.0:7840 VOICE_ENGINE_MODELS_DIR=/models VOICE_ENGINE_CACHE_DIR=/cache \
    VOICE_ENGINE_MEMORY_MB=3000 VOICE_ENGINE_THREADS=4 VOICE_ENGINE_MANIFEST=/opt/vx-voice-engine/manifest.json
USER vvengine
VOLUME ["/models", "/cache"]
EXPOSE 7840
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/opt/vx-voice-engine/vx-voice-engine", "healthcheck"]
ENTRYPOINT ["/opt/vx-voice-engine/vx-voice-engine"]
CMD ["serve"]

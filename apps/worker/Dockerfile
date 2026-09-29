# Base image is pinned by digest; update it with an explicit browser/runtime
# review rather than rebuilding from a floating Node tag.
FROM node:20.18.0-bookworm-slim@sha256:28fbbb764069c698ead61d6a739a7615e8f0e07a4b8fe1473ceca70c1c3d6aaa

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium=154.0.8037.57-1~deb12u1 \
    chromium-sandbox=154.0.8037.57-1~deb12u1 \
    ca-certificates \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /atlas
COPY package.json ./package.json
COPY bin ./bin
COPY src ./src
COPY experience ./experience
COPY types ./types
COPY apps/worker ./apps/worker
COPY apps/control-plane/src/egress-proxy.js ./apps/control-plane/src/egress-proxy.js

ENV ATLAS_CHROME=/usr/bin/chromium
ENV HOME=/tmp
USER node
ENTRYPOINT ["node", "bin/atlas.js"]

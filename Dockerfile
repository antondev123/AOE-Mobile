# The match server, which also serves the game.
#
# The image carries the repo as-is rather than a build artifact: index.html
# loads the source modules and vendored Phaser directly, exactly as GitHub Pages
# serves them today, so there is no bundle step to keep in sync with the deploy.

FROM node:22-slim

WORKDIR /app

# Only `ws` is needed at runtime; esbuild and playwright are dev tooling and are
# skipped so the image stays small and starts fast.
COPY package.json package-lock.json ./

# The optional `extra_ca` secret is an additional CA to trust *while installing*.
# It is empty in every normal build and the line below is then exactly
# `npm ci --omit=dev`. It exists because a build run behind a TLS-terminating
# egress proxy — a corporate network, or a sandboxed CI agent — sees the proxy's
# certificate rather than npm's and fails with SELF_SIGNED_CERT_IN_CHAIN. The
# fix for that is to trust the proxy's CA, never to turn verification off, so
# there is deliberately no `strict-ssl=false` anywhere near this file.
#
# Mounted as a secret rather than COPYed so it leaves no layer behind; a CA
# certificate is public, but an image that carries someone's proxy root around
# is still a thing nobody asked for.
#
#   docker build --secret id=extra_ca,src=/path/to/ca.crt .
#   fly deploy --local-only --build-secret extra_ca="$(cat /path/to/ca.crt)"
RUN --mount=type=secret,id=extra_ca,target=/tmp/extra-ca.crt \
    if [ -s /tmp/extra-ca.crt ]; then \
      export NODE_EXTRA_CA_CERTS=/tmp/extra-ca.crt; \
    fi; \
    npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/server.js"]

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
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/server.js"]

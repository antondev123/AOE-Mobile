# Age of Skirmish is a static page: an index.html, a stylesheet, a folder of ES
# modules the browser loads directly, and a vendored Phaser. There is no server
# side and no build step — `tools/build-standalone.mjs` exists for making a
# single-file copy, not for producing what gets served — so the image is nginx
# and the repo, and nothing else.
#
# The two things it does do are stamp the build (the boot card's footer is the
# only place a bug report can read a version off, and it shipped reading
# "__COMMIT_SHA__" because the GitHub Pages workflow does this substitution and
# the Fly image never did) and answer /healthz, which fly.toml's http check
# calls every 30s.
FROM nginx:1.27-alpine

ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY src /usr/share/nginx/html/src
COPY vendor /usr/share/nginx/html/vendor

# Same substitution as .github/workflows/deploy.yml, so the two deployments of
# the same commit report the same build.
RUN sed -i \
      -e "s|__COMMIT_SHA__|${COMMIT_SHA}|g" \
      -e "s|__BUILD_TIME__|${BUILD_TIME}|g" \
      /usr/share/nginx/html/index.html

EXPOSE 8080

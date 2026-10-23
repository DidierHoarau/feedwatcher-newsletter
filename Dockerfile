# BUILD
FROM node:24-alpine as builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY feedwatcher-newsletter-server feedwatcher-newsletter-server

RUN cd feedwatcher-newsletter-server && \
    npm ci && \
    npm run build && \
    npm prune --omit=dev

# RUN
FROM node:24-alpine

# TLS certificate verification is enabled by default for IMAP: the runtime
# needs a CA bundle (not shipped by the base image) to validate public servers.
RUN apk add --no-cache ca-certificates

COPY --from=builder /opt/src/feedwatcher-newsletter-server/node_modules /opt/app/feedwatcher-newsletter/node_modules
COPY --from=builder /opt/src/feedwatcher-newsletter-server/dist /opt/app/feedwatcher-newsletter/dist
COPY feedwatcher-newsletter-server/config.json /opt/app/feedwatcher-newsletter/config.json
COPY package.json /opt/app/feedwatcher-newsletter/package.json

WORKDIR /opt/app/feedwatcher-newsletter

# The service runs unprivileged; /data is the only writable location. The
# application files stay root-owned and read-only for the node user.
RUN mkdir -p /data && chown node:node /data

USER node

CMD [ "node", "dist/App.js" ]

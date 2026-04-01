# BUILD
FROM node:22-alpine as builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY feedwatcher-newsletter-server feedwatcher-newsletter-server

RUN cd feedwatcher-newsletter-server && \
    npm ci && \
    npm run build

# RUN
FROM node:22-alpine

COPY --from=builder /opt/src/feedwatcher-newsletter-server/node_modules /opt/app/feedwatcher-newsletter/node_modules
COPY --from=builder /opt/src/feedwatcher-newsletter-server/dist /opt/app/feedwatcher-newsletter/dist
COPY feedwatcher-newsletter-server/config.json /opt/app/feedwatcher-newsletter/config.json
COPY feedwatcher-newsletter-server/sql /opt/app/feedwatcher-newsletter/sql
COPY package.json /opt/app/feedwatcher-newsletter/package.json

WORKDIR /opt/app/feedwatcher-newsletter

CMD [ "node", "dist/App.js" ]

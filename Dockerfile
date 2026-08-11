# The Grading Room — single container, one SQLite file on a volume.
#
# Deliberately not a cluster. v1 is one team, one project; a single process
# serving the API and the built SPA from the same origin is the whole topology,
# which is why the shared link works with no CORS or session story.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The database lives on a volume, not in the image layer.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=8787 \
    GR_DB=/data/grading-room.db
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

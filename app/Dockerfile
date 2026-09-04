# Build from the REPOSITORY ROOT so the investigation workspace can be copied in:
#   docker build -f app/Dockerfile -t mendr-app .
FROM node:22-alpine AS build
WORKDIR /srv/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/tsconfig.json ./
COPY app/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 UI_DIR=/srv/ui
WORKDIR /srv/app
COPY --from=build /srv/app/node_modules ./node_modules
COPY --from=build /srv/app/dist ./dist
COPY app/package.json app/schema.sql ./
COPY site/app /srv/ui
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

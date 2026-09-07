ARG NODE_IMAGE=node:20-alpine

FROM ${NODE_IMAGE} AS runtime-dependencies
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node templates ./templates
RUN mkdir -p /app/logs /app/uploads/import && chown -R node:node /app/logs /app/uploads
USER node
EXPOSE 3000
CMD ["node", "src/app.js"]

FROM ${NODE_IMAGE} AS migrator-dependencies
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=migrator-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
USER node
ENTRYPOINT []
CMD ["npx", "sequelize-cli", "db:migrate"]

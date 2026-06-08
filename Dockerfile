# Dockerfile (TS/tsx 版 MCP Server 用)
FROM node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f

WORKDIR /app

# Copy package files and install dependencies
# This leverages Docker's build cache. `npm ci` will only run again
# if package.json or package-lock.json has changed.
COPY package.json package-lock.json ./
RUN npm ci

# Copy lightweight-charts standalone js to assets folder
RUN mkdir -p assets && \
    cp node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js assets/lightweight-charts.standalone.js

# Copy the rest of the application's source code
COPY --chown=node:node src ./src
COPY --chown=node:node tools ./tools
COPY --chown=node:node lib ./lib

# Run as non-root user for security
USER node

# Set the environment to production
ENV NODE_ENV=production

# stdio 専用 (StdioServerTransport) のため公開ポートは不要

# Define the entry point for the container (avoid npx for stdio stability)
ENV NO_COLOR=1 \
    LOG_LEVEL=info
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs", "src/server.ts"]
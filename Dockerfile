FROM node:22-alpine AS base
WORKDIR /app

# Install deps (only dev deps for build)
COPY package.json ./
RUN npm install --no-audit --no-fund

# Build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime image (dist only)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/dist ./dist
COPY package.json ./
# no runtime deps, start directly
EXPOSE 3001
CMD ["node", "dist/server.js"]


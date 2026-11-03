# Production image: docker build -t wordforge . && docker run -p 3000:3000 -e JWT_SECRET=... wordforge
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first so Docker can cache this layer.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# The SQLite fallback writes to ./data (only used when DATABASE_URL is not set).
RUN mkdir -p data && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- "http://localhost:${PORT:-3000}/healthz" || exit 1
CMD ["node", "server/index.js"]

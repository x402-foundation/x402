# ── Facilitator ──────────────────────────────────────────────
FROM node:22-slim AS facilitator
WORKDIR /app/rh-facilitator
COPY rh-facilitator/package*.json ./
RUN npm ci
COPY rh-facilitator/ ./
ENV FACILITATOR_PORT=3001
EXPOSE 3001
CMD ["npx", "tsx", "src/index.ts"]

# ── Demo API ─────────────────────────────────────────────────
FROM node:22-slim AS demo-api
WORKDIR /app/demo-api
COPY demo-api/package*.json ./
RUN npm ci
COPY demo-api/ ./
ENV FACILITATOR_URL=http://facilitator:3001
ENV PORT=3005
EXPOSE 3005
CMD ["npx", "tsx", "server.ts"]
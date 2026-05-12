FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
ENV DATABASE_URL=file:/app/data/bridge.db
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/data/bridge.db
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["npm", "start"]

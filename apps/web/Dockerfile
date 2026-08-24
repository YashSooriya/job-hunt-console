FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
RUN npm install

FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended lmodern && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended lmodern && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["npm", "--workspace", "@jobhunt/web", "run", "start"]

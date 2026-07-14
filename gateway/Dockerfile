# One image, two roles (see docker-compose.scale.yml): "node dist/main.js" for the stateless
# API tier, "node dist/worker.main.js" for the BullMQ worker tier — each scaled independently.
FROM node:22-slim AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /srv/dist ./dist
COPY public ./public

EXPOSE 3000
CMD ["node", "dist/main.js"]

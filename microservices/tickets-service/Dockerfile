FROM node:20-alpine AS build

WORKDIR /srv

# Copiado antes do código para reaproveitar o cache das dependências.
COPY package.json package-lock.json ./
RUN npm ci

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /srv

COPY --from=build /srv/package.json ./
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]

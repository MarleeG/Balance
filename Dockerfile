# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app

COPY api/package*.json ./api/
COPY client/package*.json ./client/
RUN npm --prefix api ci && npm --prefix client ci

FROM deps AS build
WORKDIR /app

COPY api ./api
COPY client ./client
COPY start.sh ./start.sh
RUN npm --prefix api run build && npm --prefix client run build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV API_PORT=3000
ENV FRONTEND_PORT=4173

RUN apk add --no-cache bash

COPY --from=build /app/start.sh ./start.sh

COPY --from=build /app/api/package*.json ./api/
COPY --from=build /app/api/node_modules ./api/node_modules
COPY --from=build /app/api/dist ./api/dist

COPY --from=build /app/client/package*.json ./client/
COPY --from=build /app/client/node_modules ./client/node_modules
COPY --from=build /app/client/dist ./client/dist

RUN chmod +x ./start.sh

EXPOSE 3000 4173

CMD ["./start.sh"]

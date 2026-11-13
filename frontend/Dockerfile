FROM node:20-alpine AS build

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

ARG BACKEND_API_URL=http://127.0.0.1:8000
ENV BACKEND_API_URL=${BACKEND_API_URL}

RUN npm run build

FROM node:20-alpine AS runtime

LABEL com.azure.containerizationassist.createdby="containerization-assist"

ENV NODE_ENV=production
ENV BACKEND_API_URL=http://backend:8000

WORKDIR /app

RUN chown node:node /app
USER node

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.mjs ./next.config.mjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0"]

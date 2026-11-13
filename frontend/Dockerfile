FROM node:20-alpine

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

ARG BACKEND_API_URL=http://127.0.0.1:8000
ENV BACKEND_API_URL=${BACKEND_API_URL}

RUN npm run build

USER node

EXPOSE 3000

CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0"]

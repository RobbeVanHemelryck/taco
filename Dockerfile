FROM node:24-alpine

# docker CLI + compose plugin (taco drives these), util-linux `script` for exec TTYs.
RUN apk add --no-cache docker-cli docker-cli-compose util-linux-misc coreutils

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public

ENV TACO_PORT=8080 TACO_DATA_DIR=/data
EXPOSE 8080
VOLUME /data
CMD ["node", "server/index.js"]

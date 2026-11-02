# Runs on the ERPNext host; needs the docker CLI + compose plugin and access to the docker socket.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm i -g typescript@5 && tsc -p tsconfig.json --outDir dist --rootDir src --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck

FROM node:20-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
USER root
ENV NODE_ENV=production PROVISIONER_HOST=127.0.0.1 PROVISIONER_PORT=8099
CMD ["node", "dist/server.js"]

# Container image for the demo web client (Express serving public/ and /config.js). Built by
# .github/workflows/image.yml and published to ghcr.io; the repository itself deploys with the Node.js Buildpack,
# which is why this file lives in deploy/ and not at the root.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js ./
COPY public ./public
EXPOSE 8080
USER node
CMD ["node", "server.js"]

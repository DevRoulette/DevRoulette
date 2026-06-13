# DevRoulette matchmaking server. Builds the TypeScript to plain JS at image-build
# time (devDeps available here) and runs it with node — no tsx at runtime.
FROM node:20-slim
WORKDIR /app

# Install ALL deps (incl. devDeps: typescript/tsx) so the build can compile.
COPY package.json package-lock.json ./
RUN npm ci

# Build the server (+ shared + cli) into dist/.
COPY . .
RUN npm run build

# Bind all interfaces (required behind Railway's proxy); PORT is injected by Railway.
ENV HOST=0.0.0.0 NODE_ENV=production
CMD ["node", "dist/server/src/index.js"]

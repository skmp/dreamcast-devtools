# Mock demo image: builds the UI and serves it from the mock debugger server
# (server/mockServer.ts) in production mode. This is not how the emulator ships
# the UI; it embeds the dist-native/ or dist-wasm/ build directly.

# Build stage: install the locked dependencies and build dist-native/.
# The generated AICA DSP wasm glue (src/wasm/aica-dsp) is committed, so no Rust
# toolchain is needed here.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:native

# Runtime stage: the mock server runs through tsx and imports vite, express and
# ws (all devDependencies), so it keeps the node_modules of the build stage.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-native ./dist-native
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.server.json ./

EXPOSE 8080
CMD ["npm", "run", "mock:serve"]

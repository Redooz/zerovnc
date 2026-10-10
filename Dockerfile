# Pinned Bun matches bun.lock and package.json. Dependencies come from the
# lockfile only. No secrets are copied in; they are injected at runtime.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/app/data/agent.sqlite \
    ARTIFACT_DIR=/app/artifacts
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN mkdir -p /app/data /app/artifacts && chown -R bun:bun /app/data /app/artifacts
USER bun
VOLUME ["/app/data", "/app/artifacts"]
EXPOSE 8080
# SIGTERM cancels running tasks, marks them fallida, and closes the database.
STOPSIGNAL SIGTERM
CMD ["bun", "run", "src/bootstrap/main.ts"]

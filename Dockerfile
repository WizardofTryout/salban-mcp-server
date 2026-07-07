# --- Build-Stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm install
RUN npm run build

# --- Production-Stage ---
FROM node:20-alpine AS runner

WORKDIR /app

# Install ONLY production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy compiled JavaScript from the builder stage
COPY --from=builder /app/build ./build

# Restrict write permissions on all compiled assets to prevent post-exploitation modifications
RUN chown -R root:root /app && \
    chmod -R 755 /app

# Switch to the unprivileged node user
USER node

# Expose the local WebSocket port
EXPOSE 8080

# Run the MCP server over standard I/O (stdio)
ENTRYPOINT ["node", "build/index.js"]

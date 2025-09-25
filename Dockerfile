# Multi-stage Dockerfile for Node.js App Runner application
# Optimized for security, performance, and size

# Stage 1: Build stage
FROM node:22-alpine AS builder

# Create app directory
WORKDIR /app

# Add non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S appuser -u 1001

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci --include=dev && npm cache clean --force

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies to reduce size
RUN npm ci --only=production && npm cache clean --force

# Stage 2: Production stage
FROM node:22-alpine AS production

# Create app directory
WORKDIR /app

# Add non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S appuser -u 1001

# Install security updates
RUN apk --no-cache upgrade

# Copy built application from builder stage
COPY --from=builder --chown=appuser:nodejs /app/dist ./dist
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/package*.json ./

# Create necessary directories with proper permissions
RUN mkdir -p /app/logs && chown -R appuser:nodejs /app

# Switch to non-root user
USER appuser

# Expose port 8080 (App Runner default)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "dist/index.js"]
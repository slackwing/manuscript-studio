# Multi-stage build for Manuscript Studio

# Stage 1: Build the Go binary
FROM golang:1.23-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o manuscript-studio cmd/server/main.go

# Stage 2: Create the runtime image
FROM alpine:3.19

# Install runtime dependencies
RUN apk --no-cache add ca-certificates git

# Create non-root user
RUN addgroup -g 1000 manuscript && \
    adduser -D -u 1000 -G manuscript manuscript

# Create necessary directories
RUN mkdir -p /config /logs /repos && \
    chown -R manuscript:manuscript /config /logs /repos

# Copy binary from builder
COPY --from=builder /app/manuscript-studio /usr/local/bin/manuscript-studio

# Copy web assets
COPY --from=builder /app/web /app/web

# Copy Liquibase files for reference
COPY --from=builder /app/liquibase /app/liquibase

# Switch to non-root user
USER manuscript

# Set working directory
WORKDIR /app

# Expose port
EXPOSE 5001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:5001/health || exit 1

# Run the server
CMD ["manuscript-studio"]
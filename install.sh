#!/usr/bin/env bash
# Manuscript Studio Installation Script
# One-liner: curl -sSL https://raw.githubusercontent.com/slackwing/manuscript-studio/main/install.sh | bash

set -euo pipefail

# Configuration
VERSION="${1:-latest}"
CONFIG_DIR="$HOME/.config/manuscript-studio"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
LOG_DIR="$CONFIG_DIR/logs"
INSTALL_LOG="$LOG_DIR/install.log"
REPO_URL="https://github.com/slackwing/manuscript-studio"

# Ensure log directory exists and tee all output to log file
mkdir -p "$LOG_DIR"
exec > >(tee -a "$INSTALL_LOG") 2>&1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# Header
echo "========================================="
echo "   Manuscript Studio Installation"
echo "   $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="
echo ""
log_info "Config file: $CONFIG_FILE"
log_info "Install log: $INSTALL_LOG"
echo ""

# Step 1: Check for configuration file
log_step "Checking for configuration file..."

if [[ ! -f "$CONFIG_FILE" ]]; then
    log_info "Creating configuration directory at $CONFIG_DIR"
    mkdir -p "$CONFIG_DIR"
    mkdir -p "$CONFIG_DIR/logs"
    mkdir -p "$CONFIG_DIR/repos"

    log_info "Downloading configuration template..."
    curl -sSL "$REPO_URL/raw/main/config.example.yaml" -o "$CONFIG_FILE" || {
        log_error "Failed to download configuration template"
    }

    log_warn "Configuration template created at: $CONFIG_FILE"
    echo ""
    echo "Please edit this file with your settings:"
    echo "  1. Database connection details"
    echo "  2. System token (generate with: openssl rand -hex 32)"
    echo "  3. Manuscript repository settings"
    echo "  4. File paths"
    echo ""
    echo "Then run this script again to complete installation."
    exit 0
fi

log_info "Configuration file found"

# Step 2: Check dependencies
log_step "Checking system dependencies..."

check_dependency() {
    local cmd=$1
    local name=${2:-$1}
    if ! command -v "$cmd" &> /dev/null; then
        log_error "$name is not installed. Please install it and try again."
    fi
    log_info "✓ $name found"
}

check_dependency docker "Docker"
check_dependency git "Git"
check_dependency psql "PostgreSQL client"

# Step 3: Parse configuration
log_step "Parsing configuration..."

# Simple config parsing (requires proper YAML values)
get_config() {
    grep "^[[:space:]]*$1:" "$CONFIG_FILE" | head -1 | sed "s/.*$1:[[:space:]]*[\"']*\([^\"']*\)[\"']*/\1/"
}

DB_HOST=$(get_config "host")
DB_PORT=$(get_config "port")
DB_NAME=$(get_config "name")
DB_USER=$(get_config "user")
DB_PASSWORD=$(get_config "password")
PUBLIC_DIR=$(get_config "public_dir")
PRIVATE_DIR=$(get_config "private_dir")

# Expand paths
PUBLIC_DIR="${PUBLIC_DIR/#\~/$HOME}"
PRIVATE_DIR="${PRIVATE_DIR/#\~/$HOME}"

log_info "Database: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
log_info "Public directory: $PUBLIC_DIR"
log_info "Private directory: $PRIVATE_DIR"

# Step 4: Validate directories
log_step "Validating directories..."

if [[ ! -d "$PUBLIC_DIR" ]]; then
    log_error "Public directory does not exist: $PUBLIC_DIR. Please create it and try again."
fi

if [[ ! -d "$PRIVATE_DIR" ]]; then
    log_error "Private directory does not exist: $PRIVATE_DIR. Please create it and try again."
fi

# Step 5: Test database connection
log_step "Testing database connection..."

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" &>/dev/null || {
    log_warn "Cannot connect to database (may not exist yet, continuing)"
}

# Step 6: Clone/update manuscript repositories
log_step "Setting up manuscript repositories..."

# Parse manuscript repos from config (simplified - assumes one for now)
REPO_URL=$(grep -A5 "repository:" "$CONFIG_FILE" | grep "url:" | head -1 | sed 's/.*url:[[:space:]]*"\(.*\)".*/\1/')
REPO_NAME=$(grep -A5 "manuscripts:" "$CONFIG_FILE" | grep "name:" | head -1 | sed 's/.*name:[[:space:]]*"\(.*\)".*/\1/')

if [[ -n "$REPO_URL" && -n "$REPO_NAME" ]]; then
    REPO_DIR="$CONFIG_DIR/repos/$REPO_NAME"

    if [[ ! -d "$REPO_DIR" ]]; then
        log_info "Cloning manuscript repository..."
        git clone "$REPO_URL" "$REPO_DIR" || log_warn "Failed to clone repository"
    else
        log_info "Updating manuscript repository..."
        cd "$REPO_DIR" && git pull || log_warn "Failed to update repository"
    fi
fi

# Step 7: Download and build Docker images
log_step "Building Docker images..."

cd "$PRIVATE_DIR"

# Clone or update Manuscript Studio
if [[ ! -d "manuscript-studio-src" ]]; then
    log_info "Cloning Manuscript Studio..."
    git clone "$REPO_URL.git" manuscript-studio-src
else
    log_info "Updating Manuscript Studio..."
    cd manuscript-studio-src && git pull
fi

cd manuscript-studio-src

# Build Liquibase image
log_info "Building Liquibase migration image..."
docker build -f Dockerfile.liquibase -t manuscript-studio-liquibase . || {
    log_error "Failed to build Liquibase image"
}

# Build main application image
log_info "Building Manuscript Studio application image..."
docker build -t manuscript-studio:latest . || {
    log_error "Failed to build application image"
}

# Step 8: Run database migrations
log_step "Running database migrations..."

docker run --rm \
    --network host \
    -e POSTGRES_HOST="$DB_HOST" \
    -e POSTGRES_PORT="$DB_PORT" \
    -e POSTGRES_DB="$DB_NAME" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    manuscript-studio-liquibase \
    --changeLogFile=changelog/db.changelog-master.xml \
    --url="jdbc:postgresql://$DB_HOST:$DB_PORT/$DB_NAME" \
    --username="$DB_USER" \
    --password="$DB_PASSWORD" \
    update || {
    log_warn "Migration failed - database may already be up to date"
}

# Step 9: Start the server
log_step "Starting Manuscript Studio server..."

# Stop existing container if running
if docker ps -a | grep -q manuscript-studio-server; then
    log_info "Stopping existing server..."
    docker stop manuscript-studio-server 2>/dev/null || true
    docker rm manuscript-studio-server 2>/dev/null || true
fi

# Start new container
log_info "Starting new server container..."
docker run -d \
    --name manuscript-studio-server \
    --restart unless-stopped \
    -p 127.0.0.1:5001:5001 \
    -v "$CONFIG_FILE:/config/config.yaml:ro" \
    -v "$CONFIG_DIR/logs:/logs" \
    -v "$CONFIG_DIR/repos:/repos" \
    -v "$PUBLIC_DIR:/public" \
    manuscript-studio:latest || {
    log_error "Failed to start server"
}

# Wait for server to be ready
log_info "Waiting for server to be ready..."
sleep 5

# Step 10: Verify installation
log_step "Verifying installation..."

if curl -s http://localhost:5001/health | grep -q "healthy"; then
    log_info "✓ Server is running and healthy!"
else
    log_error "Server health check failed"
fi

# Step 11: Show next steps
echo ""
echo "========================================="
echo "   Installation Complete!"
echo "========================================="
echo ""
log_info "Manuscript Studio is running on port 5001"
echo ""
echo "Next steps:"
echo "1. Configure your web server (Apache/Nginx) to proxy to localhost:5001"
echo ""
echo "Example Apache configuration:"
echo "----------------------------------------"
cat << 'EOF'
<VirtualHost *:80>
    ServerName your-domain.com

    ProxyPreserveHost On
    ProxyPass / http://localhost:5001/
    ProxyPassReverse / http://localhost:5001/

    # For WebSocket support (if needed later)
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) ws://localhost:5001/$1 [P,L]
</VirtualHost>
EOF
echo "----------------------------------------"
echo ""
echo "2. Set up GitHub webhook (optional):"
echo "   - URL: https://your-domain.com/api/admin/webhook"
echo "   - Content type: application/json"
echo "   - Secret: (from your config.yaml)"
echo ""
echo "3. Access the application at https://your-domain.com"
echo ""
echo "To check server logs:"
echo "  docker logs manuscript-studio-server"
echo ""
echo "To stop the server:"
echo "  docker stop manuscript-studio-server"
echo ""
echo "To update Manuscript Studio:"
echo "  Run this script again - it will pull the latest version"
echo ""
log_info "Installation complete!"
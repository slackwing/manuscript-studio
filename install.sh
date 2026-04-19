#!/usr/bin/env bash
# Manuscript Studio Installation Script
# One-liner: curl -sSL https://raw.githubusercontent.com/slackwing/manuscript-studio/main/install.sh | bash
#
# SCRIPT_VERSION: bump on EVERY change to this file (see AGENTS.md).
# Format: YYYY-MM-DD.N (N increments within the same day).
SCRIPT_VERSION="2026-04-19.11"

set -euo pipefail

# ---- Argument parsing ----
DEV_MODE=0
for arg in "$@"; do
    case "$arg" in
        --dev) DEV_MODE=1 ;;
    esac
done

# ---- Configuration ----
if [[ "$DEV_MODE" == "1" ]]; then
    # Dev mode: separate namespace so it can coexist with a production install.
    CONFIG_DIR="$HOME/.config/manuscript-studio-dev"
    CONFIG_FILE="$CONFIG_DIR/config.yaml"
    CONFIG_SOURCE_TEMPLATE="config.dev.yaml"
else
    CONFIG_DIR="$HOME/.config/manuscript-studio"
    CONFIG_FILE="$CONFIG_DIR/config.yaml"
    CONFIG_SOURCE_TEMPLATE="config.example.yaml"
fi
REPO_URL="https://github.com/slackwing/manuscript-studio"

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

# prompt_yn: prompt user yes/no, default Yes. Returns 0 for yes, 1 for no.
# Works under `bash <(curl ...)` because stdin stays attached to the terminal.
# Non-interactive (no TTY) → auto-yes so CI/pipes don't hang.
prompt_yn() {
    local question="$1"
    if [[ ! -t 0 ]]; then
        log_info "$question [auto-yes: non-interactive]"
        return 0
    fi
    local reply
    read -rp "$(echo -e "${YELLOW}[?]${NC} $question [Y/n]: ")" reply
    case "$reply" in
        ""|y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

# Header
echo "========================================="
echo "   Manuscript Studio Installation"
echo "   Script version: $SCRIPT_VERSION"
if [[ "$DEV_MODE" == "1" ]]; then
    echo "   Mode: DEV (using $CONFIG_DIR)"
fi
echo "========================================="
echo ""
log_info "Config file: $CONFIG_FILE"
echo ""

# Step 1: Check for configuration file
log_step "Checking for configuration file..."

if [[ ! -f "$CONFIG_FILE" ]]; then
    log_info "Creating configuration directory at $CONFIG_DIR"
    mkdir -p "$CONFIG_DIR"
    mkdir -p "$CONFIG_DIR/logs"
    mkdir -p "$CONFIG_DIR/repos"

    if [[ "$DEV_MODE" == "1" ]]; then
        # Dev mode: copy the committed config.dev.yaml from the local checkout.
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        if [[ -f "$SCRIPT_DIR/$CONFIG_SOURCE_TEMPLATE" ]]; then
            cp "$SCRIPT_DIR/$CONFIG_SOURCE_TEMPLATE" "$CONFIG_FILE"
            log_info "Copied $CONFIG_SOURCE_TEMPLATE to $CONFIG_FILE"
        else
            log_error "Dev config template not found at $SCRIPT_DIR/$CONFIG_SOURCE_TEMPLATE"
        fi
    else
        log_info "Downloading configuration template..."
        curl -sSL "$REPO_URL/raw/main/$CONFIG_SOURCE_TEMPLATE" -o "$CONFIG_FILE" || {
            log_error "Failed to download configuration template"
        }

        log_warn "Configuration template created at: $CONFIG_FILE"
        echo ""
        echo "Please edit this file with your settings (in order):"
        echo "  1. Database connection details"
        echo "  2. File paths (private_dir)"
        echo "  3. Manuscript repository settings"
        echo "  4. Auth tokens (generate with: openssl rand -hex 32)"
        echo ""
        echo "Then run this script again to complete installation."
        exit 0
    fi
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
PRIVATE_DIR=$(get_config "private_dir")
MANUSCRIPT_REPOS_DIR="$CONFIG_DIR/repos"
MANUSCRIPT_REPO_URL=$(grep -A5 "repository:" "$CONFIG_FILE" | grep "url:" | head -1 | sed 's/.*url:[[:space:]]*"\(.*\)".*/\1/')
MANUSCRIPT_NAME=$(grep -A5 "manuscripts:" "$CONFIG_FILE" | grep "name:" | head -1 | sed 's/.*name:[[:space:]]*"\(.*\)".*/\1/')

# Expand paths
PRIVATE_DIR="${PRIVATE_DIR/#\~/$HOME}"

log_info "Database: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
log_info "Private directory: $PRIVATE_DIR"
log_info "Manuscript: $MANUSCRIPT_NAME ($MANUSCRIPT_REPO_URL)"

# Step 4: Test database connection
log_step "Testing database connection..."

log_info "psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME"
DB_ERR=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" 2>&1 >/dev/null) && {
    log_info "Database connection OK"
} || {
    log_warn "Cannot connect to database:"
    echo "$DB_ERR" | sed 's/^/    /'

    # If the only problem is that the database doesn't exist, offer to create it.
    if echo "$DB_ERR" | grep -qi "database .* does not exist"; then
        if prompt_yn "Create database \"$DB_NAME\" on $DB_HOST:$DB_PORT?"; then
            if PGPASSWORD="$DB_PASSWORD" createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" 2>&1; then
                log_info "Created database $DB_NAME"
            else
                log_warn "Failed to create database (continuing; the user may lack CREATEDB)"
            fi
        fi
    fi
}

# Step 5: Validate directories
log_step "Validating directories..."

if [[ ! -d "$PRIVATE_DIR" ]]; then
    log_warn "Private directory does not exist: $PRIVATE_DIR"
    if prompt_yn "Create it (and chown to $USER if sudo is available)?"; then
        if mkdir -p "$PRIVATE_DIR" 2>/dev/null; then
            log_info "Created $PRIVATE_DIR"
        elif command -v sudo &>/dev/null; then
            sudo mkdir -p "$PRIVATE_DIR" && sudo chown -R "$USER:$USER" "$PRIVATE_DIR" \
                && log_info "Created $PRIVATE_DIR (as sudo, chowned to $USER)" \
                || log_error "Failed to create $PRIVATE_DIR even with sudo"
        else
            log_error "Failed to create $PRIVATE_DIR (no write access, sudo unavailable)"
        fi
    else
        log_error "Private directory is required. Please create it manually and try again."
    fi
fi
log_info "✓ Private directory exists"

# Step 6: Clone/update manuscript repositories
log_step "Setting up manuscript repositories..."

mkdir -p "$MANUSCRIPT_REPOS_DIR"

if [[ -n "$MANUSCRIPT_REPO_URL" && -n "$MANUSCRIPT_NAME" ]]; then
    REPO_DIR="$MANUSCRIPT_REPOS_DIR/$MANUSCRIPT_NAME"

    if [[ ! -d "$REPO_DIR" ]]; then
        if [[ "$DEV_MODE" == "1" ]]; then
            log_warn "Test repo not found at $REPO_DIR. Run 'make test-repo' or testdata/init-test-repo.sh first."
        else
            log_info "Cloning manuscript repository..."
            git clone "$MANUSCRIPT_REPO_URL" "$REPO_DIR" || log_warn "Failed to clone repository"
        fi
    else
        if [[ "$DEV_MODE" == "1" ]]; then
            log_info "Using existing manuscript repository at $REPO_DIR (dev mode skips pull)"
        else
            log_info "Updating manuscript repository..."
            git -C "$REPO_DIR" pull --ff-only || log_warn "Failed to update repository"
        fi
    fi
fi

# Step 7: Download and build Docker images
log_step "Building Docker images..."

if [[ "$DEV_MODE" == "1" ]]; then
    # Dev mode: build from the local checkout (the directory containing this script).
    SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    log_info "Using local source at $SRC_DIR (dev mode)"
else
    SRC_DIR="$PRIVATE_DIR/manuscript-studio-src"

    # Clone or update Manuscript Studio
    if [[ ! -d "$SRC_DIR" ]]; then
        log_info "Cloning Manuscript Studio..."
        git clone "$REPO_URL.git" "$SRC_DIR"
    else
        log_info "Updating Manuscript Studio..."
        git -C "$SRC_DIR" pull --ff-only
    fi
fi

cd "$SRC_DIR"

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

# Step 8b: Upsert admin user from config
log_step "Upserting admin user..."

docker run --rm \
    --network host \
    -v "$CONFIG_FILE:/config/config.yaml:ro" \
    manuscript-studio:latest \
    admin-upsert || {
    log_error "Failed to upsert admin user. Check auth.admin_username and auth.admin_password in config."
}

# Step 9: Start the server
log_step "Starting Manuscript Studio server..."

if [[ "$DEV_MODE" == "1" ]]; then
    CONTAINER_NAME="manuscript-studio-dev-server"
else
    CONTAINER_NAME="manuscript-studio-server"
fi

# Stop existing container if running
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    log_info "Stopping existing $CONTAINER_NAME..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

# Start new container.
# Dev mode uses --network host so the container can reach Postgres on localhost:5433.
# Prod mode uses port mapping + SSH mount for private-repo pulls.
log_info "Starting $CONTAINER_NAME..."
if [[ "$DEV_MODE" == "1" ]]; then
    docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        --network host \
        -v "$CONFIG_FILE:/config/config.yaml:ro" \
        -v "$CONFIG_DIR/logs:/logs" \
        -v "$MANUSCRIPT_REPOS_DIR:/repos" \
        manuscript-studio:latest || {
        log_error "Failed to start server"
    }
else
    docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        -p 127.0.0.1:5001:5001 \
        -v "$CONFIG_FILE:/config/config.yaml:ro" \
        -v "$CONFIG_DIR/logs:/logs" \
        -v "$MANUSCRIPT_REPOS_DIR:/repos" \
        -v "$HOME/.ssh:/home/manuscript/.ssh:ro" \
        manuscript-studio:latest || {
        log_error "Failed to start server"
    }
fi

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

if [[ "$DEV_MODE" == "1" ]]; then
    echo "Dev server is up. Access it at: http://127.0.0.1:5001/"
    echo ""
    echo "Useful commands:"
    echo "  docker logs -f $CONTAINER_NAME      # tail server logs"
    echo "  docker stop $CONTAINER_NAME         # stop server"
    echo "  make test                           # run the test suite"
else
    echo "Next steps:"
    echo "1. Configure your web server (Apache/Nginx) to proxy to localhost:5001"
    echo ""
    echo "Example Apache configuration (path-prefix hosting under /manuscripts):"
    echo "Set server.base_path: \"/manuscripts\" in your config.yaml to match."
    echo "----------------------------------------"
    cat << 'EOF'
<Location /manuscripts>
    ProxyPass http://127.0.0.1:5001/manuscripts
    ProxyPassReverse http://127.0.0.1:5001/manuscripts
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"
</Location>
EOF
    echo "----------------------------------------"
    echo ""
    echo "Or for a dedicated subdomain (no base_path needed):"
    echo "----------------------------------------"
    cat << 'EOF'
<VirtualHost *:443>
    ServerName manuscripts.your-domain.com

    ProxyPass / http://127.0.0.1:5001/
    ProxyPassReverse / http://127.0.0.1:5001/
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"
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
    echo "  docker logs $CONTAINER_NAME"
    echo ""
    echo "To stop the server:"
    echo "  docker stop $CONTAINER_NAME"
    echo ""
    echo "To update Manuscript Studio:"
    echo "  Run this script again - it will pull the latest version"
fi
echo ""
log_info "Installation complete!"
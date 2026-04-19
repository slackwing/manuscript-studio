# Manuscript Studio

A self-hosted, version-controlled manuscript annotation system that seamlessly integrates with your Git workflow.

## Features

- **Git-Native**: Your manuscript lives in Git, annotations follow automatically
- **Version Control**: Every edit creates a migration, preserving annotation history
- **Multi-Manuscript**: Manage multiple books/manuscripts in one instance
- **Sentence-Level Annotations**: Create color-coded sticky notes on individual sentences
- **Automatic Migration**: Push to Git triggers automatic annotation migration
- **Self-Hosted**: Full control over your data with PostgreSQL backend
- **Beautiful Reader**: Book-style pagination with typography optimizations

## Quick Start

### Prerequisites

- Docker
- PostgreSQL (local or managed)
- Git repository with your manuscript

### One-Line Installation

```bash
install_latest_manuscript_studio() { bash <(curl -sSL -H "Cache-Control: no-cache" "https://raw.githubusercontent.com/slackwing/manuscript-studio/main/install.sh"); }; install_latest_manuscript_studio
```

On first run, this creates a configuration template at `~/.config/manuscript-studio/config.yaml`. Edit it with your settings and run again to complete installation.

### Manual Installation

1. Clone the repository:
```bash
git clone https://github.com/slackwing/manuscript-studio.git
cd manuscript-studio
```

2. Copy and configure settings:
```bash
cp config.example.yaml ~/.config/manuscript-studio/config.yaml
# Edit config.yaml with your database and repository settings
```

3. Build and run with Docker:
```bash
docker build -t manuscript-studio .
docker run -d --name manuscript-studio \
  -p 5001:5001 \
  -v ~/.config/manuscript-studio:/config \
  manuscript-studio
```

4. Configure your web server to proxy to port 5001

## Configuration

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for detailed configuration options.

### Basic Configuration

```yaml
database:
  host: "localhost"
  port: 5432
  name: "manuscript_studio"
  user: "manuscript_user"
  password: "your-password"

manuscripts:
  - name: "my-book"
    title: "My Book Title"
    repository:
      url: "https://github.com/username/repo"
      branch: "main"
      path: "manuscript.md"
      auth_token: "github_pat_xxxxx"
```

## GitHub Webhook Setup

To enable automatic migration on push:

1. Generate a webhook secret:
```bash
openssl rand -hex 32
```

2. Add to your config.yaml:
```yaml
auth:
  webhook_secret: "your-generated-secret"
```

3. In GitHub repository settings:
   - Add webhook URL: `https://yourdomain.com/api/admin/webhook`
   - Set content type to `application/json`
   - Add the same secret
   - Select "Just the push event"

## Architecture

Manuscript Studio consists of:

- **API Server**: Go-based REST API with session authentication
- **Web Frontend**: Vanilla JavaScript with book-style rendering
- **Migration Engine**: Intelligent sentence tracking and annotation migration
- **PostgreSQL Database**: Stores annotations, migrations, and metadata

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for development setup.

```bash
# Run locally with docker-compose
docker-compose up

# Run tests
go test ./...

# Run frontend tests
npm test
```

## Documentation

- [Installation Guide](docs/INSTALLATION.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [API Documentation](docs/API.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## License

See [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](docs/CONTRIBUTING.md) for details.

## Acknowledgments

Built with:
- [Chi](https://github.com/go-chi/chi) - HTTP routing
- [pgx](https://github.com/jackc/pgx) - PostgreSQL driver
- [Paged.js](https://pagedjs.org/) - Beautiful pagination
- [Segman](https://github.com/slackwing/segman) - Sentence segmentation
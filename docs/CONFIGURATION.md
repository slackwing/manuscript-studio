# Configuration Reference

The server reads its configuration from a YAML file. Search order:

1. `MANUSCRIPT_STUDIO_CONFIG_FILE` environment variable (explicit path)
2. `/config/config.yaml` (the path the install script mounts into the container)
3. `~/.config/manuscript-studio/config.yaml`
4. `./config.yaml` (current working directory)

The first existing file wins. `config.example.yaml` is not in the search path — it is a template, not a fallback.

## Validation

Before the server starts, the loaded config is validated:

- **Manuscript paths** (`paths.repos_dir` + `manuscripts[*].name`) must resolve to a path inside `repos_dir` after `filepath.Clean`. A name like `../etc` will be rejected.
- **`server.base_path`** must match `^(/[A-Za-z0-9._~-]+)*$`. Quotes, angle brackets, and whitespace are rejected because the value is later interpolated into a `<base href="...">` HTML tag.
- **In production (`server.env: production`)**, every required secret (`database.password`, `auth.admin_password`, `auth.system_token`, `auth.session_secret`, `auth.webhook_secret`) must be non-empty AND must not contain the literal `REPLACE_ME` token. The `config.example.yaml` template ships with `REPLACE_ME_OR_SERVER_WONT_START` placeholders for exactly this reason.
- **Manuscript auth tokens** are also checked for the `REPLACE_ME` placeholder.

A failed validation prints the offending field and aborts startup.

## Section reference

### `database`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `host` | string | required | Postgres host |
| `port` | int | `5432` | |
| `name` | string | required | Database name (must already exist) |
| `user` | string | required | |
| `password` | string | required (prod) | |

### `auth`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `admin_username` | string | — | Seeded by `admin-upsert` on every install. |
| `admin_password` | string | required (prod) | Min 4 chars. |
| `system_token` | string | required (prod) | Bearer token for `/api/admin/*`. Generate with `openssl rand -hex 32`. |
| `session_secret` | string | required (prod) | Reserved for future use. |
| `webhook_secret` | string | required (prod) | HMAC secret for GitHub webhooks. |

### `server`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `port` | int | `5001` | |
| `host` | string | `0.0.0.0` | |
| `env` | string | `development` | Set to `production` to enable HSTS, validation, etc. |
| `base_path` | string | `""` (root) | URL prefix when reverse-proxied under a path. Validated; see above. |

### `paths`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `private_dir` | string | required | Where server source/data live (used by install script). |
| `repos_dir` | string | `/repos` | Root for manuscript checkouts. Validated against every manuscript's path. |

### `manuscripts[]`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `name` | string | required | URL-safe identifier; also the on-disk directory name under `repos_dir`. |
| `repository.slug` | string | required (in normal use) | Canonical `owner/repo` identifier. The clone URL is derived from this and `use_ssh`. Also matches incoming GitHub webhooks against `payload.repository.full_name`. |
| `repository.use_ssh` | bool | `false` | When `true`, clone URL = `git@github.com:<slug>.git` (requires SSH key on server). When `false`, clone URL = `https://github.com/<slug>.git` (set `auth_token` for private repos). |
| `repository.url` | string | optional | Escape hatch. If set, takes precedence over the slug-derived URL. Use for local filesystem paths (dev) or non-GitHub hosts. |
| `repository.branch` | string | required | Branch to track. |
| `repository.path` | string | required | Path to manuscript file within the repo. |
| `repository.auth_token` | string | optional | GitHub PAT for private repos when `use_ssh: false`. Supplied to git via `GIT_ASKPASS`, never embedded in URLs. Unused when `use_ssh: true`. |

**At least one of `slug` or `url` must be set**, otherwise the server has no way to clone the repo. The webhook matcher needs `slug` (or a literal URL match against `url`) to route incoming GitHub events.

### `rate_limits`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `admin_per_token_rpm` | int | `10` | Per-process token-bucket rate for `/api/admin/*`, keyed by hashed Authorization header. Set to `0` to disable. |
| `admin_per_token_burst` | int | `5` | Burst size for the per-token bucket. |

### `logging`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `directory` | string | — | Where the install script tells Docker to mount log output. Logs themselves go to stdout/stderr; Docker captures them. |
| `level` | string | `info` | `debug`, `info`, `warn`, `error`. |
| `max_age_days` / `max_size_mb` / `rotate` | — | — | Reserved for future log-rotation work. |

### `migrations`
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `lock_during_migration` | bool | `true` | Reserved. |
| `backup_before_migration` | bool | `false` | Reserved. |
| `queue_annotations` | bool | `true` | Reserved. |

## Environment variable overrides

| Variable | Effect |
|----------|--------|
| `MANUSCRIPT_STUDIO_CONFIG_FILE` | Bypass the search list and load this exact path. |
| `MANUSCRIPT_STUDIO_REPOS_DIR` | Override `paths.repos_dir`. Used by `make dev` to point at the host's repos directory instead of the in-container `/repos` mount. |

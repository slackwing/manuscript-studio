package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// placeholderToken is the literal string that config.example.yaml uses for
// every secret value. The server refuses to start in production if any
// secret still contains it. Dev configs (env=development) are exempt
// because dev intentionally uses weak, hard-coded secrets.
const placeholderToken = "REPLACE_ME"

// Config represents the application configuration
type Config struct {
	Version     string             `yaml:"version"`
	Database    DatabaseConfig     `yaml:"database"`
	Auth        AuthConfig         `yaml:"auth"`
	Server      ServerConfig       `yaml:"server"`
	Paths       PathsConfig        `yaml:"paths"`
	Logging     LoggingConfig      `yaml:"logging"`
	Manuscripts []ManuscriptConfig `yaml:"manuscripts"`
	Migrations  MigrationConfig    `yaml:"migrations"`
	RateLimits  RateLimitsConfig   `yaml:"rate_limits"`
}

// DatabaseConfig contains database connection settings
type DatabaseConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Name     string `yaml:"name"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
}

// AuthConfig contains authentication settings
type AuthConfig struct {
	SystemToken    string `yaml:"system_token"`
	SessionSecret  string `yaml:"session_secret"`
	WebhookSecret  string `yaml:"webhook_secret"`
	AdminUsername  string `yaml:"admin_username"`
	AdminPassword  string `yaml:"admin_password"`
}

// ServerConfig contains server settings
type ServerConfig struct {
	Port     int    `yaml:"port"`
	Host     string `yaml:"host"`
	Env      string `yaml:"env"`
	BasePath string `yaml:"base_path"` // URL prefix when mounted under a path (e.g. "/manuscripts"). No trailing slash.
}

// PathsConfig contains file path settings
type PathsConfig struct {
	PrivateDir string `yaml:"private_dir"`

	// ReposDir is the root under which manuscript git checkouts live.
	// Every manuscript's clone path must resolve inside this directory.
	// If unset, the server falls back to the legacy /repos default
	// (matching the Docker mount the install script sets up).
	ReposDir string `yaml:"repos_dir"`
}

// LoggingConfig contains logging settings
type LoggingConfig struct {
	Directory   string `yaml:"directory"`
	Level       string `yaml:"level"`
	MaxAgeDays  int    `yaml:"max_age_days"`
	MaxSizeMB   int    `yaml:"max_size_mb"`
	Rotate      bool   `yaml:"rotate"`
}

// ManuscriptConfig represents a single manuscript configuration
type ManuscriptConfig struct {
	Name          string           `yaml:"name"`
	Repository    RepositoryConfig `yaml:"repository"`
	WebhookSecret string           `yaml:"webhook_secret,omitempty"`
}

// RepositoryConfig contains git repository settings.
//
// The clone URL is normally derived from `slug` + `use_ssh`:
//   - use_ssh: false (default) → https://github.com/<slug>.git
//   - use_ssh: true            → git@github.com:<slug>.git
//
// Set `url` only when you need an escape hatch — e.g. a local filesystem
// path for dev, or a non-GitHub host. If `url` is set, it wins over the
// slug-derived form.
//
// `slug` is also the canonical "owner/repo" identifier used to match
// incoming GitHub webhooks (compared against payload.repository.full_name).
type RepositoryConfig struct {
	Slug      string `yaml:"slug"`
	UseSSH    bool   `yaml:"use_ssh"`
	URL       string `yaml:"url"` // optional override; if set, takes precedence over slug+use_ssh
	Branch    string `yaml:"branch"`
	Path      string `yaml:"path"`
	AuthToken string `yaml:"auth_token"`
}

// CloneURL returns the URL git should actually clone/pull. Precedence:
//   1. Explicit URL if set (escape hatch for local paths, non-GitHub, etc.)
//   2. Derived from slug + use_ssh
//   3. Empty string if neither is set (caller should treat as a config error).
func (r RepositoryConfig) CloneURL() string {
	if r.URL != "" {
		return r.URL
	}
	if r.Slug == "" {
		return ""
	}
	if r.UseSSH {
		return "git@github.com:" + r.Slug + ".git"
	}
	return "https://github.com/" + r.Slug + ".git"
}

// MigrationConfig contains migration behavior settings
type MigrationConfig struct {
	LockDuringMigration   bool `yaml:"lock_during_migration"`
	BackupBeforeMigration bool `yaml:"backup_before_migration"`
	QueueAnnotations      bool `yaml:"queue_annotations"`
}

// RateLimitsConfig tunes the per-process rate limiter. Zero disables the
// corresponding limit.
type RateLimitsConfig struct {
	// AdminPerTokenRPM is the steady-state per-token request budget for
	// /api/admin/* endpoints. Default 10.
	AdminPerTokenRPM int `yaml:"admin_per_token_rpm"`
	// AdminPerTokenBurst is the burst size for the per-token bucket. Default 5.
	AdminPerTokenBurst int `yaml:"admin_per_token_burst"`
}

// Load loads configuration from file
func Load() (*Config, error) {
	// MANUSCRIPT_STUDIO_CONFIG_FILE env var takes precedence — used by dev mode to point at
	// ~/.config/manuscript-studio-dev/config.yaml without touching the prod path.
	var configPath string
	if envPath := os.Getenv("MANUSCRIPT_STUDIO_CONFIG_FILE"); envPath != "" {
		if _, err := os.Stat(envPath); err == nil {
			configPath = envPath
		} else {
			return nil, fmt.Errorf("MANUSCRIPT_STUDIO_CONFIG_FILE=%s not found: %w", envPath, err)
		}
	}

	// Fall back to conventional search paths. config.example.yaml is
	// deliberately NOT in this list — it ships with REPLACE_ME placeholder
	// secrets that would fail Validate() in production anyway, and silently
	// using a "fallback" config in dev tends to mask missing-config bugs.
	configPaths := []string{
		"/config/config.yaml", // Docker mount
		filepath.Join(os.Getenv("HOME"), ".config/manuscript-studio/config.yaml"), // User config
		"config.yaml", // Local development
	}

	if configPath == "" {
		for _, path := range configPaths {
			if _, err := os.Stat(path); err == nil {
				configPath = path
				break
			}
		}
	}

	if configPath == "" {
		return nil, fmt.Errorf("no configuration file found in: %v", configPaths)
	}

	// Read file
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", configPath, err)
	}

	// Parse YAML
	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	// Set defaults
	if config.Server.Port == 0 {
		config.Server.Port = 5001
	}
	if config.Server.Host == "" {
		config.Server.Host = "0.0.0.0"
	}
	if config.Server.Env == "" {
		config.Server.Env = "development"
	}
	if config.Database.Port == 0 {
		config.Database.Port = 5432
	}
	config.Server.BasePath = normalizeBasePath(config.Server.BasePath)

	// Expand paths
	config.Paths.PrivateDir = expandPath(config.Paths.PrivateDir)
	config.Logging.Directory = expandPath(config.Logging.Directory)
	for i := range config.Manuscripts {
		config.Manuscripts[i].Repository.URL = expandPath(config.Manuscripts[i].Repository.URL)
	}

	if err := config.Validate(); err != nil {
		return nil, fmt.Errorf("invalid config in %s: %w", configPath, err)
	}

	return &config, nil
}

// Validate enforces invariants that the YAML schema can't express:
//   - structural checks (manuscript paths inside repos_dir) run always,
//   - secret-quality checks (no REPLACE_ME placeholders, nothing empty)
//     run only in production, since dev intentionally uses weak secrets.
func (c *Config) Validate() error {
	if err := c.ValidateManuscriptPaths(); err != nil {
		return err
	}

	if c.Server.BasePath != "" && !basePathPattern.MatchString(c.Server.BasePath) {
		return fmt.Errorf("server.base_path %q has invalid characters; only [A-Za-z0-9._~-] segments separated by '/' are allowed", c.Server.BasePath)
	}

	if c.Server.Env != "production" {
		return nil
	}

	type field struct {
		name  string
		value string
	}
	required := []field{
		{"database.password", c.Database.Password},
		{"auth.admin_password", c.Auth.AdminPassword},
		{"auth.system_token", c.Auth.SystemToken},
		{"auth.session_secret", c.Auth.SessionSecret},
		{"auth.webhook_secret", c.Auth.WebhookSecret},
	}
	for _, f := range required {
		if f.value == "" {
			return fmt.Errorf("%s is empty (required in production)", f.name)
		}
		if strings.Contains(f.value, placeholderToken) {
			return fmt.Errorf("%s still contains the placeholder token %q — replace it before running in production", f.name, placeholderToken)
		}
	}

	for i, m := range c.Manuscripts {
		if strings.Contains(m.Repository.AuthToken, placeholderToken) {
			return fmt.Errorf("manuscripts[%d].repository.auth_token still contains the placeholder token %q", i, placeholderToken)
		}
	}

	return nil
}

// normalizeBasePath ensures leading slash, no trailing slash, empty if root.
func normalizeBasePath(p string) string {
	if p == "" || p == "/" {
		return ""
	}
	if p[0] != '/' {
		p = "/" + p
	}
	for len(p) > 1 && p[len(p)-1] == '/' {
		p = p[:len(p)-1]
	}
	return p
}

// basePathPattern restricts base_path to URL-safe characters. Anything else
// (quotes, angle brackets, whitespace) could break out of the
// <base href="..."> attribute and become an injection vector.
// Empty is fine — it means root hosting.
var basePathPattern = regexp.MustCompile(`^(?:/[A-Za-z0-9._~-]+)*$`)

// expandPath expands ~ to home directory
func expandPath(path string) string {
	if path == "" {
		return path
	}
	if path[0] == '~' {
		home, err := os.UserHomeDir()
		if err != nil {
			return path
		}
		return filepath.Join(home, path[1:])
	}
	return path
}

// GetManuscript returns the configuration for a specific manuscript by name
func (c *Config) GetManuscript(name string) (*ManuscriptConfig, error) {
	for _, m := range c.Manuscripts {
		if m.Name == name {
			return &m, nil
		}
	}
	return nil, fmt.Errorf("manuscript %s not found", name)
}

// ReposDir returns the resolved root directory for manuscript checkouts.
// Precedence: MANUSCRIPT_STUDIO_REPOS_DIR env var > paths.repos_dir config >
// legacy "/repos" default (the Docker mount path).
func (c *Config) ReposDir() string {
	if d := os.Getenv("MANUSCRIPT_STUDIO_REPOS_DIR"); d != "" {
		return expandPath(d)
	}
	if c.Paths.ReposDir != "" {
		return expandPath(c.Paths.ReposDir)
	}
	return "/repos"
}

// RepoPath returns the absolute on-disk path for a manuscript's checkout
// (ReposDir + manuscript name). The result is guaranteed to be inside
// ReposDir — see ValidateManuscriptPaths.
func (c *Config) RepoPath(manuscriptName string) string {
	return filepath.Join(c.ReposDir(), manuscriptName)
}

// ValidateManuscriptPaths ensures every manuscript's RepoPath resolves to
// something inside ReposDir. Defends against a misconfigured (or malicious)
// manuscript name like "../../etc" that would otherwise let MkdirAll create
// directories outside the intended root.
func (c *Config) ValidateManuscriptPaths() error {
	root, err := filepath.Abs(c.ReposDir())
	if err != nil {
		return fmt.Errorf("cannot resolve repos_dir %q: %w", c.ReposDir(), err)
	}
	rootSlash := filepath.Clean(root) + string(os.PathSeparator)

	for i, m := range c.Manuscripts {
		if m.Name == "" {
			return fmt.Errorf("manuscripts[%d].name is empty", i)
		}
		abs, err := filepath.Abs(c.RepoPath(m.Name))
		if err != nil {
			return fmt.Errorf("manuscripts[%d] (%s): cannot resolve repo path: %w", i, m.Name, err)
		}
		clean := filepath.Clean(abs) + string(os.PathSeparator)
		if !strings.HasPrefix(clean, rootSlash) {
			return fmt.Errorf("manuscripts[%d] (%s): repo path %q escapes repos_dir %q", i, m.Name, abs, root)
		}
	}
	return nil
}
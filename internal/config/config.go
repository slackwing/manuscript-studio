package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Placeholder used in config.example.yaml for every secret. Production
// startup rejects any secret still containing it; dev is exempt because dev
// intentionally uses weak, hard-coded secrets.
const placeholderToken = "REPLACE_ME"

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

type DatabaseConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Name     string `yaml:"name"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
}

type AuthConfig struct {
	SystemToken    string `yaml:"system_token"`
	SessionSecret  string `yaml:"session_secret"`
	WebhookSecret  string `yaml:"webhook_secret"`
	AdminUsername  string `yaml:"admin_username"`
	AdminPassword  string `yaml:"admin_password"`
}

type ServerConfig struct {
	Port     int    `yaml:"port"`
	Host     string `yaml:"host"`
	Env      string `yaml:"env"`
	BasePath string `yaml:"base_path"` // URL prefix when mounted under a path (e.g. "/manuscripts"). No trailing slash.
}

type PathsConfig struct {
	PrivateDir string `yaml:"private_dir"`

	// Root for all manuscript git checkouts. Every manuscript's clone path
	// must resolve inside this. Falls back to legacy /repos when unset.
	ReposDir string `yaml:"repos_dir"`
}

type LoggingConfig struct {
	Directory   string `yaml:"directory"`
	Level       string `yaml:"level"`
	MaxAgeDays  int    `yaml:"max_age_days"`
	MaxSizeMB   int    `yaml:"max_size_mb"`
	Rotate      bool   `yaml:"rotate"`
}

type ManuscriptConfig struct {
	Name          string           `yaml:"name"`
	Repository    RepositoryConfig `yaml:"repository"`
	WebhookSecret string           `yaml:"webhook_secret,omitempty"`
}

// RepositoryConfig: clone URL is derived from slug+use_ssh unless `url` is
// set (escape hatch for local paths or non-GitHub hosts). `slug` is also the
// canonical "owner/repo" used to match incoming GitHub webhooks.
// See TestMatchManuscriptForWebhook and CloneURL().
type RepositoryConfig struct {
	Slug      string `yaml:"slug"`
	UseSSH    bool   `yaml:"use_ssh"`
	URL       string `yaml:"url"` // optional override; if set, takes precedence over slug+use_ssh
	Branch    string `yaml:"branch"`
	Path      string `yaml:"path"`
	AuthToken string `yaml:"auth_token"`
}

// CloneURL precedence: explicit URL > slug+use_ssh > empty (config error).
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

type MigrationConfig struct {
	LockDuringMigration   bool `yaml:"lock_during_migration"`
	BackupBeforeMigration bool `yaml:"backup_before_migration"`
	QueueAnnotations      bool `yaml:"queue_annotations"`
}

// RateLimitsConfig tunes the per-process rate limiter; zero disables.
type RateLimitsConfig struct {
	// Steady-state per-token budget for /api/admin/*. Default 10.
	AdminPerTokenRPM int `yaml:"admin_per_token_rpm"`
	// Burst size for the per-token bucket. Default 5.
	AdminPerTokenBurst int `yaml:"admin_per_token_burst"`
}

func Load() (*Config, error) {
	// MANUSCRIPT_STUDIO_CONFIG_FILE wins — dev mode uses it to point at
	// ~/.config/manuscript-studio-dev/config.yaml without touching prod paths.
	var configPath string
	if envPath := os.Getenv("MANUSCRIPT_STUDIO_CONFIG_FILE"); envPath != "" {
		if _, err := os.Stat(envPath); err == nil {
			configPath = envPath
		} else {
			return nil, fmt.Errorf("MANUSCRIPT_STUDIO_CONFIG_FILE=%s not found: %w", envPath, err)
		}
	}

	// config.example.yaml is deliberately excluded — it ships REPLACE_ME
	// placeholders (fails prod Validate()) and silently falling back to it
	// in dev tends to mask missing-config bugs.
	configPaths := []string{
		"/config/config.yaml",
		filepath.Join(os.Getenv("HOME"), ".config/manuscript-studio/config.yaml"),
		"config.yaml",
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

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", configPath, err)
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

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

// Validate enforces invariants the YAML schema can't. Structural checks
// (manuscript paths inside repos_dir) always run; secret-quality checks
// run only in production, since dev intentionally uses weak secrets.
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

// Ensures leading slash, no trailing slash, empty string for root.
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

// basePathPattern restricts base_path to URL-safe chars; anything else could
// escape the <base href="..."> attribute and become an injection vector.
var basePathPattern = regexp.MustCompile(`^(?:/[A-Za-z0-9._~-]+)*$`)

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

func (c *Config) GetManuscript(name string) (*ManuscriptConfig, error) {
	for _, m := range c.Manuscripts {
		if m.Name == name {
			return &m, nil
		}
	}
	return nil, fmt.Errorf("manuscript %s not found", name)
}

// ReposDir precedence: MANUSCRIPT_STUDIO_REPOS_DIR env > paths.repos_dir >
// legacy "/repos" default (matches the Docker mount).
func (c *Config) ReposDir() string {
	if d := os.Getenv("MANUSCRIPT_STUDIO_REPOS_DIR"); d != "" {
		return expandPath(d)
	}
	if c.Paths.ReposDir != "" {
		return expandPath(c.Paths.ReposDir)
	}
	return "/repos"
}

// RepoPath is ReposDir/<name>, guaranteed inside ReposDir (see ValidateManuscriptPaths).
func (c *Config) RepoPath(manuscriptName string) string {
	return filepath.Join(c.ReposDir(), manuscriptName)
}

// ValidateManuscriptPaths defends against a manuscript name like "../../etc"
// that would let MkdirAll escape ReposDir.
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
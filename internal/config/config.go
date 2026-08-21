package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	// The production container ships no /usr/share/zoneinfo; embedding the
	// IANA database makes wordcount_history.timezone work everywhere.
	_ "time/tzdata"

	"gopkg.in/yaml.v3"
)

// Placeholder used in config.example.yaml for every secret. Production
// startup rejects any secret still containing it; dev is exempt because dev
// intentionally uses weak, hard-coded secrets.
const placeholderToken = "REPLACE_ME"

type Config struct {
	Version  string         `yaml:"version"`
	Database DatabaseConfig `yaml:"database"`
	Auth     AuthConfig     `yaml:"auth"`
	Server   ServerConfig   `yaml:"server"`
	Paths    PathsConfig    `yaml:"paths"`
	Logging  LoggingConfig  `yaml:"logging"`
	// GitRepos is the credential/topology registry (Phase 0,
	// MANUSCRIPT_LIFECYCLE_PLAN). WHAT a manuscript is lives in the DB;
	// config holds only what the operator must supply: how to reach repos.
	GitRepos []GitRepoConfig `yaml:"git_repos"`
	// Manuscripts is the LEGACY per-manuscript config. Still honored:
	// Load() synthesizes a GitRepos entry per legacy manuscript, and
	// startup reconciliation upserts the manuscript rows into the DB.
	Manuscripts []ManuscriptConfig `yaml:"manuscripts"`
	Migrations  MigrationConfig    `yaml:"migrations"`
	RateLimits  RateLimitsConfig   `yaml:"rate_limits"`

	// Optional daily wordcount history (the wordcount-over-time graph's
	// data). When enabled, an in-process cron recomputes every manuscript's
	// row hourly (keyed by day — intra-day runs overwrite today's row) and
	// the homepage/info-header wordcounts are served from the history table
	// instead of the live count. When disabled nothing runs and nothing
	// else changes.
	WordcountHistory WordcountHistoryConfig `yaml:"wordcount_history"`
}

type WordcountHistoryConfig struct {
	Enabled bool `yaml:"enabled"`
	// Compute cadence in minutes; rows stay keyed by day regardless.
	// Default 60.
	IntervalMinutes int `yaml:"interval_minutes"`
	// IANA timezone that defines the day cutoff for history rows
	// (e.g. "America/New_York"). Default "UTC".
	Timezone string `yaml:"timezone"`
}

// Location resolves the configured timezone (default UTC). Validate()
// guarantees it parses, so runtime resolution cannot fail.
func (w WordcountHistoryConfig) Location() *time.Location {
	if w.Timezone == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(w.Timezone)
	if err != nil {
		return time.UTC
	}
	return loc
}

type DatabaseConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Name     string `yaml:"name"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
}

// AuthConfig — note: sessions are DB-backed random tokens, so there is no
// session_secret here; a legacy session_secret key in an existing yaml is
// silently ignored by the parser.
type AuthConfig struct {
	SystemToken   string `yaml:"system_token"`
	WebhookSecret string `yaml:"webhook_secret"`
	AdminUsername string `yaml:"admin_username"`
	AdminPassword string `yaml:"admin_password"`
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
	Directory  string `yaml:"directory"`
	Level      string `yaml:"level"`
	MaxAgeDays int    `yaml:"max_age_days"`
	MaxSizeMB  int    `yaml:"max_size_mb"`
	Rotate     bool   `yaml:"rotate"`
}

type ManuscriptConfig struct {
	Name          string           `yaml:"name"`
	Repository    RepositoryConfig `yaml:"repository"`
	WebhookSecret string           `yaml:"webhook_secret,omitempty"`
}

// GitRepoConfig is one entry in the git_repos registry: everything needed
// to clone/fetch/push a repository, keyed by Name. Manuscript rows in the
// DB reference entries via manuscript.git_repo_name.
type GitRepoConfig struct {
	Name          string `yaml:"name"`
	Slug          string `yaml:"slug"`
	UseSSH        bool   `yaml:"use_ssh"`
	URL           string `yaml:"url"` // optional override; wins over slug+use_ssh
	AuthToken     string `yaml:"auth_token"`
	WebhookSecret string `yaml:"webhook_secret,omitempty"`
}

// CloneURL precedence: explicit URL > slug+use_ssh > empty (config error).
func (g GitRepoConfig) CloneURL() string {
	return RepositoryConfig{Slug: g.Slug, UseSSH: g.UseSSH, URL: g.URL}.CloneURL()
}

// GetGitRepo returns the registry entry by name, nil when absent.
func (c *Config) GetGitRepo(name string) *GitRepoConfig {
	for i := range c.GitRepos {
		if c.GitRepos[i].Name == name {
			return &c.GitRepos[i]
		}
	}
	return nil
}

// synthesizeLegacyGitRepos maps each legacy manuscripts: entry to a
// git_repos entry of the same name (skipping names the registry already
// defines, so an explicit git_repos entry wins). Called from Load().
func (c *Config) synthesizeLegacyGitRepos() {
	for _, m := range c.Manuscripts {
		if c.GetGitRepo(m.Name) != nil {
			continue
		}
		c.GitRepos = append(c.GitRepos, GitRepoConfig{
			Name:          m.Name,
			Slug:          m.Repository.Slug,
			UseSSH:        m.Repository.UseSSH,
			URL:           m.Repository.URL,
			AuthToken:     m.Repository.AuthToken,
			WebhookSecret: m.WebhookSecret,
		})
	}
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
	if config.WordcountHistory.IntervalMinutes <= 0 {
		config.WordcountHistory.IntervalMinutes = 60
	}
	config.Server.BasePath = normalizeBasePath(config.Server.BasePath)

	config.Paths.PrivateDir = expandPath(config.Paths.PrivateDir)
	config.Logging.Directory = expandPath(config.Logging.Directory)
	for i := range config.Manuscripts {
		config.Manuscripts[i].Repository.URL = expandPath(config.Manuscripts[i].Repository.URL)
	}
	for i := range config.GitRepos {
		config.GitRepos[i].URL = expandPath(config.GitRepos[i].URL)
	}
	config.synthesizeLegacyGitRepos()

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

	if c.WordcountHistory.Timezone != "" {
		if _, err := time.LoadLocation(c.WordcountHistory.Timezone); err != nil {
			return fmt.Errorf("wordcount_history.timezone %q is not a valid IANA timezone: %w", c.WordcountHistory.Timezone, err)
		}
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
	for i, g := range c.GitRepos {
		if strings.Contains(g.AuthToken, placeholderToken) {
			return fmt.Errorf("git_repos[%d].auth_token still contains the placeholder token %q", i, placeholderToken)
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
	if path == "~" || strings.HasPrefix(path, "~/") {
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

// Checkout layout under ReposDir (git_repo layout decision, LIFECYCLE plan):
//   git/remote/<git_repo_name>  clones of external repos
//   git/local/<manuscript name> server-owned local-mode repos
// The flat legacy layout (ReposDir/<name>) is migrated at startup by
// MigrateReposLayout.

// GitRemoteDir is where the clone of registry entry `gitRepoName` lives.
func (c *Config) GitRemoteDir(gitRepoName string) string {
	return filepath.Join(c.ReposDir(), "git", "remote", gitRepoName)
}

// GitLocalDir is where a local-mode manuscript's repo lives.
func (c *Config) GitLocalDir(manuscriptName string) string {
	return filepath.Join(c.ReposDir(), "git", "local", manuscriptName)
}

// validateRepoDirName requires a repo/manuscript name to be a single clean
// path segment — the defense against "../..", "a/b", or absolute paths
// escaping the git/ layout via MkdirAll. (The nested git/remote|local layout
// means a partial ../ traversal could stay inside ReposDir yet land outside
// its own subtree, so prefix checks alone aren't enough.)
func validateRepoDirName(name string) error {
	if name == "" {
		return fmt.Errorf("name is empty")
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." || filepath.Clean(name) != name {
		return fmt.Errorf("name %q must be a plain directory name (no separators or traversal)", name)
	}
	return nil
}

// insideReposDir reports whether path resolves inside ReposDir — the
// defense against names like "../../etc" escaping via MkdirAll.
func (c *Config) insideReposDir(path string) error {
	root, err := filepath.Abs(c.ReposDir())
	if err != nil {
		return fmt.Errorf("cannot resolve repos_dir %q: %w", c.ReposDir(), err)
	}
	rootSlash := filepath.Clean(root) + string(os.PathSeparator)
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("cannot resolve repo path %q: %w", path, err)
	}
	clean := filepath.Clean(abs) + string(os.PathSeparator)
	if !strings.HasPrefix(clean, rootSlash) {
		return fmt.Errorf("repo path %q escapes repos_dir %q", abs, root)
	}
	return nil
}

// ValidateManuscriptPaths checks every configured repo name against
// path-escape. (Manuscript names created via the API are validated at the
// API boundary with the same helper.)
func (c *Config) ValidateManuscriptPaths() error {
	for i, m := range c.Manuscripts {
		if m.Name == "" {
			return fmt.Errorf("manuscripts[%d].name is empty", i)
		}
		if err := validateRepoDirName(m.Name); err != nil {
			return fmt.Errorf("manuscripts[%d]: %w", i, err)
		}
	}
	for i, g := range c.GitRepos {
		if g.Name == "" {
			return fmt.Errorf("git_repos[%d].name is empty", i)
		}
		if err := validateRepoDirName(g.Name); err != nil {
			return fmt.Errorf("git_repos[%d]: %w", i, err)
		}
	}
	return nil
}

// ValidateLocalName is the API-boundary check for a manuscript name that
// will become a git/local directory: a plain segment that resolves inside
// ReposDir.
func (c *Config) ValidateLocalName(name string) error {
	if err := validateRepoDirName(name); err != nil {
		return err
	}
	return c.insideReposDir(c.GitLocalDir(name))
}

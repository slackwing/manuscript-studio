package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Config represents the application configuration
type Config struct {
	Version   string           `yaml:"version"`
	Database  DatabaseConfig   `yaml:"database"`
	Auth      AuthConfig       `yaml:"auth"`
	Server    ServerConfig     `yaml:"server"`
	Paths     PathsConfig      `yaml:"paths"`
	Logging   LoggingConfig    `yaml:"logging"`
	Manuscripts []ManuscriptConfig `yaml:"manuscripts"`
	Migrations MigrationConfig    `yaml:"migrations"`
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
}

// ServerConfig contains server settings
type ServerConfig struct {
	Port int    `yaml:"port"`
	Host string `yaml:"host"`
	Env  string `yaml:"env"`
}

// PathsConfig contains file path settings
type PathsConfig struct {
	PublicDir       string `yaml:"public_dir"`
	PrivateDir      string `yaml:"private_dir"`
	ManuscriptRepos string `yaml:"manuscript_repos"`
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

// RepositoryConfig contains git repository settings
type RepositoryConfig struct {
	URL       string `yaml:"url"`
	Branch    string `yaml:"branch"`
	Path      string `yaml:"path"`
	AuthToken string `yaml:"auth_token"`
}

// MigrationConfig contains migration behavior settings
type MigrationConfig struct {
	LockDuringMigration   bool `yaml:"lock_during_migration"`
	BackupBeforeMigration bool `yaml:"backup_before_migration"`
	QueueAnnotations      bool `yaml:"queue_annotations"`
}

// Load loads configuration from file
func Load() (*Config, error) {
	// Try multiple locations for config file
	configPaths := []string{
		"/config/config.yaml",                               // Docker mount
		filepath.Join(os.Getenv("HOME"), ".config/manuscript-studio/config.yaml"), // User config
		"config.yaml",                                        // Local development
		"config.example.yaml",                                // Fallback for testing
	}

	var configPath string
	for _, path := range configPaths {
		if _, err := os.Stat(path); err == nil {
			configPath = path
			break
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

	// Expand paths
	config.Paths.PublicDir = expandPath(config.Paths.PublicDir)
	config.Paths.PrivateDir = expandPath(config.Paths.PrivateDir)
	config.Paths.ManuscriptRepos = expandPath(config.Paths.ManuscriptRepos)
	config.Logging.Directory = expandPath(config.Logging.Directory)

	return &config, nil
}

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
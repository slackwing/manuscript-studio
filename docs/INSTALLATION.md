# Installation

The canonical entry point is the one-line installer at the top of [README.md](../README.md). It downloads `install.sh`, creates `~/.config/manuscript-studio/config.yaml` from the template, generates random secrets for you (when `openssl` is available), then waits for you to fill in the database and repository specifics.

After editing the config, run the installer again. It will:

1. Verify the database connection (offers to create the DB if missing).
2. Build the Liquibase migrations image and apply schema.
3. Build the Manuscript Studio image and run it as a container.
4. Seed the admin user from `auth.admin_username` / `auth.admin_password`.
5. Print the next-steps for setting up your reverse proxy.

For configuration details see [CONFIGURATION.md](CONFIGURATION.md).
For the API surface see [API.md](API.md).

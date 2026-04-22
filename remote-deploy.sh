#!/usr/bin/env bash
# ==============================================================================
# remote-deploy.sh — trigger a redeploy of Manuscript Studio on a remote VM.
# For setting up remote deploys by Claude.
# ==============================================================================
#
# This wrapper invokes a SINGLE pre-configured SSH host alias. The alias must
# be set up in ~/.ssh/config to (a) point at the right VM, (b) use ONLY a
# dedicated restricted key, and (c) the VM must have that key locked down via
# `command="..."` in authorized_keys so it can do nothing but run the deploy.
# Four layers of defense (Claude permission allowlist → this wrapper → SSH
# IdentitiesOnly → VM forced-command) means no single misstep grants shell.
#
# ------------------------------------------------------------------------------
# One-time setup (do this once, then any future redeploys are just `./remote-deploy.sh`)
# ------------------------------------------------------------------------------
#
# 1. ON YOUR LAPTOP — generate a dedicated keypair (do not reuse your normal
#    SSH key). The path is hardcoded; pick the empty-passphrase form so
#    non-interactive ssh works:
#
#       ssh-keygen -t ed25519 -f ~/.ssh/deploy_latest_manuscript_studio_authorized -N ""
#
# 2. ON YOUR LAPTOP — add a host alias to ~/.ssh/config. This script
#    hardcodes the alias name and identity-file path; if you change them,
#    change them in BOTH places:
#
#       Host remote-deploy-latest-manuscript-studio
#           HostName your-vm.example.com
#           User your-vm-user
#           IdentityFile ~/.ssh/deploy_latest_manuscript_studio_authorized
#           IdentitiesOnly yes
#
#    `IdentitiesOnly yes` is non-negotiable: it tells ssh to use ONLY the
#    file in IdentityFile and NOT fall back to ssh-agent or default keys.
#    Without it, ssh would try your full-access ~/.ssh/id_ed25519 first
#    and the lockdown is meaningless.
#
# 3. ON YOUR LAPTOP — copy the public key to the VM:
#
#       ssh-copy-id -i ~/.ssh/deploy_latest_manuscript_studio_authorized.pub your-vm-user@your-vm.example.com
#
# 4. ON THE VM — restrict that key to ONLY running the deploy script.
#    Edit ~/.ssh/authorized_keys, find the line you just added (it ends
#    with the comment "deploy_latest_manuscript_studio_authorized" or
#    similar), and prepend the forced-command + restrictions:
#
#       command="/home/YOUR_VM_USER/deploy_latest_manuscript_studio.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA... slackwing@blackwing
#
#    The command="..." override is enforced by sshd. Anything sent over
#    this key — `ssh remote-deploy-latest-manuscript-studio whatever` —
#    runs that script and only that script. No shell, no other commands,
#    no port-forwarding.
#
#    Use the absolute path; authorized_keys does not expand $HOME or ~.
#
# 5. ON THE VM — make sure deploy_latest_manuscript_studio.sh exists and is
#    executable. install.sh drops it at $HOME on every run, so once you've
#    done the manual install one-liner once, this file is already there.
#
# 6. TEST from your laptop:
#
#       ssh remote-deploy-latest-manuscript-studio 'echo test'
#
#    You should see install.sh's output, NOT "test" — proving the
#    forced-command override is working.
#
# ==============================================================================

set -euo pipefail

ssh remote-deploy-latest-manuscript-studio

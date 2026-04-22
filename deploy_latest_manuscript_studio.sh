#!/usr/bin/env bash
# ==============================================================================
# deploy_latest_manuscript_studio.sh
# For setting up remote deploys by Claude.
# ==============================================================================
#
# This script lets a developer (or, with the SSH-key setup below, a constrained
# AI assistant) trigger a redeploy of Manuscript Studio without holding shell
# access on the VM. It runs the public install one-liner, which is idempotent
# and safe to re-run on a healthy install — Docker rebuild, Liquibase migrate,
# server restart.
#
# install.sh ships this script to ~/deploy_latest_manuscript_studio.sh on every
# install, so once you've done the manual install once, this file is already
# waiting on the VM for future redeploys.
#
# ------------------------------------------------------------------------------
# How to set up the SSH-key access (one-time, on your laptop and the VM)
# ------------------------------------------------------------------------------
#
# 1. ON YOUR LAPTOP — generate a dedicated keypair (do not reuse your normal
#    key). Pick any path; this README assumes the user-suggested name:
#
#       ssh-keygen -t ed25519 -f ~/.ssh/deploy_latest_manuscript_studio_authorized -N ""
#
#    (The trailing -N "" sets an empty passphrase so non-interactive ssh
#    works. If you'd rather have a passphrase, omit it and use ssh-agent.)
#
# 2. ON YOUR LAPTOP — copy the public key to your VM. Either:
#
#       ssh-copy-id -i ~/.ssh/deploy_latest_manuscript_studio_authorized.pub user@your-vm
#
#    or paste the contents of the .pub file into the VM's authorized_keys
#    yourself (next step).
#
# 3. ON THE VM — restrict that key to ONLY running this script. Edit
#    ~/.ssh/authorized_keys. Find the line that starts with
#    "ssh-ed25519 AAAA..." matching the public key you just copied, and
#    PREPEND restrictions so it looks like:
#
#       command="/home/YOUR_VM_USER/deploy_latest_manuscript_studio.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA... claude-deploy
#
#    The command="..." override is enforced by sshd — anything sent over this
#    key runs that script, period. No shell, no port-forward, no other
#    commands. The only thing this key can do is invoke this one script.
#
#    (authorized_keys does not expand shell variables, so write the absolute
#    path. If your VM user is "ubuntu", write
#    /home/ubuntu/deploy_latest_manuscript_studio.sh.)
#
# 4. ON THE VM — make this script executable:
#
#       chmod +x ~/deploy_latest_manuscript_studio.sh
#
# 5. TEST from your laptop. The exact command shouldn't matter (the override
#    runs this script regardless), but a benign-looking probe:
#
#       ssh -i ~/.ssh/deploy_latest_manuscript_studio_authorized user@your-vm 'echo test'
#
#    You should see this script's output, NOT "test". That confirms the
#    command="..." override is working.
#
# ------------------------------------------------------------------------------
# Updating the script on the VM (rare — only when this file itself changes)
# ------------------------------------------------------------------------------
#
# Easiest: re-run the public install one-liner manually once, and it will
# re-drop this file. Or rsync directly:
#
#   rsync -av deploy_latest_manuscript_studio.sh user@your-vm:~/
#
# ==============================================================================

set -euo pipefail

# Run the canonical public install one-liner. Idempotent on a healthy install:
# Docker rebuilds the image from latest main, Liquibase brings the schema up to
# date, and the server container restarts.
bash <(curl -sSL -H "Cache-Control: no-cache" "https://raw.githubusercontent.com/slackwing/manuscript-studio/main/install.sh")

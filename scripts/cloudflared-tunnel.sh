#!/bin/bash
# Quick tunnel wrapper. Logs the trycloudflare URL to a file we can read on demand.
# URL changes on every restart (free tier limitation). For a stable URL, switch to
# a named tunnel: requires a Cloudflare account + a domain.
exec /opt/homebrew/bin/cloudflared tunnel --url http://localhost:3030

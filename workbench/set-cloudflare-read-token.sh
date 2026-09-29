#!/usr/bin/env bash
set +x
set -euo pipefail
if [[ "$EUID" -ne 0 || ! -t 0 ]]; then
  echo 'Run as root in an interactive SSH terminal. Never pass the token as an argument.' >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then echo 'This command takes no arguments.' >&2; exit 1; fi
directory=/etc/xan9x-publisher
target="$directory/cloudflare-pages-read"
if [[ ! -d "$directory" || -L "$directory" || "$(realpath "$directory")" != "$directory" || -L "$target" ]]; then
  echo 'Expected a real administrator-managed publisher configuration directory.' >&2; exit 1
fi
if [[ "$(stat -c '%u' "$directory")" != 0 || $(( 8#$(stat -c '%a' "$directory") & 8#022 )) != 0 ]]; then
  echo 'Publisher configuration directory must be root-owned and not group/world writable.' >&2; exit 1
fi
printf '%s\n' 'Use an API token with only Account > Cloudflare Pages > Read, for the account that hosts the site project.'
IFS= read -r -p 'Cloudflare account ID (32 hex characters, from the dashboard URL): ' account
IFS= read -r -s -p 'Cloudflare Pages read-only token (hidden): ' token
printf '\n'
if [[ ! "$account" =~ ^[a-f0-9]{32}$ ]]; then
  unset token; echo 'Expected a 32-character lowercase hexadecimal account ID.' >&2; exit 1
fi
if [[ ! "$token" =~ ^[A-Za-z0-9_-]{20,512}$ ]]; then
  unset token; echo 'Expected a Cloudflare API token without whitespace.' >&2; exit 1
fi
umask 077
temporary=$(mktemp "$directory/.cloudflare-pages-read.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
# Both values are restricted to JSON-safe characters above, so no escaping is needed.
printf '{"accountId":"%s","token":"%s"}\n' "$account" "$token" > "$temporary"
unset token
chown xan9x-publisher:root "$temporary"
chmod 0400 "$temporary"
mv -T -- "$temporary" "$target"
printf '%s\n' 'Read-only credential installed. No token was printed; no service was restarted.'
printf '%s\n' 'After approval, restart xan9x-publisher to load it. Real publication remains disabled.'

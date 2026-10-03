#!/usr/bin/env bash
set +x
set -euo pipefail
if [[ "$EUID" -ne 0 || ! -t 0 ]]; then
  echo 'Run as root in an interactive SSH terminal. Never pass keys as arguments.' >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then echo 'This command takes no arguments.' >&2; exit 1; fi
directory=/etc/xan9x-publisher
target="$directory/r2-images"
if [[ ! -d "$directory" || -L "$directory" || "$(realpath "$directory")" != "$directory" || -L "$target" ]]; then
  echo 'Expected a real administrator-managed publisher configuration directory.' >&2; exit 1
fi
if [[ "$(stat -c '%u' "$directory")" != 0 || $(( 8#$(stat -c '%a' "$directory") & 8#022 )) != 0 ]]; then
  echo 'Publisher configuration directory must be root-owned and not group/world writable.' >&2; exit 1
fi
printf '%s\n' 'Use an R2 API token with Object Read & Write on the image bucket only (R2 > Manage API tokens).'
IFS= read -r -p 'Cloudflare account ID (32 hex characters): ' account
IFS= read -r -p 'Bucket name [xan9x-blog-images]: ' bucket
bucket=${bucket:-xan9x-blog-images}
IFS= read -r -s -p 'Access Key ID (hidden): ' key_id
printf '\n'
IFS= read -r -s -p 'Secret Access Key (hidden): ' secret
printf '\n'
fail() { unset key_id secret; echo "$1" >&2; exit 1; }
[[ "$account" =~ ^[a-f0-9]{32}$ ]] || fail 'Expected a 32-character lowercase hexadecimal account ID.'
[[ "$bucket" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || fail 'Expected an R2 bucket name.'
[[ "$key_id" =~ ^[A-Za-z0-9]{16,128}$ ]] || fail 'Expected an Access Key ID without whitespace.'
[[ "$secret" =~ ^[A-Za-z0-9/+=]{16,128}$ ]] || fail 'Expected a Secret Access Key without whitespace.'
umask 077
temporary=$(mktemp "$directory/.r2-images.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
# Every value is restricted to JSON-safe characters above, so no escaping is needed.
printf '{"accountId":"%s","bucket":"%s","accessKeyId":"%s","secretAccessKey":"%s"}\n' "$account" "$bucket" "$key_id" "$secret" > "$temporary"
unset key_id secret
chown xan9x-publisher:root "$temporary"
chmod 0400 "$temporary"
mv -T -- "$temporary" "$target"
printf '%s\n' 'R2 image credential installed. No key was printed; no service was restarted.'
printf '%s\n' 'Restart xan9x-publisher to load it.'

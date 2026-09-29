#!/usr/bin/env bash
set +x
set -euo pipefail
if [[ "$EUID" -ne 0 || ! -t 0 ]]; then
  echo 'Run as root in an interactive SSH terminal. Never pass the token as an argument.' >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then echo 'This command takes no arguments.' >&2; exit 1; fi
directory=/etc/xan9x-publisher
target="$directory/github-read-token"
if [[ ! -d "$directory" || -L "$directory" || "$(realpath "$directory")" != "$directory" || -L "$target" ]]; then
  echo 'Expected a real administrator-managed publisher configuration directory.' >&2; exit 1
fi
if [[ "$(stat -c '%u' "$directory")" != 0 || $(( 8#$(stat -c '%a' "$directory") & 8#022 )) != 0 ]]; then
  echo 'Publisher configuration directory must be root-owned and not group/world writable.' >&2; exit 1
fi
printf '%s\n' 'Use a fine-grained token limited to blog, blog-content, site; Actions/Contents/Checks: read-only.'
IFS= read -r -s -p 'GitHub read-only token (hidden): ' token
printf '\n'
if [[ "$token" != github_pat_* || "$token" == *[!A-Za-z0-9_]* ]]; then
  unset token; echo 'Expected a fine-grained GitHub token without whitespace.' >&2; exit 1
fi
umask 077
temporary=$(mktemp "$directory/.github-read-token.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
printf '%s' "$token" > "$temporary"
unset token
chown xan9x-publisher:root "$temporary"
chmod 0400 "$temporary"
mv -T -- "$temporary" "$target"
printf '%s\n' 'Read-only credential installed. No token was printed; no service was restarted.'
printf '%s\n' 'After approval, restart xan9x-publisher to load it. Real publication remains disabled.'

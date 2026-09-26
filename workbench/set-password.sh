#!/usr/bin/env bash
# Run interactively on the VPS. Never pass a production password through argv or chat.
set +x
set -euo pipefail
umask 077
config=/etc/xan9x-workbench.env
temporary=''
cleanup() {
  unset password confirmation hash
  if [[ -n "$temporary" ]]; then rm -f -- "$temporary"; fi
}
trap cleanup EXIT
if [[ $EUID -ne 0 ]]; then echo 'Run this setup helper as root.' >&2; exit 1; fi
if [[ ! -f "$config" || -L "$config" ]]; then echo 'Expected a regular, non-symlink environment file.' >&2; exit 1; fi
if [[ $(grep -c '^WORKBENCH_PASSWORD_HASH=' "$config" || true) != 1 ]]; then echo 'Expected exactly one password hash setting.' >&2; exit 1; fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
read -r -s -p 'Workbench password (at least 12 characters): ' password </dev/tty
printf '\n' >/dev/tty
read -r -s -p 'Confirm password: ' confirmation </dev/tty
printf '\n' >/dev/tty
if [[ "$password" != "$confirmation" ]]; then echo 'Passwords do not match; configuration unchanged.' >&2; exit 1; fi
hash=$(printf '%s' "$password" | /opt/node24/bin/node --import tsx workbench/password.ts)
unset password confirmation
if [[ ! "$hash" =~ ^scrypt\$[a-f0-9]{48}\$[a-f0-9]{128}$ ]]; then echo 'Invalid password hash; configuration unchanged.' >&2; exit 1; fi
temporary=$(mktemp /etc/.xan9x-workbench.env.XXXXXX)
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    WORKBENCH_PASSWORD_HASH=*) printf 'WORKBENCH_PASSWORD_HASH=%s\n' "$hash" ;;
    *) printf '%s\n' "$line" ;;
  esac
done <"$config" >"$temporary"
chmod 0600 "$temporary"
mv -T -- "$temporary" "$config"
temporary=''
unset hash
printf 'Password configured. The service has NOT been started or restarted.\n'
printf 'First start: systemctl enable --now xan9x-workbench\n'
printf 'Password rotation: systemctl restart xan9x-workbench (revokes existing sessions)\n'

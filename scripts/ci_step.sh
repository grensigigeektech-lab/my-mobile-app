#!/usr/bin/env bash
set -o pipefail

step_name="$1"
shift

safe_name="$(echo "$step_name" | tr -c 'A-Za-z0-9_' '_')"
log_file="${RUNNER_TEMP:-/tmp}/${safe_name}.log"

if "$@" > >(tee "$log_file") 2>&1; then
  exit 0
fi

status=$?
{
  echo "FAILED_STEP=$step_name"
  echo "FAILED_REASON<<EOF"
  tail -n 80 "$log_file"
  echo "EOF"
} >> "$GITHUB_ENV"

exit "$status"

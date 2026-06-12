#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:?APK path is required}"

if [ ! -f "$apk_path" ]; then
  echo "APK file was not found at $apk_path"
  exit 1
fi

if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  echo "Missing SLACK_BOT_TOKEN. Create a GitHub secret with a Slack bot token that has files:write access."
  exit 1
fi

if [ -z "${SLACK_CHANNEL_ID:-}" ]; then
  echo "Missing SLACK_CHANNEL_ID."
  exit 1
fi

filename="$(basename "$apk_path")"
length="$(wc -c < "$apk_path" | tr -d ' ')"

upload_response="$(
  curl -sS -X POST "https://slack.com/api/files.getUploadURLExternal" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "filename=${filename}" \
    --data-urlencode "length=${length}"
)"

if [ "$(echo "$upload_response" | jq -r '.ok')" != "true" ]; then
  echo "Slack files.getUploadURLExternal failed: $(echo "$upload_response" | jq -r '.error // \"unknown_error\"')"
  exit 1
fi

upload_url="$(echo "$upload_response" | jq -r '.upload_url')"
file_id="$(echo "$upload_response" | jq -r '.file_id')"

curl -sS -X POST "$upload_url" \
  -H "Content-Type: application/vnd.android.package-archive" \
  --data-binary "@${apk_path}" \
  >/dev/null

complete_payload="$(
  jq -n \
    --arg channel_id "$SLACK_CHANNEL_ID" \
    --arg file_id "$file_id" \
    --arg title "$filename" \
    '{channel_id: $channel_id, files: [{id: $file_id, title: $title}]}'
)"

complete_response="$(
  curl -sS -X POST "https://slack.com/api/files.completeUploadExternal" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data "$complete_payload"
)"

if [ "$(echo "$complete_response" | jq -r '.ok')" != "true" ]; then
  echo "Slack files.completeUploadExternal failed: $(echo "$complete_response" | jq -r '.error // \"unknown_error\"')"
  exit 1
fi

#!/usr/bin/env bash
# Shows how to make HermesFLLM the primary Hermes provider. Read-only: it never writes to
# ~/.hermes; you apply the change yourself.
set -euo pipefail

URL="${HERMESFLLM_URL:-http://127.0.0.1:3002}"
CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"

if curl -fsS -m 5 "$URL/api/ping" >/dev/null; then
  echo "✓ HermesFLLM answers at $URL/api/ping"
else
  echo "✗ HermesFLLM does not answer at $URL/api/ping — start it before changing Hermes." >&2
fi

[ -f "$CONFIG" ] || { echo "$CONFIG not found" >&2; exit 1; }
before=$(shasum -a 256 "$CONFIG" | cut -d' ' -f1)

echo
echo "Current primary provider (the model: block in $CONFIG):"
awk '/^model:/{on=1; print; next} on && /^[^ ]/{exit} on' "$CONFIG" | grep -viE 'key|token|secret'

cat <<EOF

Suggested manual changes to $CONFIG:

1. Add a provider under providers: (keep your key in ~/.hermes/.env, not in the YAML):
     hermesfllm:
       name: HermesFLLM
       base_url: $URL/v1
       key_env: HERMESFLLM_API_KEY
       api_mode: chat_completions
       default_model: auto

2. In the model: block, set:
     provider: hermesfllm
     default: auto

3. Move your previous primary provider (shown above) to the TOP of fallback_providers:, so
   Hermes falls back to it when HermesFLLM is down.

4. Restart the Hermes gateway.
EOF

after=$(shasum -a 256 "$CONFIG" | cut -d' ' -f1)
[ "$before" = "$after" ] && echo "✓ $CONFIG was not modified." || { echo "✗ $CONFIG changed while this script ran" >&2; exit 1; }

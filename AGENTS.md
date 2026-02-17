# Agent Rules

## Security
- Never read `api/.env`.
- Never read files under `secrets/`.
- Never open files ending in `.pem`, `.key`, `.p12`, or `.pfx` unless the user explicitly asks.
- Never print or echo values of secret environment variables.
- If a task appears to require secrets, ask the user to provide non-secret placeholders or run the command themselves.

# Contributing

External contributions are welcome. The short version:

1. Read [DEVELOPMENT.md](DEVELOPMENT.md) for local setup.
2. Read [AGENTS.md](../AGENTS.md) — even if you're not an LLM, the conventions there apply (schema-freeze policy, test-with-every-change, no `the-wildfire` references).
3. Open a PR against `main`. Keep changes focused — one bug or one feature per PR.

Tests are required for behavior changes. The Go suite runs as `go test ./...`; the Playwright suite as `./test-all.sh`.

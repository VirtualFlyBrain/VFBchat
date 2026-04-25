# VFB Task Battery Results

This folder stores JSON outputs from the VFB MCP evaluation task battery.

Local quick run:

```sh
npm run benchmark:task-battery -- --limit 1
```

Full local run, using the sibling paper checkout:

```sh
TASK_BATTERY_FILE=../vfb-paper/task_battery.md npm run benchmark:task-battery
```

Run against an already deployed server:

```sh
VFBCHAT_BENCHMARK_BASE_URL=https://chat.virtualflybrain.org npm run benchmark:task-battery -- --no-start-server
```

The runner writes a timestamped JSON file plus `latest.json`. It records questions, final answers, request IDs, response IDs, graph/image counts, status messages, and timing. It does not write API keys or environment variable values.

GitHub Actions uses repository secrets/variables for model access:

- `ELM_API_KEY` as a secret.
- `ELM_BASE_URL` as a repository variable or secret, defaulting to the EDINA ELM endpoint when unset.
- `ELM_MODEL` as a repository variable or secret, defaulting to `meta-llama/Llama-3.3-70B-Instruct` when unset.

When credentials are available, CI can commit generated JSON results back to this folder so prompt/tool-routing changes have visible before/after artefacts.

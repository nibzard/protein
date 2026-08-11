# Durable RepoAgent

This reference keeps the agent's identity, runs, event journal, action intents,
receipts, and reconnectable state in one celld cell. Repository checkout and
command execution happen behind an external HTTP executor contract because a
cell has no filesystem or subprocess API.

Submit work with:

```sh
curl -X POST http://127.0.0.1:18080/agents/acme-api/runs \
  -H 'content-type: application/json' \
  -d '{"id":"run-1","goal":{"repository":"acme/api","task":"fix tests"}}'
```

The reference currently sends the cell-local durable action ID as
`idempotency-key`. Repeating the same run or event in that cell does not create
a second logical action. A shared production executor must namespace the key by
deployment, cell class, cell identity, and local action ID so two cells cannot
alias one job. The included mock executor is for conformance testing; it does
not execute shell commands.

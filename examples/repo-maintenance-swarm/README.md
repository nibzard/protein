# Repository maintenance swarm

This is Protein's second agent environment. Four durable cells repair four real JavaScript modules, review the clockwise neighbor's artifact, revise their own work from that local critique, and submit the result to an isolated hidden evaluator.

The experiment keeps three boundaries explicit:

- Protein owns durable identity, runs, events, actions, receipts, and restart recovery.
- The maintenance executor owns OpenAI Responses calls, generated artifacts, and public checks.
- The runner owns the 2×2 topology, workflow phases, hidden acceptance, and evidence bundle.

Run it with an `OPENAI_API_KEY` and working `celld`/Docker:

```sh
npm run maintenance:run
```

Run the matched peer-review versus self-review comparison with:

```sh
CELLD_BIN=/path/to/celld npm run maintenance:compare
```

Evidence is written under `.protein/repo-maintenance/runs/<run-id>/`. A passing run means all four final revisions passed public and hidden cases and the four durable cell states survived a celld restart. It does not claim that four agents outperform one agent.

The measured three-pair comparison is documented in [PEER-REVIEW-COMPARISON.md](./PEER-REVIEW-COMPARISON.md). It found no peer-review advantage and exposed the need for a monotonic acceptance gate before a revision can replace verified work.

The workflow now uses Protein's shared `decideMonotonicAcceptance()` primitive. Live run `repo-maintenance-20260810200425835-1659306` produced four durable acceptance receipts, retained only artifacts that preserved public evidence, passed all 28 final cases, and recovered after a celld restart in 3.05 seconds.

The reusable idea proven here is artifact-centered collaboration: an authored artifact, a typed review, a revision linked to both, and an acceptance receipt. The task catalog, clockwise topology, and scoring remain experiment code.

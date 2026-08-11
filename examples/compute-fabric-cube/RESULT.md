# First live compute-fabric cube result

Run: `compute-fabric-openai-20260811071417338-2078129`

Status: **passed all frozen success criteria**.

| Measurement | Result |
| --- | ---: |
| Durable Protein identities | 27 |
| Useful completed work / receipts | 39 / 39 |
| Durable journal records | 348 |
| Typed work relationships | 41 |
| Cell / model / bounded / sandbox receipts | 17 / 11 / 6 / 5 |
| Luna calls / tokens | 11 / 6,224 |
| Linux evaluator and sandbox attempts | 11 |
| celld restart recovery | 5 outstanding actions in 7.74 s |
| Duplicate capability dispatches suppressed | 1 |
| Terminated sandbox attempts recovered | 1 |
| Denied evaluator requests retried | 1 |
| Hidden-test-backed accepted repairs | 4 |
| Same-file candidate conflicts resolved | 1 |

The cube produced correct repairs for Unicode slug normalization,
case-insensitive header merging, duration parsing, and retry delay. Two agents
independently produced different hidden-test-passing retry implementations. An
integration cell recorded the conflict, a bounded Luna reviewer selected one,
and governance cells accepted it through durable provenance.

During the run, celld was stopped with five sandbox actions outstanding. The
executors completed independently; after restart, Protein reconciled their
stable action IDs and preserved every prior cell receipt and relationship. One
real Linux container was deliberately killed before its successful retry. A
scheduled bounded-tier denial was also recorded and retried through a new
capability receipt.

The hibernation phase constrained 27 durable identities to four resident
isolates. celld logged seven recovered (`fresh=false`) starts before the target
wake and an eighth when the docs cell received new work. That cell's updated
state and receipts then survived a process restart before the long-running
capability phase began.

The result demonstrates the intended substrate pattern on one host:

```text
durable cells -> selective model or Linux escalation -> durable receipts
              -> independent verification -> accepted artifact lineage
```

It does not establish production horizontal scalability, multi-host ownership
safety, or that 27 agents are more intelligent than one agent. It does show that
the larger cube has value beyond solution-quality comparison: heterogeneous
agent work remained attributable, recoverable, budgeted, and replayable across
many durable identities.

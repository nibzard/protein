# CASE LIBRARY — Protein

> Research-backed design-thinking exploration, 2026-08-09.

> **Status: historical ideation, not the current product roadmap.** This library
> was created before Protein's Agent Cell primitive and fleet-demand test were
> derived from celld. Most entries show that a job *can* be represented as a
> sleeping case actor; they do not show that the job would cause anyone to
> deploy celld. Use the demand filter and current use cases in
> [IDEA.md](./IDEA.md) for product decisions. The rows remain useful as possible
> application harnesses and as a record of the exploration.

This library asks one practical question: **which jobs become unusually good when a named agent can remember a small amount of state, wake occasionally, make one bounded decision, record an effect, and go back to sleep?**

The top 10 below were the strongest hypotheses under the earlier case-shepherd framing. They are preserved rather than silently rewritten after the product thesis changed.

## Historical executive decision — superseded

Protein's strongest job is not “poll a page and send another alert.” Most source systems can already do that. Its sharper job is:

> **Own a slowly changing case: remember what was known, detect a material delta, carry it to a named human decision, keep following up, and record operational provenance.**

The recurring loop is:

**scheduled wake → bounded configured-source read → compact comparison → optional model-assisted classification → durable review or notification intent → wait**

That loop uses the runtime's distinctive parts together: stable identity, durable state, alarms, conditional model use, an effect ledger, retries, and inspectable history. The case is the unit of ownership. An external application or operator provisions one cell per watched object or active case rather than putting an unbounded portfolio into one agent; Protein v0 does not spawn cells, distribute discoveries, or queue cases.

In v0, human responses do not require a hidden signal or workflow system. A Protein effect creates or updates a review item in an external system of record; a later bounded read observes its acknowledgement, decision, or completion state. All shorthand below such as “record approval,” “retain the answer,” or “track a decision” means polling and referencing that externally recorded human outcome. Direct approval callbacks and arbitrary external signals are post-v0. If a case needs several simultaneously active branches or cross-case transactions, it does not fit the current contract.

Large documents, inventories, logs, and evidence stay outside the cell; Protein retains compact facts, hashes, cursors, decisions, and links. Sensitive infrastructure, incident, vendor, identity, legal, and audit payloads require the authentication, deployment, and retention blockers in [QUESTIONS.md](./QUESTIONS.md) to be resolved and should not be copied into cell state. Protein's journal records operational provenance; it is not formal compliance evidence and does not prove that an external obligation was satisfied.

### Historical top-10 hypotheses

| Rank | ID | Use case | Why it rises to the top | v0 readiness |
|---:|---|---|---|---|
| 1 | UC-001 | API contract and deprecation migration shepherd | Months-long change, structured diffs, clear owners and deadlines, and repeated follow-through are a near-perfect fit. | **Pilot first:** recommend and track; do not merge migrations automatically. |
| 2 | UC-004 | Feature-flag retirement shepherd | A flag is a natural named cell with a small state machine, long idle periods, and an obvious closure condition. | **Pilot now:** draft cleanup work; never delete a flag or code path. |
| 3 | UC-041 | Subprocessor, DPA, and terms-change review | Rare changes are easy to miss, prior wording matters, and review provenance is valuable. | **Discovery only:** legal and privacy decisions remain human-owned. |
| 4 | UC-021 | Data-freshness SLA incident shepherd | The source signal is cheap; the value comes from deduplication, ownership, reminders, and observed recovery. | **Pilot with a data team:** complement the orchestrator and catalog. |
| 5 | UC-027 | Backup restore-test shepherd | Long intervals, result metadata, retries, escalation, and explicit completion make durability matter. | **Deferred for hardening:** v0 drafts requests and observes status; it does not launch tests or restores. |
| 6 | UC-071 | Regulatory applicability and deadline shepherd | Rules evolve over long periods and require source provenance, decisions, dates, and reassessment. | **Discovery only:** informational triage; official text and counsel govern. |
| 7 | UC-091 | Knowledge-base staleness and owner-attestation shepherd | Low-risk, broadly useful, bounded, and easy to pilot while exercising durable follow-through. | **Pilot now:** ask owners to attest or revise; do not rewrite policy. |
| 8 | UC-031 | Cloud lifecycle and retirement impact shepherd | Provider events have long lead times, changing dates, inventory impact, and migration tasks. | **Deferred for hardening:** scoped reads and draft work only; no infrastructure mutation. |
| 9 | UC-051 | Product recall-to-inventory remediation shepherd | Official notices become durable internal cases with inventory matching, ownership, and observed remediation state. | **Discovery only:** safety-reviewed secondary control; draft actions only. |
| 10 | UC-011 | Asset-aware KEV remediation shepherd | The catalog changes slowly; asset context and remediation state make history more useful than another feed alert. | **Discovery only:** defense in depth; security owners decide priority and exceptions. |

The ordering is deliberately provisional. The weighted rubric below forced explicit tradeoffs, but publishing exact totals would imply evidence the research does not provide. Architectural fit and deployment readiness are separate: some guarded cases rank highly because the long-lived case is compelling even though an alpha runtime must not pilot them yet.

### What to build first

**UC-001 is the best reference product hypothesis.** It can start with one OpenAPI document or upstream API per cell, a daily cadence, a compact operation/schema fingerprint, an owner and deadline record, and a stable-key issue or message effect. It exercises more of Protein than a one-shot summarizer while avoiding the highest-stakes domains.

**UC-004 and UC-091 are the best low-risk design-partner pilots.** They have understandable states, cheap reads, clear owners, and reversible notification effects.

**UC-041, UC-071, UC-051, and UC-011 are guarded human-in-the-loop templates.** They are attractive because audit history matters, but Protein must never present its classification as legal, safety, or security authority.

**UC-027 and UC-031 should follow effect and deployment hardening.** Their reads can touch sensitive infrastructure metadata, even when the agent never makes the infrastructure change itself.

## Top-10 case briefs

### 1. UC-001 — API contract and deprecation migration shepherd

- **Person and job:** an API platform owner needs every affected service to acknowledge, plan, migrate, and verify a breaking change before the deadline.
- **Cell and state:** one cell per upstream API or announced deprecation; store the last contract fingerprint, material deltas, affected consumers, owner acknowledgements, target date, exceptions, and verification state.
- **Wake:** daily or weekly. Enforce a maximum source size and treat overflow or format failure as a visible source error, never “no change.” For larger contracts, read an externally computed operation-level fingerprint or bounded projection. Use deterministic schema comparison first and a model only to classify ambiguous prose.
- **Effect:** create or update a review item with a key derived from the source revision and affected consumer. Remind or escalate, then close only after a later bounded read observes the external outcome.
- **Pilot test:** five real upstream APIs for 60 days. Measure material-change precision, time to owner acknowledgement, duplicate effects, and whether the case history replaces a spreadsheet or recurring meeting.
- **Kill signal:** teams prefer native contract tooling plus an ordinary ticket automation, and Protein adds no useful follow-through or auditability.

### 2. UC-004 — Feature-flag retirement shepherd

- **Person and job:** a service owner wants temporary flags to leave production after rollout without breaking a safety hold or losing the cleanup trail.
- **Cell and state:** one cell per flag; keep environment status, rollout age, owner, code-reference evidence, cleanup checklist, approvals, and due dates.
- **Wake:** weekly, or more often near a planned retirement. Read bounded flag metadata and repository search results supplied by an integration.
- **Effect:** request owner attestation, open a cleanup issue, remind, and later observe an externally recorded approval reference. Deletion remains outside the v0 case.
- **Pilot test:** 20 flags already considered stale. Compare closure rate, false-stale findings, and owner effort with the current dashboard.
- **Kill signal:** lifecycle metadata and native flag-management workflows already drive cleanup to completion with no checking tax.

### 3. UC-041 — Subprocessor, DPA, and terms-change review

- **Person and job:** a privacy or vendor-risk owner needs to notice material vendor changes, determine applicability, and document review before an objection or renewal deadline.
- **Cell and state:** one cell per vendor relationship; keep source fingerprints, clause-level deltas, products and data flows in scope, reviewer, dates, decision, and evidence links.
- **Wake:** weekly or monthly, with tighter wakes after a detected change. Prefer vendor feeds or versioned notices; bound page reads and retain hashes plus selected excerpts, not full archives.
- **Effect:** draft a legal/privacy review note with source links and send stable-key reminders. The model may summarize differences but cannot decide acceptance or compliance.
- **Pilot test:** ten vendors with known subprocessor or terms pages. Measure detection lag, material-delta precision, and completeness of the review record.
- **Kill signal:** sources cannot be read reliably or lawfully, or an established vendor-risk system already owns the complete case better.

### 4. UC-021 — Data-freshness SLA incident shepherd

- **Person and job:** a data product owner needs a stale source to have one durable incident, one owner, useful reminders, and an observed recovery instead of repeated noisy alerts.
- **Cell and state:** one cell per source or data product; store last successful observation, SLA, incident fingerprint, acknowledgement, suspected dependency, waiver, and external recovery reference.
- **Wake:** around the expected arrival window. Read freshness metadata, not the dataset. Suppress repeats while advancing the same case.
- **Effect:** create or update the incident, notify the owner, escalate by policy, and close only after a configured number of fresh observations.
- **Pilot test:** ten daily sources with known late arrivals. Compare duplicate-alert volume and mean time to acknowledgement with existing alerts.
- **Kill signal:** the orchestrator already provides durable ownership, deduplication, escalation, and recovery verification.

### 5. UC-027 — Backup restore-test shepherd

- **Person and job:** a reliability or compliance owner needs every protected resource to complete periodic restore testing with retained evidence and tracked exceptions.
- **Cell and state:** one cell per protected resource or restore-test plan; keep policy interval, last result, evidence location, owner, retry state, exception, and next due date.
- **Wake:** monthly or quarterly, with bounded follow-up wakes while a test is pending or failed.
- **Effect:** draft a test request, observe status through a bounded read, remind, and record links to externally retained result evidence. v0 does not initiate a test or any recovery action.
- **Pilot test:** a non-production backup cohort. Verify no missed due dates, duplicate requests, or false completion after transient API failures.
- **Kill signal:** the backup platform's native restore-testing workflow already handles ownership, evidence, exceptions, and cross-provider reporting.

### 6. UC-071 — Regulatory applicability and deadline shepherd

- **Person and job:** a compliance owner needs a proposed or final rule to become a bounded internal case: applicability review, comment or effective dates, assigned actions, and retained rationale.
- **Cell and state:** one cell per rule or docket; keep authoritative identifiers, stage, relevant entities/products, dates, reviewer, decisions, obligations, and source provenance.
- **Wake:** daily during active windows and weekly otherwise. Read metadata through an official API, then link reviewers to the authoritative publication.
- **Effect:** draft a review brief, request counsel or owner input, remind before dates, and later reference the human decision in the external system of record.
- **Pilot test:** one narrow regulator and one business domain, replaying historical dockets before live use.
- **Kill signal:** applicability cannot be bounded without broad legal research, or users mistake the assistant's summary for legal advice despite product controls.

### 7. UC-091 — Knowledge-base staleness and owner-attestation shepherd

- **Person and job:** a documentation or policy owner needs important pages to remain owned, reviewed, and aligned with current product facts.
- **Cell and state:** one cell per critical page or small collection; store revision, owner, review interval, cited facts, last attestation, requested edits, and closure.
- **Wake:** monthly or when a bounded change feed indicates a new revision. Deterministic age and ownership rules run before any semantic comparison.
- **Effect:** ask the owner to attest, revise, or retire the page; track reminders and reference the externally recorded answer.
- **Pilot test:** 50 high-value runbooks, onboarding pages, or policies. Measure owner response, useful corrections, and nuisance rate.
- **Kill signal:** teams will not assign owners or act on reviews, leaving Protein to generate a more elaborate stale-page report.

### 8. UC-031 — Cloud lifecycle and retirement impact shepherd

- **Person and job:** a cloud platform owner needs provider maintenance and retirement notices mapped to owned resources, migration tasks, dates, and observable completion criteria.
- **Cell and state:** one cell per lifecycle event or affected resource cohort; keep provider event ID, affected inventory references, owner, milestone dates, actions, exceptions, and verification.
- **Wake:** daily or weekly, becoming more frequent near deadlines. Read official health metadata and a bounded inventory projection.
- **Effect:** open or update migration work, remind owners, and record the observed inventory state or externally approved exception.
- **Pilot test:** replay the last year of provider lifecycle events against a non-sensitive inventory snapshot.
- **Kill signal:** provider-native tooling and the organization's service catalog already give complete mapping and follow-through.

### 9. UC-051 — Product recall-to-inventory remediation shepherd

- **Person and job:** a product-safety or commerce operator needs an official recall to be matched against catalog and inventory, human-reviewed, and followed through externally recorded actions.
- **Cell and state:** one cell per official recall and organization-specific match set; keep notice revision, identifiers, candidate SKUs/lots, reviewer decisions, actions, and residual inventory checks.
- **Wake:** daily, with follow-up wakes until all candidate matches are resolved. Fetch only the official feed record plus bounded internal match data.
- **Effect:** create a safety review with draft hold/removal recommendations. Human approval and established procedures govern every catalog change and customer communication.
- **Pilot test:** replay historical recalls against a sandbox catalog and require safety-team adjudication of every match.
- **Kill signal:** identifier quality makes matching dangerously ambiguous, or Protein cannot be deployed as a secondary control beside established recall procedures.

### 10. UC-011 — Asset-aware KEV remediation shepherd

- **Person and job:** a security owner needs a newly exploited vulnerability mapped to a bounded asset set, assigned, remediated or excepted, and rechecked as facts change.
- **Cell and state:** one cell per vulnerability-and-asset cohort; keep source revisions, affected package evidence, owner, mitigation, due date, exception, and verification.
- **Wake:** daily, plus scheduled follow-up. Compare official catalog fields and bounded asset/SBOM facts; avoid model use for deterministic identifier matching.
- **Effect:** create or update a security case, request human triage, remind, and close only after a bounded read observes remediation or an externally approved exception.
- **Pilot test:** replay historical KEV additions against a test inventory and compare with existing vulnerability-management outcomes.
- **Kill signal:** the system becomes a slower duplicate of an existing vulnerability platform or cannot meet the organization's required detection window.

## Design-thinking session

### Empathize: who pays the checking tax?

The research points to four recurring people, regardless of domain:

1. **The maintainer** repeatedly checks releases, contracts, flags, or documentation because missing one slow change creates future work.
2. **The operator** already receives alerts but loses time deduplicating them, finding an owner, reminding people, and checking observed recovery.
3. **The governance owner** needs the prior wording, source provenance, reviewer decision, exception, and deadline—not just a summary.
4. **The safety or security owner** needs faster context and persistent follow-through, while retaining human authority and defense-in-depth controls.

Their shared pain is not a lack of dashboards. It is the gap between “a source changed” and “the right person made and completed a reviewable decision.”

### Define: the job to be done

> When an external fact or slow-moving operational case changes, help me notice only the material delta, carry it to a reviewable outcome, and reconstruct what Protein observed and requested—without making me run a permanent worker or trust an unbounded autonomous agent.

The desired outcomes are less checking, fewer duplicate alerts, faster acknowledgement, fewer abandoned cases, and better evidence. The unwanted outcomes are a new noisy inbox, opaque model judgment, silent autonomous action, or another general workflow engine.

### Ideate: how the 100 cases were generated

The brainstorming crossed ten domains with five reusable case shapes:

- **Change sentinels:** compare a stable source with a compact prior checkpoint.
- **Deadline shepherds:** remember a date, owner, acknowledgement, and escalation state.
- **Reconciliation cases:** compare expected and observed state until they agree.
- **Attestation loops:** ask a named owner to review, answer, and renew later.
- **Source-linked dossiers:** accumulate small facts, decisions, and external evidence links until a case can close.

Exact duplicates were merged, but domain variants were intentionally retained when they test different buyers, configured sources, matching units, response paths, or safety boundaries. For example, “watch a vendor page” is not separate from “subprocessor change review,” while consumer-product, vehicle, and FDA recall cases remain distinct because their identifiers, official channels, and response constraints differ.

### Converge: hard gates before scoring

A candidate remains in this conceptual-fit library only if it can be scoped to all of the following. Passing these gates does not make it ready for a v0 deployment; security, source, effect, and domain-authority gates still apply.

1. **Mostly dormant:** useful cadence is measured in minutes, hours, days, or months—not a sub-second stream.
2. **Named ownership:** one watched object or case can map cleanly to one cell and one active goal.
3. **Bounded work:** every wake can cap items, bytes, reads, model calls, wall time, and effect count.
4. **Compact memory:** the agent needs hashes, cursors, dates, classifications, and decisions rather than a large artifact archive.
5. **Replay tolerance:** a read or model call may repeat, and every effect has a deterministic key plus an explicit reconciliation policy.
6. **Deadline slack:** a delayed or repeated wake is recoverable and does not create an immediate unsafe state.
7. **Human-safe authority:** high-stakes outputs are review packets, reminders, or recommendations—not final medical, legal, security, financial, or safety decisions.
8. **Useful history:** the durable timeline materially helps ownership, deduplication, explanation, operational review, or recovery.

### Weighted scoring rubric

The conceptual-fit gates are pass/fail. The dimensions below provide a 100-point comparison rubric for future pilot evidence; the current ranking intentionally avoids false-precision totals.

| Dimension | Weight | High score means |
|---|---:|---|
| Dormant, alarm-paced shape | 12 | Long waits dominate short bounded transitions. |
| Controlling or well-characterized source | 12 | The agent can read a reliable identifier, cursor, revision, or structured record and distinguish it from informational inputs. |
| One-cell identity and state locality | 10 | A natural object or case owns the relevant state. |
| Bounded fetch, model, and commit | 10 | A wake has a credible worst-case budget. |
| Value of history, replay, and deduplication | 12 | Durable memory changes the outcome, not merely the implementation. |
| Safe and idempotent effect path | 10 | Notification, ticket, or review effects can use stable keys and human control. |
| Deadline slack and recovery tolerance | 8 | Retry or failover delay is acceptable and observable. |
| Privacy and deployment suitability | 8 | Useful pilots avoid excessive secrets or sensitive payloads. |
| Advantage over cron or native incumbent | 10 | Case ownership and follow-through are a meaningful improvement. |
| Clear pain, owner, and action | 8 | A named user can say what they will do with the result. |
| **Total** | **100** | |

### Validate: questions every pilot must answer

- Did the agent find material changes with acceptable precision and bounded cost?
- Did durable case state reduce duplicate work, checking, or abandoned follow-up?
- Could a user reconstruct why every notification, reminder, and closure happened?
- Did restarts, duplicate wakes, repeated model calls, and ambiguous effect delivery stay within the documented contract?
- Was Protein better enough than cron plus a database, a source-native alert, and a mature durable runtime to justify another abstraction?
- Would a design partner keep using it after the novelty period?

## Research map

The sources below establish that stable feeds, lifecycle records, change APIs, deadlines, or control obligations exist. They **do not prove customer demand**. Demand, willingness to pay, precision, and incumbent advantage still require interviews and pilots.

### Software, security, and supply chain

| Code | Primary or authoritative source | What it supports |
|---|---|---|
| DEV-1 | [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases) | Structured upstream release records. |
| DEV-2 | [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) | Repository event primitives and an incumbent event path. |
| DEV-3 | [GitHub Dependabot alerts REST API](https://docs.github.com/en/rest/dependabot/alerts) | Dependency-alert lifecycle data. |
| DEV-4 | [GitHub code-scanning REST API](https://docs.github.com/en/rest/code-scanning/code-scanning) | Finding state and resolution metadata. |
| DEV-5 | [GitHub Actions workflow-runs API](https://docs.github.com/en/rest/actions/workflow-runs) | Bounded CI run history. |
| DEV-6 | [GitHub CODEOWNERS documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) | Explicit code ownership rules. |
| DEV-7 | [OpenAPI Specification](https://spec.openapis.org/oas/) | Machine-readable API contracts. |
| DEV-8 | [Kubernetes deprecated API migration guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/) | Versioned API removal and migration obligations. |
| DEV-9 | [LaunchDarkly flag status documentation](https://launchdarkly.com/docs/home/flags/flag-status) | Flag lifecycle and activity metadata. |
| DEV-10 | [IETF Datatracker API](https://datatracker.ietf.org/api/) | Read-only document, revision, status, and working-group records. |
| DEV-11 | [Node.js end-of-life guidance](https://nodejs.org/en/about/eol) and [Python version status](https://devguide.python.org/versions/) | Official runtime support phases and scheduled end-of-life dates. |
| SEC-1 | [CISA Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) | An authoritative exploited-vulnerability list and due-date context. |
| SEC-2 | [OSV API](https://google.github.io/osv.dev/api/) | Package and version vulnerability queries. |
| SEC-3 | [NVD vulnerability APIs](https://nvd.nist.gov/developers/vulnerabilities) | Structured CVE change data. |
| SEC-4 | [OASIS CSAF 2.0 specification](https://docs.oasis-open.org/csaf/csaf/v2.0/os/csaf-v2.0-os.html) | Machine-readable vendor advisories and product status. |
| SEC-5 | [Certificate Transparency logs](https://certificate.transparency.dev/logs/) and [monitoring model](https://certificate.transparency.dev/monitors/) | Append-only certificate evidence and monitor behavior. |
| SEC-6 | [SPDX](https://spdx.dev/) and [CISA SBOM resources](https://www.cisa.gov/topics/cyber-threats-and-advisories/sbom/sbomresourceslibrary) | Standardized software component inventories. |
| SEC-7 | [AWS security bulletins](https://aws.amazon.com/security/security-bulletins/) | Provider security-advisory source. |
| SEC-8 | [Sigstore signature and attestation verification](https://docs.sigstore.dev/cosign/verifying/verify/) | Verifiable signer, transparency-log, and attestation results. |

### Reliability, data, cloud, and ML

| Code | Primary or authoritative source | What it supports |
|---|---|---|
| OPS-1 | [AWS Health planned lifecycle events](https://docs.aws.amazon.com/health/latest/ug/aws-health-planned-lifecycle-events.html) and [event types](https://docs.aws.amazon.com/health/latest/APIReference/API_EventType.html) | Provider lifecycle records and affected-resource context. |
| OPS-2 | [Azure Service Health](https://learn.microsoft.com/en-us/azure/service-health/) | Service issues, planned maintenance, and health advisories. |
| OPS-3 | [AWS Price List Bulk API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html), [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices), and [Google Cloud Catalog API](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api) | Structured cloud SKU and price data. |
| OPS-4 | [dbt source freshness](https://docs.getdbt.com/docs/deploy/source-freshness) | Freshness checks and expected loading windows. |
| OPS-5 | [dbt model contracts](https://docs.getdbt.com/docs/mesh/govern/model-contracts) | Versioned data-interface constraints. |
| OPS-6 | [OpenLineage documentation](https://openlineage.io/docs/) | Dataset, job, and run lineage events. |
| OPS-7 | [Great Expectations Checkpoint API](https://docs.greatexpectations.io/docs/reference/api/checkpoint_class/) | Persisted validation configuration and result actions. |
| OPS-8 | [HashiCorp Terraform drift tutorial](https://developer.hashicorp.com/terraform/tutorials/state/resource-drift) | Desired-versus-observed infrastructure drift. |
| OPS-9 | [AWS Backup restore testing](https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html) | Scheduled restore-test plans and results. |
| OPS-10 | [AWS Service Quotas request workflow](https://docs.aws.amazon.com/servicequotas/latest/userguide/request-quota-increase.html) | Quota state and increase requests. |
| OPS-11 | [MLflow Model Registry workflow](https://mlflow.org/docs/latest/ml/model-registry/workflow) | Model versions, aliases, tags, and promotion stages. |
| OPS-12 | [Hugging Face model cards](https://huggingface.co/docs/hub/model-cards) and [Hub API](https://huggingface.co/docs/hub/en/api) | Model metadata, revisions, and declared limitations. |
| OPS-13 | [Atlassian Statuspage automation guidance](https://support.atlassian.com/statuspage/docs/know-when-to-automate-your-status-page/) | Evidence that incident communication needs deliberate human control. |
| OPS-14 | [Stripe webhook recovery guidance](https://docs.stripe.com/webhooks/process-undelivered-events) | Replay and reconciliation of undelivered events. |
| OPS-15 | [Google SRE error-budget policy](https://sre.google/workbook/error-budget-policy/) | Release-policy decisions tied to error-budget state. |
| OPS-16 | [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) | Continuous governance, measurement, documentation, and management of AI risk. |

### Governance, regulation, finance, and public records

| Code | Primary or authoritative source | What it supports |
|---|---|---|
| GOV-1 | [GDPR, including Article 28](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679) | Processor obligations and notice around subprocessor changes. |
| GOV-2 | [EU controller-processor standard contractual clauses](https://eur-lex.europa.eu/eli/dec_impl/2021/915/oj) | Contractual governance and documented instructions. |
| GOV-3 | [Federal Register API](https://www.federalregister.gov/developers/documentation/api/v1) | Searchable document metadata; the service itself says official legal text must be verified elsewhere. |
| GOV-4 | [Regulations.gov API](https://open.gsa.gov/api/regulationsgov/) | Dockets, documents, and comment records. |
| GOV-5 | [EUR-Lex web services](https://eur-lex.europa.eu/content/help/data-reuse/webservice.html?locale=en) | EU legal-document retrieval and reuse. |
| GOV-6 | [Congress.gov API](https://api.congress.gov/) | Bill, amendment, committee, and member data. |
| GOV-7 | [GovInfo API](https://www.govinfo.gov/developers) | Official publications and metadata from all three US federal branches. |
| GOV-8 | [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | Filing submissions and XBRL company facts. |
| GOV-9 | [Simpler.Grants.gov API](https://simpler.grants.gov/developers) and [Grants.gov search API](https://www.grants.gov/api/common/search2) | Federal funding opportunity discovery. |
| GOV-10 | [SAM.gov contract opportunities API](https://open.gsa.gov/api/get-opportunities-public-api/) | Federal procurement opportunity records. |
| GOV-11 | [OpenFEMA](https://www.fema.gov/about/reports-and-data/openfema) | Disaster, assistance, and emergency-management datasets. |
| GOV-12 | [USCIS fee schedule](https://www.uscis.gov/g-1055) | Official form-fee editions and time-sensitive fee notices. |

### Product safety, trade, science, environment, and knowledge

| Code | Primary or authoritative source | What it supports |
|---|---|---|
| SAFE-1 | [CPSC Recalls API](https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information) | Official recall data and catalog-removal use cases. |
| SAFE-2 | [NHTSA datasets and APIs](https://www.nhtsa.gov/nhtsa-datasets-and-apis) | Vehicle recall and safety data. |
| SAFE-3 | [openFDA food enforcement API](https://open.fda.gov/apis/food/enforcement/) and [device enforcement API](https://open.fda.gov/apis/device/enforcement/) | Structured enforcement reports; FDA says this data is not a public-alert channel or a recall-lifecycle tracker. |
| SAFE-4 | [OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service) | Current sanctions-list data and downloads. |
| SAFE-5 | [US Consolidated Screening List](https://www.trade.gov/consolidated-screening-list) | Consolidated export-screening data; the source requires further due diligence. |
| SCI-1 | [ClinicalTrials.gov API](https://clinicaltrials.gov/data-api/api) | Structured study records and versioned lifecycle data. |
| SCI-2 | [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/home/develop/api/) | Programmatic access to biomedical literature and databases. |
| SCI-3 | [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) | Scholarly metadata, updates, and relations. |
| SCI-4 | [Living systematic review methods paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC10722674/) | The recurring evidence-surveillance workflow. |
| SCI-5 | [ClinVar maintenance and use](https://www.ncbi.nlm.nih.gov/clinvar/docs/maintenance_use/) and [ClinVar alerts](https://www.ncbi.nlm.nih.gov/clinvar/docs/alerts/) | Classification updates plus explicit interpretation cautions. |
| SCI-6 | [USPTO online patent tools](https://www.uspto.gov/patents/basics/online-patent-tools) | Patent search, status, and file-wrapper access. |
| SCI-7 | [WIPO PATENTSCOPE update feeds](https://www.wipo.int/en/web/patentscope/w/news/2006/news_0002) | Saved-query and patent-publication updates. |
| ENV-1 | [National Weather Service alerts API](https://www.weather.gov/documentation/services-web-alerts) | Official alert products and geographic metadata. |
| ENV-2 | [USGS real-time earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/) | Frequently updated earthquake event feeds. |
| ENV-3 | [USGS Water Services](https://waterservices.usgs.gov/) | Site observations and streamflow time series. |
| ENV-4 | [NASA FIRMS web services](https://firms.modaps.eosdis.nasa.gov/web-services/) | Active-fire observations and area queries. |
| ENV-5 | [EPA Envirofacts data service](https://www.epa.gov/enviro/envirofacts-data-service-api) | Environmental records through a public API. |
| KNW-1 | [Confluence REST API](https://developer.atlassian.com/cloud/confluence/using-the-rest-api/) and [CQL search](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/) | Page revisions, owners, and bounded content search. |
| KNW-2 | [Google Drive changes API](https://developers.google.com/workspace/drive/api/guides/manage-changes) | Incremental file-change cursors. |

“LOCAL” means a deployment-specific configured source, inventory projection, or external system of record must be identified and validated before the case is accepted. It may supplement a linked public source whose API covers only one side of the job. “LOCAL” does not mean filesystem-local, universally available, or inherently authoritative; it marks a research and integration dependency.

## The 100-case library

Each row describes a bounded case shape, not a whole vertical product. **Strong** means the current Protein contract is a natural conceptual fit. **Guarded** means the concept fits only with the stated source, safety, privacy, latency, or incumbent boundary. Neither label means production-ready: all cases remain subject to the runtime blockers in [QUESTIONS.md](./QUESTIONS.md), and high-stakes cases are discovery templates until those blockers and their domain controls are satisfied.

### 1. Software evolution and maintenance

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-001 | **API contract and deprecation migration shepherd.** Help an API owner move affected consumers from first material change through observed migration. | One cell per API or deprecation; compare a size-capped contract or external fingerprint projection, surface overflow as an error, retain affected consumers and decisions, then remind until verification. | **Strong.** Human-reviewed migrations; deterministic contract diff before model interpretation. | DEV-7, DEV-1, LOCAL |
| UC-002 | **Upstream dependency release-upgrade shepherd.** Help a maintainer decide whether, when, and how to adopt important releases. | One cell per dependency line; checkpoint release ID and externally reported deployed version, classify relevant notes, open one upgrade case, and recheck until merged or excepted. | **Strong.** Limit to selected dependencies; do not become a package-index crawler or auto-merge bot. | DEV-1, LOCAL |
| UC-003 | **Language or runtime end-of-support migration shepherd.** Help a platform owner move every known workload from a runtime line before maintenance and security support end. | One cell per runtime line and workload cohort; checkpoint the official schedule, retain affected services and owners, remind, and verify inventory reaches zero. | **Strong.** Inventory is a bounded external projection; Protein coordinates migration rather than changing runtimes. | DEV-11 |
| UC-004 | **Feature-flag retirement shepherd.** Help a service owner remove flags that have finished their useful lifecycle. | One cell per flag; read status and bounded code-reference evidence, request attestation, track cleanup, and close only after verification. | **Strong.** Do not infer safety from age alone or delete automatically. | DEV-9, DEV-2 |
| UC-005 | **Kubernetes deprecated-API readiness case.** Help a platform owner review each workload before a cluster version upgrade. | One cell per cluster-upgrade case; compare a bounded workload projection with the target-version removal list, draft findings, and recheck observed inventory. | **Strong.** Inventory must be pre-scoped; Protein supports readiness review rather than running the upgrade. | DEV-8, LOCAL |
| UC-006 | **Package and license-delta review.** Help a software owner notice when a selected dependency changes package metadata, license, or obligations. | One cell per package or approved dependency cohort; fingerprint metadata, summarize a delta, request legal/engineering review, and retain disposition. | **Guarded.** No autonomous license interpretation; large dependency graphs need an external SBOM/index. | DEV-1, SEC-6 |
| UC-007 | **Container base-image change review.** Help a platform team evaluate digest, release, support, or component changes for an approved image line. | One cell per base-image line; compare an external registry/SBOM projection, open an update case, and observe downstream adoption. | **Strong.** Registry and SBOM integrations supply bounded metadata; Protein does not scan layers or store images. | SEC-6, SEC-2, LOCAL |
| UC-008 | **Standards or RFC implementation watch.** Help a protocol owner track a selected proposal from draft changes to organizational impact and adoption. | One cell per proposal; checkpoint official revision/status, summarize changed requirements, ask for applicability review, and remember decisions. | **Guarded.** Select documents explicitly and link to authoritative text; no broad standards crawler. | DEV-10 |
| UC-009 | **CODEOWNERS coverage and rule-drift review.** Help a repository owner keep ownership rules valid as paths and teams change. | One cell per repository; compare a bounded path/owner projection, open a review for uncovered or invalid rules, and recheck after edits. | **Strong.** Static checks lead; a model is optional only for suggested ownership context. | DEV-6, DEV-2 |
| UC-010 | **Upstream project maintenance-risk watch.** Help a dependency owner reconsider reliance when a selected project is archived, stalls, transfers, or changes release behavior. | One cell per upstream project; retain archive/ownership/release facts, classify only material changes, and schedule periodic owner review. | **Guarded.** Signals are prompts, not a generated “health score”; monitor only an explicit allowlist. | DEV-1, DEV-2 |

### 2. Security and software supply chain

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-011 | **Asset-aware KEV remediation shepherd.** Help a security owner carry newly exploited vulnerabilities through bounded asset matching, triage, remediation, or exception. | One cell per CVE and asset cohort; diff official fields, retain owner and due date, issue stable-key reminders, and record observed mitigation or exception state. | **Guarded.** Secondary control with human triage; not the only vulnerability feed or emergency channel. | SEC-1, SEC-2, SEC-3, LOCAL |
| UC-012 | **SBOM-to-OSV new-exposure review.** Help a product owner detect when a previously recorded component becomes affected by a new or revised advisory. | One cell per product/SBOM snapshot; query bounded component batches, checkpoint advisory revisions, and open one case per material exposure. | **Strong.** SBOM indexing stays outside the cell; deterministic package/version matching precedes models. | SEC-6, SEC-2 |
| UC-013 | **Dependency-advisory owner tracker.** Help a repository owner prevent acknowledged Dependabot findings from aging without a decision. | One cell per repository or selected finding cohort; read alert state, group by stable identity, remind the owner, and retain links to external fix or waiver records. | **Strong.** Complements native alerts by owning follow-through; do not duplicate their scanner. | DEV-3, LOCAL |
| UC-014 | **Code-scanning finding aging and waiver review.** Help an AppSec owner revisit unresolved findings and expiring dismissals. | One cell per repository/finding cohort; read bounded finding metadata, track owner, resolution, waiver reason, and renewal date. | **Strong.** Static-analysis truth stays in the scanner; Protein records operational case provenance. | DEV-4 |
| UC-015 | **Unauthorized certificate-issuance case.** Help a domain owner review new certificates against an allowlist and follow suspicious issuance to resolution. | One cell per domain; consume a bounded CT cursor or monitor output, compare issuer and names, notify with a stable entry key, and retain disposition. | **Guarded.** Needs a dedicated CT monitor/index and an existing incident path; Protein should not scan global logs itself. | SEC-5 |
| UC-016 | **DNS and mail-security posture drift review.** Help a domain owner notice bounded changes to DNSSEC, CAA, SPF, DKIM, or DMARC configuration. | One cell per domain; checkpoint selected records, apply deterministic policy checks, open a review on material drift, and verify restoration. | **Guarded.** Resolver choice and transient DNS behavior must be explicit; never auto-edit DNS. | LOCAL |
| UC-017 | **Provenance and signing-attestation drift review.** Help a release owner check whether selected artifacts still have the expected signer and provenance claims. | One cell per artifact stream; compare bounded verifier output with policy, open a case for missing or changed claims, and recheck. | **Guarded.** Signature verification occurs in a specialized verifier; Protein stores compact results, not artifacts. | SEC-6, SEC-8, LOCAL |
| UC-018 | **Vendor security-bulletin applicability shepherd.** Help a service owner map a provider advisory to deployed products and retain the response. | One cell per vendor/product line; checkpoint bulletin IDs and revisions, compare against bounded inventory facts, assign, remind, and close. | **Strong.** Official vendor sources only; model classification cannot override product identifiers. | SEC-4, SEC-7 |
| UC-019 | **Public exposure or secret-remediation verifier.** Help a security team check whether a known exposure was removed and credential-rotation status changed after the first alert. | One cell per finding; read scanner state and a bounded external verification signal, retain only references to rotation/revocation records, and escalate if still exposed. | **Guarded.** Protein receives findings from specialist systems; it never fetches or stores secret values. | DEV-4, LOCAL |
| UC-020 | **Security exception and waiver-expiry shepherd.** Help a control owner revisit temporary risk acceptances before they silently become permanent. | One cell per exception; remember scope, expiry and reminders, then poll the external register for approver, compensating-control, renewal, and closure state. | **Strong.** The authenticated external system of record owns approvals; Protein emits draft-ticket or notification effects. | LOCAL |

### 3. Reliability, data, and ML operations

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-021 | **Data-freshness SLA incident shepherd.** Help a data owner turn repeated stale-source alerts into one owned case with observed recovery. | One cell per source; read freshness metadata near expected arrival, dedupe on incident identity, remind, and close after configured fresh observations. | **Strong.** Read metadata only and complement the orchestrator rather than rescheduling pipelines. | OPS-4, OPS-6, LOCAL |
| UC-022 | **External file or dataset arrival SLA.** Help an operations owner notice and follow up when a partner delivery is missing, late, duplicated, or unexpectedly revised. | One cell per delivery contract; checkpoint file/change cursor and expected window, open one case, and record an externally accepted arrival state. | **Strong.** Bound directory listing and metadata; large file validation belongs downstream. | KNW-2, OPS-4, LOCAL |
| UC-023 | **Recurring flaky-CI signature case.** Help a test owner recognize recurring failure signatures and carry a flaky test from observation to a passing-run check. | One cell per workflow or signature cohort; inspect a bounded run window, cluster compact error fingerprints, draft assignment, and recheck after changes. | **Guarded.** CI remains the event source; cap log excerpts and avoid becoming a log warehouse. | DEV-5, LOCAL |
| UC-024 | **Terraform drift review case.** Help an infrastructure owner adjudicate selected desired-versus-observed drift and observe later convergence. | One cell per workspace; ingest a sanitized, bounded plan summary, track finding identity and external owner/exception references, then recheck at a safe cadence. | **Guarded pending deployment hardening.** Protein never applies a plan, and sensitive plan payloads stay in the authorized infrastructure system. | OPS-8, LOCAL |
| UC-025 | **Data-contract change approval.** Help producers and consumers review schema-contract changes before incompatible data reaches production. | One cell per data product contract; diff versioned constraints, map a bounded consumer list, request approvals, poll their external status, and track rollout. | **Strong.** Deterministic schema checks first; no automatic waiver of compatibility failures. | OPS-5, OPS-6, LOCAL |
| UC-026 | **Data-quality failure deduplication and follow-through.** Help a data steward keep repeated expectation failures in one explainable case until recovery. | One cell per checkpoint and failure signature; read bounded validation results, update result references, remind, and close after configured passing runs. | **Strong.** Validation and retained evidence stay elsewhere; Protein handles ownership, history, and effect delivery. | OPS-7, LOCAL |
| UC-027 | **Backup restore-test shepherd.** Help a reliability owner keep periodic recovery-test status, failures, exceptions, and renewals from falling through gaps. | One cell per protected resource or plan; check due/result metadata, draft a test request, follow externally reported status, and retain result links. | **Guarded; deferred for hardening.** Start in non-production; v0 does not launch a test or any recovery action. | OPS-9, LOCAL |
| UC-028 | **Quota-headroom and increase-request shepherd.** Help a platform owner start early and follow provider-request status before growth hits a quota. | One cell per quota/resource pair; read usage and limit summaries, apply a bounded threshold, draft a request, and follow its external status. | **Strong.** Conservative rules and human submission; not a real-time autoscaler. | OPS-10, LOCAL |
| UC-029 | **Delayed-label model-performance review.** Help an ML owner revisit a deployed model when labels arrive days or weeks later and external metrics cross a review threshold. | One cell per model/cohort; read compact metric projections, compare with the last accepted baseline, request review, and track external disposition. | **Guarded.** Metrics and cohorting are external; no autonomous clinical, credit, hiring, or access decisions. | OPS-11, OPS-16, LOCAL |
| UC-030 | **Model-registry promotion approval shepherd.** Help an ML platform owner carry a candidate version through result review, sign-off, externally executed promotion, and rollback review. | One cell per model promotion; read registry metadata and bounded test summaries, draft a promotion request, poll external sign-off and registry state, and retain references. | **Guarded.** v0 never promotes a model; later mutation would require verified approval, an idempotent handler, and reconciliation. | OPS-11, OPS-12, LOCAL |

### 4. Cloud and SaaS lifecycle

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-031 | **Cloud lifecycle and retirement impact shepherd.** Help a platform owner map provider notices to resources and support migrations before changing deadlines. | One cell per event or affected cohort; read official health records plus bounded inventory, track external owners and milestones, and observe residual impact. | **Guarded; deferred for hardening.** Read-only inventory and draft work only; no infrastructure mutation. | OPS-1, OPS-2, LOCAL |
| UC-032 | **Cloud price or SKU-change impact review.** Help a FinOps owner notice selected SKU changes, estimate bounded exposure, and assign a response. | One cell per watched SKU/cohort; checkpoint catalog fields, join to an external usage summary, open one review, and retain the choice. | **Strong.** Catalog prices need contract-specific interpretation; not a billing system or trading signal. | OPS-3 |
| UC-033 | **Vendor-status dependency incident context.** Help an on-call owner correlate a selected provider incident with an internal service and remember updates without duplicating pages. | One cell per provider incident and internal dependency; read official status revisions, attach internal observations, update one case, and close together. | **Guarded.** Use webhooks when available and keep the established paging path; Protein adds context and follow-through. | OPS-1, OPS-2, OPS-13 |
| UC-034 | **Post-incident RCA and remediation follow-up.** Help an incident owner request reviews and actions, remind, observe status, and close without a recurring meeting spreadsheet. | One cell per incident; retain compact milestones and external action/response/evidence links plus overdue escalation state. | **Guarded pending deployment hardening.** The authorized incident system remains authoritative; sensitive payloads stay there. | OPS-13, OPS-15, LOCAL |
| UC-035 | **Webhook-gap and replay reconciler.** Help an integration owner detect a bounded delivery gap and safely work through replay to a known cursor. | One cell per endpoint/source pair; compare received and source cursors, draft a replay request with stable keys, record ambiguous attempts, and observe convergence. | **Strong.** v0 does not trigger replay; later handlers require explicit retrieval, idempotency, and reconciliation semantics. | OPS-14, DEV-2, LOCAL |
| UC-036 | **Error-budget release-policy review.** Help a service owner apply an explicit release policy when a slow-moving error budget crosses a decision boundary. | One cell per service/window; read compact SLO summaries, request a release posture decision, remind, and record resumption criteria. | **Guarded.** Humans own release gates; not a low-latency circuit breaker or SLO engine. | OPS-15 |
| UC-037 | **Cost-anomaly investigation shepherd.** Help a FinOps owner prevent an anomaly from becoming another dismissed alert by tracking hypothesis, owner, and observed resolution. | One cell per anomaly; ingest a bounded aggregate from an existing detector, attach price facts, request investigation, and recheck spend. | **Guarded.** Detection and billing data remain external; never make autonomous commitments or resource deletions. | OPS-3, LOCAL |
| UC-038 | **IAM unused or external-access review.** Help an identity owner periodically adjudicate selected stale grants or changed external access. | One cell per principal/resource review; read a bounded analyzer projection, request owner attestation, poll its external status, and observe approved removal. | **Guarded pending deployment hardening.** Sensitive IAM payloads stay in the authorized identity system; no autonomous revocation. | LOCAL |
| UC-039 | **Secret-rotation failure shepherd.** Help a platform owner carry a missed or failed rotation through investigation and observed recovery. | One cell per secret identifier; read only age/status metadata, track external owner and attempt references, remind, and close on vault confirmation. | **Guarded pending deployment hardening.** Never read or store secret material; emergency paging remains elsewhere. | LOCAL |
| UC-040 | **SaaS plan, entitlement, or region-availability change review.** Help a product owner notice vendor changes that affect a planned capability or customer commitment. | One cell per vendor capability; checkpoint official catalog/terms facts, summarize deltas, request owner review, and retain the decision. | **Guarded.** Source stability varies; use explicit vendor allowlists and avoid scraping behind authentication without permission. | LOCAL |

### 5. Vendor, privacy, and governance

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-041 | **Subprocessor, DPA, and terms-change review.** Help privacy and vendor-risk owners detect a material change and complete a documented applicability review. | One cell per vendor; fingerprint approved sources, retain bounded clause deltas and data-flow references, request counsel review, and track deadlines. | **Guarded and high-stakes.** Summarize and shepherd only; humans decide legal effect and objections in an authorized system. | GOV-1, GOV-2, LOCAL |
| UC-042 | **Privacy-policy material-change review.** Help a product or privacy owner compare a selected provider's current policy with the version relied upon. | One cell per provider policy; keep revision hashes and bounded changed sections, classify topics, request review, and poll the external outcome. | **Guarded.** Respect access terms; no autonomous legal conclusion or broad web crawl. | GOV-1, KNW-2, LOCAL |
| UC-043 | **AI data-use and training-policy change review.** Help an AI governance owner notice when a vendor changes retention, training, opt-out, or data-use claims. | One cell per AI provider/product; compare versioned terms and model-card facts, map to an external approved-use record, and open a source-linked review. | **Guarded.** Marketing prose is not a guarantee; require contracts and human verification. | OPS-12, OPS-16, GOV-2, LOCAL |
| UC-044 | **Data-residency claim and location-drift review.** Help a privacy or platform owner reassess a service when supported regions or processing claims change. | One cell per vendor workload; checkpoint configured region/residency sources, attach a bounded deployment projection, request review, and poll exception state. | **Guarded.** No compliance determination; deployment inventory must be scoped and protected outside cell state. | OPS-1, GOV-1, LOCAL |
| UC-045 | **Trust-center and security-documentation change case.** Help vendor-risk owners notice revised certifications, architecture claims, or security documents between formal reviews. | One cell per vendor trust source; fingerprint named documents, summarize material metadata changes, and request owner attestation. | **Guarded.** Authenticated sources need permission; do not store confidential reports in cell state. | GOV-2, LOCAL |
| UC-046 | **SOC 2, ISO, insurance, or assurance-evidence expiry shepherd.** Help a vendor owner request current assurance material before approval or renewal lapses. | One cell per vendor/control item; track period, expiry, request attempts, exception, reviewer reference, and accepted replacement link. | **Guarded pending deployment hardening.** Keep only metadata and secure links; confidential reports remain in the authorized repository. | GOV-2, LOCAL |
| UC-047 | **Approved-vendor periodic risk re-review.** Help a vendor owner revisit an explicit decision instead of letting approval persist indefinitely. | One cell per vendor approval; wake by review interval, collect bounded deltas from configured sources, request answers, and poll the external renewal decision. | **Guarded pending deployment hardening.** Protein assembles and follows up; the risk method, sensitive payloads, and final approval remain external. | GOV-1, GOV-2, LOCAL |
| UC-048 | **Contract-renewal and obligation checkpoint.** Help a commercial owner surface notice dates, evidence obligations, and open decisions early enough to act. | One cell per contract; store dates only after human verification, wake on staged lead times, request review, and reference externally retained notice records. | **Guarded.** The signed contract is authoritative; no model-derived date may trigger notice or payment. | GOV-2, LOCAL |
| UC-049 | **Data-retention and deletion-policy drift review.** Help a data governance owner compare implementation status with written retention decisions. | One cell per dataset/policy pair; compare a compact policy revision and external deletion-job status, request attestation, and track remediation references. | **Guarded.** No personal data in agent state; deletion execution and formal proof stay in specialized systems. | GOV-1, KNW-1, LOCAL |
| UC-050 | **Shared policy, handbook, or ACL-change review.** Help an owner notice material edits or access changes to a controlled document and obtain re-attestation. | One cell per critical document; consume a change cursor, compare revision/ACL metadata, request review, and poll the externally recorded answer. | **Guarded pending deployment hardening.** Limit content and principals per wake; document and identity systems remain authoritative. | KNW-1, KNW-2, LOCAL |

### 6. Commerce, product safety, and supply

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-051 | **Product recall-to-inventory remediation shepherd.** Help a safety or commerce owner map an official recall to catalog and inventory, adjudicate matches, and observe remediation state. | One cell per recall and match cohort; checkpoint notice revisions, retain SKU/lot decision references, draft recommended actions, and recheck bounded residual inventory. | **Guarded and high-stakes.** Human safety review and secondary control; v0 never changes a catalog or sends customer communication. | SAFE-1, LOCAL |
| UC-052 | **Vehicle-fleet recall shepherd.** Help a fleet owner match official safety recalls to owned vehicles and track externally reported repair completion. | One cell per recall/fleet cohort; read bounded vehicle identifiers and recall status, draft a scheduling request, remind, and retain dealer/repair-record links. | **Guarded.** Official VIN/dealer verification governs action; never the only vehicle-safety control. | SAFE-2, LOCAL |
| UC-053 | **Medical-device or food-supply recall shepherd.** Help a facility or distributor identify candidate stock and carry an official enforcement report through review and disposition. | One cell per recall and facility cohort; compare official identifiers with a bounded inventory projection, track external adjudication and residual checks, then close the internal case. | **Guarded and high-stakes.** Trained staff approve all holds, notices, and disposition; established FDA safety alerts and recall procedures remain primary because openFDA is not a public-alert or lifecycle source. | SAFE-3, LOCAL |
| UC-054 | **Supplier sanctions and restricted-party delta review.** Help a trade-compliance owner reassess selected counterparties when official lists change. | One cell per counterparty review or bounded name cohort; consume list revisions, use a specialist matcher, request due diligence, and poll external disposition. | **Guarded and high-stakes.** Not an autonomous screening decision; the official guidance explicitly requires further due diligence. | SAFE-4, SAFE-5, LOCAL |
| UC-055 | **Supplier-certification expiry shepherd.** Help procurement keep required quality, safety, sustainability, or insurance records under review. | One cell per supplier/certificate; track issuer, scope, expiry and request state, then poll external reviewer acceptance, exception, and replacement link. | **Strong.** Verify against the issuer or approved system; retain links and hashes rather than confidential documents. | LOCAL |
| UC-056 | **Tariff or export-control impact review.** Help a trade owner reassess a bounded product/country flow after an official classification or control change. | One cell per product-flow case; checkpoint selected official codes/notices, attach verified internal classification, request counsel review, and track action. | **Guarded and high-stakes.** Human classification and legal review only; no autonomous shipment release or block. | SAFE-5, GOV-3 |
| UC-057 | **Marketplace seller-policy change shepherd.** Help an ecommerce operator understand a platform-rule change, request catalog/process updates, and observe readiness. | One cell per marketplace/policy family; fingerprint the official notice, summarize bounded deltas, track external owner milestones, and retain completion links. | **Guarded.** Official seller communications preferred; source access and interpretation vary by marketplace. | LOCAL |
| UC-058 | **Component end-of-life and last-time-buy shepherd.** Help a hardware owner carry a manufacturer lifecycle notice through affected BOMs, alternatives, dates, and procurement decisions. | One cell per component notice; read bounded manufacturer records, map an external BOM projection, remind owners, and observe replacement or approved-buy state. | **Strong.** No autonomous purchase; BOM indexing and engineering qualification remain external. | LOCAL |
| UC-059 | **Supplier lead-time or availability-drift case.** Help a supply owner follow a material change for a selected constrained component instead of watching a dashboard. | One cell per supplier/component; checkpoint structured availability, compare with an approved threshold, open one case, and recheck until resolved. | **Guarded.** Contracted APIs only, modest cadence, and no purchasing or market speculation. | LOCAL |
| UC-060 | **Public-company vendor risk-factor watch.** Help a vendor or credit-risk owner review material filing changes for a small set of strategic suppliers. | One cell per issuer; consume filing IDs, extract bounded named sections, compare with prior text, request human review, and retain the decision. | **Guarded.** Not investment advice or an automated credit decision; official filings remain authoritative. | GOV-8 |

### 7. Science, health, and evidence

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-061 | **Living-evidence review sentinel.** Help a research team keep a narrowly framed review current as new studies appear. | One cell per registered query/review; advance search cursors, dedupe identifiers, triage a bounded batch, request reviewer inclusion decisions, and retain provenance. | **Guarded.** Human systematic-review methods govern screening; Protein is not a literature corpus or medical recommender. | SCI-2, SCI-3, SCI-4 |
| UC-062 | **Clinical-trial lifecycle shepherd.** Help a research, advocacy, or competitive-intelligence owner follow selected studies through status, dates, results, and publications. | One cell per trial; checkpoint versioned study fields, summarize changes, link related records, and request interpretation when milestones move. | **Guarded.** Informational only; no patient treatment, enrollment, or safety decision. | SCI-1, SCI-2 |
| UC-063 | **Retraction or correction downstream-citation repair.** Help a knowledge owner find and review internal material that relies on a corrected or retracted work. | One cell per cited work; check scholarly metadata/relations, map a bounded internal citation index, draft review items, and observe later revisions. | **Strong.** Citation indexing is external; humans judge whether the conclusion changes. | SCI-3, SCI-2, LOCAL |
| UC-064 | **ClinVar classification-change review.** Help a laboratory or knowledge-base owner reassess a selected variant record when submitted interpretations change. | One cell per variant; checkpoint accession/version and classification fields, produce a delta packet, request qualified review, and retain disposition. | **Guarded and high-stakes.** ClinVar cautions require expert interpretation; never clinical advice or an autonomous report update. | SCI-5 |
| UC-065 | **Clinical-guideline update impact shepherd.** Help a qualified clinical-governance team track selected official guideline revisions against owned protocols. | One cell per guideline/protocol pair; fingerprint the official version, summarize bounded changes, draft an expert review, and poll the external protocol decision. | **Guarded and high-stakes.** Official source and licensed access required; clinicians make every care decision. | LOCAL |
| UC-066 | **Research dataset, benchmark, model-card, or license-change review.** Help a research owner know when a relied-upon artifact changes terms, declared limitations, or version. | One cell per artifact; checkpoint revision and metadata, compare material fields, request reproducibility/governance review, and record migration. | **Strong.** Store metadata rather than large datasets or model weights. | OPS-12, SCI-3 |
| UC-067 | **Patent landscape and saved-query watch.** Help an IP team review new publications or status changes for a tightly scoped technical query. | One cell per saved query/family; advance official result cursors, dedupe family IDs, triage a bounded batch, and retain attorney decisions. | **Guarded.** Counsel owns legal conclusions; no novelty, freedom-to-operate, or infringement determination. | SCI-6, SCI-7 |
| UC-068 | **Preprint-to-publication lineage and result-drift watch.** Help a research consumer connect a selected preprint with later peer-reviewed, corrected, or updated versions. | One cell per work; compare identifiers, relations, abstract/result metadata, request reviewer assessment, and retain version lineage. | **Guarded.** Matching is probabilistic and human-confirmed; do not present publication as validation. | SCI-2, SCI-3 |
| UC-069 | **Funder data-management or reporting-policy change review.** Help a research administrator apply a funder's changed requirements before the next submission or report. | One cell per funder/policy; checkpoint configured official notices, map a bounded external portfolio, request administrator review, and track external updates. | **Guarded.** Program officers and official award terms govern; opportunity APIs cover only part of the source path. | GOV-9, LOCAL |
| UC-070 | **Replication or new-evidence watch for a critical claim.** Help an owner periodically reassess a small set of claims used in policy, product, or research decisions. | One cell per claim and registered query; retrieve a bounded new-record batch, request expert relevance review, and maintain source and decision references. | **Guarded.** Human experts define searches and strength of evidence; no automated truth score. | SCI-2, SCI-3, SCI-4, LOCAL |

### 8. Regulation, funding, and public records

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-071 | **Regulatory applicability and deadline shepherd.** Help a compliance owner carry one rule from proposal through applicability, comments, obligations, and observed implementation status. | One cell per rule/docket; checkpoint stage and dates, retain source provenance and external human-decision references, remind, and re-evaluate on revision. | **Guarded and high-stakes.** Informational triage only; official text and counsel govern. | GOV-3, GOV-4, GOV-7, LOCAL |
| UC-072 | **EU legal-act and implementation update tracker.** Help a policy owner follow a selected EU act, corrigenda, delegated acts, and national implementation questions. | One cell per act/topic; read official identifiers and versions, produce a bounded delta packet, request review, and reference external decisions. | **Guarded and high-stakes.** Multilingual legal interpretation remains with qualified reviewers. | GOV-5, LOCAL |
| UC-073 | **Regulations.gov docket and comment-window watch.** Help a policy team surface selected docket documents and comment or hearing deadlines. | One cell per docket; advance document cursor, track significant records and dates, request human triage, and retain submission links. | **Guarded and high-stakes.** Protein drafts and reminds; authorized humans verify deadlines and submit comments outside Protein. | GOV-4, GOV-3, LOCAL |
| UC-074 | **Congressional bill text and status watch.** Help a government-affairs owner understand revisions, actions, and likely internal review needs for selected bills. | One cell per bill; checkpoint official action/text versions, summarize changes, request policy review, and retain organizational decisions. | **Guarded.** No prediction presented as fact and no autonomous lobbying communication. | GOV-6, GOV-7 |
| UC-075 | **Grant-opportunity matcher and deadline shepherd.** Help a research or nonprofit owner review a narrow saved search, make a go/no-go decision, and track staged deadlines. | A saved-search cell emits a bounded candidate digest; an external operator/controller provisions a separate selected-opportunity cell that polls submission checkpoints. | **Strong.** Humans verify eligibility and submit; Protein neither queues every result nor writes an entire application. | GOV-9, LOCAL |
| UC-076 | **Government-contract opportunity matcher.** Help a small vendor review a narrow procurement search and carry selected notices through bid/no-bid and amendments. | A saved-search cell emits bounded candidates; an external operator/controller provisions a separate opportunity cell to track notice changes and deadlines. | **Guarded.** Humans verify representations, eligibility, and submissions; Protein neither queues discoveries nor submits bids. | GOV-10, LOCAL |
| UC-077 | **SEC material-filing change watch.** Help a corporate, vendor-risk, or governance owner review selected filing events and changed disclosures. | One cell per issuer/form family; advance filing IDs, compare bounded named sections or facts, request review, and retain disposition. | **Guarded.** Not investment, trading, accounting, or legal advice. | GOV-8 |
| UC-078 | **Public-dataset revision and provenance sentinel.** Help an analyst know when a relied-upon government dataset changes schema, coverage, revision date, or historical values. | One cell per dataset; checkpoint configured metadata and bounded sample aggregates, open a reproducibility review, and observe downstream refresh. | **Strong.** Large downloads and recomputation occur in a data pipeline; source-specific revision behavior must be validated. | GOV-7, GOV-11, LOCAL |
| UC-079 | **Disaster-declaration and assistance-applicability shepherd.** Help a public-service organization review official declaration changes against served places and programs. | One cell per declaration/region; checkpoint declaration and program fields, request qualified applicability review, remind, and retain outreach decisions. | **Guarded and high-stakes.** Secondary informational channel; official emergency and benefits sources govern. | GOV-11 |
| UC-080 | **Government audit-recommendation follow-up.** Help an agency or contractor carry a published finding through ownership, due dates, linked response records, and closure status. | One cell per recommendation; checkpoint configured official status, track external action and reviewer references, remind, and retain provenance links. | **Guarded pending deployment hardening.** Sensitive response material stays in the authorized source system; the issuing body determines formal closure. | GOV-7, LOCAL |

### 9. Environment and civic infrastructure

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-081 | **Wildfire-proximity operations brief.** Help an operator periodically reassess selected facilities against active-fire observations and open one reviewable preparedness case. | One cell per facility/incident; read a bounded geographic query, compare distance and trend rules, notify an owner, and retain decisions. | **Guarded and safety-critical.** Never the sole warning source; official emergency authorities and local conditions govern action. | ENV-4, GOV-11 |
| UC-082 | **Stream-gauge or flood-threshold case.** Help a site owner follow a selected gauge as it crosses planning thresholds and document preparations and recovery. | One cell per gauge/site; read compact observations, apply deterministic thresholds and hysteresis, issue stable-key notifications, and poll external acknowledgement. | **Guarded and safety-critical.** Not a real-time life-safety warning system; use official alerts in parallel. | ENV-3, ENV-1, LOCAL |
| UC-083 | **Severe-weather operational-impact brief.** Help a distributed operations team translate selected official alerts into facility-specific review and follow-up. | One cell per facility/alert episode; checkpoint official alert IDs and revisions, attach bounded site context, notify, and reference external decisions. | **Guarded and safety-critical.** NWS/local emergency channels remain primary; Protein adds context, not forecasting. | ENV-1, LOCAL |
| UC-084 | **Earthquake site-impact follow-up.** Help an infrastructure owner turn an official nearby event into a bounded inspection and status case. | One cell per site/event; read official event revisions, apply conservative geographic rules, draft an inspection request, and track external result links. | **Guarded and safety-critical.** Not early warning or structural assessment; emergency procedures govern. | ENV-2, LOCAL |
| UC-085 | **Facility environmental-compliance or enforcement-change review.** Help an environmental owner follow selected public records, due dates, and internal responses. | One cell per facility/permit topic; checkpoint official record IDs and revisions, request specialist review, remind, and poll external disposition. | **Guarded and high-stakes.** Agency records and environmental counsel govern; sensitive facility data stays in the authorized source system. | ENV-5, LOCAL |
| UC-086 | **Drinking-water violation or public-notice watch.** Help a facility, community group, or property operator follow official records and complete a human-reviewed response. | One cell per water system; compare bounded official records, notify a designated reviewer, track communication decisions, and retain closure. | **Guarded and safety-critical.** Never replace utility/public-health alerts or offer medical guidance. | ENV-5 |
| UC-087 | **Industrial permit and inspection-change shepherd.** Help an EHS owner carry a new inspection, permit revision, or enforcement record through internal review. | One cell per facility/program; checkpoint public metadata, attach external owner/date references, remind, and retain response links. | **Guarded and high-stakes.** Official permits and qualified staff control obligations. | ENV-5, LOCAL |
| UC-088 | **Drought, reservoir, or water-policy threshold review.** Help an operator revisit plans when selected hydrologic observations or official stages change. | One cell per basin/site policy; read bounded observations and official stage, apply reviewed thresholds, request action review, and retain decisions. | **Guarded.** Not an autonomous allocation or emergency decision; source and threshold quality are deployment-specific. | ENV-3, LOCAL |
| UC-089 | **Local zoning or permit-application watch.** Help a resident, developer, or property owner follow selected parcels or projects through notices, hearings, and decisions. | One cell per parcel/application; advance an official local feed, retain dates and document IDs, remind, and preserve participation decisions. | **Guarded.** Accept only jurisdictions with stable lawful feeds; official notices remain controlling. | LOCAL |
| UC-090 | **Public-meeting agenda and minutes issue watch.** Help a civic or organizational owner follow a narrow topic from agenda publication through minutes and assigned follow-up. | One cell per body/topic; retrieve bounded new agendas, request relevance review, track meeting dates and outcomes, and retain links. | **Guarded.** Local source quality and meeting-law rules vary; no broad political profiling or mass persuasion. | LOCAL |

### 10. Knowledge, market intelligence, and personal administration

| ID | Candidate and job | Protein-shaped loop | Fit and boundary | Evidence |
|---|---|---|---|---|
| UC-091 | **Knowledge-base staleness and owner-attestation shepherd.** Help a documentation owner keep critical pages owned, reviewed, current, or intentionally retired. | One cell per page/collection; track revision, owner and review date, request attestation, remind, and poll the externally recorded answer. | **Strong.** Low-risk reference pilot; never silently rewrite policy or mark content true from age alone. | KNW-1, KNW-2 |
| UC-092 | **Customer-facing docs versus product-manifest consistency review.** Help a product owner find when selected promises, limits, versions, or examples drift from structured product facts. | One cell per product/doc set; compare bounded assertions with a human-owned manifest, open one review per stable fact, and observe the published revision. | **Strong.** Models propose candidate mismatches rather than publishing edits or declaring truth. | KNW-1, DEV-7, LOCAL |
| UC-093 | **Cited-source and quote-drift review.** Help an analyst or publisher revisit material that depends on a source whose content, status, or wording changed. | One cell per source/citation cohort; checkpoint revision and selected passage hash, map a bounded citation index, request review, and retain outcome. | **Guarded.** Respect copyright/access rules and keep excerpts minimal; humans judge semantic impact. | SCI-3, KNW-2 |
| UC-094 | **Competitor release and feature-change review.** Help a product manager maintain a small evidence-backed watchlist without a daily manual tour. | One cell per named competitor/product; read official release records, dedupe changes, classify against explicit themes, and request review. | **Guarded.** Public lawful sources only, bounded watchlist, no covert collection or generated certainty. | DEV-1, LOCAL |
| UC-095 | **Competitor price and packaging-change review.** Help a commercial owner notice a selected public plan's changed price, limits, or packaging and retain the response rationale. | One cell per plan; fingerprint named fields, produce a bounded delta, request review, and remember the decision. | **Guarded.** Taxes, regions, contracts, and experiments complicate comparison; no autonomous repricing or collusion. | LOCAL |
| UC-096 | **Public roadmap, issue, or milestone watch.** Help a dependency owner follow a selected upstream commitment and revise internal plans when status or dates move. | One cell per issue/milestone; consume bounded repository events, checkpoint state, request plan review, and retain changed assumptions. | **Strong.** Treat roadmaps as signals, not promises; monitor an explicit allowlist. | DEV-2 |
| UC-097 | **Article correction and update tracker.** Help a newsroom, researcher, or internal knowledge owner revisit work when a relied-upon article publishes a correction or material update. | One cell per article; compare revision metadata or publisher notice, request editor review, track affected internal references, and close. | **Guarded.** Publisher metadata quality varies; no indiscriminate page archiving or copyright-heavy storage. | SCI-3, LOCAL |
| UC-098 | **Visa or immigration official form-and-fee change shepherd.** Help an applicant-support team notice official procedural changes and update reviewed guidance. | One cell per jurisdiction/form; checkpoint official version, fee and date metadata, request qualified review, and track guidance updates. | **Guarded and high-stakes.** Not legal advice; applicants verify current instructions with the issuing authority. | GOV-12 |
| UC-099 | **Public-benefit or program-rule change shepherd.** Help an authorized service organization review official changes and update human-approved eligibility guidance. | One cell per program/rule; read bounded official records, retain applicability-question references, remind, and observe published guidance updates. | **Guarded and high-stakes.** Never make eligibility decisions or replace agency notices. | GOV-3, GOV-5, GOV-7, LOCAL |
| UC-100 | **Subscription renewal and material-terms checkpoint.** Help a team or individual review a selected renewal, price, cancellation window, and changed terms before commitment. | One cell per subscription; store human-verified dates and source hashes, wake at staged lead times, request a decision, and poll external confirmation. | **Strong when user-scoped.** No autonomous cancellation or payment; provider communication and the contract remain authoritative. | LOCAL |

## A reusable case specification

Before any candidate becomes a template, its design should fit on one page:

| Field | Required answer |
|---|---|
| Cell key | What single object or case gets a stable identity? |
| Provisioning | Which external application or operator creates the cell and turns selected discoveries into separate case goals? |
| Goal and closure | What outcome ends this goal, and when should a recurring case renew as a new goal? |
| Authoritative source | Which API, feed, document, or internal projection is trusted, and what is only informational? |
| Wake policy | What cadence, backoff, deadline slack, and maximum dormancy are safe? |
| Read budget | Maximum calls, records, bytes, and cursor movement in one step. |
| Deterministic comparison | Which hashes, identifiers, thresholds, or schema rules run before a model? |
| Model role | What genuinely ambiguous classification may use a model, and how is it bounded and reviewable? |
| Compact checkpoint | The minimum cursor, revision, facts, dates, decisions, and owner state needed at the next wake. |
| Effect contract | Effect kind, deterministic key, receiver idempotency, retry limit, and ambiguity reconciliation. |
| Human authority | Which decision or action can only be made by an authenticated person? |
| Review state | Which external review item will later wakes poll, given that v0 has no direct approval signal? |
| Evidence and retention | What history must be queryable, for how long, and where large or sensitive artifacts live instead. |
| Pilot and kill signal | Which baseline, metrics, failure injection, and incumbent comparison can falsify the hypothesis? |

## What not to build on Protein

These ideas fail the current fit gates even if they sound adjacent:

- real-time trading, bidding, fraud blocking, ad auctions, or market making;
- emergency dispatch, earthquake early warning, wildfire evacuation, or any sole-source life-safety alert;
- an autonomous clinician, legal counsel, sanctions adjudicator, benefits decider, hiring system, or credit decision-maker;
- a general chatbot, low-latency copilot, or tight many-turn research loop;
- a general queue, DAG/workflow engine, browser farm, crawler, search index, or observability pipeline;
- video, audio, document, model-weight, SBOM-fleet, or log processing that needs a large blob and compute plane inside each cell;
- fleet-wide correlation that requires unbounded fan-in or global transactions;
- in v0, any effect that performs a production deploy, infrastructure deletion, credential revocation, payment, purchase, filing, recall action, or customer safety message; these cases are notification or draft-ticket only;
- in a later version, any such mutation without an externally verified approval reference, idempotent handler, and explicit ambiguity-reconciliation design;
- any case whose correctness depends on exactly-once remote effects;
- any case whose useful deadline is shorter than the measured alarm, failover, and recovery envelope.

## Portfolio conclusion

The hundred candidates span many domains, but they are not a mandate to build a horizontal marketplace. They reveal one repeatable product primitive:

> **A durable, source-linked, human-accountable case that wakes only when it has something bounded to check or follow up.**

The next product decision should come from three pilots, not more ideation:

1. **Reference architecture:** UC-001, because it exercises structured change, optional interpretation, ownership, deadlines, effects, and closure.
2. **Low-risk usability:** UC-004 or UC-091, because false positives are cheap and design partners can judge value quickly.
3. **Durability-sensitive operations:** UC-021 or UC-027, after the outbox, recovery, and deployment model pass fault tests.

If those users mainly want a cron job, a source-native rule, or their existing ticket system, Protein should shrink to a celld recipe. If they value the remembered case—especially its deduplication, follow-through, replay behavior, and provenance trail—the library points to a coherent product rather than 100 unrelated automations.

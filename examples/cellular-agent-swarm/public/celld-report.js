import { comparisonView } from "./comparison-view-model.js";

const elements = {
  status: document.querySelector("#runtime-status"),
  dot: document.querySelector("#runtime-dot"),
  result: document.querySelector("#run-result"),
  runId: document.querySelector("#run-id"),
  evidenceLevel: document.querySelector("#evidence-level"),
  celldVersion: document.querySelector("#celld-version"),
  completedAt: document.querySelector("#completed-at"),
  claimBoundary: document.querySelector("#claim-boundary"),
  evidenceModeLabel: document.querySelector("#evidence-mode-label"),
  evidenceModeCopy: document.querySelector("#evidence-mode-copy"),
  runtimeLede: document.querySelector("#runtime-lede"),
  cellStateTitle: document.querySelector("#cell-state-title"),
  cellStateSummary: document.querySelector("#cell-state-summary"),
  footerMode: document.querySelector("#footer-mode"),
  metricGrid: document.querySelector("#metric-grid"),
  runtimeSignal: document.querySelector("#runtime-signal"),
  generationBody: document.querySelector("#generation-body"),
  cellGrid: document.querySelector("#runtime-cell-grid"),
  milestoneList: document.querySelector("#milestone-list"),
  celldLog: document.querySelector("#celld-log"),
  logCount: document.querySelector("#log-count"),
  refreshButton: document.querySelector("#refresh-button"),
  comparisonJsonLink: document.querySelector("#comparison-json-link"),
  comparisonEvidenceLabel: document.querySelector("#comparison-evidence-label"),
  comparisonBoundary: document.querySelector("#comparison-boundary"),
  neighborAnswerTitle: document.querySelector("#neighbor-answer-title"),
  neighborVerdict: document.querySelector("#neighbor-verdict"),
  neighborVerdictLabel: document.querySelector("#neighbor-verdict-label"),
  neighborVerdictAnswer: document.querySelector("#neighbor-verdict-answer"),
  neighborVerdictClaim: document.querySelector("#neighbor-verdict-claim"),
  neighborObservation: document.querySelector(".neighbor-efficiency"),
  neighborEfficiencyCopy: document.querySelector("#neighbor-efficiency-copy"),
  neighborObservationLabel: document.querySelector("#neighbor-observation-label"),
  comparisonFacts: document.querySelector("#comparison-facts"),
  pairedDetailTitle: document.querySelector("#paired-detail-title"),
  pairedDetailSummary: document.querySelector("#paired-detail-summary"),
  comparisonPending: document.querySelector("#comparison-pending"),
  comparisonConfig: document.querySelector("#comparison-config"),
  comparisonTrials: document.querySelector("#comparison-trials"),
  comparisonAnalysis: document.querySelector("#comparison-analysis"),
  comparisonLineage: document.querySelector("#comparison-lineage"),
  comparisonTrialHead: document.querySelector("#comparison-trial-head"),
  comparisonTrialBody: document.querySelector("#comparison-trial-body"),
  comparisonScoreChart: document.querySelector("#comparison-score-chart"),
  comparisonCurveTitle: document.querySelector("#comparison-curve-title"),
  comparisonCurveSummary: document.querySelector("#comparison-curve-summary"),
  comparisonChartKey: document.querySelector("#comparison-chart-key"),
  comparisonSpendTitle: document.querySelector("#comparison-spend-title"),
  comparisonSpendMeta: document.querySelector("#comparison-spend-meta"),
  comparisonSpend: document.querySelector("#comparison-spend"),
  lineageCoverage: document.querySelector("#lineage-coverage"),
  lineageGrid: document.querySelector("#lineage-grid"),
};

elements.refreshButton.addEventListener("click", loadReport);
void loadReport();

async function loadReport() {
  setLoading(true);
  try {
    const bundle = await fetchJson("/api/celld/latest");
    const [cellData, timeline, logData, comparisonData] = await Promise.all([
      optionalJson("/api/celld/latest/cells", { cells: [], collectionErrors: [] }),
      optionalJson("/api/celld/latest/timeline?mode=milestones&limit=80", { events: [] }),
      optionalJson("/api/celld/latest/log?source=celld&lines=80", { lines: [] }),
      optionalJson("/api/celld/comparison/latest", { summary: null, lineage: { runs: [], collectionErrors: [] } }),
    ]);
    renderReport(bundle, cellData.cells, timeline.events, logData.lines, comparisonData);
  } catch (error) {
    elements.status.textContent = "Evidence unavailable";
    elements.dot.classList.add("failed");
    elements.result.textContent = "UNAVAILABLE";
    elements.result.classList.add("failed");
    elements.metricGrid.replaceChildren(emptyState(error.message));
    elements.cellGrid.replaceChildren(emptyState("No cell projection could be loaded."));
    elements.milestoneList.replaceChildren(emptyState("No timeline could be loaded."));
    elements.celldLog.textContent = error.message;
    renderComparison(comparisonView(null, null));
  } finally {
    setLoading(false);
  }
}

function renderReport(bundle, cells, events, logLines, comparisonData) {
  const { manifest, summary } = bundle;
  const passed = summary.status === "passed";
  const live = summary.evidenceLevel === "celld-experiment";
  elements.status.textContent = passed ? "Latest run passed" : `Latest run ${summary.status}`;
  elements.dot.classList.toggle("failed", !passed);
  elements.result.textContent = summary.status.toUpperCase();
  elements.result.classList.toggle("failed", !passed);
  elements.runId.textContent = summary.runId;
  elements.runId.title = summary.runId;
  elements.evidenceLevel.textContent = summary.evidenceLevel;
  elements.celldVersion.textContent = summary.celld.version;
  elements.completedAt.textContent = formatTimestamp(summary.completedAt);
  elements.claimBoundary.textContent = summary.claimBoundary;
  elements.evidenceModeLabel.textContent = live ? "Live model-backed pilot" : "Real celld runtime";
  elements.evidenceModeCopy.textContent = live
    ? "OpenAI Responses tool calls · generated code in a bounded sandbox · separate hidden evaluation. This is one integration pilot, not comparative evidence."
    : "Real Protein cells and durable actions · deterministic mock capabilities · no LLM. This report reads the latest completed bundle; it does not run the experiment.";
  elements.runtimeLede.textContent = live
    ? `Evidence from ${summary.protein.expectedCells} autonomous Protein cells using bounded OpenAI Responses tool loops, durable receipts, generated artifacts, and authoritative evaluation through celld.`
    : `Evidence from ${summary.protein.expectedCells} Protein cells executing through celld, including durable action receipts, restart recovery, latency, memory, and raw runtime signals.`;
  elements.cellStateTitle.textContent = `${summary.protein.expectedCells} Protein cells`;
  elements.cellStateSummary.textContent = "Each tile is projected from that cell’s final durable state and action records after the celld restart.";
  elements.footerMode.textContent = live
    ? "Live Responses API · isolated evaluation · non-comparative pilot"
    : "Real runtime · mock capabilities · no LLM";

  const metrics = live ? liveMetrics(summary) : runtimeMetrics(summary);
  elements.metricGrid.replaceChildren(...metrics.map(metricCard));

  const logSignals = summary.runtimeLogSignals ?? {};
  const warnings = Number(logSignals.warnings ?? 0);
  const errors = Number(logSignals.errors ?? 0);
  elements.runtimeSignal.className = warnings > 0 ? "runtime-signal warning" : "runtime-signal clean";
  elements.runtimeSignal.replaceChildren(
    textElement("strong", `${number(warnings)} warnings · ${number(errors)} errors`),
    textElement(
      "span",
      logSignals.collectionError !== undefined
        ? `Runtime log analysis was incomplete: ${logSignals.collectionError}`
        : warnings === logSignals.peerOwnerUnreachable
        ? `Every warning matched celld's peer-owner-unreachable signal. All ${summary.protein.expectedCells} states matched across the restart, and the run completed.`
        : "Inspect the raw log tail and captured process log before interpreting this run.",
    ),
  );

  const generations = summary.experiment.generationMetrics ?? [];
  const generationRows = generations.map((generation) => {
    const row = document.createElement("tr");
    [
      `Generation ${generation.generation}`,
      `${generation.submissions} / ${summary.experiment.completedCells}`,
      milliseconds(generation.elapsedMs),
      milliseconds(generation.cellLatencyMs.p50),
      milliseconds(generation.cellLatencyMs.p95),
      number(generation.bestScore),
    ].forEach((value) => row.append(textElement("td", value)));
    return row;
  });
  if (generationRows.length === 0) generationRows.push(tableEmptyRow("No generation settled before this run ended."));
  elements.generationBody.replaceChildren(...generationRows);

  const scores = cells.map((cell) => cell.score);
  const low = scores.length === 0 ? 0 : Math.min(...scores);
  const high = scores.length === 0 ? 0 : Math.max(...scores);
  elements.cellGrid.style.setProperty("--columns", String(manifest.topology.columns ?? 4));
  elements.cellGrid.replaceChildren(
    ...(cells.length === 0
      ? [emptyState("No final per-cell state was collected before this run ended.")]
      : cells.map((cell) => cellCard(cell, low, high))),
  );

  elements.milestoneList.replaceChildren(
    ...(events.length === 0 ? [listEmptyState("No timeline milestones were collected.")] : events.map(milestoneItem)),
  );
  elements.celldLog.textContent = logLines.length === 0 ? "No celld process log was collected." : logLines.join("\n");
  elements.logCount.textContent = `${number(logLines.length)} captured lines`;
  renderComparison(comparisonView(comparisonData, summary));
}

function renderComparison(view) {
  elements.comparisonJsonLink.hidden = !view.available;
  elements.comparisonPending.hidden = view.available;
  elements.comparisonConfig.hidden = !view.available;
  elements.comparisonTrials.hidden = !view.available;
  elements.comparisonAnalysis.hidden = !view.available;
  elements.comparisonLineage.hidden = !view.available;
  elements.comparisonTrials.classList.toggle("fixed-quality", view.mode === "fixed-quality");
  elements.comparisonEvidenceLabel.textContent = view.available
    ? `Paired celld evidence · ${view.status}`
    : "Paired celld evidence unavailable";
  elements.comparisonBoundary.textContent = view.verdict.boundary;
  elements.neighborAnswerTitle.textContent = view.question;
  elements.neighborAnswerTitle.classList.toggle("fixed-quality", view.mode === "fixed-quality");
  elements.neighborObservationLabel.textContent = view.observationLabel;
  elements.neighborObservation.setAttribute("aria-label", view.mode === "fixed-quality"
    ? "Target attainment and censoring observation"
    : "Secondary descriptive efficiency observation");
  elements.pairedDetailTitle.textContent = view.detailTitle;
  elements.comparisonCurveTitle.textContent = view.chartTitle;
  elements.comparisonSpendTitle.textContent = view.spendTitle;
  elements.comparisonSpendMeta.textContent = view.spendMeta;
  elements.comparisonFacts.classList.toggle("fixed-quality", view.mode === "fixed-quality");
  elements.neighborVerdict.className = `neighbor-verdict ${view.verdict.tone}`;
  elements.neighborVerdictLabel.textContent = view.verdict.label;
  elements.neighborVerdictAnswer.textContent = view.verdict.answer;
  elements.neighborVerdictClaim.textContent = view.verdict.claim;
  elements.neighborEfficiencyCopy.textContent = view.efficiency.text;
  elements.comparisonFacts.replaceChildren(...view.headlineFacts.map(comparisonFact));
  elements.pairedDetailSummary.textContent = view.available
    ? view.mode === "fixed-quality"
      ? `${view.trials.length} planned pair${view.trials.length === 1 ? "" : "s"} are shown. ${view.complete ? "Confirmatory integrity is complete." : "Confirmatory evidence is incomplete; valid-pair statistics below are descriptive only."} Discovery-cost deltas use both-reached valid pairs only; one-sided and neither-reached outcomes remain censored.`
      : `${view.trials.length} paired trial${view.trials.length === 1 ? "" : "s"} are shown without selecting only the best run. ${view.verdict.boundary}`
    : "No paired comparison bundle exists yet. This section stays explicit about the missing isolated or local counterpart.";
  renderComparisonConfig(view);
  renderTrialTable(view);
  renderComparisonChart(view);
  renderSpend(view);
  renderLineage(view);
}

function comparisonFact(fact) {
  const article = document.createElement("article");
  article.className = "comparison-fact";
  article.append(textElement("span", fact.label), textElement("strong", fact.value), textElement("small", fact.detail));
  return article;
}

function renderComparisonConfig(view) {
  if (view.config.length === 0) {
    elements.comparisonConfig.replaceChildren(emptyState("Matched controls will appear when a comparison bundle is available."));
    return;
  }
  const list = document.createElement("dl");
  for (const [label, value] of view.config) {
    const item = document.createElement("div");
    item.append(textElement("dt", label), textElement("dd", value));
    list.append(item);
  }
  elements.comparisonConfig.replaceChildren(list);
}

function renderTrialTable(view) {
  renderTrialHeader(view.mode);
  if (view.trials.length === 0) {
    elements.comparisonTrialBody.replaceChildren(tableEmptyRow("No matched local-versus-isolated trials have been recorded.", view.mode === "fixed-quality" ? 9 : 8));
    return;
  }
  if (view.mode === "fixed-quality") {
    elements.comparisonTrialBody.replaceChildren(...view.trials.map(fixedQualityTrialRow));
    return;
  }
  const rows = view.trials.map((trial) => {
    const local = trial.conditions.local;
    const isolated = trial.conditions.isolated;
    const row = document.createElement("tr");
    row.className = trial.complete ? "trial-complete" : "trial-incomplete";
    row.append(
      stackedTableCell(`Trial ${trial.trial}`, trial.order.length > 0 ? trial.order.join(" → ") : "order unrecorded"),
      pairedTableCell(local?.bestScore, isolated?.bestScore),
      stackedTableCell(trial.upliftPercent === null ? "—" : signedPercent(trial.upliftPercent), trial.upliftAbsolute === null ? "absolute delta unavailable" : `${signedNumber(trial.upliftAbsolute)} score`),
      pairedTableCell(local?.tokens, isolated?.tokens),
      pairedTableCell(local?.toolExecutions, isolated?.toolExecutions),
      pairedTableCell(local?.fallbacks, isolated?.fallbacks),
      pairedTableCell(local?.elapsedMs, isolated?.elapsedMs, milliseconds),
      stackedTableCell(humanize(trial.outcome), trial.complete ? "both runs passed" : "pair incomplete"),
    );
    return row;
  });
  elements.comparisonTrialBody.replaceChildren(...rows);
}

function renderTrialHeader(mode) {
  const headers = mode === "fixed-quality"
    ? [
        ["Trial", null],
        ["Attempt integrity", null],
        ["Target outcome", null],
        ["First reach", "local / isolated"],
        ["Responses tokens", "at target · local / isolated"],
        ["Token delta", "local vs isolated"],
        ["Model turns", "at target · local / isolated"],
        ["Tool executions", "at target · local / isolated"],
        ["Elapsed", "to target · local / isolated"],
      ]
    : [
        ["Trial", null],
        ["Best score", "local / isolated"],
        ["Paired effect", null],
        ["Responses tokens", "local / isolated"],
        ["Tool executions", "local / isolated"],
        ["Fallbacks", "local / isolated"],
        ["Elapsed", "local / isolated"],
        ["Outcome", null],
      ];
  const row = document.createElement("tr");
  for (const [label, detail] of headers) {
    const cell = document.createElement("th");
    cell.append(document.createTextNode(label));
    if (detail !== null) cell.append(document.createElement("br"), textElement("span", detail));
    row.append(cell);
  }
  elements.comparisonTrialHead.replaceChildren(row);
}

function fixedQualityTrialRow(trial) {
  const local = trial.conditions.local;
  const isolated = trial.conditions.isolated;
  const outcome = trial.fixedQuality.outcome;
  const row = document.createElement("tr");
  row.className = trial.valid && trial.attemptIntegrity.validForPair
    ? `trial-complete target-${outcome}`
    : "trial-incomplete target-invalid";
  const delta = trial.fixedQuality.localVsIsolatedPct.responsesTokens;
  row.append(
    stackedTableCell(`Trial ${trial.trial}`, trial.order.length > 0 ? trial.order.join(" → ") : "order unrecorded"),
    stackedTableCell(
      trial.attemptIntegrity.validForPair ? "Valid evidence" : "Invalid evidence",
      trial.attemptIntegrity.reasons.length === 0
        ? trial.attemptIntegrity.recorded ? `${number(trial.attemptIntegrity.auditedAttempts)} / ${number(trial.attemptIntegrity.attempts)} attempts audited` : "legacy pair validity"
        : trial.attemptIntegrity.reasons.map(integrityReasonCopy).join("; "),
    ),
    stackedTableCell(fixedQualityOutcomeLabel(outcome), trial.fixedQuality.costComparable ? "cost comparable" : outcome === "invalid" ? "pair invalid" : "cost censored"),
    pairedTargetCell(local, isolated, "firstReachedGeneration", (value) => `G${number(value)}`),
    pairedTargetCell(local, isolated, "responsesTokens", number),
    stackedTableCell(delta === null ? "CENSORED" : signedPercent(delta), delta === null ? "both conditions must reach" : "negative means local used less"),
    pairedTargetCell(local, isolated, "modelTurns", number),
    pairedTargetCell(local, isolated, "toolExecutions", number),
    pairedTargetCell(local, isolated, "elapsedMs", milliseconds),
  );
  return row;
}

function integrityReasonLabel(code) {
  return {
    ambiguous_provider_attempt: "ambiguous provider attempt",
    exhausted_target_block_retry: "exhausted target-block retry",
  }[code] ?? String(code).replaceAll("_", " ");
}

function integrityReasonCopy(reason) {
  const label = integrityReasonLabel(reason.code);
  return reason.detail === null ? label : `${label} — ${reason.detail}`;
}

function pairedTargetCell(local, isolated, metric, formatter) {
  const localValue = targetMetric(local, metric);
  const isolatedValue = targetMetric(isolated, metric);
  return stackedTableCell(
    `${targetMetricLabel(local, localValue, formatter)} / ${targetMetricLabel(isolated, isolatedValue, formatter)}`,
    "local / isolated",
  );
}

function targetMetric(run, metric) {
  if (run?.target?.reached !== true) return null;
  if (metric === "firstReachedGeneration") return run.target.firstReachedGeneration;
  return run.target.boundary?.[metric] ?? null;
}

function targetMetricLabel(run, value, formatter) {
  if (run?.target?.valid !== true || run.target.state === "invalid") return "invalid";
  if (run.target.reached !== true) return "not reached";
  return value === null ? "unrecorded" : formatter(value);
}

function fixedQualityOutcomeLabel(outcome) {
  return {
    both_reached: "Both reached",
    local_only: "Local only",
    isolated_only: "Isolated only",
    neither_reached: "Neither reached",
    invalid: "Invalid pair",
  }[outcome] ?? "Invalid pair";
}

function stackedTableCell(primary, secondary) {
  const cell = document.createElement("td");
  cell.append(textElement("strong", primary), textElement("small", secondary));
  return cell;
}

function pairedTableCell(localValue, isolatedValue, formatter = number) {
  const local = localValue === null || localValue === undefined ? "—" : formatter(localValue);
  const isolated = isolatedValue === null || isolatedValue === undefined ? "—" : formatter(isolatedValue);
  return stackedTableCell(`${local} / ${isolated}`, "local / isolated");
}

function renderComparisonChart(view) {
  const svg = elements.comparisonScoreChart;
  svg.replaceChildren();
  if (view.mode === "fixed-quality") {
    renderFixedQualityCostChart(view, svg);
    return;
  }
  renderQualityChartKey();
  svg.setAttribute("viewBox", "0 0 760 330");
  const local = view.curves.local;
  const isolated = view.curves.isolated;
  const all = [...local, ...isolated];
  if (all.length === 0 || local.length === 0 || isolated.length === 0) {
    svg.append(svgText(380, 165, "A matched pair is required before a score curve can be drawn.", "chart-empty-label"));
    elements.comparisonCurveSummary.textContent = "No paired generation series is available.";
    svg.setAttribute("aria-label", "No paired generation score series available");
    return;
  }

  const width = 760;
  const height = 330;
  const plot = { left: 72, right: width - 24, top: 24, bottom: height - 48 };
  const maxGeneration = Math.max(1, ...all.map((point) => point.generation));
  const maxScore = Math.max(1, ...all.map((point) => point.maximum));
  const yMax = niceCeiling(maxScore);
  const x = (generation) => plot.left + (generation / maxGeneration) * (plot.right - plot.left);
  const y = (score) => plot.bottom - (score / yMax) * (plot.bottom - plot.top);

  for (let tick = 0; tick <= 4; tick += 1) {
    const score = yMax * tick / 4;
    const yPosition = y(score);
    svg.append(svgLine(plot.left, yPosition, plot.right, yPosition, "comparison-chart-grid"));
    svg.append(svgText(plot.left - 10, yPosition + 4, compactNumber(score), "comparison-chart-axis-label", "end"));
  }
  for (let generation = 0; generation <= maxGeneration; generation += 1) {
    const xPosition = x(generation);
    svg.append(svgLine(xPosition, plot.bottom, xPosition, plot.bottom + 6, "comparison-chart-tick"));
    svg.append(svgText(xPosition, plot.bottom + 24, generation === 0 ? "seed" : `G${generation}`, "comparison-chart-axis-label", "middle"));
  }

  drawCurve(svg, local, "local", x, y);
  drawCurve(svg, isolated, "isolated", x, y);
  const localVariation = view.variation.local;
  const isolatedVariation = view.variation.isolated;
  elements.comparisonCurveSummary.textContent = `Median best score across passed pairs. Local range ${rangeText(localVariation)}; isolated range ${rangeText(isolatedVariation)}.`;
  svg.setAttribute("aria-label", `Best verified score by generation. ${elements.comparisonCurveSummary.textContent}`);
}

function renderFixedQualityCostChart(view, svg) {
  const comparable = view.trials.flatMap((trial) => {
    const delta = trial.fixedQuality?.localVsIsolatedPct?.responsesTokens;
    return trial.fixedQuality?.costComparable === true && Number.isFinite(delta)
      ? [{ trial: trial.trial, delta }]
      : [];
  });
  const censored = view.trials.length - comparable.length;
  elements.comparisonChartKey.replaceChildren(textElement("span", "← local used less · isolated used less →"));
  if (comparable.length === 0) {
    svg.setAttribute("viewBox", "0 0 760 220");
    svg.append(svgText(380, 110, "No pair reached the target in both conditions.", "chart-empty-label", "middle"));
    elements.comparisonCurveSummary.textContent = `${number(censored)} censored pair${censored === 1 ? "" : "s"}; no discovery-cost delta was computed.`;
    svg.setAttribute("aria-label", elements.comparisonCurveSummary.textContent);
    return;
  }

  const height = Math.max(250, 92 + comparable.length * 30);
  const plot = { left: 92, right: 728, top: 34, bottom: height - 48 };
  const largest = Math.max(5, ...comparable.map((entry) => Math.abs(entry.delta)));
  const limit = Math.ceil(largest / 5) * 5;
  const x = (value) => plot.left + ((value + limit) / (limit * 2)) * (plot.right - plot.left);
  const zero = x(0);
  svg.setAttribute("viewBox", `0 0 760 ${height}`);

  for (const tick of [-limit, -limit / 2, 0, limit / 2, limit]) {
    const xPosition = x(tick);
    svg.append(svgLine(xPosition, plot.top, xPosition, plot.bottom, tick === 0 ? "cost-chart-zero" : "comparison-chart-grid"));
    svg.append(svgText(xPosition, plot.bottom + 25, `${tick > 0 ? "+" : ""}${number(tick, 1)}%`, "comparison-chart-axis-label", "middle"));
  }

  const rowHeight = (plot.bottom - plot.top) / comparable.length;
  comparable.forEach((entry, index) => {
    const y = plot.top + rowHeight * index + rowHeight / 2;
    const end = x(entry.delta);
    const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bar.setAttribute("x", String(Math.min(zero, end)));
    bar.setAttribute("y", String(y - Math.min(9, rowHeight * .28)));
    bar.setAttribute("width", String(Math.max(2, Math.abs(end - zero))));
    bar.setAttribute("height", String(Math.min(18, rowHeight * .56)));
    bar.setAttribute("class", `cost-chart-bar ${entry.delta < 0 ? "local-lower" : entry.delta > 0 ? "isolated-lower" : "equal"}`);
    svg.append(svgText(plot.left - 14, y + 4, `T${entry.trial}`, "comparison-chart-axis-label", "end"), bar);
    const anchor = entry.delta < 0 ? "end" : "start";
    const offset = entry.delta < 0 ? -7 : 7;
    svg.append(svgText(end + offset, y + 4, signedPercent(entry.delta), "cost-chart-value", anchor));
  });

  const distribution = view.fixedQuality.tokenDistribution;
  const interval = distribution.interval95;
  const medianText = distribution.median === null ? "median unavailable" : `median ${signedPercent(distribution.median)}`;
  const range = distribution.minimum === null || distribution.maximum === null
    ? "range unavailable"
    : `range ${signedPercent(distribution.minimum)} to ${signedPercent(distribution.maximum)}`;
  const intervalText = interval?.lower === null || interval?.upper === null || interval === null
    ? "bootstrap interval unavailable"
    : `95% paired bootstrap interval ${signedPercent(interval.lower)} to ${signedPercent(interval.upper)}`;
  const evidenceQualifier = view.complete ? "" : " Descriptive valid-pair result only; confirmatory evidence is incomplete.";
  elements.comparisonCurveSummary.textContent = `${number(comparable.length)} cost-comparable pair${comparable.length === 1 ? "" : "s"}; ${medianText}, ${range}; ${intervalText}. ${number(censored)} censored or invalid pair${censored === 1 ? " was" : "s were"} omitted, not treated as zero.${evidenceQualifier}`;
  svg.setAttribute("aria-label", `Paired Responses-token cost at target. ${elements.comparisonCurveSummary.textContent}`);
}

function renderQualityChartKey() {
  const local = document.createElement("i");
  local.className = "local";
  const isolated = document.createElement("i");
  isolated.className = "isolated";
  elements.comparisonChartKey.replaceChildren(local, document.createTextNode("Local "), isolated, document.createTextNode("Isolated"));
}

function drawCurve(svg, points, condition, x, y) {
  for (const point of points) {
    if (point.samples > 1) svg.append(svgLine(x(point.generation), y(point.minimum), x(point.generation), y(point.maximum), `comparison-range ${condition}`));
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", points.map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.generation)} ${y(point.score)}`).join(" "));
  path.setAttribute("class", `comparison-chart-line ${condition}`);
  svg.append(path);
  for (const point of points) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", x(point.generation));
    dot.setAttribute("cy", y(point.score));
    dot.setAttribute("r", "5");
    dot.setAttribute("class", `comparison-chart-dot ${condition}`);
    svg.append(dot);
  }
}

function renderSpend(view) {
  if (view.mode === "fixed-quality") {
    renderFixedQualityResources(view);
    return;
  }
  const sections = ["local", "isolated"].map((condition) => {
    const totals = view.totals[condition];
    const section = document.createElement("section");
    const heading = document.createElement("h4");
    heading.append(textElement("span", condition), textElement("small", `${totals.runs} run${totals.runs === 1 ? "" : "s"}`));
    const list = document.createElement("dl");
    [
      ["Responses tokens", number(totals.tokens)],
      ["Model turns", number(totals.modelTurns)],
      ["Tool executions", number(totals.toolExecutions)],
      ["Evaluations", number(totals.evaluations)],
      ["Credits spent", number(totals.creditsSpent)],
      ["Fallbacks", number(totals.fallbacks)],
      ["Total elapsed", milliseconds(totals.elapsedMs)],
    ].forEach(([label, value]) => {
      const item = document.createElement("div");
      item.append(textElement("dt", label), textElement("dd", value));
      list.append(item);
    });
    section.append(heading, list);
    return section;
  });
  elements.comparisonSpend.replaceChildren(...sections);
}

function renderFixedQualityResources(view) {
  const section = document.createElement("section");
  section.className = "fixed-quality-resource-section";
  const list = document.createElement("dl");
  list.className = "fixed-quality-resource-list";
  for (const resource of view.fixedQuality.resources) {
    const distribution = resource.distribution;
    const item = document.createElement("div");
    const label = document.createElement("dt");
    label.textContent = resource.label;
    const value = document.createElement("dd");
    value.append(
      textElement("strong", distribution.median === null ? "—" : signedPercent(distribution.median)),
      textElement("small", distribution.minimum === null || distribution.maximum === null
        ? "no both-reached observations"
        : `${signedPercent(distribution.minimum)} to ${signedPercent(distribution.maximum)} · n=${number(distribution.values.length)}`),
    );
    item.append(label, value);
    list.append(item);
  }
  const note = textElement("p", `Negative means local used less. Recheck measurement cost is excluded from the recorded discovery boundary.${view.complete ? "" : " These valid-pair distributions are descriptive only because confirmatory integrity is incomplete."}`);
  note.className = "fixed-quality-resource-note";
  section.append(list, note);
  elements.comparisonSpend.replaceChildren(section);
}

function renderLineage(view) {
  const localRuns = view.lineageRuns.filter((run) => run.condition === "local");
  const localSummaries = view.lineageSummaries.filter((run) => run.condition === "local");
  const projected = localRuns.length > 0 ? localRuns.length : localSummaries.length;
  elements.lineageCoverage.textContent = view.available
    ? `${projected} / ${view.trials.length} local run${view.trials.length === 1 ? "" : "s"} projected${view.lineageErrors.length > 0 ? ` · ${view.lineageErrors.length} board snapshots unavailable` : ""}`
    : "No paired lineage bundle";
  if (localRuns.length === 0 && localSummaries.length === 0) {
    elements.lineageGrid.replaceChildren(emptyState(view.available
      ? "The paired summary is available, but no board-snapshot lineage projection was collected."
      : "Lineage will appear after a matched local run is recorded."));
    return;
  }
  elements.lineageGrid.replaceChildren(...(localRuns.length > 0
    ? localRuns.map((run) => lineageCard(run, localSummaries.find((summary) => summary.trial === run.trial)))
    : localSummaries.map(lineageSummaryCard)));
}

function lineageCard(run, summary) {
  const article = document.createElement("article");
  article.className = "lineage-card";
  const header = document.createElement("header");
  header.append(textElement("strong", `Trial ${run.trial} · local`), textElement("code", shortId(run.runId)));
  const list = document.createElement("ol");
  for (const generation of run.generations) {
    const item = document.createElement("li");
    const marker = textElement("span", `G${generation.generation}`);
    marker.className = "lineage-generation";
    const body = document.createElement("div");
    if (generation.leader === null) {
      body.append(textElement("strong", "No eligible candidate"), textElement("small", `${generation.candidates} candidate records`));
    } else {
      body.append(
        textElement("strong", generation.leader.strategy),
        textElement("small", `${number(generation.leader.score)} score · ${generation.leader.holders}/${generation.cells} holders · ${generation.adoptions} adoptions`),
        textElement("code", `${shortHash(generation.leader.candidateId)} · origin ${shortAgent(generation.leader.originAgent)}`),
      );
    }
    item.append(marker, body);
    list.append(item);
  }
  article.append(header, list);
  if (summary !== undefined) article.append(lineageMetrics(summary));
  return article;
}

function lineageSummaryCard(summary) {
  const article = document.createElement("article");
  article.className = "lineage-card lineage-summary-card";
  const header = document.createElement("header");
  header.append(textElement("strong", `Trial ${summary.trial} · local`), textElement("code", shortId(summary.runId)));
  const explanation = textElement("p", summary.neighborDerivedImprovements > 0
    ? `${summary.neighborDerivedImprovements} independently evaluated improvement${summary.neighborDerivedImprovements === 1 ? "" : "s"} descended from another cell’s candidate.`
    : "No independently evaluated cross-cell improvement was identified in the projected lineage.");
  explanation.className = "lineage-summary-copy";
  article.append(header, explanation, lineageMetrics(summary));
  return article;
}

function lineageMetrics(summary) {
  const list = document.createElement("dl");
  list.className = "lineage-metrics";
  [
    ["Submitted candidates", summary.uniqueSubmittedCandidates],
    ["Final diversity", summary.finalDiversity],
    ["Adoptions", summary.adoptions],
    ["Neighbor-derived improvements", summary.neighborDerivedImprovements],
    ["Maximum lineage depth", summary.maxDepth],
    ["Duplicate evaluations", summary.duplicateEvaluations],
  ].forEach(([label, value]) => {
    const item = document.createElement("div");
    item.append(textElement("dt", label), textElement("dd", number(value)));
    list.append(item);
  });
  return list;
}

function runtimeMetrics(summary) {
  return [
    ["Recovered cells", `${summary.protein.distinctCells} / ${summary.protein.expectedCells}`, "distinct Protein identities"],
    ["Delivered actions", number(summary.protein.actionsByStatus.delivered ?? 0), `${number(summary.protein.redeliveries)} redeliveries`],
    ["Action latency p95", milliseconds(summary.protein.actionLatencyMs.p95), `${number(summary.protein.actionLatencyMs.samples)} receipt samples`],
    ["Restart recovery", milliseconds(summary.celld.restartRecoveryMs), `${number(summary.celld.instances)} celld process instances`],
    ["Peak celld RSS", `${number(summary.celld.peakRssMb, 1)} MiB`, `${number(summary.celld.rssSamples)} procfs samples`],
    ["Durable journals", number(summary.protein.journals), `${number(summary.runtimeLogSignals.proteinCheckpoints)} checkpoint logs`],
  ];
}

function liveMetrics(summary) {
  const model = summary.services?.modelGateway ?? {};
  const executor = summary.services?.toolExecutor ?? {};
  const evaluator = summary.services?.evaluator ?? {};
  return [
    ["Recovered cells", `${summary.protein.distinctCells} / ${summary.protein.expectedCells}`, "distinct Protein identities"],
    ["Model turns", number(model.completedActions), `${model.model ?? "recorded model"} · ${number(model.providerRetries)} retries`],
    ["Responses tokens", number(model.usage?.totalTokens), `${number(model.usage?.reasoningTokens)} reasoning · ${number(model.usage?.cachedInputTokens)} cached input`],
    ["Tool executions", number(executor.completedActions), `${number(executor.publicChecks ?? executor.publicCheckRuns)} public-check runs`],
    ["Hidden evaluations", number(evaluator.completedActions), `${number(evaluator.passedEvaluations)} passed correctness gate`],
    ["Restart recovery", milliseconds(summary.celld.restartRecoveryMs), `${number(summary.protein.actionsByStatus.delivered ?? 0)} durable actions delivered`],
  ];
}

function metricCard([label, value, detail]) {
  const article = document.createElement("article");
  article.className = "metric-card";
  article.append(textElement("span", label), textElement("strong", value), textElement("small", detail));
  return article;
}

function cellCard(cell, low, high) {
  const article = document.createElement("article");
  const position = cell.id.match(/r(\d+)c(\d+)$/);
  const range = Math.max(1, high - low);
  const level = (cell.score - low) / range > .66 ? "high" : (cell.score - low) / range > .25 ? "mid" : "low";
  article.className = `runtime-cell ${level}`;
  article.setAttribute("role", "listitem");
  article.title = cell.id;

  const head = document.createElement("div");
  head.className = "runtime-cell-head";
  head.append(
    textElement("code", position ? `R${position[1]} · C${position[2]}` : shortId(cell.id)),
    textElement("span", cell.status),
  );
  const score = textElement("strong", number(cell.score));
  score.className = "runtime-cell-score";
  const strategy = textElement("span", cell.strategy ?? "no strategy");
  strategy.className = "runtime-cell-strategy";
  const detail = textElement("small", `${cell.actions} actions · ${cell.credits} credits · ${cell.behavior ?? "no behavior"}`);
  article.append(head, score, strategy, detail);
  return article;
}

function milestoneItem(event) {
  const item = document.createElement("li");
  const marker = document.createElement("span");
  marker.className = "milestone-marker";
  const body = document.createElement("div");
  body.append(textElement("code", event.kind), textElement("p", describeEvent(event)));
  item.append(marker, body, textElement("time", `+${milliseconds(event.elapsedMs)}`));
  return item;
}

function describeEvent(event) {
  switch (event.kind) {
    case "run.started": return `Run started with ${event.rows}×${event.columns} cells for ${event.generations} generations.`;
    case "run.finished": return `Run finished with status ${event.status}.`;
    case "phase.changed": return `Entered ${String(event.phase).replaceAll("-", " ")}.`;
    case "capability.started": return "Deterministic mock capability and receipt service became ready.";
    case "live.services.started": return "Model gateway, bounded executor, hidden evaluator, and durable board became ready.";
    case "celld.started": return `celld process instance ${event.instance} became ready.`;
    case "celld.stopped": return `celld process instance ${event.instance} stopped (${event.reason}).`;
    case "celld.restart.recovered": return `All ${event.cells ?? 16} cell states matched after restart.`;
    case "event.identity.checked": return "Duplicate, conflicting event, and conflicting receipt behavior were checked.";
    case "generation.settled": return `Generation ${event.generation} settled ${event.submissions} submissions; best evaluator score ${number(event.bestScore)}.`;
    default: return String(event.phase ?? "Recorded runtime milestone.");
  }
}

function emptyState(message) {
  const paragraph = textElement("p", message);
  paragraph.className = "report-empty";
  return paragraph;
}

function listEmptyState(message) {
  const item = document.createElement("li");
  item.className = "report-empty";
  item.textContent = message;
  return item;
}

function tableEmptyRow(message, colSpan = 6) {
  const row = document.createElement("tr");
  const cell = textElement("td", message);
  cell.colSpan = colSpan;
  cell.className = "report-empty";
  row.append(cell);
  return row;
}

function textElement(tag, value) {
  const element = document.createElement(tag);
  element.textContent = String(value);
  return element;
}

function setLoading(loading) {
  elements.refreshButton.disabled = loading;
  elements.refreshButton.textContent = loading ? "Loading bundle…" : "Refresh latest bundle";
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  return body;
}

async function optionalJson(url, fallback) {
  try {
    return await fetchJson(url);
  } catch (error) {
    return { ...fallback, collectionError: error.message };
  }
}

function number(value, fractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: fractionDigits }).format(value ?? 0);
}

function milliseconds(value) {
  const numeric = Number(value ?? 0);
  return numeric >= 1000 ? `${number(numeric / 1000, 2)} s` : `${number(numeric, 1)} ms`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

function shortId(value) {
  return value.length > 18 ? `…${value.slice(-18)}` : value;
}

function shortHash(value) {
  const hash = String(value ?? "unknown").replace(/^sha256:/, "");
  return hash.length > 12 ? `${hash.slice(0, 7)}…${hash.slice(-5)}` : hash;
}

function shortAgent(value) {
  if (typeof value !== "string") return "unrecorded";
  const position = value.match(/r(\d+)c(\d+)$/);
  return position ? `R${position[1]}·C${position[2]}` : shortId(value);
}

function signedPercent(value) {
  return `${value > 0 ? "+" : ""}${number(value, 1)}%`;
}

function signedNumber(value) {
  return `${value > 0 ? "+" : ""}${number(value)}`;
}

function humanize(value) {
  return String(value ?? "unrecorded").replaceAll(/[_-]+/g, " ");
}

function rangeText(variation) {
  if (variation.samples === 0) return "unavailable";
  return variation.minimum === variation.maximum
    ? number(variation.minimum)
    : `${number(variation.minimum)}–${number(variation.maximum)}`;
}

function niceCeiling(value) {
  const power = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / power) * power;
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function svgLine(x1, y1, x2, y2, className) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("class", className);
  return line;
}

function svgText(x, y, value, className, anchor = "start") {
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", x);
  text.setAttribute("y", y);
  text.setAttribute("class", className);
  text.setAttribute("text-anchor", anchor);
  text.textContent = value;
  return text;
}

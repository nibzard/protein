let state;
let selectedCellId;
let autoplay;
let comparisonRows = [];
let pendingCondition = null;

const elements = {
  status: document.querySelector("#run-status"),
  condition: document.querySelector("#condition-select"),
  reset: document.querySelector("#reset-button"),
  step: document.querySelector("#step-button"),
  play: document.querySelector("#play-button"),
  taskPrompt: document.querySelector("#task-prompt"),
  publicChecks: document.querySelector("#public-checks"),
  hiddenChecks: document.querySelector("#hidden-checks"),
  generation: document.querySelector("#generation-summary"),
  best: document.querySelector("#best-score"),
  grid: document.querySelector("#cell-grid"),
  inspector: document.querySelector("#inspector-content"),
  chart: document.querySelector("#score-chart"),
  ledger: document.querySelector("#ledger-values"),
  ledgerStatus: document.querySelector("#ledger-status"),
  comparison: document.querySelector("#comparison-body"),
  events: document.querySelector("#event-list"),
  note: document.querySelector("#control-note"),
};

await refresh();
bindControls();

function bindControls() {
  elements.condition.addEventListener("change", () => {
    pendingCondition = elements.condition.value;
  });
  elements.reset.addEventListener("click", async () => {
    stopAutoplay();
    const condition = pendingCondition ?? elements.condition.value;
    await request("/api/reset", { condition, seed: state.seed });
    pendingCondition = null;
    await refresh();
  });
  elements.step.addEventListener("click", async () => {
    await request("/api/step", {});
    await refresh();
    if (state.status === "completed") stopAutoplay();
  });
  elements.play.addEventListener("click", () => {
    if (autoplay) stopAutoplay();
    else startAutoplay();
  });
  elements.grid.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-cell-id]");
    if (!button) return;
    selectedCellId = button.dataset.cellId;
    render();
  });
}

async function refresh() {
  [state, { rows: comparisonRows }] = await Promise.all([fetchJSON("/api/state"), fetchJSON("/api/comparison")]);
  if (!state.cells.some((cell) => cell.id === selectedCellId)) selectedCellId = state.cells[0]?.id;
  render();
}

function render() {
  const selected = state.cells.find((cell) => cell.id === selectedCellId) ?? state.cells[0];
  const best = Math.max(...state.cells.map((cell) => cell.score));
  elements.condition.value = pendingCondition ?? state.condition;
  elements.status.textContent = `SIMULATED ${state.status.toUpperCase()} · generation ${state.generation}/${state.config.generations}`;
  elements.taskPrompt.textContent = state.task.prompt;
  renderList(elements.publicChecks, state.task.publicChecks);
  renderList(elements.hiddenChecks, state.task.hiddenChecks);
  elements.generation.textContent = `Generation ${state.generation} of ${state.config.generations}. ${state.condition === "local" ? "Observations are limited to adjacent cells." : state.condition === "isolated" ? "Cells have no peer visibility." : "One agent spends the equivalent population budget in sequence."}`;
  elements.best.textContent = best;
  elements.grid.style.setProperty("--columns", state.config.columns);
  elements.grid.innerHTML = state.cells.map((cell) => cellMarkup(cell)).join("");
  elements.inspector.innerHTML = inspectorMarkup(selected);
  renderChart();
  renderLedger(best);
  renderComparison();
  renderEvents();
  const done = state.status === "completed";
  elements.step.disabled = done;
  elements.play.disabled = done;
  elements.play.textContent = autoplay ? "Pause" : "Auto-run";
  elements.play.setAttribute("aria-pressed", String(Boolean(autoplay)));
  elements.note.textContent = done
    ? "Scenario complete. Reset to replay the authored seed; use npm run swarm:celld for Protein runtime evidence."
    : "This is a deterministic Node fixture. It does not invoke celld, Protein cells, or an LLM.";
}

function cellMarkup(cell) {
  const candidate = state.candidates[cell.candidateId];
  const level = cell.score >= 480 ? "high" : cell.score > 0 ? "mid" : "low";
  const selected = cell.id === selectedCellId;
  return `<button type="button" class="cell ${level}${selected ? " selected" : ""}" data-cell-id="${cell.id}" aria-label="${cell.id}, score ${cell.score}, ${candidate.strategy.label}" aria-pressed="${selected}">
    <span class="cell-code"><span>${cell.id.replace("cell-", "C/")}</span><span>${candidate.strategy.family}</span></span>
    <strong class="cell-score">${cell.score || "×"}</strong>
    <span class="cell-action">${escapeHtml(cell.lastAction)}</span>
  </button>`;
}

function inspectorMarkup(cell) {
  if (!cell) return `<p class="inspector-empty">Select a cell to inspect its scripted artifact.</p>`;
  const candidate = state.candidates[cell.candidateId];
  const outcome = candidate.hiddenPass ? "fixture passed" : "fixture rejected";
  return `<div class="cell-title"><strong>${escapeHtml(cell.id)}</strong><span>g${cell.lineageDepth} lineage</span></div>
    <h4 class="candidate-name">${escapeHtml(candidate.strategy.label)}</h4>
    <p class="candidate-insight">${escapeHtml(candidate.strategy.insight)}</p>
    <pre class="source-block"><code>${escapeHtml(candidate.strategy.source)}</code></pre>
    <ul class="inspection-list">
      <li><span>Scenario score</span><strong class="${candidate.hiddenPass ? "outcome-pass" : "outcome-fail"}">${candidate.score || "rejected"}</strong></li>
      <li><span>Scripted check</span><strong class="${candidate.hiddenPass ? "outcome-pass" : "outcome-fail"}">${outcome}</strong></li>
      <li><span>Last behavior</span><strong>${escapeHtml(cell.lastAction)}</strong></li>
      <li><span>Credits left</span><strong>${cell.credits}</strong></li>
      <li><span>Parents</span><strong>${candidate.parentIds.length ? candidate.parentIds.length : "seed"}</strong></li>
    </ul>
    ${candidate.failure ? `<p class="candidate-insight"><strong>Evidence:</strong> ${escapeHtml(candidate.failure)}</p>` : ""}`;
}

function renderChart() {
  const history = state.history;
  const width = 640, height = 210, left = 38, right = 16, top = 18, bottom = 31;
  const max = Math.max(650, ...history.map((point) => point.best));
  const x = (index) => left + (history.length <= 1 ? 0 : index * ((width - left - right) / (history.length - 1)));
  const y = (value) => top + (height - top - bottom) * (1 - value / max);
  const points = (key) => history.map((point, index) => `${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(" ");
  const grids = [0, 200, 400, 600].map((value) => `<g><line class="chart-axis" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"></line><text class="chart-label" x="0" y="${y(value) + 4}">${value}</text></g>`).join("");
  const labels = history.map((point, index) => `<text class="chart-label" x="${x(index)}" y="${height - 8}" text-anchor="middle">g${point.generation}</text>`).join("");
  const dots = (key, name) => history.map((point, index) => `<circle class="chart-dot-${name}" cx="${x(index)}" cy="${y(point[key])}" r="3.5"></circle>`).join("");
  elements.chart.innerHTML = `${grids}<polyline class="chart-line-best" points="${points("best")}"></polyline><polyline class="chart-line-median" points="${points("median")}"></polyline>${dots("best", "best")}${dots("median", "median")}${labels}`;
}

function renderLedger(best) {
  const latest = state.history.at(-1);
  const values = [
    ["Scenario best", best],
    ["Median score", latest?.median ?? 0],
    ["Strategy families", latest?.diversity ?? 0],
    ["Credits spent", state.usage.credits],
    ["Scripted decisions", state.usage.modelTurns],
    ["Scripted checks", state.usage.evaluations],
  ];
  elements.ledger.innerHTML = values.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");
  elements.ledgerStatus.textContent = state.status === "completed" ? "settled" : "live snapshot";
}

function renderComparison() {
  elements.comparison.innerHTML = comparisonRows.map((row) => `<tr${row.condition === state.condition ? " aria-current=\"true\"" : ""}>
    <td>${escapeHtml(row.label)}</td><td>${row.bestScore}</td><td>${escapeHtml(row.winner)}</td><td>${row.credits}</td><td>${row.evaluations}</td><td>${row.rejected}</td>
  </tr>`).join("");
}

function renderEvents() {
  elements.events.innerHTML = state.events.slice(0, 16).map((event) => `<li>
    <code>${escapeHtml(event.type)}</code><p>${escapeHtml(event.summary ?? "Recorded event.")}</p><time>generation ${event.atGeneration}</time>
  </li>`).join("");
}

function renderList(element, values) {
  element.innerHTML = values.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
}

function startAutoplay() {
  autoplay = setInterval(async () => {
    if (state.status === "completed") return stopAutoplay();
    try { await request("/api/step", {}); await refresh(); } catch (error) { stopAutoplay(); throw error; }
  }, 680);
  render();
}

function stopAutoplay() {
  if (autoplay) clearInterval(autoplay);
  autoplay = undefined;
  if (state) render();
}

async function request(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function fetchJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}: ${response.status}`);
  return response.json();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

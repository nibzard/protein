export const TASK = {
  id: "sorted-unique-stream/v1",
  title: "Sorted unique stream",
  prompt:
    "Improve a function that returns sorted unique integers from a large, mostly ordered stream. Preserve negative values, sparse ranges, and stable output.",
  publicChecks: [
    "deduplicates ordinary input",
    "sorts mixed positive values",
    "preserves empty input",
  ],
  hiddenChecks: [
    "preserves negative values",
    "does not allocate by numeric range",
    "keeps 32-bit boundaries",
  ],
};

const STRATEGIES = {
  baseline: {
    label: "Set + sort baseline",
    family: "baseline",
    source: "return [...new Set(values)].sort((a, b) => a - b)",
    insight: "Correct reference implementation; spends memory on the full set.",
    publicPass: true,
    hiddenPass: true,
    throughput: 100,
  },
  stream_scan: {
    label: "Streaming scan",
    family: "scan",
    source: "scan sorted chunks; append only when value !== previous",
    insight: "Exploits the stream's mostly ordered shape without range allocation.",
    publicPass: true,
    hiddenPass: true,
    throughput: 295,
  },
  chunk_merge: {
    label: "Chunk merge",
    family: "merge",
    source: "sort bounded chunks; merge and dedupe at chunk boundaries",
    insight: "Bounds working memory and keeps a predictable merge path.",
    publicPass: true,
    hiddenPass: true,
    throughput: 372,
  },
  adaptive_scan: {
    label: "Adaptive scan",
    family: "scan",
    source: "scan ordered runs; locally sort only disorder windows",
    insight: "Uses a fast path for ordered runs and repairs the occasional disorder window.",
    publicPass: true,
    hiddenPass: true,
    throughput: 481,
  },
  radix_window: {
    label: "Radix window",
    family: "radix",
    source: "radix-sort bounded disorder windows; stream-dedupe output",
    insight: "Combines bounded radix passes with streaming deduplication.",
    publicPass: true,
    hiddenPass: true,
    throughput: 621,
  },
  sparse_bitmap: {
    label: "Sparse bitmap",
    family: "bitmap",
    source: "const seen = new Uint8Array(maxValue + 1)",
    insight: "Looks fast on dense positive data but allocates by range.",
    publicPass: true,
    hiddenPass: false,
    throughput: 510,
    failure: "Hidden sparse-range test exhausted the allowed allocation envelope.",
  },
  cached_tail: {
    label: "Cached tail",
    family: "cache",
    source: "if (value === last) continue; output.push(value)",
    insight: "Fast on one happy path but assumes globally ordered input.",
    publicPass: false,
    hiddenPass: false,
    throughput: 450,
    failure: "Public mixed-order test returned a non-sorted result.",
  },
};

const ARCHETYPES = [
  ["stream_scan", "adaptive_scan"],
  ["sparse_bitmap", "chunk_merge"],
  ["chunk_merge", "adaptive_scan"],
  ["cached_tail", "stream_scan"],
];

const COST = {
  explore: 4,
  improve: 3,
  adopt: 1,
  challenge: 1,
  wait: 0,
};

const DEFAULTS = {
  rows: 4,
  columns: 4,
  generations: 10,
  creditsPerCell: 24,
  seed: 90311,
};

export function createRun(options = {}) {
  const condition = options.condition ?? "local";
  if (!["local", "isolated", "sequential"].includes(condition)) {
    throw new Error(`Unknown swarm condition: ${condition}`);
  }

  const rows = condition === "sequential" ? 1 : options.rows ?? DEFAULTS.rows;
  const columns =
    condition === "sequential" ? 1 : options.columns ?? DEFAULTS.columns;
  const virtualCells = DEFAULTS.rows * DEFAULTS.columns;
  const seed = Number(options.seed ?? DEFAULTS.seed);
  const run = {
    version: 1,
    evidenceLevel: "scripted-simulation",
    id: `swarm-${condition}-${seed}`,
    condition,
    seed,
    task: TASK,
    config: {
      rows,
      columns,
      generations: options.generations ?? DEFAULTS.generations,
      topology: condition === "local" ? "Moore neighborhood" : "none",
      decisionSlots: condition === "sequential" ? virtualCells : 1,
      totalCredits: virtualCells * DEFAULTS.creditsPerCell,
    },
    generation: 0,
    status: "ready",
    rngState: seed >>> 0,
    candidateCounter: 0,
    eventCounter: 0,
    candidates: [],
    cells: [],
    events: [],
    actionReceipts: {},
    settlements: [],
    usage: { credits: 0, modelTurns: 0, evaluations: 0, challenges: 0 },
    history: [],
    createdAt: new Date(0).toISOString(),
  };

  const baseline = createCandidate(run, "baseline", {
    cellId: "seed",
    generation: 0,
    parentIds: [],
    action: "seed",
  });

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const slot = row * columns + column;
      run.cells.push({
        id: `cell-${row}-${column}`,
        row,
        column,
        archetype: slot % ARCHETYPES.length,
        candidateId: baseline.id,
        score: baseline.score,
        credits:
          condition === "sequential"
            ? run.config.totalCredits
            : DEFAULTS.creditsPerCell,
        status: "ready",
        lastAction: "seed",
        lastDetail: "Seeded with the scripted baseline.",
        lineageDepth: 0,
      });
    }
  }

  appendEvent(run, "experiment.ready", {
    summary: `${condition} condition initialized with ${run.cells.length} durable cell${run.cells.length === 1 ? "" : "s"}.`,
  });
  recordHistory(run);
  return run;
}

export function advanceRun(run) {
  if (run.status === "completed") return run;
  run.status = "running";
  const nextGeneration = run.generation + 1;
  const snapshot = snapshotCells(run);
  const decisions = [];

  if (run.condition === "sequential") {
    let working = snapshot[0];
    for (let slot = 0; slot < run.config.decisionSlots; slot += 1) {
      const decision = chooseDecision(run, working, [working], slot);
      const outcome = applyDecision(run, working, decision, nextGeneration);
      decisions.push(outcome.record);
      working = outcome.cell;
    }
    run.cells[0] = working;
  } else {
    for (const cell of snapshot) {
      const neighborhood =
        run.condition === "local" ? neighbors(snapshot, cell, run.config) : [cell];
      const decision = chooseDecision(run, cell, neighborhood, 0);
      decisions.push({ cellId: cell.id, decision, neighborhood });
    }
    const nextCells = [];
    for (const record of decisions) {
      const cell = snapshot.find((item) => item.id === record.cellId);
      nextCells.push(applyDecision(run, cell, record.decision, nextGeneration).cell);
    }
    run.cells = nextCells;
  }

  run.generation = nextGeneration;
  const scores = run.cells.map((cell) => cell.score);
  const best = Math.max(...scores);
  const correct = run.cells.filter((cell) => cell.score > 0).length;
  run.settlements.push({
    generation: nextGeneration,
    bestScore: best,
    correctCells: correct,
    eligibleCells: run.cells.length,
    decisions: decisions.length,
  });
  appendEvent(run, "generation.settled", {
    generation: nextGeneration,
    summary: `Scenario generation ${nextGeneration}: ${correct}/${run.cells.length} cells pass the fixture; best score ${best}.`,
  });
  recordHistory(run);

  if (run.generation >= run.config.generations) {
    run.status = "completed";
    appendEvent(run, "experiment.completed", {
      summary: `Completed ${run.config.generations} scripted generations with scenario score ${best}.`,
    });
  } else {
    run.status = "ready";
  }
  return run;
}

export function runToCompletion(options = {}) {
  const run = createRun(options);
  while (run.status !== "completed") advanceRun(run);
  return run;
}

export function comparison(seed = DEFAULTS.seed) {
  return ["sequential", "isolated", "local"].map((condition) => {
    const run = runToCompletion({ condition, seed });
    const winner = bestCandidate(run);
    return {
      condition,
      label:
        condition === "sequential"
          ? "One sequential agent"
          : condition === "isolated"
            ? "16 isolated agents"
            : "16 local agents",
      bestScore: winner.score,
      winner: winner.strategy.label,
      credits: run.usage.credits,
      modelTurns: run.usage.modelTurns,
      evaluations: run.usage.evaluations,
      rejected: run.candidates.filter((candidate) => !candidate.hiddenPass).length,
    };
  });
}

export function bestCandidate(run) {
  return [...run.candidates].sort((left, right) => right.score - left.score)[0];
}

export function findCandidate(run, id) {
  return run.candidates.find((candidate) => candidate.id === id) ?? null;
}

export function evaluateStrategy(strategyKey) {
  const strategy = STRATEGIES[strategyKey];
  if (!strategy) throw new Error(`Unknown strategy ${strategyKey}`);
  return {
    strategyKey,
    label: strategy.label,
    score: strategy.publicPass && strategy.hiddenPass ? strategy.throughput : 0,
    publicPass: strategy.publicPass,
    hiddenPass: strategy.hiddenPass,
    failure: strategy.failure ?? null,
  };
}

export function validateRun(run) {
  const ids = new Set();
  for (const candidate of run.candidates) {
    if (ids.has(candidate.id)) throw new Error(`Duplicate candidate ${candidate.id}`);
    ids.add(candidate.id);
    if (!STRATEGIES[candidate.strategyKey]) {
      throw new Error(`Unknown candidate strategy ${candidate.strategyKey}`);
    }
    if (candidate.hiddenPass && candidate.score <= 0) {
      throw new Error(`Verified candidate ${candidate.id} has no score`);
    }
    if (!candidate.hiddenPass && candidate.score !== 0) {
      throw new Error(`Rejected candidate ${candidate.id} has a score`);
    }
  }
  for (const cell of run.cells) {
    if (!ids.has(cell.candidateId)) {
      throw new Error(`Cell ${cell.id} references unknown candidate ${cell.candidateId}`);
    }
  }
  return true;
}

function snapshotCells(run) {
  return run.cells.map((cell) => ({ ...cell }));
}

function neighbors(cells, cell, config) {
  return cells.filter((other) => {
    const rowDistance = Math.abs(other.row - cell.row);
    const columnDistance = Math.abs(other.column - cell.column);
    return rowDistance <= 1 && columnDistance <= 1;
  });
}

function chooseDecision(run, cell, neighborhood, slot) {
  const current = findCandidate(run, cell.candidateId);
  const localCandidates = neighborhood
    .map((neighbor) => ({ cell: neighbor, candidate: findCandidate(run, neighbor.candidateId) }))
    .filter((entry) => entry.candidate !== null)
    .sort((left, right) => right.candidate.score - left.candidate.score);
  const localBest = localCandidates[0];
  const roll = random(run);
  const enoughFor = (behavior) => cell.credits >= COST[behavior];

  if (cell.credits < 1) return { behavior: "wait", detail: "Budget exhausted." };

  if (
    run.condition === "local" &&
    localBest.candidate.id !== current.id &&
    localBest.candidate.score > current.score + 85 &&
    enoughFor("adopt") &&
    (roll < 0.48 || current.score === 0)
  ) {
    return {
      behavior: "adopt",
      targetId: localBest.candidate.id,
      detail: `Adopted local evidence from ${localBest.cell.id}.`,
    };
  }

  const failing = localCandidates.find((entry) => !entry.candidate.hiddenPass);
  if (failing && enoughFor("challenge") && roll < 0.22) {
    return {
      behavior: "challenge",
      targetId: failing.candidate.id,
      detail: `Stress-tested ${failing.candidate.strategy.label}.`,
    };
  }

  const neighborhoodStrategies = new Set(
    localCandidates.map((entry) => entry.candidate.strategyKey),
  );
  const canSynthesizeRadix =
    run.condition === "local" &&
    enoughFor("improve") &&
    ((current.strategyKey === "adaptive_scan" && neighborhoodStrategies.has("chunk_merge")) ||
      (current.strategyKey === "chunk_merge" && neighborhoodStrategies.has("adaptive_scan")));
  if (canSynthesizeRadix && roll < 0.82) {
    return {
      behavior: "improve",
      strategyKey: "radix_window",
      detail: "Synthesized a bounded radix window from adjacent scan and merge evidence.",
    };
  }

  const path = ARCHETYPES[(cell.archetype + slot) % ARCHETYPES.length];
  const pathIndex = Math.min(
    path.length - 1,
    Math.floor((run.generation + slot) / 2),
  );
  const proposed = path[pathIndex];

  if (
    current.strategyKey !== proposed &&
    enoughFor(current.score > 0 ? "improve" : "explore") &&
    (roll < 0.74 || current.score === 0)
  ) {
    return {
      behavior: current.score > 0 ? "improve" : "explore",
      strategyKey: proposed,
      detail: `Tried ${STRATEGIES[proposed].label}.`,
    };
  }

  if (enoughFor("explore") && roll < 0.44) {
    const alternate = path[(pathIndex + 1) % path.length];
    return {
      behavior: "explore",
      strategyKey: alternate,
      detail: `Explored ${STRATEGIES[alternate].label}.`,
    };
  }

  return { behavior: "wait", detail: "Kept the current candidate this generation." };
}

function applyDecision(run, cell, decision, generation) {
  const next = { ...cell, status: "waiting", lastAction: decision.behavior, lastDetail: decision.detail };
  const current = findCandidate(run, cell.candidateId);
  const spend = COST[decision.behavior];
  next.credits = Math.max(0, Number((cell.credits - spend).toFixed(2)));
  run.usage.credits = Number((run.usage.credits + spend).toFixed(2));

  if (decision.behavior === "wait") {
    appendEvent(run, "agent.waited", { generation, cellId: cell.id, summary: decision.detail });
    return { cell: next, record: { cellId: cell.id, decision } };
  }

  if (decision.behavior === "challenge") {
    const target = findCandidate(run, decision.targetId);
    run.usage.challenges += 1;
    appendEvent(run, "candidate.challenged", {
      generation,
      cellId: cell.id,
      candidateId: target.id,
      summary: target.hiddenPass
        ? `${cell.id} reproduced the verifier result for ${target.strategy.label}.`
        : `${cell.id} confirmed the hidden failure in ${target.strategy.label}.`,
    });
    return { cell: next, record: { cellId: cell.id, decision } };
  }

  if (decision.behavior === "adopt") {
    const target = findCandidate(run, decision.targetId);
    next.candidateId = target.id;
    next.score = target.score;
    next.lineageDepth = target.parentIds.length;
    appendEvent(run, "candidate.adopted", {
      generation,
      cellId: cell.id,
      candidateId: target.id,
      summary: `${cell.id} adopted ${target.strategy.label} with scenario score ${target.score}.`,
    });
    return { cell: next, record: { cellId: cell.id, decision } };
  }

  const candidate = createCandidate(run, decision.strategyKey, {
    cellId: cell.id,
    generation,
    parentIds: [current.id],
    action: decision.behavior,
  });
  next.candidateId = candidate.id;
  next.score = candidate.score;
  next.lineageDepth = candidate.parentIds.length;
  run.usage.modelTurns += 1;
  run.usage.evaluations += 1;
  appendEvent(run, "candidate.evaluated", {
    generation,
    cellId: cell.id,
    candidateId: candidate.id,
    summary: candidate.hiddenPass
      ? `${cell.id} passed the fixture with ${candidate.strategy.label}: score ${candidate.score}.`
      : `${cell.id} rejected ${candidate.strategy.label}: ${candidate.failure}`,
  });
  return { cell: next, record: { cellId: cell.id, decision } };
}

function createCandidate(run, strategyKey, metadata) {
  const strategy = STRATEGIES[strategyKey];
  if (!strategy) throw new Error(`Unknown strategy ${strategyKey}`);
  run.candidateCounter += 1;
  const candidate = {
    id: `candidate-${strategyKey}-${String(run.candidateCounter).padStart(3, "0")}`,
    strategyKey,
    strategy,
    score: strategy.publicPass && strategy.hiddenPass ? strategy.throughput : 0,
    publicPass: strategy.publicPass,
    hiddenPass: strategy.hiddenPass,
    failure: strategy.failure ?? null,
    cellId: metadata.cellId,
    generation: metadata.generation,
    parentIds: metadata.parentIds,
    action: metadata.action,
    evidence: strategy.publicPass && strategy.hiddenPass ? "verification.pass" : "verification.reject",
  };
  run.candidates.push(candidate);
  return candidate;
}

function appendEvent(run, type, data) {
  run.eventCounter += 1;
  run.events.push({
    id: `event-${String(run.eventCounter).padStart(4, "0")}`,
    type,
    atGeneration: run.generation,
    ...data,
  });
  if (run.events.length > 180) run.events.shift();
}

function recordHistory(run) {
  const scores = run.cells.map((cell) => cell.score);
  run.history.push({
    generation: run.generation,
    best: Math.max(...scores),
    median: median(scores),
    diversity: new Set(run.cells.map((cell) => findCandidate(run, cell.candidateId).strategy.family)).size,
    spent: run.usage.credits,
  });
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

function random(run) {
  let value = (run.rngState += 0x6d2b79f5);
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  run.rngState = value >>> 0;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

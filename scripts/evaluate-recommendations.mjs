import { readFileSync } from "node:fs";

import { evaluateRecommendations } from "../src/recommendation-evaluation.ts";

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.error("Usage: npm run eval -- <readflux-recommendation-export.json> [--since YYYY-MM-DD] [--json]");
  process.exit(1);
}
const sinceIndex = flags.indexOf("--since");
const since = sinceIndex >= 0 ? Date.parse(flags[sinceIndex + 1] ?? "") : undefined;
if (since !== undefined && !Number.isFinite(since)) {
  console.error("--since needs a date such as 2026-10-01.");
  process.exit(1);
}

const data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
if (data.format !== "readflux-recommendation-export") {
  console.error("Not a ReadFlux recommendation export.");
  process.exit(1);
}

const result = evaluateRecommendations({
  timeZone: data.timeZone,
  events: data.events,
  exposures: data.exposures,
  entries: data.entries,
  since,
});

if (flags.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const percent = (value, total) => total ? `${(value / total * 100).toFixed(1)}%` : "-";
const auc = ({ auc: value, pairs }) => value === null ? "-" : `${value.toFixed(3)} (${pairs})`;
const { exposures, coverage, metrics } = result;

console.log(`Algorithm replayed: ${result.algorithmVersion} (export: ${data.algorithmVersion}, ${data.exportedAt})`);
console.log(`Exposures: ${exposures.total} total, ${exposures.afterDeduplication} after de-duplication, ${exposures.withAttributedOpens} with attributed opens, ${exposures.seenTracked} with viewport tracking`);
console.log(`Items evaluated: ${coverage.evaluable}/${coverage.items} (${percent(coverage.evaluable, coverage.items)}) with known feed and publication time; ${percent(coverage.knownText, coverage.evaluable)} with text for term replay`);
console.log("");
console.log("Within-tier pairwise AUC (pairs) — same exposure, status, and publication day");
console.table(Object.fromEntries(Object.entries(metrics).map(([label, metric]) => [label, {
  positives: metric.positives,
  recorded: auc(metric.recorded),
  replayed: auc(metric.replayed),
  "replayed source": auc(metric.replayedSource),
  "replayed term": auc(metric.replayedTerm),
  "recorded term": auc(metric.recordedTerm),
  freshness: auc(metric.freshness),
}])));

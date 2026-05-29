#!/usr/bin/env node
// Generate a compact .digest.json sidecar for a VS Code Copilot Chat export.
// Usage: node digest.mjs <path-to-export.json> [--force] [--stdout]

import fs from "node:fs";
import path from "node:path";

const DIGEST_VERSION = 5;
const CREDITS_PER_USD = 100; // GitHub AI Credits: 1 credit = $0.01 USD (UBB launch 2026-06-01)
const credits = (usd) => Math.round(usd * CREDITS_PER_USD * 10) / 10; // 1 decimal credit

// Monthly AI Credit allowances by plan (reference data, post-2026-06-01).
// Promo: Business gets 3,000, Enterprise gets 7,000 for the first 3 months.
const CREDIT_ALLOWANCES = {
  proMonthly:        { plan: "Copilot Pro",        usdPerMonth: 10, creditsPerMonth: 1000 },
  proPlusMonthly:    { plan: "Copilot Pro+",       usdPerMonth: 39, creditsPerMonth: 3900 },
  businessMonthly:   { plan: "Copilot Business",   usdPerMonth: 19, creditsPerMonth: 1900, promoFirst3Months: 3000 },
  enterpriseMonthly: { plan: "Copilot Enterprise", usdPerMonth: 39, creditsPerMonth: 3900, promoFirst3Months: 7000 },
};

// Embedded model pricing (USD per 1M tokens). Mirrored from
// src/lib/pricing.js so this script stays standalone and zero-dep.
// Keep in sync when upstream rates change. cacheReadRatio/cacheWriteRatio
// override the family default below (Anthropic 0.10 / 1.25).
const PRICING_VERSION = "2026-05";
const PRICING_TABLE = [
  // Anthropic Claude (default cacheRead 0.10, cacheWrite 1.25)
  { match: "claude-opus-4",     input: 15.00, output: 75.00 },
  { match: "claude-sonnet-4",   input:  3.00, output: 15.00 },
  { match: "claude-haiku-4",    input:  1.00, output:  5.00 },
  { match: "claude-3-5-sonnet", input:  3.00, output: 15.00 },
  { match: "claude-3-5-haiku",  input:  0.80, output:  4.00 },
  { match: "claude-3-opus",     input: 15.00, output: 75.00 },
  { match: "claude-3-sonnet",   input:  3.00, output: 15.00 },
  { match: "claude-3-haiku",    input:  0.25, output:  1.25 },
  // OpenAI (cache read 50% of input, cache write = input — no write premium).
  { match: "gpt-5-mini",        input:  0.25, output:  2.00, cacheReadRatio: 0.10, cacheWriteRatio: 1.0 },
  { match: "gpt-4.1",           input:  2.00, output:  8.00, cacheReadRatio: 0.25, cacheWriteRatio: 1.0 },
  { match: "gpt-4o-mini",       input:  0.15, output:  0.60, cacheReadRatio: 0.50, cacheWriteRatio: 1.0 },
  { match: "gpt-4o",            input:  2.50, output: 10.00, cacheReadRatio: 0.50, cacheWriteRatio: 1.0 },
];
const DEFAULT_CACHE_READ_RATIO = 0.10;
const DEFAULT_CACHE_WRITE_RATIO = 1.25;
const FALLBACK_CLAUDE = { input: 3.00, output: 15.00 };

function lookupPricing(modelName) {
  const name = (modelName ?? "").toLowerCase();
  const hit = PRICING_TABLE.find((p) => name.includes(p.match));
  const base = hit ?? (name.includes("claude") ? FALLBACK_CLAUDE : null);
  if (!base) return null;
  const cacheReadRatio = base.cacheReadRatio ?? DEFAULT_CACHE_READ_RATIO;
  const cacheWriteRatio = base.cacheWriteRatio ?? DEFAULT_CACHE_WRITE_RATIO;
  return {
    inputPerM: base.input,
    outputPerM: base.output,
    cacheReadPerM: base.input * cacheReadRatio,
    cacheWritePerM: base.input * cacheWriteRatio,
    matched: hit ? hit.match : "claude-default",
  };
}

// Compute USD cost for a single request given token counts and the model.
// Returns { totalUsd, freshInputUsd, cachedReadUsd, cacheWriteUsd, outputUsd, withoutCacheUsd }.
function computeRequestCost({ model, promptTokens, cachedRead, cacheWrite, completion }) {
  const price = lookupPricing(model);
  if (!price) {
    return {
      totalUsd: 0, freshInputUsd: 0, cachedReadUsd: 0, cacheWriteUsd: 0,
      outputUsd: 0, withoutCacheUsd: 0, priced: false, matched: null,
    };
  }
  const fresh = Math.max(0, (promptTokens ?? 0) - (cachedRead ?? 0) - (cacheWrite ?? 0));
  const freshInputUsd  = (fresh           * price.inputPerM)      / 1_000_000;
  const cachedReadUsd  = ((cachedRead??0) * price.cacheReadPerM)  / 1_000_000;
  const cacheWriteUsd  = ((cacheWrite??0) * price.cacheWritePerM) / 1_000_000;
  const outputUsd      = ((completion??0) * price.outputPerM)     / 1_000_000;
  const totalUsd       = freshInputUsd + cachedReadUsd + cacheWriteUsd + outputUsd;
  const withoutCacheUsd = ((promptTokens ?? 0) * price.inputPerM + (completion ?? 0) * price.outputPerM) / 1_000_000;
  return { totalUsd, freshInputUsd, cachedReadUsd, cacheWriteUsd, outputUsd, withoutCacheUsd, priced: true, matched: price.matched };
}

const round6 = (n) => Math.round(n * 1_000_000) / 1_000_000;

// Rough token estimate from a string. 4 chars/token is the standard
// approximation; accurate to roughly ±20% across English + JSON.
function approxTokens(str) {
  if (!str) return 0;
  return Math.ceil(str.length / 4);
}

// Compact JSON-safe preview of a tool args blob.
function previewArgs(args, max = 240) {
  if (args == null) return null;
  let s = typeof args === "string" ? args : JSON.stringify(args);
  if (s.length > max) s = s.slice(0, max) + "…";
  return s;
}

// Heuristic error detection on a tool-call response payload.
// Returns { hasError, kind, bytes, preview }.
function summarizeToolResponse(resp, max = 240) {
  if (resp == null) {
    return { hasError: false, kind: "null", bytes: 0, preview: null };
  }
  const isString = typeof resp === "string";
  const isArray = Array.isArray(resp);
  const kind = isString ? "string" : isArray ? "array" : typeof resp;
  const flat = isString ? resp : JSON.stringify(resp);
  const bytes = flat.length;
  const preview = flat.length > max ? flat.slice(0, max) + "…" : flat;
  // Conservative error heuristic: explicit error markers near the start.
  const head = (isString ? resp : flat).slice(0, 400);
  const hasError =
    /^\s*(error|failed)[: ]/i.test(head) ||
    /<error[\s>]/i.test(head) ||
    /"error"\s*:/.test(head);
  return { hasError, kind, bytes, preview };
}

// Last assistant message text from a request's response, if any.
function extractAssistantText(resp) {
  if (!resp) return null;
  const msg = resp.message;
  if (Array.isArray(msg)) {
    for (let i = msg.length - 1; i >= 0; i--) {
      if (typeof msg[i] === "string" && msg[i].trim()) return msg[i];
    }
  } else if (typeof msg === "string" && msg.trim()) {
    return msg;
  }
  return null;
}

function truncate(s, max) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const toStdout = args.includes("--stdout");
const input = args.find((a) => !a.startsWith("--"));

if (!input) {
  console.error("usage: digest.mjs <path-to-export.json> [--force] [--stdout]");
  process.exit(2);
}

const srcPath = path.resolve(input);
if (!fs.existsSync(srcPath)) {
  console.error(`not found: ${srcPath}`);
  process.exit(2);
}

const srcStat = fs.statSync(srcPath);
const srcDir = path.dirname(srcPath);
const base = path.basename(srcPath, path.extname(srcPath));
const outDir = path.join(srcDir, ".agentviz");
const outPath = path.join(outDir, `${base}.digest.json`);

// Cache: skip work if digest is newer than source and same version.
if (!force && !toStdout && fs.existsSync(outPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const fresh =
      existing?.session?.digestVersion === DIGEST_VERSION &&
      existing?.session?.sourceMtimeMs === srcStat.mtimeMs;
    if (fresh) {
      console.error(`up to date: ${outPath}`);
      process.exit(0);
    }
  } catch {
    // fall through and regenerate
  }
}

const raw = JSON.parse(fs.readFileSync(srcPath, "utf8"));

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function pushUnique(arr, v) {
  if (v && !arr.includes(v)) arr.push(v);
}

// Extract a probable file path from tool args for common tool names.
function extractPath(toolName, args) {
  if (!args) return null;
  let parsed = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidates = ["filePath", "path", "file", "uri", "absolutePath"];
  for (const k of candidates) {
    if (typeof parsed[k] === "string") return parsed[k];
  }
  return null;
}

const FILE_READ_TOOLS = new Set(["read_file", "get_file_contents"]);
const FILE_WRITE_TOOLS = new Set([
  "create_file",
  "multi_replace_string_in_file",
  "replace_string_in_file",
  "apply_patch",
  "edit",
]);
const FILE_LIST_TOOLS = new Set(["list_dir", "glob", "file_search"]);

const session = {
  digestVersion: DIGEST_VERSION,
  generatedAt: new Date().toISOString(),
  sourceFile: srcPath,
  sourceSizeBytes: srcStat.size,
  sourceMtimeMs: srcStat.mtimeMs,
  exportedAt: raw.exportedAt ?? null,
  totalPromptsClaimed: raw.totalPrompts ?? null,
  totalLogEntriesClaimed: raw.totalLogEntries ?? null,
};

const mcpServers = (raw.mcpServers ?? []).map((m) => ({
  label: m.label ?? null,
  command: m.command ?? null,
  type: m.type ?? null,
  version: m.version ?? null,
}));

const modelStats = new Map();
const toolStats = new Map();
const fileStats = new Map();
const ttftSamples = [];
const durationSamples = [];

const promptsOut = [];
const timeline = [];

let totalRequests = 0;
let totalToolCalls = 0;
let totalToolCallErrors = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalCachedTokens = 0;
let totalCacheCreationTokens = 0;
let totalDurationMs = 0;
let totalToolDefsTokens = 0;
let totalToolDefsFullPriceUsd = 0;
let firstTime = null;
let lastTime = null;

const prompts = Array.isArray(raw.prompts) ? raw.prompts : [];

prompts.forEach((p, pi) => {
  const logs = Array.isArray(p.logs) ? p.logs : [];
  const pSummary = {
    ord: pi,
    ref: `p${pi}`,
    promptId: p.promptId ?? null,
    promptText: typeof p.prompt === "string" ? p.prompt : "",
    promptPreview:
      typeof p.prompt === "string" ? p.prompt.slice(0, 200) : "",
    logCount: logs.length,
    requestCount: 0,
    toolCallCount: 0,
    models: [],
    tools: [],
    filesTouched: [],
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    withoutCacheUsd: 0,
    toolDefsApproxTokens: 0,
    toolErrorCount: 0,
    finalAssistantPreview: null,
    durationMs: 0,
    firstTime: null,
    lastTime: null,
    isSubagent: false,
  };

  logs.forEach((log, li) => {
    const ref = `p${pi}.l${li}`;
    const t = log.time ?? null;
    if (t) {
      if (!pSummary.firstTime || t < pSummary.firstTime) pSummary.firstTime = t;
      if (!pSummary.lastTime || t > pSummary.lastTime) pSummary.lastTime = t;
      if (!firstTime || t < firstTime) firstTime = t;
      if (!lastTime || t > lastTime) lastTime = t;
    }

    if (log.kind === "toolCall") {
      totalToolCalls += 1;
      pSummary.toolCallCount += 1;
      const tool = log.tool ?? "unknown";
      pushUnique(pSummary.tools, tool);
      const ts = toolStats.get(tool) ?? { name: tool, calls: 0, errors: 0, firstRef: ref };
      ts.calls += 1;
      toolStats.set(tool, ts);

      const fp = extractPath(tool, log.args);
      if (fp) {
        pushUnique(pSummary.filesTouched, fp);
        const fs2 = fileStats.get(fp) ?? {
          path: fp,
          reads: 0,
          writes: 0,
          lists: 0,
          firstRef: ref,
        };
        if (FILE_READ_TOOLS.has(tool)) fs2.reads += 1;
        else if (FILE_WRITE_TOOLS.has(tool)) fs2.writes += 1;
        else if (FILE_LIST_TOOLS.has(tool)) fs2.lists += 1;
        fileStats.set(fp, fs2);
      }

      const respSummary = summarizeToolResponse(log.response);
      if (respSummary.hasError) {
        ts.errors += 1;
        totalToolCallErrors += 1;
        pSummary.toolErrorCount += 1;
      }

      timeline.push({
        ref,
        t,
        kind: "toolCall",
        tool,
        toolCallId: log.id ?? null,
        file: fp,
        argsPreview: previewArgs(log.args),
        response: {
          kind: respSummary.kind,
          bytes: respSummary.bytes,
          hasError: respSummary.hasError,
          preview: respSummary.preview,
        },
      });
    } else if (log.kind === "request") {
      totalRequests += 1;
      pSummary.requestCount += 1;
      const md = log.metadata ?? {};
      const usage = md.usage ?? {};
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheWrite = usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
      const pt = usage.prompt_tokens ?? 0;
      const ct = usage.completion_tokens ?? 0;
      totalPromptTokens += pt;
      totalCompletionTokens += ct;
      totalCachedTokens += cached;
      totalCacheCreationTokens += cacheWrite;
      pSummary.promptTokens += pt;
      pSummary.completionTokens += ct;
      pSummary.cachedTokens += cached;

      const dur = md.duration ?? 0;
      totalDurationMs += dur;
      pSummary.durationMs += dur;
      if (typeof md.timeToFirstToken === "number") ttftSamples.push(md.timeToFirstToken);
      if (typeof dur === "number" && dur > 0) durationSamples.push(dur);

      const model = md.model ?? "unknown";
      pushUnique(pSummary.models, model);
      const cost = computeRequestCost({
        model,
        promptTokens: pt,
        cachedRead: cached,
        cacheWrite: cacheWrite,
        completion: ct,
      });
      pSummary.cacheCreationTokens += cacheWrite;
      pSummary.costUsd += cost.totalUsd;
      pSummary.withoutCacheUsd += cost.withoutCacheUsd;

      // Tool-defs accounting: estimate tokens spent re-sending tool schemas.
      const toolsAdvertised = Array.isArray(md.tools) ? md.tools : [];
      const toolsJsonLen = toolsAdvertised.length > 0 ? JSON.stringify(toolsAdvertised).length : 0;
      const toolDefsApproxTokens = Math.ceil(toolsJsonLen / 4);
      const price = lookupPricing(model);
      const toolDefsApproxFullPriceUsd = price
        ? (toolDefsApproxTokens * price.inputPerM) / 1_000_000
        : 0;
      pSummary.toolDefsApproxTokens += toolDefsApproxTokens;
      totalToolDefsTokens += toolDefsApproxTokens;
      totalToolDefsFullPriceUsd += toolDefsApproxFullPriceUsd;

      const ms = modelStats.get(model) ?? {
        name: model,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        durationMs: 0,
        costUsd: 0,
        freshInputUsd: 0,
        cachedReadUsd: 0,
        cacheWriteUsd: 0,
        outputUsd: 0,
        withoutCacheUsd: 0,
        toolDefsApproxTokens: 0,
        toolDefsApproxFullPriceUsd: 0,
        priced: cost.priced,
        priceMatch: cost.matched,
      };
      ms.calls += 1;
      ms.promptTokens += pt;
      ms.completionTokens += ct;
      ms.cachedTokens += cached;
      ms.cacheCreationTokens += cacheWrite;
      ms.durationMs += dur;
      ms.costUsd += cost.totalUsd;
      ms.freshInputUsd += cost.freshInputUsd;
      ms.cachedReadUsd += cost.cachedReadUsd;
      ms.cacheWriteUsd += cost.cacheWriteUsd;
      ms.outputUsd += cost.outputUsd;
      ms.withoutCacheUsd += cost.withoutCacheUsd;
      ms.toolDefsApproxTokens += toolDefsApproxTokens;
      ms.toolDefsApproxFullPriceUsd += toolDefsApproxFullPriceUsd;
      modelStats.set(model, ms);

      if (log.name === "tool/runSubagent") {
        pSummary.isSubagent = true;
      }

      const messages = log.requestMessages?.messages;
      const messageCount = Array.isArray(messages) ? messages.length : 0;
      const toolCallsInResp = Array.isArray(messages)
        ? messages.reduce((n, m) => n + (Array.isArray(m.toolCalls) ? m.toolCalls.length : 0), 0)
        : 0;

      const assistantText = extractAssistantText(log.response);
      if (assistantText) {
        pSummary.finalAssistantPreview = truncate(assistantText, 800);
      }

      const freshInputTokens = Math.max(0, pt - cached - cacheWrite);
      const cacheHitRate = pt > 0 ? cached / pt : 0;

      timeline.push({
        ref,
        t,
        kind: "request",
        requestType: log.type ?? null,
        name: log.name ?? null,
        model,
        ms: dur,
        ttftMs: md.timeToFirstToken ?? null,
        promptTokens: pt,
        completionTokens: ct,
        cachedTokens: cached,
        cacheCreationTokens: cacheWrite,
        freshInputTokens,
        cacheHitRate: Math.round(cacheHitRate * 1000) / 1000,
        costUsd: round6(cost.totalUsd),
        credits: credits(cost.totalUsd),
        freshInputUsd: round6(cost.freshInputUsd),
        cachedReadUsd: round6(cost.cachedReadUsd),
        cacheWriteUsd: round6(cost.cacheWriteUsd),
        outputUsd: round6(cost.outputUsd),
        withoutCacheUsd: round6(cost.withoutCacheUsd),
        creditsWithoutCache: credits(cost.withoutCacheUsd),
        cacheSavingsUsd: round6(cost.withoutCacheUsd - cost.totalUsd),
        cacheSavingsCredits: credits(cost.withoutCacheUsd - cost.totalUsd),
        messageCount,
        toolCallsAdvertised: toolCallsInResp,
        toolDefsCount: toolsAdvertised.length,
        toolDefsJsonBytes: toolsJsonLen,
        toolDefsApproxTokens,
        toolDefsApproxFullPriceUsd: round6(toolDefsApproxFullPriceUsd),
        toolDefsApproxFullPriceCredits: credits(toolDefsApproxFullPriceUsd),
        assistantTextPreview: assistantText ? truncate(assistantText, 240) : null,
      });
    }
  });

  promptsOut.push(pSummary);
});

ttftSamples.sort((a, b) => a - b);
durationSamples.sort((a, b) => a - b);

const wallSpanMs =
  firstTime && lastTime ? new Date(lastTime).getTime() - new Date(firstTime).getTime() : 0;

const cacheHitRate =
  totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0;

const modelsArr = [...modelStats.values()]
  .sort((a, b) => b.calls - a.calls)
  .map((m) => ({
    ...m,
    costUsd: round6(m.costUsd),
    freshInputUsd: round6(m.freshInputUsd),
    cachedReadUsd: round6(m.cachedReadUsd),
    cacheWriteUsd: round6(m.cacheWriteUsd),
    outputUsd: round6(m.outputUsd),
    withoutCacheUsd: round6(m.withoutCacheUsd),
    savingsUsd: round6(m.withoutCacheUsd - m.costUsd),
    savingsRatio: m.withoutCacheUsd > 0 ? round6((m.withoutCacheUsd - m.costUsd) / m.withoutCacheUsd) : 0,
  }));
const toolsArr = [...toolStats.values()].sort((a, b) => b.calls - a.calls);
const filesArr = [...fileStats.values()].sort(
  (a, b) => b.reads + b.writes + b.lists - (a.reads + a.writes + a.lists)
);

const totalCostUsd = modelsArr.reduce((s, m) => s + m.costUsd, 0);
const totalWithoutCacheUsd = modelsArr.reduce((s, m) => s + m.withoutCacheUsd, 0);
const totalSavingsUsd = totalWithoutCacheUsd - totalCostUsd;
const allPriced = modelsArr.every((m) => m.priced !== false);

for (const p of promptsOut) {
  p.costUsd = round6(p.costUsd);
  p.withoutCacheUsd = round6(p.withoutCacheUsd);
  p.savingsUsd = round6(p.withoutCacheUsd - p.costUsd);
  p.hadError = p.toolErrorCount > 0;
  p.credits = credits(p.costUsd);
  p.creditsWithoutCache = credits(p.withoutCacheUsd);
}

// Resolved pricing block: which embedded rates were used for each model
// present in this session, plus the full table for hypotheticals.
const pricingResolved = modelsArr.map((m) => {
  const p = lookupPricing(m.name);
  return p
    ? {
        model: m.name,
        matched: true,
        inputPerM: p.inputPerM,
        outputPerM: p.outputPerM,
        cacheReadPerM: p.cacheReadPerM ?? round6(p.inputPerM * (p.cacheReadRatio ?? 0.1)),
        cacheWritePerM: p.cacheWritePerM ?? round6(p.inputPerM * (p.cacheWriteRatio ?? 1.25)),
      }
    : { model: m.name, matched: false };
});

const digest = {
  session,
  rollups: {
    prompts: prompts.length,
    requests: totalRequests,
    toolCalls: totalToolCalls,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    cachedTokens: totalCachedTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    cacheHitRate: Number(cacheHitRate.toFixed(4)),
    primaryModel: modelsArr[0]?.name ?? null,
    modelCount: modelsArr.length,
    toolCount: toolsArr.length,
    fileCount: filesArr.length,
    totalRequestDurationMs: totalDurationMs,
    wallSpanMs,
    firstTime,
    lastTime,
    ttftMs: {
      p50: percentile(ttftSamples, 50),
      p95: percentile(ttftSamples, 95),
      max: ttftSamples[ttftSamples.length - 1] ?? 0,
    },
    requestDurationMs: {
      p50: percentile(durationSamples, 50),
      p95: percentile(durationSamples, 95),
      max: durationSamples[durationSamples.length - 1] ?? 0,
    },
    cost: {
      totalUsd: round6(totalCostUsd),
      withoutCacheUsd: round6(totalWithoutCacheUsd),
      savingsUsd: round6(totalSavingsUsd),
      savingsRatio: totalWithoutCacheUsd > 0 ? round6(totalSavingsUsd / totalWithoutCacheUsd) : 0,
      pricingVersion: PRICING_VERSION,
      currency: "USD",
      allModelsPriced: allPriced,
      // GitHub AI Credits (UBB launched 2026-06-01). 1 credit = $0.01 USD.
      // These are derived from the USD numbers above; presented in credits so
      // answers match how GitHub bills under UBB.
      credits: {
        total: credits(totalCostUsd),
        withoutCache: credits(totalWithoutCacheUsd),
        savings: credits(totalSavingsUsd),
        perUsd: CREDITS_PER_USD,
        billingModel: "github-ai-credits-ubb-2026-06-01",
      },
    },
    toolDefs: {
      approxTokensTotal: totalToolDefsTokens,
      approxShareOfPromptTokens:
        totalPromptTokens > 0
          ? Math.round((totalToolDefsTokens / totalPromptTokens) * 10000) / 10000
          : 0,
      approxFullPriceUsd: round6(totalToolDefsFullPriceUsd),
      note:
        "Worst-case (all fresh) tokens for re-sending tool schemas. Actual paid cost depends on cache hits.",
    },
    errors: {
      toolCallErrors: totalToolCallErrors,
      promptsWithErrors: promptsOut.filter((p) => p.hadError).length,
    },
  },
  pricing: {
    version: PRICING_VERSION,
    currency: "USD",
    creditsPerUsd: CREDITS_PER_USD,
    billingModel: "github-ai-credits-ubb-2026-06-01",
    monthlyAllowances: CREDIT_ALLOWANCES,
    resolved: pricingResolved,
    table: PRICING_TABLE.map((row) => ({
      match: row.match,
      inputPerM: row.input,
      outputPerM: row.output,
      cacheReadRatio: row.cacheReadRatio ?? 0.1,
      cacheWriteRatio: row.cacheWriteRatio ?? 1.25,
    })),
  },
  models: modelsArr,
  tools: toolsArr,
  files: filesArr,
  mcpServers,
  prompts: promptsOut,
  timeline,
};

if (toStdout) {
  process.stdout.write(JSON.stringify(digest, null, 2));
} else {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(digest, null, 2));
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.error(`wrote ${outPath} (${kb} KB)`);
}

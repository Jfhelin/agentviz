#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRICING_LAST_VERIFIED,
  estimateCost,
  getModelPrice,
  hasModelPricing,
} from "../../../../src/lib/pricing.js";

export const DIGEST_VERSION = 8;

const CACHE_MISS_MIN_PRIOR_TOKENS = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CREDITS_PER_USD = 100;

const round6 = (value) => Math.round(value * 1_000_000) / 1_000_000;
const approxTokens = (value) => value ? Math.ceil(value.length / 4) : 0;
const approxTokensFromChars = (chars) => chars > 0 ? Math.ceil(chars / 4) : 0;
const credits = (usd) => Math.round(usd * CREDITS_PER_USD * 10) / 10;

function stringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function truncate(value, length = 240) {
  if (!value || value.length <= length) return value || null;
  return `${value.slice(0, length)}...`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function usageFrom(log) {
  const usage = log?.metadata?.usage ?? {};
  const promptDetails = usage.prompt_tokens_details ?? {};
  const completionDetails = usage.completion_tokens_details ?? {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const cachedTokens = promptDetails.cached_tokens ?? 0;
  const cacheWriteTokens =
    usage.cache_creation_input_tokens ??
    promptDetails.cache_creation_input_tokens ??
    0;
  return {
    promptTokens,
    completionTokens: usage.completion_tokens ?? 0,
    cachedTokens,
    cacheWriteTokens,
    freshTokens: Math.max(0, promptTokens - cachedTokens - cacheWriteTokens),
    reasoningTokens: completionDetails.reasoning_tokens ?? 0,
  };
}

function costForUsage(model, usage) {
  const tokenUsage = {
    inputTokens: usage.freshTokens,
    outputTokens: usage.completionTokens,
    cacheRead: usage.cachedTokens,
    cacheWrite: usage.cacheWriteTokens,
  };
  const totalUsd = estimateCost(tokenUsage, model);
  const withoutCacheUsd = estimateCost({
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
  }, model);
  const price = getModelPrice(model, tokenUsage);
  if (!price) {
    return {
      priced: false,
      totalUsd: 0,
      withoutCacheUsd: 0,
      savingsUsd: 0,
      freshInputUsd: 0,
      cachedReadUsd: 0,
      cacheWriteUsd: 0,
      outputUsd: 0,
    };
  }
  const cacheReadRatio = price.cacheReadRatio ?? 0.1;
  const cacheWriteRatio = price.cacheWriteRatio ?? 1.25;
  return {
    priced: true,
    totalUsd: round6(totalUsd),
    withoutCacheUsd: round6(withoutCacheUsd),
    savingsUsd: round6(withoutCacheUsd - totalUsd),
    freshInputUsd: round6(usage.freshTokens * price.input / 1_000_000),
    cachedReadUsd: round6(usage.cachedTokens * price.input * cacheReadRatio / 1_000_000),
    cacheWriteUsd: round6(usage.cacheWriteTokens * price.input * cacheWriteRatio / 1_000_000),
    outputUsd: round6(usage.completionTokens * price.output / 1_000_000),
  };
}

function collectVisibleText(response) {
  if (!response) return "";
  if (typeof response === "string") return response;
  const message = response.message;
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message.filter((part) => typeof part === "string").join("\n");
}

function collectThinking(value, output, seen = new Set()) {
  if (value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectThinking(item, output, seen);
    return output;
  }
  if (typeof value !== "object") return output;
  if (value.type === "thinking" && value.thinking && typeof value.thinking === "object") {
    const thinking = value.thinking;
    const text = typeof thinking.text === "string" ? thinking.text : "";
    const key = thinking.id || text;
    if (text && !seen.has(key)) {
      seen.add(key);
      output.push(text);
    }
  }
  for (const child of Object.values(value)) collectThinking(child, output, seen);
  return output;
}

function proportionalAllocation(budget, entries) {
  const total = entries.reduce((sum, entry) => sum + entry.raw, 0);
  if (total <= budget) {
    return {
      values: Object.fromEntries(entries.map((entry) => [entry.key, entry.raw])),
      residual: budget - total,
    };
  }
  const shares = entries.map((entry, index) => {
    const exact = budget * entry.raw / total;
    return { ...entry, index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = budget - shares.reduce((sum, share) => sum + share.value, 0);
  shares.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < shares.length && remaining > 0; index++, remaining--) {
    shares[index].value += 1;
  }
  return {
    values: Object.fromEntries(shares.map((share) => [share.key, share.value])),
    residual: 0,
  };
}

export function reconcileOutputAttribution(
  measuredCompletionTokens,
  rawApprox,
  measuredReasoningTokens = 0,
) {
  const measured = Math.max(0, Math.trunc(measuredCompletionTokens || 0));
  const keys = ["visible", "reasoning", "toolArguments"];
  const raw = Object.fromEntries(keys.map((key) => [key, Math.max(0, Math.trunc(rawApprox[key] || 0))]));
  const fixedReasoning = Math.min(measured, Math.max(0, Math.trunc(measuredReasoningTokens || 0)));

  if (fixedReasoning > 0) {
    const allocation = proportionalAllocation(measured - fixedReasoning, [
      { key: "visible", raw: raw.visible },
      { key: "toolArguments", raw: raw.toolArguments },
    ]);
    return {
      visible: allocation.values.visible,
      reasoning: fixedReasoning,
      toolArguments: allocation.values.toolArguments,
      unattributedResidual: allocation.residual,
    };
  }

  const allocation = proportionalAllocation(measured, keys.map((key) => ({ key, raw: raw[key] })));
  return {
    ...allocation.values,
    unattributedResidual: allocation.residual,
  };
}

function outputAttribution(log, followingTools) {
  const usage = usageFrom(log);
  const visibleText = collectVisibleText(log.response);
  const thinkingTexts = collectThinking(log.response, []);
  const seenThinking = new Set(thinkingTexts);
  let toolArgumentChars = 0;
  for (const tool of followingTools) {
    toolArgumentChars += stringify(tool.args).length;
    const text = typeof tool.thinking?.text === "string" ? tool.thinking.text : "";
    if (text && !seenThinking.has(text)) {
      seenThinking.add(text);
      thinkingTexts.push(text);
    }
  }

  const rawApprox = {
    visible: approxTokens(visibleText),
    reasoning: usage.reasoningTokens || approxTokens(thinkingTexts.join("\n")),
    toolArguments: approxTokensFromChars(toolArgumentChars),
  };
  const reconciled = reconcileOutputAttribution(
    usage.completionTokens,
    rawApprox,
    usage.reasoningTokens,
  );
  const reconciledTotal = Object.values(reconciled).reduce((sum, value) => sum + value, 0);
  return {
    measuredCompletionTokens: usage.completionTokens,
    rawApprox,
    reconciled,
    exactTotalMatches: reconciledTotal === usage.completionTokens,
    reasoningSource: usage.reasoningTokens > 0
      ? "completion_tokens_details.reasoning_tokens"
      : (thinkingTexts.length > 0 ? "thinking-text-chars/4" : "none"),
    note:
      "Reconciled categories sum exactly to measured completion_tokens. Visible text and tool arguments are character estimates; reasoning uses measured detail when present, otherwise thinking-text chars/4. Estimates are proportionally scaled only when they exceed the measured total.",
  };
}

function summarizeToolResponse(response) {
  const text = stringify(response);
  const head = text.slice(0, 400);
  return {
    bytes: text.length,
    hasError:
      /^\s*(error|failed)[: ]/i.test(head) ||
      /<error[\s>]/i.test(head) ||
      /"error"\s*:/.test(head),
    preview: truncate(text),
  };
}

function toolPath(args) {
  const parsed = parseObject(args);
  if (!parsed) return null;
  for (const key of [
    "filePath",
    "file_path",
    "filepath",
    "target_file",
    "path",
    "file",
    "uri",
    "absolutePath",
  ]) {
    if (typeof parsed[key] === "string") return parsed[key];
  }
  return null;
}

function diffTools(previous, current) {
  const previousMap = new Map(previous.map((tool) => [tool.name, stableJson(tool)]));
  const currentMap = new Map(current.map((tool) => [tool.name, stableJson(tool)]));
  const changed = [...previousMap].filter(([name, json]) =>
    currentMap.has(name) && currentMap.get(name) !== json).map(([name]) => name).sort();
  const added = [...currentMap.keys()].filter((name) => !previousMap.has(name)).sort();
  const removed = [...previousMap.keys()].filter((name) => !currentMap.has(name)).sort();
  return {
    changed,
    added,
    removed,
    likelyTtlExpiry: changed.length === 0 && added.length === 0 && removed.length === 0,
  };
}

function timestampMs(log) {
  const value = log.time ?? log.metadata?.startTime ?? null;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function supplementalSubagent(tool, ref) {
  if (tool.tool !== "runSubagent") return null;
  const args = parseObject(tool.args) ?? {};
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const response = stringify(tool.response);
  const model = tool.toolMetadata?.modelName ?? null;
  const promptTokensEst = approxTokens(prompt);
  const outputTokensEst = approxTokens(response);
  const estimatedCostUsd = model && hasModelPricing(model)
    ? estimateCost({ inputTokens: promptTokensEst, outputTokens: outputTokensEst }, model)
    : null;
  return {
    ref,
    description: typeof args.description === "string" ? args.description : null,
    prompt,
    promptTokensEst,
    outputTokensEst,
    model,
    estimatedCostUsd: estimatedCostUsd == null ? null : round6(estimatedCostUsd),
    measuredChildRef: null,
    accounting: "supplemental-estimate-excluded-from-headline",
  };
}

function normalizePrompt(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function addUsage(target, usage) {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.cachedTokens += usage.cachedTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.freshTokens += usage.freshTokens;
}

function emptyUsage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    freshTokens: 0,
  };
}

function addAttribution(target, attribution) {
  for (const key of ["visible", "reasoning", "toolArguments"]) {
    target.rawApprox[key] += attribution.rawApprox[key];
    target.reconciled[key] += attribution.reconciled[key];
  }
  target.reconciled.unattributedResidual += attribution.reconciled.unattributedResidual;
}

function emptyAttribution() {
  return {
    measuredCompletionTokens: 0,
    rawApprox: { visible: 0, reasoning: 0, toolArguments: 0 },
    reconciled: { visible: 0, reasoning: 0, toolArguments: 0, unattributedResidual: 0 },
  };
}

export function buildDigest(raw, source = {}) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.prompts)) {
    throw new Error("Not a VS Code Copilot Chat export: expected a top-level prompts array.");
  }

  const measuredUsage = emptyUsage();
  const attributionTotal = emptyAttribution();
  const modelMap = new Map();
  const toolMap = new Map();
  const fileMap = new Map();
  const requests = [];
  const tools = [];
  const prompts = [];
  const supplementalCalls = [];
  const unexpectedMisses = [];
  let totalCostUsd = 0;
  let totalWithoutCacheUsd = 0;
  let unpricedRequests = 0;
  let previousModel = null;
  const previousByModel = new Map();

  raw.prompts.forEach((prompt, promptIndex) => {
    const promptRef = `p${promptIndex}`;
    const logs = Array.isArray(prompt.logs) ? prompt.logs : [];
    const promptUsage = emptyUsage();
    const promptAttribution = emptyAttribution();
    const promptRequests = [];
    const promptTools = [];
    const isSubagent = logs.some((log) => log.kind === "request" && log.name === "tool/runSubagent");

    for (let logIndex = 0; logIndex < logs.length; logIndex++) {
      const log = logs[logIndex];
      const ref = `${promptRef}.l${logIndex}`;
      if (log.kind === "toolCall") {
        const response = summarizeToolResponse(log.response);
        const row = {
          ref,
          kind: "toolCall",
          tool: log.tool ?? "unknown",
          toolCallId: log.id ?? null,
          file: toolPath(log.args),
          argsPreview: truncate(stringify(log.args)),
          response,
        };
        tools.push(row);
        promptTools.push(row);
        const stats = toolMap.get(row.tool) ?? { name: row.tool, calls: 0, errors: 0 };
        stats.calls += 1;
        if (response.hasError) stats.errors += 1;
        toolMap.set(row.tool, stats);
        if (row.file) {
          const file = fileMap.get(row.file) ?? { path: row.file, calls: 0 };
          file.calls += 1;
          fileMap.set(row.file, file);
        }
        const supplemental = supplementalSubagent(log, ref);
        if (supplemental) supplementalCalls.push(supplemental);
        continue;
      }
      if (log.kind !== "request") continue;

      const followingTools = [];
      for (let nextIndex = logIndex + 1; nextIndex < logs.length; nextIndex++) {
        if (logs[nextIndex].kind === "request") break;
        if (logs[nextIndex].kind === "toolCall") followingTools.push(logs[nextIndex]);
      }
      const usage = usageFrom(log);
      const model = log.metadata?.model ?? "unknown";
      const callAttribution = outputAttribution(log, followingTools);
      const cost = costForUsage(model, usage);
      const currentTools = Array.isArray(log.metadata?.tools) ? log.metadata.tools : [];
      const prior = previousByModel.get(model);
      const modelSwitched = previousModel != null && previousModel !== model;
      let cacheMiss = null;
      if (
        prior &&
        !modelSwitched &&
        usage.cachedTokens === 0 &&
        prior.usage.promptTokens > CACHE_MISS_MIN_PRIOR_TOKENS
      ) {
        const toolDiff = diffTools(prior.tools, currentTools);
        const currentTime = timestampMs(log);
        const timeGapMs = currentTime != null && prior.timeMs != null
          ? currentTime - prior.timeMs
          : null;
        cacheMiss = {
          ref,
          model,
          priorPromptTokens: prior.usage.promptTokens,
          promptTokens: usage.promptTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          timeGapMs,
          cause: toolDiff.changed.length || toolDiff.added.length || toolDiff.removed.length
            ? "tool-definitions-changed"
            : (timeGapMs != null && timeGapMs >= CACHE_TTL_MS ? "possible-ttl-expiry" : "stable-prefix-or-unknown"),
          toolDiff,
        };
        unexpectedMisses.push(cacheMiss);
      }

      const row = {
        ref,
        kind: "request",
        name: log.name ?? null,
        category: log.name === "title" || log.name === "promptCategorization"
          ? "overhead"
          : "primary",
        model,
        durationMs: log.metadata?.duration ?? 0,
        usage,
        costEstimate: cost,
        outputAttribution: callAttribution,
        cache: {
          hitRate: usage.promptTokens > 0 ? usage.cachedTokens / usage.promptTokens : 0,
          namespace: model,
          modelSwitched,
          unexpectedMiss: cacheMiss,
        },
        assistantTextPreview: truncate(collectVisibleText(log.response)),
      };
      requests.push(row);
      promptRequests.push(row);
      addUsage(measuredUsage, usage);
      addUsage(promptUsage, usage);
      attributionTotal.measuredCompletionTokens += usage.completionTokens;
      promptAttribution.measuredCompletionTokens += usage.completionTokens;
      addAttribution(attributionTotal, callAttribution);
      addAttribution(promptAttribution, callAttribution);
      totalCostUsd += cost.totalUsd;
      totalWithoutCacheUsd += cost.withoutCacheUsd;
      if (!cost.priced) unpricedRequests += 1;

      const modelStats = modelMap.get(model) ?? {
        name: model,
        requests: 0,
        usage: emptyUsage(),
        costUsd: 0,
        priced: cost.priced,
      };
      modelStats.requests += 1;
      addUsage(modelStats.usage, usage);
      modelStats.costUsd += cost.totalUsd;
      modelStats.priced = modelStats.priced && cost.priced;
      modelMap.set(model, modelStats);
      previousByModel.set(model, { usage, tools: currentTools, timeMs: timestampMs(log) });
      previousModel = model;
    }

    prompts.push({
      ref: promptRef,
      promptId: prompt.promptId ?? null,
      promptText: typeof prompt.prompt === "string" ? prompt.prompt : "",
      promptPreview: truncate(typeof prompt.prompt === "string" ? prompt.prompt : "", 200),
      isSubagent,
      spawnedBy: null,
      spawnedSubagents: [],
      measuredUsage: promptUsage,
      outputAttribution: promptAttribution,
      requestRefs: promptRequests.map((request) => request.ref),
      toolCallRefs: promptTools.map((tool) => tool.ref),
    });
  });

  const childCandidates = prompts.filter((prompt) => prompt.isSubagent);
  const usedChildren = new Set();
  for (const supplemental of supplementalCalls) {
    const target = normalizePrompt(supplemental.prompt);
    const child = childCandidates.find((candidate) =>
      !usedChildren.has(candidate.ref) && normalizePrompt(candidate.promptText) === target);
    const parent = prompts.find((prompt) => supplemental.ref.startsWith(`${prompt.ref}.l`));
    if (child) {
      usedChildren.add(child.ref);
      child.spawnedBy = supplemental.ref;
      supplemental.measuredChildRef = child.ref;
    }
    if (parent) {
      parent.spawnedSubagents.push({
        toolCallRef: supplemental.ref,
        subagentRef: child?.ref ?? null,
        description: supplemental.description,
      });
    }
    delete supplemental.prompt;
  }

  const attributionSum = Object.values(attributionTotal.reconciled)
    .reduce((sum, value) => sum + value, 0);
  const cacheDenominator = measuredUsage.promptTokens;
  const supplementalCostUsd = supplementalCalls.reduce(
    (sum, call) => sum + (call.estimatedCostUsd ?? 0),
    0,
  );

  return {
    session: {
      digestVersion: DIGEST_VERSION,
      generatedAt: new Date().toISOString(),
      sourceFile: source.sourceFile ? path.basename(source.sourceFile) : null,
      sourceSizeBytes: source.sourceSizeBytes ?? null,
      sourceMtimeMs: source.sourceMtimeMs ?? null,
      exportedAt: raw.exportedAt ?? null,
      totalPromptsClaimed: raw.totalPrompts ?? null,
      totalLogEntriesClaimed: raw.totalLogEntries ?? null,
    },
    measurementPolicy: {
      headline: "metadata.usage request totals measured by the export",
      estimates:
        "Rate-card costs, output category attribution, tool-definition size, and parent runSubagent projections are estimates.",
      noDoubleCounting:
        "Supplemental runSubagent projections are excluded from measured usage and headline cost. Matched child request usage is already included exactly once.",
    },
    rollups: {
      prompts: prompts.length,
      requests: requests.length,
      toolCalls: tools.length,
      measuredUsage: {
        ...measuredUsage,
        totalTokens: measuredUsage.promptTokens + measuredUsage.completionTokens,
      },
      cache: {
        hitRate: cacheDenominator > 0 ? measuredUsage.cachedTokens / cacheDenominator : 0,
        namespace: "per-model",
        unexpectedMissCount: unexpectedMisses.length,
        unexpectedMisses,
      },
      estimatedCost: {
        usd: round6(totalCostUsd),
        aiCredits: credits(totalCostUsd),
        withoutCacheUsd: round6(totalWithoutCacheUsd),
        savingsUsd: round6(totalWithoutCacheUsd - totalCostUsd),
        allModelsPriced: unpricedRequests === 0,
        unpricedRequests,
        pricingSource: "src/lib/pricing.js",
        pricingLastVerified: PRICING_LAST_VERIFIED,
      },
      outputAttribution: {
        ...attributionTotal,
        exactTotalMatches: attributionSum === measuredUsage.completionTokens,
        note:
          "The reconciled visible + reasoning + toolArguments + unattributedResidual fields sum exactly to measured completionTokens. Raw approximations remain available for audit.",
      },
      supplemental: {
        runSubagent: {
          calls: supplementalCalls,
          promptTokensEst: supplementalCalls.reduce((sum, call) => sum + call.promptTokensEst, 0),
          outputTokensEst: supplementalCalls.reduce((sum, call) => sum + call.outputTokensEst, 0),
          estimatedCostUsd: round6(supplementalCostUsd),
          excludedFromHeadline: true,
        },
      },
      threads: {
        rootPrompts: prompts.filter((prompt) => !prompt.isSubagent).length,
        subagentPrompts: prompts.filter((prompt) => prompt.isSubagent).length,
        linkedSubagents: prompts.filter((prompt) => prompt.spawnedBy).length,
        unresolvedRunSubagentCalls: supplementalCalls.filter((call) => !call.measuredChildRef).length,
      },
      errors: {
        toolCallErrors: tools.filter((tool) => tool.response.hasError).length,
      },
    },
    models: [...modelMap.values()]
      .map((model) => ({ ...model, costUsd: round6(model.costUsd) }))
      .sort((a, b) => b.requests - a.requests),
    tools: [...toolMap.values()].sort((a, b) => b.calls - a.calls),
    files: [...fileMap.values()].sort((a, b) => b.calls - a.calls),
    mcpServers: Array.isArray(raw.mcpServers)
      ? raw.mcpServers.map((server) => ({
          label: server?.label ?? null,
          command: server?.command ?? null,
          type: server?.type ?? null,
          version: server?.version ?? null,
        }))
      : [],
    prompts,
    timeline: [...requests, ...tools].sort((a, b) => {
      const parseRef = (ref) => ref.match(/\d+/g).map(Number);
      const [ap, al] = parseRef(a.ref);
      const [bp, bl] = parseRef(b.ref);
      return ap - bp || al - bl;
    }),
  };
}

export function digestFile(inputPath, { force = false, stdout = false } = {}) {
  const sourcePath = path.resolve(inputPath);
  if (!fs.existsSync(sourcePath)) throw new Error(`Export not found: ${sourcePath}`);
  const sourceStat = fs.statSync(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`Export is not a file: ${sourcePath}`);
  const outputDirectory = path.join(path.dirname(sourcePath), ".agentviz");
  const outputPath = path.join(
    outputDirectory,
    `${path.basename(sourcePath, path.extname(sourcePath))}.digest.json`,
  );

  if (!force && !stdout && fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (
      existing?.session?.digestVersion === DIGEST_VERSION &&
      existing?.session?.sourceMtimeMs === sourceStat.mtimeMs &&
      existing?.rollups?.estimatedCost?.pricingLastVerified === PRICING_LAST_VERIFIED
    ) {
      return { outputPath, cached: true, digest: existing };
    }
  }

  const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const digest = buildDigest(raw, {
    sourceFile: sourcePath,
    sourceSizeBytes: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
  });
  if (stdout) {
    process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
  } else {
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(digest, null, 2)}\n`);
  }
  return { outputPath, cached: false, digest };
}

function main(argv) {
  const force = argv.includes("--force");
  const stdout = argv.includes("--stdout");
  const input = argv.find((arg) => !arg.startsWith("--"));
  if (!input) {
    console.error("usage: digest.mjs <path-to-copilot-export.json> [--force] [--stdout]");
    return 2;
  }
  try {
    const result = digestFile(input, { force, stdout });
    if (!stdout) console.error(`${result.cached ? "up to date" : "wrote"}: ${result.outputPath}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

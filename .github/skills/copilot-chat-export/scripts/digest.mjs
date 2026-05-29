#!/usr/bin/env node
// Generate a compact .digest.json sidecar for a VS Code Copilot Chat export.
// Usage: node digest.mjs <path-to-export.json> [--force] [--stdout]

import fs from "node:fs";
import path from "node:path";

const DIGEST_VERSION = 7;
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

// Walk an arbitrary JSON value and collect all Anthropic extended-thinking blocks.
// Shape: { type: "thinking", thinking: { id, text, encrypted, tokens } }.
// The `tokens` field is always 0 in Copilot Chat exports (the proxy drops it),
// which is why we measure plaintext/encrypted bytes ourselves.
function collectThinkingBlocks(value, acc) {
  if (value == null) return acc;
  if (Array.isArray(value)) {
    for (const v of value) collectThinkingBlocks(v, acc);
    return acc;
  }
  if (typeof value !== "object") return acc;
  if (value.type === "thinking" && value.thinking && typeof value.thinking === "object") {
    acc.push({
      id: value.thinking.id ?? null,
      text: typeof value.thinking.text === "string" ? value.thinking.text : "",
      encrypted: typeof value.thinking.encrypted === "string" ? value.thinking.encrypted : "",
    });
  }
  for (const k of Object.keys(value)) collectThinkingBlocks(value[k], acc);
  return acc;
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
let totalToolArgsChars = 0;          // sum of toolCall.args char lengths (output-side tool payload)
let totalVisibleTextChars = 0;       // sum of response.message[] char lengths
// Globally distinct thinking events, deduped by plaintext text.
const distinctThinkingText = new Set();
const distinctThinkingEncrypted = new Set();  // for second-pass encrypted merge
let totalThinkingBlockCount = 0;     // raw count incl. prefix carries
let totalThinkingPlaintextChars = 0; // distinct-events only
let totalThinkingEncryptedChars = 0; // distinct-events only
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
    toolCallArgsApproxTokens: 0,         // sum of toolCall.args / 4 for this prompt
    visibleTextApproxTokens: 0,          // sum of request.response.message / 4
    thinkingEventCount: 0,               // distinct thinking emissions (deduped by text)
    thinkingPlaintextTokensApprox: 0,    // chars/4 of distinct plaintext summaries
    thinkingEncryptedTokensApprox: 0,    // chars/4 of distinct encrypted blobs
    toolErrorCount: 0,
    finalAssistantPreview: null,
    durationMs: 0,
    firstTime: null,
    lastTime: null,
    isSubagent: false,
    spawnedBy: null,           // toolCall ref (e.g. "p2.l0") if this prompt is a subagent
    spawnedSubagents: [],      // [{ toolCallRef, subagentRef, description }] if this prompt spawned any
  };

  // runSubagent toolCall args captured during this prompt; resolved to
  // subagent prompt refs in the post-processing linkage pass.
  const spawnAttempts = [];

  // Distinct thinking events scoped to this prompt (deduped by text).
  const promptThinkingTexts = new Set();

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

      // Tool-call args bytes (output-side payload the model emitted).
      const argsLen = typeof log.args === "string"
        ? log.args.length
        : (log.args != null ? JSON.stringify(log.args).length : 0);
      pSummary.toolCallArgsApproxTokens += Math.ceil(argsLen / 4);
      totalToolArgsChars += argsLen;

      // Thinking block(s) attached directly to this toolCall (new emissions
      // that preceded the tool call, NOT prefix carries).
      if (log.thinking && typeof log.thinking === "object") {
        totalThinkingBlockCount += 1;
        const text = typeof log.thinking.text === "string" ? log.thinking.text : "";
        if (text && !promptThinkingTexts.has(text)) {
          promptThinkingTexts.add(text);
          pSummary.thinkingEventCount += 1;
          pSummary.thinkingPlaintextTokensApprox += Math.ceil(text.length / 4);
          const enc = typeof log.thinking.encrypted === "string" ? log.thinking.encrypted : "";
          pSummary.thinkingEncryptedTokensApprox += Math.ceil(enc.length / 4);
          if (!distinctThinkingText.has(text)) {
            distinctThinkingText.add(text);
            totalThinkingPlaintextChars += text.length;
            totalThinkingEncryptedChars += enc.length;
          }
        }
      }

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

      // Capture subagent spawn intent for the post-processing linkage pass.
      if (tool === "runSubagent") {
        let parsedArgs = null;
        try {
          parsedArgs = typeof log.args === "string"
            ? JSON.parse(log.args)
            : log.args;
        } catch { parsedArgs = null; }
        const description = parsedArgs && typeof parsedArgs.description === "string"
          ? parsedArgs.description
          : null;
        const prompt = parsedArgs && typeof parsedArgs.prompt === "string"
          ? parsedArgs.prompt
          : null;
        if (prompt) {
          spawnAttempts.push({
            toolCallRef: ref,
            toolCallId: log.id ?? null,
            description,
            promptHead: prompt.slice(0, 160),
          });
        }
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
        argsBytes: argsLen,
        argsApproxTokens: Math.ceil(argsLen / 4),
        thinkingBeforeChars: log.thinking?.text?.length ?? 0,
        thinkingBeforeTokensApprox: Math.ceil((log.thinking?.text?.length ?? 0) / 4),
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
      const visibleTextChars = assistantText ? assistantText.length : 0;
      const visibleTextTokensApprox = Math.ceil(visibleTextChars / 4);
      pSummary.visibleTextApproxTokens += visibleTextTokensApprox;
      totalVisibleTextChars += visibleTextChars;

      // Count thinking blocks already carried in this request's prefix.
      // These are prior emissions; their encrypted blobs are part of input
      // and (with caching) read at the cache_read rate on this call.
      // Also harvest the encrypted blobs here — toolCall.thinking only has
      // plaintext, so the prefix is where we learn the input-side cost.
      const prefixThinking = collectThinkingBlocks(log.requestMessages, []);
      const thinkingPrefixCount = prefixThinking.length;
      const thinkingPrefixEncryptedChars = prefixThinking.reduce(
        (s, b) => s + (b.encrypted?.length ?? 0), 0);
      const thinkingPrefixTokensApprox = Math.ceil(thinkingPrefixEncryptedChars / 4);
      totalThinkingBlockCount += thinkingPrefixCount;
      for (const blk of prefixThinking) {
        const text = blk.text || "";
        if (!text) continue;
        // Per-prompt dedup (in case a prefix block surfaces an emission
        // we never saw attached to a toolCall in this prompt).
        if (!promptThinkingTexts.has(text)) {
          promptThinkingTexts.add(text);
          pSummary.thinkingEventCount += 1;
          pSummary.thinkingPlaintextTokensApprox += Math.ceil(text.length / 4);
          pSummary.thinkingEncryptedTokensApprox += Math.ceil((blk.encrypted?.length ?? 0) / 4);
        }
        // Global dedup; merge encrypted bytes from prefix view.
        if (!distinctThinkingText.has(text)) {
          distinctThinkingText.add(text);
          totalThinkingPlaintextChars += text.length;
          totalThinkingEncryptedChars += blk.encrypted?.length ?? 0;
        } else if (blk.encrypted && !distinctThinkingEncrypted.has(text)) {
          // Already counted plaintext; add the encrypted blob the first time
          // we see it (toolCall.thinking lacks it, prefix carry has it).
          distinctThinkingEncrypted.add(text);
          totalThinkingEncryptedChars += blk.encrypted.length;
        }
      }

      const freshInputTokens = Math.max(0, pt - cached - cacheWrite);
      const cacheHitRate = pt > 0 ? cached / pt : 0;

      timeline.push({
        ref,
        t: t ?? md.startTime ?? null,
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
        visibleTextChars,
        visibleTextTokensApprox,
        thinkingPrefixBlocks: thinkingPrefixCount,
        thinkingPrefixTokensApprox,
        assistantTextPreview: assistantText ? truncate(assistantText, 240) : null,
      });
    }
  });

  // Stash spawnAttempts on the summary so the post-prompt linkage pass
  // can resolve refs once all subagent prompts are visible.
  pSummary._spawnAttempts = spawnAttempts;
  promptsOut.push(pSummary);
});

// --- Subagent linkage pass --------------------------------------------------
// p2.l0 runSubagent toolCall -> p1 (the subagent prompt it spawned).
// Match by prompt-text head (the runSubagent args.prompt is copied verbatim
// into the spawned subagent's prompt). This is deterministic; we do not
// invent fuzzy matches.
{
  const subagents = promptsOut.filter((p) => p.isSubagent);
  const usedSubagentRefs = new Set();
  for (const parent of promptsOut) {
    const attempts = parent._spawnAttempts || [];
    for (const att of attempts) {
      const head = att.promptHead || "";
      const match = subagents.find(
        (s) => !usedSubagentRefs.has(s.ref) && typeof s.promptText === "string"
          && s.promptText.slice(0, 160) === head
      );
      if (match) {
        usedSubagentRefs.add(match.ref);
        match.spawnedBy = att.toolCallRef;
        parent.spawnedSubagents.push({
          toolCallRef: att.toolCallRef,
          subagentRef: match.ref,
          description: att.description,
        });
      } else {
        // Record the attempt without a match so the user can see it.
        parent.spawnedSubagents.push({
          toolCallRef: att.toolCallRef,
          subagentRef: null,
          description: att.description,
        });
      }
    }
    delete parent._spawnAttempts;
  }
}

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

// --- Cache-anomaly pass -----------------------------------------------------
// Flag requests that started essentially cold despite a non-trivial prefix.
// A cold start on a large prefix is usually the single biggest cache lever
// in a session (every byte gets cache-written at premium rate). We only
// surface clear outliers; the heuristic for the cause is best-effort.
const CACHE_ANOMALY_MIN_TOKENS = 5000;   // ignore trivial calls
const CACHE_ANOMALY_HIT_THRESHOLD = 0.5; // flag below this
const TOOLDEFS_DELTA_TOKENS = 500;       // tool-defs change significant if > N tokens
const TIME_GAP_MS = 5 * 60 * 1000;       // Anthropic default cache TTL is ~5 min
const cacheAnomalies = [];
{
  const lastByModel = new Map(); // model -> { t, toolDefsApproxTokens }
  for (const row of timeline) {
    if (row.kind !== "request") continue;
    if ((row.promptTokens ?? 0) < CACHE_ANOMALY_MIN_TOKENS) {
      lastByModel.set(row.model, { t: row.t, toolDefsApproxTokens: row.toolDefsApproxTokens });
      continue;
    }
    if ((row.cacheHitRate ?? 0) >= CACHE_ANOMALY_HIT_THRESHOLD) {
      lastByModel.set(row.model, { t: row.t, toolDefsApproxTokens: row.toolDefsApproxTokens });
      continue;
    }
    const prev = lastByModel.get(row.model);
    const causes = [];
    if (!prev) {
      causes.push("first call for model in session");
    } else {
      const toolDelta = (row.toolDefsApproxTokens ?? 0) - (prev.toolDefsApproxTokens ?? 0);
      if (Math.abs(toolDelta) >= TOOLDEFS_DELTA_TOKENS) {
        causes.push(`tool-defs-changed (Δ ${toolDelta >= 0 ? "+" : ""}${toolDelta} tokens)`);
      }
      if (row.t && prev.t) {
        const gapMs = new Date(row.t).getTime() - new Date(prev.t).getTime();
        if (gapMs >= TIME_GAP_MS) {
          const gapMin = Math.round(gapMs / 60000);
          causes.push(`time-gap (~${gapMin} min since prior request, cache likely evicted)`);
        }
      }
    }
    if (causes.length === 0) causes.push("unknown");
    cacheAnomalies.push({
      ref: row.ref,
      t: row.t,
      model: row.model,
      promptTokens: row.promptTokens,
      cachedTokens: row.cachedTokens,
      cacheCreationTokens: row.cacheCreationTokens,
      cacheHitRate: row.cacheHitRate,
      cacheWriteUsd: row.cacheWriteUsd,
      cacheWriteCredits: credits(row.cacheWriteUsd ?? 0),
      toolDefsApproxTokens: row.toolDefsApproxTokens,
      causes,
    });
    lastByModel.set(row.model, { t: row.t, toolDefsApproxTokens: row.toolDefsApproxTokens });
  }
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

// Tool-call payload accounting (output side mirror of toolDefs):
// how much of the model's completion bytes were tool-call args.
const totalToolArgsApproxTokens = Math.ceil(totalToolArgsChars / 4);
const totalVisibleTextApproxTokens = Math.ceil(totalVisibleTextChars / 4);
const totalToolCallPayloadFullPriceUsd = (() => {
  const primary = modelsArr[0];
  const price = primary ? lookupPricing(primary.name) : null;
  return price ? (totalToolArgsApproxTokens * price.outputPerM) / 1_000_000 : 0;
})();

// Thinking under-count for the cost rollup. Anthropic extended thinking is
// billed at the output rate but the Copilot export sets
// completion_tokens_details.reasoning_tokens to 0 — so rollups.cost.totalUsd
// is a LOWER BOUND when thinking blocks are present. We estimate the gap
// from plaintext bytes of distinct thinking events; the encrypted portion
// is on the input side (and gets cached, so amortized cost is small).
const thinkingPresent = distinctThinkingText.size > 0;
const thinkingPlaintextTokensApprox = Math.ceil(totalThinkingPlaintextChars / 4);
const thinkingEncryptedTokensApprox = Math.ceil(totalThinkingEncryptedChars / 4);
const thinkingMissingUsd = (() => {
  if (!thinkingPresent) return 0;
  const primary = modelsArr[0];
  const price = primary ? lookupPricing(primary.name) : null;
  return price ? (thinkingPlaintextTokensApprox * price.outputPerM) / 1_000_000 : 0;
})();

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
      // Cost is a LOWER BOUND when extended thinking was used (Anthropic).
      // The Copilot export sets reasoning_tokens=0 so completion_tokens
      // under-reports. This block estimates the gap from plaintext bytes.
      thinkingUnderCount: {
        applies: thinkingPresent,
        approxMissingOutputTokens: thinkingPresent ? thinkingPlaintextTokensApprox : 0,
        approxMissingUsd: round6(thinkingMissingUsd),
        approxMissingCredits: credits(thinkingMissingUsd),
        note: thinkingPresent
          ? "Estimate from chars/4 of distinct thinking plaintext. Encrypted blobs ride in input and are mostly cache-amortized; output billing is the dominant gap."
          : "No extended-thinking blocks detected.",
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
    toolCallPayloads: {
      approxTokensTotal: totalToolArgsApproxTokens,
      approxShareOfCompletion:
        totalCompletionTokens > 0
          ? Math.round((totalToolArgsApproxTokens / totalCompletionTokens) * 10000) / 10000
          : 0,
      approxFullPriceUsd: round6(totalToolCallPayloadFullPriceUsd),
      visibleTextApproxTokens: totalVisibleTextApproxTokens,
      note:
        "Output-side mirror of toolDefs: how much of completion bytes were tool-call arguments (the code/JSON the model wrote into tool calls) vs visible assistant text. Caveman-style output reduction only addresses visibleTextApproxTokens.",
    },
    thinking: {
      present: thinkingPresent,
      totalBlocks: totalThinkingBlockCount,
      distinctEvents: distinctThinkingText.size,
      plaintextChars: totalThinkingPlaintextChars,
      plaintextTokensApprox: thinkingPlaintextTokensApprox,
      encryptedChars: totalThinkingEncryptedChars,
      encryptedTokensApprox: thinkingEncryptedTokensApprox,
      note:
        "Anthropic extended-thinking blocks. Copilot exports set `tokens: 0` on every block and `completion_tokens_details.reasoning_tokens: 0` on every request, so completionTokens UNDER-REPORTS for thinking-enabled models. See rollups.cost.thinkingUnderCount for the estimated gap. Token counts are chars/4 approximations.",
    },
    errors: {
      toolCallErrors: totalToolCallErrors,
      promptsWithErrors: promptsOut.filter((p) => p.hadError).length,
    },
    cacheAnomalies: {
      count: cacheAnomalies.length,
      thresholdHitRate: CACHE_ANOMALY_HIT_THRESHOLD,
      minPromptTokens: CACHE_ANOMALY_MIN_TOKENS,
      items: cacheAnomalies,
      note:
        "Requests with promptTokens >= minPromptTokens AND cacheHitRate < thresholdHitRate. These usually indicate either a fresh model session, a tool-defs change between prompts (most common cause inside VS Code mode switches), or a 5+ minute gap that exceeded the Anthropic prompt-cache TTL. Each anomaly's cacheWriteCredits is roughly the cost paid to re-warm the prefix.",
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

import { computeCacheHitRate, computeEffectiveInputTokens } from "./cacheMetrics";
import { estimateCost } from "./pricing.js";
import { analyzeSessionCalls, emptyComponents } from "./cacheAnalysis";

var CACHE_MISS_MAX_CACHE_READ_RATIO = 0.35;
var CACHE_MISS_FRESH_SPIKE_MULTIPLIER = 1.5;
var CACHE_MISS_MIN_FRESH_DELTA = 1000;

function getTokenUsage(event) {
  return event && event.tokenUsage ? event.tokenUsage : null;
}

function effectiveFreshInput(usage) {
  if (!usage) return 0;
  return computeEffectiveInputTokens(usage.inputTokens || 0, usage.cacheRead || 0, usage.cacheWrite || 0);
}

function getCostPrompt(event) {
  var raw = event && event.raw;
  return raw && raw.costPrompt ? raw.costPrompt : null;
}

function getBreakdown(event, usage) {
  var prompt = getCostPrompt(event);
  var breakdown = prompt && prompt.contextBreakdown ? prompt.contextBreakdown : null;
  if (breakdown) {
    return {
      system: breakdown.system || 0,
      tools: breakdown.tools || 0,
      history: breakdown.history || 0,
      toolResults: breakdown.toolResults || 0,
      user: breakdown.user || 0,
      total: breakdown.total || 0,
    };
  }
  return {
    system: 0,
    tools: 0,
    history: usage ? usage.inputTokens || 0 : 0,
    toolResults: 0,
    user: 0,
    total: usage ? usage.inputTokens || 0 : 0,
  };
}

function getToolNames(event) {
  var prompt = getCostPrompt(event);
  if (!prompt || !Array.isArray(prompt.toolNames)) return [];
  return prompt.toolNames.map(String).filter(Boolean).sort();
}

function hasUsage(usage) {
  return Boolean(usage && (
    (usage.inputTokens || 0)
    + (usage.outputTokens || 0)
    + (usage.cacheRead || 0)
    + (usage.cacheWrite || 0)
  ) > 0);
}

function totalsCoverMetadata(totals, metadataUsage) {
  if (!hasUsage(metadataUsage)) return true;
  return totals.inputTokens >= (metadataUsage.inputTokens || 0)
    && totals.outputTokens >= (metadataUsage.outputTokens || 0)
    && totals.cacheRead >= (metadataUsage.cacheRead || 0)
    && totals.cacheWrite >= (metadataUsage.cacheWrite || 0);
}

function usageMapCoversMetadata(usageByModel, metadataUsage) {
  if (!hasUsage(metadataUsage)) return true;
  if (!usageByModel || Object.keys(usageByModel).length === 0) return false;
  var totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  Object.keys(usageByModel).forEach(function (model) {
    var usage = usageByModel[model] || {};
    totals.inputTokens += usage.inputTokens || 0;
    totals.outputTokens += usage.outputTokens || 0;
    totals.cacheRead += usage.cacheRead || 0;
    totals.cacheWrite += usage.cacheWrite || 0;
  });
  return totalsCoverMetadata(totals, metadataUsage);
}

function buildMetadataUsageCalls(metadata) {
  var usageByModel = metadata && metadata.modelTokenUsage;
  var useModelBreakdown = usageMapCoversMetadata(usageByModel, metadata && metadata.tokenUsage);
  var modelNames = useModelBreakdown && usageByModel && Object.keys(usageByModel).length > 0
    ? Object.keys(usageByModel)
    : (hasUsage(metadata && metadata.tokenUsage) ? [metadata.primaryModel || "unknown"] : []);
  var calls = [];
  var cumulativeCost = 0;
  var reportedCost = metadata && metadata.totalCost != null ? metadata.totalCost : null;
  var reportedCostUnit = reportedCost != null ? metadata.totalCostUnit || "usd" : "usd";
  var estimatedCosts = modelNames.map(function (model) {
    var usage = useModelBreakdown && usageByModel && usageByModel[model] ? usageByModel[model] : metadata.tokenUsage;
    return estimateCost(usage, model);
  });
  var estimatedTotal = estimatedCosts.reduce(function (sum, cost) { return sum + cost; }, 0);

  for (var i = 0; i < modelNames.length; i += 1) {
    var model = modelNames[i];
    var usage = useModelBreakdown && usageByModel && usageByModel[model] ? usageByModel[model] : metadata.tokenUsage;
    if (!hasUsage(usage)) continue;
    var callCost = reportedCost != null
      ? (estimatedTotal > 0 ? reportedCost * (estimatedCosts[i] / estimatedTotal) : reportedCost / modelNames.length)
      : estimatedCosts[i];
    cumulativeCost += callCost;

    calls.push({
      index: calls.length,
      eventIndex: null,
      event: null,
      title: modelNames.length > 1 ? "Session total: " + model : "Session token totals",
      model: model,
      tokenUsage: usage,
      freshInputTokens: effectiveFreshInput(usage),
      cachedInputTokens: usage.cacheRead || 0,
      cacheWriteTokens: usage.cacheWrite || 0,
      outputTokens: usage.outputTokens || 0,
      cost: callCost,
      costUnit: reportedCost != null ? reportedCostUnit : "usd",
      estimatedUsdCost: estimatedCosts[i],
      cumulativeCost: cumulativeCost,
      contextBreakdown: getBreakdown(null, usage),
      netNewTokens: usage.inputTokens || 0,
      cacheHitRate: usage.cacheHitRate != null
        ? usage.cacheHitRate
        : computeCacheHitRate(usage.inputTokens || 0, usage.cacheWrite || 0, usage.cacheRead || 0) || 0,
      toolNames: [],
      toolDiff: { added: [], removed: [] },
      isMetadataSummary: true,
    });
  }

  return calls;
}

function diffNames(previous, current) {
  var previousSet = new Set(previous);
  var currentSet = new Set(current);
  var added = current.filter(function (name) { return !previousSet.has(name); });
  var removed = previous.filter(function (name) { return !currentSet.has(name); });
  return { added: added, removed: removed };
}

export function formatTokens(value) {
  var n = Math.max(0, Math.round(value || 0));
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function buildCostAnalysis(events, metadata) {
  var sourceEvents = events || [];
  var calls = [];
  var totalCost = 0;
  var totalCostUnit = "usd";
  var estimatedUsdCost = 0;
  var totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  var previousByModel = {};
  var cacheMisses = [];
  var peakContext = 0;

  for (var i = 0; i < sourceEvents.length; i += 1) {
    var event = sourceEvents[i];
    var usage = getTokenUsage(event);
    if (!usage) continue;

    var model = event.model || (metadata && metadata.primaryModel) || "unknown";
    var freshInputTokens = effectiveFreshInput(usage);
    var cachedInputTokens = usage.cacheRead || 0;
    var cacheWriteTokens = usage.cacheWrite || 0;
    var outputTokens = usage.outputTokens || 0;
    var callCost = estimateCost(usage, model);
    var estimatedCost = callCost;
    totalCost += callCost;
    estimatedUsdCost += estimatedCost;
    totals.inputTokens += usage.inputTokens || 0;
    totals.outputTokens += outputTokens;
    totals.cacheRead += cachedInputTokens;
    totals.cacheWrite += cacheWriteTokens;

    var contextBreakdown = getBreakdown(event, usage);
    var previousCall = previousByModel[model] || null;
    var netNewTokens = previousCall ? Math.max(contextBreakdown.total - previousCall.contextBreakdown.total, 0) : contextBreakdown.total;
    var toolNames = getToolNames(event);
    var toolDiff = previousCall ? diffNames(previousCall.toolNames, toolNames) : { added: [], removed: [] };
    var cacheHitRate = usage.cacheHitRate != null
      ? usage.cacheHitRate
      : computeCacheHitRate(usage.inputTokens || 0, cacheWriteTokens, cachedInputTokens) || 0;
    peakContext = Math.max(peakContext, contextBreakdown.total || usage.inputTokens || 0);

    var call = {
      index: calls.length,
      eventIndex: i,
      event: event,
      title: event.text || "LLM call",
      model: model,
      tokenUsage: usage,
      freshInputTokens: freshInputTokens,
      cachedInputTokens: cachedInputTokens,
      cacheWriteTokens: cacheWriteTokens,
      outputTokens: outputTokens,
      cost: callCost,
      costUnit: "usd",
      estimatedUsdCost: estimatedCost,
      cumulativeCost: totalCost,
      contextBreakdown: contextBreakdown,
      netNewTokens: netNewTokens,
      cacheHitRate: cacheHitRate,
      toolNames: toolNames,
      toolDiff: toolDiff,
    };

    if (previousCall) {
      var previousUsage = previousCall.tokenUsage || {};
      var previousFresh = previousCall.freshInputTokens || 0;
      var previousCacheRead = previousUsage.cacheRead || 0;
      // Flag large same-model cache drops paired with fresh-token spikes. These named
      // thresholds are conservative starting points that can be tuned with real prompt data.
      var freshSpikeThreshold = Math.max(
        previousFresh * CACHE_MISS_FRESH_SPIKE_MULTIPLIER,
        previousFresh + CACHE_MISS_MIN_FRESH_DELTA,
      );
      var likelyMiss = previousCacheRead > 0
        && cachedInputTokens < previousCacheRead * CACHE_MISS_MAX_CACHE_READ_RATIO
        && freshInputTokens > freshSpikeThreshold;
      if (likelyMiss) {
        cacheMisses.push({
          callIndex: call.index,
          eventIndex: i,
          model: model,
          freshInputTokens: freshInputTokens,
          previousFreshInputTokens: previousFresh,
          cacheReadTokens: cachedInputTokens,
          previousCacheReadTokens: previousCacheRead,
          toolDiff: toolDiff,
        });
      }
    }

    calls.push(call);
    previousByModel[model] = call;
  }

  var metadataUsage = metadata && metadata.tokenUsage;
  if (!totalsCoverMetadata(totals, metadataUsage)) {
    calls = buildMetadataUsageCalls(metadata || {});
    totalCostUnit = metadata && metadata.totalCost != null ? metadata.totalCostUnit || "usd" : "usd";
    totalCost = metadata && metadata.totalCost != null
      ? metadata.totalCost
      : calls.reduce(function (sum, call) { return sum + call.cost; }, 0);
    estimatedUsdCost = calls.reduce(function (sum, call) { return sum + (call.estimatedUsdCost || (call.costUnit === "usd" ? call.cost : 0)); }, 0);
    totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    peakContext = 0;
    cacheMisses = [];

    for (var callIndex = 0; callIndex < calls.length; callIndex += 1) {
      var summaryUsage = calls[callIndex].tokenUsage || {};
      totals.inputTokens += summaryUsage.inputTokens || 0;
      totals.outputTokens += summaryUsage.outputTokens || 0;
      totals.cacheRead += summaryUsage.cacheRead || 0;
      totals.cacheWrite += summaryUsage.cacheWrite || 0;
      peakContext = Math.max(peakContext, calls[callIndex].contextBreakdown.total || summaryUsage.inputTokens || 0);
    }
  }

  var cacheHitRate = computeCacheHitRate(totals.inputTokens, totals.cacheWrite, totals.cacheRead) || 0;
  var enhancedCacheAnalysis = buildEnhancedCacheAnalysis(calls);
  return {
    calls: calls,
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      freshInputTokens: computeEffectiveInputTokens(totals.inputTokens, totals.cacheRead, totals.cacheWrite),
      cost: totalCost,
      costUnit: totalCostUnit,
      estimatedUsdCost: estimatedUsdCost,
      premiumRequests: metadata && metadata.premiumRequests != null ? metadata.premiumRequests : null,
      cacheHitRate: cacheHitRate,
      peakContext: peakContext,
    },
    cacheMisses: cacheMisses,
    cacheAnalysis: enhancedCacheAnalysis,
    hasCostData: calls.length > 0,
  };
}

/**
 * Run the per-model cache analysis (cacheAnalysis.ts) over the calls already
 * built by buildCostAnalysis. Returns a parallel array of CallAnalysis (one
 * per call, same order) plus an `unexpectedMisses` array of calls flagged as
 * unexpected cache misses with structured diagnosis. The new CostView consumes
 * this; the legacy heuristic `cacheMisses` is kept for backward compatibility.
 */
function buildEnhancedCacheAnalysis(calls) {
  if (!calls || calls.length === 0) {
    return { perCall: [], unexpectedMisses: [], unexpectedMissCost: 0 };
  }
  var promptGroups = groupCallsByPrompt(calls);
  var groupResults = analyzeSessionCalls(promptGroups.groups);
  var perCallByEventIndex = {};
  for (var g = 0; g < groupResults.length; g += 1) {
    var groupCallIds = promptGroups.callIds[g];
    var analyzed = groupResults[g].calls;
    for (var i = 0; i < analyzed.length; i += 1) {
      perCallByEventIndex[groupCallIds[i]] = analyzed[i];
    }
  }

  var perCall = [];
  var unexpectedMisses = [];
  var unexpectedMissCost = 0;
  for (var c = 0; c < calls.length; c += 1) {
    var call = calls[c];
    var key = String(call.eventIndex);
    var analysis = perCallByEventIndex[key] || null;
    perCall.push(analysis);
    if (analysis && analysis.unexpectedMiss) {
      unexpectedMissCost += call.cost || 0;
      unexpectedMisses.push({
        callIndex: call.index,
        eventIndex: call.eventIndex,
        model: call.model,
        promptTokens: call.tokenUsage ? call.tokenUsage.inputTokens || 0 : 0,
        cost: call.cost || 0,
        diag: analysis.cacheMissDiag,
      });
    }
  }
  return { perCall: perCall, unexpectedMisses: unexpectedMisses, unexpectedMissCost: unexpectedMissCost };
}

function getCostPromptForCall(call) {
  var event = call && call.event;
  var raw = event && event.raw;
  return raw && raw.costPrompt ? raw.costPrompt : null;
}

function getToolDefs(call) {
  var prompt = getCostPromptForCall(call);
  if (!prompt || !Array.isArray(prompt.tools)) return [];
  return prompt.tools.map(function (tool, idx) {
    if (tool && typeof tool === "object") {
      var name = tool.name || (tool.function && tool.function.name) || ("tool_" + idx);
      var copy = Object.assign({}, tool);
      copy.name = name;
      return copy;
    }
    return { name: "tool_" + idx, value: tool };
  });
}

function getComponentsFromBreakdown(breakdown) {
  return {
    system: breakdown.system || 0,
    tool_defs: breakdown.tools || 0,
    history: breakdown.history || 0,
    tool_results: breakdown.toolResults || 0,
    current: breakdown.user || 0,
  };
}

/**
 * Group calls into "prompts" for cacheAnalysis. We use event.turnIndex as the
 * grouping key when available; otherwise each call is its own prompt. Returns
 * parallel arrays so we can map results back to call.eventIndex.
 */
function groupCallsByPrompt(calls) {
  var groups = [];
  var callIds = [];
  var currentKey = null;
  var current = null;
  var currentIds = null;
  for (var i = 0; i < calls.length; i += 1) {
    var call = calls[i];
    var key = call.event && typeof call.event.turnIndex === "number"
      ? "turn:" + call.event.turnIndex
      : "call:" + call.eventIndex;
    if (key !== currentKey || !current) {
      if (current) { groups.push(current); callIds.push(currentIds); }
      current = { calls: [], cacheWriteSum: 0 };
      currentIds = [];
      currentKey = key;
    }
    var usage = call.tokenUsage || {};
    var components = getComponentsFromBreakdown(call.contextBreakdown || emptyComponents());
    current.calls.push({
      id: String(call.eventIndex),
      model: call.model || "unknown",
      usage: {
        prompt_tokens: usage.inputTokens || 0,
        completion_tokens: usage.outputTokens || 0,
        cached_tokens: usage.cacheRead || 0,
        cache_write: usage.cacheWrite || 0,
      },
      tools: getToolDefs(call),
      components: components,
    });
    current.cacheWriteSum += usage.cacheWrite || 0;
    currentIds.push(String(call.eventIndex));
  }
  if (current) { groups.push(current); callIds.push(currentIds); }
  return { groups: groups, callIds: callIds };
}

/**
 * Project the upstream-shape analysis (calls[], totals.inputTokens...) into the
 * shape compareCost.ts and exportComparison.ts expect (prompts[], totals.promptTokens...).
 *
 * Used by parsers that want to expose a self-contained `metadata.costAnalysis`
 * for the Compare view and the markdown export, without forcing every consumer
 * to re-run buildCostAnalysis. The upstream-shape `analysis` is still authoritative
 * for CostView; this is purely an additional consumer-facing surface.
 */
export function buildCompareCostShape(analysis) {
  if (!analysis || !Array.isArray(analysis.calls) || analysis.calls.length === 0) {
    return null;
  }

  var prompts = [];
  var currentKey = null;
  var current = null;

  function freshFromUsage(usage) {
    return computeEffectiveInputTokens(usage.inputTokens || 0, usage.cacheRead || 0);
  }

  for (var i = 0; i < analysis.calls.length; i += 1) {
    var call = analysis.calls[i];
    var event = call.event || {};
    var prompt = getCostPromptForCall(call) || {};
    var usage = call.tokenUsage || {};
    var bd = call.contextBreakdown || emptyComponents();
    var fresh = freshFromUsage(usage);
    var cached = usage.cacheRead || 0;
    var cacheWrite = usage.cacheWrite || 0;
    var output = usage.outputTokens || 0;
    var promptTokens = usage.inputTokens || 0;
    var cost = call.cost || 0;

    var key = typeof event.turnIndex === "number" ? "turn:" + event.turnIndex : "call:" + call.eventIndex;
    if (key !== currentKey || !current) {
      current = {
        index: prompts.length,
        cost: 0, output: 0, cached: 0, fresh: 0, cacheWrite: 0, promptTokens: 0,
        llmCount: 0,
        events: [],
      };
      if (typeof prompt.userPromptText === "string") current.label = prompt.userPromptText;
      else if (typeof prompt.callName === "string") current.label = prompt.callName;
      prompts.push(current);
      currentKey = key;
    }

    var eventLike = {
      name: prompt.callName || event.text || "LLM call",
      model: call.model || "unknown",
      cost: cost,
      output: output,
      cached: cached,
      fresh: fresh,
      cacheWrite: cacheWrite,
      promptTokens: promptTokens,
      components: {
        system: bd.system || 0,
        tool_defs: bd.tools || 0,
        history: bd.history || 0,
        tool_results: bd.toolResults || 0,
        current: bd.user || 0,
        output: output,
      },
      kind: "llm",
    };
    if (typeof prompt.category === "string") eventLike.category = prompt.category;
    if (typeof prompt.responsePreview === "string") eventLike.responsePreview = prompt.responsePreview;
    if (typeof prompt.currentText === "string") eventLike.currentText = prompt.currentText;
    if (typeof prompt.systemPreview === "string") {
      eventLike.systemPreview = prompt.systemPreview;
      if (typeof prompt.systemChars === "number") eventLike.systemChars = prompt.systemChars;
      if (typeof prompt.systemHash === "string") eventLike.systemHash = prompt.systemHash;
    }
    if (typeof prompt.argsSummary === "string") eventLike.argsSummary = prompt.argsSummary;
    if (typeof prompt.rawArgs === "string") eventLike.rawArgs = prompt.rawArgs;

    current.events.push(eventLike);
    current.cost += cost;
    current.output += output;
    current.cached += cached;
    current.fresh += fresh;
    current.cacheWrite += cacheWrite;
    current.promptTokens += promptTokens;
    current.llmCount += 1;
  }

  var t = analysis.totals || {};
  var totalDenom = (t.cacheRead || 0) + (t.cacheWrite || 0) + (t.freshInputTokens || 0);
  var totals = {
    promptTokens: t.inputTokens || 0,
    output: t.outputTokens || 0,
    cached: t.cacheRead || 0,
    fresh: t.freshInputTokens || 0,
    cacheWrite: t.cacheWrite || 0,
    cost: t.cost || 0,
    llmCalls: analysis.calls.length,
    toolCalls: 0,
    cacheHitRate: totalDenom > 0 ? (t.cacheRead || 0) / totalDenom : 0,
  };
  if (analysis.cacheAnalysis) {
    totals.unexpectedMissCount = (analysis.cacheAnalysis.unexpectedMisses || []).length;
    totals.unexpectedMissCost = analysis.cacheAnalysis.unexpectedMissCost || 0;
  }

  return { prompts: prompts, totals: totals };
}

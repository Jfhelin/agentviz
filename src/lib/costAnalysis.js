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
  return computeEffectiveInputTokens(usage.inputTokens || 0, usage.cacheRead || 0);
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
    totalCost += callCost;
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

  var cacheHitRate = computeCacheHitRate(totals.inputTokens, totals.cacheWrite, totals.cacheRead) || 0;
  var enhancedCacheAnalysis = buildEnhancedCacheAnalysis(calls);
  return {
    calls: calls,
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      freshInputTokens: computeEffectiveInputTokens(totals.inputTokens, totals.cacheRead),
      cost: totalCost,
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

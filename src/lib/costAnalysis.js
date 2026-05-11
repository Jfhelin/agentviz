import { computeCacheHitRate, computeEffectiveInputTokens } from "./cacheMetrics";
import { estimateCost } from "./pricing.js";

var RECOMMIT_GROWTH_MULTIPLIER = 1.5;
var RECOMMIT_MIN_TOKENS = 2000;
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
    // Recommit means re-writing previously cached content back into the cache. Treat
    // cache writes that substantially exceed context growth as recommits.
    var recommitThreshold = Math.max(netNewTokens * RECOMMIT_GROWTH_MULTIPLIER, RECOMMIT_MIN_TOKENS);
    var recommitTokens = cacheWriteTokens > recommitThreshold ? cacheWriteTokens - netNewTokens : 0;
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
      recommitTokens: recommitTokens,
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
    hasCostData: calls.length > 0,
  };
}

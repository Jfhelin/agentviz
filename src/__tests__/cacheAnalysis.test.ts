import { describe, it, expect } from "vitest";
import {
  analyzeSessionCalls,
  computeCallNewSplit,
  diffTools,
  emptyComponents,
  type CallInput,
} from "../lib/cacheAnalysis";

function call(over: Partial<CallInput> = {}): CallInput {
  return {
    id: over.id ?? "c1",
    model: over.model ?? "claude-sonnet-4.6",
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      cache_write: 0,
      ...(over.usage ?? {}),
    },
    tools: over.tools ?? [],
    components: over.components ?? emptyComponents(),
    componentChars: over.componentChars,
  };
}

describe("computeCallNewSplit", () => {
  it("treats a model switch as fully new with no recommit", () => {
    expect(computeCallNewSplit(8000, 8000, true)).toEqual({ trulyNew: 8000, recommit: 0 });
  });

  it("attributes growth to trulyNew and the rest to recommit", () => {
    expect(computeCallNewSplit(5000, 1500, false)).toEqual({ trulyNew: 1500, recommit: 3500 });
  });

  it("clamps negative deltas (trim) so recommit equals all of newTotal", () => {
    expect(computeCallNewSplit(2000, -300, false)).toEqual({ trulyNew: 0, recommit: 2000 });
  });

  it("returns zeroes when no new tokens at all", () => {
    expect(computeCallNewSplit(0, 0, false)).toEqual({ trulyNew: 0, recommit: 0 });
  });
});

describe("diffTools", () => {
  it("flags likely TTL expiry when tools are byte-identical", () => {
    const a = [{ name: "search", desc: "x" }];
    const b = [{ name: "search", desc: "x" }];
    const d = diffTools(a, b);
    expect(d.likelyTtlExpiry).toBe(true);
    expect(d.toolDefsChanged).toBe(0);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("detects an added tool", () => {
    const d = diffTools([{ name: "a" }], [{ name: "a" }, { name: "b" }]);
    expect(d.added).toEqual(["b"]);
    expect(d.likelyTtlExpiry).toBe(false);
  });

  it("detects a removed tool", () => {
    const d = diffTools([{ name: "a" }, { name: "b" }], [{ name: "a" }]);
    expect(d.removed).toEqual(["b"]);
  });

  it("detects a changed tool body even when name is unchanged", () => {
    const d = diffTools(
      [{ name: "search", desc: "old" }],
      [{ name: "search", desc: "new" }],
    );
    expect(d.toolDefsChanged).toBe(1);
    expect(d.changedSample).toEqual(["search"]);
    expect(d.likelyTtlExpiry).toBe(false);
  });

  it("ignores key order when comparing tool bodies", () => {
    const d = diffTools(
      [{ name: "t", a: 1, b: 2 }],
      [{ name: "t", b: 2, a: 1 }],
    );
    expect(d.toolDefsChanged).toBe(0);
    expect(d.likelyTtlExpiry).toBe(true);
  });

  it("caps changed/added/removed samples at 5 entries", () => {
    const prev = Array.from({ length: 10 }, (_, i) => ({ name: "x" + i }));
    const curr: { name: string }[] = [];
    const d = diffTools(prev, curr);
    expect(d.removed).toHaveLength(5);
  });
});

describe("analyzeSessionCalls -- per-model cache scoping", () => {
  it("resets the baseline on a model switch", () => {
    const result = analyzeSessionCalls([
      {
        cacheWriteSum: 0,
        calls: [
          call({ id: "p1", model: "claude-sonnet-4.6", usage: { prompt_tokens: 5000, completion_tokens: 100, cached_tokens: 0, cache_write: 5000 } }),
          // Switch to a different model -- prevPt for THIS model is 0.
          call({ id: "p2", model: "gpt-4o", usage: { prompt_tokens: 3000, completion_tokens: 80, cached_tokens: 0, cache_write: 3000 } }),
        ],
      },
    ]);
    const calls = result[0].calls;
    expect(calls[0].modelSwitched).toBe(false);
    expect(calls[0].prevPt).toBe(0);
    expect(calls[1].modelSwitched).toBe(true);
    expect(calls[1].prevPt).toBe(0);
    // Modelswitched call should NOT be flagged as an unexpected miss --
    // the cache simply doesn't exist for this model yet.
    expect(calls[1].unexpectedMiss).toBe(false);
  });

  it("computes deltaVsPrev against the same-model baseline", () => {
    const result = analyzeSessionCalls([
      {
        cacheWriteSum: 0,
        calls: [
          call({ id: "a1", model: "claude-sonnet-4.6", usage: { prompt_tokens: 5000, completion_tokens: 0, cached_tokens: 0, cache_write: 5000 } }),
          call({ id: "a2", model: "claude-sonnet-4.6", usage: { prompt_tokens: 7000, completion_tokens: 0, cached_tokens: 5000, cache_write: 0 } }),
        ],
      },
    ]);
    expect(result[0].calls[1].prevPt).toBe(5000);
    expect(result[0].calls[1].deltaVsPrev).toBe(2000);
  });
});

describe("analyzeSessionCalls -- unexpected miss detection", () => {
  it("flags an unexpected cache miss when prior call had cached prefix", () => {
    const tools = [{ name: "search", schema: { x: 1 } }];
    const result = analyzeSessionCalls([
      {
        cacheWriteSum: 0,
        calls: [
          call({ id: "c1", model: "claude-sonnet-4.6", tools, usage: { prompt_tokens: 8000, completion_tokens: 0, cached_tokens: 0, cache_write: 8000 } }),
          // Same model, tools changed (would normally hit cache, but tool-defs invalidation)
          call({
            id: "c2",
            model: "claude-sonnet-4.6",
            tools: [{ name: "search", schema: { x: 2 } }],
            usage: { prompt_tokens: 8200, completion_tokens: 0, cached_tokens: 0, cache_write: 8200 },
          }),
        ],
      },
    ]);
    const c2 = result[0].calls[1];
    expect(c2.unexpectedMiss).toBe(true);
    expect(c2.cacheMissDiag).not.toBeNull();
    expect(c2.cacheMissDiag!.toolDefsChanged).toBe(1);
    expect(c2.cacheMissDiag!.changedSample).toEqual(["search"]);
    expect(c2.cacheMissDiag!.likelyTtlExpiry).toBe(false);
  });

  it("does NOT flag an unexpected miss when the prior call was below the threshold", () => {
    const result = analyzeSessionCalls([
      {
        cacheWriteSum: 0,
        calls: [
          call({ id: "x1", model: "claude-sonnet-4.6", usage: { prompt_tokens: 500, completion_tokens: 0, cached_tokens: 0, cache_write: 500 } }),
          call({ id: "x2", model: "claude-sonnet-4.6", usage: { prompt_tokens: 1000, completion_tokens: 0, cached_tokens: 0, cache_write: 1000 } }),
        ],
      },
    ]);
    expect(result[0].calls[1].unexpectedMiss).toBe(false);
  });

  it("attributes a TTL-expiry miss when tools are unchanged", () => {
    const tools = [{ name: "search" }];
    const result = analyzeSessionCalls([
      {
        cacheWriteSum: 0,
        calls: [
          call({ id: "t1", model: "claude-sonnet-4.6", tools, usage: { prompt_tokens: 8000, completion_tokens: 0, cached_tokens: 0, cache_write: 8000 } }),
          call({ id: "t2", model: "claude-sonnet-4.6", tools, usage: { prompt_tokens: 8000, completion_tokens: 0, cached_tokens: 0, cache_write: 8000 } }),
        ],
      },
    ]);
    const c2 = result[0].calls[1];
    expect(c2.unexpectedMiss).toBe(true);
    expect(c2.cacheMissDiag!.likelyTtlExpiry).toBe(true);
  });
});

describe("analyzeSessionCalls -- recommit math", () => {
  it("computes recommit when newTotal exceeds growth", () => {
    const result = analyzeSessionCalls([
      {
        cacheWriteSum: 0,
        calls: [
          call({ id: "r1", model: "claude-sonnet-4.6", usage: { prompt_tokens: 5000, completion_tokens: 0, cached_tokens: 0, cache_write: 5000 } }),
          // Cache expired: cache_write of 6000 but real growth is only 1000.
          call({ id: "r2", model: "claude-sonnet-4.6", usage: { prompt_tokens: 6000, completion_tokens: 0, cached_tokens: 0, cache_write: 6000 } }),
        ],
      },
    ]);
    const c2 = result[0].calls[1];
    expect(c2.deltaVsPrev).toBe(1000);
    expect(c2.newTotal).toBe(6000);
    expect(c2.trulyNew).toBe(1000);
    expect(c2.recommit).toBe(5000);
  });
});

describe("analyzeSessionCalls -- per-bucket new attribution", () => {
  it("attributes 0 new tokens to a bucket whose raw chars are unchanged", () => {
    // Simulates the real-world bug: system text is bit-identical across two
    // calls but the per-call rescaling makes the scaled `system` token count
    // drift (8500 -> 9600). Without componentChars the diff would attribute
    // ~1100 new tokens to system; with componentChars it should be 0.
    const stableSystemChars = 34000; // unchanged across both calls
    const result = analyzeSessionCalls([
      {
        cacheWriteSum: 0,
        calls: [
          call({
            id: "a1",
            usage: { prompt_tokens: 20000, completion_tokens: 0, cached_tokens: 0, cache_write: 20000 },
            components: { system: 8500, tool_defs: 4000, history: 5000, tool_results: 2000, current: 500 },
            componentChars: { system: stableSystemChars, tool_defs: 16000, history: 20000, tool_results: 8000, current: 2000 },
          }),
          call({
            id: "a2",
            usage: { prompt_tokens: 32400, completion_tokens: 0, cached_tokens: 28800, cache_write: 0 },
            // Scaled system token estimate jumped purely due to rescaling.
            components: { system: 10000, tool_defs: 4700, history: 12000, tool_results: 5200, current: 500 },
            // But the actual system char count is unchanged. History and tool_results grew.
            componentChars: { system: stableSystemChars, tool_defs: 16000, history: 48000, tool_results: 21000, current: 2000 },
          }),
        ],
      },
    ]);
    const c2 = result[0].calls[1];
    expect(c2.newPerBucket.system).toBe(0);
    expect(c2.newPerBucket.tool_defs).toBe(0);
    expect(c2.newPerBucket.current).toBe(0);
    // All of newTotal (3600) should be in history + tool_results.
    expect(c2.newPerBucket.history + c2.newPerBucket.tool_results).toBe(c2.newTotal);
  });
});

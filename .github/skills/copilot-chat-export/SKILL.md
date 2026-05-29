---
name: copilot-chat-export
description: Answer any question about a VS Code Copilot Chat export JSON file (the kind exported as "All prompts" to a file like 04-plan-implement-cart.json). Generates a compact digest sidecar on first use, then reads the digest plus the raw file as needed. Use whenever the user mentions a Copilot chat export, asks about a session log file, points at a `.json` file in CopilotLogExports/, or asks about prompts/tool calls/tokens/cache/cost in such a file.
user-invocable: true
---

# Copilot Chat Export Q&A

You are an expert on the **VS Code Copilot Chat export** JSON format. Your job is to help the user understand and analyze any such file: rollups, costs, cache behavior, tool usage, files touched, conversation flow, sub-agents, decision points, anything they ask.

Stay in chat. Do not start a web app, do not open editors, do not propose code changes unless the user explicitly asks. This skill is for reading and reasoning, not building.

## When to activate

Activate when any of these are true:
- The user names or pastes a path to a `.json` file that appears to be a Copilot chat export (e.g. anything under `~/CopilotLogExports/`, `copilot_all_prompts_*.json`, or a file with top-level keys `prompts` and `mcpServers`).
- The user says "the log", "the export", "the session", "this chat", or similar in a context that points at such a file.
- The user asks about prompts, tool calls, token usage, cache hit rate, models used, files touched, sub-agents, or cost in relation to a Copilot session file.

If you are not sure whether a file is a Copilot chat export, peek at the top-level keys with `jq 'keys' FILE` — a real export has at minimum `prompts`, `mcpServers`, `exportedAt`.

## Where the user usually keeps these files

When the user names a file without a full path (e.g. "look at `04-plan-implement-cart.json`"), search these locations in order before giving up. Use the first hit.

1. `~/Downloads/<name>`
2. `~/CopilotLogExports/<name>`

Quick resolver:

```bash
for d in "$HOME/Downloads" "$HOME/CopilotLogExports"; do
  [ -f "$d/<name>" ] && echo "$d/<name>" && break
done
```

If neither contains the file, ask the user for the path rather than guessing further. If the user says "the latest export" or similar without naming a file, list the newest few `.json` files across both directories with `ls -lt ~/Downloads/*.json ~/CopilotLogExports/*.json 2>/dev/null | head` and let them pick.

## Procedure (run this every time the user points at a file)

1. **Resolve the absolute path** of the source file.
2. **Ensure a digest exists and is fresh.** Run:
   ```bash
   node <repo>/.github/skills/copilot-chat-export/scripts/digest.mjs <abs-source-path>
   ```
   The script writes `<source-dir>/.agentviz/<basename>.digest.json` (or prints `up to date` and exits 0 if the sidecar is already current — based on source mtime). Always run it; the cache check is cheap.
3. **Read the digest** with `jq` or by opening the file. The digest is ≤100 KB for typical exports and answers most questions on its own.
4. **Give an overview** unless the user asked a specific question first. Use the template in "Default overview" below.
5. **Answer follow-ups** using the digest first. Drop down to the raw file (with `jq`) only when the digest does not have what you need — see "Drilling into the raw file" below.

## Default overview template

When the user just points at a file with no specific question, produce a 6-to-10-line overview pulled from the digest:

- File, exported timestamp, source size, digest size
- Prompts / requests / tool calls / total tokens
- Primary model, cache hit rate, total wall time, request duration p50/p95
- **Total cost in AI credits** (from `rollups.cost.credits.total`), with USD in parens, plus savings vs no-cache (also in credits). Mention `pricingVersion` and flag if `allModelsPriced` is false.
- Number of unique tools used and top 3 tools by call count
- Number of unique files touched and top 3
- Whether any prompts ran as sub-agents (and if so, which parent spawned which — pull from `prompts[].spawnedSubagents`)
- One-line per-prompt summary using `promptPreview` (truncate to fit), include `costUsd`
- If `rollups.toolDefs.approxShareOfPromptTokens` ≥ 0.10, mention the share of input budget spent on tool schemas (~$X worst case)
- If `rollups.thinking.present` is true, mention extended thinking (~N events, ~T plaintext tokens) and that cost is a LOWER BOUND by ~M credits (see `rollups.cost.thinkingUnderCount`)
- If `rollups.toolCallPayloads.approxShareOfCompletion` ≥ 0.30, mention that ~N% of output was tool-call args (only ~V tokens visible text)
- If `rollups.cacheAnomalies.count` > 0, mention how many requests started cold (~C credits to re-warm) and that `rollups.cacheAnomalies.items` has the refs and causes
- If `rollups.errors.toolCallErrors` > 0, mention how many and in which prompts

Then ask: "Anything specific you want to dig into?" Do not volunteer further analysis unprompted — this is a conversation.

## The export schema (data dictionary)

A Copilot chat export is one JSON object:

```
{
  exportedAt: ISO string
  totalPrompts: number
  totalLogEntries: number
  mcpServers: array of MCP server configs available at export time
  prompts: array of Prompt
}
```

### Prompt

```
{
  promptId: string             // e.g. "toolu_bdrk_…__vscode-…-prompt" or a uuid-prompt
  prompt: string               // the user's message text
  logCount: number
  logs: array of LogEntry      // interleaved request + toolCall, in time order
}
```

### LogEntry — two kinds

**`kind: "toolCall"`** — a tool/function call the model issued, plus its return value.
```
{
  kind: "toolCall"
  id: string                   // matches `toolCallId` referenced in later request messages
  tool: string                 // e.g. read_file, list_dir, multi_replace_string_in_file
  args: string (JSON-encoded)  // tool input
  time: ISO string
  response: any                // tool output
}
```

**`kind: "request"`** — one model call, with the full conversation prefix and the response.
```
{
  kind: "request"
  id: string                   // short id like "0d17a8cb"
  type: string                 // e.g. "ChatMLSuccess"
  name: string                 // e.g. "panel/chat", "tool/runSubagent"
  requestMessages: { messages: array of Message }   // the FULL conversation prefix sent to the model
  response: { type, message: [string, ...] }
  metadata: {
    requestType, model, maxPromptTokens, maxResponseTokens, location,
    startTime, endTime, duration (ms), ourRequestId, requestId, serverRequestId,
    timeToFirstToken (ms),
    usage: {
      prompt_tokens, completion_tokens, total_tokens,
      prompt_tokens_details: { cached_tokens, cache_creation_input_tokens },
      completion_tokens_details: { reasoning_tokens, … },
      copilot_usage: { token_details, total_nano_aiu }
    },
    copilotUsageAic,
    tools: array of tool schemas advertised to the model on this call
  }
}
```

### Message (inside `requestMessages.messages`)

```
{
  role: integer           // 0 = system, 1 = user, 2 = assistant, 3 = tool
  content: array          // each element has { type, … }. Common kinds:
                          //   type 1 = plain text         (string `.text`)
                          //   type 2 = structured / tool  (tool input or output payload)
                          //   type "thinking" = Anthropic extended-thinking block carried
                          //     in the request prefix: { thinking: { id, text, encrypted, tokens: 0 } }
                          //     — the model's chain-of-thought summary + redacted encrypted blob.
  toolCalls?: array       // present on assistant messages that called tools
  toolCallId?: string     // present on tool messages, links to the toolCall log's id
}
```

Thinking blocks also appear directly on `toolCall` log entries as
`logs[].thinking = { id, text }` (plaintext only, no encrypted blob) —
that is the "new emission immediately before this tool call" view. The
prefix-carry form above is what subsequent requests see.

### Crucial structural facts (these trip people up)

- **Each `request` carries a full snapshot of the conversation prefix**, not a delta. A prompt with 27 logs and 6 requests stores the conversation 6 times with growing tails. This is why exports are large.
- **`prompt_tokens_details.cached_tokens`** is the cache HIT count; **`cache_creation_input_tokens`** is the cache WRITE count. Cache hit rate = `cached_tokens / prompt_tokens` for the same call. Aggregating: sum both numerators and denominators across calls first, then divide.
- **`duration` is wall-clock for that single model call** (ms). Sum of `duration` across requests is total model time, which is usually less than total session wall time (which also includes tool execution and human think time).
- **`timeToFirstToken`** is part of `duration`, not on top of it.
- **`tool/runSubagent`** as `metadata` is irrelevant — what matters is the **request `name` field** being `"tool/runSubagent"`. When you see that, the prompt was spawned by a sub-agent invocation. The digest flags such prompts with `isSubagent: true`, and resolves the full parent ↔ subagent linkage on `prompts[].spawnedBy` (the `runSubagent` toolCall ref that spawned this subagent) and `prompts[].spawnedSubagents` (which subagents this prompt fanned out into). Use that linkage when answering "what did the subagents do?" questions — do NOT eyeball it from prompt ordering.
- **Subagent caches are isolated from the parent.** Each subagent runs in its own process and only inherits Anthropic's cross-session system-prompt cache (typically ~15–20K cached tokens on the very first call). Results flow back as plain text into the parent's prefix; the rich intermediate work (raw file reads etc.) is discarded. High intra-subagent hit rates (90%+) are normal and do not mean the parent benefited.
- **A `toolCall` log's `id` matches a `toolCallId` on a later tool-role message** in a subsequent request. That's how you reconstruct the chain "model decided X → called tool → got result → next request sees the result."
- **The prompt cache is keyed on `(model, prefix)`.** Switching models inside a conversation invalidates the entire prior cache — the new model starts from a cold prefix and pays full `cache_creation` rates again. The same key rule means cross-subagent cache reuse only works when sibling subagents are on the same model. When answering "what if we'd run on model X" questions, account for a cold-start cache write at the switch point, not just the per-token rate swap.
- **Conversation roles are integers, not strings.** 0=system, 1=user, 2=assistant, 3=tool.
- **`completion_tokens` UNDER-REPORTS when extended thinking is on.** Copilot exports set `tokens: 0` on every thinking block and `completion_tokens_details.reasoning_tokens: 0` on every request, even when the response clearly contains thinking output. So `rollups.cost.*` is a LOWER BOUND for Anthropic models. The digest estimates the gap in `rollups.thinking` (raw byte counts of distinct thinking events) and `rollups.cost.thinkingUnderCount` (output-rate cost of plaintext thinking). Encrypted thinking blobs ride on the input side and are heavily cache-amortized, so the output-side plaintext is the dominant missing cost.
- **A large `completionTokens` does not mean the model "wrote a lot to the user."** Tool-call arguments (the JSON / code body emitted into a tool call) are counted in `completion_tokens`. For implementation-heavy prompts, 80–95% of output bytes can be tool-call payloads (`rollups.toolCallPayloads`), with visible assistant text in the single digits. Caveman-style output reduction only addresses the visible-text slice.

## The digest schema (what `digest.mjs` produces)

```
{
  session: {
    digestVersion, generatedAt, sourceFile, sourceSizeBytes, sourceMtimeMs,
    exportedAt, totalPromptsClaimed, totalLogEntriesClaimed
  }
  rollups: {
    prompts, requests, toolCalls,
    totalTokens, promptTokens, completionTokens,
    cachedTokens, cacheCreationTokens, cacheHitRate,
    primaryModel, modelCount, toolCount, fileCount,
    totalRequestDurationMs, wallSpanMs, firstTime, lastTime,
    ttftMs: { p50, p95, max },
    requestDurationMs: { p50, p95, max },
    cost: {
      totalUsd,            // sum across all priced requests
      withoutCacheUsd,     // hypothetical cost if every input token were fresh
      savingsUsd,          // withoutCacheUsd - totalUsd
      savingsRatio,        // savingsUsd / withoutCacheUsd
      pricingVersion,      // e.g. "2026-05" — when rates were last refreshed
      currency,            // "USD"
      allModelsPriced,     // false if any model was unknown to the price table
      credits: {           // GitHub AI Credits view (UBB, post-2026-06-01). 1 credit = $0.01
        total, withoutCache, savings,
        perUsd,            // 100
        billingModel       // "github-ai-credits-ubb-2026-06-01"
      },
      thinkingUnderCount: { // applies=true when extended thinking detected; output-side gap estimate
        applies,
        approxMissingOutputTokens,   // ceil(distinct plaintext chars / 4)
        approxMissingUsd,            // approxMissingOutputTokens × primary model outputPerM / 1e6
        approxMissingCredits,        // USD × 100
        note
      }
    },
    toolDefs: {
      approxTokensTotal,        // sum across requests of ceil(JSON.stringify(metadata.tools).length / 4)
      approxShareOfPromptTokens, // approxTokensTotal / promptTokens — share of input budget spent re-sending schemas
      approxFullPriceUsd,       // worst-case: all tool-def tokens billed as fresh input
      note
    },
    toolCallPayloads: {         // output-side mirror of toolDefs
      approxTokensTotal,        // ceil(totalToolArgsChars / 4) — bytes emitted into tool-call args
      approxShareOfCompletion,  // approxTokensTotal / completionTokens
      approxFullPriceUsd,       // worst-case at primary model's output rate
      visibleTextApproxTokens,  // user-visible assistant text — the caveman-addressable portion
      note
    },
    thinking: {                 // Anthropic extended thinking, deduped by plaintext text
      present,                  // true if any thinking block was found anywhere
      totalBlocks,              // raw count incl. prefix carries (one event re-appears N times)
      distinctEvents,           // unique thinking events by .text
      plaintextChars,           // sum across distinct events
      plaintextTokensApprox,    // ceil(plaintextChars / 4)
      encryptedChars,           // sum of encrypted blobs across distinct events
      encryptedTokensApprox,    // ceil(encryptedChars / 4)
      note
    },
    errors: {
      toolCallErrors,      // tool responses flagged by heuristic (starts with Error:/Failed, contains <error>, has "error":)
      promptsWithErrors    // count of prompts with at least one tool-call error
    },
    cacheAnomalies: {      // requests that started essentially cold despite a non-trivial prefix
      count,
      thresholdHitRate,    // = 0.5; below this counts as anomaly
      minPromptTokens,     // = 5000; below this counts as trivial and is ignored
      items: [{
        ref, t, model,
        promptTokens, cachedTokens, cacheCreationTokens, cacheHitRate,
        cacheWriteUsd, cacheWriteCredits,   // ≈ cost to re-warm the prefix
        toolDefsApproxTokens,
        causes              // ["first call for model in session" | "tool-defs-changed (Δ ±N tokens)" | "time-gap (~N min since prior request, cache likely evicted)" | "unknown"]
      }],
      note
    }
  }
  pricing: {                   // resolved rates the digest used + the full embedded table
    version, currency,
    creditsPerUsd,             // 100 — 1 GitHub AI Credit = $0.01 USD
    billingModel,              // "github-ai-credits-ubb-2026-06-01"
    monthlyAllowances,         // { proMonthly, proPlusMonthly, businessMonthly, enterpriseMonthly } with creditsPerMonth and promoFirst3Months
    resolved: [{ model, matched, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM }],
    table:    [{ match, inputPerM, outputPerM, cacheReadRatio, cacheWriteRatio }]
  }
  models: [{
    name, calls, promptTokens, completionTokens, cachedTokens, cacheCreationTokens, durationMs,
    costUsd, freshInputUsd, cachedReadUsd, cacheWriteUsd, outputUsd,
    withoutCacheUsd, savingsUsd, savingsRatio,
    toolDefsApproxTokens, toolDefsApproxFullPriceUsd,
    priced, priceMatch        // priced=false means no rate found, costs will be 0
  }]
  tools:  [{ name, calls, errors, firstRef }]
  files:  [{ path, reads, writes, lists, firstRef }]
  mcpServers: [{ label, command, type, version }]
  prompts: [{
    ord, ref, promptId, promptText, promptPreview, logCount,
    requestCount, toolCallCount, models, tools, filesTouched,
    promptTokens, completionTokens, cachedTokens, cacheCreationTokens, durationMs,
    costUsd, withoutCacheUsd, savingsUsd,
    credits, creditsWithoutCache,
    toolDefsApproxTokens,
    toolErrorCount, hadError,
    finalAssistantPreview,    // last assistant text from the last request, truncated to 800 chars
    firstTime, lastTime, isSubagent,
    spawnedBy,                // ref of the parent's runSubagent toolCall (e.g. "p2.l1") if isSubagent, else null
    spawnedSubagents          // [{ toolCallRef, subagentRef, description }] - empty if this prompt did not spawn any
  }]
  timeline: [
    // request rows carry full cost decomposition + tool-defs accounting + assistant preview
    {
      ref, t, kind:"request", requestType, name, model, ms, ttftMs,
      promptTokens, completionTokens, cachedTokens, cacheCreationTokens, freshInputTokens,
      cacheHitRate,
      costUsd, freshInputUsd, cachedReadUsd, cacheWriteUsd, outputUsd,
      withoutCacheUsd, cacheSavingsUsd,
      credits, creditsWithoutCache, cacheSavingsCredits,   // USD * 100, rounded to 0.1 credit
      messageCount, toolCallsAdvertised,
      toolDefsCount, toolDefsJsonBytes, toolDefsApproxTokens,
      toolDefsApproxFullPriceUsd, toolDefsApproxFullPriceCredits,
      assistantTextPreview     // truncated to 240 chars
    },
    // toolCall rows include args/response previews and an error flag
    {
      ref, t, kind:"toolCall", tool, toolCallId, file,
      argsPreview,             // truncated to 240 chars
      response: { kind, bytes, hasError, preview }
    }
  ]
}
```

### How costs are computed and reported

The digest embeds a small pricing table (mirrored from `src/lib/pricing.js`) and applies the standard Anthropic / OpenAI three-bucket model for every request:

```
fresh_input = max(0, prompt_tokens - cached_read - cache_creation)
cost = fresh_input  × input_rate
     + cached_read  × cache_read_rate     (Anthropic default: 10% of input)
     + cache_create × cache_write_rate    (Anthropic default: 125% of input)
     + completion   × output_rate
```

`withoutCacheUsd` is the same call billed as if no caching existed: `prompt_tokens × input_rate + completion × output_rate`. The difference is the cache savings.

When citing cost, mention `rollups.cost.pricingVersion` and note that rates are list prices — actual invoices may differ for enterprise / committed-spend agreements. If `allModelsPriced` is `false`, call that out: some calls were silently treated as $0 because the model name was not in the table.

### GitHub AI Credits (UBB, post-2026-06-01)

GitHub Copilot moved from Premium Request Units (PRUs) to **AI Credits** under **Usage-Based Billing** on **June 1, 2026**. **1 AI Credit = $0.01 USD.** Token-based: every chat/CLI/agent/cloud-agent call burns credits proportional to tokens consumed across input, output, and cache.

The digest expresses this directly so you don't have to convert in your head:

- `rollups.cost.credits.total` — credits the whole session would burn
- `rollups.cost.credits.withoutCache` and `.savings` — credits saved by the prompt cache
- `prompts[].credits` and `.creditsWithoutCache` — per-prompt credit cost
- `pricing.creditsPerUsd` (= 100) and `pricing.monthlyAllowances` — conversion + plan reference

**Always lead with credits when talking to the user about cost, and put the USD in parens.** That's how they're billed under UBB:

> *"This session burned about 19 credits ($0.19). Without the cache it would have been ~63 credits ($0.63)."*

Plan allowances (from `pricing.monthlyAllowances`, for context when the user asks "is that a lot?"):

| Plan | Monthly $ | Monthly credits | First-3-months promo |
|---|---|---|---|
| Pro | $10 | 1,000 | — |
| Pro+ | $39 | 3,900 | — |
| Business | $19/user | 1,900 | 3,000/user |
| Enterprise | $39/user | 3,900 | 7,000/user |

Inline ghost-text completions and Next Edit Suggestions are **not** billed against credits. Chat, CLI, agent mode, cloud agents, Code Review, Spark, and third-party coding agents **do** consume credits. The digest covers chat exports — every request in `timeline` is a credit-burning call.

**Model choice in VS Code Copilot Chat: Auto mode.** When the user runs Chat in Auto mode (the default for many users), a router picks the model on the first turn and sticks with it for the rest of the conversation. You **cannot** detect Auto from the export — `metadata.model` only shows whichever model the router resolved to. When discussing "could this have run cheaper on model X," frame it as a hypothetical routing choice at prompt 0, not as a turn-by-turn decision the user actively made. After turn 0 the user would have had to manually override per-turn, which most don't.

### Per-token credit math (for hypotheticals and savings estimates)

When the user asks "how much would saving N tokens be worth?", always go **token → USD → credits**, never token → credits directly:

```
credits = (tokens × rate_per_million / 1_000_000) × 100
        = tokens × rate_per_million / 10_000
```

Sanity anchors for Sonnet 4.6 (`outputPerM = 15`, `inputPerM = 3`):

| Tokens | Output cost | Input cost (fresh) |
|---:|---:|---:|
| 100 | ~$0.0015 / 0.15 cr | ~$0.0003 / 0.03 cr |
| 1,000 | ~$0.015 / 1.5 cr | ~$0.003 / 0.3 cr |
| 10,000 | ~$0.15 / 15 cr | ~$0.03 / 3 cr |

If a savings estimate for a handful of tokens lands in the multi-credit range, the math is wrong — recheck. A useful gut check: **1,000 Sonnet 4.6 output tokens ≈ 1.5 credits**.

Per-prompt `credits` and per-timeline `credits` are **rounded to 0.1 credit** in the digest. Any single change saving fewer than ~70 output tokens (or ~330 fresh input tokens) on Sonnet 4.6 will round to 0 in those fields — express such savings as fractional credits in your answer, not as "0".

### Hypotheticals and refs

`pricing.resolved[]` lists the rates the digest used for each model present; `pricing.table[]` is the full embedded price table. For "what would this cost on model X?" questions, recompute from the token fields (`promptTokens`, `cachedTokens`, `cacheCreationTokens`, `completionTokens`) against `pricing.table[]` rather than guessing rates.

**Refs** use the form `p<promptIndex>` for prompts and `p<promptIndex>.l<logIndex>` for individual log entries. Cite them when pointing at specific events so the user can trace back.

### Tool-definition accounting

Tool schemas re-sent on every request are often the largest single line item after the conversation prefix. The schema doc above covers the fields (`rollups.toolDefs.*` and per-request `timeline[*].toolDefs*`). The one tip not in the schema: **compare `rollups.toolDefs.approxFullPriceUsd` against `rollups.cost.totalUsd` to gauge what the cache is buying you** on tool defs specifically. Token counts are 4-char-per-token approximations (±20%).

## Drilling into the raw file

When the digest does not have what you need (full message contents, tool arguments, sub-agent decision-making, etc.), use `jq` with the ref. Examples:

```bash
# Fetch a single log entry by ref p2.l3
jq '.prompts[2].logs[3]' SRC

# The system message of a specific request
jq '.prompts[2].logs[3].requestMessages.messages[] | select(.role==0)' SRC

# Tool args for every tool call in prompt 3
jq '.prompts[3].logs[] | select(.kind=="toolCall") | {tool, args}' SRC

# Find the request whose response generated a specific toolCallId
jq --arg id "toolu_bdrk_01H4XWWZfUerGyZ2BYRahHSD" \
  '.prompts[].logs[] | select(.kind=="request") | select(.requestMessages.messages[].toolCalls[]?.id == $id)' SRC

# Cost estimate stub: prefer the digest's `rollups.cost.credits.total`
# (run digest.mjs first). Drop to raw token math here only if you need
# a custom slice the digest does not pre-compute.
jq '[.prompts[].logs[] | select(.kind=="request") | .metadata.usage]
   | { promptTokens: map(.prompt_tokens)|add,
       cachedTokens: map(.prompt_tokens_details.cached_tokens)|add,
       completionTokens: map(.completion_tokens)|add }' SRC
```

When you need to read a single message body that is long, project just `.content` and pipe through `jq -r` to render the strings.

## Common question patterns and recipes

| Question | Where to look |
|---|---|
| "How many of X?" (prompts, requests, tool calls, files) | `rollups` |
| "How long did it take?" | `rollups.wallSpanMs` vs `rollups.totalRequestDurationMs` |
| "Why was it slow?" | `rollups.requestDurationMs` percentiles; sort `timeline` by `ms` |
| "How much did it cost?" | `rollups.cost.credits.total` (lead with credits, USD in parens); per-prompt `credits`; per-model `costUsd` × 100. Compare to `credits.withoutCache` for savings. Per-request split lives on every `timeline` request row (multiply any `*Usd` by 100 to get credits). If `rollups.cost.thinkingUnderCount.applies` is true, add: "+ ~M credits hidden as extended-thinking output." |
| "How much did the model think?" | `rollups.thinking.{distinctEvents, plaintextTokensApprox, encryptedTokensApprox}`; per-prompt `thinkingEventCount` / `thinkingPlaintextTokensApprox`. Note these are LOWER BOUNDS because the export sets `tokens:0` on every block. |
| "How much of output was tool-call payloads vs visible text?" | `rollups.toolCallPayloads.{approxTokensTotal, visibleTextApproxTokens, approxShareOfCompletion}`; per-prompt `toolCallArgsApproxTokens` / `visibleTextApproxTokens`. |
| "Is that a lot of credits?" | Compare to `pricing.monthlyAllowances` — e.g. Pro = 1,000/mo, Business = 1,900/user/mo. |
| "How much of cost is tool definitions?" | `rollups.toolDefs.approxFullPriceUsd` (worst case) and `approxShareOfPromptTokens`. Per-call: `timeline[*].toolDefsApproxFullPriceUsd`. |
| "What would this cost on model X?" | Recompute with rates from `pricing.table[]` against the token fields (`promptTokens`, `cachedTokens`, `cacheCreationTokens`, `completionTokens`) on each request. |
| "Was caching working?" | `rollups.cacheHitRate` + per-prompt `cachedTokens / promptTokens`. Per-call: `timeline[*].cacheHitRate` and `cacheSavingsUsd`. |
| "Was there a cold-start or cache miss anywhere?" | `rollups.cacheAnomalies.items` — each entry has the ref, hit rate, cache-write credits paid to re-warm, and a `causes` hint (tool-defs delta, time-gap, or first-call). Cold starts on large prefixes are usually the single biggest single cache lever in a run. |
| "Which prompts were sub-agents and who spawned them?" | `prompts[] where isSubagent` for the list. For each, `spawnedBy` is the parent's `runSubagent` toolCall ref. For the inverse view, parents carry `spawnedSubagents` with `{ toolCallRef, subagentRef, description }`. Never infer subagent parentage from prompt ordering alone. |
| "Did anything fail?" | `rollups.errors`; per-prompt `hadError` / `toolErrorCount`; per-tool `tools[].errors`; per-call `timeline[*].response.hasError`. |
| "What did the agent say at the end of prompt N?" | `prompts[N].finalAssistantPreview` (truncated to 800 chars); per-request preview at `timeline[*].assistantTextPreview` (240 chars). |
| "What did tool Y do?" | `timeline[*].argsPreview` and `timeline[*].response.preview` on toolCall rows. Drop to raw file via the ref for the full body. |
| "What files did it touch?" | `files[]` |
| "What did it do first / last?" | `timeline[0]` / `timeline[-1]`, or first/last entry per prompt |
| "Why did the model decide to do X?" | Find the relevant request via timeline, then drill into `requestMessages.messages` for that request |
| "What was in the model's context when it called tool Y?" | Find the request whose response advertised the toolCall id; read its `requestMessages.messages` |

## House rules

- Cite refs (`p2.l3`) when pointing at specific events so the user can trace back.
- When the digest's number disagrees with the user's intuition, double-check by computing from the raw file before pushing back.
- Do not invent fields. The schema above is complete as of digest version 7. If something seems missing, peek at the raw file and tell the user it is not in the digest.
- **When extended thinking is detected (`rollups.thinking.present` true), always disclose it in cost discussions.** The headline credits number from `rollups.cost.credits.total` is a LOWER BOUND. Add the gap from `rollups.cost.thinkingUnderCount.approxMissingCredits` and frame it: "this run used extended thinking, so the real billed output is roughly headline + ~M credits hidden in plaintext reasoning." Encrypted thinking blobs are input-side and largely cache-amortized; don't add them on top.
- Do not write the digest into git history. The sidecar lives next to the source file in `.agentviz/`.

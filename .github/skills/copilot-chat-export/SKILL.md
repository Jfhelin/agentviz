---
name: copilot-chat-export
description: Analyze a VS Code Copilot Chat "Export all prompts" JSON file. Use for questions about measured token usage, cache behavior, output attribution, tools, files, model cost estimates, or parent/subagent threads.
user-invocable: true
---

# Copilot Chat Export Analysis

Analyze VS Code Copilot Chat exports without launching AGENTVIZ or exposing the file to an external service.

## Run

From the repository root:

```bash
node .github/skills/copilot-chat-export/scripts/digest.mjs /absolute/path/to/copilot_all_prompts_*.json
```

The command writes a sidecar at:

```text
<export-directory>/.agentviz/<export-basename>.digest.json
```

Use `--stdout` to print JSON without writing a sidecar and `--force` to bypass the mtime/version cache. Require the user to provide or confirm the export path. Do not search personal directories or commit exports and digests.

## Analysis contract

Lead with `rollups.measuredUsage`. Those values are sums of the export's request-level `metadata.usage` fields and are the authoritative headline:

- `promptTokens`
- `completionTokens`
- `cachedTokens`
- `cacheWriteTokens`
- `freshTokens`
- `totalTokens`

Keep every derived value labeled:

- `rollups.estimatedCost` uses the live repository rate table in `src/lib/pricing.js`. Unknown models remain unpriced.
- `rollups.outputAttribution.rawApprox` uses character estimates except when the export reports reasoning-token detail.
- `rollups.outputAttribution.reconciled` is an exact partition of measured completion tokens across `visible`, `reasoning`, `toolArguments`, and `unattributedResidual`.
- `rollups.supplemental.runSubagent` estimates parent-side subagent prompt/result size. It is always excluded from headline usage and cost because matched child request usage is already measured in the export.

Never add supplemental estimates to measured totals. Never describe estimated attribution as tokenizer-accurate.

## Export semantics

The top-level `prompts[]` array contains user and subagent threads. Each prompt has interleaved logs:

- `kind: "request"` is an LLM request with its full input snapshot, response, model, and measured usage.
- `kind: "toolCall"` is a tool invocation and result.
- The tool calls after a request and before the next request are attributed to that request's output.
- `requestMessages.messages` is a full prefix snapshot, not a delta.
- Message roles are numeric: system `0`, user `1`, assistant `2`, tool `3`.

Cache namespaces are model-specific. The digest only flags an unexpected miss when a same-model predecessor exists, the model did not just switch, the predecessor had more than 1,000 prompt tokens, and the current request reports zero cached tokens. Tool-definition diffs and a possible five-minute TTL gap are diagnostic hints, not proof.

Subagent linkage is deterministic:

1. A `runSubagent` tool call supplies `args.prompt`.
2. A child prompt is identified by a request named `tool/runSubagent`.
3. Full normalized prompt text must match. Prefix/fuzzy matches are not used.
4. Unmatched calls remain visible in `unresolvedRunSubagentCalls`.

## Output attribution

For each request, the digest derives:

- **Visible:** strings in `response.message`.
- **Reasoning:** `completion_tokens_details.reasoning_tokens` when nonzero; otherwise distinct emitted thinking text at roughly four characters per token.
- **Tool arguments:** serialized arguments of tool calls emitted before the next request, at roughly four characters per token.
- **Unattributed residual:** measured completion tokens not covered by those categories.

If raw estimates exceed measured `completion_tokens`, the digest proportionally reconciles the three estimated categories. The reconciled categories plus residual always equal the measured total. Do not revive the historical assumption that visible thinking text is necessarily unreported billing; the current digest treats measured completion usage as authoritative and exposes attribution uncertainty separately.

## Useful queries

```bash
# Headline measured usage, estimated cost, cache, and exact output partition
jq '.rollups | {measuredUsage, estimatedCost, cache, outputAttribution}' DIGEST

# Parent/subagent links and supplemental estimates
jq '{threads: .rollups.threads, supplemental: .rollups.supplemental.runSubagent, prompts: [.prompts[] | {ref, isSubagent, spawnedBy, spawnedSubagents}]}' DIGEST

# Requests with cache misses or unpriced models
jq '[.timeline[] | select(.kind == "request") | select(.cache.unexpectedMiss or (.costEstimate.priced | not))]' DIGEST

# Tool failures and file activity
jq '{errors: .rollups.errors, tools, files}' DIGEST
```

Use timeline refs such as `p2.l3` when citing individual events. Read the raw export only when the digest lacks the required full content.

## Default answer

For an open-ended request, report:

1. Export timestamp and prompt/request/tool-call counts.
2. Measured prompt, completion, cache-read, cache-write, and fresh tokens.
3. Estimated cost with pricing verification date and any unpriced request count.
4. Cache hit rate and unexpected misses.
5. Exact reconciled output partition, explicitly labeled as attribution derived from estimates.
6. Root/subagent thread counts and unresolved links.
7. Top tools and files, plus tool failures.

Do not include generated personal reports, plan allowance tables, hardcoded model rates, or assumptions about the user's filesystem.

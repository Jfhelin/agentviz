# What Actually Reduces Copilot Chat Cost in VS Code

A hands-on test report to understand practical cost-saving techniques for GitHub Copilot token-based billing.

We tested several common Copilot Chat cost-saving ideas in VS Code to separate techniques that materially reduce AI Credit consumption from techniques that only reduce small amounts of prompt prefix.

The short version: **model choice and agent behavior matter far more than trimming static prompt text**. Prefix-token savings are measurable, but usually too small to matter unless they also improve the agent’s path through the task.

> **Caveat up front.** This is an internal directional report, not a statistically complete benchmark. Every measurement here is N=1 on a single TypeScript test repository, one user, one workspace, one VS Code/Copilot Chat build, and one rate-card snapshot from May 2026. Treat directional findings as useful, exact percentages as illustrative, and policy changes as requiring follow-up validation.

---

## Contents

- [TL;DR](#tldr)
- [How to read the numbers](#how-to-read-the-numbers)
- [Three things to do today](#three-things-to-do-today)
- [Cost levers, ranked](#cost-levers-ranked)
- [Decision matrix](#decision-matrix)
- **Deep dives**
  1. [Enable Auto model selection](#1-enable-auto-model-selection)
  2. [Use a smaller model for routine tasks](#2-use-a-smaller-model-for-routine-tasks)
  3. [Trim unused MCP servers](#3-trim-unused-mcp-servers)
  4. [Shrink your always-on instructions](#4-shrink-your-always-on-instructions)
  5. [Scope context with `applyTo:` globs](#5-scope-context-with-applyto-globs)
  6. [Use Ask Mode for one-shot questions](#6-use-ask-mode-for-one-shot-questions)
- [What we didn't test, and why](#what-we-didnt-test-and-why)
- [Methodology](methodology.md) — separate file
- [Final recommendation](#final-recommendation)
- [Appendix — How to reproduce](appendix.md) — separate file

---

## TL;DR

The main finding is simple:

> **Model choice and agent behavior dominate static token trimming.**

In our VS Code Copilot Chat tests, the only techniques that produced clean, material savings were:

1. **Use Auto model selection where policy allows.**  
   For eligible requests, Auto applies a 0.9× AI Credit multiplier when it selects the same model a user would otherwise choose manually.

2. **Use smaller models for bounded, repetitive, easy-to-verify work.**  
   On our JSDoc workload, Haiku 4.5 cost 59% less than Sonnet 4.5 and produced equal-or-better judged output for this specific task.

The techniques that only reduce prompt prefix — trimming MCP servers, shrinking instructions, using Ask Mode, or relying on `applyTo:` scoping — either saved very little per call or failed to translate into reliable real-workload savings.

At Sonnet 4.5 input rates, trimming 1,000 uncached prompt tokens saves roughly **0.3 AI Credits**. But one extra primary model call, unnecessary tool loop, or confused agent path can cost several times more than that.

The right optimization target is not “shorter prompts.” It is:

> **Fewer wrong turns.**

Practical guidance:

- Use the cheapest capable model.
- Keep useful instructions.
- Remove irrelevant tools for hygiene, not as a primary cost lever.
- Measure real workflows rather than prompt length alone.

---

## How to read the numbers

This report mixes four types of evidence. They should not be interpreted the same way.

| Evidence type | Meaning |
|---|---|
| **Measured** | Derived from raw VS Code Copilot Chat exports. |
| **Mechanical** | Computed from rate-card or billing-rule behavior. |
| **Inferred** | Based on export inspection and observed behavior. |
| **Illustrative** | N=1 result; useful directionally, not statistically stable. |

Costs in this report are reported in **AI Credits (cr)**, the unit GitHub Copilot is moving to for billing.

For cost intuition, this report approximates:

> **1 AI Credit ≈ $0.01 USD equivalent**

---

## Summary table

Each row shows the technique’s effect under two different test conditions:

- **Hello world** — one minimal prompt, one minimal reply. This isolates prompt-prefix cost before the agent has taken any action.
- **Real workload** — the agent runs the task end-to-end. Cache state, tool choice, and behavioral drift dominate.

All hello-world prefix-tax numbers below assume Sonnet 4.5.

| # | Technique | Hello world | Real workload | Recommendation | Confidence |
|---|---|---:|---:|---|---|
| [1](#1-enable-auto-model-selection) | **Enable Auto model selection** | n/a — billing multiplier, not token effect | −10% per eligible request when Auto selects the same model | **Turn on where policy allows. Override when needed.** | High, billing-rule dependent |
| [2](#2-use-a-smaller-model-for-routine-tasks) | **Use a smaller model for routine tasks** | ≈ −67% per call from Sonnet 4.5 to Haiku 4.5 by rate card | **−59% cost and equal-or-better quality on JSDoc task** | **Use smaller models for bounded, repetitive work.** | Medium |
| [3](#3-trim-unused-mcp-servers) | Trim unused MCP servers | ±~308 tokens/call ≈ **±0.09 cr**; sign depends on slate composition, not tool count | Inconclusive; behavior dominated | Useful for slate quality, not primary cost control | Medium |
| [4](#4-shrink-your-always-on-instructions) | Shrink always-on instructions | −320 tokens/call ≈ **−0.10 cr** | Net **+13.9%** cost in this run | Do not shrink useful guidance for cost | Medium-low |
| [5](#5-scope-context-with-applyto-globs) | Scope context with `applyTo:` globs | Observed −509 tokens/call, but likely artifact | +82% cost in this run | Do not assume this reduces cost; inspect exports | Medium for tested build |
| [6](#6-use-ask-mode-for-one-shot-questions) | Use Ask Mode for one-shot questions | −1,178 tokens/call ≈ **−0.35 cr** when both runs cold | No reliable real-world saving observed | Pick mode for task fit, not token saving | Medium-low |

---

### Safe guidance

- Start with **model selection**. Use smaller models for bounded, repetitive, easy-to-check tasks.
- Enable **Auto model selection** where policy allows.
- Optimize instructions for **clarity and task success**, not raw token count.
- Keep MCP server lists relevant and well-described so the client's tool-selection slate stays composed of tools you actually want the agent to reach for. Do not position MCP trimming as a major cost lever.
- Measure real workflows, not just prompt length.
- Treat token savings and behavioral savings as different things.

### Avoid these claims

These claims are too broad or misleading:

- “Shorter instructions always save money.”
- “Ask Mode is cheaper.”
- “`applyTo:` reduces token cost.”
- “Output formatting is the main cost lever.”
- “Haiku is better than Sonnet.”
- “These percentages will generalize to every repo.”
- “Tokens in instructions are free.”

The better message is:

> Useful cached prefix tokens are usually cheaper than the extra iterations caused by missing guidance.

---

## Three things to do today

1. **Enable Auto model selection where policy allows.**  
   It is a low-friction cost lever for eligible requests and reduces organization-wide drift toward always using the most expensive model.

2. **Default routine work to a smaller model.**  
   Use Haiku 4.5 or GPT-5 mini for bounded, repetitive, easy-to-check tasks such as documentation, boilerplate, simple transformations, and summarization. Escalate to stronger models for debugging, architecture, security-sensitive work, and ambiguous multi-step tasks.

3. **Optimize instructions for behavior, not length.**  
   Do not remove useful repo guidance just to save a few hundred prefix tokens. Instead, remove stale or contradictory instructions and add concise guidance that prevents unnecessary exploration.

---

## Cost levers, ranked

From most reliable to least reliable:

| Rank | Cost lever | Why it matters |
|---:|---|---|
| 1 | **Choose the right model** | Biggest predictable impact. |
| 2 | **Avoid unnecessary agent iterations** | Biggest behavioral impact. |
| 3 | **Keep context useful and cacheable** | More important than making it tiny. |
| 4 | **Trim irrelevant tool/instruction prefix** | Real but usually small. |
| 5 | **Format output tersely** | Useful for UX; usually not the main cost lever. |

---

## Decision matrix

| Workload type | Suggested default | Why |
|---|---|---|
| JSDoc, comments, boilerplate | Haiku 4.5 / GPT-5 mini | Low-risk, easy to verify |
| Summarization of known files | Smaller model first | Usually bounded |
| Simple code transformations | Smaller model, escalate if needed | Cost-efficient and easy to check |
| Debugging failing tests | Sonnet / stronger model | Reasoning-heavy |
| Security-sensitive code review | Stronger model | Error cost is high |
| Multi-file architecture change | Stronger model or Auto | Planning and consistency matter |
| One-shot explanation | Ask Mode | UX fit, not primarily cost |
| Autonomous edits | Agent Mode | Workflow fit |

---

# Deep dives

Each deep dive follows the same structure:

1. What the technique claims to save.
2. What hello-world prefix measurement showed.
3. What the real workload showed.
4. What to take away.

The important pattern:

> Prefix-tax savings are real but small. Behavioral changes are larger and less predictable.

---

## 1. Enable Auto model selection

We did not A/B test Auto because its primary cost effect is a billing/routing rule rather than a token-count effect.

For eligible requests, Auto receives a **0.9× AI Credit multiplier** compared with manually selecting the same model. That means if Auto selects the same appropriate model a user would have chosen manually, the direct saving is **10%**.

The larger operational benefit is behavioral: Auto reduces the chance that broad populations default to the most expensive available model for routine work. At enterprise scale, that habit is likely more expensive than small differences in prompt prefix.

> **Caveat:** This recommendation assumes Auto is enabled for the relevant Copilot surface and that its model choice is acceptable for the workload. Users should still override when task risk, model capability, or customer policy requires a specific model.

### Takeaway

Turn on Auto model selection where policy allows. Override per prompt when there is a specific reason to use a particular model.

---

## 2. Use a smaller model for routine tasks

> **The headline win of this report.**

Smaller model selection is not a prefix-token technique. The prompt may be the same, but the rate card is different.

| Model | Input cost | Output cost | Hi-prompt cost, cold cache |
|---|---:|---:|---:|
| Sonnet 4.5 | $3/M tok | $15/M tok | ≈ **5.27 cr/call** |
| Haiku 4.5 | $1/M tok | $5/M tok | ≈ **1.76 cr/call** |
| GPT-5 mini | $0.25/M tok | $2/M tok | ≈ **0.44 cr/call** |

Mechanical deltas:

- Sonnet 4.5 → Haiku 4.5: **≈ −67% per call**
- Sonnet 4.5 → GPT-5 mini: **≈ −92% per call**

The open question is not whether the model is cheaper. It is whether the model is good enough for the task.

### Real workload: JSDoc task

Same prompt, same test repo, same files. Two clean exports.

| KPI | Sonnet 4.5 | Haiku 4.5 | Delta |
|---|---:|---:|---:|
| Total cost | 20.7 cr | 8.4 cr | **−59%** |
| Cost per LLM call | high | low | **−74%** |
| Output tokens | 5,760 | 7,544 | +31% |
| Primary LLM calls | 3 | 4 | +33% |
| Tool calls | 9 | 16 | +78% |
| Cache hit rate | 67% | 68% | flat |

Quality was hand-graded using a 5-axis rubric, blind to cost.

| Output dimension | Sonnet 4.5 | Haiku 4.5 |
|---|---:|---:|
| Code blocks produced | 16 | 24 |
| Completion | 67%, skipped 8 class declarations | **100%** |
| Per-block quality | 7/10 average | 8/10 functions, 3/10 classes |
| Total quality units | 11.2 q | 18.0 q, function-weighted |

Cost-quality grid:

| Model | Completion | Per-block quality | Total quality units | Cost | Quality per credit |
|---|---:|---:|---:|---:|---:|
| Sonnet 4.5 | 16/24 (67%) | 7.0/10 | 16 × 7 = **112** | 20.7 cr | **5.4 q/cr** |
| Haiku 4.5 | 24/24 (100%) | 6.3/10 | 24 × 6.3 = **151** | 8.4 cr | **18.0 q/cr** |

On this task, Haiku produced **roughly 3.3× more quality per credit** (18.0 ÷ 5.4).


### What this does and does not prove

This does **not** prove that Haiku is better than Sonnet.

It proves something narrower and more useful:

> Smaller models can be dramatically more cost-efficient on repetitive, bounded, low-judgment tasks.

The measured task was JSDoc generation. That is structured, easy to verify, and has a clear completion target. The result should not be generalized to debugging, architecture, security-sensitive review, or ambiguous multi-step work without further testing.

### What a clean follow-up test should measure

This test was relatively clean, but N=1 still matters.

A stronger follow-up would measure the same model comparison across:

- JSDoc generation
- Multi-file refactor
- Failing test debugging
- Security review
- Feature implementation
- Code explanation/summarization

The most important unknown is whether smaller-model iteration overhead grows on reasoning-heavy tasks.

### Takeaway

Use Haiku 4.5 or GPT-5 mini for bounded, repetitive, easy-to-verify work such as:

- Documentation generation
- Boilerplate
- Simple transformations
- Summarization
- Low-risk refactoring

Use stronger models for:

- Debugging
- Architecture
- Security-sensitive analysis
- Ambiguous multi-step tasks
- Work where a wrong answer is expensive to detect

The best default is not “always use the cheapest model.” It is:

> Use the cheapest capable model.

---

## 3. Trim unused MCP servers

### Test setup

The "full MCP set" condition had 182 tools available across Azure, GitHub, Playwright, and the built-in VS Code Copilot tools.

The "audited-down" condition removed the external MCP servers and kept only the 52 built-in tools.

On paper this looked like a large reduction in visible tool surface: **182 → 52**. The first surprise of this test is that *the model never sees those numbers.*

### What the model actually receives

Inspecting the raw exports showed two things that change how this technique should be evaluated:

**1. The client picks a small slate of tools and only sends those.**

| Available tools (settings) | Tools sent to the model |
|---:|---:|
| 52 (built-in only) | **26** |
| 182 (full MCP set) | **25** |

The available-tool count is not the count the model sees. The client selects ~25–26 tools per call regardless of whether the user has 52 or 182 enabled.

**2. Large MCP catalogs sit behind router tools, not inlined definitions.**

The Azure MCP server was reachable in both runs through a single router tool, `mcp_azure_mcp_ser_search`, with its own description in the export:

> "This is a hierarchical MCP command router. Sub commands are routed to MCP servers that require specific fields inside the `parameters` object. Set `learn=true` to discover available sub commands."

When the agent needs Azure tooling, it calls the router with `learn=true` to discover sub-commands, then issues the real call. The full Azure tool catalog is reachable but not inlined in the prefix. Cost only lands when the agent actually uses Azure capabilities — and it lands on those specific calls, not on every call in the session.

This is effectively **lazy tool loading at the protocol level**: enabling an MCP server adds a small router stub to the candidate pool; the catalog itself only enters the conversation if and when the agent asks for it.

### Hello world: minimal A/B

First-primary-call input tokens, Sonnet 4.5, prefix-tax only:

| Condition | Available tools | Tools in slate | First-call input tokens | First cold-call cost |
|---|---:|---:|---:|---:|
| Full MCP set | 182 | 25 | 17,217 tok | ≈ **5.17 cr** |
| Built-in tools only | 52 | 26 | 17,525 tok | ≈ **5.26 cr** |
| Delta | +130 tools | −1 tool | **−308 tok** | **≈ −0.09 cr on first cold call** |

The direction is the opposite of what the "fewer tools = smaller prompt" intuition predicts. The 182-tool run was 308 tokens *cheaper* per cold call.

The full delta traces to one tool. Diffing the two system prompts and tool definitions shows:

- A's slate included `explore_subagent`. B's slate did not.
- That one difference accounts for ~1,058 chars of tool-definition delta and a single 149-char preference line in the system prompt — together, the entire 308-token swing.

What appears to have happened: adding 130 more candidate tools to the pool **displaced one selected built-in tool** from B's slate. The selection algorithm seems budget-bounded. We can't see its internals, but the visible effect is that the *composition* of the slate changes when the candidate pool changes — even though the slate's *size* stays roughly constant.

In this test, runs were not even fully cold (first-call cache hit was 60–66%), so the effective per-call saving is smaller than the cold-prefix number suggests.

### Real workload: JSDoc task

Same task, full vs audited MCP set:

- Net cost was **+17.1%** in the audited condition.
- This moved in the opposite direction from the prefix-tax prediction.
- Cause: with a different selected slate, the agent picked a different path.

Behavioral drift swamped the small prefix saving — and the slate displacement above is itself part of that drift.

### Practical guidance

Do:

- Remove MCP servers that are broken, noisy, irrelevant, or actively misleading.
- Prefer fewer, better-described tools over large generic tool catalogs.
- Treat MCP trimming as a quality and reliability improvement.

Do not:

- Sell MCP trimming as a primary token-cost optimization.
- Assume "available tool count" maps linearly to prompt size.
- Remove useful tools purely to save a few hundred prefix tokens.
- Compare runs without checking whether the slate (the tools the model actually saw) changed.

### What a clean test would have measured

To isolate the prefix-tax effect cleanly, we would need:

- A task where the agent's tool-selection slate is provably identical across conditions.
- N≥3 runs to wash out behavioral variance.
- A baseline export confirming both conditions hit cold cache.

We did not get all three. The hello-world number, around **−0.09 cr/call**, is the best isolated estimate from this test, and even that turns out to reflect slate composition rather than raw tool-count effects.

### Takeaway

Audit MCP servers for **slate quality**, not for token cost.

The headline cost effect is small and goes the "wrong way" because of how VS Code Copilot Chat handles tool surfaces in this build:

- Available-tool count is not the count the model sees. The client selects a small slate (~25–26 tools per call in our test) regardless of how many MCP servers are enabled.
- Large MCP catalogs are reachable through router tools (e.g. `mcp_azure_mcp_ser_search`) rather than inlined definitions. Enabling an Azure MCP server costs roughly one router stub in the prefix, not the full catalog. Real cost only lands when the agent actually invokes the router.
- Adding more candidate MCP tools can **displace useful built-in tools** out of the selected slate. That is the real risk to flag — not tokens, but tool composition.

Other IDEs and surfaces likely behave differently. Assume a different shape until you have inspected the export.

The first-order benefit of trimming MCP servers is therefore helping the agent pick the right tool quickly, keeping the slate composed of tools you actually want it to reach for, and reducing wrong-path drift. Token savings, if any, are a side effect.


---

## 4. Shrink your always-on instructions

### Hello world: minimal A/B

Cut the project’s `instructions.md` from baseline to a deliberately trimmed version. First-primary-call input tokens, Sonnet 4.5:

| Condition | First-call input tokens | First cold-call cost |
|---|---:|---:|
| Baseline | 17,580 tok | ≈ **5.27 cr** |
| Trimmed | 17,260 tok | ≈ **5.18 cr** |
| Delta | **−320 tok, −1.82%** | **≈ −0.10 cr/call** |


This is the same order of magnitude as the MCP audit hello-world result. Instructions were only a small fraction of the prompt prefix. For subsequent calls that hit the prompt cache, only the uncached portion is billed at the full input rate; cached prefix tokens are billed at the lower cached-token rate.

### How we compressed the instructions

For this test, we compressed `copilot-instructions.md` using purely subtractive edits. The goal was to match the source guide’s suggested “40–60% fewer instruction tokens” target without rewriting the actual rules or adding new guidance.

The file shrank from **2,975 to 1,541 characters**, a **48% reduction**. We removed section preambles, duplicated guidance, courtesy wording, redundant blank lines, repeated meta-instructions, and code-discoverable architecture descriptions. We kept the important landmines verbatim: custom error type names, build commands, walkthrough-writer skill guidance, the `applyTo` split convention, and other rules the agent could not reliably infer from code.

### Real workload: JSDoc task

Same task, baseline vs trimmed instructions:

| KPI | Baseline | Trimmed | Delta |
|---|---:|---:|---:|
| Total cost | low | higher | **+13.9%** |

The cost increase came from the agent doing more exploration with less guidance:

- More file reads
- More back-and-forth
- One extra primary LLM call

The trimmed instructions removed context the agent appeared to rely on.

The net cost increase was much larger than the prefix saving.

### Better framing

The wrong optimization target is:

> Shorter instructions.

The right optimization target is:

> Instructions that reduce avoidable agent work.

### Good instruction changes

Useful changes include:

- Remove stale or contradictory guidance.
- Replace verbose prose with precise rules.
- Add project-specific conventions that prevent exploration.
- Include known test commands, build commands, and repo layout.
- Add “do not touch” constraints that prevent unnecessary file reads.
- Keep examples that help the agent make fewer wrong turns.

### Bad instruction changes

Risky changes include:

- Removing useful repo context to save a few hundred tokens.
- Compressing guidance so much that it becomes ambiguous.
- Deleting examples the agent relies on.
- Removing task constraints that prevent unnecessary exploration.
- Optimizing for token count instead of task success.

### Confounds

Two confounds remain:

1. **Cache state**  
   The baseline run may have primed the cache for the trimmed run’s first call.

2. **N=1 behavioral effect**  
   The +13.9% increase comes from a single pair of runs.

A cleaner test would run N≥5 fresh-cache pairs and report median and spread.

### Takeaway

Do not shrink instructions for cost reasons.

Shrink instructions when they are:

- Confusing
- Redundant
- Contradictory
- Stale
- Too vague to guide the agent

Keep useful instructions even if they add a few hundred prefix tokens. Useful cached prefix tokens are usually cheaper than the extra iterations caused by missing guidance.

---

## 5. Scope context with `applyTo:` globs

### What this technique is supposed to do

Custom instruction files (`.github/instructions/*.instructions.md` in VS Code Copilot Chat) can carry an `applyTo:` front-matter glob. The intended behaviour:

- A file with `applyTo: "src/frontend/**"` is meant to apply only when the agent is working on files matching that glob.
- Files whose glob does not match the current task should be **excluded** from the agent's working set — and, critically, from the prompt that gets billed.

The cost claim being tested: scoping instruction files with `applyTo:` reduces tokens per call, because excluded files don't ride along in the system prompt.

### What we wanted to measure

Two questions, in this order:

1. **Does the mechanism exist?** When `applyTo:` says a file should be excluded, is that file's content actually absent from the exported prompt?
2. **If so, how much does it save?** Net cost difference per call between a "scoped" and "unscoped" configuration on a real task.

The cost question only matters if the answer to the first question is yes.

### Hello world: minimal A/B

We observed **−509 tokens per call** on the first primary call, approximately **−0.15 cr/call** at Sonnet 4.5 input rates.

But this appears to be an artifact, not a reliable saving mechanism — the clean test below shows there is no gating mechanism for the saving to come from.

### Real workload: JSDoc task

Net cost was **+82%** for the supposedly scoped condition.

Inspection of the raw exports showed the underlying mechanism does not behave as a token gate at all in this build — see "How we verified the mechanism" below.

Therefore, in this environment, `applyTo:` should not be treated as a reliable token-cost control.

### What this does and does not prove

This does not prove that `applyTo:` has no value as an authoring or routing convention.

It does suggest:

- Do not assume scoped instructions reduce token cost.
- Do not rely on `applyTo:` as a billing-control mechanism without export inspection.
- Verify the actual prompt before claiming savings.

### How we verified the mechanism

We placed two instruction files in the project, each containing a unique marker string, and gave each one an `applyTo:` glob that did not match the JSDoc task path. Both files should have been excluded from the working set.

We then ran the agent, exported the chat, and grepped the exported system prompt for the two marker strings.

Neither marker appeared anywhere in the export — not even from the file whose glob did overlap the task path. The instruction file contents were not in the prompt at all, gated or otherwise. With no contents in the prompt, there is nothing for `applyTo:` to gate, and the −509 token delta we observed earlier has no causal mechanism behind it.

### Takeaway

Do not assume `applyTo:` reduces token cost.

Verify any "scope your context" claim by exporting a real chat and inspecting whether the supposedly excluded content appears in the prompt.

The deeper methodology lesson:

> This test would have been a "skip — premise is wrong" verdict 30 minutes after the first export, with no A/B cost run needed at all.
>
> Always verify the mechanism exists before measuring its effect.

---

## 6. Use Ask Mode for one-shot questions

### What this technique is supposed to do

Ask Mode is a separate chat mode in VS Code Copilot Chat. The intent: a lighter-weight surface for one-shot questions — explanations, code reading, quick Q&A — that loads no tools and skips the agent scaffolding, and therefore costs less per call than Agent Mode.

### What we wanted to measure

Two questions:

1. **Is Ask Mode structurally lighter than Agent Mode** in current VS Code Copilot Chat — smaller prompt, no tool definitions, no tool use?
2. If so, **how much does it actually save per call**?

### Hello world: minimal A/B

Same one-shot question sent in Agent Mode vs Ask Mode, fresh chat in each:

| Condition | First-call input tokens | First cold-call cost |
|---|---:|---:|
| Agent Mode | 21,378 tok | ≈ **6.41 cr** |
| Ask Mode | 20,200 tok | ≈ **6.06 cr** |
| Delta | **−1,178 tok, −5.5%** | **≈ −0.35 cr/call** |

Ask Mode's first-call prefix is genuinely smaller — fewer tool definitions, slightly shorter system prompt — but the saving is modest: about 5%, not the order-of-magnitude difference the "lighter mode" framing suggests.

### Real workload: normal usage

In real usage, even this small structural saving is erased by cache asymmetry.

Anthropic's prompt cache is keyed on prefix bytes per API credential. Agent Mode and Ask Mode build different prefixes, so they get **independent cache entries**. In our test, even after restarting VS Code and starting a fresh chat:

- Agent Mode came up at ~50% cache hit on the first call.
- Ask Mode came up at ~14%, with the first primary call at 0%.

The reason: Agent Mode is the prefix the user already hammers every day, so its cache entry is continuously refreshed by ordinary work. Ask Mode prefixes are rarely warm because Ask Mode is, by design, used sporadically for one-shots.

Net effect on Pair 1 (single-call Q&A):

- Total cost A: **6.10 cr**
- Total cost B: **8.78 cr** (+44%)

Ask Mode pays roughly **50% more per token** in the cold-start single-call case. The structural −5.5% prefix saving is dwarfed by the cache penalty.

### The Ask Mode surprise: it is not a no-tools mode

The bigger structural finding came from a second test designed to *tempt* tool use — a cross-file exploration question:

| Mode | Tool calls | Distinct tools used |
|---|---:|---|
| Agent Mode | 14 | 3 |
| Ask Mode | **11** | **4** (added `semantic_search`) |

Ask Mode invoked `semantic_search`, `read_file`, and other tools to answer the question. There is no agent overhead being skipped at the prompt level — 98% of the system prompt is shared between the two modes — and Ask Mode will reach for tools when the question seems to need them.

In multi-call workloads like this one, the cache asymmetry shrinks (both runs hit ~86–91% cache mid-run), so total cost was within noise: 18.2 cr vs 19.1 cr.

### Practical guidance

Use Ask Mode when:

- You want to discourage edits without disabling them.
- You prefer the more conversational answer style.

Use Agent Mode when:

- You want autonomous edits or commands.
- You want to benefit from the warm prefix you've already built up today.

Do **not** pick Ask Mode expecting it to be cheaper, tool-free, or structurally different from Agent Mode. In the build we tested, it is essentially the same product surface with a slightly trimmed prompt and a colder cache.

### Takeaway

For both prompt designs we tested, Ask Mode and Agent Mode are functionally and economically equivalent.

The two modes share ~98% of the system prompt, Ask Mode loads only ~13–38% fewer tool definitions depending on call shape, and the cold-start cache penalty for Ask Mode can make it *more* expensive per call than Agent Mode for one-shot questions.

Pick the mode that fits the task, not the mode that "saves tokens."

The methodology lesson:

> First-call cache hit rate is one of the best indicators that a cost benchmark is contaminated — and that asymmetry is sometimes structural, not fixable.

---

## What we didn't test, and why

Six other ideas came up but were not measured. Each rejection is itself a finding.

| Technique | Why we didn't test |
|---|---|
| Code-only responses | Output tokens were 10–20% of total cost across our runs. Even an aggressive 50% output cut would shave 5–10% at most, and only on workflows that produce long prose. Not a primary lever for agentic coding tasks. |
| Bullets over paragraphs | Same ceiling as code-only responses — operates on the output share, which is 10–20% of cost in our data. May still be worth doing for readability, but should not be sold as a billing lever. |
| Be precise in prompts | Hard to isolate at N=1. Almost certainly one of the most important *behavioral* levers — precise framing reduces exploration, wrong edits, and clarification turns — but it shows up in path drift, not in token counts. Needs a separate task-suite evaluation with a quality rubric. |
| Retune prompts to target model | Requires a stable target model, a corpus of tasks, and a quality rubric independent of the model under test. Same N=1 problem as test #5 (Ask Mode) — model-specific tuning cannot be scored without controlling for what the model would have done untuned. |
| `/chronicle improve` weekly | Effect is on *future* sessions, not the one being measured. A one-off A/B has no observable signal; needs long-horizon evaluation across many real sessions. |
| CodeAct for long tool chains | Not exposed as a user-toggleable mode in VS Code Copilot Chat. No mechanism to A/B without forking the client. |

> Auto model selection was also not A/B tested — see deep dive [#1](#1-enable-auto-model-selection) for why it is a billing lever rather than a token-count lever, and what to expect from it.

The pattern:

- Many proposed token-saving techniques operate on parts of the request that do not drive most cost in agentic workflows. Input, cached context, and tool definitions dominate; the output share is small and behavioral drift swamps it.
- Some require infrastructure the user cannot control.
- Some may help UX or quality but should not be sold as primary billing levers.

---

# Methodology

The full methodology — tooling, units, workload rationale, the five traps, and the quality grading rubric can be found here
> [methodology.md](methodology.md).

This covers:

- Tooling and units (agentviz fork, AI Credits)
- What "hello world" and "real workload" mean
- The test workload (JSDoc on the OctoCat Supply demo) and why we chose it
- What the workload misses, alternatives we considered, and what an ideal test program would look like
- The five traps that contaminate Copilot cost benchmarks
- The quality grading rubric used in the model-comparison test

---

## Final recommendation

For Copilot token-based billing, the highest-value cost controls are not micro-optimizations of prompt text.

They are:

1. **Model routing**  
   Use Auto and smaller models where suitable.

2. **Task shaping**  
   Give the agent enough context to avoid wrong turns.

3. **Workflow fit**  
   Use Ask Mode for Q&A and Agent Mode for execution.

4. **Tool hygiene**  
   Keep MCP/tool surfaces relevant, not minimal.

5. **Measurement discipline**  
   Compare real exported runs and inspect cache state.

The practical message is:

> Do not look for “shorter prompts” as the main cost story. Ensure **right model, right task, right context, fewer iterations**.

---

## Appendix — How to reproduce

The full reproduction recipe — install command, test repo, prompts, raw exports, per-test writeups, and the run procedure can be found here:

> [appendix.md](appendix.md).

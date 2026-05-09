# What Actually Reduces Copilot Chat Cost in VS Code

A hands-on test report to understand practical cost-saving techniques for GitHub Copilot token-based billing.

We tested several common Copilot Chat cost-saving ideas in VS Code to separate techniques that materially reduce AI Credit consumption from techniques that only reduce small amounts of prompt prefix.

The short version: **model choice and agent behavior matter far more than trimming static prompt text**. Prefix-token savings are measurable, but usually too small to matter unless they also improve the agent’s path through the task.

> **Caveat up front.** This is an internal directional report, not a statistically complete benchmark. Every measurement here is N=1 on a single TypeScript test repository, one user, one workspace, one VS Code/Copilot Chat build, and one rate-card snapshot from May 2026. Treat directional findings as useful, exact percentages as illustrative, and policy changes as requiring follow-up validation.

---

## Contents

- [TL;DR](#tldr)
- [How to read the numbers](#how-to-read-the-numbers)
- [Field guidance for SEs](#field-guidance-for-ses)
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
- **Methodology**
  - [Tooling and units](#tooling-and-units)
  - [What "hello world" and "real workload" mean](#what-hello-world-and-real-workload-mean)
  - [The test workload](#the-test-workload--what-we-ran-and-why)
  - [The five traps](#the-five-traps)
  - [Quality grading rubric](#quality-grading-rubric-used-in-test-12)
- [Final recommendation](#final-recommendation)
- [Appendix — How to reproduce](#appendix--how-to-reproduce)

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
| [3](#3-trim-unused-mcp-servers) | Trim unused MCP servers | −308 tokens/call ≈ **−0.09 cr** | Inconclusive; behavior dominated | Useful for hygiene, not primary cost control | Medium |
| [4](#4-shrink-your-always-on-instructions) | Shrink always-on instructions | −320 tokens/call ≈ **−0.10 cr** | Net **+13.9%** cost in this run | Do not shrink useful guidance for cost | Medium-low |
| [5](#5-scope-context-with-applyto-globs) | Scope context with `applyTo:` globs | Observed −509 tokens/call, but likely artifact | +82% cost in this run | Do not assume this reduces cost; inspect exports | Medium for tested build |
| [6](#6-use-ask-mode-for-one-shot-questions) | Use Ask Mode for one-shot questions | −1,178 tokens/call ≈ **−0.35 cr** when both runs cold | No reliable real-world saving observed | Pick mode for task fit, not token saving | Medium-low |

---

### Safe guidance

- Start with **model selection**. Use smaller models for bounded, repetitive, easy-to-check tasks.
- Enable **Auto model selection** where policy allows.
- Optimize instructions for **clarity and task success**, not raw token count.
- Keep MCP server lists relevant and well-described, but do not position MCP trimming as a major cost lever.
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

The “full MCP set” condition included 182 available tools in total: Azure, GitHub, Playwright, and the built-in VS Code Copilot tools.

The “audited-down” condition removed the external MCP servers and kept only the 52 built-in tools.

So this was not a tiny cleanup. It was a large reduction in visible tool surface: **182 tools → 52 tools**.


### Hello world: minimal A/B

Run with full MCP server set vs audited-down set. First-primary-call input tokens, Sonnet 4.5, prefix-tax only:

| Condition | Available tools | First-call input tokens | First cold-call cost |
|---|---:|---:|---:|
| Full MCP set | 182 | 17,525 tok | ≈ **5.26 cr** |
| Built-in tools only | 52 | 17,217 tok | ≈ **5.17 cr** |
| Delta | −130 tools | **−308 tok, −1.83%** | **≈ −0.09 cr on first cold call** |


Tool definitions sit in the prefix of every primary call, so trimming unused MCP servers can reduce the uncached prefix size. However, after the prefix is cached, repeated calls against the same stable prefix are much cheaper — roughly 10% of the original input cost for cached tokens, depending on the model/provider pricing. That means the saving can still compound across a session, but mostly at the cached-token rate after the first call. In normal usage, the per-call saving is therefore even smaller than the cold-prefix number suggests.

In this test, the runs were not even fully cold: first-call cache hit was around 60–66%.

### Real workload: JSDoc task

Same task, full vs audited MCP set:

- Net cost was **+17.1%** in the audited condition.
- This moved in the opposite direction from the prefix-tax prediction.
- Cause: with a different tool set, the agent picked a different path on this single run.

Behavioral drift swamped the small prefix saving.

### Practical guidance

Do:

- Remove MCP servers that are unused, broken, noisy, or irrelevant to the workspace.
- Prefer fewer, better-described tools over large generic tool catalogs.
- Treat MCP trimming as a quality and reliability improvement first.

Do not:

- Sell MCP trimming as a primary token-cost optimization.
- Remove useful tools purely to save a few hundred prefix tokens.
- Compare runs without checking whether the agent took a different tool path.

### What a clean test would have measured

To isolate the prefix-tax effect cleanly, we would need:

- A task where the agent’s tool choice is provably unaffected by which MCP servers are present.
- N≥3 runs to wash out behavioral variance.
- A baseline export confirming both conditions hit cold cache.

We did not get all three.

The hello-world number, around **−0.09 cr/call**, is the best isolated estimate from this test. The real workload shows that agent path variance can easily exceed it.

### Takeaway

Audit MCP servers for hygiene, correctness, and tool-selection quality — not primarily for cost.

The prefix-tax saving is real but tiny for typical configurations. A very large MCP setup may matter more, but the first-order benefit is helping the model select the right tool quickly.

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

### Hello world: minimal A/B

We observed −509 tokens per call on the first primary call, approximately **−0.15 cr/call** at Sonnet 4.5 input rates.

But this appears to be an artifact, not a reliable saving mechanism — the clean test below shows there is no gating mechanism for the saving to come from.

### Real workload: JSDoc task

Net cost was **+82%** for the supposedly scoped condition.

More importantly, inspection of the raw exports showed that in the VS Code Copilot Chat build and configuration we tested, `applyTo:` did not behave as a hard cost gate for instruction files.

Inspection of the raw exports showed the underlying mechanism does not behave as a token gate at all in this build — see "How we verified the mechanism" below.

Therefore, in this environment, `applyTo:` should not be treated as a reliable token-cost control.

### What this does and does not prove

This does not prove that `applyTo:` has no value.

It does suggest:

- Do not assume scoped instructions reduce token cost.
- Do not rely on `applyTo:` as a billing-control mechanism without export inspection.
- Verify the actual prompt before claiming savings.

### How we verified the mechanism

We placed two instruction files in the project, each containing a unique marker string, and gave each one an `applyTo:` glob that did **not** match the JSDoc task path. Both files should have been excluded from the working set.

We then ran the agent, exported the chat, and grepped the exported system prompt for the two marker strings.

**Neither marker appeared anywhere in the export** — not even from the file whose glob *did* overlap the task path. The instruction file contents were not in the prompt at all, gated or otherwise. With no contents in the prompt, there is nothing for `applyTo:` to gate, and the −509 token delta we observed earlier has no causal mechanism behind it.

### Takeaway

Do not assume `applyTo:` reduces token cost.

Verify any "scope your context" claim by exporting a real chat and inspecting whether the supposedly excluded content appears in the prompt.

The deeper methodology lesson:

> This test would have been a "skip — premise is wrong" verdict 30 minutes after the first export, with no A/B cost run needed at all.
>
> Always verify the mechanism exists before measuring its effect.

---

## 6. Use Ask Mode for one-shot questions

### Hello world: minimal A/B, both runs cold

Same one-shot question sent in Agent Mode vs Ask Mode. Both runs forced to cold cache.

| Condition | First-call input tokens | Cost per call, cold |
|---|---:|---:|
| Agent Mode | 21,378 tok | ≈ **6.41 cr** |
| Ask Mode | 20,200 tok | ≈ **6.06 cr** |
| Delta | **−1,178 tok, −5.5%** | **≈ −0.35 cr/call** |

Ask Mode is genuinely cheaper at hello world:

- Smaller system prompt
- Fewer tool definitions in the prefix
- Lower first-call input token count

This is the largest hello-world saving of any prefix-tax technique we tested.

### Real workload: normal usage

In real usage, the cost difference was not reliable.

The reason appears to be cache asymmetry.

Agent Mode and Ask Mode have different prefix bytes, so they have independent cache entries. Agent Mode prefixes are more likely to stay warm because users issue many Agent Mode calls in a tight sequence. Ask Mode is more often used for occasional one-shot questions, making its first call more likely to be cold.

The mechanism observed in raw exports:

> Per-prefix-bytes, per-credential cache, approximately 5-minute TTL.

Both modes request caching the same way. The asymmetry is usage-pattern driven, not a configuration the user can fix.

### Practical guidance

Use Ask Mode when:

- You want explanation, Q&A, code reading, or a one-shot answer.
- You do not need autonomous edits.
- You want less tool-driven behavior.

Use Agent Mode when:

- You want the agent to inspect files.
- You want the agent to modify code.
- You want the agent to run commands.
- You expect a multi-step task.

### Takeaway

Pick the mode that fits the task, not the mode that “saves tokens.”

Ask Mode can have a smaller first-call prefix, but the absolute saving is small and cache behavior can erase it in real use.

The more durable finding is methodological:

> First-call cache hit rate is one of the best indicators that a cost benchmark is contaminated.

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

This section is for people who want to reproduce the work, debug similar measurements of their own, or pressure-test the methodology.

---

## Tooling and units

### Tooling

All measurements come from VS Code Copilot Chat exports:

```text
copilot_all_prompts_*.json
```

These exports were loaded into a local fork of:

```text
jayparikh/agentviz
```

Fork:

```text
Jfhelin/agentviz
```

Branch:

```text
jfhelin/cost-compare-instrumentation
```

The fork adds:

- A **Cost view** that breaks each call down by prefix bucket:
  - system
  - tool definitions
  - history
  - current prompt
  - tool results
  - output
- A **Cost Compare** tab that pins two runs side-by-side.
- Pre-vs-post divergence cost split.
- Projected prefix tax over each run’s actual call shape.
- Drift detection for:
  - prompt hash
  - system prompt hash
  - model
  - tool set
  - turn count
- Per-model cache-aware pricing via:

```text
src/lib/pricing.js
```

Pricing data was refreshed against official Anthropic, OpenAI, and GitHub Copilot rate cards in May 2026.

Exports are deterministic JSON. Numbers in this report are computed from raw token counts in the export, not estimated by an LLM.

---

## What "AI Credits" means

Cost numbers are reported in **AI Credits (cr)**, the unit GitHub Copilot is moving to for billing.

For intuition, this report approximates:

```text
1 cr ≈ $0.01 USD equivalent
```

A 20 cr task is therefore roughly equivalent to $0.20 of underlying spend in this framing.

---

## What "hello world" and "real workload" mean

A **hello world** measurement is the prefix-tax delta on the first primary LLM call of a run with the technique toggled on or off.

It is the cleanest possible cost number because it is path-independent:

- The agent has not made decisions yet.
- No tool path has diverged yet.
- The only difference should be whatever bytes the technique changed in the prompt prefix.

Cost Compare reports this as the input token count of the first primary call.

We express this as **AI Credits per call** at the Sonnet 4.5 rate card:

```text
$3/M input tokens
$15/M output tokens
≈ 0.30 cr per 1,000 uncached input tokens
```

Hello world is useful for techniques that change prompt prefix:

- Dropping MCP servers
- Shrinking instructions
- Switching mode
- Changing system/tool prompt shape

The other extreme is the **real workload** measurement, where the agent runs end-to-end and behavior dominates:

- Tool calls
- Extra LLM calls
- Cache state
- File reads
- Wrong turns
- Output length
- Task completion

Comparing the two tells us whether a technique that “works” in isolation actually saves money in real use.

For techniques that do not change prefix, such as Auto model selection or smaller-model choice, hello world is not the right frame. Those have to be evaluated through rate-card, billing-rule, or real workload behavior.

---

## The test workload — what we ran and why

Every measurement in this report comes from variations of one workload:

> **Add JSDoc to every exported symbol in `api/src/repositories/`.**

The task was run against the standard **OctoCat Supply Platform Demo** repo:

- TypeScript
- Approximately 8 small repository files under:

```text
api/src/repositories/
```

- Approximately 24 export-worthy symbols

For each condition, we sent that prompt, or a near-variant, in a fresh VS Code Copilot Chat session, exported the chat as JSON, and loaded the export into agentviz Cost Compare.

---

## Why this workload

We needed a task with these properties:

### Bounded scope

A known set of files and a known list of exported symbols means we can count completion deterministically.

Example:

```text
16 of 24 expected blocks
```

Without a closed scope, every “did the AI do the task?” judgment becomes subjective.

### Deterministic and judgment axes

The task allows both:

- Hard measurement:
  - block count
  - completion ratio
  - files touched
- Quality judgment:
  - correct types
  - useful descriptions
  - behavior captured
  - brevity
  - edge cases

This lets us compare cost and quality on the same task.

### Multi-file exploration

The task forces the agent to inspect multiple files, so it exercises the parts of cost that matter in Copilot Chat:

- Tool calls
- File reads
- Context buildup
- Agent planning
- Model calls

---

## What this workload misses

The workload is useful for screening, but it is not enough for policy.

### Highly templated, low judgment

JSDoc generation under-exercises the hardest parts of agent behavior:

- Multi-step reasoning
- Debugging
- Design trade-offs
- Refactoring judgment
- Security analysis

Techniques whose value is mostly “make the model think better” may not show their full effect here.

### Single task class

We do not know whether findings generalize to:

- Large refactors
- Failing test debugging
- Code review
- Open-ended feature work
- Security remediation
- Generated tests

The Haiku win is especially task-shape dependent.

### Small repo

File counts and context size are modest.

Effects that scale with codebase size may look compressed here:

- MCP server overhead at 10+ servers
- Instruction files at 50KB+
- Large monorepo context
- Multi-language workspaces

### One-shot, no persistent state

Each run starts fresh. We did not measure techniques that depend on cross-session memory or learned context.

---

## Alternatives we considered

| Alternative | Why we didn't use it |
|---|---|
| Replay a real PR, issue to produced fix | Most realistic, but high setup cost and hard to grade equivalently across models. |
| Multi-file refactor | Better stress test for tool chains, but completion criteria are fuzzy. |
| Debug a failing test | Exercises reasoning hard, but pass/fail is binary and loses quality gradient. |
| Code review of an existing PR | Pure judgment, no objective grade. Useful follow-up, not a baseline. |
| Pre-recorded transcript replay | Removes behavioral variance, but is not supported by the tooling and would test a different system than users actually run. |

The JSDoc workload is good for technique screening.

It is not sufficient for deciding broad policy.

A finding that survives this workload deserves follow-up on a debugging or refactor task before being adopted as a team-wide default.

---

## What an ideal test program would look like

If we were doing this again with more time:

- A task suite of 4–6 workloads:
  - JSDoc generation
  - Multi-file refactor
  - Failing test debug
  - Code review
  - Feature add
  - Security remediation
- N≥3 runs per condition.
- Cold-cache enforcement.
- Median and spread, not only single numbers.
- A second test repository of different size and language.
- Independent quality grading.
- Blind double-grading for outputs.
- Explicit product-build and extension-version capture.

We did not do this.

Treat the report accordingly:

- Directional findings are useful.
- Exact percentages are illustrative.
- Low-cost, high-reversibility actions are reasonable to try.
- Team-wide defaults deserve more validation.

---

## The five traps

These bit repeatedly during testing.

Anyone running similar measurements will likely hit them too.

---

### Trap 1 — Cache pollution makes everything look great

The biggest source of bad measurements.

Anthropic prompt caching warms a prefix for approximately 5 minutes after each hit. If the before run primes the cache and the after run runs immediately after, the after condition can look 70–90% cheaper purely from cache hits.

That does not mean the technique saved money.

#### Symptom

First primary call shows high cache hit rate, especially above 40%.

#### Fix

Force cold cache for both runs:

- Use different prefix bytes.
- Wait out the TTL.
- Start each run from a fresh chat.
- Select the model before the first prompt.
- Inspect first-call cache hit rate before trusting the comparison.

---

### Trap 2 — Prefix tax projection vs measured net cost

Two valid numbers exist for every before/after change:

| Number | Meaning |
|---|---|
| Prefix tax delta | How many fewer input tokens the new prefix carries on each call. |
| Net cost delta | What was actually paid across all calls in the full run. |

These can disagree dramatically.

Example from the instruction trimming test:

- Prefix tax saving was real.
- Net cost increased because the agent did more exploration.

Always report both.

---

### Trap 3 — One chat = one prompt = one model

VS Code Copilot Chat exports capture everything in the chat session, including prompts sent under different model selections.

Switching model mid-chat or running two prompts in the same chat produces a polluted export.

#### Fix

Verify clean tests by inspecting:

- Single user-turn count
- Single primary model
- Single prompt hash
- Expected tool set
- Expected mode

If not clean, discard and rerun.

---

### Trap 4 — Mechanisms that do not behave as assumed

The `applyTo:` test showed that a technique can sound plausible but not operate as a cost gate in the tested product configuration.

The lesson:

> Verify the mechanism before measuring the effect.

#### Fix

Inspect the raw export.

If the content you expect to be gated is either fully present or fully absent regardless of the gating directive, the gating mechanism is not doing what you think. In our `applyTo:` test, the contents were never loaded in the first place — meaning there was nothing to gate, and any token delta we measured was incidental, not causal.

---

### Trap 5 — Speculation loses to inspection

During testing, several plausible cache-behavior hypotheses turned out to be wrong.

Inspecting raw exports and `cache_control` breakpoints answered questions faster than reasoning from assumptions.

#### Fix

When in doubt, look at the bytes actually sent.

---

## Quality grading rubric used in test #12

For tests where the technique might affect output, not just cost:

1. Pre-commit a rubric before running the test.
2. Score each output unit separately.
3. Grade blind to cost numbers.
4. Report both completion and quality.
5. Compute quality per credit.

For the JSDoc task, each output block was scored on five axes:

- Parameters
- Types
- Behavior
- Edge cases
- Brevity

Each axis was scored 0–2.

The final comparison used:

```text
per-unit average × completion ratio = quality units
```

Then:

```text
quality units / AI Credits = quality per credit
```

This avoids comparing only cost when output quality differs.

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

### Tooling

Repository:

```text
Jfhelin/agentviz
```

Branch:

```text
jfhelin/cost-compare-instrumentation
```

Install:

```bash
npm install -g https://github.com/Jfhelin/agentviz/releases/download/v0.7.0-cost-preview/agentviz-0.7.0.tgz
```

### Test repo

The standard **OctoCat Supply Platform Demo** repo:

- TypeScript
- 8 small repository files in:

```text
api/src/repositories/
```

- Default test repository for agent demos inside GitHub

### Test prompts

Stored in:

```text
.github/prompts/
```

### Raw exports

Stored in:

```text
cost-test-results/raw-exports/*.json
```

One export per run.

### Per-test writeups

Stored as:

```text
cost-test-results/test-NN-<slug>.md
cost-test-results/test-NN-<slug>.json
```

### Procedure

1. Open VS Code Copilot Chat.
2. Start a **new chat** for every run.
3. Select the model before the first prompt.
4. Send exactly one user prompt.
5. Let the agent finish.
6. Export the chat:

```text
copilot_all_prompts_*.json
```

7. Load the export into agentviz.
8. Use Cost Compare to A/B against baseline.
9. Verify the export has:
   - Single user-turn count
   - Single primary model
   - Single prompt hash
   - Expected tool set
10. Check first-call cache hit rate.
11. If first-call cache hit rate is above 40%, suspect cache pollution and rerun from a colder state.

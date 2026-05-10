# Methodology

This section is for people who want to reproduce the work, debug similar measurements of their own, or pressure-test the methodology.

It is the companion to the main report: [copilot-cost-report.md](copilot-cost-report.md).

---

## Tooling and units

### Tooling

All measurements come from VS Code Copilot Chat exports:

    copilot_all_prompts_*.json

These exports were loaded into a local fork of:

    jayparikh/agentviz

Fork:

    Jfhelin/agentviz

Branch:

    jfhelin/cost-compare-instrumentation

The fork adds:

- A Cost view that breaks each call down by prefix bucket:
  - system
  - tool definitions
  - history
  - current prompt
  - tool results
  - output
- A Cost Compare tab that pins two runs side-by-side.
- Pre-vs-post divergence cost split.
- Projected prefix tax over each run’s actual call shape.
- Drift detection for:
  - prompt hash
  - system prompt hash
  - model
  - tool set / selected tool slate
  - turn count
- Per-model cache-aware pricing via:

      src/lib/pricing.js

Pricing data was refreshed against official Anthropic, OpenAI, and GitHub Copilot rate cards in May 2026.

Exports are deterministic JSON. Numbers in this report are computed from raw token counts in the export, not estimated by an LLM.

---

## What "AI Credits" means

Cost numbers are reported in AI Credits (cr), the unit GitHub Copilot is moving to for billing.

For intuition, this report approximates:

    1 cr ≈ $0.01 USD equivalent

A 20 cr task is therefore roughly equivalent to $0.20 of underlying spend in this framing.

---

## What "hello world" and "real workload" mean

A hello world measurement is the prefix-tax delta on the first primary LLM call of a run with the technique toggled on or off.

It is the cleanest possible cost number because it is path-independent:

- The agent has not made decisions yet.
- No tool path has diverged yet.
- The only difference should be whatever bytes the technique changed in the prompt prefix.

Cost Compare reports this as the input token count of the first primary call.

We express this as AI Credits per call at the Sonnet 4.5 rate card:

    $3/M input tokens
    $15/M output tokens
    ≈ 0.30 cr per 1,000 uncached input tokens

Hello world is useful for techniques that actually change prompt prefix:

- Changing the selected tool slate, if the configuration change actually changes what is sent to the model
- Shrinking instructions
- Switching mode
- Changing system/tool prompt shape

The other extreme is the real workload measurement, where the agent runs end-to-end and behavior dominates:

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

> Add JSDoc to every exported symbol in `api/src/repositories/`.

The task was run against the standard OctoCat Supply Platform Demo repo:

- TypeScript
- Approximately 8 small repository files under:

      api/src/repositories/

- Approximately 24 export-worthy symbols

For each condition, we sent that prompt, or a near-variant, in a fresh VS Code Copilot Chat session, exported the chat as JSON, and loaded the export into agentviz Cost Compare.

---

## Why this workload

We needed a task with these properties:

### Bounded scope

A known set of files and a known list of exported symbols means we can count completion deterministically.

Example:

    16 of 24 expected blocks

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

- Instruction files at 50KB+
- Large monorepo context
- Multi-language workspaces

MCP server count is not on this list. In our test, going from 52 to 182 available tools left the model’s selected slate at roughly 25–26 tools per call and changed the system prompt by only about 308 tokens — in the opposite direction from “more tools = bigger prompt.” VS Code Copilot Chat selects a small slate per call and reaches large MCP catalogs through router tools rather than inlining every definition. Available-tool count is therefore not a linear driver of prefix size in this client.

See deep dive #3 in the main report.

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
- Expected selected tool slate
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

    completed output units × average score per completed unit = total quality units

Then:

    total quality units / AI Credits = quality per credit

This deliberately rewards both quality and completion: a model that produces good blocks but skips part of the requested scope receives fewer total quality units than a model that completes more of the task at similar quality.

This avoids comparing only cost when output quality differs.

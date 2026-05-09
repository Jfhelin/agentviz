# Token-cost optimization techniques (fork test plan)

<!-- FORK-LOCAL: this document tracks the experimental program driving the
     Cost Compare instrumentation work on the Jfhelin/agentviz fork.
     It is not part of upstream agentviz. Do not cherry-pick into PRs. -->

This file is the source of truth for the 11 token-cost reduction techniques
the fork's Cost Compare instrumentation work is designed to validate. It
exists so that as the tooling evolves we keep checking each technique
against a methodology that can actually attribute its effect.

## The 11 techniques

| # | Action | Primary effect | Scope | Setup time |
|---|---|---|---|---|
| 1 | Request code-only responses (`Code only, no explanation.` in `copilot-instructions.md`) | Shrinks response length | 40-70% fewer output tokens on code tasks | 0 min |
| 2 | Constrain output format by default (`Bullets over paragraphs. No explanations unless asked.`) | Keeps answers terse | 30-60% fewer output tokens on output-heavy interactions | 0 min |
| 3 | Shrink always-on context — compress `copilot-instructions.md` and prune `AGENTS.md` to landmines only | Reduces always-on input/context | 40-60% fewer instruction tokens per call | 15 min |
| 4 | Default to Auto model selection; pin higher-cost models only when justified | Lowers billed rate on eligible usage | Paid-plan credit discount; not a token reduction | 0 min |
| 5 | Use Ask Mode for simple questions; reserve Agent Mode for multi-step tasks | Avoids agent overhead | 60-90% lower token use for simple questions vs agent-style flows | 0 min |
| 6 | Scope context with `applyTo:` paths — split one large instructions file into small scoped ones | Reduces always-on input/context | 50-80% less scoped load when the file does not apply | 15 min |
| 7 | Be precise in prompts (`Add null check to getUser()` not `maybe add some error handling`) | Improves task targeting | Quality first; minor user-prompt token savings | 0 min |
| 8 | Retune prompts to the target model — paste official prompting guide and ask Copilot to adapt instructions | Reduces rework | Better first-pass output → fewer follow-up turns | 10 min per model |
| 9 | Audit MCP servers — disable servers you don't use; each costs ~100-500 tokens per agent step | Removes tool/schema overhead | 5K-190K fewer tokens per task | 5 min |
| 10 | Run `/chronicle improve` weekly (Copilot CLI only, experimental) — generates custom-instruction fixes for recurring confusion patterns | Cuts recurring rework | 10K-30K fewer tokens per repeated pattern | 2 min/run |
| 11 | Try CodeAct for long tool chains (Copilot CLI only, optional plugin) — collapses multi-step tool chains into one sandboxed execution | Reduces tool-loop replay | Best for tool-heavy CLI tasks with MCP servers loaded | 10-15 min |

## Validation methodology buckets

The Cost Compare tool ships with a Run Drift panel and a Pre/Post-Divergence
cost split. The split exposes the only causally clean number you can get
from a single A/B run: the input-token delta on the **first primary LLM
call**, before the agent has acted. Everything after that is path-noise at
N=1.

This forces a triage of which techniques can be honestly tested with how
much methodology.

### ✅ Cleanly validatable with 1-call + projection

These change only the prompt prefix. Run a single path-pinned call (e.g.
`list files and stop`), read the prefix-tax delta, project over a real
past session's call shape with cache amortization. **N=1 is enough.**

- **#3** Shrink always-on context (compress `copilot-instructions.md`)
- **#6** Scope context with `applyTo:` paths
- **#9** Audit MCP servers (this is the t1_a vs t1_b test that motivated
  the whole instrumentation effort)

### ⚠️ Partially validatable

The 1-call captures the prefix component, but the dominant effect is
behavioral. Use the projection for the prefix component only; treat the
behavioral component as descriptive.

- **#4** Auto model selection — billed rate per call is a flat
  multiplier, but only on calls that actually route to a cheaper model.
  Measure on each call type separately.
- **#7** Be precise in prompts — user-message prefix shrinks slightly;
  the real win is fewer follow-up turns (behavioral).
- **#8** Retune prompts to target model — prefix usually gets larger;
  the win is fewer follow-up turns.
- **#11** CodeAct — reduces the **number** of times the prefix is
  replayed; effect is `prefixSize × callsAvoided`. Each side is
  measurable but the avoided-call count is path-dependent.

### ❌ Not validatable with 1-call + projection

These act on output tokens or on the agent's choices. The prefix may not
change at all. Compare deterministic KPIs (output tokens, tool count,
turn count) across **3-5 runs** per condition.

- **#1** Code-only responses — pure output reduction
- **#2** Constrain output format — pure output reduction
- **#5** Ask Mode vs Agent Mode — entirely different flow; compare on
  total cost per question class, not per-call delta
- **#10** `/chronicle improve` — meta-technique. Validate each
  individual instruction fix it produces using whichever bucket fits.

## Test plan implications

| Bucket | Min runs per technique | Methodology |
|---|---|---|
| ✅ Cleanly validatable | 1 controlled + 1 path-pinned A and B | Pre-Divergence cost delta + projection |
| ⚠️ Partially validatable | 3-5 per condition | Prefix delta from controlled call + KPI comparison |
| ❌ Not validatable here | 3-5 per condition | KPI comparison only; cost number is descriptive |

The drift panel and divergence split are the gating tools: if drift shows
something that should have been identical wasn't, throw the run out. If
post-divergence cost dominates pre-divergence cost (typical at N=1), the
headline cost number can't be used as causal evidence for the technique.

## Test status (test 1 of 11)

- **#9 Audit MCP servers**: in progress on `octocat_supply-psychic-disco`.
  Run A (`t1_a_builtin52`, 52 builtin tools) vs Run B (`t1_b_mcp182`, 182
  tools incl. Azure/Playwright/GitHub). N=1, path-dominated by ~50%
  swings. Pre-divergence delta: ~+2,238 input tokens per call. The
  prefix tax is the only causal number; the rest is path noise.

# Appendix — How to reproduce

Companion to the main report: [copilot-cost-report.md](copilot-cost-report.md). For methodology details, see [methodology.md](methodology.md).

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

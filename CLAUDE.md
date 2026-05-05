# AGENTVIZ

Session replay visualizer for AI agent workflows. Renders Claude Code, VS Code Copilot Chat, and Copilot CLI session logs as interactive timelines, with auto-detection of file format.

## Stack
- React 18 + Vite 6
- No CSS framework, all inline styles
- Font: JetBrains Mono (loaded from Google Fonts in index.html)
- Mixed JS/TS: components and hooks are plain JSX, parsers and data libs are TypeScript

## Architecture
```
src/
  App.jsx              # Main orchestrator: file loading, playback, keyboard shortcuts, view routing
  main.jsx             # React entry point
  contexts/
    PlaybackContext.jsx  # Playback, search, track filtering, and derived state provider
  hooks/
    usePlayback.js     # Playback state: time, playing, speed, seek, playPause
    useSearch.js       # Debounced search with matchSet/matchedEntries
    useKeyboardShortcuts.js # Centralized keyboard handler (ref-based, stable listener)
    useQA.js           # Session Q&A state: messages, classifier, SSE streaming, abort
    useFeatureFlag.js  # localStorage-backed feature flag evaluation
    useSessionLoader.js # File parsing, live init from /api/file, session reset, hero state
    useLiveStream.js   # SSE EventSource hook with 500ms debounce for live mode
    usePersistentState.js # localStorage-backed useState with debounced writes
    useDiscoveredSessions.js # Auto-discovery of sessions via /api/sessions or ?manifest= URL
    useHashRouter.js   # Hash-based routing between inbox and session views
    useAsyncStatus.js  # Async operation state machine (idle/loading/success/error)
  lib/
    theme.js           # Design token system, TRACK_TYPES, AGENT_COLORS
    theme.d.ts         # TypeScript declarations for theme.js
    constants.js       # SAMPLE_EVENTS data for demo mode
    parser.ts          # parseClaudeCodeJSONL() - Claude Code JSONL parser
    copilotCliParser.ts # parseCopilotCliJSONL() - Copilot CLI JSONL parser
    vscodeSessionParser.ts # parseVSCodeChatJSON() - VS Code Copilot Chat JSON parser
    liveSessionParser.ts # Incremental live JSONL parser for appended session text
    parseSession.ts    # Auto-detect format router: detectFormat() + parseSession()
    session.ts         # Pure helpers: getSessionTotal, buildFilteredEventEntries, buildTurnStartMap
    sessionLibrary.js  # localStorage-backed session library with content persistence
    sessionParsing.ts  # Session parsing utilities and types
    sessionTypes.ts    # TypeScript type definitions for session data
    cacheMetrics.ts    # Shared cache hit rate helpers
    skillExtractor.ts  # Skill/capability lifecycle extractor (skills, instructions, agents, MCP servers, tools, prompts)
    autonomyMetrics.js # Human response time, idle gaps, intervention scoring
    projectConfig.js   # Project config surface detection (CLAUDE.md, .github/, etc.)
    aiCoachAgent.js    # AI Coach powered by @github/copilot-sdk (gpt-4o)
    qaClassifier.js    # Session Q&A instant answer engine (9 patterns + model context)
    qaAgent.js         # Q&A agent powered by @github/copilot-sdk for model fallback
    replayLayout.js    # Estimated layout + binary search windowing for virtualized replay
    commandPalette.js  # Precomputed search index with scoring and per-type caps
    diffUtils.js       # Diff detection (isFileEditEvent) + Myers line diff algorithm
    waterfall.ts       # Waterfall view helpers: item building, stats, layout, windowing
    graphLayout.js     # Graph view helpers: ELKjs DAG builder, layout runner, position merger
    pricing.js         # Claude + GPT-4o model pricing table and cost estimation (per-model cache ratios)
    cacheAnalysis.ts   # Per-model cache scoping, recommit math, unexpected-miss diagnosis
    copilotChatExportParser.ts # Parser + cost analysis builder for VS Code Copilot Chat exports
    exportHtml.js      # Self-contained HTML export for single sessions and comparisons
    dataInspector.js   # Payload summary and preview helpers for inspector panels
    formatTime.js      # Duration and date formatting utilities
    landingSessions.js # Shared landing browser labels, filters, and format options
    playbackUtils.js   # Playback state helpers
  components/
    InboxView.jsx      # Session inbox with auto-discovery, sorting, refresh, and review priority
    DashboardView.jsx  # Landing dashboard card grid with shared landing controls, aggregate stats, and quick open
    DebriefView.jsx    # AI Coach panel with cached analysis and one-click apply
    FileUploader.jsx   # Drag-and-drop file input with error handling
    Timeline.jsx       # Scrubable playback bar with event markers, turn boundaries
    ReplayView.jsx     # Windowed event stream + resizable inspector sidebar
    TracksView.jsx     # DAW-style multi-track lanes with solo/mute
    WaterfallView.jsx  # Tool execution waterfall with nesting, inspector sidebar
    GraphView.jsx      # Interactive DAG of turns/tool calls with ELKjs layout, pan/zoom, animations
    StatsView.jsx      # Aggregate metrics, tool ranking, turn summary
    CostView.jsx       # Token cost & context buildup view (Copilot Chat exports only); 3-column timeline with CTX/NET/BILLED lenses
    CompareView.jsx    # Side-by-side session comparison: Scorecard + Tools tabs
    CommandPalette.jsx # Cmd+K fuzzy search overlay (events, turns, views)
    DiffViewer.jsx     # Inline unified diff view for file-editing tool calls
    DataInspector.jsx  # Readable payload inspector with summaries and copy support
    LiveIndicator.jsx  # Pulsing LIVE badge shown in CLI streaming mode
    ShortcutsModal.jsx # Keyboard shortcuts overlay
    QADrawer.jsx       # Session Q&A slide-over drawer with instant answers
    RecentSessionsPicker.jsx # Recent sessions dropdown picker
    SyntaxHighlight.jsx # Lightweight code syntax coloring for raw data
    ResizablePanel.jsx # Drag-to-resize split panel utility
    ErrorBoundary.jsx  # React error boundary with resetKey for recovery
    Icon.jsx           # Lucide icon wrapper; all icons must be imported AND added to ICON_MAP
    app/               # Shell components: AppHeader, AppLandingState, AppLoadingState, CompareLandingState, CompareShell (AppLandingState switches between inbox and dashboard landing modes)
    ui/                # Shared primitives: BrandWordmark, ShellFrame, ToolbarButton, ToolbarSelect, ExportStatusButton, KeyboardHint
    waterfall/         # Waterfall sub-components: WaterfallChart, WaterfallRow, WaterfallInspector, TimeAxis
routes/
  sessions.js        # Session discovery, file serving, SSE streaming
  ai.js              # Coach analysis, Q&A, model info (SSE streaming)
  config.js          # Project config surface detection, file preview, apply
bin/
  agentviz.js          # CLI entry point: finds free port, starts server, opens browser
mcp/
  server.js            # MCP server: launch_agentviz and close_agentviz tools
server.js              # HTTP server: serves dist/ SPA + SSE /api/stream file tail
```

## Key data types

Normalized event (output of parser, consumed by all views):
```
{ t, agent, track, text, duration, intensity, toolName?, toolInput?, raw, turnIndex, isError, model?, tokenUsage? }
```

Turn (groups events by user-initiated conversation rounds):
```
{ index, startTime, endTime, eventIndices, userMessage, toolCount, hasError }
```

Session metadata (aggregate stats):
```
{ totalEvents, totalTurns, totalToolCalls, errorCount, duration, models, primaryModel, tokenUsage }
```

Parser returns: `{ events, turns, metadata }` or null

Track types: reasoning, tool_call, context, output
Agent types: user, assistant, system

## Commands
- `npm start` - Build and launch AGENTVIZ in browser (production)
- `npm run dev` - Vite dev server + API backend (both auto-started)
- `npm run build` - Production build to dist/
- `npm test` - Run 300 tests via Vitest (parsers, layout, diff, graph, autonomy, QA, regressions, and more)
- `npm run test:watch` - Watch mode for tests
- `npm run typecheck` - Type-check with tsc --noEmit

`npm run dev` auto-starts the API backend on port 4242.
Vite proxies `/api/*` to the backend automatically.

## Conventions
- No em dashes in any content or comments
- All styles are inline (no CSS files), all colors reference theme.js tokens
- Unicode characters used directly or as escape sequences in JS
- Components receive data as props, no global state management
- Design tokens defined in src/lib/theme.js
- Product name is always AGENTVIZ (all caps, no spaces)
- UI/UX design system: see docs/ui-ux-style-guide.md -- all UI changes must conform to it
- Cache usage summaries omit the cache-write segment when `cacheWrite` is zero

## Planned features
- Bookmarks and annotations (persisted to localStorage)
- Vim-style keyboard navigation
- Parsers for: LangSmith traces, OpenTelemetry
- Multi-agent hierarchy (parent/child agents, nested tracks)
- Fork-from-any-point replay
- Publish to npm (`npx agentviz`)
<!-- FORK-LOCAL START: do NOT cherry-pick into PR branches or upstream -->

## Fork context (Jfhelin/agentviz)

This checkout is a personal fork of `jayparikh/agentviz`. Upstream is the
authoritative source; we contribute back via pull requests.

- **Fork:** `Jfhelin/agentviz`
- **Upstream:** `jayparikh/agentviz` (public, MIT)
- **Local path:** `/Users/jfhelin/Code/GitHub/jfhelin/agentviz-fork`
- **Remote setup:** `origin` -> fork, `upstream` -> jayparikh

### Active feature: Cost view

Branch `jfhelin/copilot-token-spend-tracking` adds a Cost view that
visualizes token spend and context buildup for VS Code Copilot Chat
exports (`copilot_all_prompts_*.json`). Current state:

- Three commits, rebased onto `upstream/main`.
- `npm run build`, `npx tsc --noEmit`, and `npm test` (677/677) pass.
- Pushed to `origin`. PR to upstream NOT yet opened.
- Prebuilt tarball published as GitHub Release `v0.7.0-cost-preview`
  for colleagues to install with:
  `npm install -g https://github.com/Jfhelin/agentviz/releases/download/v0.7.0-cost-preview/agentviz-0.7.0.tgz`

Key files for the feature:
- `src/components/CostView.jsx` -- view (uses `theme.cost.*` tokens)
- `src/lib/cacheAnalysis.ts` -- per-call cache + cost analysis
- `src/lib/copilotChatExportParser.ts` -- new parser, auto-detected
- `src/__tests__/cacheAnalysis.test.ts` -- 16 unit tests
- `src/__tests__/copilotChatExport.test.ts` -- parser tests
- README.md (Cost View section), CLAUDE.md (file tree), `docs/ui-ux-style-guide.md` (Cost Colors), `docs/color-palette.html` (Cost View Palette)

### Open architectural debt to track

- Cost view depends on per-call context breakdown that today only the
  VS Code Copilot Chat export carries. Plan: lift `contextBreakdown`
  into the normalized event/turn schema so other parsers (Claude Code
  JSONL, Copilot CLI JSONL) can populate it when the upstream format
  exposes the data.
- Compare view does not yet have a Cost tab.
- Coach does not yet read `cacheAnalysis` findings.

### Local-only fixture (gitignored)

Real Copilot Chat export used during development:
`/Users/jfhelin/.copilot/workspaces/<workspace-id>/attachments/copilot_all_prompts_2026-04-29T14-41-16.json`

Do not commit it. The synthetic fixture in
`src/__tests__/fixtures/copilot-chat-export-minimal.json` is what tests
run against.

### Working rules for this fork

- Never commit fork-local sections (anything between FORK-LOCAL markers)
  into the PR branch. They live on `main` of this fork only.
- Before opening or updating the upstream PR, rebase the feature branch
  onto `upstream/main`, run `npm run build && npx tsc --noEmit && npm test`,
  then push `--force-with-lease`.
- When syncing `main` from upstream: `git pull upstream main && git push origin main`.
  This file should remain (upstream does not touch this section).

<!-- FORK-LOCAL END -->

import React, { useState, useMemo, useEffect } from "react";
import { theme } from "../lib/theme.js";
import { estimateCost, hasModelPricing, getModelPrice } from "../lib/pricing.js";
import { estimateImageTokens, imageDollarCost } from "../lib/imageTokenEstimate.js";
import { buildLlmAnalysisPrompt, detectUnusedTools, aggregateSkillCarry } from "../lib/llmAnalysisExport";
import { buildAgentThreads } from "../lib/agentThreads";
import usePersistentState from "../hooks/usePersistentState.js";

// Display unit for $ amounts. Module-level so the dozens of fmt$ call sites
// don't all need a context/prop. The CostView root keeps it in sync with the
// persistent toggle via setCostUnit() in a useEffect.
//   currency:  "$0.0123"     (USD)
//   credits:   "1.23 cr"     (1 credit = $0.01, per GitHub Copilot AI Credits)
var _costUnit = "credits";
function setCostUnit(u) { _costUnit = u === "currency" ? "currency" : "credits"; }
function isCredits() { return _costUnit === "credits"; }

// Cost view uses theme.cost.* tokens (defined in src/lib/theme.js).
// These are categorical color roles that change with light/dark mode.
var COST_COLORS = {
  get fresh()  { return theme.cost.fresh; },
  get cwrite() { return theme.cost.cwrite; },
  get cached() { return theme.cost.cached; },
  get output() { return theme.cost.output; },
};
var COST_LABELS = {
  fresh: "Fresh input",
  cwrite: "Cache write",
  cached: "Cached read",
  output: "Output",
};

// Image thumbnail with hover-popover preview. Renders a 28x28 thumb and on
// hover floats a ~240px preview of the actual image. The export only carries
// `data:image/...;base64,...` URLs (no original filenames), so the visual
// itself is the best identifier we can give. Clicking opens the full image
// in a new tab.
function ImageThumb(props) {
  var url = props.url;
  var alt = props.alt || "image";
  var size = props.size || 28;
  var [hover, setHover] = useState(false);
  var inner = (
    <img src={url} alt={alt} style={{ width: size, height: size, objectFit: "cover", borderRadius: 3, border: "1px solid " + theme.border.subtle, background: theme.bg.base, display: "block" }} />
  );
  return (
    <span
      style={{ position: "relative", display: "inline-block", lineHeight: 0 }}
      onMouseEnter={function () { setHover(true); }}
      onMouseLeave={function () { setHover(false); }}
    >
      <a href={url} target="_blank" rel="noreferrer" title="Click to open full size in new tab" style={{ display: "block" }}>
        {inner}
      </a>
      {hover && (
        <span style={{
          position: "absolute", zIndex: 50, left: size + 6, top: 0,
          background: theme.bg.surface, border: "1px solid " + theme.border.default,
          borderRadius: 6, padding: 4, boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
          pointerEvents: "none",
        }}>
          <img src={url} alt="" style={{ maxWidth: 240, maxHeight: 240, display: "block", borderRadius: 3, background: theme.bg.base }} />
        </span>
      )}
    </span>
  );
}

// Smart tool-result preview. Tool results are flat plaintext strings; the
// only natural unit we can lean on is line breaks. This component:
//   - detects data:image/... results and renders the image inline with the
//     standard ImageThumb hover preview;
//   - inlines tiny results (<=3 lines, <=400 chars) with no toggle;
//   - collapses larger results behind a one-line `<details>` summary that
//     shows shape (N lines · X chars) + the first non-empty line, with the
//     full body revealed on click.
// `full` is the longer (8KB) slice from the parser; `preview` is the older
// 240-char one used as a fallback. `truncated` indicates the original tool
// output exceeded what we kept.
function ToolResultPreview(props) {
  var preview = props.preview || "";
  var full = props.full || preview;
  var truncated = !!props.truncated;
  var totalChars = props.totalChars || full.length;
  var accent = props.accent || theme.cost.ctxHistory;
  var blockStyle = props.blockStyle;
  if (!preview && !full) {
    return <div style={{ color: theme.text.ghost, fontStyle: "italic", fontSize: theme.fontSize.sm }}>(no preview captured)</div>;
  }
  // Tool-returned single image (e.g. view_image).
  if (/^data:image\//i.test(full.trim())) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
        <ImageThumb url={full.trim()} alt="tool image result" size={48} />
        <span style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, fontFamily: theme.font.mono }}>
          {(/^data:(image\/[a-z]+)/i.exec(full.trim()) || [, "image"])[1]} · {totalChars.toLocaleString()} chars (base64)
        </span>
      </div>
    );
  }
  var lines = full.split("\n");
  var nonEmpty = lines.filter(function (l) { return l.trim().length > 0; });
  var firstLine = (nonEmpty[0] || "").trim();
  if (firstLine.length > 100) firstLine = firstLine.slice(0, 100) + "…";
  var isTiny = lines.length <= 3 && totalChars <= 400;
  if (isTiny) {
    return <div style={blockStyle}>{full}{truncated ? "\n\n…(truncated, full result was longer)" : ""}</div>;
  }
  var summary = "tool returned " + lines.length + " line" + (lines.length === 1 ? "" : "s")
    + " · " + totalChars.toLocaleString() + " chars"
    + (firstLine ? " · first: " + JSON.stringify(firstLine) : "");
  return (
    <details style={{ marginTop: 0 }}>
      <summary style={{ cursor: "pointer", padding: "4px 0", color: theme.text.secondary, fontSize: theme.fontSize.sm, listStyle: "revert" }}>
        {summary}
      </summary>
      <div style={Object.assign({}, blockStyle, { marginTop: 6 })}>
        {full}
        {truncated ? "\n\n…(original was longer; preview capped at 8KB)" : ""}
      </div>
    </details>
  );
}

// Smart tool-argument preview. Mirrors ToolResultPreview: shows a one-line
// summary (using the existing summarizeToolArgs heuristics: shell commands
// get verb-chain summaries, other tools get a key:value preview) with an
// expandable body that pretty-prints the full JSON arguments.
function ToolArgsPreview(props) {
  var ev = props.ev;
  var blockStyle = props.blockStyle;
  var workspaceRoot = props.workspaceRoot || "";
  if (!ev || !ev.rawArgs) {
    return ev && ev.argsSummary
      ? <div style={blockStyle}>{ev.argsSummary}</div>
      : <div style={{ color: theme.text.ghost, fontStyle: "italic", fontSize: theme.fontSize.sm }}>(no arguments)</div>;
  }
  var smart = smartToolHeadline(ev, workspaceRoot) || summarizeToolArgs(ev) || ev.argsSummary || "";
  var pretty = ev.rawArgs;
  try { pretty = JSON.stringify(JSON.parse(ev.rawArgs), null, 2); } catch (_e) { /* leave raw */ }
  var lines = pretty.split("\n").length;
  var chars = pretty.length;
  return (
    <details style={{ marginTop: 0 }}>
      <summary style={{ cursor: "pointer", padding: "4px 0", color: theme.text.secondary, fontSize: theme.fontSize.sm, listStyle: "revert" }}>
        <span style={{ color: theme.text.primary }}>{smart}</span>
        <span style={{ color: theme.text.muted, marginLeft: 8 }}>· {lines} line{lines === 1 ? "" : "s"} · {chars.toLocaleString()} chars (click for full args)</span>
      </summary>
      <div style={Object.assign({}, blockStyle, { marginTop: 6, maxHeight: 400, overflow: "auto" })}>
        {pretty}
      </div>
    </details>
  );
}

var CTX_KEYS = ["system", "tool_defs", "history", "tool_results", "current", "images", "output"];
var CTX_INPUT_KEYS = ["system", "tool_defs", "history", "tool_results", "current", "images"];
var CTX_COLORS = {
  get system()       { return theme.cost.ctxSystem; },
  get tool_defs()    { return theme.cost.ctxToolDefs; },
  get history()      { return theme.cost.ctxHistory; },
  get tool_results() { return theme.cost.ctxToolResults; },
  get current()      { return theme.cost.ctxCurrent; },
  get images()       { return theme.cost.ctxImages; },
  get output()       { return theme.cost.ctxOutput; },
};
var CTX_LABELS = {
  system: "System",
  tool_defs: "Tool defs",
  history: "History",
  tool_results: "Tool results",
  current: "Current prompt",
  images: "Images (vision)",
  output: "Response",
};
var KIND_COLORS = {
  get mcp()       { return theme.cost.kindMcp; },
  get extension() { return theme.cost.kindExtension; },
  get builtin()   { return theme.cost.kindBuiltin; },
};

// Map VS Code Copilot Chat's internal call names to friendly labels.
// The raw name is still shown as a small subtitle for power users.
var CALL_NAME_LABELS = {
  "panel/editAgent":      "Chat turn (with tools)",
  "panel/request":        "Chat turn",
  "panel/explain":        "Explain",
  "panel/fix":            "Fix",
  "tool/runSubagent":     "Subagent turn",
  "title":                "Generate chat title",
  "promptCategorization": "Categorize prompt",
};
function friendlyCallName(name) {
  if (!name) return "Request";
  if (CALL_NAME_LABELS[name]) return CALL_NAME_LABELS[name];
  // panel/<something> → "Chat: something"
  if (name.indexOf("panel/") === 0) return "Chat: " + name.slice(6);
  return name;
}

// Split a shell command on top-level sequence operators (&&, ||, ;) outside
// quotes. Not a full shell parser; good enough for the common Copilot
// patterns (no nested quoted operators in the wild).
function splitShellSteps(cmd) {
  var out = [];
  var buf = "";
  var inSingle = false;
  var inDouble = false;
  var i = 0;
  while (i < cmd.length) {
    var ch = cmd[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; i += 1; continue; }
      if ((ch === "&" || ch === "|") && cmd[i + 1] === ch) {
        if (buf.trim()) out.push(buf.trim());
        buf = ""; i += 2; continue;
      }
    }
    buf += ch; i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// First word of a step, after stripping leading env-var assignments and
// common builtins that are setup-only (cd, export, set).
function firstVerbOfStep(step) {
  // Walk past VAR=value prefixes
  var rest = step.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  // Pipeline: first command in the pipe is what matters
  var firstPipe = rest.split(/\s\|\s/)[0] || rest;
  var m = firstPipe.trim().match(/^(\S+)/);
  return m ? m[1] : "";
}

function summarizeShellCommand(cmd) {
  if (!cmd) return "";
  var normalized = cmd.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  var steps = splitShellSteps(normalized);
  // Strip a leading bare `cd <path>` (it's just setup, not real work).
  if (steps.length > 1 && /^cd\s/.test(steps[0])) steps = steps.slice(1);
  if (steps.length <= 1) {
    return normalized.length > 90 ? normalized.slice(0, 90) + "\u2026" : normalized;
  }
  var verbs = steps.map(firstVerbOfStep).filter(Boolean);
  var unique = [];
  verbs.forEach(function (v) { if (unique.indexOf(v) < 0) unique.push(v); });
  if (unique.length === 1 && verbs.length > 1) {
    return verbs.length + "\u00d7 " + unique[0];
  }
  var shown = verbs.slice(0, 4).join(" \u2192 ");
  return verbs.length > 4
    ? shown + " \u2026 (" + verbs.length + " steps)"
    : shown + " (" + verbs.length + " steps)";
}

// Try to extract the most informative one-line summary from a tool call's
// raw arguments. Falls back to the parser-side argsSummary when nothing
// special-cased applies.
function summarizeToolArgs(ev) {
  if (!ev) return "";
  var parsed = null;
  if (ev.rawArgs) {
    try { parsed = JSON.parse(ev.rawArgs); } catch (_e) { parsed = null; }
  }
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.command === "string" && parsed.command.length > 0) {
      return summarizeShellCommand(parsed.command);
    }
  }
  return ev.argsSummary || "";
}

// Per-tool human summary for tool-call row headers. Picks the most useful
// single field for known tools (file basename, query text, todo counts, etc.)
// and falls back to the first key:value of the args for unknown tools.
function inferWorkspaceRoot(analysis) {
  if (!analysis || !analysis.prompts) return "";
  var paths = [];
  var keys = ["filePath", "path", "file", "uri", "directory", "dir", "cwd", "workspaceFolder", "rootPath"];
  analysis.prompts.forEach(function (p) {
    p.events.forEach(function (e) {
      if (!e || !e.rawArgs) return;
      var parsed;
      try { parsed = JSON.parse(e.rawArgs); } catch (_e) { return; }
      if (!parsed || typeof parsed !== "object") return;
      keys.forEach(function (k) {
        var v = parsed[k];
        if (typeof v === "string" && v.length > 1 && (v.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(v))) {
          paths.push(v);
        }
      });
    });
  });
  if (paths.length < 2) return "";
  // Tally every prefix candidate (every parent directory of every path).
  // Pick the longest prefix that covers >= 80% of paths AND has at least
  // 4 meaningful segments. This is robust against outliers like
  // /memories/session/plan.md from a memory tool that would otherwise
  // collapse a strict longest-common-prefix to "".
  var counts = new Map();
  paths.forEach(function (p) {
    var segs = p.split(/[\\/]+/);
    // Build every prefix from segment 4 up to segment N-1 (exclude the
    // basename itself; we only care about directory prefixes).
    for (var i = 4; i < segs.length; i++) {
      var pref = segs.slice(0, i + 1).join("/");
      counts.set(pref, (counts.get(pref) || 0) + 1);
    }
  });
  var threshold = Math.ceil(paths.length * 0.8);
  var best = "";
  counts.forEach(function (n, pref) {
    if (n >= threshold && pref.length > best.length) best = pref;
  });
  return best;
}

function stripRoot(p, root) {
  if (!p || typeof p !== "string") return p;
  if (!root) return p;
  if (p === root) return ".";
  var withSlash = root.charAt(root.length - 1) === "/" ? root : root + "/";
  if (p.indexOf(withSlash) === 0) return "./" + p.slice(withSlash.length);
  return p;
}

function smartToolHeadline(ev, workspaceRoot) {
  if (!ev) return "";
  var name = ev.name || "";
  var parsed = null;
  if (ev.rawArgs) {
    try { parsed = JSON.parse(ev.rawArgs); } catch (_e) { parsed = null; }
  }

  var basename = function (p) {
    if (!p || typeof p !== "string") return "";
    var clean = p.replace(/[\\/]+$/, "");
    var i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    return i >= 0 ? clean.slice(i + 1) : clean;
  };
  var trunc = function (s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "\u2026" : s;
  };

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    var lname = name.toLowerCase();

    var fmtSize = function (s) {
      if (!s || typeof s !== "string") return "";
      var chars = s.length;
      var lines = s ? s.split("\n").length : 0;
      var charsStr = chars >= 1000 ? (chars / 1000).toFixed(chars >= 10000 ? 0 : 1) + "k" : String(chars);
      return lines + " line" + (lines === 1 ? "" : "s") + ", " + charsStr + " chars";
    };
    var diffLines = function (a, b) {
      var al = a ? a.split("\n").length : 0;
      var bl = b ? b.split("\n").length : 0;
      // Approximate: treat as full replacement when both sides exist.
      var added = bl;
      var removed = al;
      return "+" + added + " / -" + removed + " lines";
    };
    var patchCounts = function (patch) {
      if (!patch || typeof patch !== "string") return "";
      var added = 0, removed = 0;
      patch.split("\n").forEach(function (ln) {
        if (ln.length === 0) return;
        var c = ln.charAt(0);
        if (c === "+" && ln.slice(0, 3) !== "+++") added += 1;
        else if (c === "-" && ln.slice(0, 3) !== "---") removed += 1;
      });
      if (added === 0 && removed === 0) return "";
      return "+" + added + " / -" + removed + " lines";
    };

    // Show file paths as workspace-relative when possible, falling back to
    // basename when the file lives outside the inferred root (so the path
    // wouldn't strip cleanly).
    var fileLabel = function (fp) {
      var stripped = stripRoot(fp, workspaceRoot);
      // stripRoot returns the same string back when no root match -- in
      // that case use basename to avoid showing a useless absolute path.
      return stripped === fp ? basename(fp) : stripped;
    };

    if (lname.indexOf("read_file") >= 0) {
      var rfp = parsed.filePath || parsed.path || parsed.file || parsed.uri || "";
      if (rfp) {
        var label = fileLabel(rfp);
        var startLine = parsed.startLine || parsed.startLineNumber || parsed.start_line;
        var endLine = parsed.endLine || parsed.endLineNumber || parsed.end_line;
        if (startLine && endLine) label += " \u00b7 lines " + startLine + "-" + endLine;
        return label;
      }
    }

    if (lname.indexOf("create_file") >= 0 || lname === "write") {
      var cfp = parsed.filePath || parsed.path || parsed.file || parsed.uri || "";
      if (cfp) {
        var body = parsed.content || parsed.text || parsed.code || parsed.fileContents || "";
        var size = fmtSize(body);
        return fileLabel(cfp) + (size ? " \u00b7 " + size : "");
      }
    }

    if (lname.indexOf("replace_string_in_file") >= 0) {
      var rsfp = parsed.filePath || parsed.path || parsed.file || parsed.uri || "";
      if (rsfp) {
        var oldS = parsed.oldString || parsed.old_string || parsed.search || "";
        var newS = parsed.newString || parsed.new_string || parsed.replace || "";
        var d = diffLines(oldS, newS);
        return fileLabel(rsfp) + (d ? " \u00b7 " + d : "");
      }
    }

    if (lname.indexOf("insert_edit_into_file") >= 0 || lname.indexOf("edit_file") >= 0 || lname === "edit") {
      var efp = parsed.filePath || parsed.path || parsed.file || parsed.uri || "";
      if (efp) {
        var ebody = parsed.code || parsed.content || parsed.text || parsed.newString || "";
        var esize = fmtSize(ebody);
        return fileLabel(efp) + (esize ? " \u00b7 +" + esize : "");
      }
    }

    if (lname.indexOf("apply_patch") >= 0 || lname === "patch") {
      var p = parsed.patch || parsed.diff || parsed.body || "";
      var pc = patchCounts(p);
      if (pc) return pc;
    }

    if (lname.indexOf("list_dir") >= 0 || lname === "ls") {
      var dp = parsed.path || parsed.directory || parsed.dir || "";
      if (dp) return stripRoot(dp, workspaceRoot);
    }

    if (lname.indexOf("grep") >= 0 || lname.indexOf("semantic_search") >= 0
        || lname.indexOf("file_search") >= 0 || lname.indexOf("search") >= 0) {
      var q = parsed.query || parsed.pattern || parsed.q || "";
      if (q) return trunc(q, 80);
    }

    if (typeof parsed.command === "string" && parsed.command.length > 0) {
      return summarizeShellCommand(parsed.command);
    }

    if (lname.indexOf("manage_todo_list") >= 0) {
      var list = Array.isArray(parsed.todoList) ? parsed.todoList : null;
      if (list) {
        var counts = { "in-progress": 0, pending: 0, completed: 0, blocked: 0 };
        var inProgressTitle = "";
        list.forEach(function (t) {
          var s = (t && t.status) || "pending";
          counts[s] = (counts[s] || 0) + 1;
          if (s === "in-progress" && !inProgressTitle && t && t.title) {
            inProgressTitle = t.title;
          }
        });
        var total = list.length;
        var done = counts.completed || 0;
        var allDone = total > 0 && done === total;
        var head = done + "/" + total + " done" + (allDone ? " \u2713" : "");
        var segs = [head];
        if (counts.blocked) segs.push(counts.blocked + " blocked");
        if (inProgressTitle) segs.push("\u25b6 \u201c" + trunc(inProgressTitle, 60) + "\u201d");
        return segs.join(" \u00b7 ");
      }
    }

    if (lname.indexOf("memory") >= 0) {
      var memAction = parsed.action || parsed.command || parsed.op || "";
      var memName = parsed.name || parsed.title || parsed.key || parsed.path || parsed.id || "";
      var memBody = parsed.content || parsed.value || parsed.body || parsed.text || parsed.data || "";
      var bits = [];
      if (memAction && typeof memAction === "string") bits.push(memAction);
      if (memName) bits.push(String(memName));
      if (memBody && typeof memBody === "string") {
        var oneLine = memBody.replace(/\s+/g, " ").trim();
        if (oneLine) bits.push("\u201c" + trunc(oneLine, 70) + "\u201d");
      }
      if (bits.length > 0) return bits.join(" \u00b7 ");
    }

    if (lname.indexOf("runsubagent") >= 0 || lname === "tool/runsubagent") {
      var agent = parsed.subagent_type || parsed.agent || parsed.agent_name || "";
      var promptText = parsed.prompt || parsed.description || "";
      var quoted = promptText ? "\u201c" + trunc(promptText, 60) + "\u201d" : "";
      if (agent && quoted) return agent + " \u00b7 " + quoted;
      if (agent) return agent;
      if (quoted) return quoted;
    }

    // Generic fallback: probe args for common shapes in priority order.
    // We try the most informative signals first so unknown tools still get
    // a readable headline without per-tool wiring.
    var pathLikeKey = function (k) {
      var lk = k.toLowerCase();
      return lk === "path" || lk === "filepath" || lk === "file_path" || lk === "file"
        || lk === "uri" || lk === "url" || lk === "filename" || lk === "directory"
        || lk === "dir" || lk === "cwd" || lk.indexOf("path") >= 0 || lk.indexOf("file") >= 0;
    };
    var queryLikeKey = function (k) {
      var lk = k.toLowerCase();
      return lk === "query" || lk === "q" || lk === "search" || lk === "pattern"
        || lk === "prompt" || lk === "input" || lk === "text" || lk === "message"
        || lk === "command" || lk === "cmd";
    };
    var bodyLikeKey = function (k) {
      var lk = k.toLowerCase();
      return lk === "content" || lk === "body" || lk === "code" || lk === "data"
        || lk === "value" || lk === "filecontents";
    };
    var idLikeKey = function (k) {
      var lk = k.toLowerCase();
      return lk === "name" || lk === "id" || lk === "title" || lk === "key" || lk === "label";
    };

    var entries = Object.entries(parsed);

    // 1. URL-like value (full http(s) URL) -- show host + path
    for (var ui = 0; ui < entries.length; ui++) {
      var uv = entries[ui][1];
      if (typeof uv === "string" && /^https?:\/\//i.test(uv)) {
        try {
          var url = new URL(uv);
          return url.hostname + (url.pathname && url.pathname !== "/" ? url.pathname : "");
        } catch (_e) { return trunc(uv, 80); }
      }
    }

    // 2. Path-like key with absolute or workspace-relative string value
    for (var pi = 0; pi < entries.length; pi++) {
      var pk = entries[pi][0]; var pv = entries[pi][1];
      if (typeof pv === "string" && pv.length > 0 && pathLikeKey(pk)) {
        var stripped = stripRoot(pv, workspaceRoot);
        // If stripping made it relative ('./...') keep it -- shows location.
        // If not stripped (path outside workspace), fall back to basename
        // for clearly-file paths so we don't show useless absolute prefixes.
        if (stripped !== pv) return trunc(stripped, 80);
        if (/\.[a-z0-9]{1,8}$/i.test(stripped)) return basename(stripped);
        return trunc(stripped, 80);
      }
    }

    // 3. Action + name pair (manage_*, set_*, update_*, etc.)
    var actionVal = parsed.action || parsed.command || parsed.op || parsed.operation || parsed.method;
    var nameVal = null;
    for (var ni = 0; ni < entries.length; ni++) {
      var nk = entries[ni][0];
      if (idLikeKey(nk) && typeof entries[ni][1] === "string") { nameVal = entries[ni][1]; break; }
    }
    if (actionVal && nameVal) return actionVal + " \u00b7 " + trunc(nameVal, 60);

    // 4. Query/command-like value
    for (var qi = 0; qi < entries.length; qi++) {
      var qk = entries[qi][0]; var qv = entries[qi][1];
      if (typeof qv === "string" && qv.length > 0 && queryLikeKey(qk)) {
        return trunc(qv.replace(/\s+/g, " ").trim(), 80);
      }
    }

    // 5. Body-like value -- show size signal instead of contents
    for (var bi = 0; bi < entries.length; bi++) {
      var bk = entries[bi][0]; var bv = entries[bi][1];
      if (typeof bv === "string" && bodyLikeKey(bk) && bv.length > 0) {
        var bChars = bv.length;
        var bLines = bv.split("\n").length;
        var cs = bChars >= 1000 ? (bChars / 1000).toFixed(bChars >= 10000 ? 0 : 1) + "k" : String(bChars);
        return bk + ": " + bLines + " line" + (bLines === 1 ? "" : "s") + ", " + cs + " chars";
      }
    }

    // 6. Array of paths/items -- show count + first
    for (var ai = 0; ai < entries.length; ai++) {
      var ak = entries[ai][0]; var av = entries[ai][1];
      if (Array.isArray(av) && av.length > 0) {
        var first = av[0];
        if (typeof first === "string") {
          var firstShown = pathLikeKey(ak) ? basename(stripRoot(first, workspaceRoot)) : trunc(first, 50);
          if (av.length === 1) return firstShown;
          return firstShown + " +" + (av.length - 1) + " more";
        }
        return ak + " \u00d7 " + av.length;
      }
    }

    // 7. Last resort: a string-typed id/name even without an action
    if (nameVal) return trunc(nameVal, 80);

    // 8. Final fallback -- single key: value
    var keys = Object.keys(parsed);
    if (keys.length > 0) {
      var k = keys[0];
      var v = parsed[k];
      if (typeof v === "string") return k + ": " + trunc(v, 80);
      if (typeof v === "number" || typeof v === "boolean") return k + ": " + v;
      if (Array.isArray(v)) return k + ": [" + v.length + "]";
      if (v && typeof v === "object") {
        var sub = Object.keys(v);
        return k + ": {" + (sub.length ? sub[0] + ", \u2026" : "") + "}";
      }
    }
  }

  return ev.argsSummary || "";
}

// Names of LLM calls that represent a real agent/chat turn (vs UI overhead
// like title or promptCategorization). For these we want a richer "what
// happened" label instead of the static friendlyCallName.
var AGENT_TURN_NAMES = { "panel/editAgent": true, "panel/request": true, "tool/runSubagent": true };

function stripLeadingMarkdown(line) {
  return (line || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>+\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^```\w*\s*$/, "")
    .trim();
}

function firstVisibleSnippet(text, max) {
  if (!text) return "";
  var limit = max || 90;
  var lines = String(text).split("\n");
  for (var i = 0; i < lines.length; i++) {
    var s = stripLeadingMarkdown(lines[i]);
    if (s.length >= 3) {
      return s.length > limit ? s.slice(0, limit) + "\u2026" : s;
    }
  }
  return "";
}

function firstLine(text) {
  if (!text) return "";
  var i = text.indexOf("\n");
  var line = (i >= 0 ? text.slice(0, i) : text).trim();
  if (line.length > 90) line = line.slice(0, 90) + "…";
  return line;
}

function summarizeToolCalls(calls) {
  if (!calls || calls.length === 0) return "";
  var counts = {};
  calls.forEach(function (c) {
    var n = c && c.name ? c.name : "tool";
    counts[n] = (counts[n] || 0) + 1;
  });
  var names = Object.keys(counts);
  var parts = names.slice(0, 3).map(function (n) {
    return counts[n] > 1 ? n + " \u00d7" + counts[n] : n;
  });
  if (names.length > 3) parts.push("+" + (names.length - 3) + " more");
  return parts.join(", ");
}

// Build a smart label for an agent-turn LLM event. Prefers the tools the
// model called this turn; falls back to the first line of the response.
function smartTurnLabel(ev) {
  var toolPart = summarizeToolCalls(ev.producedToolCalls);
  if (toolPart) return "\u2192 " + toolPart;
  var text = firstLine(ev.responsePreview);
  if (text) return "\u201c" + text + "\u201d";
  return "";
}

// Returns { index, total } for ev within its prompt's LLM events with the
// same name. 1-based. total=1 when there's only one such call (we suppress
// the counter in that case).
function turnIndexWithinPrompt(promptEvents, targetEvent) {
  var matches = (promptEvents || []).filter(function (e) {
    return e.kind === "llm" && e.name === targetEvent.name;
  });
  var idx = matches.indexOf(targetEvent);
  return { index: idx + 1, total: matches.length };
}

function fmt$(n) {
  if (n == null || isNaN(n)) return isCredits() ? "0 cr" : "$0";
  if (isCredits()) {
    var c = n * 100; // 100 credits = $1
    var a = Math.abs(c);
    var sign = c < 0 ? "-" : "";
    if (a < 0.01) return sign + a.toFixed(3) + " cr";
    if (a < 1) return sign + a.toFixed(2) + " cr";
    if (a < 10) return sign + a.toFixed(2) + " cr";
    if (a < 100) return sign + a.toFixed(1) + " cr";
    return sign + Math.round(a).toLocaleString() + " cr";
  }
  return n < 0.01 ? "$" + n.toFixed(5) : "$" + n.toFixed(4);
}
function fmtT(n) {
  if (n == null || isNaN(n)) return "0";
  var a = Math.abs(n);
  var sign = n < 0 ? "-" : "";
  return sign + (a >= 1000 ? (a / 1000).toFixed(1) + "k" : "" + Math.round(a));
}
function fmtTSigned(n) {
  if (n == null || isNaN(n)) return "+0";
  var a = Math.abs(n);
  var sign = n >= 0 ? "+" : "-";
  return sign + (a >= 1000 ? (a / 1000).toFixed(2) + "k" : "" + Math.round(a));
}

// Map cacheAnalysis field names (camelCase) to mockup field names.
function eventCumParts(ev, cumState) {
  return {
    fresh: cumState.fresh,
    cwrite: cumState.cwrite,
    cached: cumState.cached,
    output: cumState.output,
  };
}

// Build cumulative cost timeline for stacked bars.
// When includeOverhead is false, overhead LLM calls (e.g. `title`,
// `promptCategorization`) contribute zero so the cum bars on visible rows
// reflect only the user-facing chat flow.
function buildCumStates(prompts, includeOverhead) {
  var freshAcc = 0, cwriteAcc = 0, cachedAcc = 0, outputAcc = 0;
  var states = [];
  prompts.forEach(function (p) {
    p.events.forEach(function (ev) {
      if (ev.kind === "llm" && (includeOverhead || ev.category !== "overhead")) {
        // Decompose this call's cost into its 4 cost components for the stacked
        // cum bar. We approximate by calling the same per-token rates.
        // Use the raw counts from the event (they sum to ev.cost).
        // Per-call cost split = fresh + cached_read + cache_write + output.
        // We don't know exact per-component prices here; approximate from totals.
        // The component values themselves come from cost analysis.
        // For visual proportions, scale each by their token counts.
        var totalToks = ev.fresh + ev.cached + ev.cacheWrite + ev.output;
        if (totalToks > 0 && ev.cost > 0) {
          // crude weights per token type (Anthropic-like ratios)
          var weights = {
            fresh: ev.fresh * 1.0,
            cached: ev.cached * 0.1,
            cwrite: ev.cacheWrite * 1.25,
            output: ev.output * 5.0,
          };
          var wSum = weights.fresh + weights.cached + weights.cwrite + weights.output || 1;
          freshAcc += ev.cost * (weights.fresh / wSum);
          cachedAcc += ev.cost * (weights.cached / wSum);
          cwriteAcc += ev.cost * (weights.cwrite / wSum);
          outputAcc += ev.cost * (weights.output / wSum);
        }
      }
      states.push({
        fresh: freshAcc,
        cached: cachedAcc,
        cwrite: cwriteAcc,
        output: outputAcc,
      });
    });
  });
  return states;
}

function StackBar(props) {
  var parts = props.parts;
  var keys = props.keys;
  var colors = props.colors;
  var labels = props.labels;
  var maxVal = props.maxVal;
  var withLabel = props.withLabel;
  var formatFn = props.formatFn;
  var sum = keys.reduce(function (a, k) { return a + (parts[k] || 0); }, 0);
  if (sum === 0) {
    return (
      <div style={{ position: "relative", width: "100%", height: 18, background: theme.bg.base, borderRadius: 2, overflow: "hidden" }}>
        <span style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic", paddingLeft: 6, lineHeight: "18px" }}>--</span>
      </div>
    );
  }
  var fillPct = 100 * sum / maxVal;
  var fmt = formatFn || ((maxVal < 1) ? fmt$ : fmtT);
  var lab = fmt(sum);
  return (
    <div style={{ position: "relative", width: "100%", height: 18, background: theme.bg.base, borderRadius: 2, overflow: "hidden" }}>
      <div style={{ display: "flex", height: "100%", width: fillPct + "%" }}>
        {keys.map(function (k) {
          var v = parts[k] || 0;
          if (v === 0) return null;
          var w = 100 * v / sum;
          var valStr = formatFn ? formatFn(v) : ((maxVal < 1) ? fmt$(v) : fmtT(v));
          return (
            <div key={k}
              title={labels[k] + " · " + valStr + " (" + (100 * v / sum).toFixed(1) + "% of bar)"}
              style={{ height: "100%", background: colors[k], width: w + "%" }} />
          );
        })}
      </div>
      {withLabel && (
        <div style={{
          position: "absolute",
          right: fillPct < 35 ? "auto" : 6,
          left: fillPct < 35 ? (fillPct + 1) + "%" : "auto",
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: theme.fontSize.xs,
          color: theme.text.primary,
          fontVariantNumeric: "tabular-nums",
          background: theme.bg.base,
          border: "1px solid " + theme.border.subtle,
          borderRadius: 3,
          padding: "0 5px",
          lineHeight: "14px",
          pointerEvents: "none",
        }}>{lab}</div>
      )}
    </div>
  );
}

function ToolGroups(props) {
  var groups = props.groups || [];
  var routerNames = props.routerNames || null;
  var [expanded, setExpanded] = useState({});
  // Map parser group `source` → kind
  var grouped = groups.map(function (g) {
    var name = g.source || g.label || "Built-in";
    var lower = name.toLowerCase();
    var kind = lower.indexOf("mcp") >= 0 ? "mcp"
      : (lower.indexOf("ext") >= 0 || lower.indexOf("extension") >= 0) ? "extension"
      : "builtin";
    var allTools = (g.tools || []).map(function (t) {
      if (Array.isArray(t)) return { name: t[0], tokens: t[1] };
      return { name: t.name, tokens: t.tokens };
    });
    return {
      label: name,
      kind: kind,
      count: g.tools ? g.tools.length : (g.count || 0),
      tokens: g.tokens || g.scaled_tokens || 0,
      top: (g.tools || g.top || []).slice(0, 5).map(function (t) {
        if (Array.isArray(t)) return { name: t[0], tokens: t[1], description: "", paramSummary: "" };
        return { name: t.name, tokens: t.tokens, description: t.description || "", paramSummary: t.paramSummary || "" };
      }),
      rest: allTools.slice(5),
      total: g.tools ? g.tools.length : (g.count || 0),
    };
  });
  var byKind = { mcp: 0, extension: 0, builtin: 0 };
  grouped.forEach(function (g) { byKind[g.kind] += g.tokens; });
  var totalKind = byKind.mcp + byKind.extension + byKind.builtin || 1;
  return (
    <div>
      <div style={{ display: "flex", height: 6, borderRadius: 1, overflow: "hidden", marginTop: 6, marginBottom: 6 }}>
        {["mcp", "extension", "builtin"].map(function (k) {
          if (!byKind[k]) return null;
          return <div key={k} title={k + ": " + fmtT(byKind[k]) + " tok"} style={{ height: "100%", background: KIND_COLORS[k], width: (100 * byKind[k] / totalKind) + "%" }} />;
        })}
      </div>
      {grouped.map(function (g, i) {
        var open = expanded[i];
        return (
          <div key={i}>
            <div onClick={function () { setExpanded(Object.assign({}, expanded, { [i]: !open })); }}
              style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, fontSize: theme.fontSize.sm, padding: "3px 0", alignItems: "center", cursor: "pointer" }}>
              <div style={{ color: theme.text.primary }}>
                <span style={{
                  display: "inline-block", fontSize: theme.fontSize.xs, padding: "1px 5px", borderRadius: 9,
                  marginRight: 6, fontWeight: 600, letterSpacing: 0.4,
                  background: g.kind === "mcp" ? theme.cost.chipBgMcp : g.kind === "extension" ? theme.cost.chipBgExtension : theme.cost.chipBgBuiltin,
                  color: KIND_COLORS[g.kind],
                }}>{g.kind.toUpperCase()}</span>
                {g.label}
              </div>
              <div style={{ color: theme.text.muted, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                {g.count} tool{g.count === 1 ? "" : "s"}
              </div>
              <div style={{ color: theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right", fontWeight: 500 }}>
                {fmtT(g.tokens)} tok
              </div>
            </div>
            {open && (
              <div style={{ paddingLeft: 10, color: theme.text.muted, fontSize: theme.fontSize.xs, borderLeft: "1px solid " + theme.border.default, marginBottom: 4 }}>
                {g.top.map(function (t, j) {
                  var tip = "";
                  if (t.description) tip += t.description;
                  if (t.paramSummary) tip += (tip ? "\n\n" : "") + "params: " + t.paramSummary;
                  return (
                    <div key={j}
                      title={tip || undefined}
                      style={{ padding: "2px 0", display: "grid", gridTemplateColumns: "1fr auto", gap: 6, fontVariantNumeric: "tabular-nums", cursor: tip ? "help" : "default" }}>
                      <span style={{ color: theme.text.secondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.name}
                        {routerNames && routerNames.has(t.name) && (
                          <span
                            title="Router/grouped tool: this single schema can stand in for many hidden or deferred subcommands. Unless it was invoked with discovery arguments (e.g. learn=true), those subcommands were not expanded in this run."
                            style={{
                              display: "inline-block", marginLeft: 6,
                              fontSize: theme.fontSize.xs, padding: "0 4px", borderRadius: 8,
                              background: theme.cost.chipBgMcp, color: KIND_COLORS.mcp,
                              fontWeight: 700, letterSpacing: 0.4, cursor: "help",
                              verticalAlign: "middle",
                            }}
                          >ROUTER</span>
                        )}
                        {tip && <span style={{ marginLeft: 6, opacity: 0.55 }}>ⓘ</span>}
                      </span>
                      <span>{fmtT(t.tokens)} tok</span>
                    </div>
                  );
                })}
                {g.count > g.top.length && (function () {
                  var more = g.rest || [];
                  var tip = more.map(function (t) {
                    return t.name + (t.tokens != null ? "  " + fmtT(t.tokens) + " tok" : "");
                  }).join("\n");
                  return (
                    <div title={tip || undefined} style={{ padding: "2px 0", opacity: 0.75, cursor: tip ? "help" : "default" }}>
                      +{g.count - g.top.length} more{tip && <span style={{ marginLeft: 6, opacity: 0.8 }}>ⓘ</span>}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CachedRowsHeader(props) {
  return (
    <button onClick={props.onClick} style={{
      display: "flex", alignItems: "center", gap: 6, width: "100%",
      background: "transparent", border: "none", padding: "4px 0",
      borderBottom: "1px dashed " + theme.border.subtle,
      fontFamily: theme.font.mono, fontSize: theme.fontSize.xs,
      color: theme.text.muted, cursor: "pointer", textAlign: "left",
      marginBottom: props.open ? 4 : 0,
    }} title={props.open ? "Hide cached entries" : "Show cached entries (reused from prior calls, not billed this call)"}>
      <span style={{ display: "inline-block", width: 10, color: theme.text.dim }}>{props.open ? "\u25bc" : "\u25b6"}</span>
      <span>{props.count} cached {props.noun}{props.count === 1 ? "" : "s"} {props.open ? "(hide)" : "(show)"}</span>
      <span style={{ marginLeft: "auto", color: theme.text.dim }}>reused from prior calls</span>
    </button>
  );
}

function HistoryList(props) {
  var msgs = props.msgs || [];
  var newCount = typeof props.newCount === "number" ? props.newCount : msgs.length;
  if (!msgs.length) return <div style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic" }}>no prior conversation</div>;
  var cachedCount = msgs.length - newCount;
  var [showCached, setShowCached] = React.useState(false);
  var renderRow = function (m, i) {
    var isCached = i < cachedCount;
    var raw = (m.preview || "").replace(/\s+/g, " ").trim();
    var summary = raw.length > 90 ? raw.slice(0, 90) + "\u2026" : raw;
    var tip = (m.role || "?") + " \u00b7 " + (m.chars || 0).toLocaleString() + " chars \u00b7 ~" + fmtT(m.tokens || 0) + " tok"
      + (isCached ? " \u00b7 cached from prior call" : " \u00b7 new this call")
      + (m.preview ? "\n\n" + m.preview : "");
    var rowOpacity = isCached ? 0.55 : 1;
    return (
      <div key={i}
        title={tip}
        style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, fontSize: theme.fontSize.sm, padding: "3px 0", alignItems: "baseline", borderTop: i === 0 ? "none" : "1px solid " + theme.border.subtle, opacity: rowOpacity, cursor: m.preview ? "help" : "default" }}>
        <span style={{
          fontSize: theme.fontSize.xs, padding: "1px 5px", borderRadius: 9, fontWeight: 600, letterSpacing: 0.4,
          background: m.role === "user" ? theme.cost.chipBgExtension : theme.cost.chipBgAssistant,
          color: m.role === "user" ? theme.cost.cwrite : theme.cost.fresh,
        }}>{m.role}</span>
        <span style={{ color: isCached ? theme.text.muted : theme.text.secondary, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
        <span style={{ color: isCached ? theme.text.muted : theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmtT(m.tokens || 0)}</span>
      </div>
    );
  };
  var cachedMsgs = msgs.slice(0, cachedCount);
  var newMsgs = msgs.slice(cachedCount);
  return (
    <div>
      {cachedCount > 0 && (
        <>
          <CachedRowsHeader count={cachedCount} noun="message" open={showCached} onClick={function () { setShowCached(!showCached); }} />
          {showCached && cachedMsgs.map(function (m, i) { return renderRow(m, i); })}
        </>
      )}
      {newMsgs.map(function (m, i) { return renderRow(m, cachedCount + i); })}
    </div>
  );
}

function ToolResultList(props) {
  var msgs = props.msgs || [];
  var newCount = typeof props.newCount === "number" ? props.newCount : msgs.length;
  if (!msgs.length) return <div style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic" }}>none in this call</div>;
  var cachedCount = msgs.length - newCount;
  var [showCached, setShowCached] = React.useState(false);
  var renderRow = function (m, i) {
    var label = m.label || ("result " + (i + 1));
    var isCached = i < cachedCount;
    var raw = (m.preview || "").replace(/\s+/g, " ").trim();
    var summary = raw.length > 90 ? raw.slice(0, 90) + "\u2026" : raw;
    var tip = label + " \u00b7 " + (m.chars || 0).toLocaleString() + " chars \u00b7 ~" + fmtT(m.tokens || 0) + " tok"
      + (isCached ? " \u00b7 cached from prior call" : " \u00b7 new this call")
      + (m.preview ? "\n\n" + m.preview : "");
    var rowOpacity = isCached ? 0.55 : 1;
    return (
      <div key={i}
        title={tip}
        style={{ display: "grid", gridTemplateColumns: "minmax(0, auto) 1fr auto", gap: 8, fontSize: theme.fontSize.sm, padding: "3px 0", alignItems: "baseline", borderTop: i === 0 ? "none" : "1px solid " + theme.border.subtle, opacity: rowOpacity, cursor: m.preview ? "help" : "default" }}>
        <span
          style={{ fontSize: theme.fontSize.xs, padding: "1px 6px", borderRadius: 9, fontWeight: 600, letterSpacing: 0.2, background: theme.cost.chipBgResult, color: theme.cost.ctxToolResults, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >{label}</span>
        <span style={{ color: isCached ? theme.text.muted : theme.text.secondary, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
        <span style={{ color: isCached ? theme.text.muted : theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmtT(m.tokens || 0)}</span>
      </div>
    );
  };
  var cachedMsgs = msgs.slice(0, cachedCount);
  var newMsgs = msgs.slice(cachedCount);
  return (
    <div>
      {cachedCount > 0 && (
        <>
          <CachedRowsHeader count={cachedCount} noun="result" open={showCached} onClick={function () { setShowCached(!showCached); }} />
          {showCached && cachedMsgs.map(function (m, i) { return renderRow(m, i); })}
        </>
      )}
      {newMsgs.map(function (m, i) { return renderRow(m, cachedCount + i); })}
    </div>
  );
}

function NewBlock(props) {
  var newPerBucket = props.newPerBucket || {};
  var newTotal = props.newTotal || 0;
  var totalIn = props.totalIn || 0;
  var label = props.label || "this call";
  var sum = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (newPerBucket[k] || 0); }, 0) || 1;
  var pct = totalIn ? 100 * newTotal / totalIn : 0;
  return (
    <div style={{
      background: theme.cost.okBg, border: "1px solid " + theme.cost.okBorder, borderRadius: 5,
      padding: "11px 13px", marginBottom: 14,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ color: theme.cost.fresh, fontSize: theme.fontSize.sm, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
          ▲ Billed as new {label}: {fmtT(newTotal)} tok ({pct.toFixed(1)}% of input)
        </div>
        <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, fontVariantNumeric: "tabular-nums" }}>
          {(100 - pct).toFixed(1)}% reused from cache · {fmtT(totalIn - newTotal)} cached tok
        </div>
      </div>
      <div style={{ height: 14, background: theme.cost.okBarTrack, borderRadius: 2, overflow: "hidden", display: "flex", marginBottom: 8 }}>
        {CTX_INPUT_KEYS.map(function (k) {
          var v = newPerBucket[k] || 0;
          if (v === 0) return null;
          var w = 100 * v / sum;
          return (
            <div key={k}
              title={CTX_LABELS[k] + " · " + fmtT(v) + " new tok · " + (100 * v / sum).toFixed(1) + "% of new content"}
              style={{ height: "100%", background: CTX_COLORS[k], width: w + "%" }} />
          );
        })}
        {!sum && <div style={{ height: "100%", background: theme.bg.raised, width: "100%" }} />}
      </div>
      <div style={{ fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.7 }}>
        {CTX_INPUT_KEYS.filter(function (k) { return (newPerBucket[k] || 0) > 0; })
          .map(function (k) {
            return (
              <div key={k} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "baseline" }}>
                <span>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 1, background: CTX_COLORS[k], marginRight: 6 }} />
                  <b style={{ color: theme.text.primary, fontWeight: 500 }}>{CTX_LABELS[k]}</b>
                </span>
                <span />
                <span style={{ color: theme.cost.fresh, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>+{fmtT(newPerBucket[k])} tok</span>
              </div>
            );
          })}
        {!sum && <div style={{ opacity: 0.6 }}>No new content this call (everything cached)</div>}
      </div>
    </div>
  );
}

function DetailSection(props) {
  return (
    <div style={{ background: theme.bg.surface, border: "1px solid " + theme.border.default, borderRadius: 4, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, fontSize: theme.fontSize.sm }}>
        <span style={{ color: theme.text.primary, fontWeight: 600 }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 1, marginRight: 6, background: CTX_COLORS[props.bucket] }} />
          {CTX_LABELS[props.bucket]}
        </span>
        <span style={{ color: theme.text.secondary, fontVariantNumeric: "tabular-nums" }}>
          {props.valuePrefix || ""}{fmtT(props.value)} tok{props.pctLabel === "cached" ? " · cached" : props.pctLabel ? " · " + props.pct.toFixed(1) + "% " + props.pctLabel : ""}
        </span>
      </div>
      {props.children}
    </div>
  );
}

function renderSystemAnatomy(ev) {
  var skills = ev.skills || [];
  var scaff = ev.scaffoldingSections || [];
  var fileAtts = ev.fileAttachments || [];
  var instAtts = ev.instructionAttachments || [];
  var subAgents = ev.subAgents || [];
  var toolPrefixInst = ev.toolPrefixInstructions || [];
  var sysTok = (ev.components && ev.components.system) || 0;
  var sysChars = ev.systemChars || 0;
  if (skills.length === 0 && scaff.length === 0 && fileAtts.length === 0 && !ev.chatMode && instAtts.length === 0 && subAgents.length === 0 && toolPrefixInst.length === 0) {
    if (!ev.systemPreview) return null;
    return <div style={textBlockStyle()}>{ev.systemPreview}{ev.systemPreview.length >= 300 ? "…" : ""}</div>;
  }
  var charsToScaledTok = function (chars) {
    return sysChars > 0 && sysTok > 0 ? Math.round(chars / sysChars * sysTok) : Math.round(chars / 4);
  };
  var skillsChars = skills.reduce(function (a, s) { return a + s.chars; }, 0);
  var scaffChars = scaff.reduce(function (a, s) { return a + s.chars; }, 0);
  var modeChars = (ev.chatMode && ev.chatMode.body) ? ev.chatMode.body.length : 0;
  var instAttsChars = instAtts.reduce(function (a, x) { return a + x.chars; }, 0);
  var fileAttsChars = fileAtts.reduce(function (a, x) { return a + x.chars; }, 0);
  var subAgentsChars = subAgents.reduce(function (a, x) { return a + x.chars; }, 0);
  var toolPrefixChars = toolPrefixInst.reduce(function (a, x) { return a + x.chars; }, 0);
  var classifiedChars = skillsChars + scaffChars + modeChars + instAttsChars + fileAttsChars + subAgentsChars + toolPrefixChars;
  var otherChars = Math.max(0, sysChars - classifiedChars);
  var pctOf = function (chars) {
    return sysChars > 0 ? (100 * chars / sysChars).toFixed(1) + "%" : "—";
  };
  var rows = [
    {
      key: "scaff",
      label: "Copilot built-in scaffolding (" + scaff.length + " section" + (scaff.length === 1 ? "" : "s") + ")",
      chars: scaffChars,
      color: theme.cost.ctxToolDefs,
      body: scaff.length > 0 ? (
        <div style={{ marginTop: 6, fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
          {scaff.map(function (s, i) {
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: s.body ? "help" : "default" }} title={s.body ? "<" + s.tag + ">  ·  " + s.chars.toLocaleString() + " chars\n\n" + s.body : "<" + s.tag + ">  ·  " + s.chars.toLocaleString() + " chars"}>
                <span style={{ color: theme.text.primary }}>&lt;{s.tag}&gt;</span>
                <span style={{ color: theme.text.muted, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{s.chars.toLocaleString()} ch · ~{fmtT(charsToScaledTok(s.chars))} tok</span>
              </div>
            );
          })}
          <div style={{ marginTop: 6, color: theme.text.muted, fontStyle: "italic", fontFamily: theme.font.sans }}>Hover any tag to preview its body text.</div>
        </div>
      ) : null,
    },
    {
      key: "skills",
      label: "Skills (" + skills.length + ")",
      chars: skillsChars,
      color: theme.cost.kindMcp,
      body: skills.length > 0 ? (
        <div style={{ marginTop: 6, maxHeight: 320, overflow: "auto", fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
          {skills.map(function (s, i) {
            var tip = s.name +
              (s.file ? "\n" + s.file : "") +
              "\n~" + fmtT(charsToScaledTok(s.chars)) + " tok · " + s.chars.toLocaleString() + " chars" +
              (s.description ? "\n\n" + s.description : "");
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: "help" }} title={tip}>
                <span style={{ color: theme.cost.kindMcp, fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: theme.text.muted, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{s.chars.toLocaleString()} ch · ~{fmtT(charsToScaledTok(s.chars))} tok</span>
              </div>
            );
          })}
          <div style={{ marginTop: 6, color: theme.text.muted, fontStyle: "italic", fontFamily: theme.font.sans }}>Hover any skill for file path and full description.</div>
        </div>
      ) : null,
    },
    {
      key: "subagents",
      label: "Sub-agents (" + subAgents.length + ")",
      chars: subAgentsChars,
      color: theme.accent.primary,
      body: subAgents.length > 0 ? (
        <div style={{ marginTop: 6, fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
          {subAgents.map(function (a, i) {
            var tip = a.name +
              (a.argumentHint ? "\n\nArguments: " + a.argumentHint : "") +
              "\n~" + fmtT(charsToScaledTok(a.chars)) + " tok · " + a.chars.toLocaleString() + " chars" +
              (a.description ? "\n\n" + a.description : "");
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: "help" }} title={tip}>
                <span style={{ color: theme.accent.primary, fontWeight: 600 }}>{a.name || "(unnamed)"}</span>
                <span style={{ color: theme.text.muted, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{a.chars.toLocaleString()} ch · ~{fmtT(charsToScaledTok(a.chars))} tok</span>
              </div>
            );
          })}
          <div style={{ marginTop: 6, color: theme.text.muted, fontStyle: "italic", fontFamily: theme.font.sans }}>Sub-agents the model can launch via the <code>runSubagent</code> tool. Hover for full description.</div>
        </div>
      ) : null,
    },
    {
      key: "toolprefix",
      label: "MCP / tool-prefix instructions (" + toolPrefixInst.length + ")",
      chars: toolPrefixChars,
      color: theme.cost.kindMcp,
      body: toolPrefixInst.length > 0 ? (
        <div style={{ marginTop: 6, fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
          {toolPrefixInst.map(function (x, i) {
            var tip = "<instruction forToolsWithPrefix=\"" + x.prefix + "\">" +
              "\n~" + fmtT(charsToScaledTok(x.chars)) + " tok · " + x.chars.toLocaleString() + " chars" +
              "\n\n" + x.body;
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: "help" }} title={tip}>
                <span style={{ color: theme.cost.kindMcp, fontWeight: 600 }}>{x.prefix}</span>
                <span style={{ color: theme.text.muted, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{x.chars.toLocaleString()} ch · ~{fmtT(charsToScaledTok(x.chars))} tok</span>
              </div>
            );
          })}
          <div style={{ marginTop: 6, color: theme.text.muted, fontStyle: "italic", fontFamily: theme.font.sans }}>Per-tool-prefix instructions injected into the system prompt (typically by MCP servers). Hidden from the MCP server list but billed every call. Hover to see the body.</div>
        </div>
      ) : null,
    },
    {
      key: "mode",
      label: "Custom chat mode" + (ev.chatMode ? ": " + ev.chatMode.name : ""),
      chars: modeChars,
      color: theme.accent.primary,
      body: (ev.chatMode && ev.chatMode.body) ? (
        <div style={Object.assign(textBlockStyle(), { marginTop: 6, maxHeight: 360, overflow: "auto" })}>
          {ev.chatMode.body.length > 4000 ? ev.chatMode.body.slice(0, 4000) + "\n…[truncated]" : ev.chatMode.body}
        </div>
      ) : null,
    },
    {
      key: "inst",
      label: "Workspace instruction files (" + instAtts.length + ")",
      chars: instAttsChars,
      color: theme.cost.ctxHistory,
      body: instAtts.length > 0 ? (
        <div style={{ marginTop: 6, fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
          {instAtts.map(function (a, i) {
            var base = a.filePath.split("/").pop() || a.filePath;
            var tip = a.filePath + "\n~" + fmtT(charsToScaledTok(a.chars)) + " tok · " + a.chars.toLocaleString() + " chars";
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: "help" }} title={tip}>
                <span style={{ color: theme.text.primary }}>{base}</span>
                <span style={{ color: theme.text.muted, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{a.chars.toLocaleString()} ch · ~{fmtT(charsToScaledTok(a.chars))} tok</span>
              </div>
            );
          })}
          <div style={{ marginTop: 6, color: theme.text.muted, fontStyle: "italic", fontFamily: theme.font.sans }}>Hover for full path.</div>
        </div>
      ) : null,
    },
    {
      key: "files",
      label: "Other file attachments (" + fileAtts.length + ")",
      chars: fileAttsChars,
      color: theme.cost.ctxToolResults,
      body: fileAtts.length > 0 ? (
        <div style={{ marginTop: 6, fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
          {fileAtts.map(function (a, i) {
            var base = a.filePath.split("/").pop() || a.filePath;
            var tip = a.filePath + "\n~" + fmtT(charsToScaledTok(a.chars)) + " tok · " + a.chars.toLocaleString() + " chars";
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: "help" }} title={tip}>
                <span style={{ color: theme.text.primary }}>{base}</span>
                <span style={{ color: theme.text.muted, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{a.chars.toLocaleString()} ch · ~{fmtT(charsToScaledTok(a.chars))} tok</span>
              </div>
            );
          })}
          <div style={{ marginTop: 6, color: theme.text.muted, fontStyle: "italic", fontFamily: theme.font.sans }}>Hover for full path.</div>
        </div>
      ) : null,
    },
    {
      key: "other",
      label: "Other / unclassified system text" + (ev.systemPreamble ? " (incl. role preamble)" : ""),
      chars: otherChars,
      color: theme.cost.ctxSystem,
      body: ev.systemPreamble ? (
        <div>
          <div style={{ marginTop: 4, color: theme.text.muted, fontSize: theme.fontSize.xs }}>
            Role preamble — start of the system prompt before any tagged block ({ev.systemPreamble.length.toLocaleString()} chars):
          </div>
          <div style={Object.assign(textBlockStyle(), { marginTop: 6, maxHeight: 280, overflow: "auto" })}>
            {ev.systemPreamble}
          </div>
        </div>
      ) : null,
    },
  ].filter(function (r) { return r.chars > 0; });
  var openByDefault = {};
  if (!ev.chatMode && skills.length === 0) openByDefault.other = true;
  return (
    <div>
      <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginBottom: 8 }}>
        <div style={{ fontVariantNumeric: "tabular-nums" }}>
          {sysChars.toLocaleString()} chars · {fmtT(sysTok)} tok (API-reported total) · click ▸ to expand any section
        </div>
        <div style={{ marginTop: 4, color: theme.text.dim, fontStyle: "italic" }}>
          Chars are exact. Per-section <b>tok</b> values are pro-rata estimates of this run's total; they shift between runs when <i>other</i> sections change size, even when this section's chars are identical. Compare <b>chars</b> across runs to see real content changes.
        </div>
      </div>
      <div style={{ fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
        {rows.map(function (r) {
          var expandable = !!r.body;
          var summary = (
            <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
              <span style={{ display: "inline-block", width: 10, height: 10, background: r.color, borderRadius: 2, flex: "0 0 auto" }} />
              <span style={{ color: theme.text.primary, flex: "1 1 auto" }}>{r.label}</span>
              <span style={{ color: theme.text.muted, textAlign: "right", flex: "0 0 auto", fontVariantNumeric: "tabular-nums" }} title="Exact char count from the request body">{r.chars.toLocaleString()} ch</span>
              <span style={{ color: theme.text.dim, textAlign: "right", flex: "0 0 auto", width: 86, fontVariantNumeric: "tabular-nums" }} title="Pro-rata estimate of this section's share of the run's total prompt tokens. Will shift between runs when other sections change, even when this section's chars are identical.">~{fmtT(charsToScaledTok(r.chars))} tok est</span>
              <span style={{ color: theme.text.muted, textAlign: "right", flex: "0 0 auto", width: 48, fontVariantNumeric: "tabular-nums" }}>{pctOf(r.chars)}</span>
            </span>
          );
          if (!expandable) {
            return (
              <div key={r.key} style={{ display: "flex", alignItems: "center", padding: "3px 0 3px 18px" }}>
                {summary}
              </div>
            );
          }
          return (
            <details key={r.key} open={!!openByDefault[r.key]} style={{ padding: "1px 0" }}>
              <summary style={{ cursor: "pointer", listStylePosition: "outside", padding: "2px 0", color: theme.text.muted }}>
                {summary}
              </summary>
              <div style={{ padding: "4px 0 8px 18px" }}>{r.body}</div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function CollapsibleRow(props) {
  var _a = React.useState(false), open = _a[0], setOpen = _a[1];
  var stripe = props.accent || theme.border.default;
  return (
    <div style={{
      borderTop: props.first ? "none" : "1px solid " + theme.border.subtle,
      padding: "4px 0",
    }}>
      <div onClick={function () { setOpen(!open); }}
           style={{
             display: "grid", gridTemplateColumns: "14px auto 1fr", gap: 6, alignItems: "baseline",
             cursor: "pointer", padding: "2px 0",
           }}>
        <span style={{
          color: theme.text.muted, fontSize: theme.fontSize.xs, width: 12, textAlign: "center",
          transition: "transform .12s", display: "inline-block",
          transform: open ? "rotate(90deg)" : "none",
        }}>▶</span>
        {props.label}
        <span style={{
          fontFamily: theme.font.mono, fontSize: theme.fontSize.xs,
          color: theme.text.secondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }} title={props.previewTitle || ""}>{props.preview}</span>
      </div>
      {open && (
        <div style={{
          marginTop: 4, marginLeft: 18, padding: "8px 10px",
          background: theme.bg.surface, border: "1px solid " + theme.border.default,
          borderLeft: "2px solid " + stripe, borderRadius: 3,
        }}>
          {props.children}
        </div>
      )}
    </div>
  );
}

// Group identical consecutive reasoning blocks into a single entry with a
// repeat count. Blocks differ in `tool` association but share the same text
// content surprisingly often (the model re-emits the same thought before
// each parallel tool_use).
function groupReasoningBlocks(blocks) {
  var out = [];
  (blocks || []).forEach(function (rb) {
    var last = out[out.length - 1];
    if (last && last.text === rb.text && last.tool === rb.tool) {
      last.count += 1;
    } else {
      out.push({ text: rb.text, tool: rb.tool, count: 1 });
    }
  });
  return out;
}

// Try to pretty-print a tool's args. Returns a string suitable for a <pre>
// block. Multi-key objects render as 2-space-indented JSON; single-key
// objects with a long string value render as `key:\nvalue`.
function prettyToolArgs(tc) {
  if (!tc) return "";
  var raw = tc.rawArgs;
  if (!raw || typeof raw !== "string") return tc.argsSummary || "";
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      var keys = Object.keys(parsed);
      if (keys.length === 1) {
        var v = parsed[keys[0]];
        if (typeof v === "string" && v.length > 40) {
          return keys[0] + ":\n" + v;
        }
      }
      return JSON.stringify(parsed, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch (_e) {
    return raw;
  }
}

function LLMDetail(props) {
  var ev = props.event;

  // Synthesized rows are reconstructed from a missing `request` log entry.
  // We only have the response text and dispatched tool calls; token counts,
  // cost, cache split, and per-bucket breakdowns are simply not recoverable.
  // Render an honest "data not available" inspector rather than rendering
  // zeros that look like "this call was free".
  if (ev.synthesized) {
    var stripe = "repeating-linear-gradient(45deg, " + theme.bg.surface + " 0 6px, " + theme.bg.base + " 6px 12px)";
    var hasResp = ev.responsePreview && ev.responsePreview.trim().length > 0;
    var dispatched = ev.producedToolCalls || [];
    var unknownBox = function (label, hint) {
      return (
        <div style={{
          background: stripe, border: "1px dashed " + theme.border.default, borderRadius: 5,
          padding: "10px 12px", opacity: 0.85,
        }} title={hint || "Not recorded by VS Code's export -- request entry was missing."}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>{label}</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.text.ghost, fontWeight: 600, fontStyle: "italic" }}>unknown</div>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginTop: 6, lineHeight: 1.4 }}>
            Not recorded by the export.
          </div>
        </div>
      );
    };
    return (
      <div style={{ gridColumn: "1 / -1", background: theme.bg.base, borderBottom: "1px solid " + theme.border.subtle, padding: "14px 22px" }}>
        <div style={{
          background: theme.cost.switchBg, border: "1px solid " + theme.cost.switchBorder, color: theme.cost.switchText,
          padding: "9px 13px", margin: "0 0 12px", borderRadius: 4, fontSize: theme.fontSize.sm, lineHeight: 1.55,
        }}>
          <b style={{ color: theme.text.primary }}>Synthesized row -- request log missing.</b>{" "}
          VS Code did not write a <code>request</code> entry for this LLM round-trip, so token counts, cost, cache split, and the per-bucket new-input breakdown are not available. The response text and the {dispatched.length} dispatched tool call{dispatched.length === 1 ? "" : "s"} were recovered from the next request's message history.
        </div>
        <h4 style={{ margin: "0 0 8px", color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
          What we know
        </h4>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          {unknownBox("\u25b6 Prompt sent")}
          {unknownBox("\u25c0 Reply written")}
          {unknownBox("$ Cost for this call")}
        </div>
        <div style={{
          background: theme.bg.surface, border: "1px solid " + theme.border.subtle, borderRadius: 5,
          padding: "9px 12px", marginBottom: 12, fontSize: theme.fontSize.sm, color: theme.text.secondary,
        }}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, fontWeight: 600 }}>
            Recovered facts
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", alignItems: "baseline", fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
            <span style={{ color: theme.text.muted }}>model</span>
            <span style={{ color: theme.text.primary }}>
              {ev.model || <span style={{ color: theme.text.ghost, fontStyle: "italic" }}>unknown</span>}
              {ev.model && <span style={{ color: theme.text.muted, marginLeft: 6 }} title="The request entry was missing, so the model name is inferred from the next request in this prompt. Usually correct, but not guaranteed if a model switch happened mid-turn.">(inferred)</span>}
            </span>
            <span style={{ color: theme.text.muted }}>dispatched</span>
            <span style={{ color: theme.text.primary }}>
              {dispatched.length > 0
                ? dispatched.map(function (t, i) { return (i > 0 ? ", " : "") + t.name; }).join("")
                : <span style={{ color: theme.text.ghost, fontStyle: "italic" }}>none</span>}
            </span>
          </div>
        </div>
        {hasResp && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5, fontWeight: 600 }}>
              Response text (recovered from next request's history)
            </div>
            <div style={textBlockStyle()}>{ev.responsePreview}</div>
          </div>
        )}
      </div>
    );
  }

  var c = ev.components || {};
  var totalIn = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (c[k] || 0); }, 0);
  var pct = function (k) { return 100 * (c[k] || 0) / Math.max(1, totalIn); };

  var missCallout = null;
  if (ev.unexpectedMiss && ev.cacheMissDiag) {
    var d = ev.cacheMissDiag;
    var reasons = [];
    if (d.toolDefsChanged > 0) {
      reasons.push(<span key="r1"><b>{d.toolDefsChanged} of {d.totalToolDefs || d.n_total} tool definitions changed</b> since the previous call. Even one byte difference invalidates the cached prefix. Changed: {(d.changedSample || []).map(function (n, i) {
        return <code key={i} style={{ background: theme.cost.missCodeBg, border: "1px solid " + theme.cost.missCodeBorder, padding: "1px 5px", borderRadius: 2, color: theme.cost.missCodeText, fontSize: theme.fontSize.xs, marginRight: 4 }}>{n}</code>;
      })}{(d.changedSample || []).length < d.toolDefsChanged ? "…" : ""}</span>);
    }
    if ((d.added || []).length) reasons.push(<span key="r2">Tools added: {d.added.map(function (n, i) { return <code key={i} style={{ background: theme.cost.missCodeBg, border: "1px solid " + theme.cost.missCodeBorder, padding: "1px 5px", borderRadius: 2, color: theme.cost.missCodeText, fontSize: theme.fontSize.xs, marginRight: 4 }}>{n}</code>; })}</span>);
    if ((d.removed || []).length) reasons.push(<span key="r3">Tools removed: {d.removed.map(function (n, i) { return <code key={i} style={{ background: theme.cost.missCodeBg, border: "1px solid " + theme.cost.missCodeBorder, padding: "1px 5px", borderRadius: 2, color: theme.cost.missCodeText, fontSize: theme.fontSize.xs, marginRight: 4 }}>{n}</code>; })}</span>);
    if (reasons.length === 0) reasons.push(<span key="r4">Tools are identical to the previous call. The cache likely <b>expired</b> (Anthropic ephemeral cache TTL is ~5 min) or the cache_control breakpoint placement changed in the messages array.</span>);
    missCallout = (
      <div style={{
        background: theme.cost.missBg, border: "1px solid " + theme.cost.missBorder, color: theme.cost.missText,
        padding: "10px 13px", margin: "0 0 12px", borderRadius: 4, fontSize: theme.fontSize.sm, lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 600, color: theme.cost.missAccent, fontSize: theme.fontSize.base, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ background: theme.cost.missBorder, color: theme.text.primary, padding: "2px 7px", borderRadius: 3, fontSize: theme.fontSize.xs, letterSpacing: 0.5 }}>⚠ Unexpected cache miss</span>
        </div>
        We expected this call to hit the cache (<b style={{ color: theme.text.primary }}>{fmtT(ev.prevPt || 0)} tok</b> were cached on this model just before), but the API returned <b style={{ color: theme.text.primary }}>0 cached tokens</b>. The full <b style={{ color: theme.text.primary }}>{fmtT(ev.promptTokens)} tok</b> prefix was re-billed at premium write rate (~<b style={{ color: theme.text.primary }}>{fmt$(ev.cost)}</b>). Likely cause:
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {reasons.map(function (r, i) { return <li key={i} style={{ marginBottom: 2 }}>{r}</li>; })}
        </ul>
      </div>
    );
  }

  var recommitCallout = null;
  if (ev.modelSwitched) {
    var fresh = Math.max(0, ev.promptTokens - (ev.cached || 0));
    var hasServiceCache = (ev.cached || 0) > 0;
    var isSubagent = (ev.name || "").indexOf("runSubagent") !== -1;
    var hadPriorSameModel = (ev.priorSameModelPt || 0) > 0;

    var headline, body;
    if (isSubagent) {
      headline = <>⇄ <b style={{ color: theme.text.primary }}>Subagent invocation</b></>;
      body = <>this is a fresh conversation thread spawned by a tool call. Subagents do <b>not</b> inherit the parent agent's per-session cache, even when they run on the same model ({ev.model}).</>;
    } else if (hadPriorSameModel) {
      headline = <>↺ <b style={{ color: theme.text.primary }}>Cache reset</b></>;
      body = <>your previous call on <b style={{ color: theme.text.primary }}>{ev.model}</b> had <b style={{ color: theme.text.primary }}>{fmtT(ev.priorSameModelPt)} tok</b> of context, but the immediately prior LLM call used a different model (typically a small overhead call like <code>title</code> or <code>promptCategorization</code>). Per-session cache is short-lived across model bounces, so most of it was evicted.</>;
    } else {
      headline = <>⇄ <b style={{ color: theme.text.primary }}>Model switch</b></>;
      body = <>this call is on <b style={{ color: theme.text.primary }}>{ev.model}</b>, which has not been used in this session before. Per-session cache from prior models does not carry over.</>;
    }

    recommitCallout = (
      <div style={{ background: theme.cost.switchBg, border: "1px solid " + theme.cost.switchBorder, color: theme.cost.switchText, padding: "8px 11px", margin: "0 0 12px", borderRadius: 4, fontSize: theme.fontSize.sm, lineHeight: 1.55 }}>
        {headline} -- {body}
        {hasServiceCache ? (
          <> Of the <b style={{ color: theme.text.primary }}>{fmtT(ev.promptTokens)} tok</b> sent, <b style={{ color: theme.text.primary }}>{fmtT(ev.cached)} tok</b> still hit cache -- these come from Copilot's <b>shared service-side cache</b> (common system prompt and tool defs that are warm across sessions and users). The remaining <b style={{ color: theme.text.primary }}>{fmtT(fresh)} tok</b> are billed as new.</>
        ) : (
          <> All <b style={{ color: theme.text.primary }}>{fmtT(ev.promptTokens)} tok</b> are billed as new for this call.</>
        )}
      </div>
    );
  } else if (ev.recommit > 100) {
    recommitCallout = (
      <div style={{ background: theme.cost.recommitBg, border: "1px solid " + theme.cost.recommitBorder, color: theme.cost.cwrite, padding: "8px 11px", margin: "0 0 12px", borderRadius: 4, fontSize: theme.fontSize.sm, lineHeight: 1.55 }}>
        ↻ <b style={{ color: theme.text.primary }}>{fmtT(ev.recommit)} tok</b> of this call's billed-as-new content was actually <b>cache recommit</b> -- material the agent already had, but the cache expired so it had to be re-sent at premium rate. Net new context this call vs the previous one: <b style={{ color: theme.text.primary }}>{fmtTSigned(ev.deltaVsPrev)} tok</b>.
      </div>
    );
  }

  return (
    <div style={{ gridColumn: "1 / -1", background: theme.bg.base, borderBottom: "1px solid " + theme.border.subtle, padding: "14px 22px" }}>
      <h4 style={{ margin: "0 0 8px", color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
        What happened in this LLM call
      </h4>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        {(function () {
          var hasPx = ev.model && hasModelPricing(ev.model);
          var cachedCost = hasPx ? estimateCost({ inputTokens: 0, outputTokens: 0, cacheRead: ev.cached || 0, cacheWrite: 0 }, ev.model) : 0;
          var freshCost  = hasPx ? estimateCost({ inputTokens: ev.fresh || 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, ev.model) : 0;
          var cwriteCost = hasPx ? estimateCost({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: ev.cacheWrite || 0 }, ev.model) : 0;
          var newBillCost = freshCost + cwriteCost;
          var inputCost = cachedCost + newBillCost;
          var outputCost = hasPx ? estimateCost({ inputTokens: ev.output || 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, ev.model) : 0;
          // estimateCost above prices `output` at INPUT rate (wrong); recompute
          // honestly using the model's output rate.
          outputCost = hasPx ? estimateCost({ inputTokens: 0, outputTokens: ev.output || 0, cacheRead: 0, cacheWrite: 0 }, ev.model) : 0;
          var totalCost = inputCost + outputCost;
          var pt = ev.promptTokens || 0;
          var cached = ev.cached || 0;
          var cwriteTok = ev.cacheWrite || 0;
          var fresh = Math.max(0, pt - cached - cwriteTok);
          var billedNew = fresh + cwriteTok;
          var pctCachedSize = pt > 0 ? (100 * cached / pt) : 0;
          var pctFreshSize  = pt > 0 ? (100 * fresh / pt) : 0;
          var pctCwriteSize = pt > 0 ? (100 * cwriteTok / pt) : 0;
          // Reserve a minimum visible width per non-zero slice so tiny slivers
          // (e.g. 1% cache) are still readable.
          var minSlice = 4;
          var slices = [
            { pct: pctCachedSize, color: theme.cost.cached },
            { pct: pctFreshSize,  color: theme.cost.cwrite },
            { pct: pctCwriteSize, color: theme.cost.recommitBorder || theme.cost.fresh },
          ];
          var displaySum = 0;
          slices.forEach(function (s) {
            s.display = s.pct > 0 && s.pct < minSlice ? minSlice : s.pct;
            displaySum += s.display;
          });
          if (displaySum > 0 && displaySum !== 100) {
            slices.forEach(function (s) { s.display = s.display * 100 / displaySum; });
          }
          var pctInputOfTotal = totalCost > 0 ? Math.round(100 * inputCost / totalCost) : 0;
          var pctOutputOfTotal = totalCost > 0 ? 100 - pctInputOfTotal : 0;
          return (
          <>
        {/* Box 1: Prompt sent in (size + cache split bar) */}
        <div style={{ background: theme.bg.surface, border: "1px solid " + theme.cost.switchBorder, borderRadius: 5, padding: "10px 12px" }}
             title={hasPx ? "What was sent to the model on this call. The bar splits the prompt by what got cached (cheap) vs what was billed at full input rate." : "Total prompt size sent to the model"}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>▶ Prompt sent</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.cost.cached, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtT(pt)} tok</div>
          {pt > 0 && (
            <div style={{ marginTop: 8, marginBottom: 4 }}>
              <div style={{ display: "flex", width: "100%", height: 8, borderRadius: 2, overflow: "hidden", background: theme.bg.base }}>
                {cached > 0 && (
                  <div style={{ width: slices[0].display + "%", background: slices[0].color }}
                       title={fmtT(cached) + " tok reused from cache (~10% input rate)" + (hasPx ? " · " + fmt$(cachedCost) : "")} />
                )}
                {fresh > 0 && (
                  <div style={{ width: slices[1].display + "%", background: slices[1].color }}
                       title={fmtT(fresh) + " tok new, one-off (full input rate, won't be cached)" + (hasPx ? " · " + fmt$(freshCost) : "")} />
                )}
                {cwriteTok > 0 && (
                  <div style={{ width: slices[2].display + "%", background: slices[2].color }}
                       title={fmtT(cwriteTok) + " tok new, being cached for next call (1.25x premium write)" + (hasPx ? " · " + fmt$(cwriteCost) : "")} />
                )}
              </div>
            </div>
          )}
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginTop: 6, fontVariantNumeric: "tabular-nums", lineHeight: 1.5 }}>
            {cached > 0 && (
              <div title="Tokens served from the prompt cache. Charged at ~10% of the input rate.">
                <span style={{ color: slices[0].color }}>■</span> {fmtT(cached)} tok <b>reused from cache</b> · {pctCachedSize.toFixed(0)}%
              </div>
            )}
            {cwriteTok > 0 && (
              <div title="New material this call that the API is also committing to the cache. Costs 1.25x input rate now, but the next call gets it back at cache-read rate (much cheaper).">
                <span style={{ color: slices[2].color }}>■</span> {fmtT(cwriteTok)} tok <b>new, cached for next call</b> · {pctCwriteSize.toFixed(0)}% <span style={{ color: theme.text.muted }}>(1.25x premium)</span>
              </div>
            )}
            {fresh > 0 && (
              <div title="New material this call that is not eligible for caching (typically the user's latest message at the tail of the prompt). Charged at full input rate.">
                <span style={{ color: slices[1].color }}>■</span> {fmtT(fresh)} tok <b>new, one-off</b> · {pctFreshSize.toFixed(0)}% <span style={{ color: theme.text.muted }}>(won't help next call)</span>
              </div>
            )}
            {(cwriteTok > 0 || fresh > 0) && (
              <div style={{ color: theme.text.muted, marginTop: 3, fontStyle: "italic" }}>
                new this call total: {fmtT(cwriteTok + fresh)} tok ({(pctCwriteSize + pctFreshSize).toFixed(0)}%)
              </div>
            )}
            {(ev.deltaVsPrev || 0) !== 0 && (
              <div style={{ color: theme.text.muted, marginTop: 3 }}>
                {ev.modelSwitched
                  ? "first call on this model"
                  : (ev.prevPt ? "prompt grew " + fmtTSigned(ev.deltaVsPrev) + " vs previous call" : "first call in session")}
              </div>
            )}
          </div>
        </div>
        {/* Box 2: Model wrote (output size + visible/thinking split) */}
        <div style={{ background: theme.bg.surface, border: "1px solid " + theme.border.default, borderRadius: 5, padding: "10px 12px" }}
             title={hasPx ? "What the model generated. Output is billed at the model's output rate (typically ~5x input). Visible/thinking split is estimated from char share." : "Output tokens generated by the model"}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>◀ Reply written</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.text.primary, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtT(ev.output)} tok</div>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginTop: 6, fontVariantNumeric: "tabular-nums", lineHeight: 1.5 }}>
            {(function () {
              var visCh = ev.visibleResponseChars || 0;
              var thinkCh = ev.thinkingChars || 0;
              var argsCh = ev.toolArgsChars || 0;
              var sumCh = visCh + thinkCh + argsCh;
              var perTok = (hasPx && ev.output > 0) ? outputCost / ev.output : 0;
              var costStr = function (tok) {
                return perTok > 0 ? " · " + fmt$(tok * perTok) : "";
              };
              if (sumCh > 0 && ev.output > 0) {
                var estVis = Math.round(visCh / 4);
                var estThink = Math.round(thinkCh / 4);
                var estArgs = Math.round(argsCh / 4);
                var resid = Math.max(0, ev.output - estVis - estThink - estArgs);
                var rows = [];
                if (estVis > 0) rows.push(<div key="v">~{fmtT(estVis)} visible to user{costStr(estVis)}</div>);
                if (estThink > 0) rows.push(<div key="t">~{fmtT(estThink)} thinking{costStr(estThink)}</div>);
                if (estArgs > 0) rows.push(<div key="a">~{fmtT(estArgs)} tool-call args{costStr(estArgs)}</div>);
                if (resid > 0) rows.push(<div key="r" style={{ color: theme.text.muted }}>~{fmtT(resid)} unattributed{costStr(resid)}</div>);
                return rows;
              }
              if (ev.reasoningTokens > 0) {
                var visTok = ev.output - ev.reasoningTokens;
                return (
                  <>
                    <div>~{fmtT(visTok)} visible to user{costStr(visTok)}</div>
                    <div>~{fmtT(ev.reasoningTokens)} thinking{costStr(ev.reasoningTokens)}</div>
                  </>
                );
              }
              return null;
            })()}
          </div>
        </div>
        {/* Box 3: Cost for this call (total + input/output split) */}
        <div style={{ background: theme.bg.surface, border: "1px solid " + theme.cost.recommitBorder, borderRadius: 5, padding: "10px 12px" }}
             title={hasPx ? "Total cost charged for this call. = input cost + output cost. Input is already split (cached vs billed-new) in the Prompt box." : "Pricing unknown for this model"}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>$ Cost for this call</div>
          <div style={{ fontSize: theme.fontSize.lg, color: theme.cost.cwrite, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{hasPx ? fmt$(totalCost) : "—"}</div>
          {hasPx && (
            <div style={{ fontSize: theme.fontSize.xs, color: theme.text.secondary, marginTop: 6, fontVariantNumeric: "tabular-nums", lineHeight: 1.5 }}>
              <div><span style={{ color: theme.text.muted }}>input</span>  {fmt$(inputCost).padStart(7)} · {pctInputOfTotal}%</div>
              {cwriteCost > 0 && (
                <div style={{ color: theme.text.muted, paddingLeft: 12, fontSize: theme.fontSize.xs }} title="Anthropic charges cache writes at 1.25x the input rate. Already counted in `input` above.">
                  ├ reused {fmt$(cachedCost)} · one-off {fmt$(freshCost)} · cached for next {fmt$(cwriteCost)} <span style={{ color: theme.cost.cwrite }}>(1.25x)</span>
                </div>
              )}
              <div><span style={{ color: theme.text.muted }}>output</span> {fmt$(outputCost).padStart(7)} · {pctOutputOfTotal}%</div>
              {ev.recommit > 100 && (
                <div style={{ color: theme.cost.cwrite, marginTop: 3 }} title="Tokens the API treated as new because the cache for them had expired. Included in the input number above.">
                  incl. {fmtT(ev.recommit)} tok cache recommit
                </div>
              )}
            </div>
          )}
        </div>
          </>
          );
        })()}
      </div>
      {missCallout}
      {recommitCallout}
      {ev.images && ev.images.length > 0 && (() => {
        var vis = ev.visionTokensTotal || 0;
        var pt = ev.promptTokens || 0;
        var ocrChars = (ev.components && ev.components.tool_results) || 0;
        var nonVis = Math.max(0, pt - vis);
        var pct = function (n) { return pt > 0 ? (100 * n / Math.max(pt, vis + nonVis)).toFixed(1) + "%" : "—"; };
        var price = ev.model ? getModelPrice(ev.model) : null;
        var visDollars = imageDollarCost(price, vis);
        return (
        <div style={{
          background: theme.bg.surface, border: "1px solid " + theme.border.default,
          borderRadius: 5, padding: "9px 12px", marginBottom: 12,
          fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.5,
        }}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, fontWeight: 600 }}>
            Prompt content breakdown ({fmtT(pt)} billed input tok)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: "4px 12px", alignItems: "baseline", fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
            <span style={{ display: "inline-block", width: 10, height: 10, background: theme.cost.ctxImages, borderRadius: 2 }} />
            <span style={{ color: theme.text.primary }} title="Estimated from each attachment's `detail` field + model's documented vision rule. The export does not report exact image tokens; these are an approximation.">
              Vision ({ev.images.length} image{ev.images.length === 1 ? "" : "s"})
            </span>
            <span style={{ color: theme.text.muted, textAlign: "right" }}>~{fmtT(vis)} tok</span>
            <span style={{ color: theme.text.muted, textAlign: "right" }}>{pct(vis)}{visDollars > 0 ? " · ~" + fmt$(visDollars) : ""}</span>

            <span style={{ display: "inline-block", width: 10, height: 10, background: theme.cost.ctxToolResults, borderRadius: 2 }} />
            <span style={{ color: theme.text.primary }} title="Text returned by client-side tools (e.g. pdftotext output, file reads, terminal output). Already part of the billed prompt; shown here as the dominant non-vision input.">
              Tool result text ({ev.toolResultMsgs.length} msg{ev.toolResultMsgs.length === 1 ? "" : "s"})
            </span>
            <span style={{ color: theme.text.muted, textAlign: "right" }}>~{fmtT(Math.round(ocrChars / 4))} tok</span>
            <span style={{ color: theme.text.muted, textAlign: "right" }}>char-est</span>

            <span style={{ display: "inline-block", width: 10, height: 10, background: theme.cost.ctxHistory, borderRadius: 2 }} />
            <span style={{ color: theme.text.primary }}>
              System + history + tool defs + current
            </span>
            <span style={{ color: theme.text.muted, textAlign: "right" }}>~{fmtT(Math.max(0, nonVis - Math.round(ocrChars / 4)))} tok</span>
            <span style={{ color: theme.text.muted, textAlign: "right" }}>remainder</span>
          </div>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, fontStyle: "italic", marginTop: 6 }}>
            Vision tokens are already counted in the {fmtT(pt)} billed prompt total above — they don't add on top.
            On cache-hit calls most of this is served at the cached rate ({fmtT(ev.cached || 0)} cached, {fmtT(ev.cacheWrite || 0)} cache-write).
          </div>
        </div>
        );
      })()}
      {ev.newImages && ev.newImages.length > 0 && (() => {
        var price = ev.model ? getModelPrice(ev.model) : null;
        var imgRows = ev.newImages.map(function (img) {
          var tok = estimateImageTokens(ev.model, img.detail);
          var dollars = imageDollarCost(price, tok);
          return { img: img, tok: tok, dollars: dollars };
        });
        var totalTok = imgRows.reduce(function (s, r) { return s + r.tok; }, 0);
        var totalDollars = imgRows.reduce(function (s, r) { return s + r.dollars; }, 0);
        var anyKnown = imgRows.some(function (r) { return r.tok > 0; });
        return (
        <div style={{
          background: theme.bg.surface, border: "1px solid " + theme.border.default,
          borderRadius: 5, padding: "9px 12px", marginBottom: 12,
          fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.5,
        }}>
          <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5, fontWeight: 600 }}>
            📎 New image attachment{ev.newImages.length === 1 ? "" : "s"} ({ev.newImages.length})
            {ev.images.length > ev.newImages.length && (
              <span style={{ color: theme.text.muted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 8 }}>
                · {ev.images.length - ev.newImages.length} more carried from cache
              </span>
            )}
          </div>
          {imgRows.map(function (r, i) {
            var ext = (r.img.mediaType || "").split("/").pop() || "img";
            return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", gap: 10, alignItems: "center", padding: "3px 0", fontSize: theme.fontSize.xs, borderTop: i === 0 ? "none" : "1px solid " + theme.border.subtle }}>
                <ImageThumb url={r.img.url} alt={"image " + (i + 1)} />
                <span style={{ color: theme.text.primary, fontFamily: theme.font.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ext.toUpperCase()}
                  {r.img.detail ? <span style={{ color: theme.text.muted }}> · {r.img.detail}</span> : null}
                </span>
                <span style={{ color: theme.text.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }} title="Estimated from model + detail field. The export does not report image token usage.">
                  {r.tok > 0 ? "~" + fmtT(r.tok) + " tok" + (r.dollars > 0 ? " · " + fmt$(r.dollars) : "") : "—"}
                </span>
              </div>
            );
          })}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6, fontSize: theme.fontSize.xs, color: theme.text.muted, fontVariantNumeric: "tabular-nums" }}
               title={anyKnown ? "Estimated from model + detail field. The export does not report exact image tokens." : "No documented image cost rule for this model."}>
            <span style={{ fontStyle: "italic" }}>{anyKnown ? "est." : "token cost unknown"}</span>
            {anyKnown && (
              <span><b style={{ color: theme.text.secondary }}>~{fmtT(totalTok)} tok</b>{totalDollars > 0 ? " · " + fmt$(totalDollars) : ""}</span>
            )}
          </div>
        </div>
        );
      })()}
      <NewBlock newPerBucket={ev.newPerBucket} newTotal={ev.newTotal} totalIn={ev.promptTokens} label="this call" />
      {(function () {
        var npb = ev.newPerBucket || {};
        var comps = ev.components || {};
        var newSum = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (npb[k] || 0); }, 0) || 1;
        var newPct = function (k) { return 100 * (npb[k] || 0) / newSum; };
        // Show any bucket that has either new tokens this call OR cached
        // content carried over from earlier calls. This way subagent tool
        // results stay drillable on subsequent steps even though they're
        // 100% cache hits.
        var visible = CTX_INPUT_KEYS.filter(function (k) {
          return (npb[k] || 0) > 0 || (comps[k] || 0) > 0;
        });
        if (visible.length === 0) {
          return (
            <div style={{ fontSize: theme.fontSize.sm, color: theme.text.muted, fontStyle: "italic", padding: "8px 0" }}>
              Nothing new in this call -- 100% of the input was served from cache.
            </div>
          );
        }
        var newBucketCount = visible.filter(function (k) { return (npb[k] || 0) > 0; }).length;
        var bodyForBucket = function (k) {
          if (k === "system") return renderSystemAnatomy(ev);
          if (k === "tool_defs") {
            var shape = ev.toolDefinitionShape;
            var routerNames = shape && shape.available
              ? new Set((shape.routerOrGroupedTools || []).map(function (t) { return t.name; }))
              : null;
            var summary = ev.totalTools + " model-visible tool definitions sent to the model";
            if (shape && shape.available && (shape.routerOrGroupedToolCount > 0 || shape.possibleRouterToolCount > 0)) {
              summary += " (" + shape.directToolCount + " direct, " + shape.routerOrGroupedToolCount + " router/grouped";
              if (shape.possibleRouterToolCount > 0) summary += ", " + shape.possibleRouterToolCount + " possible router";
              summary += "). IDE-selected tool count is not in the export -- routers stand in for many hidden subcommands.";
            } else {
              summary += ". IDE-selected tool count is not in the export.";
            }
            return (
              <>
                <div
                  title="Model-visible tool definitions are the tool schemas actually sent to the model in this request. The IDE may show more selected/enabled tools than were sent. Router/grouped tools can stand in for many hidden or deferred subcommands behind one schema."
                  style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, marginBottom: 5, cursor: "help" }}
                >
                  {summary}
                </div>
                <ToolGroups groups={ev.toolGroups} routerNames={routerNames} />
              </>
            );
          }
          if (k === "history") return (
            <>
              <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginBottom: 4 }}>
                {ev.newHistoryMsgs.length} new of {ev.historyMsgs.length} total (older cached entries collapsed; hover any row for full text)
              </div>
              <HistoryList msgs={ev.historyMsgs} newCount={ev.newHistoryMsgs.length} />
            </>
          );
          if (k === "tool_results") return (
            <>
              <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginBottom: 4 }}>
                {ev.newToolResultMsgs.length} new of {ev.toolResultMsgs.length} total (older cached entries collapsed; hover any row for full text)
              </div>
              <ToolResultList msgs={ev.toolResultMsgs} newCount={ev.newToolResultMsgs.length} />
            </>
          );
          if (k === "current") {
            var parts = ev.currentParts || [];
            var totalCurChars = parts.reduce(function (a, p) { return a + p.chars; }, 0);
            var curTok = (ev.components && ev.components.current) || 0;
            var partToTok = function (chars) {
              return totalCurChars > 0 && curTok > 0
                ? Math.round(chars / totalCurChars * curTok)
                : Math.round(chars / 4);
            };
            return (
              <>
                {parts.length > 0 ? (
                  <div style={{ fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }}>
                    {parts.map(function (p, i) {
                      var label = p.isTagged ? "<" + p.tag + ">" : p.tag;
                      var tip = (p.isTagged ? "<" + p.tag + ">" : "(plaintext)")
                        + "  ·  " + p.chars.toLocaleString() + " chars"
                        + (p.body ? "\n\n" + p.body : "");
                      return (
                        <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", cursor: p.body ? "help" : "default" }} title={tip}>
                          <span style={{ color: p.isTagged ? theme.text.primary : theme.text.muted, fontStyle: p.isTagged ? "normal" : "italic" }}>{label}</span>
                          <span style={{ color: theme.text.muted, marginLeft: "auto" }}>~{fmtT(partToTok(p.chars))} tok</span>
                        </div>
                      );
                    })}
                    <div style={{ marginTop: 6, color: theme.text.muted, fontStyle: "italic", fontFamily: theme.font.sans }}>Hover any tag to preview its body.</div>
                  </div>
                ) : (
                  <div style={textBlockStyle()}>{ev.currentText || "(empty)"}{ev.currentText && ev.currentText.length >= 400 ? "…" : ""}</div>
                )}
                {ev.imageTokensEst > 0 && (
                  <div style={{ marginTop: 6, fontSize: theme.fontSize.xs, color: theme.text.muted, fontStyle: "italic" }}>
                    Includes ~{fmtT(ev.imageTokensEst)} estimated image tokens (see 📎 attachment block above for per-image breakdown).
                  </div>
                )}
              </>
            );
          }
          return null;
        };
        return (
          <>
            <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 8px", fontWeight: 600 }}>
              Context buildup ({fmtT(ev.newTotal)} new tok across {newBucketCount} bucket{newBucketCount === 1 ? "" : "s"}, {visible.length - newBucketCount} more cached)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {visible.map(function (k) {
                var isNew = (npb[k] || 0) > 0;
                return isNew ? (
                  <DetailSection key={k} bucket={k} value={npb[k]} pct={newPct(k)} pctLabel="of new" valuePrefix="+">
                    {bodyForBucket(k)}
                  </DetailSection>
                ) : (
                  <DetailSection key={k} bucket={k} value={comps[k]} pct={0} pctLabel="cached" valuePrefix="">
                    {bodyForBucket(k)}
                  </DetailSection>
                );
              })}
            </div>
          </>
        );
      })()}
      {(function () {
        var hasText = ev.responsePreview && ev.responsePreview.trim().length > 0;
        var calls = ev.producedToolCalls || [];
        var reasoning = ev.reasoningBlocks || [];
        var silent = ev.silentToolCall;
        if (!hasText && calls.length === 0 && reasoning.length === 0 && !silent) return null;
        return (
          <div style={{
            marginTop: 14,
            background: theme.bg.surface,
            border: "1px solid " + theme.border.default,
            borderRadius: 4,
            padding: "10px 12px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, fontSize: theme.fontSize.sm, gap: 12, flexWrap: "wrap" }}>
              <span style={{ color: theme.text.primary, fontWeight: 600 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 1, marginRight: 6, background: theme.cost.output }} />
                Response
              </span>
              <span style={{ color: theme.text.secondary, fontVariantNumeric: "tabular-nums", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <span style={{ color: theme.text.primary, fontWeight: 600 }}>{fmtT(ev.output)} output tok</span>
                {(function () {
                  var visCh = ev.visibleResponseChars || 0;
                  var thinkCh = ev.thinkingChars || 0;
                  var argsCh = ev.toolArgsChars || 0;
                  var sumCh = visCh + thinkCh + argsCh;
                  var parts = [];
                  if (sumCh > 0 && ev.output > 0) {
                    var estVis = Math.round(visCh / 4);
                    var estThink = Math.round(thinkCh / 4);
                    var estArgs = Math.round(argsCh / 4);
                    if (estVis > 0) parts.push({ label: "visible", tok: estVis, color: theme.cost.fresh });
                    if (estThink > 0) parts.push({ label: "thinking", tok: estThink, color: theme.cost.output });
                    if (estArgs > 0) parts.push({ label: "tool args", tok: estArgs, color: theme.cost.ctxToolDefs });
                  } else if (ev.reasoningTokens > 0) {
                    var visTok2 = ev.output - ev.reasoningTokens;
                    if (visTok2 > 0) parts.push({ label: "visible", tok: visTok2, color: theme.cost.fresh });
                    parts.push({ label: "thinking", tok: ev.reasoningTokens, color: theme.cost.output });
                  }
                  if (parts.length === 0) return null;
                  return parts.map(function (p, i) {
                    return (
                      <span key={i} style={{ display: "inline-flex", alignItems: "baseline", gap: 4, color: theme.text.secondary }} title={p.label + " (estimated from char share)"}>
                        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 1, background: p.color, transform: "translateY(-1px)" }} />
                        ~{fmtT(p.tok)} {p.label}
                      </span>
                    );
                  });
                })()}
              </span>
            </div>
            {hasText && (() => {
              var full = ev.responsePreview;
              var firstLine = full.split("\n").find(function (l) { return l.trim().length > 0; }) || "";
              var hasMore = full.trim() !== firstLine.trim();
              var label = (
                <span style={{ fontFamily: theme.font.mono, fontSize: theme.fontSize.xs, color: theme.text.muted, whiteSpace: "nowrap", display: "inline-flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 1, background: theme.cost.fresh, transform: "translateY(-1px)" }} />
                  <span style={{ color: theme.text.primary, fontWeight: 600 }}>visible</span>
                </span>
              );
              if (!hasMore) {
                return (
                  <div style={{ padding: "4px 0", display: "grid", gridTemplateColumns: "14px auto 1fr", gap: 6, alignItems: "baseline" }}>
                    <span />
                    {label}
                    <span style={{
                      fontFamily: theme.font.mono, fontSize: theme.fontSize.sm,
                      color: theme.text.primary, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}>{firstLine}</span>
                  </div>
                );
              }
              return (
                <CollapsibleRow first accent={theme.cost.fresh}
                                label={label} preview={firstLine} previewTitle={full}>
                  <div style={{
                    fontFamily: theme.font.mono, fontSize: theme.fontSize.sm,
                    color: theme.text.primary, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    lineHeight: 1.55,
                  }}>{full}</div>
                </CollapsibleRow>
              );
            })()}
            {!hasText && calls.length === 0 && silent && (
              <div style={{
                background: theme.bg.base, border: "1px dashed " + theme.border.default,
                borderRadius: 3, padding: "8px 10px",
              }}>
                <div style={{ color: theme.text.secondary, fontStyle: "italic", fontSize: theme.fontSize.sm, marginBottom: 6 }}>
                  No text content. The model spent its {fmtT(silent.outputTokens)} output tokens emitting a tool call that the export does not capture inline.
                </div>
                <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, marginBottom: 4 }}>
                  Likely tool{silent.likelyTools.length === 1 ? "" : "s"} (from the {silent.likelyTools.length === 1 ? "single tool" : "tools"} exposed on this call):
                </div>
                {silent.likelyTools.map(function (n, i) {
                  return (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", fontFamily: theme.font.mono, fontSize: theme.fontSize.xs, lineHeight: 1.7 }}>
                      <span style={{ color: theme.text.muted }}>→</span>
                      <span style={{ color: theme.text.primary, fontWeight: 600 }}>{n}</span>
                      {silent.likelyTools.length === 1 && (
                        <span style={{ color: theme.text.muted }}>(only tool offered, so this is what got called)</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {!hasText && calls.length > 0 && (
              <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, fontStyle: "italic", marginBottom: 6 }}>
                No text reply this turn. The model used its {fmtT(ev.output)} output tokens to request {calls.length} tool execution{calls.length === 1 ? "" : "s"} from the client.
              </div>
            )}
            {(ev.reasoningBlocks || []).length > 0 && (() => {
              var grouped = groupReasoningBlocks(ev.reasoningBlocks);
              return (
                <div style={{
                  marginTop: hasText ? 10 : 0,
                  paddingTop: hasText ? 10 : 0,
                  borderTop: hasText ? "1px solid " + theme.border.subtle : "none",
                }}>
                  <div
                    title={
                      "Extended thinking emitted by the model as part of this response, before each tool_use. " +
                      "Billed as output tokens on this call. For Claude, thinking is discarded after the turn and is not re-sent as input on the next call."
                    }
                    style={{
                      fontSize: theme.fontSize.xs, color: theme.text.muted,
                      textTransform: "uppercase", letterSpacing: 0.5,
                      marginBottom: 6, fontWeight: 600,
                      display: "flex", alignItems: "center", gap: 6,
                      cursor: "help",
                    }}
                  >
                    <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 1, background: theme.text.muted }} />
                    <span style={{ borderBottom: "1px dotted " + theme.border.default }}>
                      Reasoning ({ev.reasoningBlocks.length} block{ev.reasoningBlocks.length === 1 ? "" : "s"}{grouped.length !== ev.reasoningBlocks.length ? ", " + grouped.length + " unique" : ""})
                    </span>
                    <span style={{ color: theme.text.ghost, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                      LLM&apos;s pre-tool thoughts, billed in the {fmtT(ev.output)} output tok above
                    </span>
                  </div>
                  {grouped.map(function (g, i) {
                    var firstLine = (g.text || "").split("\n").find(function (l) { return l.trim().length > 0; }) || "";
                    var label = (
                      <span style={{ fontFamily: theme.font.mono, fontSize: theme.fontSize.xs, color: theme.text.muted, whiteSpace: "nowrap" }}>
                        {g.tool ? <>before <span style={{ color: theme.text.primary, fontWeight: 600 }}>{g.tool}</span></> : "thinking"}
                        {g.count > 1 && <span style={{ color: theme.cost.cwrite, marginLeft: 4 }}>×{g.count} identical</span>}
                      </span>
                    );
                    return (
                      <CollapsibleRow key={i} first={i === 0} accent={theme.text.muted}
                                      label={label}
                                      preview={firstLine}
                                      previewTitle={g.text}>
                        <div style={{
                          fontFamily: theme.font.mono, fontSize: theme.fontSize.sm,
                          color: theme.text.secondary, fontStyle: "italic",
                          whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5,
                        }}>{g.text}</div>
                      </CollapsibleRow>
                    );
                  })}
                </div>
              );
            })()}
            {calls.length > 0 && (
              <div style={{
                marginTop: (hasText || reasoning.length > 0) ? 10 : 0,
                paddingTop: (hasText || reasoning.length > 0) ? 10 : 0,
                borderTop: (hasText || reasoning.length > 0) ? "1px solid " + theme.border.subtle : "none",
              }}>
                <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 1, background: theme.cost.kindBuiltin }} />
                  <span>Tool calls requested by the model</span>
                  <span style={{ color: theme.text.ghost, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                    LLM → client. Results are fed back on the next call.
                  </span>
                </div>
                {calls.map(function (tc, i) {
                  var smart = summarizeToolArgs(tc) || tc.argsSummary || "";
                  var pretty = prettyToolArgs(tc);
                  var label = (
                    <span style={{
                      fontFamily: theme.font.mono, fontSize: theme.fontSize.xs, fontWeight: 600,
                      color: theme.cost.kindBuiltin,
                      background: theme.bg.base, padding: "1px 6px", borderRadius: 3,
                      border: "1px solid " + theme.border.subtle, whiteSpace: "nowrap",
                    }}>{tc.name || "(unnamed tool)"}</span>
                  );
                  return (
                    <CollapsibleRow key={i} first={i === 0} accent={theme.cost.kindBuiltin}
                                    label={label} preview={smart}
                                    previewTitle={tc.rawArgs || smart}>
                      <pre style={{
                        margin: 0, fontFamily: theme.font.mono, fontSize: theme.fontSize.xs,
                        color: theme.text.primary, whiteSpace: "pre-wrap", wordBreak: "break-word",
                        lineHeight: 1.5,
                      }}>{pretty || "(no args)"}</pre>
                    </CollapsibleRow>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function textBlockStyle() {
  return {
    background: theme.bg.base,
    border: "1px dashed " + theme.border.default,
    borderRadius: 3,
    padding: "8px 10px",
    marginTop: 6,
    color: theme.text.primary,
    fontSize: theme.fontSize.sm,
    lineHeight: 1.55,
    maxHeight: 120,
    overflow: "auto",
    whiteSpace: "pre-wrap",
  };
}

function detectResponseShape(preview) {
  if (!preview) return "empty";
  var s = preview.trimStart();
  if (s.startsWith("{")) return "JSON object";
  if (s.startsWith("[")) return "JSON array";
  if (s.indexOf("```") >= 0) return "Markdown";
  return "Text";
}

function ToolDetail(props) {
  var ev = props.event;
  var workspaceRoot = props.workspaceRoot || "";
  var sectionLabelStyle = {
    fontSize: theme.fontSize.xs,
    color: theme.text.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: 600,
    marginBottom: 5,
    display: "flex",
    alignItems: "center",
    gap: 6,
  };
  var arrowChip = function (color, label) {
    return (
      <span style={{
        background: theme.bg.raised,
        color: color,
        padding: "1px 6px",
        borderRadius: 3,
        fontSize: theme.fontSize.xs,
        fontWeight: 700,
        letterSpacing: 0.4,
      }}>{label}</span>
    );
  };
  var blockStyle = function (accentColor) {
    return Object.assign({}, textBlockStyle(), {
      borderLeft: "3px solid " + accentColor,
      borderTop: "1px solid " + theme.border.subtle,
      borderRight: "1px solid " + theme.border.subtle,
      borderBottom: "1px solid " + theme.border.subtle,
      borderStyle: "solid",
      maxHeight: 200,
    });
  };
  var shape = detectResponseShape(ev.resultPreview);
  var headerSummary = smartToolHeadline(ev, workspaceRoot) || summarizeToolArgs(ev);
  return (
    <div style={{ gridColumn: "1 / -1", background: theme.bg.base, borderBottom: "1px solid " + theme.border.subtle, padding: "14px 22px" }}>
      <h4 style={{ margin: "0 0 10px", color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 600, letterSpacing: 0.4 }}>
        <span style={{ textTransform: "uppercase", letterSpacing: 0.4 }}>Tool call · {ev.name}</span>
        {headerSummary && (
          <span
            title={ev.rawArgs && ev.rawArgs.length > 0 ? ev.rawArgs : headerSummary}
            style={{
              marginLeft: 10,
              fontFamily: theme.font.mono,
              fontSize: theme.fontSize.sm,
              fontWeight: 400,
              color: theme.text.secondary,
              letterSpacing: 0,
              textTransform: "none",
              borderLeft: "2px solid " + theme.border.default,
              paddingLeft: 10,
            }}
          >{headerSummary.length > 110 ? headerSummary.slice(0, 110) + "\u2026" : headerSummary}</span>
        )}
      </h4>

      {/* Reasoning that the model emitted before this tool call is shown on
          the preceding LLM call's Response section, since it's part of that
          response and is billed there. We keep a small breadcrumb here so
          the user knows where to find it. */}
      {ev.thinking && (
        <div style={{
          marginBottom: 12,
          padding: "6px 10px",
          background: theme.bg.base,
          border: "1px dashed " + theme.border.default,
          borderRadius: 3,
          fontSize: theme.fontSize.xs,
          color: theme.text.muted,
          fontStyle: "italic",
        }}>
          The model emitted {ev.thinking.length.toLocaleString()} chars of reasoning before requesting this tool. It is shown under the preceding LLM call&apos;s Response section (billed there as output tokens).
        </div>
      )}

      {/* 2. Input */}
      <div style={{ marginBottom: 12 }}>
        <div style={sectionLabelStyle}>
          {arrowChip(theme.cost.fresh, "1 · input →")}
          <span>Arguments sent to <code style={{ color: theme.text.primary }}>{ev.name}</code></span>
        </div>
        {ev.rawArgs || ev.argsSummary
          ? <ToolArgsPreview ev={ev} blockStyle={blockStyle(theme.cost.fresh)} workspaceRoot={workspaceRoot} />
          : <div style={{ color: theme.text.ghost, fontStyle: "italic", fontSize: theme.fontSize.sm }}>(no arguments)</div>}
      </div>

      {/* 3. Output */}
      <div>
        <div style={sectionLabelStyle}>
          {arrowChip(theme.cost.ctxHistory, "2 · ← output")}
          <span>Result returned by <code style={{ color: theme.text.primary }}>{ev.name}</code></span>
          <span style={{
            marginLeft: "auto",
            background: theme.bg.raised,
            color: theme.text.secondary,
            padding: "1px 6px",
            borderRadius: 3,
            fontSize: theme.fontSize.xs,
            fontWeight: 600,
            border: "1px solid " + theme.border.subtle,
          }}>
            {shape} · {fmtT(ev.resultTokens || 0)} tok · {(ev.resultChars || 0).toLocaleString()} chars
          </span>
        </div>
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginBottom: 4 }}>
          → Will be folded into the <b style={{ color: theme.cost.ctxHistory }}>tool_results</b> bucket of the next LLM call's context.
        </div>
        <ToolResultPreview
          preview={ev.resultPreview}
          full={ev.resultFull}
          truncated={ev.resultTruncated}
          totalChars={ev.resultChars}
          accent={theme.cost.ctxHistory}
          blockStyle={blockStyle(theme.cost.ctxHistory)}
        />
      </div>
    </div>
  );
}

function computePromptCostByBucket(p) {
  // returns: { [bucket]: { cost, cachedTok, newTok, savings, sample, calls? } }
  // sample = string summary for the inline label
  // calls = array of per-call breakdown for the tooltip
  var byBucket = {};
  CTX_KEYS.forEach(function (k) {
    byBucket[k] = {
      cost: 0,
      cachedTok: 0, newTok: 0, freshTok: 0, cwTok: 0, outputTok: 0,
      freshCost: 0, cwCost: 0, cachedCost: 0, outputCost: 0,
      savings: 0, sample: "", tooltip: "",
    };
  });
  if (!p || !p.events) return byBucket;
  var llmEvents = p.events.filter(function (e) { return e.kind === "llm"; });
  if (!llmEvents.length) return byBucket;
  var lastLLM = llmEvents[llmEvents.length - 1];
  var totalOutputTok = 0;

  llmEvents.forEach(function (ev) {
    if (!ev.model || !hasModelPricing(ev.model)) return;
    var price = getModelPrice(ev.model);
    if (!price) return;
    var cacheReadRatio = price.cacheReadRatio != null ? price.cacheReadRatio : 0.1;
    var comp = ev.components || {};
    var npb = ev.newPerBucket || {};
    var newTotal = (ev.fresh || 0) + (ev.cacheWrite || 0);
    var freshShare = newTotal > 0 ? (ev.fresh || 0) / newTotal : 1;
    // Provisional per-bucket cost via char-share allocation. We'll rescale
    // these to match the call's real billed cost so the sum reconciles with
    // the headline total.
    var perBucket = {};
    var inputCostSum = 0;
    CTX_INPUT_KEYS.forEach(function (k) {
      var totalIn = k === "images" ? (ev.visionTokensTotal || 0) : (comp[k] || 0);
      var newB    = k === "images" ? (ev.imageTokensEst   || 0) : (npb[k]  || 0);
      var cachedB = Math.max(0, totalIn - newB);
      var freshB = newB * freshShare;
      var cwB = newB * (1 - freshShare);
      var freshCost = estimateCost({ inputTokens: freshB }, ev.model);
      var cwCost = estimateCost({ cacheWrite: cwB }, ev.model);
      var cachedCost = estimateCost({ cacheRead: cachedB }, ev.model);
      perBucket[k] = {
        totalIn: totalIn, newB: newB, cachedB: cachedB,
        freshB: freshB, cwB: cwB,
        freshCost: freshCost, cwCost: cwCost, cachedCost: cachedCost,
      };
      inputCostSum += freshCost + cwCost + cachedCost;
    });
    // Reconcile bucket cost sum with the real input cost from the API.
    // Vision tokens are typically already inside prompt_tokens, so an
    // un-scaled sum would double-count them. Scaling preserves relative
    // shares while making the sum match what was actually billed.
    var outCost = estimateCost({ outputTokens: ev.output || 0 }, ev.model);
    var realInputCost = Math.max(0, (ev.cost || 0) - outCost);
    var scale = inputCostSum > 0 ? realInputCost / inputCostSum : 0;
    CTX_INPUT_KEYS.forEach(function (k) {
      var pb = perBucket[k];
      var freshCost = pb.freshCost * scale;
      var cwCost = pb.cwCost * scale;
      var cachedCost = pb.cachedCost * scale;
      byBucket[k].cost += freshCost + cwCost + cachedCost;
      byBucket[k].freshCost += freshCost;
      byBucket[k].cwCost += cwCost;
      byBucket[k].cachedCost += cachedCost;
      byBucket[k].cachedTok += pb.cachedB;
      byBucket[k].newTok    += pb.newB;
      byBucket[k].freshTok  += pb.freshB;
      byBucket[k].cwTok     += pb.cwB;
      // Savings = what cached_tokens would have cost at full input rate,
      // minus what they actually cost at the cache-read rate.
      byBucket[k].savings += pb.cachedB * price.input * (1 - cacheReadRatio) / 1e6;
    });
    byBucket.output.cost += outCost;
    byBucket.output.outputCost += outCost;
    byBucket.output.outputTok += ev.output || 0;
    byBucket.output.newTok += ev.output || 0;
    byBucket.output.reasoningTok = (byBucket.output.reasoningTok || 0) + (ev.reasoningTokens || 0);
    byBucket.output.visibleChars = (byBucket.output.visibleChars || 0) + (ev.visibleResponseChars || 0);
    byBucket.output.thinkingChars = (byBucket.output.thinkingChars || 0) + (ev.thinkingChars || 0);
    byBucket.output.toolArgsChars = (byBucket.output.toolArgsChars || 0) + (ev.toolArgsChars || 0);
    byBucket.output.codeChars = (byBucket.output.codeChars || 0) + (ev.codeChars || 0);
    if (!byBucket.output.codeByLang) byBucket.output.codeByLang = new Map();
    (ev.codeCharsByLang || []).forEach(function (L) {
      byBucket.output.codeByLang.set(L.lang, (byBucket.output.codeByLang.get(L.lang) || 0) + L.chars);
    });
    if (!byBucket.output.argsByName) byBucket.output.argsByName = new Map();
    (ev.toolArgCharsByName || []).forEach(function (A) {
      byBucket.output.argsByName.set(A.name, (byBucket.output.argsByName.get(A.name) || 0) + A.chars);
    });
    totalOutputTok += ev.output || 0;
  });

  // System: stable across calls; report the prompt size from chars (the only
  // honest, call-independent measurement we have).
  var sysChars = (lastLLM.systemChars || 0);
  var sysTokEst = sysChars > 0 ? Math.round(sysChars / 4) : 0;
  var nCalls = llmEvents.length;
  byBucket.system.sample = sysChars > 0
    ? ("1 system prompt · " + fmtT(sysChars) + " chars · ~" + fmtT(sysTokEst) + " tok"
        + (nCalls > 1 ? " (identical across " + nCalls + " calls)" : ""))
    : "";
  byBucket.system.tooltip = lastLLM.systemPreview ? "First 400 chars:\n" + lastLLM.systemPreview : "";

  // Tool defs: aggregate from last call (tools are stable per session).
  var groups = lastLLM.toolGroups || [];
  var totalTools = groups.reduce(function (a, g) { return a + (g.tools ? g.tools.length : 0); }, 0);
  byBucket.tool_defs.sample = totalTools > 0
    ? totalTools + " tools (" + groups.map(function (g) { return (g.tools ? g.tools.length : 0) + " " + g.source; }).join(", ") + ")"
    : "";
  if (groups.length) {
    var topTools = [].concat.apply([], groups.map(function (g) { return g.tools || []; }))
      .sort(function (a, b) { return (b.tokens || 0) - (a.tokens || 0); }).slice(0, 8);
    byBucket.tool_defs.tooltip = "Top tools by size:\n" + topTools.map(function (t) {
      return "  " + t.name + " · " + fmtT(t.tokens || 0) + " tok";
    }).join("\n");
  }

  // History: count user vs assistant from last call (history grows monotonically).
  var hms = lastLLM.historyMsgs || [];
  var nUser = hms.filter(function (m) { return m.role === "user"; }).length;
  var nAsst = hms.filter(function (m) { return m.role === "assistant"; }).length;
  byBucket.history.sample = hms.length > 0
    ? hms.length + " message" + (hms.length === 1 ? "" : "s") + " (" + nUser + " user, " + nAsst + " assistant)"
    : "";

  // Tool results: group by tool name (first word before ":" in label).
  var trms = lastLLM.toolResultMsgs || [];
  if (trms.length) {
    var byTool = {};
    trms.forEach(function (m) {
      var label = m.label || "result";
      var idx = label.indexOf(":");
      var name = idx > 0 ? label.slice(0, idx) : label;
      byTool[name] = (byTool[name] || 0) + 1;
    });
    var pairs = Object.keys(byTool).map(function (n) { return { n: n, c: byTool[n] }; })
      .sort(function (a, b) { return b.c - a.c; });
    byBucket.tool_results.sample = trms.length + " result" + (trms.length === 1 ? "" : "s")
      + " (" + pairs.slice(0, 3).map(function (p) { return p.c + "× " + p.n; }).join(", ")
      + (pairs.length > 3 ? ", …" : "") + ")";
    byBucket.tool_results.tooltip = "By tool:\n" + pairs.map(function (p) { return "  " + p.c + "× " + p.n; }).join("\n");
  }

  // Current prompt: just chars/tokens of the user's actual ask.
  var curTok = (lastLLM.components || {}).current || 0;
  byBucket.current.sample = curTok > 0 ? "user's request (" + fmtT(curTok) + " tok)" : "";
  byBucket.current.tooltip = lastLLM.currentText ? "Text:\n" + lastLLM.currentText.slice(0, 400) : "";

  // Images: aggregate vision token cost across all LLM calls in this prompt.
  var totalImgs = 0, totalImgTok = 0;
  llmEvents.forEach(function (e) {
    totalImgs += (e.images && e.images.length) || 0;
    totalImgTok += e.visionTokensTotal || 0;
  });
  byBucket.images.sample = totalImgTok > 0
    ? totalImgs + " image attachment" + (totalImgs === 1 ? "" : "s") + " (~" + fmtT(totalImgTok) + " tok est)"
    : "";
  byBucket.images.tooltip = totalImgTok > 0
    ? "Estimated vision input tokens from model + detail field.\nAlready included in billed prompt_tokens; shown here so reused images on cached calls are visible."
    : "";

  // Output: model's response totals. The detailed bucket breakdown below
  // covers the attribution; the inline sample line would just repeat it.
  // Keep a minimal call-count sample as a fallback for when chars data is
  // missing entirely.
  var totalReasoning = byBucket.output.reasoningTok || 0;
  var visCh = byBucket.output.visibleChars || 0;
  var thinkCh = byBucket.output.thinkingChars || 0;
  var argsCh = byBucket.output.toolArgsChars || 0;
  var anyChars = visCh + thinkCh + argsCh;
  if (totalOutputTok > 0 && anyChars > 0) {
    // Build a one-line summary of the 3 output categories so the collapsed
    // bucket row shows the cost attribution without expanding.
    var perTokSum = byBucket.output.outputCost / totalOutputTok;
    var thinkTokS = totalReasoning > 0
      ? totalReasoning
      : Math.round(totalOutputTok * (thinkCh / anyChars));
    var remainS = Math.max(0, totalOutputTok - thinkTokS);
    var visArgChS = visCh + argsCh;
    var argTokS = visArgChS > 0 ? Math.round(remainS * (argsCh / visArgChS)) : 0;
    var visTokS = Math.max(0, remainS - argTokS);
    var partsS = [];
    if (visTokS > 0) partsS.push("visible " + fmt$(visTokS * perTokSum));
    if (thinkTokS > 0) partsS.push("thinking " + fmt$(thinkTokS * perTokSum));
    if (argTokS > 0) partsS.push("tool-args " + fmt$(argTokS * perTokSum));
    byBucket.output.sample = partsS.join(" · ");
  } else if (totalOutputTok > 0 && anyChars === 0) {
    var nLlm = llmEvents.length;
    var callStr = nLlm + " call" + (nLlm === 1 ? "" : "s");
    if (totalReasoning > 0) {
      byBucket.output.sample = "model wrote " + fmtT(totalOutputTok - totalReasoning)
        + " visible + " + fmtT(totalReasoning) + " thinking tok across " + callStr;
    } else {
      byBucket.output.sample = "model wrote " + fmtT(totalOutputTok) + " tok across " + callStr;
    }
  }

  return byBucket;
}

function PromptCostBreakdown(props) {
  var p = props.prompt;
  var byBucket = useMemo(function () { return computePromptCostByBucket(p); }, [p]);
  var total = CTX_KEYS.reduce(function (a, k) { return a + (byBucket[k].cost || 0); }, 0);
  if (total <= 0) return null;
  var totalSavings = CTX_KEYS.reduce(function (a, k) { return a + (byBucket[k].savings || 0); }, 0);
  return (
    <div style={{
      gridColumn: "1 / -1",
      background: theme.bg.surface,
      borderBottom: "1px solid " + theme.border.subtle,
      padding: "10px 18px 14px",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        fontSize: theme.fontSize.xs, color: theme.text.muted,
        textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
      }}>
        <span>Cost by component</span>
        <span>
          <span style={{ marginRight: 12 }}>cache saved <b style={{ color: theme.cost.cached }}>{fmt$(totalSavings)}</b></span>
          <b style={{ color: theme.text.primary }}>{fmt$(total)}</b>
        </span>
      </div>
      <div style={{ height: 10, background: theme.bg.base, borderRadius: 1, overflow: "hidden", display: "flex", marginBottom: 8 }}>
        {CTX_KEYS.map(function (k) {
          var v = byBucket[k].cost || 0;
          if (v <= 0) return null;
          var w = 100 * v / total;
          return (
            <div key={k}
              title={CTX_LABELS[k] + ": " + fmt$(v) + " (" + w.toFixed(1) + "%)"}
              style={{ height: "100%", background: CTX_COLORS[k], width: w + "%" }} />
          );
        })}
      </div>
      <div style={{ display: "grid", gap: 2, fontSize: theme.fontSize.sm }}>
        {CTX_KEYS.map(function (k) {
          var b = byBucket[k];
          if (!b.cost || b.cost <= 0) return null;
          var pct = 100 * b.cost / total;
          var totalTok = b.cachedTok + b.newTok;
          var cachedPct = totalTok > 0 ? Math.round(100 * b.cachedTok / totalTok) : 0;
          // Cache-effect summary (right-aligned on header line).
          var cacheText = null;
          if (k === "output") {
            cacheText = <span style={{ color: theme.text.muted, fontStyle: "italic" }}>billed at output rate</span>;
          } else if (k === "current") {
            cacheText = <span style={{ color: theme.text.muted, fontStyle: "italic" }}>fresh each call</span>;
          } else if (totalTok > 0) {
            cacheText = (
              <span>
                <b style={{ color: theme.cost.cached }}>{cachedPct}%</b> cached
                {b.savings > 0 ? <span style={{ color: theme.text.muted }}> · saved <b style={{ color: theme.cost.cached }}>{fmt$(b.savings)}</b></span> : null}
              </span>
            );
          }
          // Build receipt segments for the expandable detail.
          var seg = [];
          if (k === "output") {
            if (b.outputTok > 0) {
              var visCh2 = b.visibleChars || 0;
              var thinkCh2 = b.thinkingChars || 0;
              var argsCh2 = b.toolArgsChars || 0;
              var sumCh = visCh2 + thinkCh2 + argsCh2;
              var perTok = b.outputCost / b.outputTok;
              if (sumCh > 0) {
                // Proportional allocation: parts sum exactly to outputTok.
                var thinkTok2 = (b.reasoningTok || 0) > 0
                  ? b.reasoningTok
                  : Math.round(b.outputTok * (thinkCh2 / sumCh));
                var remainTok = Math.max(0, b.outputTok - thinkTok2);
                var visArgCh = visCh2 + argsCh2;
                var argTok2 = visArgCh > 0 ? Math.round(remainTok * (argsCh2 / visArgCh)) : 0;
                var visTok2 = Math.max(0, remainTok - argTok2);
                if (visTok2 > 0) {
                  var codeCh2 = b.codeChars || 0;
                  var codeTok2 = visCh2 > 0 ? Math.round(visTok2 * (codeCh2 / visCh2)) : 0;
                  var proseTok2 = Math.max(0, visTok2 - codeTok2);
                  var visParts = [];
                  if (proseTok2 > 0) visParts.push("prose " + fmtT(proseTok2));
                  if (codeTok2 > 0) visParts.push("fenced code " + fmtT(codeTok2));
                  seg.push({
                    label: "visible to user", tok: visTok2, cost: visTok2 * perTok, color: theme.cost.fresh,
                    detail: visParts.join(" · "),
                  });
                }
                if (thinkTok2 > 0) {
                  seg.push({ label: "thinking", tok: thinkTok2, cost: thinkTok2 * perTok, color: theme.cost.output, detail: "" });
                }
                if (argTok2 > 0) {
                  var argDetail = "";
                  var byName = b.argsByName;
                  if (byName && byName.size > 0 && argsCh2 > 0) {
                    var argArr = Array.from(byName.entries()).sort(function (a, b) { return b[1] - a[1]; });
                    var parts = argArr.map(function (A) {
                      var aTok = Math.round(argTok2 * (A[1] / argsCh2));
                      return aTok > 0 ? (A[0] + " " + fmtT(aTok)) : null;
                    }).filter(Boolean);
                    argDetail = parts.join(" · ");
                  }
                  seg.push({
                    label: "tool-call args", tok: argTok2, cost: argTok2 * perTok, color: theme.cost.ctxToolDefs,
                    detail: argDetail,
                  });
                }
              } else {
                var rTok = b.reasoningTok || 0;
                var visTok = b.outputTok - rTok;
                var rCost = b.outputTok > 0 ? b.outputCost * rTok / b.outputTok : 0;
                var visCost = b.outputCost - rCost;
                if (visTok > 0) seg.push({ label: "visible output", tok: visTok, cost: visCost, color: theme.cost.fresh, detail: "" });
                if (rTok > 0) seg.push({ label: "thinking", tok: rTok, cost: rCost, color: theme.cost.output, detail: "" });
              }
            }
          } else {
            if (b.freshTok > 0) seg.push({ label: "new", tok: b.freshTok, cost: b.freshCost, color: theme.cost.fresh });
            if (b.cwTok > 0) seg.push({ label: "cache-write", tok: b.cwTok, cost: b.cwCost, color: theme.cost.cwrite });
            if (b.cachedTok > 0) seg.push({ label: "cache-read", tok: b.cachedTok, cost: b.cachedCost, color: theme.cost.cached });
          }
          return (
            <details key={k}
              style={{
                padding: "4px 0",
                borderTop: "1px solid " + theme.border.subtle,
              }}>
              <summary style={{
                display: "grid",
                gridTemplateColumns: "16px 130px 90px 56px minmax(140px,1fr) 2fr",
                gap: 10, alignItems: "baseline",
                cursor: "pointer", listStyle: "none",
              }}>
                <span style={{ display: "inline-block", width: 10, height: 10, background: CTX_COLORS[k], borderRadius: 1 }} />
                <span style={{ color: theme.text.primary, fontWeight: 500 }}>{CTX_LABELS[k]}</span>
                <span style={{ color: theme.text.primary, fontVariantNumeric: "tabular-nums" }}>{fmt$(b.cost)}</span>
                <span style={{ color: theme.text.muted, fontVariantNumeric: "tabular-nums" }}>{pct.toFixed(0)}%</span>
                <span style={{ color: theme.text.secondary, fontVariantNumeric: "tabular-nums" }}>{cacheText}</span>
                <span title={b.tooltip || ""}
                  style={{
                    color: theme.text.muted,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    cursor: b.tooltip ? "help" : "pointer",
                  }}>{b.sample}</span>
              </summary>
              {seg.length > 0 ? (
                <div style={{
                  marginLeft: 26, marginTop: 6, paddingBottom: 4,
                  display: "flex", flexDirection: "column", gap: 3,
                  fontSize: theme.fontSize.xs, color: theme.text.muted,
                  fontVariantNumeric: "tabular-nums",
                }}
                  title={"Per-bucket cost is estimated by allocating each call's prompt_tokens to buckets in proportion to their character share."}>
                  {seg.map(function (s, i) {
                    var subPct = total > 0 ? (s.cost / total) * 100 : 0;
                    return (
                      <div key={i} style={{
                        display: "grid",
                        gridTemplateColumns: "140px 90px 56px minmax(0,1fr)",
                        gap: 10, alignItems: "baseline",
                      }}>
                        <span style={{ color: s.color, fontWeight: 500 }}>{s.label}</span>
                        <span style={{ color: theme.text.primary }}>{fmt$(s.cost)}</span>
                        <span style={{ color: theme.text.muted }}>{subPct.toFixed(0)}%</span>
                        <span style={{
                          color: theme.text.muted, opacity: 0.8,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }} title={s.detail || ""}>{s.detail || ""}</span>
                      </div>
                    );
                  })}
                  {b.savings > 0 ? (
                    <div style={{ marginTop: 2 }}>
                      <span style={{ color: theme.cost.cached, fontWeight: 500 }}>saved</span>
                      {" "}
                      <span style={{ color: theme.cost.cached }}>{fmt$(b.savings)}</span>
                      {" vs uncached"}
                    </div>
                  ) : null}
                  <div style={{ fontStyle: "italic", opacity: 0.6, marginTop: 2 }}>(est.)</div>
                </div>
              ) : null}
            </details>
          );
        })}
      </div>
    </div>
  );
}

function PromptNewMini(props) {
  var p = props.prompt;
  var pa = p.prompt; // PromptAnalysis
  var newPerBucket = pa.newPerBucket || {};
  var sum = CTX_INPUT_KEYS.reduce(function (a, k) { return a + (newPerBucket[k] || 0); }, 0) || 1;
  var missCalls = (p.events || []).filter(function (e) { return e.kind === "llm" && e.unexpectedMiss; });
  var missTotal = missCalls.reduce(function (a, e) { return a + (e.promptTokens || 0); }, 0);
  var missCost = missCalls.reduce(function (a, e) { return a + (e.cost || 0); }, 0);
  return (
    <div style={{ background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 4, padding: "6px 9px" }}>
      <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
        <span>Billed as new this prompt</span>
        <b style={{ color: theme.cost.fresh }}>{fmtT(pa.newTotal)}</b>
      </div>
      <div style={{ height: 10, background: theme.bg.surface, borderRadius: 1, overflow: "hidden", display: "flex" }}>
        {sum > 1 ? CTX_INPUT_KEYS.map(function (k) {
          var v = newPerBucket[k] || 0;
          if (v === 0) return null;
          var w = 100 * v / sum;
          return <div key={k} title={CTX_LABELS[k] + ": " + fmtT(v) + " new tok"} style={{ height: "100%", background: CTX_COLORS[k], width: w + "%" }} />;
        }) : <div style={{ height: "100%", background: theme.border.default, width: "100%" }} />}
      </div>
      {missCalls.length > 0 && (
        <div style={{ fontSize: theme.fontSize.xs, color: theme.cost.missText, marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ⚠ {missCalls.length} unexpected cache miss{missCalls.length > 1 ? "es" : ""} -- {fmtT(missTotal)} tok re-billed at premium (~{fmt$(missCost)})
        </div>
      )}
      {pa.modelSwitchedIn ? (
        <div style={{ fontSize: theme.fontSize.xs, color: theme.cost.switchText, marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ⇄ Model switch -- fresh cache, all context is genuinely new to this model
        </div>
      ) : (pa.cacheRecommit > 200 && (
        <div style={{ fontSize: theme.fontSize.xs, color: theme.cost.cwrite, marginTop: 4, fontStyle: "italic", lineHeight: 1.3 }}>
          ↻ {fmtT(pa.cacheRecommit)} of this is cache recommit (already in context, cache expired)
        </div>
      ))}
    </div>
  );
}

function Kpis(props) {
  var t = props.totals;
  var sa = props.subagentEst || {};
  var notes = [];
  if (sa.overheadCount > 0) {
    notes.push({
      text: "incl. " + fmt$(sa.overheadCost) + " overhead (" + sa.overheadCount + " " + (sa.overheadCount === 1 ? "call" : "calls") + ")",
      title: "Overhead calls (title generation, prompt categorization) are already counted in this total. Toggle 'Show overhead calls' above to filter them from the visualization.",
      color: theme.text.muted,
    });
  }
  if (sa.count > 0) {
    notes.push({
      text: "+ ~" + fmt$(sa.cost) + " est. subagent (" + sa.count + " " + (sa.count === 1 ? "call" : "calls") + ")",
      title: "VS Code's export does not report subagent token usage. This is estimated from each subagent's args.prompt length (~4 chars/token) and its model price.",
      color: theme.text.secondary,
    });
  }
  if (sa.imageCount > 0) {
    if (sa.imageCost > 0) {
      notes.push({
        text: "+ ~" + fmt$(sa.imageCost) + " est. images (" + sa.imageCount + " " + (sa.imageCount === 1 ? "image" : "images") + ", ~" + fmtT(sa.imageTokens) + " tok)",
        title: "Image input tokens are estimated from each attachment's `detail` field and the model's documented vision pricing rule. The export does not report exact image tokens, so this is an approximation that is NOT included in the headline Total cost.",
        color: theme.text.secondary,
      });
    } else {
      notes.push({
        text: "+ image cost not measured (" + sa.imageCount + " " + (sa.imageCount === 1 ? "image" : "images") + ")",
        title: "Images are attached but no documented vision-pricing rule is available for this model, so token cost can't be estimated.",
        color: theme.text.muted,
      });
    }
  }
  var totalCostItem = { l: "Total cost", v: fmt$(t.cost), notes: notes };
  var inputCost = (t.freshCost || 0) + (t.cachedCost || 0);
  var freshTok = Math.max(0, (t.promptTokens || 0) - (t.cached || 0) - (t.cacheWrite || 0));
  var items = [
    totalCostItem,
    {
      l: "Billed input",
      v: inputCost > 0 ? fmt$(inputCost) : fmtT(t.promptTokens),
      m: inputCost > 0 ? fmtT(t.promptTokens) + " tok" : null,
      d: fmtT(t.cached) + " cached · " + fmtT(freshTok) + " fresh · " + (100 * t.cacheHitRate).toFixed(0) + "% hit",
      dColor: theme.text.muted,
      dTitle: "Input split: cached (cheap rate) + fresh (full rate). Cache hit rate shows what fraction of input tokens were served from cache.",
    },
    (function () {
      // Split output cost into thinking, visible (response text), and tool-args
      // (JSON the model emits to invoke tools). All bill at the same output
      // rate, so split proportionally by char share when reasoning_tokens are
      // not reported directly (Claude).
      //
      // Tooltip breaks the visible slice further into prose vs fenced code
      // blocks by regex-scanning the visible response text. Inline `code`
      // (backtick spans) is folded into prose because it's typically file
      // paths and identifiers, not "the model wrote code".
      if (!(t.outputCost > 0) || !(t.output > 0)) {
        return { l: "Output", v: fmtT(t.output) };
      }
      var visCh = t.visibleResponseChars || 0;
      var thinkCh = t.thinkingChars || 0;
      var argCh = t.toolArgChars || 0;
      var perTok = t.outputCost / t.output;
      var thinkTok, visTok, argTok, source;
      if (t.reasoning > 0) {
        // OpenAI o-series: trust reasoning_tokens for thinking, then split
        // the remainder between visible response and tool-args by char share.
        thinkTok = t.reasoning;
        var remainTok = Math.max(0, t.output - thinkTok);
        var remCh = visCh + argCh;
        if (remCh > 0) {
          argTok = Math.round(remainTok * (argCh / remCh));
          visTok = remainTok - argTok;
        } else {
          argTok = 0; visTok = remainTok;
        }
        source = "reasoning_tokens + char-ratio";
      } else {
        var totCh = visCh + thinkCh + argCh;
        if (totCh > 0) {
          thinkTok = Math.round(t.output * (thinkCh / totCh));
          argTok = Math.round(t.output * (argCh / totCh));
          visTok = Math.max(0, t.output - thinkTok - argTok);
          source = "char-ratio";
        } else {
          thinkTok = 0; argTok = 0; visTok = t.output;
          source = "none";
        }
      }
      var thinkCost = thinkTok * perTok;
      var visCost = visTok * perTok;
      var argCost = argTok * perTok;
      var d = (
        <>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>thinking {fmt$(thinkCost)}</div>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>visible {fmt$(visCost)}</div>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>tool-args {fmt$(argCost)}</div>
        </>
      );
      // Tooltip: just the breakdowns. No explanatory prose.
      var codeCh = t.codeChars || 0;
      var visBreak = "";
      if (visCh > 0 && visTok > 0) {
        var codeTok = Math.round(visTok * (codeCh / visCh));
        var proseTok = Math.max(0, visTok - codeTok);
        var proseCost = proseTok * perTok;
        var codeCost = codeTok * perTok;
        var visLines = [
          "  prose " + fmt$(proseCost),
          "  fenced code " + fmt$(codeCost),
        ];
        var langs = Array.isArray(t.codeCharsByLang) ? t.codeCharsByLang : [];
        if (langs.length > 0 && codeCh > 0 && codeTok > 0) {
          langs.slice(0, 5).forEach(function (L) {
            var share = L.chars / codeCh;
            var lTok = Math.round(codeTok * share);
            var lCost = lTok * perTok;
            var label = L.lang || "(no lang)";
            visLines.push("    " + label + " " + fmt$(lCost));
          });
          if (langs.length > 5) visLines.push("    ...");
        }
        visBreak = "Visible (" + fmt$(visCost) + ")\n" + visLines.join("\n");
      }
      var argBreak = "";
      var argsByName = Array.isArray(t.toolArgCharsByName) ? t.toolArgCharsByName : [];
      if (argsByName.length > 0 && argCh > 0 && argTok > 0) {
        var argLines = argsByName.slice(0, 8).map(function (A) {
          var share = A.chars / argCh;
          var aTok = Math.round(argTok * share);
          var aCost = aTok * perTok;
          return "  " + A.name + " " + fmt$(aCost);
        });
        if (argsByName.length > 8) argLines.push("  ...");
        argBreak = "Tool-args (" + fmt$(argCost) + ")\n" + argLines.join("\n");
      }
      var sections = [];
      if (visBreak) sections.push(visBreak);
      if (argBreak) sections.push(argBreak);
      var title = sections.length > 0 ? sections.join("\n\n") : null;
      return {
        l: "Output",
        v: fmt$(t.outputCost),
        m: fmtT(t.output) + " tok",
        d: d,
        dColor: theme.text.muted,
        dTitle: title,
      };
    })(),
    (function () {
      var ohc = sa.overheadCount || 0;
      var primary = Math.max(0, t.llmCalls - ohc);
      // Per-thread breakdown when sub-agents exist: count LLM events grouped
      // by their containing prompt's name. Sub-agent prompts (name ===
      // "tool/runSubagent") carry an `invokedBy.description` we use as the
      // thread label.
      var threadBreakdown = null;
      var an = props.analysis;
      if (an && Array.isArray(an.prompts)) {
        var mainCount = 0;
        var subThreads = [];
        an.prompts.forEach(function (p) {
          var n = (p.events || []).filter(function (e) { return e && e.kind === "llm"; }).length;
          if (n === 0) return;
          if (p.name === "tool/runSubagent") {
            var label = (p.invokedBy && p.invokedBy.description) || p.userMessage || "subagent";
            subThreads.push({ label: label, count: n });
          } else {
            mainCount += n;
          }
        });
        if (subThreads.length > 0) {
          subThreads.sort(function (a, b) { return b.count - a.count; });
          var truncLabel = function (s) {
            var clean = String(s || "").replace(/\s+/g, " ").trim();
            return clean.length > 28 ? clean.slice(0, 27) + "\u2026" : clean;
          };
          var lineStyle = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
          var nodes = [];
          nodes.push(
            <div key="main" style={lineStyle}>
              <strong style={{ fontWeight: 600 }}>{mainCount}</strong>
              {" main thread" + (ohc > 0 ? " (incl. " + ohc + " overhead)" : "")}
            </div>
          );
          var maxRows = 3;
          var shown = subThreads.slice(0, maxRows);
          shown.forEach(function (st, idx) {
            nodes.push(
              <div key={"sa" + idx} style={lineStyle}>
                <span style={{ color: theme.text.dim }}>{"\u21B3 "}</span>
                <strong style={{ fontWeight: 600 }}>{st.count}</strong>
                {" "}
                {truncLabel(st.label)}
              </div>
            );
          });
          if (subThreads.length > maxRows) {
            var extra = subThreads.length - maxRows;
            var extraCalls = subThreads.slice(maxRows).reduce(function (a, s) { return a + s.count; }, 0);
            nodes.push(
              <div key="more" style={Object.assign({}, lineStyle, { color: theme.text.dim })}
                title={subThreads.slice(maxRows).map(function (s) { return s.count + " " + s.label; }).join("\n")}>
                {"\u2026 +" + extra + " more sub-agents (" + extraCalls + " calls)"}
              </div>
            );
          }
          threadBreakdown = <>{nodes}</>;
        }
      }
      var d = threadBreakdown
        ? threadBreakdown
        : (ohc > 0 ? primary + " primary \u00B7 " + ohc + " overhead" : null);
      return {
        l: "LLM calls",
        v: "" + t.llmCalls,
        d: d,
        dColor: theme.text.muted,
        dTitle: threadBreakdown
          ? "LLM calls grouped by thread. Main thread = the chat conversation. Sub-agent threads are spawned via the runSubagent tool; their calls are counted here but their token usage is estimated separately (see overall total)."
          : (ohc > 0
            ? "Primary calls are real chat turns the agent ran. Overhead calls are background bookkeeping (e.g. title generation, prompt categorization) Copilot makes for UI features -- still billed."
            : null),
      };
    })(),
    (function () {
      var all = Array.isArray(t.topTools) ? t.topTools : [];
      var top = all.slice(0, 3);
      var hasMore = all.length > 3;
      var sub = top.length > 0
        ? (
          <>
            {top.map(function (x, i) {
              return (
                <div key={i} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {x.name} {x.count}
                </div>
              );
            })}
            {hasMore && <div>...</div>}
          </>
        )
        : null;
      var title = all.length > 0
        ? "Top tools by invocation count: " + all.map(function (x) { return x.name + " (" + x.count + ")"; }).join(", ")
        : undefined;
      return { l: "Tool calls", v: "" + t.toolCalls, d: sub, dColor: theme.text.muted, dTitle: title };
    })(),
  ];
  if (t.cacheWrite > 0) {
    items.splice(3, 0, {
      l: "Cache write",
      v: t.cacheWriteCost > 0 ? fmt$(t.cacheWriteCost) : fmtT(t.cacheWrite),
      m: t.cacheWriteCost > 0 ? fmtT(t.cacheWrite) + " tok" : null,
      vTitle: "Cost of cache-write tokens (typically ~1.25x the fresh input rate). Pays once per chunk; subsequent calls hit at the cache-read rate.",
    });
  }
  if (t.unexpectedMissCount > 0) {
    items.push({ l: "⚠ Unexpected misses", v: "" + t.unexpectedMissCount, d: "wasted ~" + fmt$(t.unexpectedMissCost), warn: true });
  }
  // Setup overhead: tools and skills that were attached to every call but
  // never invoked / opened. Cost is computed at the cached-input rate
  // (these prefix tokens hit cache on calls 2..N), which honestly reflects
  // what the user is actually paying for the dead weight. Unused MCP servers
  // are intentionally excluded -- they ship zero tool defs to the model, so
  // they add zero LLM tokens. The standalone MCP reachability callout below
  // surfaces them separately.
  var setup = (function () {
    var analysis = props.analysis;
    if (!analysis || !Array.isArray(analysis.prompts)) return null;
    var unusedTools, skillCarry;
    try {
      unusedTools = detectUnusedTools(analysis.prompts);
      skillCarry = aggregateSkillCarry(analysis.prompts);
    } catch (_) { return null; }
    var toolsUnused = unusedTools.unused.length;
    var skillsUnused = skillCarry.unusedCount || 0;
    var totalUnused = toolsUnused + skillsUnused;
    if (totalUnused === 0) return null;
    var wastedTokPerCall = (unusedTools.unusedTokensPerCall || 0) + (skillCarry.unusedTokensPerCall || 0);
    var calls = unusedTools.callsWithDefs || 0;
    var wastedTokTotal = wastedTokPerCall * calls;
    // Per-token cached input rate, derived from observed cached spend. Falls
    // back to ~10% of the fresh rate (Anthropic / OpenAI cache discount).
    var perTokCached = 0;
    if (t.cached > 0 && t.cachedCost > 0) {
      perTokCached = t.cachedCost / t.cached;
    } else {
      var freshTokK = Math.max(0, (t.promptTokens || 0) - (t.cached || 0) - (t.cacheWrite || 0));
      if (freshTokK > 0 && t.freshCost > 0) perTokCached = (t.freshCost / freshTokK) * 0.1;
    }
    var wastedCost = wastedTokTotal * perTokCached;
    var toolsTokPerCall = unusedTools.unusedTokensPerCall || 0;
    var skillsTokPerCall = skillCarry.unusedTokensPerCall || 0;
    var toolsCost = toolsTokPerCall * calls * perTokCached;
    var skillsCost = skillsTokPerCall * calls * perTokCached;
    var toolsTotal = (unusedTools.offeredAll && unusedTools.offeredAll.size) || 0;
    var skillsTotal = skillCarry.skillCount || 0;
    var lines = [];
    if (toolsUnused > 0) {
      lines.push({
        text: toolsUnused + "/" + toolsTotal + " " + (toolsTotal === 1 ? "tool" : "tools") + " unused",
        cost: toolsCost,
      });
    }
    if (skillsUnused > 0) {
      lines.push({
        text: skillsUnused + "/" + skillsTotal + " " + (skillsTotal === 1 ? "skill" : "skills") + " unused",
        cost: skillsCost,
      });
    }
    var sub = (
      <>
        {lines.map(function (line, i) {
          return (
            <div key={i} style={{ fontVariantNumeric: "tabular-nums" }}>
              {line.text}{line.cost > 0 ? " ~" + fmt$(line.cost) : ""}
            </div>
          );
        })}
      </>
    );
    var unusedToolList = unusedTools.unused.slice(0, 12).join(", ") + (unusedTools.unused.length > 12 ? ", ..." : "");
    var title = "Tools and skills attached to every LLM call but never invoked or opened. "
      + "These ship in the (cache-discounted) system prefix on every call. "
      + "Disable them in your config to reduce per-call overhead. "
      + (toolsUnused > 0 ? ("Unused tools: " + unusedToolList + ". ") : "")
      + ("Estimated " + fmtT(wastedTokPerCall) + " wasted tok / call × " + calls + " calls.");
    return {
      l: "Setup overhead",
      v: wastedCost > 0 ? "~" + fmt$(wastedCost) : "" + totalUnused,
      m: wastedTokPerCall > 0 ? "~" + fmtT(wastedTokPerCall) + " tok / call" : null,
      d: sub,
      dColor: theme.text.muted,
      dTitle: title,
      vTitle: wastedCost > 0 ? title : null,
    };
  })();
  if (setup) items.push(setup);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(" + items.length + ", 1fr)", gap: 12, marginBottom: 28 }}>
      {items.map(function (k, i) {
        return (
          <div key={i} style={{
            background: theme.bg.surface,
            border: "1px solid " + (k.warn ? theme.cost.missBorder : theme.border.default),
            borderRadius: theme.radius.md, padding: "12px 14px",
            minWidth: 0,
          }}>
            <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, textTransform: "uppercase", letterSpacing: 0.6 }}>{k.l}</div>
            <div title={k.vTitle || undefined} style={{ fontSize: theme.fontSize.xl, fontWeight: 600, color: k.warn ? theme.cost.missText : theme.text.primary, marginTop: 4, fontVariantNumeric: "tabular-nums", cursor: k.vTitle ? "help" : "default" }}>{k.v}</div>
            {k.m && <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{k.m}</div>}
            {k.d && <div title={k.dTitle || undefined} style={{
              color: k.dColor || theme.semantic.success,
              fontSize: theme.fontSize.xs,
              marginTop: 2,
              cursor: k.dTitle ? "help" : "default",
              lineHeight: 1.4,
              ...(k.dTruncate ? {
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
              } : null),
            }}>{k.d}</div>}
            {k.notes && k.notes.map(function (n, ni) {
              return (
                <div key={ni} title={n.title} style={{ color: n.color, fontSize: theme.fontSize.xs, marginTop: 2, cursor: n.title ? "help" : "default", lineHeight: 1.35 }}>
                  {n.text}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// "Copy LLM analysis prompt" button. Builds a markdown+JSON payload (see
// `buildLlmAnalysisPrompt` in lib/llmAnalysisExport.ts) and drops it on the
// clipboard. The user pastes the result into ChatGPT / Claude / etc. and
// gets a structured session report back.
function ExportPromptButton(props) {
  var analysis = props.analysis;
  var sessionLabel = props.sessionLabel;
  var [status, setStatus] = useState("idle"); // idle | copied | error
  function onClick() {
    try {
      var text = buildLlmAnalysisPrompt(analysis, { sessionLabel: sessionLabel });
      navigator.clipboard.writeText(text).then(
        function () { setStatus("copied"); setTimeout(function () { setStatus("idle"); }, 2400); },
        function () { setStatus("error"); setTimeout(function () { setStatus("idle"); }, 3000); }
      );
    } catch (e) {
      setStatus("error");
      setTimeout(function () { setStatus("idle"); }, 3000); // eslint-disable-line
    }
  }
  var label = status === "copied" ? "✓ Analysis prompt copied"
    : status === "error" ? "Copy failed -- see console"
    : "Copy for LLM analysis";
  return (
    <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
      <button
        type="button"
        onClick={onClick}
        title="Copy the session wrapped in analyst instructions. Paste into ChatGPT/Claude/Copilot to get a focused report on efficiency, model fit, and what the user could have done differently."
        style={{
          background: status === "copied" ? "rgba(34,197,94,0.15)" : "transparent",
          border: "1px solid " + (status === "error" ? theme.semantic.error : theme.border.default),
          color: status === "copied" ? theme.semantic.success
            : status === "error" ? theme.semantic.error
            : theme.accent.primary,
          padding: "4px 12px",
          borderRadius: theme.radius.sm,
          cursor: "pointer",
          fontFamily: theme.font.mono,
          fontSize: theme.fontSize.xs,
        }}
      >
        {label}
      </button>
    </div>
  );
}


// two groups: user-facing calls vs 'overhead' calls (title generation,
// prompt categorization, etc.). Overhead is rendered dimmer and tagged so
// it stays accountable but visually deprioritised.
function ModelBreakdown(props) {
  var prompts = props.prompts || [];
  var mainTotals = {};
  var ovhTotals = {};
  var mainGrandCost = 0;
  var mainGrandCalls = 0;
  var ovhGrandCost = 0;
  var ovhGrandCalls = 0;
  prompts.forEach(function (p) {
    (p.events || []).forEach(function (e) {
      if (e.kind !== "llm") return;
      var name = e.model || "(unknown)";
      var isOvh = e.category === "overhead";
      var bucket = isOvh ? ovhTotals : mainTotals;
      var t = bucket[name] || { cost: 0, calls: 0, ctx: 0 };
      t.cost += e.cost || 0;
      t.calls += 1;
      t.ctx += e.promptTokens || 0;
      bucket[name] = t;
      if (isOvh) { ovhGrandCost += e.cost || 0; ovhGrandCalls += 1; }
      else { mainGrandCost += e.cost || 0; mainGrandCalls += 1; }
    });
  });
  var mkRows = function (totals) {
    return Object.keys(totals).map(function (k) {
      return { name: k, cost: totals[k].cost, calls: totals[k].calls, ctx: totals[k].ctx };
    }).sort(function (a, b) { return b.cost - a.cost; });
  };
  var mainRows = mkRows(mainTotals);
  var ovhRows = mkRows(ovhTotals);
  if (mainRows.length === 0 && ovhRows.length === 0) return null;
  var shortName = function (n) {
    if (!n) return "(unknown)";
    return n.replace(/-(\d{8})$/, "").replace(/-\d{8}-v\d+$/, "");
  };
  var palette = [theme.cost.cached, theme.cost.fresh, theme.cost.cwrite, theme.cost.ctxHistory, theme.cost.ctxToolDefs, theme.cost.ctxImages];

  function renderGroup(rows, grandCost, grandCalls, dim) {
    if (rows.length === 0) return null;
    var multi = rows.length > 1;
    return (
      <>
        {multi && (
          <div style={{ display: "flex", width: "100%", height: 6, borderRadius: 2, overflow: "hidden", background: theme.bg.base, marginBottom: 10, opacity: dim ? 0.6 : 1 }}>
            {rows.map(function (r, i) {
              var pct = grandCost > 0 ? 100 * r.cost / grandCost : 100 / rows.length;
              return <div key={r.name} style={{ width: pct + "%", background: palette[i % palette.length] }} title={shortName(r.name) + ": " + pct.toFixed(0) + "% of " + (dim ? "overhead " : "") + "cost"} />;
            })}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, opacity: dim ? 0.7 : 1 }}>
          {rows.map(function (r, i) {
            var color = palette[i % palette.length];
            var costPct = grandCost > 0 ? Math.round(100 * r.cost / grandCost) : 100;
            var callPct = grandCalls > 0 ? Math.round(100 * r.calls / grandCalls) : 100;
            return (
              <div key={r.name} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: theme.fontSize.sm, fontVariantNumeric: "tabular-nums" }}>
                <span style={{ display: "inline-block", width: 8, height: 8, background: color, borderRadius: 2, flex: "0 0 auto" }} />
                <span style={{ color: dim ? theme.text.secondary : theme.text.primary, fontWeight: 500, fontFamily: theme.font.mono, fontSize: theme.fontSize.xs }} title={r.name}>{shortName(r.name)}</span>
                <span style={{ color: theme.text.secondary, marginLeft: "auto" }}>
                  {fmt$(r.cost)} <span style={{ color: theme.text.muted }}>· {costPct}%</span>
                </span>
                <span style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, minWidth: 80, textAlign: "right" }}>
                  {r.calls} call{r.calls === 1 ? "" : "s"} · {callPct}%
                </span>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div style={{
      background: theme.bg.surface, border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.md, padding: "10px 14px", marginBottom: 28,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: mainRows.length > 1 ? 8 : 4 }}>
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, textTransform: "uppercase", letterSpacing: 0.6 }}>
          Models used {mainRows.length > 1 ? "(" + mainRows.length + " for chat)" : ""}
        </div>
        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs }}>
          {fmt$(mainGrandCost)} chat · {mainGrandCalls} call{mainGrandCalls === 1 ? "" : "s"}
        </div>
      </div>
      {renderGroup(mainRows, mainGrandCost, mainGrandCalls, false)}
      {ovhRows.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "14px 0 6px", paddingTop: 10, borderTop: "1px dashed " + theme.border.subtle }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                fontSize: theme.fontSize.xs, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
                color: theme.text.muted, background: theme.bg.raised, border: "1px solid " + theme.border.subtle,
                textTransform: "uppercase", letterSpacing: 0.4,
              }}>overhead</span>
              <span style={{ color: theme.text.muted, fontSize: theme.fontSize.xs }} title="Title generation, prompt categorization, and other UI/telemetry calls. Already counted in 'Total cost' above. Toggle 'Show overhead calls' to filter them from the timeline.">
                title gen, categorization, telemetry
              </span>
            </div>
            <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs }}>
              {fmt$(ovhGrandCost)} · {ovhGrandCalls} call{ovhGrandCalls === 1 ? "" : "s"}
            </div>
          </div>
          {renderGroup(ovhRows, ovhGrandCost, ovhGrandCalls, true)}
        </>
      )}
    </div>
  );
}

function Glossary() {
  var term = function (color, bg) {
    return {
      display: "inline-block", background: bg || theme.bg.surface, color: color, padding: "1px 7px",
      borderRadius: 9, fontSize: theme.fontSize.xs, fontWeight: 600, letterSpacing: 0.4, marginRight: 4,
    };
  };
  return (
    <div style={{ background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 5, padding: "11px 14px", marginBottom: 20, fontSize: theme.fontSize.sm, color: theme.text.secondary, lineHeight: 1.7 }}>
      <span style={term(theme.cost.fresh)}>CTX</span><b style={{ color: theme.text.primary }}>Context window</b> -- actual size of one LLM call's input (= API <code>prompt_tokens</code>).
      &nbsp;&nbsp;<span style={term(theme.cost.fresh)}>▲ NET</span><b style={{ color: theme.text.primary }}>Net new context</b> -- how much working memory actually grew vs the previous call.
      &nbsp;&nbsp;<span style={term(theme.cost.cwrite, theme.cost.chipBgExtension)}>$ BILLED</span><b style={{ color: theme.text.primary }}>Billed input</b> -- sum of <code>prompt_tokens</code> across calls (cache reads still cost; cache writes cost more).
      &nbsp;&nbsp;<span style={term(theme.cost.cwrite, theme.cost.chipBgExtension)}>↻ RECOMMIT</span><b style={{ color: theme.text.primary }}>Cache recommit</b> -- content the agent already had to send again because the cache expired.
    </div>
  );
}

function Legend() {
  var swatchStyle = function (color) { return { display: "inline-block", width: 10, height: 10, marginRight: 5, borderRadius: 2, verticalAlign: "-1px", background: color }; };
  var groupStyle = { padding: "6px 10px", background: theme.bg.base, border: "1px solid " + theme.border.default, borderRadius: 4, display: "flex", flexWrap: "wrap", gap: 10 };
  var labelStyle = { color: theme.text.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, fontSize: theme.fontSize.xs, marginRight: 4 };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, margin: "8px 0 20px", fontSize: theme.fontSize.sm, color: theme.text.secondary }}>
      <div style={groupStyle}>
        <b style={labelStyle}>cost type</b>
        <span><span style={swatchStyle(COST_COLORS.fresh)} />fresh input</span>
        <span><span style={swatchStyle(COST_COLORS.cwrite)} />cache write</span>
        <span><span style={swatchStyle(COST_COLORS.cached)} />cached read</span>
        <span><span style={swatchStyle(COST_COLORS.output)} />output</span>
      </div>
      <div style={groupStyle}>
        <b style={labelStyle}>context part</b>
        {CTX_KEYS.map(function (k) { return <span key={k}><span style={swatchStyle(CTX_COLORS[k])} />{CTX_LABELS[k]}</span>; })}
      </div>
    </div>
  );
}

function McpReachabilityCallout(props) {
  var reach = props.reachability;
  if (!reach || !reach.available) return null;
  if (!reach.unusedCount || reach.unusedCount === 0) return null;
  var warn = theme.semantic.warning;
  var unusedLabels = reach.unused.map(function (s) { return s.label; });
  var mcpToolCount = reach.mcpToolCount || 0;
  var matchedToolCount = reach.matches.reduce(function (sum, m) { return sum + (m.toolCount || 0); }, 0);
  return (
    <div
      role="alert"
      style={{
        margin: "0 0 16px",
        padding: "12px 14px",
        background: warn + "14",
        border: "1px solid " + warn + "55",
        borderLeft: "4px solid " + warn,
        borderRadius: 5,
        fontSize: theme.fontSize.sm,
        color: theme.text.primary,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: warn }}>
        {"\u26A0\uFE0F  "}
        {reach.visibleCount} of {reach.declaredCount} listed MCP servers produced all {matchedToolCount} <code style={{ background: "transparent" }}>mcp_*</code> tools the model saw; the other {reach.unusedCount} produced 0
      </div>
      <div style={{ color: theme.text.secondary, marginBottom: 6 }}>
        No <code>mcp_*</code> tools from these labels appeared in any chat request. They may be disabled, may have failed to start, or simply had no tools the IDE chose to send.
      </div>
      <div style={{ color: theme.text.secondary, marginBottom: 6 }}>
        Unused: {unusedLabels.map(function (label, idx) {
          return (
            <span key={label}>
              <code style={{ background: theme.bg.surface, padding: "1px 6px", borderRadius: 3 }}>{label}</code>
              {idx < unusedLabels.length - 1 ? ", " : ""}
            </span>
          );
        })}
      </div>
      <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, fontStyle: "italic" }}>
        Heuristic label-slug match against <code>mcp_&lt;slug&gt;_*</code> tool names.
        {mcpToolCount > matchedToolCount ? (
          <span> {mcpToolCount - matchedToolCount} additional <code>mcp_*</code> tool(s) appeared on the wire without a matching listed server.</span>
        ) : null}
        {reach.extraInWire && reach.extraInWire.length > 0 ? (
          <span>
            {" "}Unmatched prefixes: {reach.extraInWire.map(function (e) { return "mcp_" + e.slug + "_*"; }).join(", ")}.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Resolve a thread's colorKey to the actual theme hex. Centralized so the
// pill, badge, and per-row left border all use the same color for a given
// agent. Colors live under theme.agentThread.* (defined in theme.js).
function agentColor(colorKey) {
  return theme.agentThread[colorKey] || theme.agentThread.main;
}

// Row of agent cards rendered above the timeline. Each card shows the
// agent's identity (color dot + label + optional task snippet), its real
// cost and call counts, and clicking it toggles a filter on the timeline
// below. Renders nothing when the session has only one agent (the main
// thread) since there's nothing to compare or filter.
function AgentThreadsRow(props) {
  var threads = props.threads || [];
  var selected = props.selected;
  var onToggle = props.onToggle;
  var onSelectAll = props.onSelectAll;
  if (threads.length <= 1) return null;
  var isAll = !selected || selected.size === 0 || selected.size === threads.length;
  return (
    <div style={{ margin: "0 0 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ color: theme.text.primary, fontSize: theme.fontSize.sm, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>
          Agent threads in this session ({threads.length})
        </div>
        <button
          onClick={onSelectAll}
          style={{
            background: isAll ? theme.bg.raised : "transparent",
            border: "1px solid " + (isAll ? theme.border.default : theme.border.subtle),
            color: isAll ? theme.text.primary : theme.text.secondary,
            fontFamily: theme.font.mono,
            fontSize: theme.fontSize.xs,
            padding: "4px 10px",
            borderRadius: 3,
            cursor: "pointer",
            transition: "all " + theme.transition.fast,
          }}
          title="Show all agents in the timeline"
        >
          {isAll ? "✓ all" : "show all"}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
        {threads.map(function (t) {
          var on = !selected || selected.size === 0 || selected.has(t.id);
          var color = agentColor(t.colorKey);
          return (
            <button
              key={t.id}
              onClick={function () { onToggle(t.id); }}
              style={{
                textAlign: "left",
                background: on ? theme.bg.raised : theme.bg.surface,
                border: "1px solid " + (on ? color + "55" : theme.border.subtle),
                borderLeft: "4px solid " + (on ? color : color + "55"),
                padding: "10px 12px",
                borderRadius: 3,
                cursor: "pointer",
                fontFamily: theme.font.mono,
                opacity: on ? 1 : 0.55,
                transition: "all " + theme.transition.fast,
              }}
              title={t.slot === "sub" ? "Subagent " + t.letter + (t.taskSnippet ? " · " + t.taskSnippet : "") : "Main agent (all user-initiated turns)"}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ display: "inline-block", width: 10, height: 10, background: color, borderRadius: 2, flex: "0 0 auto" }} />
                <span style={{ color: theme.text.primary, fontSize: theme.fontSize.sm, fontWeight: 600 }}>{t.label}</span>
              </div>
              {t.slot === "sub" && t.taskSnippet ? (
                <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.xs, marginBottom: 6, lineHeight: 1.4, fontStyle: "italic" }}>
                  &ldquo;{t.taskSnippet}&rdquo;
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 12, color: theme.text.muted, fontSize: theme.fontSize.xs, fontVariantNumeric: "tabular-nums" }}>
                <span><b style={{ color: theme.text.secondary }}>{t.llmCount}</b> LLM</span>
                <span><b style={{ color: theme.text.secondary }}>{t.toolCount}</b> tools</span>
                <span style={{ marginLeft: "auto", color: theme.text.primary, fontWeight: 600 }}>{fmt$(t.totalCost)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CostView(props) {
  var analysis = props.analysis;
  var [openRow, setOpenRow] = useState({});
  var [showOverhead, setShowOverhead] = useState(false);
  var [unit, setUnit] = usePersistentState("agentviz.cost.unit", "credits");
  // Per-view (not persisted) filter for agent threads. null = all visible.
  // Stored as a Set<string> of selected thread ids.
  var [selectedAgents, setSelectedAgents] = useState(null);
  // Keep the module-level fmt$ helper in sync. Use a layout-time effect so the
  // very first render after a unit change already formats with the new unit.
  setCostUnit(unit);
  useEffect(function () { setCostUnit(unit); }, [unit]);

  if (!analysis || !analysis.prompts || !analysis.prompts.length) {
    return (
      <div style={{ padding: 40, color: theme.text.secondary, textAlign: "center", fontFamily: theme.font.mono }}>
        Cost analysis isn't available for this session format.
        <br />
        Load a VS Code Copilot Chat <code>copilot_all_prompts_*.json</code> export to see the cost breakdown.
      </div>
    );
  }

  // Pre-compute cumulative cost states (one per event in document order).
  var cumStates = useMemo(function () { return buildCumStates(analysis.prompts, showOverhead); }, [analysis, showOverhead]);
  var workspaceRoot = useMemo(function () { return inferWorkspaceRoot(analysis); }, [analysis]);
  var maxCost = cumStates.length
    ? cumStates[cumStates.length - 1].fresh + cumStates[cumStates.length - 1].cached + cumStates[cumStates.length - 1].cwrite + cumStates[cumStates.length - 1].output
    : 0.0001;
  var allLLM = [];
  analysis.prompts.forEach(function (p) {
    p.events.forEach(function (e) { if (e.kind === "llm") allLLM.push(e); });
  });
  var maxCtx = Math.max.apply(null, allLLM.map(function (e) {
    return e.promptTokens + (e.output || 0) + Math.max(0, (e.visionTokensTotal || 0) - (e.imageTokensEst || 0));
  }).concat([1]));

  // Sum estimated subagent cost across the session. Estimates only apply to
  // runSubagent calls when we know the subagent's model; others are skipped
  // so the number stays honest.
  // Also sum overhead-call cost (already included in totals) and count
  // images (not measured at all -- export carries no token usage for them).
  var subagentEst = useMemo(function () {
    var saCount = 0, saCost = 0;
    var ohCount = 0, ohCost = 0;
    var imgCount = 0, imgCost = 0, imgTokens = 0;
    analysis.prompts.forEach(function (p) {
      p.events.forEach(function (e) {
        if (e.kind === "tool" && e.subagent) {
          saCount += 1;
          if (e.subagent.modelName && hasModelPricing(e.subagent.modelName)) {
            saCost += estimateCost({
              inputTokens: e.subagent.promptTokensEst || 0,
              outputTokens: e.resultTokens || 0,
              cacheRead: 0, cacheWrite: 0,
            }, e.subagent.modelName);
          }
        } else if (e.kind === "llm") {
          if (e.category === "overhead") {
            ohCount += 1;
            ohCost += e.cost || 0;
          }
          if (e.newImages && e.newImages.length > 0) {
            imgCount += e.newImages.length;
            var price = e.model ? getModelPrice(e.model) : null;
            for (var ii = 0; ii < e.newImages.length; ii++) {
              var tok = estimateImageTokens(e.model, e.newImages[ii].detail);
              imgCost += imageDollarCost(price, tok);
              imgTokens += tok;
            }
          }
        }
      });
    });
    return { count: saCount, cost: saCost, overheadCount: ohCount, overheadCost: ohCost, imageCount: imgCount, imageCost: imgCost, imageTokens: imgTokens };
  }, [analysis]);

  var rowKey = function (pi, ei) { return pi + ":" + ei; };
  var toggle = function (pi, ei) { var k = rowKey(pi, ei); setOpenRow(Object.assign({}, openRow, { [k]: !openRow[k] })); };

  // Count overhead calls across the whole session for the toolbar label.
  var overheadCount = 0, overheadCost = 0;
  analysis.prompts.forEach(function (p) {
    p.events.forEach(function (e) {
      if (e.kind === "llm" && e.category === "overhead") {
        overheadCount += 1;
        overheadCost += e.cost || 0;
      }
    });
  });

  var globalEventIdx = 0;

  // Group prompts into agent threads (main + N subagents) so the user can
  // see per-agent cost cards and filter the timeline below by agent.
  var agentInfo = useMemo(function () { return buildAgentThreads(analysis.prompts); }, [analysis]);
  var threadOf = function (promptId) {
    var tid = agentInfo.promptIdToThreadId.get(promptId);
    return agentInfo.threads.find(function (x) { return x.id === tid; }) || null;
  };
  var toggleAgent = function (id) {
    setSelectedAgents(function (prev) {
      var next = new Set(prev || agentInfo.threads.map(function (t) { return t.id; }));
      if (next.has(id)) next.delete(id); else next.add(id);
      // If everything is selected, normalize back to null (all visible).
      if (next.size === 0 || next.size === agentInfo.threads.length) return null;
      return next;
    });
  };
  var clearAgentFilter = function () { setSelectedAgents(null); };
  var isAgentVisible = function (promptId) {
    if (!selectedAgents) return true;
    var tid = agentInfo.promptIdToThreadId.get(promptId);
    return selectedAgents.has(tid);
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden", background: theme.bg.base }}>
    <div style={{ maxWidth: 1700, margin: "0 auto", padding: "32px 28px 80px", fontFamily: theme.font.mono, fontSize: theme.fontSize.md, color: theme.text.primary }}>
      <h1 style={{ fontSize: theme.fontSize.xl, fontWeight: 600, margin: "0 0 4px", color: theme.text.primary, letterSpacing: 0.4 }}>
        Token cost &amp; context buildup
      </h1>
      <div style={{ color: theme.text.muted, fontSize: theme.fontSize.base, marginBottom: 24 }}>
        Three different lenses on "input": context size, growth, and billing.
      </div>

      <ExportPromptButton analysis={analysis} sessionLabel={props.sessionLabel || null} />

      <Kpis totals={analysis.totals} subagentEst={subagentEst} analysis={analysis} />
      <ModelBreakdown prompts={analysis.prompts} />
      <Glossary />
      <Legend />
      <McpReachabilityCallout reachability={analysis.mcpReachability} />
      <AgentThreadsRow
        threads={agentInfo.threads}
        selected={selectedAgents}
        onToggle={toggleAgent}
        onSelectAll={clearAgentFilter}
      />

      <div style={{
        display: "flex", alignItems: "center", gap: 12, margin: "0 0 12px",
        padding: "8px 12px", background: theme.bg.surface,
        border: "1px solid " + theme.border.default, borderRadius: 5,
        fontSize: theme.fontSize.sm, color: theme.text.secondary,
      }}>
        <span style={{ color: theme.text.muted }}>Show costs as:</span>
        <div role="radiogroup" aria-label="Cost display unit" style={{
          display: "inline-flex", border: "1px solid " + theme.border.default,
          borderRadius: 4, overflow: "hidden",
        }}>
          {[
            { id: "credits", label: "AI Credits", title: "1 credit = $0.01 (GitHub Copilot AI Credits)" },
            { id: "currency", label: "USD ($)", title: "Raw provider $ rates from pricing.js" },
          ].map(function (opt) {
            var active = unit === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={opt.title}
                onClick={function () { setUnit(opt.id); }}
                style={{
                  padding: "4px 10px", border: "none", cursor: "pointer",
                  background: active ? theme.cost.fresh : "transparent",
                  color: active ? theme.bg.base : theme.text.secondary,
                  fontFamily: theme.font.mono, fontSize: theme.fontSize.sm,
                  fontWeight: active ? 600 : 400,
                }}
              >{opt.label}</button>
            );
          })}
        </div>
        <span style={{ color: theme.text.muted, fontSize: theme.fontSize.xs }}>
          {unit === "credits"
            ? "100 cr = $1. Persists across sessions."
            : "Raw USD from per-token rates. Persists across sessions."}
        </span>
      </div>

      {overheadCount > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, margin: "0 0 12px",
          padding: "8px 12px", background: theme.bg.surface,
          border: "1px solid " + theme.border.default, borderRadius: 5,
          fontSize: theme.fontSize.sm, color: theme.text.secondary,
        }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showOverhead}
              onChange={function (e) { setShowOverhead(e.target.checked); }}
              style={{ cursor: "pointer" }}
            />
            <span>
              Show overhead LLM calls
              <span style={{ color: theme.text.muted, marginLeft: 6 }}>
                ({overheadCount} {overheadCount === 1 ? "call" : "calls"} ·{" "}
                {fmt$(overheadCost)} · e.g. <code>title</code>, <code>promptCategorization</code>)
              </span>
            </span>
          </label>
          <span style={{ marginLeft: "auto", color: theme.text.muted, fontSize: theme.fontSize.xs }}>
            Totals always include all calls.
          </span>
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(420px,1fr) 360px 360px",
        border: "1px solid " + theme.border.default, borderRadius: 6, overflow: "hidden", background: theme.bg.surface,
      }}>
        <div style={colHeadStyle()}>Prompt &amp; steps</div>
        <div style={Object.assign({}, colHeadStyle(), { borderLeft: "1px solid " + theme.border.default })}>Cumulative cost so far → max {fmt$(maxCost)}</div>
        <div style={Object.assign({}, colHeadStyle(), { borderLeft: "1px solid " + theme.border.default })}>Context window for this call → max {fmtT(maxCtx)} tok</div>

        {(function () {
          var visiblePromptOrdinal = 0;
          return analysis.prompts.map(function (p, pi) {
          var cachedPct = 100 * p.cacheHitRate;
          var pa = p.prompt;
          // Hide prompts whose agent is filtered out. Advance the cumulative
          // state cursor so other prompts stay aligned with their cumStates.
          if (!isAgentVisible(p.promptId)) {
            globalEventIdx += p.events.length;
            return null;
          }
          // When hiding overhead calls, prompts whose only LLM activity is
          // overhead (e.g. background `title` / `promptCategorization` calls)
          // become empty. Skip rendering them entirely, but advance the
          // cumulative-state cursor so other prompts stay aligned.
          if (!showOverhead) {
            var visible = 0;
            p.events.forEach(function (e) {
              if (e.kind === "llm") {
                if (e.category !== "overhead") visible += 1;
              } else {
                visible += 1;
              }
            });
            if (visible === 0) {
              globalEventIdx += p.events.length;
              return null;
            }
          }
          visiblePromptOrdinal += 1;
          var displayOrdinal = visiblePromptOrdinal;
          var thread = threadOf(p.promptId);
          var tColor = thread ? agentColor(thread.colorKey) : null;
          var parentOrdinal = null;
          if (thread && thread.slot === "sub" && thread.parentPromptId) {
            // 1-based ordinal of the parent prompt in the unfiltered list,
            // for a "spawned by prompt #N" hint on the subagent header.
            var pidx = analysis.prompts.findIndex(function (x) { return x.promptId === thread.parentPromptId; });
            if (pidx >= 0) parentOrdinal = pidx + 1;
          }
          return (
            <React.Fragment key={pi}>
              {/* Prompt header spans all 3 columns */}
              <div style={{
                gridColumn: "1 / -1",
                background: theme.bg.raised,
                borderTop: pi > 0 ? "1px solid " + theme.border.default : "none",
                borderBottom: "1px solid " + theme.border.default,
                borderLeft: tColor ? "4px solid " + tColor : undefined,
                padding: "14px 18px",
                display: "grid",
                gridTemplateColumns: "48px 1fr 220px auto",
                gap: 14,
                alignItems: "center",
              }}>
                <div style={{ fontSize: theme.fontSize.xs, color: theme.text.muted, textAlign: "center" }}>
                  <span style={{ fontSize: theme.fontSize.xxl, color: theme.text.primary, fontWeight: 700, display: "block", lineHeight: 1 }}>{displayOrdinal}</span>
                  prompt
                </div>
                <div>
                  {thread && agentInfo.threads.length > 1 ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: theme.fontSize.xs }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        background: tColor + "1f",
                        color: tColor,
                        border: "1px solid " + tColor + "55",
                        padding: "2px 7px", borderRadius: 3, fontWeight: 600,
                        letterSpacing: 0.3,
                      }}>
                        <span style={{ display: "inline-block", width: 7, height: 7, background: tColor, borderRadius: 2 }} />
                        {thread.slot === "sub" ? "SUB " + thread.letter : "MAIN"}
                      </span>
                      {parentOrdinal != null ? (
                        <span style={{ color: theme.text.muted }}>spawned by prompt #{parentOrdinal}</span>
                      ) : null}
                    </div>
                  ) : null}
                  <div style={{ color: theme.text.primary, fontSize: theme.fontSize.md, fontWeight: 500, lineHeight: 1.4 }}>{p.label || "(empty)"}</div>
                  <div style={{ color: theme.text.secondary, fontSize: theme.fontSize.sm, marginTop: 6, display: "grid", gap: 4 }}>
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
                      <span style={{ color: theme.cost.cached }}>⊞ Context: <b style={{ color: theme.cost.cached, fontWeight: 600 }}>{fmtT(pa.contextInitial)} → {fmtT(pa.contextFinal)}</b></span>
                      <span style={{ color: theme.cost.fresh, fontWeight: 600 }}>▲ {fmtTSigned(pa.contextGrowth)} tok net new this prompt</span>
                      <span><b style={{ color: theme.text.primary, fontWeight: 500 }}>{p.llmCount}</b> LLM</span>
                      <span><b style={{ color: theme.text.primary, fontWeight: 500 }}>{p.toolCount}</b> tools</span>
                    </div>
                    <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, display: "flex", gap: 14, flexWrap: "wrap" }}>
                      <span>$ Billed: <b style={{ color: theme.text.secondary }}>{fmtT(p.promptTokens)}</b> input · <b style={{ color: theme.text.secondary }}>{fmtT(p.output)}</b> output · <b style={{ color: theme.text.secondary }}>{cachedPct.toFixed(0)}%</b> cached · <b style={{ color: theme.text.secondary }}>{fmtT(pa.newTotal)}</b> billed-as-new</span>
                      {pa.cacheRecommit > 200 && <span style={{ color: theme.cost.cwrite }}>↻ <b>{fmtT(pa.cacheRecommit)}</b> recommit</span>}
                    </div>
                  </div>
                </div>
                <div><PromptNewMini prompt={p} /></div>
                <div style={{ fontSize: theme.fontSize.lg, fontWeight: 600, color: theme.text.primary, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{fmt$(p.cost)}</div>
              </div>
              <PromptCostBreakdown prompt={p} />

              {p.events.map(function (ev, ei) {
                var isLLM = ev.kind === "llm";
                var k = rowKey(pi, ei);
                var open = !!openRow[k];
                var cumState = cumStates[globalEventIdx];
                globalEventIdx += 1;
                // Hide overhead LLM rows when toggle is off, but keep
                // cumulative bars and totals correct (we already incremented
                // globalEventIdx above).
                if (isLLM && ev.category === "overhead" && !showOverhead) {
                  return null;
                }
                var cellBg = isLLM ? theme.bg.surface : theme.bg.raised;
                // Whether this is the first LLM event in this prompt's events
                // (used to anchor the "invoked by" hint for subagent prompts).
                var isFirstLlmInPrompt = false;
                if (isLLM && p.invokedBy) {
                  isFirstLlmInPrompt = true;
                  for (var fi = 0; fi < ei; fi++) {
                    if (p.events[fi] && p.events[fi].kind === "llm") { isFirstLlmInPrompt = false; break; }
                  }
                }
                var meta = isLLM ? (
                  <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {open && <span>{(ev.model || "").split("-").slice(0, 3).join("-")}</span>}
                    <span style={{ color: theme.cost.cached, cursor: "help" }}
                          title="Total input sent to the LLM this call (the full prompt). = cached + billed-new.">
                      ⊞ <b style={{ color: theme.cost.cached }}>{fmtT(ev.promptTokens)}</b> ctx
                    </span>
                    <span style={{ color: theme.cost.fresh, cursor: "help" }}
                          title="How much the prompt grew vs the previous call's prompt size. Independent of caching -- just measures growth. On the first call this equals the full context.">
                      ▲ <b style={{ color: theme.cost.fresh }}>{fmtTSigned(ev.deltaVsPrev)}</b> net new
                    </span>
                    <span style={{ cursor: "help" }}
                          title="Tokens served from prompt cache at ~10% of the input rate. Copilot caches at the GitHub service layer (not just per-session), so even the first call in a session can hit cache for stable prefixes like the system prompt and tool defs.">
                      <b style={{ color: theme.text.primary }}>{fmtT(ev.cached)}</b> cached
                    </span>
                    <span style={{ color: theme.cost.cwrite, cursor: "help" }}
                          title="Tokens NOT served from cache, billed at full input rate (or cache-write rate ~1.25x). = ctx - cached.">
                      $ <b>{fmtT(ev.newTotal)}</b> billed-new
                    </span>
                    <span style={{ color: theme.text.secondary }}>{fmt$(ev.cost)}</span>
                    {ev.unexpectedMiss && (
                      <span style={{ color: theme.cost.missText, background: theme.cost.missBg, border: "1px solid " + theme.cost.missBorder, padding: "1px 6px", borderRadius: 3 }}>⚠ unexpected cache miss</span>
                    )}
                  </div>
                ) : (
                  (function () {
                    if (ev.subagent) {
                      var sa = ev.subagent;
                      var inputTok = sa.promptTokensEst || 0;
                      var outputTok = ev.resultTokens || 0;
                      var costEst = (sa.modelName && hasModelPricing(sa.modelName))
                        ? estimateCost({ inputTokens: inputTok, outputTokens: outputTok, cacheRead: 0, cacheWrite: 0 }, sa.modelName)
                        : null;
                      return (
                        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                          <span>subagent</span>
                          {sa.modelName && <span style={{ color: theme.text.secondary }}>{sa.modelName}</span>}
                          <span title="Estimated from args.prompt length (~4 chars/token); the export does not include subagent token usage">
                            ▶ <b style={{ color: theme.cost.fresh }}>~{fmtT(inputTok)}</b> in
                          </span>
                          <span>◀ <b style={{ color: theme.cost.ctxHistory }}>{fmtT(outputTok)}</b> out</span>
                          {costEst != null
                            ? <span style={{ color: theme.text.secondary }} title="Estimated cost based on input/output token estimates and the subagent model price; not reported by VS Code">~{fmt$(costEst)}</span>
                            : <span style={{ color: theme.text.ghost, fontStyle: "italic" }} title="Subagent cost is not reported in the Copilot Chat export">cost n/a</span>}
                        </div>
                      );
                    }
                    return (
                      <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 3, display: open ? "flex" : "none", gap: 10 }}>
                        <span>tool call</span>
                        {ev.resultTokens > 0 && <span>→ <b style={{ color: theme.text.primary }}>{fmtT(ev.resultTokens)}</b> tok of result</span>}
                      </div>
                    );
                  })()
                );

                return (
                  <React.Fragment key={ei}>
                    <div id={"cost-row-" + pi + "-" + ei} onClick={function () { toggle(pi, ei); }}
                      style={{
                        padding: "8px 14px", borderBottom: "1px solid " + theme.border.subtle,
                        background: cellBg, display: "flex", alignItems: "center", minHeight: 38, cursor: "pointer",
                      }}>
                      <div style={{ display: "grid", gridTemplateColumns: "18px 78px 1fr", gap: 8, alignItems: "start", width: "100%" }}>
                        <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, width: 14, textAlign: "center", marginTop: 3, transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}>▶</div>
                        {(function () {
                          var pillBg, pillFg, pillBorder, pillLabel, pillTitle;
                          var isSubagentLlm = isLLM && ev.name === "tool/runSubagent";
                          if (isLLM) {
                            if (ev.synthesized) {
                              pillBg = theme.cost.chipBgBuiltin;
                              pillFg = theme.text.muted;
                              pillBorder = theme.border.subtle;
                              pillLabel = "LLM (synth)";
                              pillTitle = "Synthesized LLM call. VS Code's export omitted the `request` log entry for this round-trip, so token counts and cost are unavailable. The response text was recovered from the next request's message history; producedToolCalls were dispatched by this missing call.";
                            } else if (isSubagentLlm) {
                              if (thread && thread.slot === "sub" && tColor) {
                                pillBg = tColor + "1f";
                                pillFg = tColor;
                                pillBorder = tColor + "55";
                                pillLabel = "Sub " + thread.letter + " LLM";
                              } else {
                                pillBg = theme.cost.chipBgExtension;
                                pillFg = theme.cost.kindExtension;
                                pillBorder = theme.cost.kindExtension + "40";
                                pillLabel = "Subagent LLM";
                              }
                              pillTitle = "LLM call running inside a spawned subagent (surface = tool/runSubagent). It was dispatched by a runSubagent tool call on the parent thread, not by the model emitting a `runSubagent` request here.";
                            } else {
                              pillBg = theme.cost.chipBgAssistant;
                              pillFg = theme.accent.primary;
                              pillBorder = theme.accent.primary + "40";
                              pillLabel = "LLM call";
                              pillTitle = "Roundtrip to the model. Billed.";
                            }
                          } else if (ev.subagent) {
                            pillBg = theme.cost.chipBgExtension;
                            pillFg = theme.cost.kindExtension;
                            pillBorder = theme.cost.kindExtension + "40";
                            pillLabel = "Subagent";
                            pillTitle = "Tool that spawns its own LLM call internally. Has an estimated cost.";
                          } else {
                            pillBg = theme.cost.chipBgBuiltin;
                            pillFg = theme.cost.kindBuiltin;
                            pillBorder = theme.cost.kindBuiltin + "40";
                            pillLabel = "Tool";
                            pillTitle = "Client-side tool execution. No LLM cost.";
                          }
                          return (
                            <div style={{
                              fontSize: theme.fontSize.xs, fontWeight: 700, padding: "1px 7px", borderRadius: 3,
                              display: "inline-flex", alignItems: "center", justifyContent: "center",
                              color: pillFg, marginTop: 1, background: pillBg,
                              border: "1px solid " + pillBorder,
                              textTransform: "uppercase", letterSpacing: 0.4, height: 18, whiteSpace: "nowrap",
                            }} title={pillTitle}>{pillLabel}</div>
                          );
                        })()}
                        <div>
                          <div style={{ color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 500, lineHeight: 1.4, display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                            {(function () {
                              if (!isLLM) return <span>{ev.name}</span>;
                              var isAgentTurn = AGENT_TURN_NAMES[ev.name];
                              if (!isAgentTurn) {
                                return (
                                  <>
                                    <span title={ev.name}>{friendlyCallName(ev.name)}</span>
                                    {open && ev.name && friendlyCallName(ev.name) !== ev.name && (
                                      <span style={{ color: theme.text.ghost, fontWeight: 400, fontSize: theme.fontSize.xs, fontFamily: theme.font.mono }}>
                                        {ev.name}
                                      </span>
                                    )}
                                  </>
                                );
                              }
                              var snippet = firstVisibleSnippet(ev.responsePreview, 90);
                              var toolSummary = summarizeToolCalls(ev.producedToolCalls);
                              var pos = turnIndexWithinPrompt(p.events, ev);
                              var primary = snippet
                                ? <span title={ev.responsePreview}>{"\u201c" + snippet + "\u201d"}</span>
                                : <span style={{ color: theme.text.muted, fontStyle: "italic", fontWeight: 400 }}
                                        title="The model emitted no visible text this turn; it spent its output tokens on the tool calls listed next.">
                                    (no visible reply)
                                  </span>;
                              return (
                                <>
                                  {primary}
                                  {toolSummary && (
                                    <span style={{ color: theme.text.secondary, fontWeight: 400, fontSize: theme.fontSize.sm, fontFamily: theme.font.mono }}
                                          title={(ev.producedToolCalls || []).map(function (c) { return c.name; }).join(", ")}>
                                      → {toolSummary}
                                    </span>
                                  )}
                                  {pos.total > 1 && (
                                    <span style={{ color: theme.text.muted, fontWeight: 400, fontSize: theme.fontSize.xs }}>
                                      Step {pos.index} of {pos.total}
                                    </span>
                                  )}
                                  {open && (
                                    <span style={{ color: theme.text.ghost, fontWeight: 400, fontSize: theme.fontSize.xs, fontFamily: theme.font.mono }}>
                                      {ev.name}
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                            {open && isLLM && ev.environment && (() => {
                              var env = ev.environment;
                              var wsName = env.workspaceFolders[0] ? env.workspaceFolders[0].split("/").filter(Boolean).pop() : "";
                              var label = "🖥 " + (env.os || "?") + (wsName ? " · " + wsName : "");
                              var tip = (env.os ? "OS: " + env.os + "\n" : "")
                                + (env.workspaceFolders.length > 0
                                  ? "Workspace folder" + (env.workspaceFolders.length === 1 ? ":\n" : "s:\n")
                                    + env.workspaceFolders.map(function (f) { return "  " + f; }).join("\n")
                                  : "");
                              return (
                                <span title={tip} style={{
                                  fontSize: theme.fontSize.xs, fontWeight: 500,
                                  padding: "1px 6px", borderRadius: 3,
                                  background: theme.bg.raised, color: theme.text.secondary,
                                  border: "1px solid " + theme.border.subtle,
                                  fontFamily: theme.font.mono,
                                }}>{label}</span>
                              );
                            })()}
                            {isLLM && ev.chatMode && (() => {
                              var name = ev.chatMode.name;
                              var tip = "Custom chat mode: " + name
                                + "\n~" + fmtT(ev.chatMode.tokensEst) + " tok of mode instructions in system prompt"
                                + (ev.instructionAttachments && ev.instructionAttachments.length > 0
                                  ? "\n+ " + ev.instructionAttachments.length + " workspace instruction file"
                                    + (ev.instructionAttachments.length === 1 ? "" : "s")
                                  : "");
                              return (
                                <span title={tip} style={{
                                  fontSize: theme.fontSize.xs, fontWeight: 500,
                                  padding: "1px 6px", borderRadius: 3,
                                  background: theme.accent.muted,
                                  color: theme.accent.primary,
                                  border: "1px solid " + theme.accent.primary + "55",
                                  fontFamily: theme.font.mono,
                                }}>⚙ {name}</span>
                              );
                            })()}
                            {isLLM && ev.images && ev.images.length > 0 && (() => {
                              var newN = (ev.newImages && ev.newImages.length) || 0;
                              if (newN === 0) return null;
                              var vis = ev.newImageVisionTokens != null
                                ? ev.newImageVisionTokens
                                : (ev.visionTokensTotal || 0);
                              var reusedN = ev.images.length - newN;
                              var label = "🖼 +" + newN;
                              if (vis > 0) label += " (~" + fmtT(vis) + " tok)";
                              var tip = newN + " new image" + (newN === 1 ? "" : "s") + " in this prompt"
                                + (reusedN > 0 ? " · " + reusedN + " more cached from prior call" : "")
                                + (vis > 0 ? "\nEstimated vision input ~" + fmtT(vis) + " tokens (from model + detail field)" : "");
                              return (
                                <span title={tip} style={{
                                  fontSize: theme.fontSize.xs, fontWeight: 500,
                                  padding: "1px 6px", borderRadius: 3,
                                  background: theme.cost.ctxImages + "26",
                                  color: theme.cost.ctxImages,
                                  border: "1px solid " + theme.cost.ctxImages + "55",
                                  fontFamily: theme.font.mono,
                                }}>{label}</span>
                              );
                            })()}
                            {isLLM && ev.category === "overhead" && (
                              <span style={{
                                fontSize: theme.fontSize.xs, fontWeight: 600, letterSpacing: 0.4,
                                textTransform: "uppercase", padding: "1px 6px", borderRadius: 3,
                                background: theme.bg.raised, color: theme.text.muted,
                                border: "1px solid " + theme.border.subtle,
                              }} title="UI/telemetry call, not the user-facing chat turn">overhead</span>
                            )}
                            {ev.subagent
                              ? (ev.subagent.description && <span style={{ color: theme.text.secondary, fontWeight: 400, marginLeft: 4 }}>· {ev.subagent.description}</span>)
                              : !isLLM && (function () {
                                  var smart = smartToolHeadline(ev, workspaceRoot);
                                  return smart
                                    ? <span style={{ color: theme.text.secondary, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%", fontFamily: theme.font.mono }} title={ev.rawArgs || smart}>{smart}</span>
                                    : null;
                                })()}
                            {!isLLM && !ev.subagent && ev.resultTokens > 0 && (
                              <span style={{
                                fontFamily: theme.font.mono, fontSize: theme.fontSize.xs,
                                color: theme.text.muted, marginLeft: "auto",
                                fontVariantNumeric: "tabular-nums",
                                display: "inline-flex", alignItems: "baseline", gap: 4,
                              }} title={"~" + fmtT(ev.resultTokens) + " tok of tool output (" + (ev.resultChars > 0 ? ev.resultChars.toLocaleString() + " chars" : "size unknown") + "). On the next LLM call this is sent as a role:'tool' message and counted under the Tool results bucket (distinct from History, which holds prior user/assistant turns)."}>
                                <span style={{
                                  fontWeight: 500, color: theme.text.primary,
                                  padding: "1px 6px", borderRadius: 3,
                                  background: theme.bg.raised,
                                  border: "1px solid " + theme.border.subtle,
                                }}>{fmtT(ev.resultTokens)} tok</span>
                                <span>→</span>
                                <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 1, background: CTX_COLORS.tool_results, transform: "translateY(-1px)" }} />
                                <span style={{ color: theme.text.secondary }}>Tool results</span>
                              </span>
                            )}
                          </div>
                          {isLLM && isFirstLlmInPrompt && p.invokedBy && (() => {
                            var parentPi = p.invokedBy.parentPromptIndex;
                            var parentTcId = p.invokedBy.parentToolCallId;
                            var parentPrompt = analysis.prompts[parentPi];
                            var parentEi = -1;
                            if (parentPrompt) {
                              for (var ji = 0; ji < parentPrompt.events.length; ji++) {
                                if (parentPrompt.events[ji].id === parentTcId) { parentEi = ji; break; }
                              }
                            }
                            var desc = p.invokedBy.description || "runSubagent";
                            return (
                              <div style={{ color: theme.text.muted, fontSize: theme.fontSize.xs, marginTop: 4, display: "flex", gap: 6, alignItems: "baseline" }}
                                title="This subagent was spawned by a runSubagent tool call on the parent thread. Click to jump to the parent call.">
                                <span style={{ color: theme.text.ghost }}>← invoked by</span>
                                {parentEi >= 0 ? (
                                  <button type="button" onClick={function (e) {
                                    e.stopPropagation();
                                    var el = document.getElementById("cost-row-" + parentPi + "-" + parentEi);
                                    if (el) {
                                      el.scrollIntoView({ behavior: "smooth", block: "center" });
                                      var prev = el.style.boxShadow;
                                      el.style.boxShadow = "inset 0 0 0 2px " + theme.cost.kindExtension;
                                      setTimeout(function () { el.style.boxShadow = prev; }, 1500);
                                    }
                                  }} style={{
                                    background: "transparent", border: "none", padding: 0,
                                    color: theme.cost.kindExtension, cursor: "pointer",
                                    fontFamily: theme.font.mono, fontSize: theme.fontSize.xs,
                                    textDecoration: "underline",
                                  }}>prompt {parentPi + 1} · runSubagent ({desc})</button>
                                ) : (
                                  <span style={{ fontFamily: theme.font.mono }}>prompt {parentPi + 1} · runSubagent ({desc})</span>
                                )}
                              </div>
                            );
                          })()}
                          {meta}
                        </div>
                      </div>
                    </div>
                    <div style={{ padding: "8px 12px", borderBottom: "1px solid " + theme.border.subtle, background: cellBg, borderLeft: "1px solid " + theme.border.default, display: "flex", alignItems: "center" }}>
                      <StackBar parts={cumState} keys={["fresh", "cwrite", "cached", "output"]} colors={COST_COLORS} labels={COST_LABELS} maxVal={maxCost} formatFn={fmt$} withLabel />
                    </div>
                    <div style={{ padding: "8px 12px", borderBottom: "1px solid " + theme.border.subtle, background: cellBg, borderLeft: "1px solid " + theme.border.default, display: "flex", alignItems: "center" }}>
                      {isLLM
                        ? (function () {
                            var vis = ev.visionTokensTotal || 0;
                            var newImgInCur = ev.imageTokensEst || 0;
                            var parts = Object.assign({}, ev.components, {
                              current: Math.max(0, (ev.components.current || 0) - newImgInCur),
                              images: vis,
                            });
                            return <StackBar parts={parts} keys={CTX_KEYS} colors={CTX_COLORS} labels={CTX_LABELS} maxVal={maxCtx} withLabel />;
                          })()
                        : <span style={{ color: theme.text.ghost, fontSize: theme.fontSize.xs, fontStyle: "italic" }}>→ result lands in next LLM call</span>}
                    </div>
                    {open && (isLLM ? <LLMDetail event={ev} /> : <ToolDetail event={ev} workspaceRoot={workspaceRoot} />)}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          );
          });
        })()}
      </div>
    </div>
    </div>
  );
}

function colHeadStyle() {
  return {
    background: theme.bg.raised,
    padding: "13px 16px",
    fontSize: theme.fontSize.base,
    color: theme.text.primary,
    letterSpacing: 0.2,
    borderBottom: "1px solid " + theme.border.default,
    fontWeight: 700,
  };
}

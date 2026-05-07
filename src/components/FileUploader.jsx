import { useState, useRef } from "react";
import { theme, alpha } from "../lib/theme.js";
import Icon from "./Icon.jsx";

export default function FileUploader({ onLoad, debugLabel }) {
  var ref = useRef(null);
  var [over, setOver] = useState(false);

  var [readError, setReadError] = useState(null);

  var label = debugLabel || "uploader";

  function handleFile(file) {
    if (!file) {
      console.warn("[agentviz][" + label + "] handleFile called with no file (empty drop or canceled picker)");
      return;
    }
    console.log("[agentviz][" + label + "] file received", {
      name: file.name,
      size: file.size,
      sizeMB: (file.size / 1048576).toFixed(2),
      type: file.type || "(empty)",
      lastModified: new Date(file.lastModified).toISOString(),
    });
    if (file.size === 0) {
      setReadError("File is empty (0 bytes): " + file.name);
      console.error("[agentviz][" + label + "] empty file rejected");
      return;
    }
    setReadError(null);
    var reader = new FileReader();
    var t0 = performance.now();
    reader.onload = function (e) {
      var t1 = performance.now();
      var text = e.target.result;
      console.log("[agentviz][" + label + "] file read complete", {
        chars: text ? text.length : 0,
        readMs: Math.round(t1 - t0),
        first200: text ? text.slice(0, 200) : "(empty)",
      });
      onLoad(text, file.name);
    };
    reader.onerror = function (err) {
      console.error("[agentviz][" + label + "] FileReader error", reader.error, err);
      setReadError("Could not read file: " + file.name + " (" + (reader.error && reader.error.name) + ")");
    };
    reader.onabort = function () {
      console.warn("[agentviz][" + label + "] FileReader aborted");
      setReadError("File read was aborted: " + file.name);
    };
    reader.readAsText(file);
  }

  return (
    <div
      onDragOver={function (e) { e.preventDefault(); setOver(true); }}
      onDragLeave={function () { setOver(false); }}
      onDrop={function (e) {
        e.preventDefault();
        setOver(false);
        var dt = e.dataTransfer;
        var files = dt && dt.files ? dt.files : null;
        var items = dt && dt.items ? dt.items : null;
        console.log("[agentviz][" + label + "] drop event", {
          fileCount: files ? files.length : 0,
          itemCount: items ? items.length : 0,
          types: dt && dt.types ? Array.from(dt.types) : [],
          itemKinds: items ? Array.from(items).map(function (it) { return { kind: it.kind, type: it.type }; }) : [],
        });
        if (!files || files.length === 0) {
          setReadError("Drop did not contain a file. (Some sources, like Outlook attachments or browser tabs, deliver a URL instead. Try saving the file to disk first.)");
          return;
        }
        handleFile(files[0]);
      }}
      onClick={function () { ref.current && ref.current.click(); }}
      style={{
        border: "2px dashed " + (over ? theme.accent.primary : theme.border.strong),
        borderRadius: theme.radius.xxl, padding: "48px 32px", textAlign: "center",
        cursor: "pointer", background: over ? alpha(theme.accent.primary, 0.03) : theme.bg.surface,
        transition: "background " + theme.transition.smooth + ", border-color " + theme.transition.smooth, maxWidth: 560, margin: "0 auto",
      }}
    >
      <input
        ref={ref} type="file" accept=".jsonl,.json,.txt"
        style={{ display: "none" }}
        onChange={function (e) {
          var f = e.target.files && e.target.files[0];
          console.log("[agentviz][" + label + "] file picker selection", f ? { name: f.name, size: f.size } : "(none)");
          handleFile(f);
        }}
      />
      <div style={{
        fontSize: theme.fontSize.hero, marginBottom: 12, color: theme.accent.primary,
        transition: "transform " + theme.transition.smooth,
        transform: over ? "scale(1.1)" : "scale(1)",
      }}><Icon name="upload" size={32} /></div>
      <div style={{ fontSize: theme.fontSize.xl, color: theme.text.primary, marginBottom: 8, fontWeight: 600 }}>
        Drop a session file here
      </div>
      <div style={{ fontSize: theme.fontSize.md, color: theme.text.muted, lineHeight: 1.8 }}>
        Claude Code, VS Code, and Copilot CLI sessions
        <br />
        <span style={{ color: theme.text.dim, fontSize: theme.fontSize.base }}>
          Also accepts .json and .txt
        </span>
      </div>
      {readError && (
        <div style={{ marginTop: 12, fontSize: theme.fontSize.base, color: theme.semantic.error, lineHeight: 1.5 }}>
          {readError}
        </div>
      )}
    </div>
  );
}

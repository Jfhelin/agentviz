import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi } from "vitest";
import { createServer } from "../../server.js";

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", function () {
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}

describe("server live JSONL streaming", function () {
  it("streams an initialized partial line once after it is completed", async function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-server-"));
    var sessionPath = path.join(tempDir, "session.jsonl");
    var partialLine = '{"type":"assistant","message":{"content":"part';
    fs.writeFileSync(
      sessionPath,
      '{"type":"user","message":{"content":"already loaded"}}\n' + partialLine,
      "utf8"
    );

    var server = createServer({ sessionFile: sessionPath, distDir: tempDir });

    try {
      var port = await listen(server);

      var payload = await new Promise(function (resolve, reject) {
        var request = null;
        var settled = false;
        var appended = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          if (request) request.destroy();
          reject(new Error("Timed out waiting for streamed JSONL update"));
        }, 3000);

        request = http.get({ hostname: "127.0.0.1", port: port, path: "/api/stream" }, function (res) {
          res.setEncoding("utf8");
          var body = "";

          res.on("data", function (chunk) {
            body += chunk;

            if (!appended && body.indexOf("retry: 3000") !== -1) {
              appended = true;
              fs.appendFileSync(sessionPath, 'ial"}}\n', "utf8");
            }

            var match = body.match(/data: (.+)\n\n/);
            if (!match || settled) return;

            settled = true;
            clearTimeout(timer);
            request.destroy();
            resolve(JSON.parse(match[1]));
          });
        });

        request.on("error", function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      });

      expect(payload.lines).toBe('{"type":"assistant","message":{"content":"partial"}}');
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes stream state without reading the whole session file", async function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-server-"));
    var sessionPath = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(
      sessionPath,
      '{"type":"user","message":{"content":"' + "x".repeat(128 * 1024) + '"}}\n'
      + '{"type":"assistant","message":{"content":"part',
      "utf8"
    );

    var originalReadFileSync = fs.readFileSync;
    var sessionReadCount = 0;
    var readFileSpy = vi.spyOn(fs, "readFileSync").mockImplementation(function () {
      if (arguments[0] === sessionPath) sessionReadCount += 1;
      return originalReadFileSync.apply(fs, arguments);
    });

    var server = null;
    try {
      server = createServer({ sessionFile: sessionPath, distDir: tempDir });
      await listen(server);
      expect(sessionReadCount).toBe(0);
    } finally {
      readFileSpy.mockRestore();
      if (server) await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

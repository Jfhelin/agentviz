import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi } from "vitest";
import { createServer, getCompleteJsonlLines, getJsonlStreamChunk } from "../../server.js";

function listen(server) {
  return new Promise(function (resolve, reject) {
    function onError(err) {
      server.off("error", onError);
      reject(err);
    }

    server.once("error", onError);
    server.listen(0, "127.0.0.1", function () {
      server.off("error", onError);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}

function waitForStreamPayload(port, onConnected) {
  return new Promise(function (resolve, reject) {
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
          onConnected();
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
}

describe("server live JSONL streaming", function () {
  it("ignores a trailing partial Claude record until it is newline-terminated", function () {
    var firstChunk = getJsonlStreamChunk(
      '{"type":"user","message":{"content":"hello"}}\n'
      + '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}}',
      0
    );

    expect(firstChunk.lines).toEqual([
      '{"type":"user","message":{"content":"hello"}}',
    ]);
    expect(firstChunk.nextLineIdx).toBe(1);

    var secondChunk = getJsonlStreamChunk(
      '{"type":"user","message":{"content":"hello"}}\n'
      + '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n',
      firstChunk.nextLineIdx
    );

    expect(secondChunk.lines).toEqual([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);
    expect(secondChunk.nextLineIdx).toBe(2);
  });

  it("counts only complete newline-terminated records during initialization", function () {
    var lines = getCompleteJsonlLines(
      '{"type":"user","message":{"content":"hello"}}\n'
      + '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}}'
    );

    expect(lines).toEqual([
      '{"type":"user","message":{"content":"hello"}}',
    ]);
  });

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
      var payload = await waitForStreamPayload(port, function () {
        fs.appendFileSync(sessionPath, 'ial"}}\n', "utf8");
      });

      expect(payload.lines).toBe('{"type":"assistant","message":{"content":"partial"}}');
    } finally {
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves an initialized partial UTF-8 sequence when new bytes complete it", async function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-server-"));
    var sessionPath = path.join(tempDir, "session.jsonl");
    var prefix = Buffer.from('{"type":"assistant","message":{"content":"caf', "utf8");
    fs.writeFileSync(sessionPath, Buffer.concat([prefix, Buffer.from([0xc3])]));

    var server = createServer({ sessionFile: sessionPath, distDir: tempDir });

    try {
      var port = await listen(server);
      var payload = await waitForStreamPayload(port, function () {
        fs.appendFileSync(sessionPath, Buffer.from([0xa9, 0x22, 0x7d, 0x7d, 0x0a]));
      });

      expect(payload.lines).toBe('{"type":"assistant","message":{"content":"café"}}');
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

  it("reads large appended deltas in bounded chunks", async function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-server-"));
    var sessionPath = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(sessionPath, '{"type":"user","message":{"content":"already loaded"}}\n', "utf8");

    var watchedFds = new Set();
    var readLengths = [];
    var originalOpenSync = fs.openSync;
    var originalReadSync = fs.readSync;
    var openSpy = vi.spyOn(fs, "openSync").mockImplementation(function () {
      var fd = originalOpenSync.apply(fs, arguments);
      if (arguments[0] === sessionPath) watchedFds.add(fd);
      return fd;
    });
    var readSpy = vi.spyOn(fs, "readSync").mockImplementation(function () {
      if (watchedFds.has(arguments[0])) readLengths.push(arguments[3]);
      return originalReadSync.apply(fs, arguments);
    });

    var server = createServer({ sessionFile: sessionPath, distDir: tempDir });

    try {
      var port = await listen(server);
      readLengths = [];
      var largeLine = '{"type":"assistant","message":{"content":"' + "x".repeat(128 * 1024) + '"}}';
      var payload = await waitForStreamPayload(port, function () {
        fs.appendFileSync(sessionPath, largeLine + "\n", "utf8");
      });

      expect(payload.lines).toBe(largeLine);
      expect(Math.max.apply(Math, readLengths)).toBeLessThanOrEqual(64 * 1024);
      expect(readLengths.length).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
      openSpy.mockRestore();
      await closeServer(server);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

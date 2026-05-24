// IndexedDB-backed store for raw session content.
// localStorage caps each origin at ~5-10 MB which is well below the size of
// real Copilot Chat exports (often 10-50 MB). IndexedDB quota is typically
// hundreds of MB to several GB, so large exports fit and older sessions are
// not evicted.

var DB_NAME = "agentviz";
var DB_VERSION = 1;
var STORE_NAME = "session-content";

var DEV = typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV;

function debugWarn(message, detail) {
  if (DEV) console.warn(message, detail); // eslint-disable-line no-console
}

function getIDB() {
  if (typeof window === "undefined") return null;
  return window.indexedDB || null;
}

var dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  var idb = getIDB();
  if (!idb) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise(function (resolve) {
    var req;
    try { req = idb.open(DB_NAME, DB_VERSION); }
    catch (error) { debugWarn("Could not open IndexedDB", error); resolve(null); return; }

    req.onupgradeneeded = function () {
      try {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      } catch (error) {
        debugWarn("Could not create object store", error);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { debugWarn("IndexedDB open failed", req.error); resolve(null); };
    req.onblocked = function () { debugWarn("IndexedDB open blocked", null); };
  });
  return dbPromise;
}

export function isContentStoreAvailable() {
  return Boolean(getIDB());
}

function tx(db, mode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function promisifyRequest(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

export function getContent(id) {
  if (!id) return Promise.resolve(null);
  return openDB().then(function (db) {
    if (!db) return null;
    try { return promisifyRequest(tx(db, "readonly").get(id)); }
    catch (error) { debugWarn("Could not read content", error); return null; }
  }).then(function (value) {
    if (value == null) return null;
    return typeof value === "string" ? value : String(value);
  }).catch(function (error) {
    debugWarn("getContent failed", error);
    return null;
  });
}

export function putContent(id, rawText) {
  if (!id) return Promise.resolve(false);
  return openDB().then(function (db) {
    if (!db) return false;
    try { return promisifyRequest(tx(db, "readwrite").put(rawText, id)).then(function () { return true; }); }
    catch (error) { debugWarn("Could not write content", error); return false; }
  }).catch(function (error) {
    debugWarn("putContent failed", error);
    return false;
  });
}

export function deleteContent(id) {
  if (!id) return Promise.resolve();
  return openDB().then(function (db) {
    if (!db) return;
    try { return promisifyRequest(tx(db, "readwrite").delete(id)); }
    catch (error) { debugWarn("Could not delete content", error); }
  }).catch(function (error) { debugWarn("deleteContent failed", error); });
}

export function listIds() {
  return openDB().then(function (db) {
    if (!db) return [];
    try { return promisifyRequest(tx(db, "readonly").getAllKeys()); }
    catch (error) { debugWarn("Could not list ids", error); return []; }
  }).then(function (keys) {
    if (!Array.isArray(keys)) return [];
    return keys.map(function (k) { return String(k); });
  }).catch(function (error) {
    debugWarn("listIds failed", error);
    return [];
  });
}

export function resetForTests() {
  dbPromise = null;
}

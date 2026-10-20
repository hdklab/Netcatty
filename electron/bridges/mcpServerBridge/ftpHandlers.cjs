"use strict";

const path = require("node:path");

const ftpBridge = require("../ftpBridge.cjs");

/**
 * Accept the shapes an agent realistically sends for a file list: a JSON array,
 * a comma/newline separated string, or an array of objects.
 */
function normalizeFtpFiles(input) {
  let raw = input;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) raw = parsed;
      } catch {
        raw = trimmed;
      }
    } else {
      raw = trimmed.split(/[\n,]/);
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        const localPath = entry.trim();
        return localPath ? { localPath, remoteName: path.basename(localPath) } : null;
      }
      if (entry && typeof entry === "object") {
        const localPath = String(entry.path || entry.localPath || "").trim();
        if (!localPath) return null;
        return { localPath, remoteName: String(entry.remoteName || path.basename(localPath)) };
      }
      return null;
    })
    .filter(Boolean);
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  return String(value ?? "").trim().toLowerCase() === "true";
}

function asPort(value) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

function createFtpHandlerApi() {
  /** Handler: upload local files over FTP/FTPS (built-in client). */
  async function handleFtpUpload(params = {}) {
    const host = String(params.host ?? "").trim();
    if (!host) return { ok: false, code: "invalid-request", error: "host is required" };
    const files = normalizeFtpFiles(params.files);
    if (files.length === 0) {
      return { ok: false, code: "invalid-request", error: "files must list at least one local path" };
    }
    return ftpBridge.uploadFiles({
      host,
      port: asPort(params.port),
      user: typeof params.user === "string" && params.user.trim() ? params.user.trim() : undefined,
      password: typeof params.password === "string" ? params.password : undefined,
      secure: asBool(params.secure),
      insecure: asBool(params.insecure),
      remoteDir: typeof params.remoteDir === "string" ? params.remoteDir : undefined,
      timeoutMs: asPort(params.timeoutMs) ? Number(params.timeoutMs) : undefined,
      files,
    });
  }

  return { handleFtpUpload, normalizeFtpFiles };
}

module.exports = { createFtpHandlerApi, normalizeFtpFiles };

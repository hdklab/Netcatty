'use strict';

/**
 * Scripted stand-in for basic-ftp's Client, backed by an in-memory tree.
 *
 * Both FTP suites drive the real backend/bridge code against this double, so
 * they assert the operation sequence the backend performs (which path it opens,
 * when it restores the cwd, how progress is forwarded) without a network or a
 * live FTP server. It mimics the library's shapes: FileInfo objects, `closed`,
 * `trackProgress`, and downloads that end the stream they were handed.
 *
 * Not a `*.test.cjs` file on purpose: the runner's globs would treat it as a
 * suite with no tests.
 */

const fs = require('node:fs');
const path = require('node:path');

function ftpError(code, message) {
  const error = new Error(message || `reply ${code}`);
  error.code = code;
  return error;
}

class FakeFtpClient {
  constructor(tree = {}, options = {}) {
    this.tree = { '/': { type: 'dir' }, ...tree };
    this.cwd = '/';
    this.closed = false;
    this.calls = [];
    this.options = null;
    this.progress = null;
    this.accessError = options.accessError || null;
    this.ftp = { log: () => {} };
  }

  async access(options) {
    this.options = options;
    if (this.accessError) throw this.accessError;
    this.calls.push(['access', options.host]);
  }

  close() {
    this.closed = true;
    this.calls.push(['close']);
  }

  trackProgress(handler) {
    this.progress = handler || null;
    this.calls.push(['trackProgress', Boolean(handler)]);
  }

  resolve(target) {
    if (!target) return this.cwd;
    const joined = target.startsWith('/') ? target : `${this.cwd.replace(/\/$/, '')}/${target}`;
    return path.posix.normalize(joined) || '/';
  }

  async pwd() {
    this.calls.push(['pwd']);
    return this.cwd;
  }

  async cd(target) {
    const resolved = this.resolve(target);
    const entry = this.tree[resolved];
    if (!entry || entry.type !== 'dir') throw ftpError(550, 'No such directory');
    this.cwd = resolved;
    this.calls.push(['cd', resolved]);
  }

  async list(target) {
    const dir = this.resolve(target);
    const entry = this.tree[dir];
    if (!entry) throw ftpError(550, 'No such directory');
    this.calls.push(['list', dir]);
    if (entry.type !== 'dir') return [this.info(dir, entry)];
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return Object.entries(this.tree)
      .filter(([key]) => key !== dir && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map(([key, value]) => this.info(key, value));
  }

  info(absolutePath, entry) {
    const name = absolutePath === '/' ? '/' : absolutePath.split('/').pop();
    const isDirectory = entry.type === 'dir';
    return {
      name,
      isDirectory,
      isFile: !isDirectory,
      isSymbolicLink: false,
      size: isDirectory ? 0 : (entry.data ? entry.data.length : 0),
      modifiedAt: new Date('2024-05-01T10:00:00Z'),
      permissions: entry.permissions,
      user: 'root',
      group: 'root',
    };
  }

  async ensureDir(target) {
    const resolved = this.resolve(target);
    let current = '';
    for (const segment of resolved.split('/').filter(Boolean)) {
      current += `/${segment}`;
      this.calls.push(['mkdir', current]);
      if (!this.tree[current]) this.tree[current] = { type: 'dir' };
      else if (this.tree[current].type !== 'dir') throw ftpError(550, 'File exists');
    }
    this.cwd = resolved;
  }

  async send(command) {
    const match = /^MKD (.+)$/.exec(command);
    if (!match) throw ftpError(500, `unsupported command ${command}`);
    const resolved = this.resolve(match[1]);
    this.calls.push(['mkdir', resolved]);
    if (this.tree[resolved]) throw ftpError(550, 'File exists');
    this.tree[resolved] = { type: 'dir' };
    return { code: 257 };
  }

  async removeEmptyDir(target) {
    const resolved = this.resolve(target);
    this.calls.push(['removeEmptyDir', resolved]);
    const children = Object.keys(this.tree).filter((key) => key.startsWith(`${resolved}/`));
    if (children.length > 0) throw ftpError(550, 'Directory not empty');
    delete this.tree[resolved];
  }

  async removeDir(target) {
    const resolved = this.resolve(target);
    this.calls.push(['removeDir', resolved]);
    for (const key of Object.keys(this.tree)) {
      if (key === resolved || key.startsWith(`${resolved}/`)) delete this.tree[key];
    }
  }

  async remove(target) {
    const resolved = this.resolve(target);
    this.calls.push(['remove', resolved]);
    if (!this.tree[resolved]) throw ftpError(550, 'No such file');
    delete this.tree[resolved];
  }

  async rename(from, to) {
    const source = this.resolve(from);
    const dest = this.resolve(to);
    this.calls.push(['rename', source, dest]);
    if (!this.tree[source]) throw ftpError(550, 'No such file');
    this.tree[dest] = this.tree[source];
    delete this.tree[source];
  }

  async uploadFrom(source, remotePath) {
    const resolved = this.resolve(remotePath);
    let data;
    if (typeof source === 'string') {
      data = fs.readFileSync(source);
    } else {
      data = Buffer.concat(await new Promise((resolve, reject) => {
        const chunks = [];
        source.on('data', (chunk) => chunks.push(chunk));
        source.on('end', () => resolve(chunks));
        source.on('error', reject);
      }));
    }
    this.calls.push(['upload', resolved, data.toString()]);
    this.tree[resolved] = { type: 'file', data };
    this.progress?.({ type: 'upload', name: resolved, bytes: data.length, bytesOverall: data.length });
  }

  async downloadTo(destination, remotePath) {
    const resolved = this.resolve(remotePath);
    const entry = this.tree[resolved];
    this.calls.push(['download', resolved]);
    if (!entry || entry.type !== 'file') throw ftpError(550, 'No such file');
    const data = entry.data || Buffer.alloc(0);
    if (typeof destination === 'string') {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, data);
      return;
    }
    destination.write(data);
    this.progress?.({ type: 'download', name: resolved, bytes: data.length, bytesOverall: data.length });
    await new Promise((resolve) => destination.end(resolve));
  }
}

/** A client factory that records every client the backend creates. */
function makeFakeClientFactory(tree, options = {}) {
  const clients = [];
  const factory = () => {
    const client = new FakeFtpClient(tree, options);
    clients.push(client);
    return client;
  };
  return { factory, clients };
}

module.exports = { FakeFtpClient, makeFakeClientFactory, ftpError };

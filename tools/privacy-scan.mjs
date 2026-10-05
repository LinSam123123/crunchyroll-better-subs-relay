import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { unzipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const topFiles = new Set(['README.md', 'README.en.md', 'README.ja.md', 'README.ko.md', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE',
  'NOTICE.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json', 'upstream-files.json']);
const skipped = new Set(['.git', 'node_modules', 'artifacts']);
const patterns = [
  ['relay-key', /sk-[A-Za-z0-9_-]{24,}/],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['personal-path', /[A-Za-z]:[\\/](?:Users[\\/]|edge下载内容)/i],
  ['private-test-host', /(?:api\.sam123123\.dpdns\.org|sam123123\.dpdns)/i],
  ['signed-url', /https?:[^\s"'<>]+[?&](?:token|access_token|api_key|signature|X-Amz-Signature)=[A-Za-z0-9_%.-]{16,}/i],
];
export function allowed(filename) {
  return topFiles.has(filename) || /^(?:extension\/|tests\/[\w.-]+\.mjs$|tools\/[\w.-]+\.mjs$|\.github\/(?:workflows\/ci\.yml|ISSUE_TEMPLATE\/bug_report\.yml)$)/.test(filename)
    && !/(?:^|\/)(?:\.git|node_modules|artifacts|reports|_metadata)(?:\/|$)/.test(filename)
    && !/\.(?:csv|ass|srt|ssa|vtt|log|zip|tgz|pem|key)$/i.test(filename);
}
export function inspect(bytes, knownSecrets = []) {
  const findings = [];
  if (knownSecrets.some(secret => secret.length && bytes.includes(secret))) findings.push('known-secret');
  const text = bytes.toString('utf8');
  for (const [kind, expression] of patterns) if (expression.test(text)) findings.push(kind);
  return findings;
}
export async function scan(secretFiles = []) {
  const secrets = [];
  for (const filename of secretFiles) {
    const value = (await readFile(filename, 'utf8')).trim();
    if (!value || value.length > 4096 || /\s/.test(value)) throw new Error('INVALID_SECRET_FILE');
    secrets.push(Buffer.from(value));
  }
  const findings = [], files = [];
  const check = (filename, bytes, scope) => {
    if (!allowed(filename)) findings.push({ scope, path: filename, category: 'unexpected-path' });
    for (const category of inspect(bytes, secrets)) findings.push({ scope, path: filename, category });
  };
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && skipped.has(entry.name)) continue;
      const name = prefix + entry.name, absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, name + '/');
      else if (entry.isFile()) {
        if (!prefix && /^crunchyroll-better-subs-relay-[\d.]+-beta\.zip$/.test(name)) {
          for (const [file, bytes] of Object.entries(unzipSync(await readFile(absolute)))) check('extension/' + file, Buffer.from(bytes), 'archive');
        } else { files.push(name); check(name, await readFile(absolute), 'worktree'); }
      } else findings.push({ scope: 'worktree', path: name, category: 'non-regular-entry' });
    }
  }
  await visit(root);
  let historyBlobs = 0;
  // Never walk the parent/private repository when this is only an exported directory.
  let ownGit = false;
  try { ownGit = path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()).toLowerCase() === path.resolve(root).toLowerCase(); } catch {}
  if (ownGit) {
    const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: root, encoding: 'utf8' }).split('\n');
    for (const line of objects) {
      const separator = line.indexOf(' ');
      if (separator < 0) continue;
      const sha = line.slice(0, separator), name = line.slice(separator + 1);
      if (execFileSync('git', ['cat-file', '-t', sha], { cwd: root, encoding: 'utf8' }).trim() !== 'blob') continue;
      check(name, execFileSync('git', ['cat-file', 'blob', sha], { cwd: root, maxBuffer: 20000000 }), 'history');
      historyBlobs++;
    }
    const commits = execFileSync('git', ['log', '--all', '--format=%B%n%an <%ae>'], { cwd: root, encoding: 'utf8' });
    for (const category of inspect(Buffer.from(commits), secrets)) findings.push({ scope: 'history', path: '(commit metadata)', category });
  }
  console.log(JSON.stringify({ files: files.length, historyBlobs, knownSecretFiles: secrets.length, findings }, null, 2));
  if (findings.length) throw new Error('PRIVACY_SCAN_FAILED');
  return { files: files.length, historyBlobs };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await scan(process.argv.slice(2));

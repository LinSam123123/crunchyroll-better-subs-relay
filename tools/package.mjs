import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version.replace(/\.([^.]+)$/, '-relay.$1')) throw new Error('VERSION_MISMATCH');
const secrets = [];
for (const filename of process.argv.slice(2)) {
  const secret = (await readFile(filename, 'utf8')).trim();
  if (!secret || secret.length > 4096 || /\s/.test(secret)) throw new Error('INVALID_SCAN_SECRET_FILE');
  secrets.push(Buffer.from(secret));
}
const entries = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name, absolute = path.join(directory, entry.name);
    if (/(?:^|\/)(?:_metadata|node_modules|artifacts|\.git)(?:\/|$)/.test(name)) throw new Error('UNEXPECTED_PACKAGE_PATH');
    if (entry.isDirectory()) await collect(absolute, name + '/');
    else if (entry.isFile()) {
      const bytes = await readFile(absolute);
      if (secrets.some(secret => bytes.includes(secret)) || /sk-[A-Za-z0-9_-]{24,}/.test(bytes.toString('utf8')))
        throw new Error('PACKAGE_CREDENTIAL_MATCH');
      entries[name] = new Uint8Array(bytes);
    } else throw new Error('UNEXPECTED_PACKAGE_ENTRY');
  }
}
await collect(path.join(root, 'extension'));
const name = `crunchyroll-better-subs-relay-${manifest.version}-beta.zip`;
await writeFile(path.join(root, name), zipSync(entries, { level: 6 }));
const saved = await readFile(path.join(root, name));
// Unpack only the archive just created from validated local extension files.
const unpacked = unzipSync(saved);
if (Object.keys(unpacked).length !== Object.keys(entries).length) throw new Error('PACKAGE_COUNT_MISMATCH');
for (const [filename, bytes] of Object.entries(entries))
  if (!unpacked[filename] || !Buffer.from(bytes).equals(Buffer.from(unpacked[filename]))) throw new Error('PACKAGE_CONTENT_MISMATCH');
const report = { version: manifest.version, archive: name, files: Object.keys(entries).length, bytes: saved.length,
  sha256: createHash('sha256').update(saved).digest('hex'), byteEqual: true,
  scannedLocalKeys: secrets.length, credentialMatches: 0, relayKeyPatternMatches: 0 };
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(root, 'artifacts/package-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

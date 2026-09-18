#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));

export const MANIFEST_NAME = '.badminton-kb-sync.json';
export const DEFAULT_POLICY = Object.freeze({
  sourceRoot: join(repositoryRoot, 'docs', 'knowledge-base'),
  vaultRoot: '/Users/a10954/Documents/Documents - Sunsetz的MacBook Pro/Obsidian Vault',
  targetRoot:
    '/Users/a10954/Documents/Documents - Sunsetz的MacBook Pro/Obsidian Vault/羽毛球赛事管理系统',
  backupRoot: join(repositoryRoot, '.local', 'kb-sync-backups'),
  sourceId: 'badminton-tournament-knowledge-base',
});

export class PolicyError extends Error {}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    value !== '..' &&
    !value.startsWith(`..${sep}`) &&
    !value.split(sep).includes('..')
  );
}

async function exists(pathname) {
  try {
    await access(pathname, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(pathname, allowMissingTail = false) {
  const absolute = resolve(pathname);
  const parsedRoot = absolute.slice(0, absolute.indexOf(sep, 1) === -1 ? absolute.length : 1);
  const parts = absolute.slice(parsedRoot.length).split(sep).filter(Boolean);
  let current = parsedRoot || sep;
  let missing = false;

  for (const part of parts) {
    current = join(current, part);
    if (missing) continue;
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new PolicyError(`拒绝符号链接路径：${current}`);
      }
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      if (error?.code === 'ENOENT' && allowMissingTail) {
        missing = true;
        continue;
      }
      throw error;
    }
  }
}

async function validatePolicy(policy) {
  const sourceRoot = resolve(policy.sourceRoot);
  const vaultRoot = resolve(policy.vaultRoot);
  const targetRoot = resolve(policy.targetRoot);
  const expectedTarget = join(vaultRoot, '羽毛球赛事管理系统');

  if (targetRoot !== expectedTarget || dirname(targetRoot) !== vaultRoot) {
    throw new PolicyError(`目标路径不在唯一允许目录：${targetRoot}`);
  }

  await assertNoSymlinkComponents(sourceRoot);
  await assertNoSymlinkComponents(vaultRoot);
  await assertNoSymlinkComponents(targetRoot, true);

  const sourceMetadata = await stat(sourceRoot);
  const vaultMetadata = await stat(vaultRoot);
  if (!sourceMetadata.isDirectory()) throw new PolicyError(`知识库源不是目录：${sourceRoot}`);
  if (!vaultMetadata.isDirectory()) throw new PolicyError(`Vault 不是目录：${vaultRoot}`);

  const canonicalVault = await realpath(vaultRoot);
  if (canonicalVault !== vaultRoot) {
    throw new PolicyError(`Vault 真实路径与允许路径不一致：${canonicalVault}`);
  }

  if (await exists(targetRoot)) {
    const canonicalTarget = await realpath(targetRoot);
    if (canonicalTarget !== targetRoot) {
      throw new PolicyError(`目标真实路径与允许路径不一致：${canonicalTarget}`);
    }
  }

  return { ...policy, sourceRoot, vaultRoot, targetRoot, backupRoot: resolve(policy.backupRoot) };
}

async function collectMarkdownFiles(root, { target = false } = {}) {
  const files = new Map();

  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

    for (const entry of entries) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new PolicyError(`拒绝知识库中的符号链接：${absolutePath}`);
      }
      if (entry.name.startsWith('.')) {
        if (target && entry.name === MANIFEST_NAME && prefix === '') continue;
        throw new PolicyError(`拒绝知识库中的隐藏条目：${absolutePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new PolicyError(`拒绝非普通文件：${absolutePath}`);
      if (extname(entry.name).toLowerCase() !== '.md') {
        throw new PolicyError(`阶段 0 只允许同步 Markdown：${absolutePath}`);
      }
      if (!safeRelativePath(relativePath)) {
        throw new PolicyError(`拒绝不安全相对路径：${relativePath}`);
      }

      const content = await readFile(absolutePath);
      files.set(relativePath, {
        path: relativePath,
        absolutePath,
        size: content.byteLength,
        sha256: sha256(content),
      });
    }
  }

  await visit(root);
  return files;
}

function validateManifestFileEntry(pathname, entry) {
  return (
    safeRelativePath(pathname) &&
    extname(pathname).toLowerCase() === '.md' &&
    entry &&
    Number.isInteger(entry.size) &&
    entry.size >= 0 &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256)
  );
}

async function loadManifest(policy) {
  const manifestPath = join(policy.targetRoot, MANIFEST_NAME);
  if (!(await exists(manifestPath))) return null;

  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PolicyError(`同步清单不是普通文件：${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new PolicyError(`同步清单无法解析：${error.message}`);
  }

  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.sourceId !== policy.sourceId ||
    manifest?.targetRoot !== policy.targetRoot ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    throw new PolicyError('同步清单身份或结构异常，拒绝覆盖目标。');
  }

  for (const [pathname, entry] of Object.entries(manifest.files)) {
    if (!validateManifestFileEntry(pathname, entry)) {
      throw new PolicyError(`同步清单包含不安全条目：${pathname}`);
    }
  }
  return manifest;
}

function createPlan(sourceFiles, targetFiles, manifest) {
  const actions = [];
  const conflicts = [];
  const managed = manifest?.files ?? {};

  for (const [pathname, source] of sourceFiles) {
    const target = targetFiles.get(pathname);
    const previous = managed[pathname];

    if (!previous) {
      if (target) conflicts.push({ type: 'CONFLICT', path: pathname, reason: '目标存在未知同名文件' });
      else actions.push({ type: 'CREATE', path: pathname, source });
      continue;
    }

    if (!target) {
      conflicts.push({ type: 'CONFLICT', path: pathname, reason: '已管理目标文件被删除' });
      continue;
    }
    if (target.sha256 !== previous.sha256 || target.size !== previous.size) {
      conflicts.push({ type: 'CONFLICT', path: pathname, reason: '已管理目标文件被人工修改' });
      continue;
    }
    if (source.sha256 === target.sha256 && source.size === target.size) {
      actions.push({ type: 'UNCHANGED', path: pathname, source, target });
    } else {
      actions.push({ type: 'UPDATE', path: pathname, source, target });
    }
  }

  for (const [pathname, previous] of Object.entries(managed)) {
    if (sourceFiles.has(pathname)) continue;
    const target = targetFiles.get(pathname);
    if (target && (target.sha256 !== previous.sha256 || target.size !== previous.size)) {
      conflicts.push({ type: 'CONFLICT', path: pathname, reason: '已移除源文件的目标副本被人工修改' });
      continue;
    }
    actions.push({ type: 'STALE', path: pathname, target, previous });
  }

  return { actions, conflicts };
}

function logPlan(actions, conflicts, output) {
  for (const action of actions) output(`${action.type.padEnd(9)} ${action.path}`);
  for (const conflict of conflicts) output(`${conflict.type.padEnd(9)} ${conflict.path} — ${conflict.reason}`);
  const counts = [...actions, ...conflicts].reduce((summary, item) => {
    summary[item.type] = (summary[item.type] ?? 0) + 1;
    return summary;
  }, {});
  output(
    `SUMMARY   create=${counts.CREATE ?? 0} update=${counts.UPDATE ?? 0} unchanged=${counts.UNCHANGED ?? 0} stale=${counts.STALE ?? 0} conflict=${counts.CONFLICT ?? 0}`,
  );
}

async function atomicCopy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await assertNoSymlinkComponents(dirname(destination));
  const temporary = `${destination}.kb-sync-tmp-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicWriteJson(destination, value) {
  const temporary = `${destination}.kb-sync-tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function timestampForPath(date) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function applyPlan(policy, sourceFiles, plan, manifest, now) {
  await mkdir(policy.targetRoot, { recursive: true });
  await assertNoSymlinkComponents(policy.targetRoot);
  const changes = plan.actions.filter((action) => action.type === 'CREATE' || action.type === 'UPDATE');
  const updates = changes.filter((action) => action.type === 'UPDATE');
  let backupDirectory = null;

  if (updates.length > 0 || manifest) {
    backupDirectory = join(policy.backupRoot, timestampForPath(now()));
    await mkdir(backupDirectory, { recursive: true });
    for (const action of updates) {
      await atomicCopy(join(policy.targetRoot, action.path), join(backupDirectory, action.path));
    }
    const currentManifestPath = join(policy.targetRoot, MANIFEST_NAME);
    if (await exists(currentManifestPath)) {
      await atomicCopy(currentManifestPath, join(backupDirectory, MANIFEST_NAME));
    }
  }

  for (const action of changes) {
    await atomicCopy(action.source.absolutePath, join(policy.targetRoot, action.path));
  }

  const manifestFiles = {};
  for (const [pathname, source] of sourceFiles) {
    manifestFiles[pathname] = { size: source.size, sha256: source.sha256 };
  }
  for (const action of plan.actions.filter((item) => item.type === 'STALE')) {
    manifestFiles[action.path] = action.previous;
  }

  const nextManifest = {
    schemaVersion: 1,
    sourceId: policy.sourceId,
    targetRoot: policy.targetRoot,
    lastSuccessfulSync: now().toISOString(),
    files: Object.fromEntries(Object.entries(manifestFiles).sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
  };
  await atomicWriteJson(join(policy.targetRoot, MANIFEST_NAME), nextManifest);

  for (const [pathname, source] of sourceFiles) {
    const targetContent = await readFile(join(policy.targetRoot, pathname));
    if (targetContent.byteLength !== source.size || sha256(targetContent) !== source.sha256) {
      throw new Error(`同步后哈希校验失败：${pathname}`);
    }
  }

  const verifiedManifest = await loadManifest(policy);
  if (Object.keys(verifiedManifest.files).length !== Object.keys(nextManifest.files).length) {
    throw new Error('同步后清单条目数校验失败。');
  }
  return { backupDirectory };
}

export async function runSync({ mode = 'dry-run', policy = DEFAULT_POLICY, output = console.log, now = () => new Date() } = {}) {
  if (mode !== 'dry-run' && mode !== 'apply') throw new PolicyError(`未知模式：${mode}`);
  const validatedPolicy = await validatePolicy(policy);
  const sourceFiles = await collectMarkdownFiles(validatedPolicy.sourceRoot);
  const targetExists = await exists(validatedPolicy.targetRoot);
  const targetFiles = targetExists
    ? await collectMarkdownFiles(validatedPolicy.targetRoot, { target: true })
    : new Map();
  const manifest = targetExists ? await loadManifest(validatedPolicy) : null;
  const plan = createPlan(sourceFiles, targetFiles, manifest);

  logPlan(plan.actions, plan.conflicts, output);
  if (plan.conflicts.length > 0) return { exitCode: 2, mode, ...plan };
  if (mode === 'dry-run') return { exitCode: 0, mode, ...plan };

  const applied = await applyPlan(validatedPolicy, sourceFiles, plan, manifest, now);
  output(`APPLIED   ${sourceFiles.size} managed Markdown files`);
  if (applied.backupDirectory) output(`BACKUP    ${applied.backupDirectory}`);
  return { exitCode: 0, mode, ...plan, ...applied };
}

function parseMode(argumentsList) {
  if (argumentsList.length === 0) return 'dry-run';
  if (argumentsList.length === 1 && argumentsList[0] === '--dry-run') return 'dry-run';
  if (argumentsList.length === 1 && argumentsList[0] === '--apply') return 'apply';
  throw new PolicyError(`参数只允许 --dry-run 或 --apply，收到：${argumentsList.join(' ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    const result = await runSync({ mode: parseMode(process.argv.slice(2)) });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`ERROR     ${error.message}`);
    process.exitCode = error instanceof PolicyError ? 2 : 1;
  }
}

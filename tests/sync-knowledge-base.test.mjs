import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MANIFEST_NAME, PolicyError, runSync } from '../scripts/sync-knowledge-base.mjs';

async function fixture() {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(canonicalTemporaryRoot, '羽毛球 同步测试-'));
  const sourceRoot = join(root, 'repo', 'docs', 'knowledge-base');
  const vaultRoot = join(root, 'Obsidian Vault');
  const targetRoot = join(vaultRoot, '羽毛球赛事管理系统');
  const backupRoot = join(root, 'repo', '.local', 'kb-sync-backups');
  await mkdir(join(sourceRoot, '01-项目规划'), { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  await writeFile(join(sourceRoot, '00-首页.md'), '# 首页\n', 'utf8');
  await writeFile(join(sourceRoot, '01-项目规划', '产品 需求.md'), '# 产品需求\n', 'utf8');
  const policy = { sourceRoot, vaultRoot, targetRoot, backupRoot, sourceId: 'test-kb' };
  return { root, sourceRoot, vaultRoot, targetRoot, backupRoot, policy };
}

async function quietRun(options) {
  return runSync({ ...options, output: () => {} });
}

test('dry-run 对不存在的目标保持零写入', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await quietRun({ mode: 'dry-run', policy: data.policy });
  assert.equal(result.exitCode, 0);
  assert.equal(result.actions.filter((item) => item.type === 'CREATE').length, 2);
  await assert.rejects(readFile(join(data.targetRoot, '00-首页.md')));
});

test('首次应用、哈希清单和二次幂等', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const applied = await quietRun({ mode: 'apply', policy: data.policy });
  assert.equal(applied.exitCode, 0);
  assert.equal(await readFile(join(data.targetRoot, '01-项目规划', '产品 需求.md'), 'utf8'), '# 产品需求\n');
  const manifest = JSON.parse(await readFile(join(data.targetRoot, MANIFEST_NAME), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 2);
  const second = await quietRun({ mode: 'dry-run', policy: data.policy });
  assert.equal(second.actions.filter((item) => item.type === 'UNCHANGED').length, 2);
});

test('更新已管理文件前创建备份', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  await quietRun({ mode: 'apply', policy: data.policy });
  await writeFile(join(data.sourceRoot, '00-首页.md'), '# 新首页\n', 'utf8');
  const result = await quietRun({
    mode: 'apply',
    policy: data.policy,
    now: () => new Date('2026-09-18T10:00:00.000Z'),
  });
  assert.equal(await readFile(join(data.targetRoot, '00-首页.md'), 'utf8'), '# 新首页\n');
  assert.equal(await readFile(join(result.backupDirectory, '00-首页.md'), 'utf8'), '# 首页\n');
});

test('人工修改已管理目标时整体停止且不覆盖', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  await quietRun({ mode: 'apply', policy: data.policy });
  await writeFile(join(data.targetRoot, '00-首页.md'), '# 人工修改\n', 'utf8');
  await writeFile(join(data.sourceRoot, '01-项目规划', '产品 需求.md'), '# 新需求\n', 'utf8');
  const result = await quietRun({ mode: 'apply', policy: data.policy });
  assert.equal(result.exitCode, 2);
  assert.equal(await readFile(join(data.targetRoot, '01-项目规划', '产品 需求.md'), 'utf8'), '# 产品需求\n');
});

test('未知同名文件冲突，未知额外文件保持不变', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  await mkdir(data.targetRoot, { recursive: true });
  await writeFile(join(data.targetRoot, '00-首页.md'), '# 未知文件\n', 'utf8');
  let result = await quietRun({ mode: 'apply', policy: data.policy });
  assert.equal(result.exitCode, 2);
  assert.equal(await readFile(join(data.targetRoot, '00-首页.md'), 'utf8'), '# 未知文件\n');

  await rm(data.targetRoot, { recursive: true, force: true });
  await quietRun({ mode: 'apply', policy: data.policy });
  await writeFile(join(data.targetRoot, '个人笔记.md'), '# 不属于同步工具\n', 'utf8');
  await writeFile(join(data.sourceRoot, '00-首页.md'), '# 更新首页\n', 'utf8');
  result = await quietRun({ mode: 'apply', policy: data.policy });
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(join(data.targetRoot, '个人笔记.md'), 'utf8'), '# 不属于同步工具\n');
});

test('源删除只报告 STALE，不删除目标', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  await quietRun({ mode: 'apply', policy: data.policy });
  await unlink(join(data.sourceRoot, '00-首页.md'));
  const result = await quietRun({ mode: 'apply', policy: data.policy });
  assert.equal(result.actions.some((item) => item.type === 'STALE' && item.path === '00-首页.md'), true);
  assert.equal(await readFile(join(data.targetRoot, '00-首页.md'), 'utf8'), '# 首页\n');
});

test('目标越出唯一允许目录时拒绝', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  await assert.rejects(
    quietRun({ mode: 'dry-run', policy: { ...data.policy, targetRoot: join(data.root, 'outside') } }),
    PolicyError,
  );
});

test('源或目标含符号链接时拒绝', async (t) => {
  const sourceCase = await fixture();
  t.after(() => rm(sourceCase.root, { recursive: true, force: true }));
  await symlink(join(sourceCase.sourceRoot, '00-首页.md'), join(sourceCase.sourceRoot, 'link.md'));
  await assert.rejects(quietRun({ mode: 'dry-run', policy: sourceCase.policy }), PolicyError);

  const targetCase = await fixture();
  t.after(() => rm(targetCase.root, { recursive: true, force: true }));
  await quietRun({ mode: 'apply', policy: targetCase.policy });
  await symlink(join(targetCase.targetRoot, '00-首页.md'), join(targetCase.targetRoot, 'link.md'));
  await assert.rejects(quietRun({ mode: 'dry-run', policy: targetCase.policy }), PolicyError);
});

test('目标清单以外的目录结构仍可枚举且不被删除', async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  await quietRun({ mode: 'apply', policy: data.policy });
  await mkdir(join(data.targetRoot, '个人目录'), { recursive: true });
  await writeFile(join(data.targetRoot, '个人目录', '说明.md'), '# 保留\n', 'utf8');
  await quietRun({ mode: 'apply', policy: data.policy });
  assert.deepEqual(await readdir(join(data.targetRoot, '个人目录')), ['说明.md']);
});

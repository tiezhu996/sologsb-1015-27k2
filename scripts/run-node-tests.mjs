/* eslint-disable */
// 离线可执行的核心逻辑测试（Node 环境），与 *.spec.ts 用例保持一致。
// 校样室无法启动 Chrome 时可用：node scripts/run-node-tests.mjs
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
  }
}

// ── localStorage shim ──
const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
  clear: () => memory.clear(),
};

const {
  buildChanges,
  cellKey,
  charAt,
  defaultMark,
  makeAnnotations,
  makeReading,
  mergeAnnotations,
  mergeReadings,
  migratePackage,
  normalizeMark,
  reconcileChange,
  revisionOf,
  PackageValidationError,
} = await import('../out-node/collation.engine.mjs');
const { PoetryStoreService } = await import('../out-node/poetry-store.service.mjs');

const poem = '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少';
const fullPoem = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';

function version(partial = {}) {
  return {
    id: 'v1', name: '校本', source: '', createdAt: '2026-10-01T00:00:00.000Z',
    text: poem, marks: {}, antithesisPairs: [], readings: {}, annotations: {}, ...partial,
  };
}
function baselineFor(text, marks = {}) {
  return { versionId: 'v1', versionName: '校本', text, marks, revision: revisionOf(text, marks), capturedAt: '2026-10-01T00:00:00.000Z' };
}

console.log('collation engine');
await test('按字位拆分正文并忽略标点', () => {
  assert.equal(charAt('春眠不觉晓，', 0, 4), '晓');
  assert.equal(charAt(poem, 1, 0), '处');
  assert.equal(cellKey(3, 4), '3:4');
});

await test('buildChanges 只产出相对基线发生变化的字位', () => {
  const changes = buildChanges(baselineFor(poem), poem.replace('处处闻啼鸟', '处处闻啼鳥'), {});
  assert.equal(changes.length, 1);
  assert.deepEqual({ line: changes[0].line, position: changes[0].position, baseChar: changes[0].baseChar, char: changes[0].char },
    { line: 1, position: 4, baseChar: '鸟', char: '鳥' });
});

await test('buildChanges 捕获平仄标注改动', () => {
  const changes = buildChanges(
    baselineFor(poem, { '0:4': { ...defaultMark(), tone: '仄' } }),
    poem,
    { '0:4': { ...defaultMark(), tone: '平' } },
  );
  const at = changes.find((item) => item.line === 0 && item.position === 4);
  assert.equal(at.mark.tone, '平');
});

await test('与基线一致不产生改动', () => {
  assert.equal(buildChanges(baselineFor(poem), poem, {}).length, 0);
});

await test('单方改字可自动合并', () => {
  const editorText = poem.replace('闻啼鸟', '闻啼鳥');
  const changes = buildChanges(baselineFor(poem), editorText, {});
  assert.equal(reconcileChange(changes[0], baselineFor(poem), version()).applied, true);
});

await test('双方同字位改成不同字判冲突', () => {
  const baseline = baselineFor(poem);
  const changesA = buildChanges(baseline, poem.replace('闻啼鸟', '闻啼鳥'), {});
  const currentB = version({ text: poem.replace('闻啼鸟', '闻啼乌') });
  const result = reconcileChange(changesA[0], baseline, currentB);
  assert.equal(result.applied, false);
  assert.ok(result.conflict.fields.includes('text'));
  assert.equal(result.conflict.currentChar, '乌');
  assert.equal(result.conflict.change.char, '鳥');
});

await test('双方改成同字不冲突', () => {
  const baseline = baselineFor(poem);
  const text = poem.replace('闻啼鸟', '闻啼鳥');
  assert.equal(reconcileChange(buildChanges(baseline, text, {})[0], baseline, version({ text })).applied, true);
});

await test('同包同字异文去重，不同字全部保留来源', () => {
  const pkg = { packageId: 'pkg-1', editor: '王校', name: '王校包', exportedAt: 't' };
  const c1 = buildChanges(baselineFor(poem), poem.replace('闻啼鸟', '闻啼鳥'), {})[0];
  let list = mergeReadings([], makeReading(c1, pkg));
  list = mergeReadings(list, makeReading(c1, pkg));
  assert.equal(list.length, 1);
  const c2 = buildChanges(baselineFor(poem), poem.replace('闻啼鸟', '闻啼乌'), {})[0];
  list = mergeReadings(list, makeReading(c2, { ...pkg, packageId: 'pkg-2', editor: '李校' }));
  assert.deepEqual(list.map((i) => i.char), ['鳥', '乌']);
  assert.deepEqual(list.map((i) => i.editor), ['王校', '李校']);
});

await test('批注追加来源且同文去重', () => {
  const change = buildChanges(baselineFor(poem), poem, { '0:0': { ...defaultMark(), note: '王校新批' } })[0];
  const pkg = { packageId: 'pkg-1', editor: '王校', name: '包', exportedAt: 't' };
  let list = mergeAnnotations([], makeAnnotations(change, pkg));
  list = mergeAnnotations(list, makeAnnotations(change, pkg));
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '王校新批');
});

await test('旧稿 schema 1 升级为 schema 2', () => {
  const result = migratePackage({ schema: 1, packageId: 'old-1', name: '旧稿', editor: '前辈', text: '春眠不觉晓\n处处闻啼鸟', marks: { '0:4': { tone: '仄' } } });
  assert.equal(result.migrated, true);
  assert.equal(result.package.schema, 2);
  assert.equal(result.package.changes.length, 10);
  assert.equal(result.package.baseline.revision, 'legacy');
  assert.equal(result.package.changes.find((c) => c.line === 0 && c.position === 4).char, '晓');
});

await test('旧稿异文不产生阻塞性冲突', () => {
  const legacyText = poem;
  const migrated = migratePackage({ schema: 1, packageId: 'old-2', editor: '前辈', text: legacyText.replace('闻啼鸟', '闻啼鳥') }).package;
  const change = migrated.changes.find((c) => c.line === 1 && c.position === 4);
  assert.equal(change.char, '鳥');
  assert.equal(reconcileChange(change, migrated.baseline, version()).applied, true);
});

await test('损坏包抛 PackageValidationError', () => {
  assert.throws(() => migratePackage(null), PackageValidationError);
  assert.throws(() => migratePackage({ schema: 1, editor: 'x' }), PackageValidationError);
});

await test('normalizeMark 补默认值', () => {
  assert.deepEqual(normalizeMark({ tone: '平' }), { tone: '平', rhyme: '', pauseAfter: false, basis: '', note: '' });
  assert.equal(normalizeMark(null).tone, '?');
});

// ── store 集成 ──
console.log('PoetryStoreService 离线校勘包');
function freshStore() {
  localStorage.clear();
  return new PoetryStoreService();
}
function importJson(store, json, fileName = 'pkg.json') {
  return store.importCollationPackage(new File([json], fileName, { type: 'application/json' }));
}

await test('保存基线并持久化', () => {
  const s = freshStore();
  s.setEditor('王校');
  const b = s.captureBaseline();
  assert.equal(s.activeVersion().baseline.revision, b.revision);
  const reloaded = new PoetryStoreService();
  assert.ok(reloaded.workspace().versions[0].baseline.text.includes('春眠'));
});

await test('导出包带基线、署名与逐字位改动', () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
  const pkg = JSON.parse(s.exportCollationPackage('测试包').json);
  assert.equal(pkg.editor, '王校');
  assert.equal(pkg.baseline.text, fullPoem);
  assert.notEqual(pkg.baseline.text, s.activeVersion().text);
  assert.equal(pkg.changes.length, 1);
  assert.deepEqual({ line: pkg.changes[0].line, position: pkg.changes[0].position, baseChar: pkg.changes[0].baseChar, char: pkg.changes[0].char },
    { line: 1, position: 4, baseChar: '鸟', char: '鳥' });
});

await test('未署名不能导出', () => {
  const s = freshStore();
  s.captureBaseline();
  assert.throws(() => s.exportCollationPackage('x'), /整理者署名/);
});

await test('单方改字导入自动合并落字', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
  const pkg = s.exportCollationPackage('包').json;
  s.undo();
  assert.ok(s.activeVersion().text.includes('闻啼鸟'));
  const report = await importJson(s, pkg);
  assert.equal(report.applied, 1);
  assert.ok(s.activeVersion().text.includes('闻啼鳥'));
  assert.equal(s.pendingConflicts().length, 0);
});

await test('双方不同字：冲突待确认、本字不覆盖、来字留来源', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
  const pkgA = s.exportCollationPackage('A').json;
  s.undo();
  s.setEditor('李校');
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼乌'));
  const report = await importJson(s, pkgA);
  assert.equal(report.conflicts, 1);
  assert.equal(s.pendingConflicts().length, 1);
  assert.ok(s.activeVersion().text.includes('闻啼乌'));
  const readings = s.activeVersion().readings[cellKey(1, 4)];
  assert.ok(readings.some((i) => i.char === '鳥' && i.editor === '王校'));
});

await test('裁决采纳来稿：改正文且本字留存异文', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
  const pkgA = s.exportCollationPackage('A').json;
  s.undo();
  s.setEditor('李校');
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼乌'));
  await importJson(s, pkgA);
  s.resolveConflict(s.pendingConflicts()[0].id, 'incoming');
  assert.ok(s.activeVersion().text.includes('闻啼鳥'));
  assert.equal(s.pendingConflicts().length, 0);
  const readings = s.activeVersion().readings[cellKey(1, 4)];
  assert.ok(readings.some((i) => i.char === '乌'));
  assert.equal(readings.find((i) => i.char === '鳥').adopted, true);
});

await test('裁决并存：本字不动、来字留异文', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
  const pkgA = s.exportCollationPackage('A').json;
  s.undo();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼乌'));
  await importJson(s, pkgA);
  s.resolveConflict(s.pendingConflicts()[0].id, 'both');
  assert.ok(s.activeVersion().text.includes('闻啼乌'));
  const readings = s.activeVersion().readings[cellKey(1, 4)];
  assert.ok(readings.some((i) => i.char === '鳥' && !i.adopted));
});

await test('同一包再导入只留一条登记', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
  const pkg = s.exportCollationPackage('A').json;
  s.undo();
  assert.equal((await importJson(s, pkg)).duplicated, false);
  const again = await importJson(s, pkg);
  assert.equal(again.duplicated, true);
  assert.equal(again.applied, 0);
  assert.equal(s.importedPackages().length, 1);
});

await test('已有批注不被覆盖，新批注按来源追加', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.selectCell(0, 0);
  s.setMark({ note: '王校批注' });
  const pkg = s.exportCollationPackage('A').json;
  s.undo();
  s.selectCell(0, 0);
  s.setMark({ note: '本机批注' });
  await importJson(s, pkg);
  assert.equal(s.activeVersion().marks[cellKey(0, 0)].note, '本机批注');
  const sources = s.activeVersion().annotations[cellKey(0, 0)];
  assert.ok(sources.some((i) => i.text === '王校批注' && i.editor === '王校'));
});

await test('平仄冲突进待确认，本注保留', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.selectCell(0, 0);
  s.setMark({ tone: '仄' });
  const pkg = s.exportCollationPackage('A').json;
  s.undo();
  s.selectCell(0, 0);
  s.setMark({ tone: '中' });
  await importJson(s, pkg);
  assert.equal(s.pendingConflicts().length, 1);
  assert.ok(s.pendingConflicts()[0].fields.includes('tone'));
  assert.equal(s.activeVersion().marks[cellKey(0, 0)].tone, '中');
});

await test('旧稿 schema 1 兼容导入', async () => {
  const s = freshStore();
  s.setEditor('李校');
  const legacy = {
    schema: 1, packageId: 'legacy-001', name: '旧稿校本', editor: '前辈整理者',
    targetVersionId: s.activeVersion().id,
    text: fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'),
    marks: { [cellKey(0, 0)]: { ...defaultMark(), note: '旧批注' } },
  };
  const report = await importJson(s, JSON.stringify(legacy), 'old.json');
  assert.equal(report.migrated, true);
  assert.equal(s.pendingConflicts().length, 0);
  const readings = s.activeVersion().readings[cellKey(1, 4)];
  assert.ok(readings.some((i) => i.char === '鳥' && i.editor === '前辈整理者'));
  assert.equal(s.importedPackages()[0].packageId, 'legacy-001');
});

await test('非当前诗作的包被拒绝', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  const pkg = JSON.parse(s.exportCollationPackage('A').json);
  pkg.poemId = 'poem-of-another-work';
  await assert.rejects(() => importJson(s, JSON.stringify(pkg)));
  assert.equal(s.importedPackages().length, 0);
});

await test('导入失败保存检查点，重试时回滚并重放成功', async () => {
  const s = freshStore();
  s.setEditor('王校');
  s.captureBaseline();
  s.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
  const pkg = s.exportCollationPackage('A').json;
  s.undo();

  const original = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    if (k === 'sologsb-1015-poetry-workspace-v1') throw new Error('mock disk failure');
    return original(k, v);
  };
  await assert.rejects(() => importJson(s, pkg));
  assert.equal(s.importCheckpoint().failed, true);
  assert.ok(s.activeVersion().text.includes('闻啼鸟'));
  localStorage.setItem = original;

  const report = s.retryImportFromCheckpoint();
  assert.equal(report.applied, 1);
  assert.equal(s.importCheckpoint(), null);
  assert.ok(s.activeVersion().text.includes('闻啼鳥'));
  assert.equal(s.importedPackages().length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const { name, error } of failures) {
    console.log(`\n✗ ${name}\n${error.stack || error}`);
  }
  process.exit(1);
}

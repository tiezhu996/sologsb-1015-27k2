import { TestBed } from '@angular/core/testing';
import { ImportReport, PoetryStoreService } from './poetry-store.service';
import type { CollationPackage } from '../models/collation.models';
import { cellKey, defaultMark } from './collation.engine';

describe('PoetryStoreService 离线校勘包', () => {
  let store: PoetryStoreService;

  const poem = '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少';
  const fullPoem = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    store = TestBed.inject(PoetryStoreService);
  });

  async function importJson(json: string, fileName = 'pkg.json'): Promise<ImportReport> {
    const file = new File([json], fileName, { type: 'application/json' });
    return store.importCollationPackage(file);
  }

  function exportJson(): string {
    return store.exportCollationPackage('测试包').json;
  }

  it('保存修改基线并随工作区持久化', () => {
    store.setEditor('王校');
    const baseline = store.captureBaseline();
    expect(store.activeVersion().baseline?.revision).toBe(baseline.revision);
    const reloaded = TestBed.inject(PoetryStoreService);
    expect(reloaded.workspace().versions[0].baseline?.text).toContain('春眠');
  });

  it('导出的校勘包带基线与整理者，改动按字位列出', () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
    const pkg = JSON.parse(exportJson()) as CollationPackage;
    expect(pkg.editor).toBe('王校');
    expect(pkg.baseline?.text).toBe(fullPoem);
    expect(pkg.changes.length).toBe(1);
    expect(pkg.changes[0]).toEqual(jasmine.objectContaining({ line: 1, position: 4, baseChar: '鸟', char: '鳥' }));
    expect(pkg.packageId).toBeTruthy();
  });

  it('未署名不能导出', () => {
    store.captureBaseline();
    expect(() => store.exportCollationPackage('x')).toThrowError();
  });

  it('单一整理者改字、本机仍为基线时自动合并落字', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
    const pkgA = exportJson();

    store.undo(); // 回到基线稿
    expect(store.activeVersion().text).toContain('闻啼鸟');
    const report = await importJson(pkgA);
    expect(report.applied).toBe(1);
    expect(store.activeVersion().text).toContain('闻啼鳥');
    expect(store.pendingConflicts().length).toBe(0);
  });

  it('两位整理者同字位改成不同字：冲突进待确认，异文保留来源，本字不被覆盖', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
    const pkgA = exportJson();

    store.undo();
    store.setEditor('李校');
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼乌'));

    const report = await importJson(pkgA);
    expect(report.conflicts).toBe(1);
    expect(store.pendingConflicts().length).toBe(1);
    // 本字不被覆盖。
    expect(store.activeVersion().text).toContain('闻啼乌');
    // 来字进入异文来源。
    const readings = store.activeVersion().readings?.[cellKey(1, 4)] ?? [];
    expect(readings.some((item) => item.char === '鳥' && item.editor === '王校')).toBeTrue();
  });

  it('裁决采纳来稿：正文改为来字，本字留存为异文', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
    const pkgA = exportJson();
    store.undo();
    store.setEditor('李校');
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼乌'));
    await importJson(pkgA);

    const conflict = store.pendingConflicts()[0];
    store.resolveConflict(conflict.id, 'incoming');
    expect(store.activeVersion().text).toContain('闻啼鳥');
    expect(store.pendingConflicts().length).toBe(0);
    const readings = store.activeVersion().readings?.[cellKey(1, 4)] ?? [];
    expect(readings.some((item) => item.char === '乌')).toBeTrue();
    expect(readings.find((item) => item.char === '鳥')?.adopted).toBeTrue();
  });

  it('裁决并存：本字不动，来字留在异文来源', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
    const pkgA = exportJson();
    store.undo();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼乌'));
    await importJson(pkgA);

    store.resolveConflict(store.pendingConflicts()[0].id, 'both');
    expect(store.activeVersion().text).toContain('闻啼乌');
    const readings = store.activeVersion().readings?.[cellKey(1, 4)] ?? [];
    expect(readings.some((item) => item.char === '鳥' && !item.adopted)).toBeTrue();
  });

  it('同一包再导入只保留一条登记且不重复落字', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
    const pkgA = exportJson();
    store.undo();

    const first = await importJson(pkgA);
    expect(first.duplicated).toBeFalse();
    const second = await importJson(pkgA);
    expect(second.duplicated).toBeTrue();
    expect(second.applied).toBe(0);
    expect(store.importedPackages().length).toBe(1);
  });

  it('已有批注不会被覆盖，新批注按来源追加', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    // 王校在 0:0 加批注。
    store.selectCell(0, 0);
    store.setMark({ note: '王校批注' });
    const pkgA = exportJson();

    // 本机另有批注。
    store.undo();
    store.selectCell(0, 0);
    store.setMark({ note: '本机批注' });

    await importJson(pkgA);
    const mark = store.activeVersion().marks[cellKey(0, 0)];
    expect(mark.note).toBe('本机批注'); // 未被覆盖
    const sources = store.activeVersion().annotations?.[cellKey(0, 0)] ?? [];
    expect(sources.some((item) => item.text === '王校批注' && item.editor === '王校')).toBeTrue();
  });

  it('平仄/韵组/停顿冲突进入待确认，相同时自动合并', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.selectCell(0, 0);
    store.setMark({ tone: '仄' });
    const pkgA = exportJson();

    // 本机对同一字位改成不同平仄。
    store.undo();
    store.selectCell(0, 0);
    store.setMark({ tone: '中' });
    await importJson(pkgA);
    expect(store.pendingConflicts().length).toBe(1);
    expect(store.pendingConflicts()[0].fields).toContain('tone');
    // 本注保留。
    expect(store.activeVersion().marks[cellKey(0, 0)].tone).toBe('中');
  });

  it('旧稿 schema 1 校勘包升级后仍可兼容导入', async () => {
    store.setEditor('李校');
    const legacy = {
      schema: 1,
      packageId: 'legacy-001',
      name: '旧稿校本',
      editor: '前辈整理者',
      targetVersionId: store.activeVersion().id,
      text: poem.replace('处处闻啼鸟', '处处闻啼鳥'),
      marks: { [cellKey(0, 0)]: { ...defaultMark(), note: '旧批注' } },
    };
    const report = await importJson(JSON.stringify(legacy), 'old.json');
    expect(report.migrated).toBeTrue();
    expect(store.pendingConflicts().length).toBe(0);
    const readings = store.activeVersion().readings?.[cellKey(1, 4)] ?? [];
    expect(readings.some((item) => item.char === '鳥' && item.editor === '前辈整理者')).toBeTrue();
    expect(store.importedPackages()[0].packageId).toBe('legacy-001');
  });

  it('不属于当前诗作的包被拒绝', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    const pkg = JSON.parse(exportJson()) as CollationPackage;
    pkg.poemId = 'poem-of-another-work';
    await expectAsync(importJson(JSON.stringify(pkg))).toBeRejected();
    expect(store.importedPackages().length).toBe(0);
  });

  it('导入失败后从检查点重试：先回滚到导入前快照再重放', async () => {
    store.setEditor('王校');
    store.captureBaseline();
    store.updateText(fullPoem.replace('处处闻啼鸟', '处处闻啼鳥'));
    const pkgA = exportJson();
    store.undo();

    // 让工作区落盘失败，触发 applyPackage 异常与失败检查点。
    const original = Storage.prototype.setItem;
    const failing = spyOn(Storage.prototype, 'setItem').and.callFake(function (this: Storage, key: string, value: string) {
      if (key === 'sologsb-1015-poetry-workspace-v1') throw new Error('mock disk failure');
      return original.call(this, key, value);
    });

    await expectAsync(importJson(pkgA)).toBeRejected();
    expect(store.importCheckpoint()?.failed).toBeTrue();
    expect(store.activeVersion().text).toContain('闻啼鸟');

    failing.and.callThrough();
    const retried = store.retryImportFromCheckpoint();
    expect(retried?.applied).toBe(1);
    expect(store.importCheckpoint()).toBeNull();
    expect(store.activeVersion().text).toContain('闻啼鳥');
    expect(store.importedPackages().length).toBe(1);
  });
});

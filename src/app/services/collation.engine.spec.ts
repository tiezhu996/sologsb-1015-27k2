import {
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
} from './collation.engine';
import type { VersionBaseline, PoemVersion, SourcedReading } from '../models/poem.models';
import type { CollationPackage } from '../models/collation.models';
import { PackageValidationError } from '../models/collation.models';

function version(partial: Partial<PoemVersion> = {}): PoemVersion {
  return {
    id: 'v1',
    name: '校本',
    source: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    text: '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少',
    marks: {},
    antithesisPairs: [],
    readings: {},
    annotations: {},
    ...partial,
  };
}

function baselineFor(text: string, marks: Record<string, import('../models/poem.models').CharacterMark> = {}): VersionBaseline {
  return {
    versionId: 'v1',
    versionName: '校本',
    text,
    marks,
    revision: revisionOf(text, marks),
    capturedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('collation engine', () => {
  const baseText = '春眠不觉晓\n处处闻啼鸟\n夜来风雨声\n花落知多少';

  it('按字位拆分正文并忽略标点', () => {
    expect(charAt('春眠不觉晓，', 0, 4)).toBe('晓');
    expect(charAt(baseText, 1, 0)).toBe('处');
    expect(cellKey(3, 4)).toBe('3:4');
  });

  it('buildChanges 只产出相对基线发生变化的字位', () => {
    const baseline = baselineFor(baseText);
    const editorText = baseText.replace('处处闻啼鸟', '处处闻啼鳥');
    const changes = buildChanges(baseline, editorText, {});
    expect(changes.length).toBe(1);
    expect(changes[0]).toEqual(jasmine.objectContaining({ line: 1, position: 4, baseChar: '鸟', char: '鳥' }));
  });

  it('buildChanges 捕获标注改动', () => {
    const baseline = baselineFor(baseText, { '0:4': { ...defaultMark(), tone: '仄', note: '原注' } });
    const changes = buildChanges(baseline, baseText, { '0:4': { ...defaultMark(), tone: '平', note: '原注' } });
    const at = changes.find((item) => item.line === 0 && item.position === 4);
    expect(at?.mark?.tone).toBe('平');
  });

  it('基线与来稿一致时不产生改动', () => {
    const baseline = baselineFor(baseText);
    expect(buildChanges(baseline, baseText, {}).length).toBe(0);
  });

  it('单一整理者改字、本机仍是基线原字时可自动合并', () => {
    const baseline = baselineFor(baseText);
    const editorText = baseText.replace('闻啼鸟', '闻啼鳥');
    const changes = buildChanges(baseline, editorText, {});
    const result = reconcileChange(changes[0], baseline, version());
    expect(result.applied).toBeTrue();
    expect(result.conflict).toBeUndefined();
  });

  it('两位整理者对同一字位改成不同字时判为冲突', () => {
    const baseline = baselineFor(baseText);
    const aText = baseText.replace('闻啼鸟', '闻啼鳥');
    const changesA = buildChanges(baseline, aText, {});
    const currentB = version({ text: baseText.replace('闻啼鸟', '闻啼乌') });
    const result = reconcileChange(changesA[0], baseline, currentB);
    expect(result.applied).toBeFalse();
    expect(result.conflict?.fields).toContain('text');
    expect(result.conflict?.change.char).toBe('鳥');
    expect(result.conflict?.currentChar).toBe('乌');
  });

  it('双方改成同一个字时不冲突', () => {
    const baseline = baselineFor(baseText);
    const aText = baseText.replace('闻啼鸟', '闻啼鳥');
    const changesA = buildChanges(baseline, aText, {});
    const currentB = version({ text: aText });
    expect(reconcileChange(changesA[0], baseline, currentB).applied).toBeTrue();
  });

  it('同包同字同字异文去重，不同字全部保留', () => {
    const pkg = { packageId: 'pkg-1', editor: '王校', name: '王校包', exportedAt: 't' } as CollationPackage;
    const change = buildChanges(baselineFor(baseText), baseText.replace('闻啼鸟', '闻啼鳥'), {})[0];
    const reading = makeReading(change, pkg);
    let list = mergeReadings([], reading);
    list = mergeReadings(list, reading);
    expect(list.length).toBe(1);
    const change2 = buildChanges(baselineFor(baseText), baseText.replace('闻啼鸟', '闻啼乌'), {})[0];
    list = mergeReadings(list, makeReading(change2, { ...pkg, packageId: 'pkg-2', editor: '李校' } as CollationPackage));
    expect(list.map((item) => item.char)).toEqual(['鳥', '乌']);
    expect(list.map((item) => item.editor)).toEqual(['王校', '李校']);
  });

  it('批注按来源追加且同文去重，不覆盖原有批注', () => {
    const change = { ...buildChanges(baselineFor(baseText), baseText, { '0:0': { ...defaultMark(), note: '王校新批' } })[0] };
    const pkg = { packageId: 'pkg-1', editor: '王校', name: '包', exportedAt: 't' } as CollationPackage;
    const annotations = makeAnnotations({ ...change, line: 0, position: 0 }, pkg);
    let list = mergeAnnotations([], annotations);
    list = mergeAnnotations(list, annotations);
    expect(list.length).toBe(1);
    expect(list[0].text).toBe('王校新批');
  });

  it('旧稿 schema 1 校勘包升级为 schema 2 且逐字位可对账', () => {
    const legacy = {
      schema: 1,
      packageId: 'old-1',
      name: '旧稿',
      editor: '前辈',
      text: '春眠不觉晓\n处处闻啼鸟',
      marks: { '0:4': { tone: '仄' } },
    };
    const result = migratePackage(legacy);
    expect(result.migrated).toBeTrue();
    expect(result.package.schema).toBe(2);
    expect(result.package.changes.length).toBe(10);
    expect(result.package.changes.find((c) => c.line === 0 && c.position === 4)?.char).toBe('晓');
    expect(result.package.baseline?.revision).toBe('legacy');
  });

  it('旧稿异文与当前稿不同字时不产生阻塞性冲突', () => {
    const migrated = migratePackage({
      schema: 1,
      packageId: 'old-2',
      editor: '前辈',
      text: baseText.replace('闻啼鸟', '闻啼鳥'),
    }).package;
    const change = migrated.changes.find((c) => c.line === 1 && c.position === 4)!;
    // 旧包基线为空 → 无论当前稿是什么字，reconcile 以空基线对账。
    const result = reconcileChange(change, migrated.baseline, version());
    expect(result.applied).toBeTrue();
  });

  it('已是 schema 2 的包直通，无需迁移', () => {
    const pkg: CollationPackage = {
      kind: 'classical-poetry-collation-package',
      schema: 2,
      packageId: 'p',
      name: 'n',
      poemId: '',
      title: '',
      editor: '王校',
      exportedAt: 't',
      targetVersionId: 'v1',
      targetVersionName: '校本',
      baseline: baselineFor(baseText) as CollationPackage['baseline'],
      changes: [],
    };
    expect(migratePackage(pkg).migrated).toBeFalse();
  });

  it('损坏或缺少正文的包抛出可识别错误', () => {
    expect(() => migratePackage(null)).toThrowError(PackageValidationError);
    expect(() => migratePackage({ schema: 1, editor: 'x' })).toThrowError(PackageValidationError);
  });

  it('normalizeMark 对残缺标注补默认值', () => {
    expect(normalizeMark({ tone: '平' })).toEqual({ tone: '平', rhyme: '', pauseAfter: false, basis: '', note: '' });
    expect(normalizeMark(null).tone).toBe('?');
  });

  it('异文来源携带整理者与包信息', () => {
    const change = buildChanges(baselineFor(baseText), baseText.replace('晓', '晓'), {})[0];
    const noChange = buildChanges(baselineFor(baseText), baseText, {});
    expect(noChange.length).toBe(0);
    expect(change).toBeUndefined();
    const changed = buildChanges(baselineFor(baseText), baseText.replace('晓', '小'), {})[0];
    const pkg = { packageId: 'pkg-9', editor: '赵校', name: '赵校包', exportedAt: 't' } as CollationPackage;
    const reading: SourcedReading = makeReading(changed, pkg);
    expect(reading.char).toBe('小');
    expect(reading.editor).toBe('赵校');
    expect(reading.packageId).toBe('pkg-9');
  });
});

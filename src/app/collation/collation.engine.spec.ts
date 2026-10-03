import type { CharacterMark } from '../models/poem.models';
import type { JiaoKanPackage, MergeCounters } from './collation.models';
import {
  buildPackage,
  captureBaseline,
  mergeChange,
  migratePackage,
  packageFingerprint,
  replaceCharAt,
  toPoemCells,
  type MergeState,
} from './collation.engine';

const POEM = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';

function emptyMarks(): Record<string, CharacterMark> {
  return {};
}

function makePackage(overrides: Partial<JiaoKanPackage> & { changes: JiaoKanPackage['changes'] }): JiaoKanPackage {
  const baseline = captureBaseline({ id: 'v1', name: '底本', text: POEM, marks: {} }, '2026-10-01T00:00:00.000Z');
  return {
    kind: 'jiaokan',
    format: 2,
    packageId: '',
    exportedAt: '2026-10-02T00:00:00.000Z',
    poemTitle: '春晓',
    editor: { id: 'ed-a', name: '甲', room: '甲室' },
    baseline: {
      capturedAt: baseline.capturedAt,
      versionId: baseline.versionId,
      versionName: baseline.versionName,
      text: baseline.text,
      digest: baseline.digest,
      charHashes: baseline.charHashes,
    },
    sourceVersion: { id: 'v1', name: '甲的校勘稿', source: '' },
    ...overrides,
  };
}

function stateFrom(text = POEM, marks: Record<string, CharacterMark> = {}): MergeState {
  return { text, marks, variants: {}, conflicts: [], appliedPositions: [] };
}

function runAll(state: MergeState, pkg: JiaoKanPackage, seen = new Set<string>(), resumePackageId?: string): MergeCounters {
  const counters: MergeCounters = { applied: 0, conflicts: 0, anomalies: 0, skipped: 0, blockedFields: 0 };
  pkg.changes.forEach((change) => mergeChange(state, change, pkg, seen, counters, '2026-10-03T00:00:00.000Z', resumePackageId));
  return counters;
}

function charAt(text: string, pos: number): string {
  return toPoemCells(text)[pos].char;
}

describe('校勘引擎', () => {
  it('单方改字按字位并入，并保留标点与换行', () => {
    const pkg = makePackage({ changes: [{ pos: 4, line: 0, ch: 4, base: '晓', text: '哓' }] });
    const state = stateFrom();
    const counters = runAll(state, pkg);
    expect(counters.applied).toBe(1);
    expect(charAt(state.text, 4)).toBe('哓');
    expect(state.text.split('\n').length).toBe(4);
    expect(state.conflicts.length).toBe(0);
  });

  it('双方在同一字位改作不同字：冲突入待确认，本地字不被覆盖，两个字都留来源', () => {
    // 本地已把第 4 个诗字“晓”改为“小”
    const local = stateFrom(replaceCharAt(POEM, 4, '小'));
    const pkg = makePackage({ changes: [{ pos: 4, line: 0, ch: 4, base: '晓', text: '哓' }] });
    const counters = runAll(local, pkg);
    expect(counters.conflicts).toBe(1);
    expect(charAt(local.text, 4)).toBe('小');
    expect(local.conflicts[0].reason).toBe('both-changed');
    const readings = local.variants['0:4'].readings.map((r) => r.char);
    expect(readings).toContain('小');
    expect(readings).toContain('哓');
  });

  it('已有异文与批注不被覆盖：批注只追加，按“包+内容”去重', () => {
    const local = stateFrom();
    const pkg = makePackage({
      changes: [{ pos: 4, line: 0, ch: 4, base: '晓', note: '甲：一作哓' }],
    });
    runAll(local, pkg);
    runAll(local, pkg); // 同包再跑一次
    const ledger = local.variants['0:4'];
    expect(ledger.notes.length).toBe(1);
    // 字位本身的批注不受导入影响
    expect(local.marks['0:4']?.note ?? '').toBe('');
  });

  it('已有平仄/依据等标注绝不被来稿覆盖，只填空缺', () => {
    const local = stateFrom(POEM, { '0:4': { tone: '平', rhyme: 'A', pauseAfter: false, basis: '本地依据', note: '' } });
    const pkg = makePackage({
      changes: [{ pos: 4, line: 0, ch: 4, base: '晓', markPatch: { tone: '仄', basis: '甲方依据', rhyme: 'B' } }],
    });
    const counters = runAll(local, pkg);
    expect(local.marks['0:4'].tone).toBe('平');
    expect(local.marks['0:4'].basis).toBe('本地依据');
    // 韵基本地已有 A，不被改为 B
    expect(local.marks['0:4'].rhyme).toBe('A');
    expect(counters.blockedFields).toBe(3);
  });

  it('空缺标注由来稿补入', () => {
    const local = stateFrom();
    const pkg = makePackage({
      changes: [{ pos: 4, line: 0, ch: 4, base: '晓', markPatch: { basis: '《广韵》' } }],
    });
    const counters = runAll(local, pkg);
    expect(counters.applied).toBe(1);
    expect(local.marks['0:4'].basis).toBe('《广韵》');
  });

  it('同一包重复导入：字位级去重，不产生新冲突/新异文', () => {
    const local = stateFrom();
    const pkg = makePackage({ changes: [{ pos: 4, line: 0, ch: 4, base: '晓', text: '哓' }] });
    const first = runAll(local, pkg);
    // 再次导入同一个包：检查点台账已记录该字位，按本包续跑语义跳过
    const second = runAll(local, pkg, new Set(), pkg.packageId);
    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(1);
    expect(local.variants['0:4'].readings.filter((r) => r.packageId === pkg.packageId).length).toBe(1);
  });

  it('包号由内容决定：同样的整理者/基线/改动导出两次是同一个包', () => {
    const version = { id: 'v1', name: '底本', source: '', text: POEM.replace('晓', '哓'), marks: emptyMarks() };
    const baseline = captureBaseline({ id: 'v1', name: '底本', text: POEM, marks: {} }, '2026-10-01T00:00:00.000Z');
    const editor = { id: 'ed-a', name: '甲', room: '甲室' };
    const pkg1 = buildPackage({ poemTitle: '春晓', editor, baseline, version }, '2026-10-02T00:00:00.000Z');
    const pkg2 = buildPackage({ poemTitle: '春晓', editor, baseline, version }, '2026-10-03T00:00:00.000Z');
    expect(pkg1.packageId).toBe(pkg2.packageId);
    // 改了整理者房间（非内容）不影响包号；改了改动内容才换号
    const pkg3 = buildPackage({
      poemTitle: '春晓',
      editor: { ...editor, room: '乙室' },
      baseline,
      version,
    }, '2026-10-03T00:00:00.000Z');
    expect(pkg3.packageId).toBe(pkg1.packageId);
    void packageFingerprint;
  });

  it('基线不合且本地也已偏离时转异常待确认，不改文本', () => {
    // 本地第 4 字已被改成“小”，来稿却声称底字是“错字”、要改成“哓”：三方对不上，需人工核对。
    const local = stateFrom(replaceCharAt(POEM, 4, '小'));
    expect(charAt(local.text, 4)).toBe('小');
    const pkg = makePackage({ changes: [{ pos: 4, line: 0, ch: 4, base: '错字', text: '哓' }] });
    const counters = runAll(local, pkg);
    expect(counters.anomalies).toBe(1);
    expect(local.conflicts[0].reason).toBe('baseline-mismatch');
    expect(charAt(local.text, 4)).toBe('小');
  });

  it('旧稿 v0 散件包可升级迁移并按字位导入', () => {
    const legacy = {
      meta: { editor: '旧稿整理者', baselineVersion: 'v1', title: '春晓' },
      changes: [{ index: 4, from: '晓', to: '哓', note: '旧本一作哓' }],
    };
    const migrated = migratePackage(legacy, {
      title: '春晓',
      versions: [{ id: 'v1', name: '底本', source: '', text: POEM, marks: {} }],
    });
    expect(migrated.legacy).toBeTrue();
    expect(migrated.pkg.format).toBe(2);
    expect(migrated.pkg.editor.name).toBe('旧稿整理者');
    expect(migrated.pkg.changes[0].pos).toBe(4);
    expect(migrated.pkg.changes[0].text).toBe('哓');
    expect(migrated.pkg.changes[0].note).toBe('旧本一作哓');

    const local = stateFrom();
    const counters = runAll(local, migrated.pkg);
    expect(counters.applied).toBe(1);
    expect(local.variants['0:4'].notes[0].note).toBe('旧本一作哓');
  });

  it('format=1 的旧包同样兼容', () => {
    const v1 = {
      kind: 'jiaokan',
      format: 1,
      exportedAt: '2026-09-01T00:00:00.000Z',
      editor: { id: 'ed-old', name: '老整理者' },
      baseline: null,
      changes: [{ pos: 0, line: 0, ch: 0, base: '春', text: '萅' }],
    };
    const migrated = migratePackage(v1, {
      title: '春晓',
      versions: [{ id: 'version-main', name: '主版本', source: '', text: POEM, marks: {} }],
    });
    expect(migrated.legacy).toBeTrue();
    expect(migrated.pkg.format).toBe(2);
    const local = stateFrom();
    const counters = runAll(local, migrated.pkg);
    expect(counters.applied).toBe(1);
    expect(charAt(local.text, 0)).toBe('萅');
  });

  it('导出的包携带整理者与基线摘要', () => {
    const baseline = captureBaseline({ id: 'v1', name: '底本', text: POEM, marks: {} }, '2026-10-01T00:00:00.000Z');
    const version = { id: 'v1', name: '底本', source: '某宋本', text: POEM, marks: {} };
    const pkg = buildPackage({
      poemTitle: '春晓',
      editor: { id: 'ed-a', name: '甲', room: '甲室' },
      baseline,
      version,
    }, '2026-10-02T00:00:00.000Z');
    expect(pkg.editor.name).toBe('甲');
    expect(pkg.baseline.digest).toBe(baseline.digest);
    expect(pkg.baseline.charHashes.length).toBe(toPoemCells(POEM).length);
  });

  it('检查点续跑：前两条落盘后从第三条继续，不重复并入、不漏并', () => {
    const pkg = makePackage({
      changes: [
        { pos: 1, line: 0, ch: 1, base: '眠', text: '瞑' },
        { pos: 2, line: 0, ch: 2, base: '不', markPatch: { basis: '广韵' } },
        { pos: 4, line: 0, ch: 4, base: '晓', text: '哓' },
      ],
    });

    // 第一次：只处理前两条后“中断”
    const state = stateFrom();
    const seen = new Set<string>();
    const counters: MergeCounters = { applied: 0, conflicts: 0, anomalies: 0, skipped: 0, blockedFields: 0 };
    pkg.changes.slice(0, 2).forEach((change) => mergeChange(state, change, pkg, seen, counters, '2026-10-03T00:00:00.000Z'));
    expect(charAt(state.text, 1)).toBe('瞑');
    expect(state.marks['0:2'].basis).toBe('广韵');
    expect(charAt(state.text, 4)).toBe('晓');

    // 续跑：从第三条开始；前两条按本包检查点跳过，避免重复并入
    pkg.changes.forEach((change) => mergeChange(state, change, pkg, seen, counters, '2026-10-03T00:01:00.000Z', pkg.packageId));
    expect(charAt(state.text, 1)).toBe('瞑');
    expect(state.marks['0:2'].basis).toBe('广韵');
    expect(charAt(state.text, 4)).toBe('哓');
    expect(counters.applied).toBe(3);
    expect(counters.skipped).toBe(2);
    expect(state.conflicts.length).toBe(0);
  });

  it('多位整理者的不同用字在同一字位全部保留来源', () => {
    const local = stateFrom();
    // 甲改第 4 字为哓（单方改）
    runAll(local, makePackage({
      packageId: 'jk-a',
      editor: { id: 'ed-a', name: '甲', room: '' },
      changes: [{ pos: 4, line: 0, ch: 4, base: '晓', text: '哓' }],
    }), new Set());
    // 乙在同一字位又作“小”：与当前字“哓”冲突，两字并存留来源（两次独立导入，去重集合各自独立）
    runAll(local, makePackage({
      packageId: 'jk-b',
      editor: { id: 'ed-b', name: '乙', room: '' },
      changes: [{ pos: 4, line: 0, ch: 4, base: '晓', text: '小' }],
    }), new Set());
    expect(charAt(local.text, 4)).toBe('哓'); // 本稿字不被乙覆盖
    const readingChars = local.variants['0:4'].readings.map((r) => `${r.char}@${r.editorName}`);
    expect(readingChars).toContain('哓@甲');
    expect(readingChars).toContain('哓@本稿');
    expect(readingChars).toContain('小@乙');
    expect(readingChars).toContain('晓@甲');
    expect(local.conflicts.length).toBe(1);
  });
});

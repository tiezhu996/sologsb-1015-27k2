import { computed, Injectable, signal } from '@angular/core';
import type {
  AntithesisPair,
  AnalysisCell,
  AnalysisLine,
  CharacterMark,
  CharDiff,
  CollationState,
  ImportedPackageRecord,
  MarkTone,
  MeterTemplate,
  PendingConflict,
  PoemIssue,
  PoemVersion,
  PoemWorkspace,
  SourcedAnnotation,
  SourcedReading,
  Tone,
  VersionBaseline,
} from '../models/poem.models';
import type { CollationPackage } from '../models/collation.models';
import {
  PACKAGE_SCHEMA_VERSION,
  PackageValidationError,
} from '../models/collation.models';
import {
  buildChanges,
  cellKey,
  charAt,
  defaultMark,
  gridOf,
  makeAnnotations,
  makeReading,
  mergeAnnotations,
  mergeReadings,
  buildConflict,
  migratePackage,
  normalizeMark,
  reconcileChange,
  revisionOf,
} from './collation.engine';

export const METER_TEMPLATES: MeterTemplate[] = [
  {
    id: 'wuyan-zeqi',
    name: '五言绝句 · 仄起首句不入韵',
    summary: '四句，每句五字；二、四句押韵',
    lineCount: 4,
    lineLength: 5,
    pattern: ['仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
  {
    id: 'wuyan-pingqi',
    name: '五言绝句 · 平起首句入韵',
    summary: '四句，每句五字；一、二、四句押韵',
    lineCount: 4,
    lineLength: 5,
    pattern: ['中', '平', '中', '仄', '平', '仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '仄', '中', '平'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-zeqi',
    name: '七言绝句 · 仄起首句入韵',
    summary: '四句，每句七字；一、二、四句押韵',
    lineCount: 4,
    lineLength: 7,
    pattern: ['仄', '仄', '中', '平', '中', '仄', '平', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-pingqi',
    name: '七言绝句 · 平起首句不入韵',
    summary: '四句，每句七字；二、四句押韵',
    lineCount: 4,
    lineLength: 7,
    pattern: ['中', '平', '中', '仄', '仄', '中', '平', '仄', '仄', '中', '平', '平', '仄', '仄', '中', '平', '中', '仄', '中', '平', '仄', '仄', '中', '平', '中', '仄', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
];

const STORAGE_KEY = 'sologsb-1015-poetry-workspace-v1';
const CHECKPOINT_KEY = 'sologsb-1015-import-checkpoint-v1';
const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t']);
const TONE_DICTIONARY: Record<string, Tone> = {
  春: '平', 眠: '平', 不: '仄', 觉: '仄', 晓: '仄', 处: '仄', 闻: '平', 啼: '平', 鸟: '仄',
  夜: '仄', 来: '平', 风: '平', 雨: '仄', 声: '平', 花: '平', 落: '仄', 知: '平', 多: '平', 少: '仄',
  国: '仄', 破: '仄', 山: '平', 河: '平', 在: '仄', 城: '平', 深: '平', 木: '仄', 草: '仄', 独: '仄',
  明: '平', 月: '仄', 高: '平', 天: '平', 故: '仄', 乡: '平', 万: '仄', 里: '仄', 江: '平', 船: '平',
};

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function key(line: number, position: number): string {
  return cellKey(line, position);
}

export interface ImportCheckpoint {
  savedAt: string;
  fileName: string;
  packageId: string;
  packageName: string;
  editor: string;
  /** 失败时保留的原始包 JSON，供检查点重试。 */
  packageJson: string;
  /** 导入前工作区快照。 */
  workspace: PoemWorkspace;
  failed: boolean;
  error?: string;
}

export interface ImportReport {
  ok: boolean;
  duplicated: boolean;
  migrated: boolean;
  warnings: string[];
  applied: number;
  conflicts: number;
  annotations: number;
  readings: number;
  targetVersionName: string;
  message: string;
}

function initialWorkspace(): PoemWorkspace {
  const now = new Date().toISOString();
  const spring = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';
  const marks: Record<string, CharacterMark> = {};
  const cells = [
    ['晓', 0, '平', false], ['鸟', 1, '平', false], ['声', 2, '平', false], ['少', 3, '平', false],
  ] as const;
  cells.forEach(([char, line, tone, pause]) => {
    marks[key(line, 4)] = { tone, rhyme: 'A', pauseAfter: pause, basis: '《平水韵》上声十七筱', note: `${char} 为韵脚` };
  });
  marks[key(0, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '句中平声' };
  marks[key(1, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };
  marks[key(2, 2)] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };

  const topVersion: PoemVersion = {
    id: 'version-main',
    name: '通行本 · 孟浩然集',
    source: '《孟浩然诗集笺注》',
    createdAt: now,
    text: spring,
    marks,
    antithesisPairs: [],
  };
  const variant: PoemVersion = {
    id: 'version-song',
    name: '宋刻本异文',
    source: '宋蜀刻本',
    createdAt: now,
    text: '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。',
    marks: clone(marks),
    antithesisPairs: [],
  };
  return {
    title: '春晓',
    author: '孟浩然',
    templateId: 'wuyan-zeqi',
    versions: [topVersion, variant],
    activeVersionId: topVersion.id,
    updatedAt: now,
    editor: '',
    poemId: 'poem-chunxiao-meng-haoran',
    collation: { pendingConflicts: [], importedPackages: [] },
  };
}

/** 兼容旧档：为缺少基线/异文/校勘状态的工作区补齐字段。 */
function migrateWorkspace(parsed: Partial<PoemWorkspace>): PoemWorkspace {
  const now = new Date().toISOString();
  const workspace = parsed as unknown as PoemWorkspace;
  workspace.versions = (workspace.versions ?? []).map((version) => ({
    ...version,
    marks: version.marks ?? {},
    antithesisPairs: version.antithesisPairs ?? [],
    readings: version.readings ?? {},
    annotations: version.annotations ?? {},
  }));
  workspace.collation = {
    pendingConflicts: workspace.collation?.pendingConflicts ?? [],
    importedPackages: workspace.collation?.importedPackages ?? [],
  };
  if (!workspace.poemId) {
    workspace.poemId = `poem-${revisionOf(`${workspace.title ?? ''}/${workspace.author ?? ''}`, {})}`;
  }
  workspace.editor = workspace.editor ?? '';
  workspace.updatedAt = workspace.updatedAt ?? now;
  return workspace;
}

function loadWorkspace(): PoemWorkspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialWorkspace();
    const parsed = JSON.parse(raw) as Partial<PoemWorkspace>;
    if (!parsed.versions?.length) return initialWorkspace();
    return migrateWorkspace(parsed);
  } catch {
    return initialWorkspace();
  }
}

function loadCheckpoint(): ImportCheckpoint | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    return raw ? (JSON.parse(raw) as ImportCheckpoint) : null;
  } catch {
    return null;
  }
}

/** 在保留标点与换行的前提下，替换第 line 句第 position 个正文字。 */
function replaceCharAt(text: string, line: number, position: number, char: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let seen = -1;
  const target = lines[line];
  if (target === undefined) return text;
  const chars = Array.from(target);
  for (let i = 0; i < chars.length; i++) {
    if (PUNCTUATION.has(chars[i])) continue;
    seen += 1;
    if (seen === position) {
      chars[i] = char;
      lines[line] = chars.join('');
      return lines.join('\n');
    }
  }
  return text;
}

@Injectable({ providedIn: 'root' })
export class PoetryStoreService {
  readonly workspace = signal<PoemWorkspace>(loadWorkspace());
  readonly selectedLine = signal(0);
  readonly selectedPosition = signal(4);
  readonly baselineVersionId = signal<string>('');
  readonly currentDiffIndex = signal(0);
  readonly toast = signal('');
  readonly undoCount = signal(0);
  readonly redoCount = signal(0);
  readonly importCheckpoint = signal<ImportCheckpoint | null>(loadCheckpoint());
  readonly lastImportReport = signal<ImportReport | null>(null);

  private undoStack: PoemWorkspace[] = [];
  private redoStack: PoemWorkspace[] = [];

  readonly activeVersion = computed(() => {
    const state = this.workspace();
    return state.versions.find((version) => version.id === state.activeVersionId) ?? state.versions[0];
  });

  readonly template = computed(() => {
    return METER_TEMPLATES.find((item) => item.id === this.workspace().templateId) ?? METER_TEMPLATES[0];
  });

  readonly lines = computed(() => this.activeVersion().text.split('\n'));

  readonly collation = computed<CollationState>(
    () => this.workspace().collation ?? { pendingConflicts: [], importedPackages: [] },
  );
  readonly pendingConflicts = computed<PendingConflict[]>(() => this.collation().pendingConflicts);
  readonly importedPackages = computed<ImportedPackageRecord[]>(() => this.collation().importedPackages);

  /** 当前活动版本上的待确认冲突，供字格与合并页使用。 */
  readonly activeConflicts = computed(() => {
    const versionId = this.activeVersion().id;
    return this.pendingConflicts().filter((item) => item.versionId === versionId);
  });

  private conflictAt(line: number, position: number): PendingConflict | undefined {
    const ck = key(line, position);
    return this.activeConflicts().find((item) => item.status === 'pending' && item.cellKey === ck);
  }

  readonly analysis = computed<AnalysisLine[]>(() => {
    const version = this.activeVersion();
    const template = this.template();
    return this.lines().map((line, lineIndex) => {
      const chars = Array.from(line).filter((char) => !PUNCTUATION.has(char));
      const cells: AnalysisCell[] = chars.map((char, position) => {
        const ck = key(lineIndex, position);
        const mark = version.marks[ck] ?? defaultMark();
        const expected = template.pattern[lineIndex * template.lineLength + position] ?? '中';
        const actual = mark.tone === '?' ? (TONE_DICTIONARY[char] ?? '?') : mark.tone;
        let status: AnalysisCell['status'] = 'neutral';
        let message = '标点或不计律位置';
        if (PUNCTUATION.has(char)) {
          status = 'neutral';
        } else if (actual === '?') {
          status = 'unknown';
          message = '尚未标注平仄';
        } else if (expected === '中') {
          status = 'correct';
          message = '可平可仄';
        } else if (actual === expected) {
          status = 'correct';
          message = '合律';
        } else if (this.isAcceptableVariant(template, lineIndex, position)) {
          status = 'variant';
          message = '一三五位置的可接受变体';
        } else {
          status = 'error';
          message = `此处应为${expected}声`;
        }
        return {
          char,
          position,
          expected,
          actual,
          status,
          message,
          mark,
          readings: version.readings?.[ck] ?? [],
          annotations: version.annotations?.[ck] ?? [],
        };
      });
      const rhymeChars = template.rhymeLines.includes(lineIndex) ? cells.slice(-1).map((cell) => cell.char) : [];
      return {
        index: lineIndex,
        cells,
        rhymeChars,
        errors: cells.filter((cell) => cell.status === 'error').length,
        variants: cells.filter((cell) => cell.status === 'variant').length,
      };
    });
  });

  readonly issues = computed<PoemIssue[]>(() => {
    const analysis = this.analysis();
    const version = this.activeVersion();
    const template = this.template();
    const issues: PoemIssue[] = [];
    analysis.forEach((line) => {
      line.cells.filter((cell) => cell.status === 'error').forEach((cell) => {
        issues.push({
          id: uid('issue'),
          level: 'error',
          title: '出律位置',
          detail: `第 ${line.index + 1} 句“${cell.char}”：${cell.message}`,
          line: line.index,
          position: cell.position,
        });
      });
      if (line.cells.some((cell) => cell.status === 'unknown')) {
        issues.push({ id: uid('issue'), level: 'warning', title: '存在未标注字', detail: `第 ${line.index + 1} 句仍有平仄未确认。`, line: line.index });
      }
    });
    const rhymeCells = template.rhymeLines.map((line) => analysis[line]?.cells.at(-1)).filter(Boolean);
    const rhymeGroups = new Map<string, string[]>();
    rhymeCells.forEach((cell) => {
      if (!cell?.mark.rhyme) {
        issues.push({ id: uid('issue'), level: 'warning', title: '韵脚缺少韵部', detail: `第 ${(cell?.position ?? 0) + 1} 句末字尚未指定韵部。` });
        return;
      }
      rhymeGroups.set(cell.mark.rhyme, [...(rhymeGroups.get(cell.mark.rhyme) ?? []), cell.char]);
    });
    rhymeGroups.forEach((chars, rhyme) => {
      const duplicate = chars.find((char, index) => chars.indexOf(char) !== index);
      if (duplicate) issues.push({ id: uid('issue'), level: 'warning', title: '重复用韵', detail: `韵部 ${rhyme} 重复使用末字“${duplicate}”。` });
    });
    if (version.antithesisPairs.length === 0) {
      issues.push({ id: 'antithesis-empty', level: 'info', title: '尚未标记对仗', detail: '可在检视器中把两句建立对仗关系。' });
    }
    const pending = this.activeConflicts().length;
    if (pending > 0) {
      issues.unshift({
        id: 'collation-pending',
        level: 'warning',
        title: '离线合并有待确认冲突',
        detail: `当前版本有 ${pending} 个字位需要人工裁决，请前往「离线合并」处理。`,
      });
    }
    if (!issues.some((issue) => issue.level === 'error')) {
      issues.unshift({ id: 'meter-ok', level: 'info', title: '格律检查通过', detail: '当前未发现硬性出律，请继续核对可接受变体。' });
    }
    return issues;
  });

  readonly diff = computed<CharDiff[]>(() => {
    const left = this.workspace().versions.find((version) => version.id === this.baselineVersionId());
    const right = this.activeVersion();
    if (!left || left.id === right.id) return [];
    const leftChars = Array.from(left.text.replace(/\n/g, ''));
    const rightChars = Array.from(right.text.replace(/\n/g, ''));
    const size = Math.max(leftChars.length, rightChars.length);
    return Array.from({ length: size }, (_, index) => ({
      index,
      left: leftChars[index] ?? '',
      right: rightChars[index] ?? '',
      changed: leftChars[index] !== rightChars[index],
    }));
  });

  readonly differences = computed(() => this.diff().filter((item) => item.changed).map((item) => item.index));
  readonly baselineVersion = computed(() => this.workspace().versions.find((version) => version.id === this.baselineVersionId()));

  selectVersion(id: string): void {
    this.workspace.update((workspace) => ({ ...workspace, activeVersionId: id }));
  }

  selectCell(line: number, position: number): void {
    this.selectedLine.set(line);
    this.selectedPosition.set(position);
  }

  setTemplate(id: string): void {
    this.commit((workspace) => {
      workspace.templateId = id;
    });
  }

  updateText(text: string): void {
    this.commit((workspace) => {
      const version = this.versionIn(workspace);
      version.text = text;
    });
  }

  updateTitle(title: string): void {
    this.commit((workspace) => {
      workspace.title = title;
    });
  }

  setEditor(editor: string): void {
    this.commit((workspace) => {
      workspace.editor = editor;
    });
  }

  updateVersionSource(source: string): void {
    this.commit((workspace) => {
      this.versionIn(workspace).source = source;
    });
  }

  setMark(patch: Partial<CharacterMark>): void {
    this.commit((workspace) => {
      const version = this.versionIn(workspace);
      const id = key(this.selectedLine(), this.selectedPosition());
      version.marks[id] = { ...defaultMark(), ...version.marks[id], ...patch };
    });
  }

  cycleTone(): void {
    const cell = this.selectedCell();
    const next: Record<Tone, MarkTone | '?'> = { '?': '平', '平': '仄', '仄': '中', '中': '?' };
    this.setMark({ tone: next[cell?.actual ?? '?'] });
  }

  togglePause(): void {
    const cell = this.selectedCell();
    this.setMark({ pauseAfter: !(cell?.mark.pauseAfter ?? false) });
  }

  cycleRhyme(): void {
    const cell = this.selectedCell();
    const current = cell?.mark.rhyme ?? '';
    const next = current === '' ? 'A' : current === 'A' ? 'B' : current === 'B' ? 'C' : '';
    this.setMark({ rhyme: next });
  }

  addAntithesis(): void {
    const line = this.selectedLine();
    const other = line === 0 ? 1 : line - 1;
    this.commit((workspace) => {
      const version = this.versionIn(workspace);
      if (version.antithesisPairs.some((pair) => pair.leftLine === line && pair.rightLine === other)) return;
      version.antithesisPairs.push({ id: uid('pair'), leftLine: Math.min(line, other), rightLine: Math.max(line, other), note: '结构相对，词性相应。' });
    });
  }

  removeAntithesis(id: string): void {
    this.commit((workspace) => {
      const version = this.versionIn(workspace);
      version.antithesisPairs = version.antithesisPairs.filter((pair) => pair.id !== id);
    });
  }

  updateAntithesis(id: string, note: string): void {
    this.commit((workspace) => {
      const pair = this.versionIn(workspace).antithesisPairs.find((item) => item.id === id);
      if (pair) pair.note = note;
    });
  }

  snapshot(): void {
    const active = clone(this.activeVersion());
    active.id = uid('version');
    active.name = `校勘稿 ${this.workspace().versions.length}`;
    active.createdAt = new Date().toISOString();
    active.baseline = undefined;
    active.readings = {};
    active.annotations = {};
    this.commit((workspace) => {
      workspace.versions.unshift(active);
      workspace.activeVersionId = active.id;
    });
    this.toast.set('已建立独立校勘稿');
  }

  duplicateActiveAsBaseline(): void {
    this.baselineVersionId.set(this.activeVersion().id);
  }

  nextDifference(): void {
    const values = this.differences();
    if (!values.length) return;
    const current = values.findIndex((index) => index >= this.currentDiffIndex());
    this.currentDiffIndex.set(values[(current + 1) % values.length]);
  }

  previousDifference(): void {
    const values = this.differences();
    if (!values.length) return;
    const reverse = [...values].reverse();
    const current = reverse.findIndex((index) => index <= this.currentDiffIndex());
    this.currentDiffIndex.set(reverse[(current + 1) % reverse.length]);
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.workspace()));
    this.workspace.set(migrateWorkspace(previous));
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persist();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.workspace()));
    this.workspace.set(migrateWorkspace(next));
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persist();
  }

  // ─── 离线校勘包：基线 ────────────────────────────────────────────

  /** 为指定版本（默认当前稿）确立修改基线，随工作区持久保存。 */
  captureBaseline(versionId?: string): VersionBaseline {
    let captured: VersionBaseline | undefined;
    this.commit((workspace) => {
      const version = workspace.versions.find((item) => item.id === (versionId ?? workspace.activeVersionId)) ?? this.versionIn(workspace);
      const now = new Date().toISOString();
      captured = {
        versionId: version.id,
        versionName: version.name,
        text: version.text,
        marks: clone(version.marks),
        revision: revisionOf(version.text, version.marks),
        capturedAt: now,
      };
      version.baseline = captured;
    });
    return captured!;
  }

  baselineOf(version: PoemVersion): VersionBaseline | undefined {
    return version.baseline;
  }

  /** 当前稿相对基线的改动数。 */
  pendingChangeCount(version: PoemVersion = this.activeVersion()): number {
    if (!version.baseline) return 0;
    return buildChanges(version.baseline, version.text, version.marks).length;
  }

  // ─── 离线校勘包：导出 ────────────────────────────────────────────

  exportCollationPackage(name: string): { fileName: string; json: string; changeCount: number } {
    const workspace = this.workspace();
    if (!workspace.editor?.trim()) throw new PackageValidationError('请先在顶部填写整理者署名再导出。');
    const version = this.activeVersion();
    if (!version.baseline) this.captureBaseline(version.id);
    const baseline = this.activeVersion().baseline!;
    const changes = buildChanges(baseline, version.text, version.marks);
    const now = new Date().toISOString();
    const pkg: CollationPackage = {
      kind: 'classical-poetry-collation-package',
      schema: PACKAGE_SCHEMA_VERSION,
      packageId: uid('pkg'),
      name: name.trim() || `${version.name} · 校勘包`,
      poemId: workspace.poemId ?? '',
      title: workspace.title,
      editor: workspace.editor.trim(),
      exportedAt: now,
      targetVersionId: version.id,
      targetVersionName: version.name,
      baseline: clone(baseline),
      changes,
    };
    const json = JSON.stringify(pkg, null, 2);
    return { fileName: `${workspace.title}-${pkg.name}.校勘包.json`, json, changeCount: changes.length };
  }

  downloadCollationPackage(name: string): void {
    const { fileName, json, changeCount } = this.exportCollationPackage(name);
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    this.toast.set(`校勘包已导出（基线与署名已写入，${changeCount} 处改动）`);
  }

  // ─── 离线校勘包：导入与检查点 ────────────────────────────────────

  async importCollationPackage(file: File): Promise<ImportReport> {
    const text = await file.text();
    let packageJson = text;
    let pkg: CollationPackage;
    let migrated = false;
    const warnings: string[] = [];
    try {
      const result = migratePackage(JSON.parse(text));
      pkg = result.package;
      migrated = result.migrated;
      warnings.push(...result.warnings);
    } catch (error) {
      throw new PackageValidationError(error instanceof Error ? error.message : '校勘包解析失败。');
    }

    if (pkg.poemId && this.workspace().poemId && pkg.poemId !== this.workspace().poemId) {
      throw new PackageValidationError(`校勘包属于《${pkg.title || '另一首诗'}》，与当前作品不一致，已中止导入。`);
    }

    // 同一包再导入：只保留一条登记，不重复落字、不重复记异文。
    const already = this.workspace().collation?.importedPackages.some((item) => item.packageId === pkg.packageId);
    const target = this.resolveTargetVersion(pkg);
    if (already) {
      const report: ImportReport = {
        ok: true,
        duplicated: true,
        migrated,
        warnings,
        applied: 0,
        conflicts: 0,
        annotations: 0,
        readings: 0,
        targetVersionName: target?.name ?? '',
        message: '该校勘包此前已导入，按同一包不重复记录处理。',
      };
      this.lastImportReport.set(report);
      this.toast.set(report.message);
      return report;
    }
    if (!target) throw new PackageValidationError('校勘包找不到对应版本，当前工作区无法对账。');

    // 导入检查点：先落盘，失败后可从此重试。
    const checkpoint: ImportCheckpoint = {
      savedAt: new Date().toISOString(),
      fileName: file.name,
      packageId: pkg.packageId,
      packageName: pkg.name,
      editor: pkg.editor,
      packageJson,
      workspace: clone(this.workspace()),
      failed: false,
    };
    this.saveCheckpoint(checkpoint);

    try {
      const report = this.applyPackage(pkg, target.id, migrated, warnings, file.name);
      this.clearCheckpoint();
      this.lastImportReport.set(report);
      this.toast.set(report.message);
      return report;
    } catch (error) {
      // 导入失败：工作区回到检查点保存的导入前快照，避免半截写入。
      this.workspace.set(migrateWorkspace(clone(checkpoint.workspace)));
      try {
        this.persist();
      } catch {
        // 落盘本身故障时至少保证内存状态已回滚，检查点仍可重试。
      }
      const failed: ImportCheckpoint = {
        ...checkpoint,
        failed: true,
        error: error instanceof Error ? error.message : String(error),
      };
      this.saveCheckpoint(failed);
      this.importCheckpoint.set(failed);
      throw error;
    }
  }

  /** 导入失败后从检查点重试：以导入前快照为基底重放同一包。 */
  retryImportFromCheckpoint(): ImportReport | null {
    const checkpoint = this.importCheckpoint();
    if (!checkpoint?.failed) return null;
    let pkg: CollationPackage;
    try {
      pkg = migratePackage(JSON.parse(checkpoint.packageJson)).package;
    } catch (error) {
      throw new PackageValidationError(error instanceof Error ? error.message : '检查点中的校勘包已损坏。');
    }
    // 回到导入前快照后重放。
    this.workspace.set(migrateWorkspace(clone(checkpoint.workspace)));
    this.persist();
    const target = this.resolveTargetVersion(pkg);
    if (!target) throw new PackageValidationError('检查点重试失败：对应版本已不存在。');
    const replayed: ImportCheckpoint = { ...checkpoint, failed: false, savedAt: new Date().toISOString() };
    this.saveCheckpoint(replayed);
    try {
      const report = this.applyPackage(pkg, target.id, false, ['由失败检查点重试导入。'], checkpoint.fileName);
      this.clearCheckpoint();
      this.lastImportReport.set(report);
      this.toast.set(`检查点重试成功：${report.message}`);
      return report;
    } catch (error) {
      const failedAgain: ImportCheckpoint = {
        ...replayed,
        failed: true,
        error: error instanceof Error ? error.message : String(error),
      };
      this.saveCheckpoint(failedAgain);
      this.importCheckpoint.set(failedAgain);
      throw error;
    }
  }

  discardCheckpoint(): void {
    this.clearCheckpoint();
    this.toast.set('已放弃该检查点');
  }

  private resolveTargetVersion(pkg: CollationPackage): PoemVersion | undefined {
    const state = this.workspace();
    return (
      state.versions.find((version) => version.id === pkg.targetVersionId) ??
      state.versions.find((version) => version.name === pkg.targetVersionName) ??
      state.versions.find((version) => version.id === state.activeVersionId) ??
      state.versions[0]
    );
  }

  private applyPackage(
    pkg: CollationPackage,
    targetVersionId: string,
    migrated: boolean,
    warnings: string[],
    fileName: string,
  ): ImportReport {
    let applied = 0;
    let conflictCount = 0;
    let annotationCount = 0;
    let readingCount = 0;
    const legacy = pkg.baseline?.revision === 'legacy';
    const now = new Date().toISOString();

    this.commit((workspace) => {
      const collation = workspace.collation ?? { pendingConflicts: [], importedPackages: [] };
      workspace.collation = collation;
      const target = workspace.versions.find((version) => version.id === targetVersionId);
      if (!target) throw new PackageValidationError('目标版本在应用阶段消失，已中止。');
      target.readings = target.readings ?? {};
      target.annotations = target.annotations ?? {};
      const targetReadings = target.readings;
      const targetAnnotations = target.annotations;

      pkg.changes.forEach((change) => {
        const ck = cellKey(change.line, change.position);
        const incomingChar = change.char || change.baseChar;
        const changedIncomingChar = incomingChar !== '' && incomingChar !== change.baseChar;

        // 不同的字都保留来源（含冲突字位与旧稿异文）。
        if (changedIncomingChar) {
          const reading: SourcedReading = { ...makeReading(change, pkg), adopted: false };
          const before = targetReadings[ck]?.length ?? 0;
          targetReadings[ck] = mergeReadings(targetReadings[ck], reading);
          if (targetReadings[ck].length > before) readingCount += 1;
        }

        // 批注与依据只追加来源，绝不覆盖已有内容。
        const annotations = makeAnnotations(change, pkg);
        if (annotations.length) {
          const before = targetAnnotations[ck]?.length ?? 0;
          targetAnnotations[ck] = mergeAnnotations(targetAnnotations[ck], annotations);
          annotationCount += Math.max(0, targetAnnotations[ck].length - before);
          target.marks[ck] = { ...defaultMark(), ...target.marks[ck] };
          const mark = target.marks[ck];
          (['basis', 'note'] as const).forEach((field) => {
            const incomingText = change.mark?.[field] ?? '';
            if (incomingText && !mark[field]) mark[field] = incomingText;
          });
        }

        const result = reconcileChange(change, pkg.baseline, target);
        const isConflict = Boolean(result.conflict);

        // 旧稿无基线：异文与批注保留来源即可，不阻塞为待确认冲突。
        if (isConflict && !legacy) {
          const conflict = buildConflict(result.conflict!, pkg, target.id, now);
          if (!collation.pendingConflicts.some((item) => item.id === conflict.id)) {
            collation.pendingConflicts.push(conflict);
            conflictCount += 1;
          }
          // 冲突来字仍记入异文来源（上面已追加），不覆盖正文。
          const list = targetReadings[ck];
          if (list) list[list.length - 1] = { ...list[list.length - 1], adopted: false };
          return;
        }

        // 可自动合并：落字。旧稿无基线时，异文仅登记来源，不覆盖当前用字。
        const currentChar = charAt(target.text, change.line, change.position);
        if (changedIncomingChar && incomingChar !== currentChar && !legacy) {
          const replaced = replaceCharAt(target.text, change.line, change.position, incomingChar);
          if (replaced !== target.text) {
            target.text = replaced;
            applied += 1;
          }
          const list = targetReadings[ck];
          if (list) {
            const idx = list.findIndex((item) => item.packageId === pkg.packageId && item.char === incomingChar);
            if (idx >= 0) list[idx] = { ...list[idx], adopted: true };
          }
        }

        // 可自动合并：逐字段落标注（批注/依据仅在原值为空时补写）。旧稿标注不覆盖。
        if (change.mark && !legacy) {
          const incoming = normalizeMark(change.mark);
          const base = change.baseMark ? normalizeMark(change.baseMark) : defaultMark();
          target.marks[ck] = { ...defaultMark(), ...target.marks[ck] };
          const mark = target.marks[ck];
          let markTouched = false;
          (['tone', 'rhyme', 'pauseAfter'] as const).forEach((field) => {
            const incomingChanged = incoming[field] !== base[field];
            if (!incomingChanged) return;
            if (field === 'tone' && incoming.tone === '?') return;
            if (mark[field] !== incoming[field]) {
              (mark as CharacterMark)[field] = incoming[field] as never;
              markTouched = true;
            }
          });
          (['basis', 'note'] as const).forEach((field) => {
            if (incoming[field] && incoming[field] !== base[field] && !mark[field]) {
              mark[field] = incoming[field];
              markTouched = true;
            }
          });
          if (markTouched && !changedIncomingChar) applied += 1;
        }
      });

      collation.importedPackages.push({
        packageId: pkg.packageId,
        name: pkg.name,
        editor: pkg.editor,
        exportedAt: pkg.exportedAt,
        importedAt: now,
        changeCount: pkg.changes.length,
        applied,
        conflicts: conflictCount,
      });
    });

    const targetName = this.workspace().versions.find((version) => version.id === targetVersionId)?.name ?? '';
    const parts: string[] = [];
    if (applied) parts.push(`自动合并 ${applied} 处`);
    if (conflictCount) parts.push(`${conflictCount} 处冲突待确认`);
    if (annotationCount) parts.push(`保留 ${annotationCount} 条来源批注`);
    if (readingCount) parts.push(`登记 ${readingCount} 条异文来源`);
    if (!parts.length) parts.push('无新增改动');
    const message = `《${targetName}》导入完成：${parts.join('，')}。`;
    return {
      ok: true,
      duplicated: false,
      migrated,
      warnings,
      applied,
      conflicts: conflictCount,
      annotations: annotationCount,
      readings: readingCount,
      targetVersionName: targetName,
      message: migrated ? `${message}（旧稿包已升级兼容${legacy ? '，异文按来源保留' : ''}；${fileName}）` : message,
    };
  }

  // ─── 冲突裁决 ────────────────────────────────────────────────────

  /** 定位到冲突字位。 */
  locateConflict(conflict: PendingConflict): void {
    this.selectVersion(conflict.versionId);
    this.selectCell(conflict.line, conflict.position);
  }

  /**
   * 裁决待确认冲突。
   * - incoming：采纳来字/来注，覆盖当前字位（异文来源仍保留本机读法）；
   * - current：保留本字，来字仅作异文来源；
   * - both：本字不动，来字并存为异文。
   */
  resolveConflict(conflictId: string, resolution: 'incoming' | 'current' | 'both'): void {
    this.commit((workspace) => {
      const collation = workspace.collation!;
      const conflict = collation.pendingConflicts.find((item) => item.id === conflictId);
      if (!conflict || conflict.status !== 'pending') return;
      const version = workspace.versions.find((item) => item.id === conflict.versionId);
      if (!version) return;
      version.readings = version.readings ?? {};
      version.annotations = version.annotations ?? {};
      const readings = version.readings;
      const ck = conflict.cellKey;

      if (resolution === 'incoming') {
        if (conflict.fields.includes('text') && conflict.incomingChar) {
          // 采纳来字前，把本字也作为异文来源留存，避免丢失。
          if (conflict.currentChar && conflict.currentChar !== conflict.incomingChar) {
            readings[ck] = mergeReadings(readings[ck], {
              char: conflict.currentChar,
              editor: workspace.editor || '本机',
              packageId: 'local-current',
              packageName: '本机现稿',
              at: new Date().toISOString(),
              adopted: false,
            });
          }
          version.text = replaceCharAt(version.text, conflict.line, conflict.position, conflict.incomingChar);
          const list = readings[ck];
          if (list) {
            const idx = list.findIndex((item) => item.packageId === conflict.packageId && item.char === conflict.incomingChar);
            if (idx >= 0) list[idx] = { ...list[idx], adopted: true };
          }
        }
        if (conflict.incomingMark) {
          version.marks[ck] = { ...defaultMark(), ...version.marks[ck] };
          (['tone', 'rhyme', 'pauseAfter', 'basis', 'note'] as const).forEach((field) => {
            if (!conflict.fields.includes(field)) return;
            const value = conflict.incomingMark![field];
            if (field === 'tone' && value === '?') return;
            if (field === 'basis' || field === 'note') {
              // 批注/依据不覆盖，仅当为空时补入。
              if (value && !version.marks[ck][field]) version.marks[ck][field] = value as never;
            } else {
              version.marks[ck][field] = value as never;
            }
          });
        }
      } else {
        // current / both：本字与本注不动；来字确保已在异文来源中（导入时已登记）。
        const list = readings[ck];
        if (list && resolution === 'both') {
          const idx = list.findIndex((item) => item.packageId === conflict.packageId && item.char === conflict.incomingChar);
          if (idx >= 0) list[idx] = { ...list[idx], adopted: false };
        }
      }

      conflict.status = 'resolved';
      conflict.resolution = resolution;
      collation.pendingConflicts = collation.pendingConflicts.filter((item) => item.id !== conflictId);
    });
    this.toast.set(resolution === 'incoming' ? '已采纳来稿字位' : resolution === 'both' ? '已并存为异文' : '已保留本机字位');
  }

  // ─── 导出校对稿 ──────────────────────────────────────────────────

  exportProofreadCopy(): string {
    const workspace = this.workspace();
    const active = this.activeVersion();
    const lines = this.analysis().map((line) => {
      const tags = line.cells.map((cell) => `${cell.char}${cell.actual === '?' ? '□' : `(${cell.actual})`}`).join(' ');
      return `第 ${line.index + 1} 句：${tags}`;
    });
    const notes = this.issues().map((issue) => `[${issue.level.toUpperCase()}] ${issue.title}：${issue.detail}`);
    const sections = [
      `# ${workspace.title} · 格律校对稿`,
      '',
      `底本：${active.name}`,
      `出处：${active.source}`,
      `整理者：${workspace.editor || '未署名'}`,
      '',
      '## 字音标注',
      ...lines,
      '',
      '## 检查记录',
      ...notes,
    ];
    if (active.baseline) {
      sections.push('', '## 合并基线', `基线版本：${active.baseline.versionName}`, `修订号：${active.baseline.revision}`, `确立时间：${active.baseline.capturedAt}`);
    }
    const allReadings = Object.entries(active.readings ?? {}).filter(([, list]) => list.length);
    if (allReadings.length) {
      sections.push('', '## 异文来源（按字位）');
      allReadings.forEach(([ck, list]) => {
        const [line, position] = ck.split(':');
        const detail = list.map((item) => `「${item.char}」${item.adopted ? '（采用）' : ''}— ${item.editor}${item.packageName ? `·${item.packageName}` : ''}`).join('；');
        sections.push(`- 第 ${Number(line) + 1} 句第 ${Number(position) + 1} 字：${detail}`);
      });
    }
    const allAnnotations = Object.entries(active.annotations ?? {}).filter(([, list]) => list.length);
    if (allAnnotations.length) {
      sections.push('', '## 来源批注');
      allAnnotations.forEach(([ck, list]) => {
        const [line, position] = ck.split(':');
        list.forEach((item) => {
          sections.push(`- 第 ${Number(line) + 1} 句第 ${Number(position) + 1} 字〔${item.kind === 'note' ? '批注' : '依据'}}〕${item.text} — ${item.editor}`);
        });
      });
    }
    const pending = this.activeConflicts();
    if (pending.length) {
      sections.push('', '## 待确认冲突');
      pending.forEach((conflict) => {
        sections.push(`- 第 ${conflict.line + 1} 句第 ${conflict.position + 1} 字：${conflict.reason}（${conflict.editor}）`);
      });
    }
    return sections.join('\n');
  }

  downloadProofreadCopy(): void {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([this.exportProofreadCopy()], { type: 'text/markdown;charset=utf-8' }));
    anchor.download = `${this.workspace().title}-格律校对稿.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  selectedCell(): AnalysisCell | undefined {
    return this.analysis()[this.selectedLine()]?.cells[this.selectedPosition()];
  }

  hasConflict(line: number, position: number): boolean {
    return Boolean(this.conflictAt(line, position));
  }

  private commit(mutator: (workspace: PoemWorkspace) => void): void {
    this.undoStack.push(clone(this.workspace()));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.workspace());
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.workspace.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(0);
    this.persist();
  }

  private versionIn(workspace: PoemWorkspace): PoemVersion {
    const version = workspace.versions.find((item) => item.id === workspace.activeVersionId) ?? workspace.versions[0];
    return version;
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.workspace()));
  }

  private saveCheckpoint(checkpoint: ImportCheckpoint): void {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    this.importCheckpoint.set(checkpoint);
  }

  private clearCheckpoint(): void {
    localStorage.removeItem(CHECKPOINT_KEY);
    this.importCheckpoint.set(null);
  }

  private isAcceptableVariant(template: MeterTemplate, line: number, position: number): boolean {
    if (template.lineLength === 5) return position === 0 || position === 2;
    return position === 0 || position === 2 || position === 4;
  }
}

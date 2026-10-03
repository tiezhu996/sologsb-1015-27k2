import { computed, Injectable, signal } from '@angular/core';
import type {
  AntithesisPair,
  AnalysisCell,
  AnalysisLine,
  CharacterMark,
  CharDiff,
  MarkTone,
  MeterTemplate,
  PoemIssue,
  PoemVersion,
  PoemWorkspace,
  Tone,
} from '../models/poem.models';
import type {
  EditorProfile,
  FailedImportCheckpoint,
  ImportLogEntry,
  ImportOutcome,
  JiaoKanPackage,
  MergeCounters,
  PositionVariants,
} from '../collation/collation.models';
import {
  buildPackage,
  captureBaseline,
  checkpointOf,
  isImportLogged,
  markKey,
  mergeChange,
  migratePackage,
  replaceCharAt,
  toPoemCells,
  type MergeState,
} from '../collation/collation.engine';

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
  return `${line}:${position}`;
}

function defaultMark(): CharacterMark {
  return { tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' };
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

  const variants = spring.replace('处处闻啼鸟', '处处闻啼鸟');
  const topVersion: PoemVersion = {
    id: 'version-main',
    name: '通行本 · 孟浩然集',
    source: '《孟浩然诗集笺注》',
    createdAt: now,
    text: variants,
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
  const baseline = captureBaseline(topVersion, now);
  return {
    title: '春晓',
    author: '孟浩然',
    templateId: 'wuyan-zeqi',
    versions: [topVersion, variant],
    activeVersionId: topVersion.id,
    updatedAt: now,
    editor: { id: 'editor-local', name: '主校整理者', room: '校样室 · 主机位' },
    baseline,
    baselineVersionId: topVersion.id,
    variantsLedger: {},
    pendingConflicts: [],
    importLog: [],
    importCheckpoints: [],
  };
}

/** 兼容旧版本地存档：补齐基线、整理者与合台账字段。 */
function upgradeWorkspace(parsed: PoemWorkspace): PoemWorkspace {
  const now = new Date().toISOString();
  const baseVersion = parsed.versions.find((version) => version.id === parsed.baselineVersionId) ?? parsed.versions[0];
  return {
    ...parsed,
    editor: parsed.editor ?? { id: 'editor-local', name: '主校整理者', room: '校样室 · 主机位' },
    baseline: parsed.baseline ?? (baseVersion ? captureBaseline(baseVersion, now) : null),
    baselineVersionId: parsed.baselineVersionId ?? baseVersion?.id ?? '',
    variantsLedger: parsed.variantsLedger ?? {},
    pendingConflicts: parsed.pendingConflicts ?? [],
    importLog: parsed.importLog ?? [],
    importCheckpoints: parsed.importCheckpoints ?? [],
  };
}

function loadWorkspace(): PoemWorkspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialWorkspace();
    const parsed = JSON.parse(raw) as PoemWorkspace;
    return parsed.versions?.length ? upgradeWorkspace(parsed) : initialWorkspace();
  } catch {
    return initialWorkspace();
  }
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
  readonly lastImport = signal<ImportOutcome | null>(null);

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

  readonly analysis = computed<AnalysisLine[]>(() => {
    const version = this.activeVersion();
    const template = this.template();
    return this.lines().map((line, lineIndex) => {
      const chars = Array.from(line).filter((char) => !PUNCTUATION.has(char));
      const cells: AnalysisCell[] = chars.map((char, position) => {
        const mark = version.marks[key(lineIndex, position)] ?? defaultMark();
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
        return { char, position, expected, actual, status, message, mark };
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
    this.workspace.set(previous);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persist();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.workspace()));
    this.workspace.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persist();
  }

  exportProofreadCopy(): string {
    const active = this.activeVersion();
    const lines = this.analysis().map((line) => {
      const tags = line.cells.map((cell) => `${cell.char}${cell.actual === '?' ? '□' : `(${cell.actual})`}`).join(' ');
      return `第 ${line.index + 1} 句：${tags}`;
    });
    const notes = this.issues().map((issue) => `[${issue.level.toUpperCase()}] ${issue.title}：${issue.detail}`);
    return [`# ${this.workspace().title} · 格律校对稿`, '', `底本：${active.name}`, `出处：${active.source}`, '', '## 字音标注', ...lines, '', '## 检查记录', ...notes].join('\n');
  }

  downloadProofreadCopy(): void {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([this.exportProofreadCopy()], { type: 'text/markdown;charset=utf-8' }));
    anchor.download = `${this.workspace().title}-格律校对稿.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  /* ---------------------------------------------------------------- */
  /* 基线 · 整理者 · 校勘包                                            */
  /* ---------------------------------------------------------------- */

  readonly pendingConflicts = computed(() => this.workspace().pendingConflicts.filter((item) => item.status === 'pending'));
  readonly importLog = computed(() => [...this.workspace().importLog].sort((a, b) => b.importedAt.localeCompare(a.importedAt)));
  readonly checkpoints = computed(() => this.workspace().importCheckpoints);

  /** 当前工作区基线（未建立时返回 null）。 */
  readonly baseline = computed(() => this.workspace().baseline);

  updateEditor(patch: Partial<EditorProfile>): void {
    this.commit((workspace) => {
      workspace.editor = { ...workspace.editor, ...patch };
    });
  }

  /** 以指定版本（默认当前版本）保存修改基线，之后导出的校勘包都携带它。 */
  saveBaseline(versionId?: string): void {
    const workspace = this.workspace();
    const version = workspace.versions.find((item) => item.id === (versionId ?? workspace.activeVersionId)) ?? workspace.versions[0];
    const baseline = captureBaseline(version, new Date().toISOString());
    this.commit((next) => {
      next.baseline = baseline;
      next.baselineVersionId = version.id;
    });
    this.toast.set(`已保存基线：${version.name}`);
  }

  /** 导出当前校勘稿相对基线的校勘包（JSON，内含整理者与基线信息）。 */
  exportJiaoKanPackage(): JiaoKanPackage {
    const workspace = this.workspace();
    let baseline = workspace.baseline;
    if (!baseline) {
      // 尚未保存过基线时，以主版本建立基线，保证离线可对账。
      baseline = captureBaseline(workspace.versions[0], new Date().toISOString());
      this.commit((next) => {
        next.baseline = baseline;
        next.baselineVersionId = next.versions[0].id;
      });
    }
    const version = this.activeVersion();
    return buildPackage({
      poemTitle: workspace.title,
      editor: workspace.editor,
      baseline,
      version: { id: version.id, name: version.name, source: version.source, text: version.text, marks: version.marks },
    }, new Date().toISOString());
  }

  downloadJiaoKanPackage(): void {
    const pkg = this.exportJiaoKanPackage();
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' }));
    anchor.download = `校勘包-${pkg.editor.name}-${pkg.packageId}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    this.toast.set(`校勘包 ${pkg.packageId} 已导出（含基线与整理者）`);
  }

  /**
   * 导入校勘包文本。
   * @param rawText 校勘包 JSON 文本
   * @param failAfterChange 演练用：处理到第 N 条改动时模拟断电，用于验证检查点重试。
   */
  importJiaoKanPackage(rawText: string, failAfterChange?: number): ImportOutcome {
    let migrated: ReturnType<typeof migratePackage>;
    try {
      migrated = migratePackage(JSON.parse(rawText), {
        title: this.workspace().title,
        versions: this.workspace().versions.map((version) => ({
          id: version.id, name: version.name, source: version.source, text: version.text, marks: version.marks,
        })),
      });
    } catch (error) {
      const outcome: ImportOutcome = {
        ok: false, packageId: '', editorName: '', applied: 0, conflicts: 0, anomalies: 0, skipped: 0,
        blockedFields: 0, pendingTotal: this.pendingConflicts().length, legacy: false,
        message: `校勘包无法解析：${(error as Error).message}`, hardError: (error as Error).message,
      };
      this.lastImport.set(outcome);
      this.toast.set(outcome.message);
      return outcome;
    }

    const pkg = migrated.pkg;
    const workspace = this.workspace();
    if (isImportLogged(workspace.importLog, pkg.packageId) && !checkpointOf(workspace.importCheckpoints, pkg.packageId)) {
      const outcome: ImportOutcome = {
        ok: true, duplicate: true, packageId: pkg.packageId, editorName: pkg.editor.name,
        applied: 0, conflicts: 0, anomalies: 0, skipped: pkg.changes.length, blockedFields: 0,
        pendingTotal: this.pendingConflicts().length, legacy: migrated.legacy,
        message: `校勘包 ${pkg.packageId} 已导入过，未重复生成记录`,
      };
      this.lastImport.set(outcome);
      this.toast.set('同一校勘包再次导入：已忽略，只保留原记录');
      return outcome;
    }

    const resumedCheckpoint = checkpointOf(workspace.importCheckpoints, pkg.packageId);
    const now = new Date().toISOString();
    const target = workspace.versions.find((version) => version.id === pkg.baseline.versionId)
      ?? workspace.versions.find((version) => version.id === workspace.baselineVersionId)
      ?? workspace.versions[0];

    const state: MergeState = {
      text: target.text,
      marks: clone(target.marks),
      variants: clone(workspace.variantsLedger),
      conflicts: clone(workspace.pendingConflicts),
      appliedPositions: resumedCheckpoint ? [...resumedCheckpoint.appliedPositions] : [],
    };
    const seen = new Set<string>();
    const counters: MergeCounters = resumedCheckpoint
      ? { ...resumedCheckpoint.counters }
      : { applied: 0, conflicts: 0, anomalies: 0, skipped: 0, blockedFields: 0 };

    const start = resumedCheckpoint?.nextIndex ?? 0;
    let interrupted = false;
    let hardError: string | undefined;
    let nextIndex = start;

    try {
      for (let index = start; index < pkg.changes.length; index += 1) {
        if (failAfterChange !== undefined && index === start + failAfterChange) {
          throw new Error('导入在中途中断（演练）');
        }
        mergeChange(state, pkg.changes[index], pkg, seen, counters, now, resumedCheckpoint?.packageId);
        nextIndex = index + 1;
      }
    } catch (error) {
      interrupted = true;
      hardError = (error as Error).message;
      const checkpoint: FailedImportCheckpoint = {
        packageId: pkg.packageId,
        pkg,
        nextIndex,
        total: pkg.changes.length,
        appliedPositions: state.appliedPositions,
        counters: { ...counters },
        startedAt: resumedCheckpoint?.startedAt ?? now,
        updatedAt: new Date().toISOString(),
        attempts: (resumedCheckpoint?.attempts ?? 0) + 1,
        legacy: migrated.legacy,
        lastError: hardError,
      };
      // 中断也把已对账部分落盘，避免前功尽弃；检查点记录续跑位置。
      this.commit((next) => {
        const targetVersion = this.findVersion(next, target.id);
        targetVersion.text = state.text;
        targetVersion.marks = state.marks;
        next.variantsLedger = state.variants;
        next.pendingConflicts = state.conflicts;
        const others = next.importCheckpoints.filter((item) => item.packageId !== pkg.packageId);
        others.push(checkpoint);
        next.importCheckpoints = others;
        this.upsertLogEntry(next, {
          packageId: pkg.packageId,
          editorName: pkg.editor.name,
          exportedAt: pkg.exportedAt,
          importedAt: checkpoint.startedAt,
          status: 'failed',
          appliedChanges: counters.applied,
          conflicts: counters.conflicts,
          anomalies: counters.anomalies,
          skipped: counters.skipped,
          blockedFields: counters.blockedFields,
          legacy: migrated.legacy,
          attempts: checkpoint.attempts,
          lastError: hardError,
        });
      });
      const outcome: ImportOutcome = {
        ok: false, interrupted: true, resumed: !!resumedCheckpoint, packageId: pkg.packageId,
        editorName: pkg.editor.name, ...counters,
        pendingTotal: state.conflicts.filter((item) => item.status === 'pending').length,
        legacy: migrated.legacy, message: `导入在第 ${checkpoint.nextIndex + 1}/${pkg.changes.length} 条处中断，已存检查点，可重试续跑`,
        hardError,
      };
      this.lastImport.set(outcome);
      this.toast.set(outcome.message);
      return outcome;
    }

    const pendingTotal = state.conflicts.filter((item) => item.status === 'pending').length;
    const status = pendingTotal > 0 ? 'partial' as const : 'applied' as const;
    this.commit((next) => {
      const targetVersion = this.findVersion(next, target.id);
      targetVersion.text = state.text;
      targetVersion.marks = state.marks;
      next.variantsLedger = state.variants;
      next.pendingConflicts = state.conflicts;
      next.importCheckpoints = next.importCheckpoints.filter((item) => item.packageId !== pkg.packageId);
      this.upsertLogEntry(next, {
        packageId: pkg.packageId,
        editorName: pkg.editor.name,
        exportedAt: pkg.exportedAt,
        importedAt: resumedCheckpoint?.startedAt ?? now,
        finishedAt: new Date().toISOString(),
        status,
        appliedChanges: counters.applied,
        conflicts: counters.conflicts,
        anomalies: counters.anomalies,
        skipped: counters.skipped,
        blockedFields: counters.blockedFields,
        legacy: migrated.legacy,
        attempts: (resumedCheckpoint?.attempts ?? 0) + 1,
      });
    });

    const outcome: ImportOutcome = {
      ok: true, resumed: !!resumedCheckpoint, interrupted: false, packageId: pkg.packageId,
      editorName: pkg.editor.name, ...counters, pendingTotal, legacy: migrated.legacy,
      message: resumedCheckpoint
        ? `已从检查点续跑完成：并入 ${counters.applied} 处，待确认 ${pendingTotal} 处`
        : status === 'partial'
          ? `导入完成：并入 ${counters.applied} 处，${pendingTotal} 处冲突已放入待确认`
          : `导入完成：并入 ${counters.applied} 处，无冲突`,
    };
    this.lastImport.set(outcome);
    this.toast.set(outcome.message);
    return outcome;
  }

  /** 从失败检查点重试指定校勘包。 */
  retryImport(packageId: string): ImportOutcome | null {
    const checkpoint = this.workspace().importCheckpoints.find((item) => item.packageId === packageId);
    if (!checkpoint) return null;
    return this.importJiaoKanPackage(JSON.stringify(checkpoint.pkg));
  }

  retryAllImports(): void {
    const ids = this.workspace().importCheckpoints.map((item) => item.packageId);
    ids.forEach((id) => this.retryImport(id));
  }

  /** 待确认处处置：采用来字 / 保留本字 / 暂不处理。 */
  resolveConflict(id: string, decision: 'accepted' | 'kept-local'): void {
    this.commit((workspace) => {
      const conflict = workspace.pendingConflicts.find((item) => item.id === id);
      if (!conflict || conflict.status !== 'pending') return;
      conflict.status = decision;
      conflict.resolvedAt = new Date().toISOString();
      const target = workspace.versions.find((version) => version.id === workspace.baselineVersionId) ?? workspace.versions[0];
      // 以当前文本的字位坐标为准（导入可能已改动过前后字位）。
      const cell = toPoemCells(target.text)[conflict.pos];
      if (decision === 'accepted' && conflict.incoming) {
        target.text = replaceCharAt(target.text, conflict.pos, conflict.incoming);
      }
      if (conflict.incomingMarkPatch && cell) {
        // 处置时同样只填补空缺标注，已有判断不覆盖。
        const k = markKey(cell.line, cell.ch);
        const current = target.marks[k];
        const fill: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(conflict.incomingMarkPatch)) {
          if (field === 'note') continue;
          const existing = current?.[field as keyof CharacterMark];
          const empty = existing === undefined || existing === '' || existing === false || existing === '?';
          if (empty && value !== undefined && value !== '') fill[field] = value;
        }
        if (Object.keys(fill).length) {
          target.marks[k] = { ...{ tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' }, ...(current ?? {}), ...fill } as CharacterMark;
        }
      }
    });
    this.toast.set(decision === 'accepted' ? '已采用来字并记录来源' : '已保留本字，来源仍留台账');
  }

  /** 取某字位的异文与批注台账。 */
  ledgerAt(line: number, ch: number): PositionVariants | undefined {
    return this.workspace().variantsLedger[markKey(line, ch)];
  }

  private findVersion(workspace: PoemWorkspace, id: string): PoemVersion {
    return workspace.versions.find((version) => version.id === id) ?? workspace.versions[0];
  }

  /** 同一包只保留一条导入记录：失败时更新，成功时定稿。 */
  private upsertLogEntry(workspace: PoemWorkspace, entry: ImportLogEntry): void {
    const index = workspace.importLog.findIndex((item) => item.packageId === entry.packageId);
    if (index === -1) workspace.importLog.push(entry);
    else workspace.importLog[index] = { ...workspace.importLog[index], ...entry };
  }

  /* ---------------------------------------------------------------- */

  selectedCell(): AnalysisCell | undefined {
    return this.analysis()[this.selectedLine()]?.cells[this.selectedPosition()];
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

  private isAcceptableVariant(template: MeterTemplate, line: number, position: number): boolean {
    if (template.lineLength === 5) return position === 0 || position === 2;
    return position === 0 || position === 2 || position === 4;
  }
}

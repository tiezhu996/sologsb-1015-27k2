export type Tone = '平' | '仄' | '中' | '?';
export type MarkTone = '平' | '仄' | '中';

export interface CharacterMark {
  tone: MarkTone | '?';
  rhyme: string;
  pauseAfter: boolean;
  basis: string;
  note: string;
}

export interface AntithesisPair {
  id: string;
  leftLine: number;
  rightLine: number;
  note: string;
}

/** 带来源的异文记录：同一字位出现过的每个字都保留整理者与包号。 */
export interface SourcedReading {
  char: string;
  editor: string;
  packageId: string;
  packageName?: string;
  at: string;
  adopted: boolean;
}

/** 带来源的批注（含校勘依据），按追加方式保留，绝不覆盖已有批注。 */
export interface SourcedAnnotation {
  id: string;
  kind: 'note' | 'basis';
  text: string;
  editor: string;
  packageId: string;
  packageName?: string;
  at: string;
}

/** 某版本被导出/合并时参照的基线快照。 */
export interface VersionBaseline {
  versionId: string;
  versionName: string;
  text: string;
  marks: Record<string, CharacterMark>;
  revision: string;
  capturedAt: string;
}

export interface PoemVersion {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  marks: Record<string, CharacterMark>;
  antithesisPairs: AntithesisPair[];
  /** 该版本最近一次确立的合并基线（含文本与逐字标注）。 */
  baseline?: VersionBaseline;
  /** 逐字位异文来源，键为「句:字位」。 */
  readings?: Record<string, SourcedReading[]>;
  /** 逐字位批注/依据来源。 */
  annotations?: Record<string, SourcedAnnotation[]>;
}

/** 待人工裁决的字位冲突。 */
export interface PendingConflict {
  id: string;
  versionId: string;
  line: number;
  position: number;
  cellKey: string;
  currentChar: string;
  incomingChar: string;
  baselineChar: string;
  editor: string;
  packageId: string;
  packageName?: string;
  note?: string;
  reason: string;
  fields: Array<'text' | 'tone' | 'rhyme' | 'pauseAfter' | 'basis' | 'note'>;
  incomingMark?: CharacterMark;
  status: 'pending' | 'resolved';
  resolution?: 'incoming' | 'current' | 'both';
  createdAt: string;
}

/** 已导入校勘包登记，同一包重复导入只保留一条。 */
export interface ImportedPackageRecord {
  packageId: string;
  name: string;
  editor: string;
  exportedAt: string;
  importedAt: string;
  changeCount: number;
  applied: number;
  conflicts: number;
}

/** 离线合并工作区状态。 */
export interface CollationState {
  pendingConflicts: PendingConflict[];
  importedPackages: ImportedPackageRecord[];
}

export interface PoemWorkspace {
  title: string;
  author: string;
  templateId: string;
  versions: PoemVersion[];
  activeVersionId: string;
  updatedAt: string;
  /** 本机整理者署名，随校勘包导出。 */
  editor?: string;
  /** 作品稳定标识，用于校验导入包是否属于同一首诗。 */
  poemId?: string;
  collation?: CollationState;
}

export interface MeterTemplate {
  id: string;
  name: string;
  summary: string;
  lineCount: number;
  lineLength: number;
  pattern: Tone[];
  rhymeLines: number[];
}

export interface AnalysisCell {
  char: string;
  position: number;
  expected: Tone;
  actual: Tone;
  status: 'correct' | 'variant' | 'error' | 'unknown' | 'neutral';
  message: string;
  mark: CharacterMark;
  readings: SourcedReading[];
  annotations: SourcedAnnotation[];
}

export interface AnalysisLine {
  index: number;
  cells: AnalysisCell[];
  rhymeChars: string[];
  errors: number;
  variants: number;
}

export interface PoemIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  line?: number;
  position?: number;
}

export interface CharDiff {
  index: number;
  left: string;
  right: string;
  changed: boolean;
}

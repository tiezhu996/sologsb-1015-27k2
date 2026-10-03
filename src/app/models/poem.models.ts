export type Tone = '平' | '仄' | '中' | '?';
export type MarkTone = '平' | '仄' | '中';

export interface CharacterMark {
  tone: MarkTone | '?';
  rhyme: string;
  pauseAfter: boolean;
  basis: string;
  note: string;
}

export interface PoemVersion {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  marks: Record<string, CharacterMark>;
  antithesisPairs: AntithesisPair[];
}

export interface AntithesisPair {
  id: string;
  leftLine: number;
  rightLine: number;
  note: string;
}

export interface PoemWorkspace {
  title: string;
  author: string;
  templateId: string;
  versions: PoemVersion[];
  activeVersionId: string;
  updatedAt: string;
  /** 本机整理者：随工作区保存，并写入每个导出的校勘包。 */
  editor: import('../collation/collation.models').EditorProfile;
  /** 修改基线；未建立时为空。 */
  baseline: import('../collation/collation.models').BaselineSnapshot | null;
  /** 被基线锁定的版本 id。 */
  baselineVersionId: string;
  /** 按字位累积的异文与批注台账（跨版本）。 */
  variantsLedger: Record<string, import('../collation/collation.models').PositionVariants>;
  /** 离线合并产生的待确认处。 */
  pendingConflicts: import('../collation/collation.models').PendingConflict[];
  /** 导入记录：同一校勘包只保留一条。 */
  importLog: import('../collation/collation.models').ImportLogEntry[];
  /** 导入失败的检查点，重试成功后清除。 */
  importCheckpoints: import('../collation/collation.models').FailedImportCheckpoint[];
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

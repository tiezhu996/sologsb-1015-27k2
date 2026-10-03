import type { CharacterMark } from '../models/poem.models';

/** 整理者档案：随工作区保存，并写入每一个导出的校勘包。 */
export interface EditorProfile {
  id: string;
  name: string;
  /** 校样室 / 工位，断网回传时用于溯源。 */
  room: string;
}

/** 修改基线：导出与导入对账都以此快照为准。 */
export interface BaselineSnapshot {
  capturedAt: string;
  versionId: string;
  versionName: string;
  text: string;
  /** 逐字标注的基线副本，键为 “句:字”。 */
  marks: Record<string, CharacterMark>;
  /** 每个诗句字位的摘要，用于快速比对基线是否一致。 */
  charHashes: string[];
  /** 全诗字位摘要。 */
  digest: string;
}

/** 异文来源记录：某字位上出现过的一个字及其整理者。 */
export interface ReadingSource {
  char: string;
  editorId: string;
  editorName: string;
  /** 来自哪个校勘包；本地产出记为 local:版本id。 */
  packageId: string;
  receivedAt: string;
}

/** 批注线索：批注只追加、不覆盖。 */
export interface LedgerNote {
  note: string;
  editorId: string;
  editorName: string;
  packageId: string;
  at: string;
}

/** 字位异文台账：不同的字连同来源一并保留。 */
export interface PositionVariants {
  key: string;
  line: number;
  ch: number;
  readings: ReadingSource[];
  notes: LedgerNote[];
}

export type CollationField = 'tone' | 'rhyme' | 'pauseAfter' | 'basis';

/** 一条相对基线的改动：字位坐标 + 基线字 + 来字 + 标注补丁。 */
export interface CollationChange {
  /** 全诗文（不计标点）字位序号。 */
  pos: number;
  line: number;
  /** 句内字位（不计标点）。 */
  ch: number;
  base: string;
  /** 来稿用字；缺省表示只改了标注。 */
  text?: string;
  markPatch?: Partial<CharacterMark>;
  /** 来稿批注：导入时只追加到批注台账，不覆盖字位批注。 */
  note?: string;
}

/** 校勘包（当前格式 v2）。 */
export interface JiaoKanPackage {
  kind: 'jiaokan';
  format: 2;
  /** 内容指纹：整理者 + 基线摘要 + 改动集合相同则包号相同，保证幂等。 */
  packageId: string;
  exportedAt: string;
  poemTitle: string;
  editor: EditorProfile;
  baseline: Pick<BaselineSnapshot, 'capturedAt' | 'versionId' | 'versionName' | 'text' | 'digest' | 'charHashes'>;
  sourceVersion: { id: string; name: string; source: string };
  changes: CollationChange[];
}

export type ConflictReason = 'both-changed' | 'baseline-mismatch' | 'out-of-range';
export type ConflictStatus = 'pending' | 'accepted' | 'kept-local';

/** 待确认处：离线合并时无法自动并入的字位。 */
export interface PendingConflict {
  id: string;
  packageId: string;
  editorId: string;
  editorName: string;
  pos: number;
  line: number;
  ch: number;
  base: string;
  local: string;
  incoming: string;
  reason: ConflictReason;
  detail: string;
  incomingMarkPatch?: Partial<CharacterMark>;
  status: ConflictStatus;
  createdAt: string;
  resolvedAt?: string;
}

export type ImportStatus = 'applied' | 'partial' | 'failed';

/** 导入记录：同一 packageId 永远只有一条。 */
export interface ImportLogEntry {
  packageId: string;
  editorName: string;
  exportedAt: string;
  importedAt: string;
  finishedAt?: string;
  status: ImportStatus;
  appliedChanges: number;
  conflicts: number;
  anomalies: number;
  skipped: number;
  blockedFields: number;
  legacy: boolean;
  attempts: number;
  lastError?: string;
}

/** 导入失败检查点：中断后可从 nextIndex 继续。 */
export interface FailedImportCheckpoint {
  packageId: string;
  pkg: JiaoKanPackage;
  nextIndex: number;
  total: number;
  appliedPositions: number[];
  /** 截至中断时的累计计数，续跑在此基础上累加。 */
  counters: MergeCounters;
  startedAt: string;
  updatedAt: string;
  attempts: number;
  legacy: boolean;
  lastError: string;
}

export interface MergeCounters {
  applied: number;
  conflicts: number;
  anomalies: number;
  skipped: number;
  blockedFields: number;
}

export interface ImportOutcome {
  ok: boolean;
  resumed?: boolean;
  duplicate?: boolean;
  interrupted?: boolean;
  packageId: string;
  editorName: string;
  applied: number;
  conflicts: number;
  anomalies: number;
  skipped: number;
  blockedFields: number;
  pendingTotal: number;
  legacy: boolean;
  message: string;
  hardError?: string;
}

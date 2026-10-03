import type { CharacterMark } from '../models/poem.models';
import type {
  BaselineSnapshot,
  CollationChange,
  CollationField,
  EditorProfile,
  FailedImportCheckpoint,
  ImportLogEntry,
  JiaoKanPackage,
  MergeCounters,
  PendingConflict,
  PositionVariants,
} from './collation.models';

const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t', '\n', '\r']);
const MARK_FIELDS: CollationField[] = ['tone', 'rhyme', 'pauseAfter', 'basis'];

export function isPunctuation(char: string): boolean {
  return PUNCTUATION.has(char);
}

/** 将诗行文本切为“句 → 字位坐标”，标点与换行不计位。 */
export function toPoemCells(text: string): { line: number; ch: number; pos: number; char: string }[] {
  const cells: { line: number; ch: number; pos: number; char: string }[] = [];
  const lines = text.split('\n');
  let pos = 0;
  lines.forEach((lineText, line) => {
    let ch = 0;
    for (const char of Array.from(lineText)) {
      if (PUNCTUATION.has(char)) continue;
      cells.push({ line, ch, pos, char });
      ch += 1;
      pos += 1;
    }
  });
  return cells;
}

export function verseChars(text: string): string[] {
  return Array.from(text).filter((char) => !PUNCTUATION.has(char));
}

export function markKey(line: number, ch: number): string {
  return `${line}:${ch}`;
}

/** djb2 摘要，离线即可计算，仅用于判断字串是否一致。 */
export function digestOf(chars: string[]): string {
  let hash = 5381;
  for (const char of chars.join('')) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function captureBaseline(
  version: { id: string; name: string; text: string; marks: Record<string, CharacterMark> },
  capturedAt: string,
): BaselineSnapshot {
  const cells = toPoemCells(version.text);
  const marks: Record<string, CharacterMark> = {};
  for (const cell of cells) {
    const mark = version.marks[markKey(cell.line, cell.ch)];
    if (mark) marks[markKey(cell.line, cell.ch)] = structuredClone(mark);
  }
  const charHashes = cells.map((cell) => digestOf([cell.char]));
  return {
    capturedAt,
    versionId: version.id,
    versionName: version.name,
    text: version.text,
    marks,
    charHashes,
    digest: digestOf(cells.map((cell) => cell.char)),
  };
}

/** 以基线为参照，逐字位推导改动（文本差异 + 标注差异）。 */
export function diffAgainstBaseline(
  baseline: BaselineSnapshot,
  version: { text: string; marks: Record<string, CharacterMark> },
): CollationChange[] {
  const baseCells = toPoemCells(baseline.text);
  const nowCells = toPoemCells(version.text);
  const changes: CollationChange[] = [];
  baseCells.forEach((baseCell, pos) => {
    const nowCell = nowCells[pos];
    if (!nowCell) {
      changes.push({ pos, line: baseCell.line, ch: baseCell.ch, base: baseCell.char, text: '' });
      return;
    }
    const textChanged = nowCell.char !== baseCell.char;
    const baseMark = baseline.marks[markKey(baseCell.line, baseCell.ch)];
    const nowMark = version.marks[markKey(nowCell.line, nowCell.ch)];
    const patch = markPatch(baseMark, nowMark);
    if (textChanged || Object.keys(patch).length || (nowMark?.note && nowMark.note !== baseMark?.note)) {
      changes.push({
        pos,
        line: nowCell.line,
        ch: nowCell.ch,
        base: baseCell.char,
        ...(textChanged ? { text: nowCell.char } : {}),
        ...(Object.keys(patch).length ? { markPatch: patch } : {}),
        ...(nowMark?.note && nowMark.note !== baseMark?.note ? { note: nowMark.note } : {}),
      });
    }
  });
  for (let pos = baseCells.length; pos < nowCells.length; pos += 1) {
    const nowCell = nowCells[pos];
    const nowMark = version.marks[markKey(nowCell.line, nowCell.ch)];
    const patch = markPatch(undefined, nowMark);
    changes.push({
      pos,
      line: nowCell.line,
      ch: nowCell.ch,
      base: '',
      text: nowCell.char,
      ...(Object.keys(patch).length ? { markPatch: patch } : {}),
      ...(nowMark?.note ? { note: nowMark.note } : {}),
    });
  }
  return changes;
}

function markPatch(
  before: CharacterMark | undefined,
  after: CharacterMark | undefined,
): Partial<CharacterMark> {
  const patch: Partial<CharacterMark> = {};
  for (const field of MARK_FIELDS) {
    const left = before?.[field];
    const right = after?.[field];
    if (after && (right ?? '') !== (left ?? '')) {
      (patch as Record<string, unknown>)[field] = right;
    }
  }
  return patch;
}

export function buildPackage(
  args: {
    poemTitle: string;
    editor: EditorProfile;
    baseline: BaselineSnapshot;
    version: { id: string; name: string; source: string; text: string; marks: Record<string, CharacterMark> };
  },
  exportedAt: string,
): JiaoKanPackage {
  const changes = diffAgainstBaseline(args.baseline, args.version);
  const { marks: _omit, ...baselineHeader } = args.baseline;
  void _omit;
  const pkg: JiaoKanPackage = {
    kind: 'jiaokan',
    format: 2,
    packageId: '',
    exportedAt,
    poemTitle: args.poemTitle,
    editor: args.editor,
    baseline: baselineHeader,
    sourceVersion: { id: args.version.id, name: args.version.name, source: args.version.source },
    changes,
  };
  pkg.packageId = packageFingerprint(pkg);
  return pkg;
}

/** 包号由整理者、基线与改动内容决定：同样内容重复导出仍是同一个包。 */
export function packageFingerprint(pkg: Omit<JiaoKanPackage, 'packageId'>): string {
  const payload = JSON.stringify({
    e: pkg.editor.id,
    b: pkg.baseline.digest,
    bv: pkg.baseline.versionId,
    c: pkg.changes.map((c) => `${c.pos}:${c.text ?? ''}:${c.markPatch ? JSON.stringify(c.markPatch) : ''}`),
  });
  let hash = 5381;
  for (let i = 0; i < payload.length; i += 1) hash = ((hash << 5) + hash + payload.charCodeAt(i)) >>> 0;
  return `jk-${hash.toString(16).padStart(8, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 旧稿校勘包迁移                                                      */
/* ------------------------------------------------------------------ */

export interface MigrationResult {
  pkg: JiaoKanPackage;
  legacy: boolean;
  notes: string[];
}

interface MigrationInput {
  kind?: string;
  format?: number;
  packageId?: string;
  id?: string;
  poemTitle?: string;
  title?: string;
  exportedAt?: string;
  editor?: EditorProfile | string;
  meta?: { editor?: string; exportedAt?: string; baselineVersion?: string; title?: string };
  baselineVersionId?: string;
  baseline?: Partial<JiaoKanPackage['baseline']>;
  sourceVersion?: JiaoKanPackage['sourceVersion'];
  changes?: Array<Partial<CollationChange> & {
    index?: number; position?: number; from?: string; to?: string; mark?: Partial<CharacterMark>;
  }>;
}

/** 识别并升级旧稿校勘包：无格式号的散件(v0)与 format=1 均兼容到 v2。 */
export function migratePackage(raw: unknown, localWorkspace: {
  title: string;
  versions: { id: string; name: string; source: string; text: string; marks: Record<string, CharacterMark> }[];
}): MigrationResult {
  if (!raw || typeof raw !== 'object') throw new Error('校勘包不是有效的 JSON 对象');
  const candidate = raw as MigrationInput;

  if (candidate.kind === 'jiaokan' && candidate.format === 2) {
    return { pkg: normalizeV2(candidate), legacy: false, notes: [] };
  }

  const notes: string[] = [];
  const isV1 = candidate.kind === 'jiaokan' && candidate.format === 1;
  const isV0 = !isV1;
  if (isV0) notes.push('旧稿散件包（无格式号）已按字位迁移升级');
  else notes.push('v1 校勘包已升级为 v2');

  const editor = migrateEditor(candidate.editor ?? candidate.meta?.editor);
  const exportedAt = candidate.exportedAt ?? candidate.meta?.exportedAt ?? new Date(0).toISOString();
  const title = candidate.poemTitle ?? candidate.title ?? candidate.meta?.title ?? localWorkspace.title;

  let baseline: JiaoKanPackage['baseline'];
  if (candidate.baseline && typeof candidate.baseline === 'object' && 'digest' in candidate.baseline) {
    baseline = candidate.baseline as JiaoKanPackage['baseline'];
  } else {
    const versionId = candidate.baseline?.versionId ?? candidate.baselineVersionId ?? candidate.meta?.baselineVersion ?? localWorkspace.versions[0]?.id ?? '';
    const baseVersion = localWorkspace.versions.find((v) => v.id === versionId) ?? localWorkspace.versions[0];
    const snap = captureBaseline(baseVersion, exportedAt);
    baseline = { capturedAt: snap.capturedAt, versionId: snap.versionId, versionName: snap.versionName, text: snap.text, digest: snap.digest, charHashes: snap.charHashes };
    notes.push(`旧包缺少基线快照，已按当前工作区“${baseVersion?.name ?? '主版本'}”补全`);
  }

  const rawChanges = Array.isArray(candidate.changes) ? candidate.changes : [];
  const cells = toPoemCells(baseline.text);
  const changes: CollationChange[] = rawChanges.map((rawChange, i) => {
    // 同时兼容 v1 字位字段（pos/ch/base/text/markPatch/note）与 v0 散件字段（index/from/to）。
    type AnyChange = Partial<CollationChange> & { index?: number; position?: number; from?: string; to?: string; mark?: Partial<CharacterMark> };
    const r = rawChange as AnyChange;
    const pos = r.pos ?? r.index ?? r.position ?? i;
    const cell = cells[pos];
    const base = r.base ?? r.from ?? cell?.char ?? '';
    const text = r.text ?? r.to;
    const markPatchValue: Partial<CharacterMark> = { ...(r.markPatch ?? r.mark ?? {}) };
    return {
      pos,
      line: r.line ?? cell?.line ?? 0,
      ch: r.ch ?? cell?.ch ?? pos,
      base,
      ...(text !== undefined && text !== base ? { text } : {}),
      ...(Object.keys(markPatchValue).length ? { markPatch: markPatchValue } : {}),
      ...(r.note ? { note: r.note } : {}),
    };
  });

  const sourceVersion = candidate.sourceVersion ?? {
    id: baseline.versionId,
    name: baseline.versionName,
    source: '',
  };

  const pkg: JiaoKanPackage = {
    kind: 'jiaokan',
    format: 2,
    packageId: candidate.packageId ?? '',
    exportedAt,
    poemTitle: title,
    editor,
    baseline,
    sourceVersion,
    changes,
  };
  if (!pkg.packageId) pkg.packageId = packageFingerprint(pkg);
  return { pkg, legacy: isV0 || isV1, notes };
}

function migrateEditor(value: unknown): EditorProfile {
  if (value && typeof value === 'object') {
    const v = value as { id?: string; name?: string; room?: string };
    return { id: v.id || 'editor-legacy', name: v.name || '未署名整理者', room: v.room || '旧稿' };
  }
  if (typeof value === 'string') return { id: `editor-${digestOf([value])}`, name: value, room: '旧稿' };
  return { id: 'editor-legacy', name: '未署名整理者', room: '旧稿' };
}

function normalizeV2(candidate: MigrationInput): JiaoKanPackage {
  const pkg: JiaoKanPackage = {
    kind: 'jiaokan',
    format: 2,
    packageId: candidate.packageId ?? '',
    exportedAt: candidate.exportedAt ?? new Date(0).toISOString(),
    poemTitle: candidate.poemTitle ?? '',
    editor: (candidate.editor as EditorProfile) ?? { id: 'editor-legacy', name: '未署名整理者', room: '' },
    baseline: (candidate.baseline as JiaoKanPackage['baseline']) ?? {
      capturedAt: '', versionId: '', versionName: '', text: '', digest: '', charHashes: [],
    },
    sourceVersion: candidate.sourceVersion ?? { id: '', name: '', source: '' },
    changes: Array.isArray(candidate.changes) ? (candidate.changes as unknown as CollationChange[]) : [],
  };
  if (!pkg.packageId) pkg.packageId = packageFingerprint(pkg);
  return pkg;
}

/* ------------------------------------------------------------------ */
/* 按字位对账合并                                                      */
/* ------------------------------------------------------------------ */

export interface MergeState {
  text: string;
  marks: Record<string, CharacterMark>;
  variants: Record<string, PositionVariants>;
  conflicts: PendingConflict[];
  appliedPositions: number[];
}

/** 对一条改动按字位对账，原地改写 state。同一批处理内重复出现的字位跳过（幂等/检查点续跑）。 */
export function mergeChange(
  state: MergeState,
  change: CollationChange,
  pkg: JiaoKanPackage,
  seenPositionPackages: Set<string>,
  counters: MergeCounters,
  now: string,
  /** 本次为检查点续跑：只有检查点中已落盘的本包字位才跳过；跨包字位不跳过。 */
  resumePackageId?: string,
): void {
  const dedupeKey = `${change.pos}`;
  const resumed = resumePackageId === pkg.packageId && state.appliedPositions.includes(change.pos);
  if (seenPositionPackages.has(dedupeKey) || resumed) {
    counters.skipped += 1;
    return;
  }

  const cells = toPoemCells(state.text);
  const incomingText = change.text;
  const localCell = cells[change.pos];
  const localChar = localCell?.char ?? '';

  // 基线一致性核对：包记录的 base 必须与基线/本地吻合，否则标记异常并转待确认。
  const baselineCell = toPoemCells(pkg.baseline.text)[change.pos];
  const baseAgrees = !baselineCell || baselineCell.char === change.base;
  const outOfRange = change.pos >= cells.length && incomingText === undefined;

  const localChangedFromBase = change.base !== localChar;
  const bothChangedText = incomingText !== undefined && incomingText !== localChar && localChangedFromBase && localChar !== '';

  // 字位越界无法对账，直接转待确认。
  if (outOfRange) {
    state.conflicts.push({
      id: `conflict-${pkg.packageId}-${change.pos}`,
      packageId: pkg.packageId,
      editorId: pkg.editor.id,
      editorName: pkg.editor.name,
      pos: change.pos,
      line: localCell?.line ?? change.line,
      ch: localCell?.ch ?? change.ch,
      base: change.base,
      local: localChar,
      incoming: incomingText ?? localChar,
      reason: 'out-of-range',
      detail: '来稿字位超出当前诗文字数',
      incomingMarkPatch: change.markPatch,
      status: 'pending',
      createdAt: now,
    });
    counters.anomalies += 1;
    seenPositionPackages.add(dedupeKey);
    return;
  }

  // 来稿所记底字与基线不符：三方对不上（本地又另有其字），必须人工核对；
  // 唯一例外是本地字恰好等于来字——说明同一修改已从别处并入，按幂等跳过处理。
  if (!baseAgrees && incomingText !== localChar) {
    state.conflicts.push({
      id: `conflict-${pkg.packageId}-${change.pos}`,
      packageId: pkg.packageId,
      editorId: pkg.editor.id,
      editorName: pkg.editor.name,
      pos: change.pos,
      line: localCell?.line ?? change.line,
      ch: localCell?.ch ?? change.ch,
      base: change.base,
      local: localChar,
      incoming: incomingText ?? localChar,
      reason: 'baseline-mismatch',
      detail: '来稿所记底本之字与当前基线不合，需人工核对',
      incomingMarkPatch: change.markPatch,
      status: 'pending',
      createdAt: now,
    });
    counters.anomalies += 1;
    seenPositionPackages.add(dedupeKey);
    return;
  }

  if (bothChangedText) {
    // 双方都改了同一字位且用字不同：保留本地字，异文与来源入待确认。
    state.conflicts.push({
      id: `conflict-${pkg.packageId}-${change.pos}`,
      packageId: pkg.packageId,
      editorId: pkg.editor.id,
      editorName: pkg.editor.name,
      pos: change.pos,
      line: localCell!.line,
      ch: localCell!.ch,
      base: change.base,
      local: localChar,
      incoming: incomingText!,
      reason: 'both-changed',
      detail: `本地作“${localChar}”，${pkg.editor.name} 作“${incomingText}”，两字并存待定`,
      incomingMarkPatch: change.markPatch,
      status: 'pending',
      createdAt: now,
    });
    appendReading(state, localCell!.line, localCell!.ch, localChar, 'local:current', '本稿', pkg, now, true);
    appendReading(state, localCell!.line, localCell!.ch, incomingText!, pkg.packageId, pkg.editor.name, pkg, now, false);
    counters.conflicts += 1;
  } else if (incomingText !== undefined && incomingText !== localChar) {
    // 单方改字：直接采用来字（本地未改）。
    state.text = replaceCharAt(state.text, change.pos, incomingText);
    appendReading(state, localCell!.line, localCell!.ch, change.base, pkg.baseline.versionId || 'baseline', '基线', pkg, now, false);
    appendReading(state, localCell!.line, localCell!.ch, incomingText, pkg.packageId, pkg.editor.name, pkg, now, false);
    counters.applied += 1;
  }

  // 标注合并：仅填补本地空缺；本地已有判断绝不覆盖，计入 blockedFields。
  if (change.markPatch && localCell) {
    const k = markKey(localCell.line, localCell.ch);
    const current = state.marks[k];
    const fill: Record<string, unknown> = {};
    let touched = false;
    for (const [field, value] of Object.entries(change.markPatch)) {
      const currentValue = current?.[field as CollationField];
      const empty = currentValue === undefined || currentValue === '' || currentValue === false || currentValue === '?';
      if (empty && value !== undefined && value !== '') {
        fill[field] = value;
        touched = true;
      } else if (!empty && value !== undefined && value !== currentValue) {
        counters.blockedFields += 1;
      }
    }
    if (Object.keys(fill).length) state.marks[k] = { ...emptyMark(), ...state.marks[k], ...fill } as CharacterMark;
    if (touched && incomingText === undefined) counters.applied += 1;
  }

  // 批注只追加、绝不覆盖（旧包挂在改动上的批注同样如此）。
  const noteText = change.note;
  if (noteText && localCell) {
    const vk = markKey(localCell.line, localCell.ch);
    const ledger = state.variants[vk] ?? { key: vk, line: localCell.line, ch: localCell.ch, readings: [], notes: [] };
    const already = ledger.notes.some((n) => n.packageId === pkg.packageId && n.note === noteText);
    if (!already) ledger.notes.push({ note: noteText, editorId: pkg.editor.id, editorName: pkg.editor.name, packageId: pkg.packageId, at: now });
    state.variants[vk] = ledger;
  }

  seenPositionPackages.add(dedupeKey);
  if (!state.appliedPositions.includes(change.pos)) state.appliedPositions.push(change.pos);
}

function emptyMark(): CharacterMark {
  return { tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' };
}

function appendReading(
  state: MergeState,
  line: number,
  ch: number,
  char: string,
  packageId: string,
  editorName: string,
  pkg: JiaoKanPackage,
  now: string,
  isLocal: boolean,
): void {
  if (!char) return;
  const vk = markKey(line, ch);
  const ledger = state.variants[vk] ?? { key: vk, line, ch, readings: [], notes: [] };
  const exists = ledger.readings.some((r) => r.char === char && r.packageId === packageId);
  if (!exists) {
    ledger.readings.push({
      char,
      editorId: isLocal ? 'local' : pkg.editor.id,
      editorName: isLocal ? editorName : pkg.editor.name,
      packageId,
      receivedAt: now,
    });
  }
  state.variants[vk] = ledger;
}

/** 按诗文字位序号替换第 pos 个非标点汉字（保留标点与换行）。 */
export function replaceCharAt(text: string, pos: number, next: string): string {
  let seen = 0;
  const out: string[] = [];
  for (const char of Array.from(text)) {
    if (PUNCTUATION.has(char)) {
      out.push(char);
      continue;
    }
    out.push(seen === pos ? next : char);
    seen += 1;
  }
  return out.join('');
}

export function isImportLogged(logs: ImportLogEntry[], packageId: string): boolean {
  return logs.some((entry) => entry.packageId === packageId && (entry.status === 'applied' || entry.status === 'partial'));
}

export function checkpointOf(checkpoints: FailedImportCheckpoint[], packageId: string): FailedImportCheckpoint | undefined {
  return checkpoints.find((item) => item.packageId === packageId);
}

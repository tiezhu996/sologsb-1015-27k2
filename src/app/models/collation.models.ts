import type { CharacterMark } from '../models/poem.models';

export const COLLATION_KIND = 'classical-poetry-collation-package';
export const PACKAGE_SCHEMA_VERSION = 2;
export const MIN_SUPPORTED_SCHEMA = 1;

/** 导出时相对基线的一条改动。 */
export interface CollationChange {
  id: string;
  line: number;
  position: number;
  /** 基线字（无基线的旧稿为空串）。 */
  baseChar: string;
  /** 整理者改后的字。 */
  char: string;
  baseMark: CharacterMark | null;
  mark: CharacterMark | null;
}

export interface CollationBaseline {
  versionId: string;
  versionName: string;
  text: string;
  marks: Record<string, CharacterMark>;
  revision: string;
  capturedAt: string;
}

/** 当前版本（schema 2）校勘包。 */
export interface CollationPackage {
  kind: typeof COLLATION_KIND;
  schema: 2;
  packageId: string;
  name: string;
  poemId: string;
  title: string;
  editor: string;
  exportedAt: string;
  targetVersionId: string;
  targetVersionName: string;
  baseline: CollationBaseline | null;
  changes: CollationChange[];
}

/** 旧稿校勘包（schema 1）：仅含工作区切片，无基线与改动清单。 */
export interface LegacyCollationPackage {
  kind?: string;
  schema?: 1;
  packageId?: string;
  name?: string;
  poemId?: string;
  title?: string;
  editor?: string;
  exportedAt?: string;
  targetVersionId?: string;
  targetVersionName?: string;
  version?: {
    id?: string;
    name?: string;
    source?: string;
    text?: string;
    marks?: Record<string, Partial<CharacterMark>>;
  };
  /** 更早期的打包方式：直接放文本与标注。 */
  text?: string;
  marks?: Record<string, Partial<CharacterMark>>;
  editorName?: string;
  source?: string;
}

export type AnyCollationPackage = CollationPackage | LegacyCollationPackage;

export interface MigrationResult {
  package: CollationPackage;
  warnings: string[];
  migrated: boolean;
}

export class PackageValidationError extends Error {}

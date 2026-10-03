import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzBadgeModule } from 'ng-zorro-antd/badge';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDividerModule } from 'ng-zorro-antd/divider';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { METER_TEMPLATES, PoetryStoreService } from './services/poetry-store.service';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule,
    NzAlertModule,
    NzBadgeModule,
    NzButtonModule,
    NzDividerModule,
    NzEmptyModule,
    NzInputModule,
    NzProgressModule,
    NzSelectModule,
    NzSwitchModule,
    NzTableModule,
    NzTabsModule,
    NzTagModule,
    NzToolTipModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly store = inject(PoetryStoreService);
  readonly templates = METER_TEMPLATES;
  readonly selectedCell = computed(() => this.store.selectedCell());
  importFileName = '';

  get totalErrors(): number {
    return this.store.issues().filter((issue) => issue.level === 'error').length;
  }

  get totalWarnings(): number {
    return this.store.issues().filter((issue) => issue.level === 'warning').length;
  }

  get checkedRate(): number {
    const cells = this.store.analysis().flatMap((line) => line.cells);
    if (!cells.length) return 0;
    return Math.round((cells.filter((cell) => cell.actual !== '?').length / cells.length) * 100);
  }

  setTone(tone: '平' | '仄' | '中' | '?'): void {
    this.store.setMark({ tone });
  }

  updateSource(source: string): void {
    this.store.setMark({ basis: source });
  }

  updateVersionSource(source: string): void {
    this.store.updateVersionSource(source);
  }

  trackTemplate(index: number, item: (typeof METER_TEMPLATES)[number]): string {
    return item.id;
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const inTextEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.getAttribute('contenteditable') === 'true';
    const command = event.ctrlKey || event.metaKey;

    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.store.redo() : this.store.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.store.redo();
      return;
    }
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.store.toast.set('内容已保存在本机');
      return;
    }
    if (inTextEntry) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const line = this.store.analysis()[this.store.selectedLine()];
      const next = Math.max(0, this.store.selectedPosition() - 1);
      this.store.selectCell(this.store.selectedLine(), Math.min(next, Math.max(0, line?.cells.length - 1)));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const line = this.store.analysis()[this.store.selectedLine()];
      const next = Math.min((line?.cells.length ?? 1) - 1, this.store.selectedPosition() + 1);
      this.store.selectCell(this.store.selectedLine(), next);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, this.store.selectedLine() - 1);
      const max = Math.max(0, (this.store.analysis()[next]?.cells.length ?? 1) - 1);
      this.store.selectCell(next, Math.min(this.store.selectedPosition(), max));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = Math.min(this.store.analysis().length - 1, this.store.selectedLine() + 1);
      const max = Math.max(0, (this.store.analysis()[next]?.cells.length ?? 1) - 1);
      this.store.selectCell(next, Math.min(this.store.selectedPosition(), max));
    } else if (event.key === '1') {
      this.setTone('平');
    } else if (event.key === '2') {
      this.setTone('仄');
    } else if (event.key === '3') {
      this.setTone('中');
    } else if (event.key === ' ') {
      event.preventDefault();
      this.store.togglePause();
    } else if (event.key.toLowerCase() === 'r') {
      this.store.cycleRhyme();
    }
  }

  onPackageFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.importFileName = file.name;
    const reader = new FileReader();
    reader.onload = () => this.store.importJiaoKanPackage(String(reader.result ?? ''));
    reader.readAsText(file, 'utf-8');
    input.value = '';
  }

  /** 演练：导入一份旧稿（v0 散件）校勘包，兼容升级后按字位并入。 */
  simulateLegacyImport(): void {
    const store = this.store;
    const baseline = store.baseline();
    if (!baseline) return;
    const legacy = {
      meta: {
        title: store.workspace().title,
        editor: '旧稿整理者',
        exportedAt: new Date().toISOString(),
        baselineVersion: baseline.versionId,
      },
      changes: [
        { index: 2, from: this.charAt(baseline.text, 2), to: '夢', note: '旧本一作“夢”，待考' },
      ],
    };
    this.importFileName = '旧稿校勘包-无格式号.json';
    store.importJiaoKanPackage(JSON.stringify(legacy));
  }

  /** 演练：导入含三处改动的临时包，并在第 2 条处模拟中断，便于验证检查点重试。 */
  simulateInterruptedImport(): void {
    const raw = JSON.stringify(this.buildDemoPackage());
    this.importFileName = '演练-中断校勘包.json';
    this.store.importJiaoKanPackage(raw, 1);
  }

  private buildDemoPackage(): unknown {
    const pkg = this.store.exportJiaoKanPackage();
    return {
      ...pkg,
      editor: { id: 'editor-demo', name: '演练整理者', room: '断网校样室' },
      sourceVersion: { ...pkg.sourceVersion, name: '演练校勘稿' },
      changes: [
        // 单方改字：本地未改此位，直接并入
        { pos: 1, line: 0, ch: 1, base: this.charAt(pkg.baseline.text, 1), text: '鳥', note: '整理者批注：异体字，仅留存不覆盖' },
        // 仅补标注
        { pos: 2, line: 0, ch: 2, base: this.charAt(pkg.baseline.text, 2), markPatch: { basis: '《广韵》四纸' } },
        // 双方改字：本地已将该位改作他字时进入待确认
        { pos: 3, line: 0, ch: 3, base: this.charAt(pkg.baseline.text, 3), text: '哓' },
      ],
    };
  }

  private charAt(text: string, pos: number): string {
    return Array.from(text).filter((char) => !'，。！？；：、 \t\n\r'.includes(char))[pos] ?? '';
  }

  conflictReasonLabel(reason: string): string {
    if (reason === 'both-changed') return '双方改字';
    if (reason === 'baseline-mismatch') return '基线不合';
    return '字位越界';
  }
}

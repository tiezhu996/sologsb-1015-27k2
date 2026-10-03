// 用 Angular 自带的 esbuild 将纯逻辑源码打包为 Node ESM，供离线测试运行。
import { build } from 'esbuild';

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outdir: 'out-node',
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: {
    'collation.engine': 'src/app/services/collation.engine.ts',
    'collation.models': 'src/app/models/collation.models.ts',
    'poetry-store.service': 'src/app/services/poetry-store.service.ts',
  },
  alias: { '@angular/core': new URL('./angular-shim.mjs', import.meta.url).pathname },
});

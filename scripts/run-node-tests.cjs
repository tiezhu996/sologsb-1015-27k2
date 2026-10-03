/* 纯 Node 测试运行器：用 esbuild 打包 spec，再借 jasmine-core 在 Node 内执行（无需浏览器）。 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

// jasmine.js 面向浏览器：在 Node 中提供最小 CommonJS 宿主。
const jasmineCorePath = require.resolve('jasmine-core/lib/jasmine-core/jasmine.js');
const jasmineSrc = fs.readFileSync(jasmineCorePath, 'utf8');
const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', `${jasmineSrc}\nmodule.exports = getJasmineRequireObj();`);
const mod = { exports: {} };
factory(mod.exports, require, mod, __filename, path.dirname(jasmineCorePath));
const jasmineRequireObj = mod.exports;
const jasmine = jasmineRequireObj.core(jasmineRequireObj);
const env = jasmine.getEnv();

for (const name of ['describe', 'xdescribe', 'fdescribe', 'it', 'xit', 'fit', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'expect', 'pending', 'fail', 'spyOn', 'spyOnProperty']) {
  global[name] = env[name] ? env[name].bind(env) : jasmine[name];
}
global.jasmine = jasmine;

async function main() {
  const specs = process.argv.slice(2);
  const tmpDir = path.join(__dirname, '..', '.tmp-tests');
  fs.mkdirSync(tmpDir, { recursive: true });
  const entry = path.join(tmpDir, 'entry.ts');
  fs.writeFileSync(entry, specs.map((spec) => `import ${JSON.stringify(path.resolve(spec))};`).join('\n'));
  const outfile = path.join(tmpDir, 'bundle.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  });

  let failed = 0;
  let passed = 0;
  env.addReporter({
    specDone(result) {
      if (result.status === 'failed') {
        failed += 1;
        console.error(`✘ ${result.fullName}`);
        for (const failure of result.failedExpectations) console.error(`   ${failure.message}`);
      } else if (result.status === 'passed') {
        passed += 1;
        console.log(`✔ ${result.fullName}`);
      }
    },
    jasmineDone(result) {
      console.log(`\n${passed} 通过 / ${failed} 失败（${result.overallStatus}）`);
      process.exitCode = result.overallStatus === 'passed' ? 0 : 1;
    },
  });
  require(outfile);
  env.execute();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

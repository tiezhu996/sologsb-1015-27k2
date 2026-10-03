// 最小 signal/computed 垫片：仅满足 PoetryStoreService 在 Node 下运行的需要。
export function signal(initial) {
  let value = initial;
  const fn = (...args) => {
    if (args.length === 0) return value;
    value = args[0] instanceof Function ? args[0](value) : args[0];
    return undefined;
  };
  fn.set = (next) => {
    value = next;
  };
  fn.update = (updater) => {
    value = updater(value);
  };
  fn.asReadonly = () => fn;
  return fn;
}

export function computed(getter) {
  const fn = () => getter();
  fn.set = () => {};
  fn.update = () => {};
  return fn;
}

export function Injectable(config) {
  return (target) => {
    target.ɵprov = config ?? {};
    return target;
  };
}

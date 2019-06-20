function pifyFn(fn, self) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      args.push((err, res) => err ? reject(err) : resolve(res));
      fn.apply(self || this, args);
    });
  };
}

const pifyCache = new WeakSet();

function pifyObj(obj) {
  if (pifyCache.has(obj)) {
    return obj;
  } else {
    const fnCache = new WeakMap();

    const handler = {
      get(target, key) {
        const prop = target[key];

        const cached = fnCache.get(prop);

        if (cached) {
          return cached;
        } else {
          if (typeof prop === 'function') {
            const pifyd = pifyFn(prop, target);
            fnCache.set(prop, pifyd);
            return pifyd;
          } else {
            return prop
          }
        }
      }
    }

    const pified = new Proxy(obj, handler);
    pifyCache.add(pified);
    return pified;
  }
}

module.exports = function pify(target) {
  if (typeof target === 'function') {
    return pifyFn(target);
  } else {
    return pifyObj(target);
  }
};

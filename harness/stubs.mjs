// Minimal browser-ish stubs so the compiled controllers can run in Node.
// This module INSTALLS the stubs when imported first.
let store = new Map();
const idCache = new Map();

export function freshStorage() {
  store = new Map();
  idCache.clear();
}

/** Simulate a page reload: fresh DOM nodes, same localStorage. */
export function resetDom() {
  idCache.clear();
}

export function __store() {
  return store;
}

function makeNode() {
  const listeners = new Map();
  const children = [];
  const node = {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    dataset: {},
    style: {},
    children,
    className: "",
    firstElementChild: null,
    parentElement: null,
    offsetWidth: 0,
    isConnected: true,
    _classes: new Set(),
    classList: {
      toggle(c, on) {
        if (on === undefined) {
          if (node._classes.has(c)) node._classes.delete(c);
          else node._classes.add(c);
        } else if (on) node._classes.add(c);
        else node._classes.delete(c);
      },
      add(c) {
        node._classes.add(c);
      },
      remove(c) {
        node._classes.delete(c);
      },
      contains(c) {
        return node._classes.has(c);
      },
    },
    setAttribute(k, v) {
      node["attr-" + k] = v;
    },
    getAttribute(k) {
      return node["attr-" + k] ?? null;
    },
    hasAttribute(k) {
      return ("attr-" + k) in node;
    },
    removeAttribute(k) {
      delete node["attr-" + k];
    },
    toggleAttribute(k, force) {
      const has = ("attr-" + k) in node;
      const on = force === undefined ? !has : Boolean(force);
      if (on) node["attr-" + k] = "";
      else delete node["attr-" + k];
      return on;
    },
    addEventListener(name, cb) {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
    removeEventListener() {},
    fire(name, target) {
      target = target ?? node;
      for (const cb of listeners.get(name) ?? []) {
        cb({ target, currentTarget: node, preventDefault() {} });
      }
    },
    click() {
      node.fire("click");
    },
    focus() {},
    replaceChildren() {
      children.length = 0;
      node.firstElementChild = null;
    },
    appendChild(child) {
      if (child._isFragment) {
        for (const c of [...child.children]) {
          c.parentElement = node;
          c.isConnected = true;
          children.push(c);
        }
        child.children.length = 0;
        return child;
      }
      child.parentElement = node;
      child.isConnected = true;
      children.push(child);
      if (node.firstElementChild === null) node.firstElementChild = child;
      return child;
    },
    contains(other) {
      return other !== null && other !== undefined;
    },
    closest() {
      return node;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    animate() {
      return { finished: Promise.resolve(), cancel() {} };
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };
  return node;
}

const doc = {
  hidden: false,
  getElementById(id) {
    if (!idCache.has(id)) idCache.set(id, makeNode());
    return idCache.get(id);
  },
  createElement() {
    return makeNode();
  },
  createDocumentFragment() {
    const f = makeNode();
    f._isFragment = true;
    return f;
  },
  addEventListener() {},
  title: "",
};

export function install() {
  const g = globalThis;
  g.document = doc;
  g.window = {
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
  };
  g.performance = { now: () => 1_000_000 };
  g.localStorage = {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
    removeItem(k) {
      store.delete(k);
    },
  };
  g.fetch = async (url) => {
    const m = /[?&]day=([^&]+)/.exec(String(url));
    const day = m ? decodeURIComponent(m[1]) : new Date().toISOString().slice(0, 10);
    return {
      ok: true,
      async json() {
        return {
          day,
          seeds: { crowns: 12345, minesweeper: 54321, seasons: 11111, tents: 22222 },
        };
      },
      async text() {
        return JSON.stringify({
          day,
          seeds: { crowns: 12345, minesweeper: 54321, seasons: 11111, tents: 22222 },
        });
      },
    };
  };
  g.AbortController = class {
    constructor() {
      this.signal = {};
    }
    abort() {}
  };
  Object.defineProperty(g, "crypto", { value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" }, configurable: true });
  g.location = { reload() {} };
}

install();
freshStorage();
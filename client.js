/**
 * browser-hands — Client 半边。
 *
 * 职责（详见 PROTOCOL.md）：
 *  1. 注册右侧栏 tab 类型 `agent-browser`，tab 正文里挂一个**自己 acquire 的** <webview> guest；
 *  2. 常驻长轮询 Host 的 /browser-hands/poll，把到来的命令翻译成对 webview 的操作；
 *  3. 命令需要时自动把 tab 打开（打开 = 面板展开、用户可见），执行完把结果回给 Host。
 *
 * 与 Host 的唯一契约是 PROTOCOL.md；任何一侧改字段都必须同步改另一边。
 *
 * 说明：本文件是纯 JavaScript（无构建步骤），由 Client 模块加载器按包名惰性加载。
 * React 来自浏览器的模块表，不要 import 任何 @deepseek-ai/* 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-browser-hands',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** tab 类型 id（也是 slot 的 key）与 kind。 */
    const TAB_ID = 'dsh-plugin-browser-hands';
    const TAB_KIND = 'agent-browser';
    const ENDPOINT = '/browser-hands';
    /** lease 的存储分区身份：所有会话共用一份 cookie/存储，但各自持有独立 guest。 */
    const WORKSPACE_KEY = 'browser-hands';
    const VERSION = 2;

    // ────────────────────────────── 基础设施 ──────────────────────────────

    let pluginCtx = null;
    let clientId = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const debugQueue = [];
    let debugTimer = 0;

    /** 上报日志（限流：每 120ms 合并一次）。失败静默，绝不因为日志把主流程打挂。 */
    function log(level, message, data) {
      const entry = { level, message: String(message), data: data === undefined ? undefined : safe(data) };
      if (level === 'error' || level === 'warn') console[level]('[browser-hands]', message, data ?? '');
      debugQueue.push(entry);
      if (debugTimer) return;
      debugTimer = setTimeout(() => {
        debugTimer = 0;
        const batch = debugQueue.splice(0, debugQueue.length);
        for (const item of batch) {
          fetch(ENDPOINT + '/log', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item),
          }).catch(() => {});
        }
      }, 120);
    }

    /** 把任意值压成可 JSON 传输的小对象。 */
    function safe(value) {
      if (value instanceof Error) return { error: String(value && value.stack ? value.stack : value) };
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return { text: String(value) };
      }
    }

    async function postJson(path, body) {
      const response = await fetch(ENDPOINT + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (response.status === 204) return null;
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
      if (!response.ok) throw new Error('browser-hands http ' + response.status + ': ' + (text || '').slice(0, 300));
      return parsed;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** 轮询直到条件成立或超时。 */
    async function waitFor(check, timeoutMs, intervalMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() > deadline) return undefined;
        await sleep(intervalMs ?? 50);
      }
    }

    function err(code, message, extra) {
      const error = new Error(message);
      error.bhCode = code;
      if (extra) error.bhExtra = extra;
      return error;
    }

    function isDesktop() {
      const carrier = globalThis.dshDesktop;
      return !!carrier && carrier.protocolVersion === 1 && !!carrier.browser;
    }

    // ────────────────────────────── 页面脚本 ──────────────────────────────
    // 注意：下面这个函数会被 toString() 后注入 guest 页面执行，**必须自包含**
    // （不引用本文件里的任何变量），且只能返回可结构化克隆的值。

    function pageAgent(op, args) {
      var S = window.__dshAgent;
      if (!S) {
        S = window.__dshAgent = {
          refs: new Map(),
          sigs: new Map(),
          seq: 0,
          mutations: 0,
          net: [],
          consoleErrors: [],
          installed: false,
        };
      }
      if (!S.sigs) S.sigs = new Map();
      function installObservers() {
        if (S.obsInstalled || !document.documentElement) return;
        S.obsInstalled = true;
        try {
          var obs = new MutationObserver(function (records) {
            S.mutations += records.length;
          });
          obs.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        } catch (e) { /* 忽略 */ }
      }
      installObservers();

      var INTERACTIVE = [
        'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
        '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]',
        '[role=checkbox]', '[role=radio]', '[role=combobox]', '[role=switch]', '[role=slider]',
        '[role=option]', '[role=searchbox]', '[contenteditable=""]', '[contenteditable=true]',
        '[tabindex]:not([tabindex="-1"])', 'audio[controls]', 'video[controls]', 'label[for]',
        '[onclick]',
      ].join(',');

      function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (typeof el.checkVisibility === 'function') {
          if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: false })) return false;
        } else {
          var style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') return false;
        }
        return true;
      }

      function textOf(node) {
        var value = node.textContent || '';
        return value.replace(/\s+/g, ' ').trim();
      }

      /** 去掉图标字体用的私用区字形与零宽字符——它们只占 token，不携带任何语义。 */
      function cleanName(value) {
        return String(value == null ? '' : value)
          .replace(/[\uE000-\uF8FF\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function nameOf(el) {
        var candidates = [
          el.getAttribute && el.getAttribute('aria-label'),
          el.getAttribute && el.getAttribute('placeholder'),
          el.getAttribute && el.getAttribute('alt'),
          el.getAttribute && el.getAttribute('title'),
        ];
        for (var i = 0; i < candidates.length; i += 1) {
          var named = cleanName(candidates[i]);
          if (named) return named.slice(0, 100);
        }
        if (el.tagName === 'INPUT') {
          var type = (el.type || '').toLowerCase();
          if (type === 'submit' || type === 'button' || type === 'reset') {
            var buttonLabel = cleanName(el.value);
            if (buttonLabel) return buttonLabel.slice(0, 100);
          }
        }
        if (el.id) {
          var labelled = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (labelled) {
            var labelText = cleanName(textOf(labelled));
            if (labelText) return labelText.slice(0, 100);
          }
        }
        var parentLabel = el.closest && el.closest('label');
        if (parentLabel && parentLabel !== el) {
          var parentText = cleanName(textOf(parentLabel));
          if (parentText) return parentText.slice(0, 100);
        }
        var text = cleanName(textOf(el));
        if (text) return text.slice(0, 100);
        if (el.value && typeof el.value === 'string') return cleanName(el.value).slice(0, 100);
        if (el.tagName === 'IMG') return '';
        return '';
      }

      function roleOf(el) {
        var explicit = el.getAttribute && el.getAttribute('role');
        if (explicit) return explicit;
        var tag = el.tagName;
        if (tag === 'A') return 'link';
        if (tag === 'BUTTON') return 'button';
        if (tag === 'SELECT') return 'combobox';
        if (tag === 'TEXTAREA') return 'textarea';
        if (tag === 'SUMMARY') return 'button';
        if (tag === 'LABEL') return 'other';
        if (tag === 'INPUT') {
          var type = (el.type || 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
          if (type === 'search') return 'searchbox';
          if (type === 'range') return 'slider';
          return 'textbox';
        }
        return 'other';
      }

      function refFor(el) {
        var existing = S.byEl && S.byEl.get(el);
        if (existing) return existing;
        S.seq += 1;
        var ref = '@e' + S.seq;
        S.refs.set(ref, el);
        if (!S.byEl) S.byEl = new WeakMap();
        S.byEl.set(el, ref);
        return ref;
      }

      function pruneRefs() {
        S.refs.forEach(function (el, ref) {
          if (!el || !el.isConnected) {
            S.refs.delete(ref);
            if (S.byEl) S.byEl.delete(el);
          }
        });
      }

      /**
       * 收集可交互元素：穿透 open shadow root 与**同源** iframe。
       * 每收集到一个元素，记下它的 frame 链（外→内），供坐标换算用。
       * 跨源 iframe 拿不到 contentDocument，跳过（并在快照里报数量）。
       */
      var frameChain = new WeakMap();
      var frameStats = { shadowRoots: 0, sameOriginFrames: 0, blockedFrames: 0 };

      function walkInteractive(root, out, chain) {
        if (!root || !root.querySelectorAll) return;
        var nodes = root.querySelectorAll(INTERACTIVE);
        for (var i = 0; i < nodes.length; i += 1) out.push(nodes[i]);
        var all = root.querySelectorAll('*');
        for (var j = 0; j < all.length; j += 1) {
          var shadow = all[j].shadowRoot;
          if (shadow) {
            frameStats.shadowRoots += 1;
            walkInteractive(shadow, out, chain);
          }
        }
        var frames = root.querySelectorAll('iframe,frame');
        for (var k = 0; k < frames.length; k += 1) {
          var frame = frames[k];
          var doc = null;
          try { doc = frame.contentDocument; } catch (e) { doc = null; }
          if (!doc || !doc.documentElement) { frameStats.blockedFrames += 1; continue; }
          frameStats.sameOriginFrames += 1;
          var nextChain = chain.concat([frame]);
          frameChain.set(frame, chain);
          walkInteractive(doc, out, nextChain);
          // 记录该 iframe 内元素对应的链：先记 frame 自身，元素在下面按 chain 取。
          var inner = doc.querySelectorAll('*');
          for (var m = 0; m < inner.length; m += 1) frameChain.set(inner[m], nextChain);
        }
      }

      function collectInteractive() {
        frameStats = { shadowRoots: 0, sameOriginFrames: 0, blockedFrames: 0 };
        var out = [];
        walkInteractive(document, out, []);
        // document 本身的元素（含 shadow 里的）链为空数组：walkInteractive 已按层写入。
        for (var i = 0; i < out.length; i += 1) {
          if (!frameChain.has(out[i])) frameChain.set(out[i], []);
        }
        return out;
      }

      /** 元素在**顶层视口**里的中点坐标（穿透同源 iframe 的偏移）。 */
      function viewportCenter(el) {
        var rect = el.getBoundingClientRect();
        var left = rect.left;
        var top = rect.top;
        var chain = frameChain.get(el) || [];
        for (var i = 0; i < chain.length; i += 1) {
          var frameRect = chain[i].getBoundingClientRect();
          left += frameRect.left + (chain[i].clientLeft || 0);
          top += frameRect.top + (chain[i].clientTop || 0);
        }
        return { left: left, top: top, width: rect.width, height: rect.height };
      }

      function rectOf(el) {
        var box = viewportCenter(el);
        return {
          x: box.left + window.scrollX,
          y: box.top + window.scrollY,
          width: box.width,
          height: box.height,
          viewportX: box.left + box.width / 2,
          viewportY: box.top + box.height / 2,
        };
      }

      /**
       * 收集「读不到内容但能点」的区域（跨源 iframe / canvas / embed / object）。
       * 给模型矩形，让它能用坐标点或判断「这里需要截图」。
       */
      function collectOpaque() {
        var out = [];
        function scan(doc) {
          var list = doc.querySelectorAll('iframe,frame,canvas,embed,object');
          for (var i = 0; i < list.length; i += 1) {
            var el = list[i];
            if (!isVisible(el)) continue;
            var kind = el.tagName.toLowerCase();
            var crossOrigin = false;
            if (kind === 'iframe' || kind === 'frame') {
              try { crossOrigin = !el.contentDocument; } catch (e) { crossOrigin = true; }
              if (!crossOrigin) continue; // 同源 iframe 已展开成元素，不用再报告
            }
            var box = viewportCenter(el);
            var label = el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('aria-label') || '';
            out.push({
              kind: kind,
              x: Math.round(box.left),
              y: Math.round(box.top),
              width: Math.round(box.width),
              height: Math.round(box.height),
              name: String(label).slice(0, 60),
            });
          }
          var frames = doc.querySelectorAll('iframe,frame');
          for (var j = 0; j < frames.length; j += 1) {
            var inner = null;
            try { inner = frames[j].contentDocument; } catch (e) { inner = null; }
            if (inner && inner.documentElement) scan(inner);
          }
        }
        scan(document);
        return out;
      }

      // 视口过滤：viewport 只保留与视口相交的元素（几何信息只有在页面里才拿得到），
      // document 保留现在的行为（全部可见元素）。offscreen 记录视口外被丢掉的元素数，
      // 让模型知道「还有东西在屏幕外」，不至于以为页面就这些。
      // 正文默认不发（text 默认 false）——多步任务里正文是最大成本，用户要看时显式传 text:true。
      function snapshot(options) {
        var opts = options || {};
        var maxElements = typeof opts.maxElements === 'number' && opts.maxElements > 0 ? opts.maxElements : 80;
        var textLimit = typeof opts.textLimit === 'number' && opts.textLimit > 0 ? opts.textLimit : 3000;
        var scope = opts.scope === 'document' ? 'document' : 'viewport';
        var wantText = opts.text === true;
        pruneRefs();
        var elements = [];
        var offscreen = 0;
        var nodes = collectInteractive();
        var truncatedElements = false;
        for (var i = 0; i < nodes.length; i += 1) {
          if (elements.length >= maxElements) { truncatedElements = true; break; }
          var el = nodes[i];
          if (!isVisible(el)) continue;
          var box = viewportCenter(el);
          var inView = box.top + box.height > 0 && box.top < window.innerHeight
            && box.left + box.width > 0 && box.left < window.innerWidth;
          if (scope === 'viewport' && !inView) { offscreen += 1; continue; }
          var role = roleOf(el);
          var item = { ref: refFor(el), role: role, name: nameOf(el) };
          item.inViewport = inView;
          S.sigs.set(item.ref, { role: item.role, name: item.name });
          if (role === 'link') {
            var href = el.getAttribute('href') || '';
            if (href) item.href = href.slice(0, 100);
          }
          if (role === 'textbox' || role === 'searchbox' || role === 'textarea' || role === 'combobox') {
            var value = typeof el.value === 'string' ? el.value : '';
            if (value) item.value = value.slice(0, 200);
            if (el.getAttribute && el.getAttribute('placeholder')) item.placeholder = String(el.getAttribute('placeholder')).slice(0, 120);
          }
          if (role === 'checkbox' || role === 'radio' || role === 'switch') item.checked = !!el.checked;
          if (el.disabled) item.disabled = true;
          elements.push(item);
        }
        // 正文默认不发（text:false）：返回空串而不是 null，保持输出 schema 是单一 string 类型。
        var text = '';
        var truncatedText = false;
        if (wantText) {
          try {
            text = (document.body ? document.body.innerText : '') || '';
            text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
          } catch (e) { text = ''; }
          truncatedText = text.length > textLimit;
          if (truncatedText) text = text.slice(0, textLimit) + '\n…';
        }
        return {
          pageId: opts.pageId || '',
          url: location.href,
          title: document.title || '',
          scope: scope,
          offscreen: offscreen,
          scroll: {
            y: Math.round(window.scrollY),
            height: Math.round(document.documentElement ? document.documentElement.scrollHeight : 0),
            viewport: window.innerHeight,
          },
          text: text,
          elements: elements,
          opaque: collectOpaque(),
          frames: {
            shadowRoots: frameStats.shadowRoots,
            sameOrigin: frameStats.sameOriginFrames,
            crossOrigin: frameStats.blockedFrames,
          },
          truncated: { text: truncatedText, elements: truncatedElements },
        };
      }

      function resolve(ref) {
        var el = S.refs.get(ref);
        if (!el || !el.isConnected) return null;
        return el;
      }

      /**
       * 按 ref 找元素；ref 失效（SPA 重渲染把节点换掉了）时按「角色 + 名字」找同一个语义元素，
       * 并给它分配一个新 ref 返回。这是 R1.2「ref 稳定」在页面变化后的自愈路径。
       */
      function resolveLoose(ref) {
        var el = resolve(ref);
        if (el) return { el: el, ref: ref, recovered: false };
        var sig = S.sigs.get(ref);
        if (!sig) return null;
        var nodes = collectInteractive();
        for (var i = 0; i < nodes.length; i += 1) {
          var candidate = nodes[i];
          if (!isVisible(candidate)) continue;
          if (roleOf(candidate) !== sig.role) continue;
          if (nameOf(candidate) !== sig.name) continue;
          return { el: candidate, ref: refFor(candidate), recovered: true };
        }
        return null;
      }

      function foldText(value, limit) {
        return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit || 200);
      }

      switch (op) {
        case 'install': {
          if (!S.installed) {
            S.installed = true;
            try {
              var originalFetch = window.fetch;
              window.fetch = function () {
                var input = arguments[0];
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                var promise = originalFetch.apply(this, arguments);
                promise.then(function (response) {
                  S.net.push({ url: String(url).slice(0, 300), status: response.status, ok: response.ok });
                  if (S.net.length > 400) S.net.splice(0, S.net.length - 400);
                }, function (error) {
                  S.net.push({ url: String(url).slice(0, 300), ok: false, failure: String(error && error.message ? error.message : error) });
                  if (S.net.length > 400) S.net.splice(0, S.net.length - 400);
                });
                return promise;
              };
              var open = XMLHttpRequest.prototype.open;
              var send = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function (method, url) {
                this.__dshUrl = String(url || '');
                this.__dshMethod = String(method || 'GET');
                return open.apply(this, arguments);
              };
              XMLHttpRequest.prototype.send = function () {
                var xhr = this;
                xhr.addEventListener('loadend', function () {
                  S.net.push({ url: xhr.__dshUrl.slice(0, 300), method: xhr.__dshMethod, status: xhr.status, ok: xhr.status >= 200 && xhr.status < 400 });
                  if (S.net.length > 400) S.net.splice(0, S.net.length - 400);
                });
                return send.apply(this, arguments);
              };
              window.addEventListener('error', function (event) {
                S.consoleErrors.push({ level: 'error', text: String(event.message || 'error').slice(0, 500) });
              });
            } catch (e) { /* 忽略：注入失败不影响主流程 */ }
          }
          return { ok: true };
        }
        case 'snapshot':
          return snapshot(args || {});
        case 'find': {
          // 全文档（含 shadow / 同源 iframe）按名字或当前值搜索，返回 ref；
          // 解决「元素在视口外/没列出来，但我就想找到它」的场景，不用整页快照。
          var needle = String(args.text || '').toLowerCase();
          if (needle === '') return { ok: false, code: 'BAD_ARG', message: 'find 需要 text' };
          var limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : 20;
          var pool = collectInteractive();
          var matches = [];
          for (var fi = 0; fi < pool.length; fi += 1) {
            var fel = pool[fi];
            if (!isVisible(fel)) continue;
            var fname = nameOf(fel);
            var fval = fel && typeof fel.value === 'string' ? fel.value : '';
            var hay = (fname + ' ' + fval).toLowerCase();
            if (hay.indexOf(needle) < 0) continue;
            var fbox = viewportCenter(fel);
            matches.push({
              ref: refFor(fel),
              role: roleOf(fel),
              name: fname,
              inViewport: fbox.top + fbox.height > 0 && fbox.top < window.innerHeight
                && fbox.left + fbox.width > 0 && fbox.left < window.innerWidth,
            });
            if (matches.length >= limit) break;
          }
          if (matches.length > 0) {
            var first = S.refs.get(matches[0].ref);
            try { if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* 忽略 */ }
          }
          // 兜底：没有语义元素命中时，扫描全部元素（含 shadow/同源 iframe），
          // 找「文字包含关键词的最小可见元素」，给坐标让模型用 browser_click x/y 点。
          if (matches.length === 0) {
            var all = [];
            (function collectAll(root) {
              if (!root || !root.querySelectorAll) return;
              var list = root.querySelectorAll('*');
              for (var ai = 0; ai < list.length; ai += 1) all.push(list[ai]);
              for (var aj = 0; aj < list.length; aj += 1) {
                if (list[aj].shadowRoot) collectAll(list[aj].shadowRoot);
              }
            })(document);
            var best = null;
            var bestArea = Infinity;
            for (var bi = 0; bi < all.length; bi += 1) {
              var bel = all[bi];
              if (!isVisible(bel)) continue;
              var btxt = textOf(bel).toLowerCase();
              if (btxt === '' || btxt.indexOf(needle) < 0) continue;
              var bbox = viewportCenter(bel);
              var area = bbox.width * bbox.height;
              if (area <= 0 || area > 400000) continue;
              if (area < bestArea) { best = bel; bestArea = area; }
            }
            if (best !== null) {
              var gbox = viewportCenter(best);
              try { best.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* 忽略 */ }
              gbox = viewportCenter(best);
              matches.push({
                ref: '',
                role: 'element',
                name: textOf(best).slice(0, 120),
                inViewport: true,
                x: Math.round(gbox.left + gbox.width / 2),
                y: Math.round(gbox.top + gbox.height / 2),
                fallback: true,
              });
            }
          }
          return { ok: true, query: String(args.text), matches: matches };
        }
        case 'state': {
          var active = document.activeElement;
          return {
            url: location.href,
            title: document.title || '',
            mutations: S.mutations,
            scrollY: Math.round(window.scrollY),
            textLength: document.body ? document.body.innerText.length : 0,
            activeRef: active && S.byEl ? S.byEl.get(active) || null : null,
          };
        }
        case 'rect': {
          var found = resolveLoose(args.ref);
          if (!found) return { ok: false, code: 'NO_REF' };
          var element = found.el;
          if (!isVisible(element)) {
            try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* 忽略 */ }
          }
          var rect = rectOf(element);
          var vw = window.innerWidth;
          var vh = window.innerHeight;
          if (rect.viewportX < 0 || rect.viewportY < 0 || rect.viewportX > vw || rect.viewportY > vh) {
            try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* 忽略 */ }
            rect = rectOf(element);
          }
          return {
            ok: true,
            ref: found.ref,
            recovered: found.recovered,
            rect: { x: rect.viewportX, y: rect.viewportY, width: rect.width, height: rect.height },
          };
        }
        case 'clickDom': {
          var foundClick = resolveLoose(args.ref);
          if (!foundClick) return { ok: false, code: 'NO_REF' };
          var clickEl = foundClick.el;
          try {
            if (typeof clickEl.scrollIntoView === 'function') clickEl.scrollIntoView({ block: 'center', inline: 'center' });
            clickEl.focus({ preventScroll: true });
          } catch (e) { /* 忽略 */ }
          var before = { mutations: S.mutations, url: location.href };
          try {
            clickEl.click();
          } catch (e) {
            return { ok: false, code: 'INTERNAL', message: String(e && e.message ? e.message : e) };
          }
          return { ok: true, ref: foundClick.ref, recovered: foundClick.recovered, before: before };
        }
        case 'clickAt': {
          var hit = document.elementFromPoint(args.x, args.y);
          if (!hit) return { ok: false, code: 'NO_REF', message: '该坐标没有元素' };
          try { hit.click(); } catch (e) { return { ok: false, code: 'INTERNAL', message: String(e) }; }
          return { ok: true, tag: hit.tagName, text: foldText(hit.textContent, 60) };
        }
        case 'focus': {
          var foundFocus = resolveLoose(args.ref);
          if (!foundFocus) return { ok: false, code: 'NO_REF' };
          var focusEl = foundFocus.el;
          try {
            focusEl.scrollIntoView({ block: 'center', inline: 'center' });
            focusEl.focus({ preventScroll: true });
          } catch (e) { /* 忽略 */ }
          var isEditable = focusEl.isContentEditable || focusEl.tagName === 'INPUT' || focusEl.tagName === 'TEXTAREA';
          if (args.clear && !focusEl.isContentEditable) {
            try { focusEl.select(); } catch (e) { /* 忽略 */ }
          }
          if (args.clear && focusEl.isContentEditable) {
            try {
              var range = document.createRange();
              range.selectNodeContents(focusEl);
              var selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            } catch (e) { /* 忽略 */ }
          }
          return {
            ok: true,
            ref: foundFocus.ref,
            recovered: foundFocus.recovered,
            editable: isEditable,
            readOnly: !!focusEl.readOnly,
            value: focusEl.isContentEditable ? foldText(focusEl.textContent, 400) : String(focusEl.value ?? ''),
            maxLength: focusEl.maxLength && focusEl.maxLength > 0 ? focusEl.maxLength : null,
          };
        }
        case 'typeFallback': {
          var typeEl = resolve(args.ref);
          if (!typeEl) return { ok: false, code: 'NO_REF' };
          var text = String(args.text ?? '');
          try {
            typeEl.focus({ preventScroll: true });
            if (typeEl.isContentEditable) {
              if (args.clear !== false) {
                var clearRange = document.createRange();
                clearRange.selectNodeContents(typeEl);
                var clearSel = window.getSelection();
                clearSel.removeAllRanges();
                clearSel.addRange(clearRange);
                document.execCommand('delete');
              }
              document.execCommand('insertText', false, text);
            } else {
              var proto = typeEl.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              var setter = Object.getOwnPropertyDescriptor(proto, 'value');
              if (setter && setter.set) setter.set.call(typeEl, text);
              else typeEl.value = text;
              typeEl.dispatchEvent(new Event('input', { bubbles: true }));
              typeEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {
            return { ok: false, code: 'INTERNAL', message: String(e && e.message ? e.message : e) };
          }
          var finalValue = typeEl.isContentEditable ? foldText(typeEl.textContent, 400) : String(typeEl.value ?? '');
          return { ok: true, value: finalValue };
        }
        case 'readValue': {
          var readEl = resolve(args.ref);
          if (!readEl) return { ok: false, code: 'NO_REF' };
          return { ok: true, value: readEl.isContentEditable ? foldText(readEl.textContent, 400) : String(readEl.value ?? '') };
        }
        case 'submit': {
          var form = document.activeElement && document.activeElement.form
            ? document.activeElement.form
            : (args.ref ? (resolve(args.ref) || {}).form : null);
          if (form) {
            try {
              if (typeof form.requestSubmit === 'function') form.requestSubmit();
              else form.submit();
              return { ok: true, via: 'form' };
            } catch (e) {
              return { ok: false, code: 'INTERNAL', message: String(e) };
            }
          }
          return { ok: false, code: 'NO_REF', message: '没有可提交的表单' };
        }
        case 'keyFallback': {
          var target = document.activeElement || document.body;
          var key = String(args.key || 'Enter');
          var code = args.code || key;
          var keyCode = args.keyCode || 0;
          if (!target) return { ok: false, code: 'INTERNAL', message: '没有焦点元素' };
          var init = { key: key, code: code, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
          target.dispatchEvent(new KeyboardEvent('keydown', init));
          target.dispatchEvent(new KeyboardEvent('keyup', init));
          return { ok: true, via: 'KeyboardEvent' };
        }
        case 'scrollDom': {
          var dx = Number(args.dx || 0);
          var dy = Number(args.dy || 0);
          window.scrollBy(dx, dy);
          return {
            ok: true,
            scroll: { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight, viewport: window.innerHeight },
          };
        }
        case 'measure': {
          return {
            ok: true,
            height: Math.round(document.documentElement ? document.documentElement.scrollHeight : 0),
            viewport: window.innerHeight,
          };
        }
        case 'console': {
          var limit = typeof args && typeof args.limit === 'number' ? args.limit : 50;
          return { ok: true, entries: S.consoleErrors.slice(-limit) };
        }
        case 'net': {
          var netLimit = typeof args && typeof args.limit === 'number' ? args.limit : 60;
          var entries = S.net.slice(-netLimit);
          try {
            var navEntry = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
            if (navEntry && navEntry.name) {
              entries.unshift({ url: String(navEntry.name).slice(0, 300), method: 'GET', ok: true, durationMs: Math.round(navEntry.duration) });
            }
          } catch (e) { /* 忽略 */ }
          if (entries.length === 0 && performance && performance.getEntriesByType) {
            entries = performance.getEntriesByType('resource').slice(-netLimit).map(function (item) {
              return { url: String(item.name).slice(0, 300), ok: true, durationMs: Math.round(item.duration) };
            });
          }
          return { ok: true, entries: entries };
        }
        case 'eval': {
          try {
            var result = (0, eval)(args.code);
            var shaped;
            try { shaped = JSON.parse(JSON.stringify(result)); } catch (e) { shaped = String(result); }
            return { ok: true, value: shaped };
          } catch (e) {
            return { ok: false, code: 'INTERNAL', message: String(e && e.message ? e.message : e) };
          }
        }
        default:
          return { ok: false, code: 'INTERNAL', message: 'unknown page op: ' + op };
      }
    }

    // ────────────────────────────── 页面对象 ──────────────────────────────

    let pageSeq = 0;

    /** 一个 webview guest + 它的页面状态。 */
    class Page {
      constructor(sessionId) {
        this.sessionId = sessionId;
        this.id = 'p' + (pageSeq += 1);
        this.element = null;
        this.lease = null;
        this.ready = false;
        this.url = 'about:blank';
        this.title = '';
        this.failure = null;
        this.consoleEntries = [];
        this.disposed = false;
      }

      async create(host) {
        if (!isDesktop()) throw err('NOT_DESKTOP', '当前不是桌面版，无法创建受控浏览器');
        const reservation = await globalThis.dshDesktop.browser.acquire(WORKSPACE_KEY);
        this.lease = reservation.lease;
        const element = document.createElement('webview');
        element.className = 'bh-view';
        element.setAttribute('name', reservation.lease);
        element.setAttribute('partition', reservation.partition);
        element.setAttribute('allowpopups', '');
        element.setAttribute('src', 'about:blank#' + reservation.lease);
        this.element = element;

        element.addEventListener('dom-ready', () => {
          this.ready = true;
          log('info', 'guest dom-ready', { pageId: this.id, url: this.url });
          this.exec('install', {}).catch((error) => log('warn', 'install page agent failed', { error }));
        });
        element.addEventListener('did-start-loading', () => {
          this.loading = true;
        });
        element.addEventListener('did-stop-loading', () => {
          this.loading = false;
        });
        element.addEventListener('did-navigate', (event) => {
          this.url = event.url || this.url;
          this.failure = null;
          this.title = safeTitle(element);
        });
        element.addEventListener('did-navigate-in-page', (event) => {
          if (event.isMainFrame) this.url = event.url || this.url;
        });
        element.addEventListener('page-title-updated', () => {
          this.title = safeTitle(element);
        });
        element.addEventListener('did-fail-load', (event) => {
          if (!event.isMainFrame || event.errorCode === -3) return;
          this.failure = { code: event.errorCode, description: event.errorDescription };
          log('warn', 'guest did-fail-load', { pageId: this.id, code: event.errorCode, description: event.errorDescription, url: event.validatedURL });
        });
        element.addEventListener('console-message', (event) => {
          const level = ['debug', 'info', 'warning', 'error'][event.level] || 'info';
          this.consoleEntries.push({ level, text: String(event.message || '').slice(0, 500), line: event.line, url: event.sourceId ? String(event.sourceId).slice(0, 200) : undefined });
          if (this.consoleEntries.length > 300) this.consoleEntries.shift();
        });
        element.addEventListener('render-process-gone', () => {
          this.failure = { code: 'render-process-gone', description: '页面渲染进程退出' };
          log('error', 'guest render-process-gone', { pageId: this.id });
        });

        if (host) host.appendChild(element);
        this.host = host || null;
        return this;
      }

      /** 把 guest 挂到可见容器（同一元素只能挂一处）。 */
      attach(host) {
        if (!this.element) return;
        if (this.element.parentElement !== host) {
          host.appendChild(this.element);
        }
        this.host = host;
      }

      detach() {
        if (this.element && this.element.parentElement) this.element.parentElement.removeChild(this.element);
        this.host = null;
      }

      async waitReady(timeoutMs) {
        const ok = await waitFor(() => (this.ready ? true : undefined), timeoutMs || 8000, 50);
        if (!ok) throw err('TIMEOUT', 'guest 未在 ' + (timeoutMs || 8000) + 'ms 内就绪');
      }

      /** 在 guest 主世界执行页面脚本。 */
      async exec(op, args) {
        if (!this.element) throw err('NO_PAGE', '页面已被销毁');
        const code = '(' + pageAgent.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(args || {}) + ')';
        const value = await this.element.executeJavaScript(code, true);
        return value;
      }

      /** 导航并等待加载完成（或超时）。超时不算失败，交给快照去暴露真实状态。 */
      async navigate(url, timeoutMs) {
        const budget = Math.max(3000, timeoutMs || 15000);
        const before = this.url;
        this.failure = null;
        const loaded = new Promise((resolve) => {
          const element = this.element;
          const done = () => {
            element.removeEventListener('did-stop-loading', done);
            element.removeEventListener('did-fail-load', done);
            resolve('event');
          };
          element.addEventListener('did-stop-loading', done);
          element.addEventListener('did-fail-load', done);
        });
        // loadURL 的 Promise 在重定向场景下会以 ERR_ABORTED 拒绝；这里只当信号用，不 await 到底。
        this.element.loadURL(url).then(() => undefined, (error) => {
          const message = String(error && error.message ? error.message : error);
          if (!message.includes('ERR_ABORTED')) log('warn', 'loadURL rejected', { url, message });
        });
        const outcome = await Promise.race([loaded, sleep(budget).then(() => 'timeout')]);
        await sleep(outcome === 'timeout' ? 300 : 250);
        // 失败有时比 did-stop-loading 还晚到（DNS/连接超时走的是浏览器自己的超时），
        // 再给 1.5s 观察一次；同时识别 Chromium 的错误页，别把空白错误页当成功快照交上去。
        if (this.failure === null) {
          const deadline = Date.now() + 1500;
          while (Date.now() < deadline && this.failure === null) {
            const state = await this.exec('state', {}).catch(() => null);
            if (state && typeof state.url === 'string' && state.url.startsWith('chrome-error://')) {
              this.failure = { code: -118, description: '页面无法加载（连接超时、DNS 失败或被网络拦截）' };
              break;
            }
            if (this.failure !== null) break;
            await sleep(150);
          }
        }
        if (this.failure) {
          throw err('LOAD_FAILED', '页面加载失败 (' + this.failure.code + '): ' + this.failure.description);
        }
        if (outcome === 'timeout') {
          log('warn', 'navigation wait timed out', { url, budget, observed: this.url, was: before });
        }
        return this;
      }

      async sendInput(event) {
        if (!this.element) throw err('NO_PAGE', '页面已被销毁');
        this.element.sendInputEvent(event);
      }

      /** tab 上显示的名字：优先真实标题，其次 URL，最后「空白页」。 */
      get label() {
        const title = String(this.title || '').trim();
        if (title && !title.startsWith('about:blank')) return title;
        if (this.url && !this.url.startsWith('about:blank')) return this.url;
        return '空白页';
      }

      async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        const element = this.element;
        this.element = null;
        try { if (element && element.parentElement) element.parentElement.removeChild(element); } catch { /* 忽略 */ }
        const lease = this.lease;
        this.lease = null;
        if (lease) {
          try { await globalThis.dshDesktop.browser.release(lease); } catch (error) { log('warn', 'release lease failed', { error }); }
        }
      }
    }

    function safeTitle(element) {
      try { return element.getTitle() || ''; } catch { return ''; }
    }

    // ────────────────────────────── 会话控制器 ──────────────────────────────

    /** 一个会话一个控制器：持有该会话的页面集合与可见宿主元素。 */
    class SessionController {
      constructor(sessionId) {
        this.sessionId = sessionId;
        this.pages = [];
        this.activeId = null;
        this.host = null;
        this.busy = 0;
        this.lastError = null;
        this.listeners = new Set();
        this.version = 0;
      }

      snapshot() {
        return {
          version: this.version,
          pages: this.pages.filter((page) => !page.disposed).map((page) => ({ id: page.id, url: page.url, title: page.label, active: page.id === this.activeId })),
          activeId: this.activeId,
          busy: this.busy > 0,
          lastError: this.lastError,
          attached: !!this.host,
        };
      }

      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }

      notify() {
        this.version += 1;
        for (const listener of [...this.listeners]) {
          try { listener(); } catch (error) { log('warn', 'session listener failed', { error }); }
        }
      }

      get active() {
        return this.pages.find((page) => page.id === this.activeId && !page.disposed) || null;
      }

      attach(host) {
        this.host = host;
        const active = this.active;
        if (active) active.attach(host);
        this.notify();
        return () => {
          if (this.host !== host) return;
          this.host = null;
          for (const page of this.pages) page.detach();
          this.notify();
        };
      }

      async ensurePage() {
        let active = this.active;
        if (active) {
          if (this.host && active.element && active.element.parentElement !== this.host) active.attach(this.host);
          return active;
        }
        active = new Page(this.sessionId);
        await active.create(this.host);
        await active.waitReady(10000);
        this.pages.push(active);
        this.activeId = active.id;
        this.notify();
        return active;
      }

      async newPage() {
        const page = new Page(this.sessionId);
        await page.create(this.host);
        await page.waitReady(10000);
        this.pages.push(page);
        this.activeId = page.id;
        this.notify();
        return page;
      }

      switchTo(id) {
        const page = this.pages.find((item) => item.id === id && !item.disposed);
        if (!page) throw err('NO_PAGE', '没有这个页面: ' + id);
        this.activeId = page.id;
        for (const other of this.pages) if (other !== page) other.detach();
        if (this.host) page.attach(this.host);
        this.notify();
        return page;
      }

      async closePage(id) {
        const target = id || this.activeId;
        const index = this.pages.findIndex((page) => page.id === target);
        if (index < 0) return false;
        const [page] = this.pages.splice(index, 1);
        await page.dispose();
        if (this.activeId === page.id) {
          const next = this.pages[this.pages.length - 1] || null;
          this.activeId = next ? next.id : null;
          if (next && this.host) next.attach(this.host);
        }
        this.notify();
        return true;
      }

      async dispose() {
        for (const page of this.pages.splice(0, this.pages.length)) await page.dispose();
        this.activeId = null;
        this.host = null;
        this.notify();
      }
    }

    /** sessionId → SessionController。 */
    const controllers = new Map();

    function controllerFor(sessionId, create) {
      let controller = controllers.get(sessionId);
      if (!controller && create) {
        controller = new SessionController(sessionId);
        controllers.set(sessionId, controller);
      }
      return controller;
    }

    // ────────────────────────────── 命令执行 ──────────────────────────────

    /** 执行一条来自 Host 的命令。返回 PROTOCOL.md §2 的 value。 */
    async function runCommand(command) {
      const op = String(command.op || '');
      const args = command.args && typeof command.args === 'object' ? command.args : {};
      const sessionId = command.sessionId;
      const controller = controllerFor(sessionId, true);
      controller.busy += 1;
      controller.notify();
      try {
        const value = await dispatch(controller, op, args);
        controller.lastError = null;
        return value;
      } catch (error) {
        controller.lastError = { code: error.bhCode || 'INTERNAL', message: String(error.message || error) };
        throw error;
      } finally {
        controller.busy = Math.max(0, controller.busy - 1);
        controller.notify();
      }
    }

    /** 会话级「上一帧全量快照」缓存：用于动作后回 delta（ref 由 client 保证稳定，diff 天然同套）。 */
    const lastFull = new Map();

    /** 拍一张全量快照，更新 lastFull，返回原始快照对象。 */
    async function fullSnapshot(page, args) {
      const raw = await snapshotOf(page, args);
      if (raw && typeof raw === 'object') lastFull.set(page.id, raw);
      return raw;
    }

    async function dispatch(controller, op, args) {
      if (!isDesktop()) throw err('NOT_DESKTOP', '当前页面不是桌面版，浏览器插件只在 DSH 桌面版可用');
      switch (op) {
        case 'open': {
          const page = args.newTab ? await controller.newPage() : await controller.ensurePage();
          await page.navigate(String(args.url), args.waitMs);
          return { pageId: page.id, url: page.url, title: page.title, snapshot: await fullSnapshot(page, args) };
        }
        case 'snapshot': {
          const page = await controller.ensurePage();
          return { snapshot: await fullSnapshot(page, args) };
        }
        case 'find': {
          const page = await controller.ensurePage();
          const value = await page.exec('find', { text: String(args.text || ''), limit: args.limit });
          if (!value || value.ok !== true) throw err((value && value.code) || 'INTERNAL', (value && value.message) || '查找失败');
          return { query: value.query, matches: value.matches };
        }
        case 'click': {
          const page = await controller.ensurePage();
          const result = await clickPage(page, args, lastFull);
          return result;
        }
        case 'type': {
          const page = await controller.ensurePage();
          return typePage(page, args, lastFull);
        }
        case 'press': {
          const page = await controller.ensurePage();
          return pressPage(page, args, lastFull);
        }
        case 'scroll': {
          const page = await controller.ensurePage();
          return scrollPage(page, args, lastFull);
        }
        case 'nav': {
          const page = await controller.ensurePage();
          const action = String(args.action || 'reload');
          if (action === 'goto') {
            await page.navigate(String(args.url), args.waitMs);
          } else if (action === 'back') {
            if (!page.element.canGoBack()) throw err('NAV_BLOCKED', '没有可后退的历史');
            page.element.goBack();
            await settle(page);
          } else if (action === 'forward') {
            if (!page.element.canGoForward()) throw err('NAV_BLOCKED', '没有可前进的历史');
            page.element.goForward();
            await settle(page);
          } else {
            page.element.reload();
            await settle(page);
          }
          const value = { action, url: page.url, title: page.title };
          if (args.snapshot !== false) value.snapshot = await fullSnapshot(page, args);
          return value;
        }
        case 'screenshot': {
          const page = await controller.ensurePage();
          return screenshot(page, args);
        }
        case 'tabs': {
          const action = String(args.action || 'list');
          if (action === 'new') {
            const page = await controller.newPage();
            return tabsValue(controller, page.id);
          }
          if (action === 'switch') {
            controller.switchTo(String(args.id));
            return tabsValue(controller, controller.activeId);
          }
          if (action === 'close') {
            await controller.closePage(args.id ? String(args.id) : undefined);
            return tabsValue(controller, controller.activeId);
          }
          return tabsValue(controller, controller.activeId);
        }
        case 'console': {
          const page = controller.active;
          if (!page) return { entries: [] };
          const limit = typeof args.limit === 'number' ? args.limit : 50;
          const domEntries = [];
          try {
            const result = await page.exec('console', { limit });
            if (result && result.ok) domEntries.push(...result.entries);
          } catch (error) {
            log('warn', 'read page console failed', { error });
          }
          const entries = [...page.consoleEntries, ...domEntries].slice(-limit);
          return { entries };
        }
        case 'network': {
          const page = controller.active;
          if (!page) return { entries: [] };
          const limit = typeof args.limit === 'number' ? args.limit : 60;
          let entries = [];
          try {
            const result = await page.exec('net', { limit });
            if (result && result.ok) entries = result.entries || [];
          } catch (error) {
            log('warn', 'read page network failed', { error });
          }
          return { entries };
        }
        case 'eval': {
          const page = await controller.ensurePage();
          const result = await page.exec('eval', { code: String(args.code || '') });
          if (!result || result.ok !== true) throw err(result && result.code ? result.code : 'INTERNAL', (result && result.message) || '求值失败');
          return { value: result.value };
        }
        case 'close': {
          // 只释放页面（销毁 guest），保留 tab 宿主：否则右栏 tab 还在、host 却被清空，
          // 下一次 browser_open 调 openTab 会被当成「已打开」而不再挂载 → NO_CLIENT 死锁。
          const closed = controller.pages.length;
          for (const page of controller.pages.splice(0, controller.pages.length)) await page.dispose();
          controller.activeId = null;
          controller.lastError = null;
          controller.notify();
          return { closed: true, pages: closed };
        }
        case 'ping': {
          return { pong: true, pageCount: controller.pages.length };
        }
        default:
          throw err('INTERNAL', '未知命令: ' + op);
      }
    }

    function tabsValue(controller, activeId) {
      return {
        activeId: activeId || null,
        tabs: controller.pages.filter((page) => !page.disposed).map((page) => ({
          id: page.id,
          url: page.url,
          title: page.label,
          active: page.id === (activeId || controller.activeId),
        })),
      };
    }

    async function snapshotOf(page, args) {
      const value = await page.exec('snapshot', {
        pageId: page.id,
        maxElements: args.maxElements,
        textLimit: args.textLimit,
        scope: args.scope,
        text: args.text,
      });
      if (!value || typeof value !== 'object') throw err('INTERNAL', '页面快照失败');
      return value;
    }

    /** 动作之后等页面静下来（网络/渲染），再拍快照。任何异常都吞掉：它只是节流用的等待。 */
    async function settle(page) {
      try {
        await sleep(180);
        for (let attempt = 0; attempt < 12; attempt += 1) {
          if (!page.loading) break;
          await sleep(150);
        }
      } catch (error) {
        log('debug', 'settle skipped', { error });
      }
    }

    /** 观察页面是否发生了变化（URL / DOM 变更数 / 焦点），用于判断真实输入是否生效。 */
    async function waitForChange(page, before, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(110);
        if (page.loading) return true;
        let state = null;
        try { state = await page.exec('state', {}); } catch { return true; }
        if (!state) continue;
        if (state.url !== before.url || state.mutations !== before.mutations || state.activeRef !== before.activeRef) return true;
      }
      return false;
    }

    async function clickPage(page, args, lastFull) {
      const before = await page.exec('state', {});
      const beforeSnap = lastFull.get(page.id) || null;
      let usedRef = null;
      if (args.ref) {
        const rect = await page.exec('rect', { ref: String(args.ref) });
        if (!rect || rect.ok !== true) throw err('NO_REF', '元素 ' + args.ref + ' 已失效（页面可能变化了），请先重新快照');
        const x = Math.round(rect.rect.x);
        const y = Math.round(rect.rect.y);
        usedRef = String(args.ref);
        try {
          await page.sendInput({ type: 'mouseMove', x, y });
          await sleep(20);
          await page.sendInput({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          await page.sendInput({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        } catch (error) {
          log('warn', 'sendInputEvent click failed; will fall back', { error });
        }
        // 真实输入管线优先；只有确实没有反应（且没在导航）时才退回 DOM click，避免重复触发。
        let changed = await waitForChange(page, before, 900);
        if (!changed && !page.loading) {
          const fallback = await page.exec('clickDom', { ref: usedRef });
          if (fallback && fallback.ok !== true) throw err(fallback.code || 'NO_REF', fallback.message || '元素已失效');
          changed = await waitForChange(page, before, 700);
        }
      } else if (typeof args.x === 'number' && typeof args.y === 'number') {
        const x = Math.round(args.x);
        const y = Math.round(args.y);
        try {
          await page.sendInput({ type: 'mouseMove', x, y });
          await page.sendInput({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          await page.sendInput({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        } catch (error) {
          log('warn', 'coordinate click sendInputEvent failed', { error });
        }
        const changed = await waitForChange(page, before, 900);
        if (!changed && !page.loading) {
          await page.exec('clickAt', { x, y });
          await sleep(180);
        }
      } else {
        throw err('INTERNAL', 'click 需要 ref 或 x/y');
      }
      await settle(page);
      const afterState = await page.exec('state', {});
      const changed = !!afterState && !!before && (afterState.url !== before.url || afterState.mutations !== before.mutations);
      const value = { action: 'click', changed, url: page.url, title: page.title };
      if (args.snapshot !== false) value.snapshot = await fullSnapshot(page, args);
      else lastFull.set(page.id, beforeSnap);
      return value;
    }

    async function typePage(page, args, lastFull) {
      const ref = String(args.ref || '');
      const text = String(args.text ?? '');
      const focus = await page.exec('focus', { ref, clear: args.clear === true });
      if (!focus || focus.ok !== true) throw err('NO_REF', '输入框 ' + ref + ' 已失效，请先重新快照');
      const before = await page.exec('state', {});
      if (args.clear === true) {
        await page.sendInput({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] });
        await page.sendInput({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] });
      }
      let typed = false;
      try {
        for (const character of text) {
          await page.sendInput({ type: 'char', keyCode: character });
        }
        await sleep(140);
        const current = await page.exec('readValue', { ref });
        const currentValue = current && current.ok === true ? String(current.value ?? '') : '';
        typed = currentValue === text || currentValue.trimEnd() === text.trimEnd();
      } catch (error) {
        log('warn', 'char input failed; falling back', { error });
      }
      if (!typed) {
        const fallback = await page.exec('typeFallback', { ref, text, clear: args.clear !== false });
        if (!fallback || fallback.ok !== true) throw err(fallback && fallback.code ? fallback.code : 'INTERNAL', (fallback && fallback.message) || '输入失败');
      }
      if (args.submit === true) {
        const submitted = await page.exec('submit', { ref });
        if (!submitted || submitted.ok !== true) {
          await pressPage(page, { key: 'Enter', snapshot: false });
        }
        await settle(page);
      }
      const after = await page.exec('state', {});
      const value = {
        action: 'type',
        changed: !!after && !!before && (after.url !== before.url || after.mutations !== before.mutations),
        url: page.url,
        title: page.title,
      };
      if (args.snapshot !== false) value.snapshot = await fullSnapshot(page, args);
      return value;
    }

    const KEY_MAP = {
      Enter: { keyCode: 'Enter', code: 'Enter', vk: 13 },
      Tab: { keyCode: 'Tab', code: 'Tab', vk: 9 },
      Escape: { keyCode: 'Escape', code: 'Escape', vk: 27 },
      Backspace: { keyCode: 'Backspace', code: 'Backspace', vk: 8 },
      Delete: { keyCode: 'Delete', code: 'Delete', vk: 46 },
      ArrowUp: { keyCode: 'ArrowUp', code: 'ArrowUp', vk: 38 },
      ArrowDown: { keyCode: 'ArrowDown', code: 'ArrowDown', vk: 40 },
      ArrowLeft: { keyCode: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
      ArrowRight: { keyCode: 'ArrowRight', code: 'ArrowRight', vk: 39 },
      PageUp: { keyCode: 'PageUp', code: 'PageUp', vk: 33 },
      PageDown: { keyCode: 'PageDown', code: 'PageDown', vk: 34 },
      Home: { keyCode: 'Home', code: 'Home', vk: 36 },
      End: { keyCode: 'End', code: 'End', vk: 35 },
      Space: { keyCode: ' ', code: 'Space', vk: 32 },
    };

    async function pressPage(page, args, lastFull) {
      const key = String(args.key || 'Enter');
      const mapped = KEY_MAP[key] || { keyCode: key, code: key, vk: 0 };
      const before = await page.exec('state', {});
      let sent = false;
      try {
        await page.sendInput({ type: 'keyDown', keyCode: mapped.keyCode, code: mapped.code });
        await page.sendInput({ type: 'keyUp', keyCode: mapped.keyCode, code: mapped.code });
        sent = true;
      } catch (error) {
        log('warn', 'key sendInputEvent failed; falling back', { error });
      }
      // 只有真实按键完全没反应时才补一次合成键盘事件，避免表单被提交两次。
      if (sent) {
        const changed = await waitForChange(page, before, 450);
        if (!changed && !page.loading) await page.exec('keyFallback', { key, code: mapped.code, keyCode: mapped.vk });
      } else {
        await page.exec('keyFallback', { key, code: mapped.code, keyCode: mapped.vk });
      }
      await settle(page);
      const value = { action: 'press', key, url: page.url, title: page.title };
      if (args.snapshot !== false) value.snapshot = await fullSnapshot(page, args);
      return value;
    }

    async function scrollPage(page, args, lastFull) {
      const dy = Number(args.dy || 0);
      const dx = Number(args.dx || 0);
      const before = await page.exec('state', {});
      let scrolled = false;
      try {
        const measure = await page.exec('measure', {});
        const centerX = 120;
        const centerY = Math.round(((measure && measure.ok && measure.viewport) || 600) / 2);
        await page.sendInput({ type: 'mouseWheel', x: centerX, y: centerY, deltaX: dx, deltaY: dy, canScroll: true });
        await sleep(280);
        const probe = await page.exec('state', {});
        scrolled = !!probe && !!before && probe.scrollY !== before.scrollY;
      } catch (error) {
        log('warn', 'wheel sendInputEvent failed; falling back', { error });
      }
      let scroll = null;
      if (!scrolled) {
        const dom = await page.exec('scrollDom', { dx, dy });
        scroll = dom && dom.ok ? dom.scroll : null;
        await sleep(120);
      } else {
        const measure = await page.exec('measure', {});
        scroll = { y: (await page.exec('state', {})).scrollY, height: measure && measure.height, viewport: measure && measure.viewport };
      }
      const afterState = await page.exec('state', {});
      const value = { action: 'scroll', scroll, changed: !!afterState && !!before && afterState.scrollY !== before.scrollY, url: page.url };
      if (args.snapshot !== false) value.snapshot = await fullSnapshot(page, args);
      return value;
    }

    async function screenshot(page, args) {
      if (!page.element || typeof page.element.capturePage !== 'function') {
        throw err('INTERNAL', '当前 Electron 版本不支持 capturePage');
      }
      let restoreHeight = null;
      try {
        if (args.fullPage) {
          const measure = await page.exec('measure', {});
          const height = Math.min(Math.round((measure && measure.height) || 800), 4000);
          restoreHeight = page.element.style.height;
          page.element.style.height = height + 'px';
          await sleep(320);
        }
        const image = await page.element.capturePage();
        // 主窗口是 sandbox 渲染进程，没有 Buffer：`image.toPNG()` 会直接抛
        // 「Buffer is not available for the current Context」，所以走 data URL 自己解码。
        const dataUrl = typeof image.toDataURL === 'function'
          ? image.toDataURL()
          : 'data:image/png;base64,' + image.toPNG().toString('base64');
        const comma = dataUrl.indexOf(',');
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
        if (base64 === '') throw err('INTERNAL', '截图内容为空');
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const size = image.getSize();
        const response = await fetch(ENDPOINT + '/shot?pageId=' + encodeURIComponent(page.id) + '&url=' + encodeURIComponent(page.url), {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: bytes,
        });
        const text = await response.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        if (!response.ok || !parsed || !parsed.ok) {
          throw err('INTERNAL', '截图上传失败: ' + (text || response.status));
        }
        return { path: parsed.path, bytes: parsed.bytes || bytes.length, width: size.width, height: size.height, pageId: page.id, url: page.url };
      } finally {
        if (restoreHeight !== null && page.element) page.element.style.height = restoreHeight;
      }
    }

    // ────────────────────────────── 轮询循环 ──────────────────────────────

    const pollState = { running: false, stopping: false, failures: 0, lastHello: 0 };

    function currentSessionId() {
      try {
        const sidebarRight = pluginCtx && pluginCtx.sidebarRight;
        const value = sidebarRight && sidebarRight.mounted ? sidebarRight.mounted.getSnapshot() : undefined;
        return typeof value === 'string' ? value : null;
      } catch (error) {
        log('warn', 'read mounted session failed', { error });
        return null;
      }
    }

    async function hello() {
      const response = await postJson('/hello', {
        clientId,
        sessionId: currentSessionId(),
        desktop: isDesktop(),
        version: VERSION,
      });
      pollState.lastHello = Date.now();
      if (response && response.ok === false) throw new Error(response.error && response.error.message);
      return response;
    }

    /** 确保 tab 已经打开（打开意味着面板展开、用户可见）。重复调用不会反复重建，只在确实没挂载时导航一次。 */
    async function ensureTab(sessionId) {
      const sidebarRight = pluginCtx && pluginCtx.sidebarRight;
      if (!sidebarRight) throw err('NO_CLIENT', '右侧栏服务不可用');
      const controller = controllerFor(sessionId, true);
      if (controller.host) return controller;
      const mounted = currentSessionId();
      if (mounted && mounted !== sessionId) {
        throw err('NO_CLIENT', '目标会话不在前台：请在 PC 上切到该会话后再试');
      }
      try {
        sidebarRight.openTab(TAB_KIND, { revealIfOpened: true });
      } catch (error) {
        throw err('NO_CLIENT', '无法打开浏览器标签页：' + String(error && error.message ? error.message : error));
      }
      const attached = await waitFor(() => (controller.host ? true : undefined), 6000, 60);
      if (!attached) throw err('NO_CLIENT', '浏览器标签页没有挂载（可能右侧栏被关闭）');
      return controller;
    }

    async function pollOnce() {
      const sessionId = currentSessionId();
      const url = ENDPOINT + '/poll?clientId=' + encodeURIComponent(clientId)
        + '&sessionId=' + encodeURIComponent(sessionId || '')
        + '&wait=20000';
      const response = await fetch(url, { method: 'GET' });
      if (response.status === 204) return null;
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error('未认证: ' + response.status), { fatal: true });
      }
      if (!response.ok) throw new Error('poll http ' + response.status);
      const text = await response.text();
      if (!text) return null;
      const parsed = JSON.parse(text);
      return parsed && parsed.command ? parsed.command : null;
    }

    async function pollLoop() {
      if (pollState.running) return;
      pollState.running = true;
      while (!pollState.stopping) {
        try {
          if (Date.now() - pollState.lastHello > 10000) await hello();
          if (!isDesktop()) { await sleep(3000); continue; }
          const command = await pollOnce();
          pollState.failures = 0;
          if (!command) continue;
          // 命令到达：先确保 tab 可见并挂载，再执行。
          const sessionId = command.sessionId || currentSessionId();
          if (!sessionId) {
            await postJson('/result', { id: command.id, ok: false, error: { code: 'NO_CLIENT', message: '没有屏幕上的会话' } }).catch(() => {});
            continue;
          }
          try {
            await ensureTab(sessionId);
            const value = await runCommand({ ...command, sessionId });
            await postJson('/result', { id: command.id, ok: true, value }).catch((error) => log('warn', 'post result failed', { error }));
          } catch (error) {
            const code = error && error.bhCode ? error.bhCode : 'INTERNAL';
            const message = String(error && error.message ? error.message : error);
            log(code === 'INTERNAL' ? 'error' : 'warn', 'command failed: ' + command.op, { code, message, error });
            await postJson('/result', { id: command.id, ok: false, error: { code, message } }).catch(() => {});
          }
        } catch (error) {
          if (error && error.fatal) {
            log('error', 'poll fatal; retrying in 10s', { error });
            await sleep(10000);
            continue;
          }
          pollState.failures += 1;
          const delay = Math.min(500 * Math.pow(2, Math.min(pollState.failures, 5)), 5000);
          if (pollState.failures <= 3) log('warn', 'poll failed', { error, delay });
          await sleep(delay);
        }
      }
      pollState.running = false;
    }

    function stopPolling() {
      pollState.stopping = true;
      postJson('/bye', { clientId }).catch(() => {});
    }

    // ────────────────────────────── UI ──────────────────────────────

    const STYLE = `
      .bh-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .bh-bar { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: .5px solid var(--dsw-alias-border-l3); flex: none; }
      .bh-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-quaternary); flex: none; }
      .bh-dot.busy { background: var(--dsw-alias-state-business-primary); }
      .bh-dot.error { background: var(--dsw-alias-state-error-primary); }
      .bh-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12); }
      .bh-chip { border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: var(--dsw-radius-sm); font: var(--dsw-font-xxs-12); padding: 2px 8px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
      .bh-chip.active { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-state-business-primary); }
      .bh-tabs { display: flex; gap: 4px; overflow-x: auto; flex: none; padding: 4px 8px; scrollbar-width: none; }
      .bh-tabs::-webkit-scrollbar { display: none; }
      .bh-viewport { flex: auto; min-height: 0; min-width: 0; position: relative; display: flex; }
      .bh-view { flex: auto; width: 100%; height: 100%; border: 0; display: flex; background: var(--dsw-alias-bg-base); }
      .bh-empty { margin: auto; padding: 24px; text-align: center; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); }
      .bh-error { flex: none; padding: 6px 12px; color: var(--dsw-alias-state-error-primary); font: var(--dsw-font-xxs-11); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
    `;

    const KICKOFF = '点工具条的「打开」或直接让 Agent 使用 browser_open 打开一个网址。';

    function HandsBody(props) {
      const sessionId = props.sessionId;
      const [controller] = React.useState(() => controllerFor(sessionId, true));
      const [state, setState] = React.useState(() => controller.snapshot());
      const hostRef = React.useRef(null);
      const [showOpen, setShowOpen] = React.useState(false);
      const [draft, setDraft] = React.useState('');

      React.useEffect(() => controller.subscribe(() => setState(controller.snapshot())), [controller]);

      React.useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        const detach = controller.attach(host);
        return () => {
          detach();
        };
      }, [controller]);

      const openUrl = () => {
        const value = draft.trim();
        if (!value) return;
        setShowOpen(false);
        setDraft('');
        runCommand({ id: 'ui-local', op: 'open', sessionId, args: { url: value } }).catch((error) => {
          controller.lastError = { code: error.bhCode || 'INTERNAL', message: String(error.message || error) };
          controller.notify();
        });
      };

      if (!isDesktop()) {
        return h('div', { className: 'bh-root' }, h('style', null, STYLE), h('div', { className: 'bh-empty' }, '受控浏览器只在 DSH 桌面版可用。'));
      }

      if (!sessionId) {
        return h('div', { className: 'bh-root' }, h('style', null, STYLE), h('div', { className: 'bh-empty' }, '没有会话。'));
      }

      return h('div', { className: 'bh-root' },
        h('style', null, STYLE),
        h('div', { className: 'bh-bar' },
          h('div', { className: 'bh-dot' + (state.lastError ? ' error' : state.busy ? ' busy' : ''), title: state.busy ? 'Agent 正在操作' : '空闲' }),
          h('div', { className: 'bh-url', title: state.pages.find((page) => page.active)?.url || '' },
            state.pages.find((page) => page.active)?.url || (showOpen ? '' : KICKOFF)),
          showOpen
            ? h('input', {
              className: 'bh-chip',
              autoFocus: true,
              value: draft,
              placeholder: '输入 https:// 地址后回车',
              onChange: (event) => setDraft(event.currentTarget.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') { event.preventDefault(); openUrl(); }
                if (event.key === 'Escape') setShowOpen(false);
              },
            })
            : h('button', { className: 'bh-chip', type: 'button', onClick: () => setShowOpen(true) }, '打开'),
        ),
        state.pages.length > 1
          ? h('div', { className: 'bh-tabs' }, state.pages.map((page) =>
            h('button', {
              key: page.id,
              type: 'button',
              className: 'bh-chip' + (page.active ? ' active' : ''),
              title: page.url,
              onClick: () => {
                try { controller.switchTo(page.id); } catch (error) { log('warn', 'switch tab failed', { error }); }
              },
            }, (page.title || page.url || '页面').slice(0, 24))))
          : null,
        state.lastError ? h('div', { className: 'bh-error' }, state.lastError.code + ' — ' + state.lastError.message) : null,
        h('div', { className: 'bh-viewport', ref: hostRef }),
      );
    }

    // ────────────────────────────── 插件入口 ──────────────────────────────

    const ZH = {
      'type.label': 'Agent 浏览器',
      'type.description': '模型可看可操作的浏览器',
      'guide.title': 'Agent 浏览器',
      'guide.description': '让模型看见并操作网页',
    };
    const EN = {
      'type.label': 'Agent browser',
      'type.description': 'A browser the model can see and drive',
      'guide.title': 'Agent browser',
      'guide.description': 'Let the model see and operate a web page',
    };

    function apply(ctx) {
      pluginCtx = ctx;
      const namespace = 'browserHands';
      let t = (key) => key;
      let localeReady = false;

      // 0) 先启动轮询再碰任何可能抛错的注册：只要模块被加载，Host 的 debug.jsonl
      //    里就一定能看到 hello/client-log，排障不会因为后面的注册失败而失明。
      try {
        globalThis.__dshBrowserHands = {
          version: VERSION,
          clientId,
          desktop: isDesktop(),
          controllers,
          pollState,
          log,
        };
        ctx.effect(() => {
          log('info', 'client module loaded', { clientId, desktop: isDesktop(), href: String(location.href).slice(0, 120) });
          pollLoop().catch((error) => log('error', 'poll loop crashed', { error }));
          return () => stopPolling();
        }, 'browser-hands.poll');
      } catch (error) {
        log('error', 'failed to start polling', { error });
      }

      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(() => {
            try {
              return ctx.locale.register(namespace, { zh: ZH, en: EN });
            } catch (error) {
              log('warn', 'locale.register(ns, dicts) failed; trying per-locale form', { error });
              const zhDispose = ctx.locale.register(namespace, 'zh', ZH);
              const enDispose = ctx.locale.register(namespace, 'en', EN);
              return () => { zhDispose(); enDispose(); };
            }
          }, 'browser-hands.copy');
          t = ctx.locale.bind(namespace);
          localeReady = true;
        }
      } catch (error) {
        log('warn', 'locale registration failed', { error });
      }

      const title = () => {
        try { return localeReady ? t('type.label') : 'Agent 浏览器'; } catch { return 'Agent 浏览器'; }
      };
      const description = () => {
        try { return localeReady ? t('guide.description') : '让模型看见并操作网页'; } catch { return '让模型看见并操作网页'; }
      };

      // 1) 注册 tab 类型（HMR 重放时重复注册会 throw，吞掉并说明）。
      ctx.effect(() => {
        try {
          return ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title,
            keepMounted: true,
            guide: [{ id: 'new', title, description }],
          });
        } catch (error) {
          log('error', 'sidebarRightTabs.register failed (maybe already registered by a previous generation)', { error });
          return () => {};
        }
      }, 'browser-hands.type');

      // 2) 注册 tab 正文。
      try {
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          ...(localeReady ? { locale: namespace } : {}),
        }, HandsBody)), 'browser-hands.body');
      } catch (error) {
        log('error', 'slot registration failed', { error });
      }

      // 3) 关 tab = 释放该会话的 guest（R1.5：关掉 tab 即停止）。
      try {
        ctx.effect(() => {
          const tabsService = ctx.sidebarRightTabs;
          const rightService = ctx.sidebarRight;
          const register = (service) => (service && typeof service.registerCloseHandler === 'function'
            ? service.registerCloseHandler(TAB_KIND, (sessionId) => {
              const controller = controllers.get(sessionId);
              if (controller) controller.dispose().catch((error) => log('warn', 'dispose controller failed', { error }));
            })
            : undefined);
          const dispose = register(tabsService) || register(rightService);
          return () => {
            if (typeof dispose === 'function') dispose();
          };
        }, 'browser-hands.close');
      } catch (error) {
        log('warn', 'close-handler registration failed', { error });
      }

      // 4) 插件卸载时回收全部 guest。
      ctx.effect(() => () => {
        for (const controller of controllers.values()) controller.dispose().catch(() => {});
        controllers.clear();
      }, 'browser-hands.dispose');
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply,
    };
  },
});

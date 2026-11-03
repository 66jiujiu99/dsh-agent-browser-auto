/**
 * agent-browser-auto — Client 半边。
 *
 * 职责（详见 PROTOCOL.md）：
 *  1. 注册右侧栏 tab 类型 `agent-browser`，tab 正文里挂一个**自己 acquire 的** <webview> guest；
 *  2. 常驻长轮询 Host 的 /agent-browser-auto/poll，把到来的命令翻译成对 webview 的操作；
 *  3. 命令需要时自动把 tab 打开（打开 = 面板展开、用户可见），执行完把结果回给 Host。
 *
 * 与 Host 的唯一契约是 PROTOCOL.md；任何一侧改字段都必须同步改另一边。
 *
 * 说明：本文件是纯 JavaScript（无构建步骤），由 Client 模块加载器按包名惰性加载。
 * React 来自浏览器的模块表，不要 import 任何 @deepseek-ai/* 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-browser-auto',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** tab 类型 id（也是 slot 的 key）与 kind。 */
    const TAB_ID = 'dsh-agent-browser-auto';
    /**
     * tab 类型。改名时**必须**跟着改：旧版本注册的 kind 会一直占着 side-bar 的
     * 注册表，HMR 重放时会抛 "already registered by a previous generation"，
     * 于是新注册失败、`openTab` 找不到可用的 tab，所有工具都退化成 NO_CLIENT。
     */
    const TAB_KIND = 'agent-browser-auto';
    const ENDPOINT = '/agent-browser-auto';
    /** lease 的存储分区身份：所有会话共用一份 cookie/存储，但各自持有独立 guest。 */
    const WORKSPACE_KEY = 'agent-browser-auto';
    const VERSION = 3;

    // ────────────────────────────── 基础设施 ──────────────────────────────

    let pluginCtx = null;
    let clientId = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const debugQueue = [];
    let debugTimer = 0;

    /** 上报日志（限流：每 120ms 合并一次）。失败静默，绝不因为日志把主流程打挂。 */
    function log(level, message, data) {
      const entry = { level, message: String(message), data: data === undefined ? undefined : safe(data) };
      if (level === 'error' || level === 'warn') console[level]('[agent-browser-auto]', message, data ?? '');
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
      if (!response.ok) throw new Error('agent-browser-auto http ' + response.status + ': ' + (text || '').slice(0, 300));
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

      function optionCandidate(el, native, index) {
        var label = native ? (el.label || el.text || textOf(el)) : textOf(el);
        var value = '';
        if (native) value = String(el.value == null ? '' : el.value);
        else if (el.getAttribute('value') !== null) value = String(el.getAttribute('value'));
        else if (el.getAttribute('data-value') !== null) value = String(el.getAttribute('data-value'));
        return { el: el, label: foldText(label, 200), value: value, index: index };
      }

      function optionNotFound(candidates) {
        var shown = [];
        for (var i = 0; i < Math.min(candidates.length, 8); i += 1) {
          var item = candidates[i];
          shown.push('[' + item.index + '] ' + JSON.stringify(item.label)
            + (item.value !== '' ? ' value=' + JSON.stringify(item.value) : ''));
        }
        return {
          ok: false,
          code: 'OPTION_NOT_FOUND',
          message: '找不到匹配选项；候选（最多 8 个）: ' + (shown.join(' | ') || '（无）'),
        };
      }

      function insideOptionContainer(el) {
        var node = el;
        while (node) {
          if (node.getAttribute) {
            var role = node.getAttribute('role');
            if (role === 'listbox' || role === 'menu') return true;
            var marker = String(node.getAttribute('class') || '') + ' ' + String(node.getAttribute('id') || '');
            var tokens = marker.toLowerCase().split(/\s+/);
            for (var i = 0; i < tokens.length; i += 1) {
              if (/(?:^|[-_])(dropdown|select|select2|ant-select|el-select)(?:[-_]|$)/.test(tokens[i])) return true;
            }
          }
          if (node.parentElement) node = node.parentElement;
          else {
            var root = node.getRootNode && node.getRootNode();
            node = root && root.host ? root.host : null;
          }
        }
        return false;
      }

      function collectOptionCandidates() {
        var out = [];
        function scan(root) {
          if (!root || !root.querySelectorAll) return;
          var nodes = root.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],li');
          for (var i = 0; i < nodes.length; i += 1) {
            var role = nodes[i].getAttribute('role');
            var explicitOption = role === 'option' || role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox';
            if (nodes[i].tagName === 'LI' && !explicitOption && !insideOptionContainer(nodes[i])) continue;
            if (isVisible(nodes[i])) out.push(optionCandidate(nodes[i], false, out.length));
          }
          var all = root.querySelectorAll('*');
          for (var j = 0; j < all.length; j += 1) {
            if (all[j].shadowRoot) scan(all[j].shadowRoot);
          }
          var frames = root.querySelectorAll('iframe,frame');
          for (var k = 0; k < frames.length; k += 1) {
            var doc = null;
            try { doc = frames[k].contentDocument; } catch (e) { doc = null; }
            if (doc && doc.documentElement) scan(doc);
          }
        }
        scan(document);
        return out;
      }

      async function selectCustomOption(found, args, kind) {
        try {
          if (typeof found.el.scrollIntoView === 'function') found.el.scrollIntoView({ block: 'center', inline: 'center' });
          found.el.click();
        } catch (e) {
          return { ok: false, code: 'INTERNAL', message: '打开下拉框失败: ' + String(e && e.message ? e.message : e) };
        }
        // 给常见 React/Vue 下拉一次渲染窗口；executeJavaScript 会等待这个 Promise。
        await new Promise(function (resolve) { setTimeout(resolve, 180); });
        var candidates = collectOptionCandidates();
        if (candidates.length === 0) {
          var popup = found.el.getAttribute && found.el.getAttribute('aria-haspopup');
          if (roleOf(found.el) === 'combobox' || popup === 'listbox' || popup === 'menu' || popup === 'true') {
            return optionNotFound(candidates);
          }
          return { ok: false, code: 'NOT_SELECT', message: '目标不是原生 select，点击后也没有可见下拉选项' };
        }
        var picked = null;
        if (kind === 'index') {
          if (args.index >= 0 && args.index < candidates.length) picked = candidates[args.index];
        } else if (kind === 'value') {
          var wantedValue = String(args.value);
          for (var i = 0; i < candidates.length; i += 1) {
            var valueAttr = candidates[i].el.getAttribute('value');
            var dataValue = candidates[i].el.getAttribute('data-value');
            if ((valueAttr !== null && String(valueAttr) === wantedValue)
              || (dataValue !== null && String(dataValue) === wantedValue)) {
              picked = candidates[i];
              break;
            }
          }
        } else {
          var wantedLabel = foldText(args.label, 200);
          for (var j = 0; j < candidates.length; j += 1) {
            if (candidates[j].label === wantedLabel) { picked = candidates[j]; break; }
          }
          if (!picked) {
            var partial = [];
            for (var k = 0; k < candidates.length; k += 1) {
              if (wantedLabel !== '' && candidates[k].label.indexOf(wantedLabel) >= 0) partial.push(candidates[k]);
            }
            if (partial.length === 1) picked = partial[0];
          }
        }
        if (!picked) return optionNotFound(candidates);
        try {
          picked.el.click();
        } catch (e) {
          return { ok: false, code: 'INTERNAL', message: '点击下拉选项失败: ' + String(e && e.message ? e.message : e) };
        }
        return {
          ok: true,
          ref: found.ref,
          selected: { value: picked.value, label: picked.label, index: picked.index },
          changed: true,
        };
      }

      function installDialogHandlers() {
        if (S.dialogsInstalled) return;
        S.dialogsInstalled = true;
        var originals = S.dialogOriginals = {
          alert: window.alert,
          confirm: window.confirm,
          prompt: window.prompt,
        };
        function wrap(type, original) {
          return function (message, defaultValue) {
            var armed = S.dialogResponse;
            if (!armed) return original.apply(this, arguments);
            S.dialogResponse = null;
            var promptText = null;
            if (type === 'prompt' && armed.action === 'accept') {
              promptText = typeof armed.promptText === 'string'
                ? armed.promptText
                : String(defaultValue == null ? '' : defaultValue);
            }
            S.lastDialog = {
              type: type,
              message: String(message == null ? '' : message),
              action: armed.action,
              promptText: promptText,
              at: Date.now(),
            };
            if (type === 'alert') return undefined;
            if (type === 'confirm') return armed.action === 'accept';
            return armed.action === 'accept' ? promptText : null;
          };
        }
        window.alert = wrap('alert', originals.alert);
        window.confirm = wrap('confirm', originals.confirm);
        window.prompt = wrap('prompt', originals.prompt);
      }

      switch (op) {
        case 'install': {
          installDialogHandlers();
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
        case 'waitProbe': {
          var waitState = args.state === 'hidden' ? 'hidden' : 'visible';
          var waitUrl = location.href;
          var waitMatched = false;
          if (typeof args.url === 'string') {
            // URL 条件只看当前地址，state 对 URL 不适用。
            waitMatched = waitUrl.indexOf(args.url) >= 0;
          } else if (typeof args.selector === 'string') {
            var waitElement = null;
            try {
              // 主文档 selector；不可用选择器必须让调用方立即知道。
              waitElement = document.querySelector(args.selector);
            } catch (e) {
              return {
                ok: false,
                code: 'INVALID_SELECTOR',
                message: String(e && e.message ? e.message : e),
              };
            }
            var waitVisible = !!waitElement && isVisible(waitElement);
            waitMatched = waitState === 'hidden' ? !waitVisible : waitVisible;
          } else if (typeof args.text === 'string') {
            var waitBodyText = '';
            try {
              // innerText 只包含可见正文，不包含 display:none 等隐藏文本。
              waitBodyText = String(document.body ? document.body.innerText || '' : '');
            } catch (e) {
              waitBodyText = '';
            }
            var waitTextFound = waitBodyText.indexOf(args.text) >= 0;
            waitMatched = waitState === 'hidden' ? !waitTextFound : waitTextFound;
          }
          return { ok: true, matched: waitMatched, url: waitUrl };
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
        case 'selectOption': {
          var foundSelect = resolveLoose(args.ref);
          if (!foundSelect) return { ok: false, code: 'NO_REF', message: '选择框 ' + args.ref + ' 已失效，请先重新快照' };
          var selectionKeys = [];
          if (Object.prototype.hasOwnProperty.call(args, 'value')) selectionKeys.push('value');
          if (Object.prototype.hasOwnProperty.call(args, 'label')) selectionKeys.push('label');
          if (Object.prototype.hasOwnProperty.call(args, 'index')) selectionKeys.push('index');
          if (selectionKeys.length !== 1) {
            return { ok: false, code: 'BAD_ARG', message: 'select 必须在 value / label / index 中恰好提供一个' };
          }
          var selectionKind = selectionKeys[0];
          if (selectionKind === 'index' && (!Number.isInteger(args.index) || args.index < 0)) {
            return { ok: false, code: 'BAD_ARG', message: 'select 的 index 必须是零基非负整数' };
          }
          if (foundSelect.el.tagName !== 'SELECT') return selectCustomOption(foundSelect, args, selectionKind);
          var selectEl = foundSelect.el;
          var nativeCandidates = [];
          for (var si = 0; si < selectEl.options.length; si += 1) {
            nativeCandidates.push(optionCandidate(selectEl.options[si], true, si));
          }
          var nativePicked = null;
          if (selectionKind === 'index') {
            if (args.index < nativeCandidates.length) nativePicked = nativeCandidates[args.index];
          } else if (selectionKind === 'value') {
            var nativeValue = String(args.value);
            for (var sj = 0; sj < nativeCandidates.length; sj += 1) {
              if (nativeCandidates[sj].value === nativeValue) { nativePicked = nativeCandidates[sj]; break; }
            }
          } else {
            var nativeLabel = foldText(args.label, 200);
            for (var sk = 0; sk < nativeCandidates.length; sk += 1) {
              if (nativeCandidates[sk].label === nativeLabel) { nativePicked = nativeCandidates[sk]; break; }
            }
          }
          if (!nativePicked) return optionNotFound(nativeCandidates);
          function selectSignature() {
            var selected = [];
            for (var i = 0; i < selectEl.options.length; i += 1) {
              if (selectEl.options[i].selected) selected.push(String(i));
            }
            return selected.join(',');
          }
          var beforeSelection = selectSignature();
          try {
            selectEl.selectedIndex = nativePicked.index;
            var selectView = selectEl.ownerDocument.defaultView || window;
            selectEl.dispatchEvent(new selectView.Event('input', { bubbles: true }));
            selectEl.dispatchEvent(new selectView.Event('change', { bubbles: true }));
          } catch (e) {
            return { ok: false, code: 'INTERNAL', message: '设置原生 select 失败: ' + String(e && e.message ? e.message : e) };
          }
          return {
            ok: true,
            ref: foundSelect.ref,
            selected: { value: nativePicked.value, label: nativePicked.label, index: nativePicked.index },
            changed: selectSignature() !== beforeSelection,
          };
        }
        case 'uploadFiles': {
          var foundUpload = resolveLoose(args.ref);
          if (!foundUpload) return { ok: false, code: 'NO_REF', message: '文件输入框 ' + args.ref + ' 已失效，请先重新快照' };
          var fileInput = foundUpload.el;
          if (fileInput.tagName !== 'INPUT' || String(fileInput.type || '').toLowerCase() !== 'file') {
            return { ok: false, code: 'NOT_FILE_INPUT', message: '目标元素不是 input[type=file]' };
          }
          if (!Array.isArray(args.files)) return { ok: false, code: 'UPLOAD_FAILED', message: '上传失败：files 必须是文件数组' };
          if (!fileInput.multiple && args.files.length > 1) {
            return { ok: false, code: 'UPLOAD_FAILED', message: '上传失败：该文件输入框不允许多选，只能上传 1 个文件' };
          }
          function uploadSignature() {
            var signature = [];
            for (var i = 0; fileInput.files && i < fileInput.files.length; i += 1) {
              var file = fileInput.files[i];
              signature.push(file.name + ':' + file.size + ':' + file.lastModified);
            }
            return signature.join('|');
          }
          var beforeUpload = uploadSignature();
          try {
            var uploadView = fileInput.ownerDocument.defaultView || window;
            var transfer = new uploadView.DataTransfer();
            for (var ui = 0; ui < args.files.length; ui += 1) {
              var item = args.files[ui];
              if (!item || typeof item.base64 !== 'string') throw new Error('第 ' + (ui + 1) + ' 个文件缺少 base64 内容');
              var rawName = String(item.name == null ? 'upload.bin' : item.name);
              var nameParts = rawName.split(/[\\/]/);
              var fileName = nameParts[nameParts.length - 1] || 'upload.bin';
              var binary = uploadView.atob(item.base64);
              var bytes = new uploadView.Uint8Array(binary.length);
              for (var uj = 0; uj < binary.length; uj += 1) bytes[uj] = binary.charCodeAt(uj);
              var file = new uploadView.File([bytes], fileName, {
                type: typeof item.type === 'string' ? item.type : '',
                lastModified: Date.now(),
              });
              transfer.items.add(file);
            }
            fileInput.files = transfer.files;
            fileInput.dispatchEvent(new uploadView.Event('input', { bubbles: true }));
            fileInput.dispatchEvent(new uploadView.Event('change', { bubbles: true }));
          } catch (e) {
            return { ok: false, code: 'UPLOAD_FAILED', message: '上传失败：' + String(e && e.message ? e.message : e) };
          }
          var uploaded = [];
          for (var uk = 0; fileInput.files && uk < fileInput.files.length; uk += 1) {
            uploaded.push({ name: String(fileInput.files[uk].name), size: Number(fileInput.files[uk].size) || 0 });
          }
          return { ok: true, ref: foundUpload.ref, files: uploaded, changed: uploadSignature() !== beforeUpload };
        }
        case 'dialogArm': {
          installDialogHandlers();
          var dialogAction = String(args.action || '');
          if (dialogAction !== 'accept' && dialogAction !== 'dismiss') {
            return { ok: false, code: 'BAD_ARG', message: 'dialog action 必须是 accept 或 dismiss' };
          }
          if (args.promptText !== undefined && typeof args.promptText !== 'string') {
            return { ok: false, code: 'BAD_ARG', message: 'dialog promptText 必须是字符串' };
          }
          var armedDialog = { action: dialogAction };
          if (typeof args.promptText === 'string') armedDialog.promptText = args.promptText;
          S.dialogResponse = armedDialog;
          return { ok: true, armed: armedDialog };
        }
        case 'dialogState': {
          return { ok: true, lastDialog: S.lastDialog || null };
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
      constructor(sessionId, owner) {
        this.sessionId = sessionId;
        this.owner = owner || null;
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

      notifyOwner() {
        if (this.owner) this.owner.notify();
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
          this.notifyOwner();
          this.exec('install', {}).catch((error) => log('warn', 'install page agent failed', { error }));
        });
        element.addEventListener('did-start-loading', () => {
          this.loading = true;
          this.notifyOwner();
        });
        element.addEventListener('did-stop-loading', () => {
          this.loading = false;
          this.notifyOwner();
        });
        element.addEventListener('did-navigate', (event) => {
          this.url = event.url || this.url;
          this.failure = null;
          this.title = safeTitle(element);
          this.notifyOwner();
        });
        element.addEventListener('did-navigate-in-page', (event) => {
          if (event.isMainFrame) {
            this.url = event.url || this.url;
            this.notifyOwner();
          }
        });
        element.addEventListener('page-title-updated', () => {
          this.title = safeTitle(element);
          this.notifyOwner();
        });
        element.addEventListener('did-fail-load', (event) => {
          if (!event.isMainFrame || event.errorCode === -3) return;
          this.failure = { code: event.errorCode, description: event.errorDescription };
          log('warn', 'guest did-fail-load', { pageId: this.id, code: event.errorCode, description: event.errorDescription, url: event.validatedURL });
          this.notifyOwner();
        });
        element.addEventListener('console-message', (event) => {
          const level = ['debug', 'info', 'warning', 'error'][event.level] || 'info';
          this.consoleEntries.push({ level, text: String(event.message || '').slice(0, 500), line: event.line, url: event.sourceId ? String(event.sourceId).slice(0, 200) : undefined });
          if (this.consoleEntries.length > 300) this.consoleEntries.shift();
        });
        // 只处理 embedder 实际收到的 F12；不向 guest 注入快捷键脚本。
        // Electron 是否把 guest 焦点的键盘事件转发到 webview 元素取决于运行环境。
        element.addEventListener('keydown', (event) => {
          if (event.key !== 'F12') return;
          event.preventDefault();
          event.stopPropagation();
          if (this.owner) this.owner.openDevTools(this.id);
        });
        element.addEventListener('render-process-gone', () => {
          this.loading = false;
          this.failure = { code: 'render-process-gone', description: '页面渲染进程退出' };
          log('error', 'guest render-process-gone', { pageId: this.id });
          this.notifyOwner();
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

      openDevTools() {
        if (!this.element || this.disposed) throw err('NO_PAGE', '没有可检查的轻量页面');
        if (typeof this.element.openDevTools !== 'function') {
          throw err('NOT_SUPPORTED', '当前 Electron 版本不支持打开 webview 开发者工具');
        }
        let opened = null;
        try {
          this.element.openDevTools();
          opened = typeof this.element.isDevToolsOpened === 'function' ? this.element.isDevToolsOpened() : null;
          log('info', 'embedded devtools state', { pageId: this.id, opened });
        } catch (error) {
          throw err('DEVTOOLS_FAILED', '打开开发者工具失败：' + String(error && error.message ? error.message : error));
        }
        if (opened === false) {
          throw err('DEVTOOLS_UNAVAILABLE', '当前宿主未打开轻量页面开发者工具；请启动真实 Chrome/Edge 后使用原生 F12');
        }
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
        this.owner = null;
        this.host = null;
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

    function safeHistoryCapability(element, method) {
      try {
        if (!element || typeof element[method] !== 'function') return null;
        return Boolean(element[method]());
      } catch {
        return null;
      }
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
        this.backend = null;
        this.listeners = new Set();
        this.version = 0;
      }

      snapshot() {
        return {
          version: this.version,
          pages: this.pages.filter((page) => !page.disposed).map((page) => ({
            id: page.id,
            url: page.url,
            title: page.label,
            active: page.id === this.activeId,
            loading: page.loading === true,
            failure: page.failure ? { code: page.failure.code, description: String(page.failure.description || '') } : null,
            canGoBack: safeHistoryCapability(page.element, 'canGoBack'),
            canGoForward: safeHistoryCapability(page.element, 'canGoForward'),
          })),
          activeId: this.activeId,
          busy: this.busy > 0,
          lastError: this.lastError,
          backend: this.backend ? {
            ...this.backend,
            real: this.backend.real ? { ...this.backend.real } : null,
          } : null,
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

      /** 只在 hello 成功后调用；无效或缺失状态不改变已有显示。 */
      setBackend(status) {
        if (!status || (status.backend !== 'embedded' && status.backend !== 'real')) return;
        const real = status.real && typeof status.real === 'object' ? {
          connected: typeof status.real.connected === 'boolean' ? status.real.connected : null,
          browser: typeof status.real.browser === 'string' ? status.real.browser : '',
          profileMode: typeof status.real.profileMode === 'string' ? status.real.profileMode : '',
        } : null;
        const next = {
          ok: status.ok !== false,
          backend: status.backend,
          real,
          message: typeof status.message === 'string' ? status.message : '',
        };
        if (JSON.stringify(next) === JSON.stringify(this.backend)) return;
        this.backend = next;
        this.notify();
      }

      get active() {
        return this.pages.find((page) => page.id === this.activeId && !page.disposed) || null;
      }

      openDevTools(pageId) {
        try {
          const page = pageId
            ? this.pages.find((item) => item.id === pageId && !item.disposed)
            : this.active;
          if (!page) throw err('NO_PAGE', '没有可检查的轻量页面');
          page.openDevTools();
          log('info', 'open devtools requested', { pageId: page.id });
          this.lastError = null;
          this.notify();
          return true;
        } catch (error) {
          this.lastError = { code: error.bhCode || 'INTERNAL', message: String(error.message || error) };
          this.notify();
          log('warn', 'open devtools failed', { error });
          return false;
        }
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
        active = new Page(this.sessionId, this);
        try {
          await active.create(this.host);
          await active.waitReady(10000);
        } catch (error) {
          await active.dispose().catch((disposeError) => log('warn', 'dispose failed page failed', { error: disposeError }));
          throw error;
        }
        this.pages.push(active);
        this.activeId = active.id;
        this.notify();
        return active;
      }

      async newPage() {
        const previous = this.active;
        for (const other of this.pages) other.detach();
        const page = new Page(this.sessionId, this);
        try {
          await page.create(this.host);
          await page.waitReady(10000);
        } catch (error) {
          await page.dispose().catch((disposeError) => log('warn', 'dispose failed page failed', { error: disposeError }));
          if (previous && !previous.disposed && this.host) previous.attach(this.host);
          throw error;
        }
        this.pages.push(page);
        this.activeId = page.id;
        for (const other of this.pages) if (other !== page) other.detach();
        if (this.host) page.attach(this.host);
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
        case 'wait': {
          const page = await controller.ensurePage();
          return waitPage(page, args);
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
        case 'select': {
          const page = await controller.ensurePage();
          return selectPage(page, args);
        }
        case 'upload': {
          const page = await controller.ensurePage();
          return uploadPage(page, args);
        }
        case 'dialog': {
          const page = await controller.ensurePage();
          const result = await page.exec('dialogArm', { action: args.action, promptText: args.promptText });
          if (!result || result.ok !== true) throw err((result && result.code) || 'INTERNAL', (result && result.message) || '预置对话框响应失败');
          return { action: 'dialog', armed: result.armed, url: page.url, title: page.title };
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

    /**
     * 动作之后等页面静下来（网络/渲染），再拍快照。
     * 总预算约 5 秒；连续 300ms 没有 loading 且 DOM mutations 不变即可提前返回。
     * 任何异常都吞掉：它只是优化等待，不能让动作失败。
     */
    async function settle(page) {
      const deadline = Date.now() + 5000;
      try {
        // 给点击/输入等动作一个触发渲染与导航的窗口。
        await sleep(120);
        let previousMutations;
        let quietSince = Date.now();
        while (Date.now() < deadline) {
          let state = null;
          try {
            state = await page.exec('state', {});
          } catch (error) {
            // 跳转期间 exec 可能短暂失败；等待仍受总预算限制。
            log('debug', 'settle state probe failed', { error });
          }
          const now = Date.now();
          const mutations = state && typeof state.mutations === 'number' ? state.mutations : null;
          if (page.loading || mutations === null || previousMutations === undefined || mutations !== previousMutations) {
            quietSince = now;
          } else if (now - quietSince >= 300) {
            return;
          }
          previousMutations = mutations;
          if (now >= deadline) return;
          await sleep(Math.min(120, deadline - now));
        }
      } catch (error) {
        log('debug', 'settle skipped', { error });
      }
    }

    /** 等待正文、主文档 selector 或 URL 条件成立；导航中的临时 exec 失败可重试。 */
    async function waitPage(page, args) {
      const startedAt = Date.now();
      const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.max(0, args.timeoutMs)
        : 10000;
      const state = args.state === 'hidden' ? 'hidden' : 'visible';
      const condition = {};
      if (typeof args.text === 'string') condition.text = args.text;
      else if (typeof args.selector === 'string') condition.selector = args.selector;
      else condition.url = String(args.url ?? '');
      condition.state = state;
      const deadline = startedAt + timeoutMs;

      for (;;) {
        let probe = null;
        try {
          probe = await page.exec('waitProbe', {
            text: args.text,
            selector: args.selector,
            url: args.url,
            state,
          });
        } catch (error) {
          // 页面跳转可能销毁本次执行上下文；明确的选择器错误不能重试。
          if (error && (error.bhCode === 'INVALID_SELECTOR' || error.code === 'INVALID_SELECTOR')) {
            throw err('INVALID_SELECTOR', String(error.message || error));
          }
          log('debug', 'wait probe failed; retrying', { error });
        }
        if (probe && probe.ok === false && probe.code === 'INVALID_SELECTOR') {
          throw err('INVALID_SELECTOR', probe.message || '无效的 CSS selector');
        }

        const now = Date.now();
        if (probe && probe.ok === true && probe.matched) {
          const value = {
            action: 'wait',
            condition,
            waitedMs: now - startedAt,
            url: page.url,
            title: page.title,
          };
          if (args.snapshot !== false) value.snapshot = await fullSnapshot(page, args);
          return value;
        }
        if (now >= deadline) {
          throw err('WAIT_TIMEOUT', '等待条件 ' + JSON.stringify(condition) + ' 在 ' + timeoutMs + 'ms 内未满足');
        }
        await sleep(Math.min(120, deadline - now));
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
          // pressPage 的独立调用默认会 settle；这里由 typePage 尾部统一等待，避免重复。
          await pressPage(page, { key: 'Enter', snapshot: false, skipSettle: true });
        }
      }
      // 普通输入与 submit 共用一次稳定等待。
      await settle(page);
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

    async function selectPage(page, args) {
      const ref = String(args.ref || '');
      const before = await page.exec('state', {});
      const result = await page.exec('selectOption', {
        ref,
        value: args.value,
        label: args.label,
        index: args.index,
      });
      if (!result || result.ok !== true) {
        throw err((result && result.code) || 'INTERNAL', (result && result.message) || '选择选项失败');
      }
      await settle(page);
      const after = await page.exec('state', {});
      const selected = result.selected || {};
      const value = {
        action: 'select',
        ref: result.ref || ref,
        selected: {
          value: String(selected.value ?? ''),
          label: String(selected.label ?? ''),
          index: Number(selected.index),
        },
        changed: result.changed === true || (!!after && !!before && (after.url !== before.url || after.mutations !== before.mutations)),
        url: page.url,
        title: page.title,
      };
      if (args.snapshot !== false) value.snapshot = await fullSnapshot(page, args);
      return value;
    }

    async function uploadPage(page, args) {
      const ref = String(args.ref || '');
      const before = await page.exec('state', {});
      const result = await page.exec('uploadFiles', { ref, files: args.files });
      if (!result || result.ok !== true) {
        throw err((result && result.code) || 'UPLOAD_FAILED', (result && result.message) || '上传失败');
      }
      await settle(page);
      const after = await page.exec('state', {});
      const files = Array.isArray(result.files) ? result.files.map((file) => ({
        name: String(file && file.name ? file.name : '').split(/[\\/]/).pop() || '',
        size: Number(file && file.size) || 0,
      })) : [];
      const value = {
        action: 'upload',
        ref: result.ref || ref,
        files,
        changed: result.changed === true || (!!after && !!before && (after.url !== before.url || after.mutations !== before.mutations)),
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
      if (args.skipSettle !== true) await settle(page);
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
      // 滚动可能触发懒加载；快照前等待 DOM 与 loading 稳定。
      await settle(page);
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
      const sessionId = currentSessionId();
      const response = await postJson('/hello', {
        clientId,
        sessionId,
        desktop: isDesktop(),
        version: VERSION,
      });
      pollState.lastHello = Date.now();
      if (response && response.ok === false) throw new Error(response.error && response.error.message);
      // 后端模式属于本次 hello 的会话；失败或字段无效时保留旧状态，不自动切换。
      if (sessionId && response && response.backend) {
        controllerFor(sessionId, true).setBackend(response.backend);
      }
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
      .bh-bar { display: flex; align-items: center; gap: 3px; padding: 5px 6px; border-bottom: .5px solid var(--dsw-alias-border-l3); flex: none; min-width: 0; }
      .bh-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-quaternary); flex: none; }
      .bh-dot.busy { background: var(--dsw-alias-state-business-primary); }
      .bh-dot.error { background: var(--dsw-alias-state-error-primary); }
      .bh-backend { flex: none; padding: 1px 5px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-11); white-space: nowrap; }
      .bh-backend.real { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
      .bh-backend-note { flex: none; padding: 4px 8px; border-bottom: .5px solid var(--dsw-alias-border-l3); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent); color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-11); line-height: 1.4; }
      .bh-page-loading { flex: none; color: var(--dsw-alias-state-business-primary); font: var(--dsw-font-xxs-11); white-space: nowrap; }
      .bh-icon-button { flex: 0 0 24px; width: 24px; padding: 2px 0; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xs-13); cursor: pointer; }
      .bh-devtools-button { flex: none; width: auto; padding: 2px 6px; font: var(--dsw-font-xxs-11); white-space: nowrap; }
      .bh-icon-button:disabled, .bh-tab-close:disabled { opacity: .45; cursor: default; }
      .bh-address { flex: 1; min-width: 60px; width: 100%; border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-sm); font: var(--dsw-font-xxs-12); padding: 3px 7px; outline: none; }
      .bh-address:focus { border-color: var(--dsw-alias-state-business-primary); }
      .bh-tabs { display: flex; gap: 4px; overflow-x: auto; flex: none; padding: 4px 6px; scrollbar-width: none; border-bottom: .5px solid var(--dsw-alias-border-l3); }
      .bh-tabs::-webkit-scrollbar { display: none; }
      .bh-tab { display: flex; align-items: stretch; flex: 0 1 160px; min-width: 72px; max-width: 180px; overflow: hidden; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); }
      .bh-tab.active { border-color: var(--dsw-alias-state-business-primary); }
      .bh-tab-main { flex: 1; min-width: 0; padding: 2px 6px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; cursor: pointer; }
      .bh-tab.active .bh-tab-main { color: var(--dsw-alias-label-primary); }
      .bh-tab-close { flex: 0 0 22px; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); cursor: pointer; }
      .bh-viewport { flex: auto; min-height: 0; min-width: 0; position: relative; display: flex; }
      .bh-guest-host { flex: auto; min-height: 0; min-width: 0; display: flex; }
      .bh-view { flex: auto; width: 100%; height: 100%; border: 0; display: flex; background: var(--dsw-alias-bg-base); }
      .bh-empty-overlay { position: absolute; inset: 0; display: flex; pointer-events: none; background: var(--dsw-alias-bg-base); }
      .bh-empty { margin: auto; padding: 24px; text-align: center; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); }
      .bh-error { flex: none; padding: 6px 10px; color: var(--dsw-alias-state-error-primary); font: var(--dsw-font-xxs-11); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); overflow-wrap: anywhere; }
      .bh-page-failure { display: flex; align-items: flex-start; gap: 8px; }
      .bh-error-text { flex: 1; min-width: 0; }
      .bh-retry { flex: none; padding: 1px 7px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: var(--dsw-font-xxs-11); cursor: pointer; }
    `;

    const KICKOFF = '在地址栏输入网址后按 Enter，或直接让 Agent 使用 browser_open。';

    function normalizeUiUrl(input) {
      const raw = String(input || '').trim();
      if (!raw) throw err('BAD_URL', '请输入网址');
      // example.com:8080 / localhost:3000 是主机加端口，不是 URL scheme。
      const hostWithPort = /^(?:localhost|127(?:\.\d{1,3}){3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?):\d+(?:[/?#]|$)/i.test(raw);
      const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(raw) && !hostWithPort;
      const candidate = hasScheme ? raw : 'https://' + raw.replace(/^\/\//, '');
      let parsed;
      try {
        parsed = new URL(candidate);
      } catch {
        throw err('BAD_URL', '网址格式无效，请输入有效的 http:// 或 https:// 地址');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw err('BAD_URL', '地址栏仅支持 http:// 或 https:// 网址');
      }
      if (!parsed.hostname) throw err('BAD_URL', '网址缺少有效主机名');
      if (!hasScheme) {
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1') {
          parsed.protocol = 'http:';
        }
      }
      return parsed.href;
    }

    function HandsBody(props) {
      const sessionId = props.sessionId;
      const [controller] = React.useState(() => controllerFor(sessionId, true));
      const [state, setState] = React.useState(() => controller.snapshot());
      const hostRef = React.useRef(null);
      const addressRef = React.useRef(null);
      const draftOwner = React.useRef(null);
      const tabActionBusy = React.useRef(false);
      const [draft, setDraft] = React.useState('');
      const [addressFocused, setAddressFocused] = React.useState(false);
      const [tabBusy, setTabBusy] = React.useState(false);
      const activePage = state.pages.find((page) => page.active) || null;
      const activeUrl = activePage ? activePage.url : '';
      const backend = state.backend;
      const backendLabel = backend && backend.backend === 'real'
        ? '真实 Chrome/Edge'
        : backend && backend.backend === 'embedded' ? '轻量内嵌' : '';
      const backendTitle = !backend ? '' : backend.backend === 'real'
        ? [
          '工具在独立浏览器窗口操作；本面板保留轻量页面，不与独立窗口同步。',
          backend.real && backend.real.browser ? '浏览器：' + backend.real.browser : '',
          backend.real && backend.real.profileMode ? '配置模式：' + backend.real.profileMode : '',
          backend.real && typeof backend.real.connected === 'boolean'
            ? '连接状态：' + (backend.real.connected ? '已连接' : '未连接') : '',
          backend.message,
        ].filter(Boolean).join('\n')
        : backend.message || 'Agent 工具使用本面板中的轻量内嵌页面。';

      React.useEffect(() => controller.subscribe(() => setState(controller.snapshot())), [controller]);

      React.useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        const detach = controller.attach(host);
        return () => {
          detach();
        };
      }, [controller]);

      React.useEffect(() => {
        if (draftOwner.current !== state.activeId || !addressFocused) {
          draftOwner.current = state.activeId;
          setDraft(activeUrl);
        }
      }, [state.activeId, activeUrl, addressFocused]);

      const reportError = (error) => {
        controller.lastError = { code: error.bhCode || 'INTERNAL', message: String(error.message || error) };
        controller.notify();
        log('warn', 'browser UI action failed', { error });
      };

      const openDevTools = () => {
        controller.openDevTools();
      };

      const openUrl = () => {
        if (!draft.trim() || controller.busy > 0 || tabActionBusy.current) return;
        let value;
        try {
          value = normalizeUiUrl(draft);
        } catch (error) {
          reportError(error);
          return;
        }
        const hasPage = !!controller.active;
        runCommand({
          id: 'ui-local',
          op: hasPage ? 'nav' : 'open',
          sessionId,
          args: hasPage ? { action: 'goto', url: value, snapshot: false } : { url: value, snapshot: false },
        }).catch(reportError);
      };

      const navigate = (action) => {
        if (!controller.active || controller.busy > 0 || tabActionBusy.current) return;
        runCommand({ id: 'ui-local', op: 'nav', sessionId, args: { action, snapshot: false } }).catch(reportError);
      };

      const createTab = async () => {
        if (controller.busy > 0 || tabActionBusy.current) return;
        tabActionBusy.current = true;
        setTabBusy(true);
        try {
          await controller.newPage();
          controller.lastError = null;
          controller.notify();
        } catch (error) {
          reportError(error);
        } finally {
          tabActionBusy.current = false;
          setTabBusy(false);
        }
      };

      const closeTab = async (id) => {
        if (controller.busy > 0 || tabActionBusy.current) return;
        tabActionBusy.current = true;
        setTabBusy(true);
        try {
          await controller.closePage(id);
          controller.lastError = null;
          controller.notify();
        } catch (error) {
          reportError(error);
        } finally {
          tabActionBusy.current = false;
          setTabBusy(false);
        }
      };

      const switchTab = (id) => {
        try {
          controller.switchTo(id);
          if (controller.lastError) {
            controller.lastError = null;
            controller.notify();
          }
        } catch (error) {
          reportError(error);
        }
      };

      if (!isDesktop()) {
        return h('div', { className: 'bh-root' }, h('style', null, STYLE), h('div', { className: 'bh-empty' }, '受控浏览器只在 DSH 桌面版可用。'));
      }

      if (!sessionId) {
        return h('div', { className: 'bh-root' }, h('style', null, STYLE), h('div', { className: 'bh-empty' }, '没有会话。'));
      }

      const commandDisabled = state.busy || tabBusy;
      return h('div', {
        className: 'bh-root',
        onKeyDown: (event) => {
          if (event.key !== 'F12') return;
          event.preventDefault();
          event.stopPropagation();
          openDevTools();
        },
      },
        h('style', null, STYLE),
        h('div', { className: 'bh-bar' },
          h('div', {
            className: 'bh-dot' + (state.lastError ? ' error' : state.busy ? ' busy' : ''),
            title: state.busy ? 'Agent 正在操作' : 'Agent 空闲',
            'aria-label': state.busy ? 'Agent 正在操作' : 'Agent 空闲',
          }),
          backendLabel ? h('span', {
            className: 'bh-backend ' + backend.backend,
            title: backendTitle,
            'aria-label': '后端模式：' + backendLabel,
          }, backendLabel) : null,
          activePage && activePage.loading
            ? h('span', { className: 'bh-page-loading', title: '页面正在加载', 'aria-label': '页面正在加载' }, '加载中')
            : null,
          h('button', {
            className: 'bh-icon-button',
            type: 'button',
            title: '后退',
            'aria-label': '后退',
            disabled: commandDisabled || !activePage || activePage.canGoBack !== true,
            onClick: () => navigate('back'),
          }, '←'),
          h('button', {
            className: 'bh-icon-button',
            type: 'button',
            title: '前进',
            'aria-label': '前进',
            disabled: commandDisabled || !activePage || activePage.canGoForward !== true,
            onClick: () => navigate('forward'),
          }, '→'),
          h('button', {
            className: 'bh-icon-button',
            type: 'button',
            title: '刷新',
            'aria-label': '刷新',
            disabled: commandDisabled || !activePage,
            onClick: () => navigate('reload'),
          }, '↻'),
          h('input', {
            ref: addressRef,
            className: 'bh-address',
            value: draft,
            placeholder: '输入 https:// 地址后回车',
            title: 'Enter 打开地址；Escape 恢复当前地址',
            'aria-label': '地址栏',
            spellCheck: false,
            autoCapitalize: 'off',
            autoCorrect: 'off',
            onFocus: () => {
              draftOwner.current = state.activeId;
              setAddressFocused(true);
            },
            onBlur: () => setAddressFocused(false),
            onChange: (event) => {
              draftOwner.current = state.activeId;
              setDraft(event.currentTarget.value);
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                openUrl();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                draftOwner.current = state.activeId;
                setDraft(activeUrl);
              }
            },
          }),
          h('button', {
            className: 'bh-icon-button',
            type: 'button',
            title: '新建标签',
            'aria-label': '新建标签',
            disabled: commandDisabled,
            onClick: createTab,
          }, '+'),
          h('button', {
            className: 'bh-icon-button bh-devtools-button',
            type: 'button',
            title: '打开轻量页面的开发者工具（F12）',
            'aria-label': '打开轻量页面的开发者工具',
            disabled: !activePage,
            onClick: openDevTools,
          }, '开发者工具'),
        ),
        backend && backend.backend === 'real'
          ? h('div', { className: 'bh-backend-note', role: 'note' },
            '真实模式下，工具在独立浏览器窗口操作；本面板保留轻量页面，不与独立窗口同步。')
          : null,
        state.pages.length > 0
          ? h('div', { className: 'bh-tabs', role: 'tablist', 'aria-label': '浏览器标签' }, state.pages.map((page) =>
            h('div', { key: page.id, className: 'bh-tab' + (page.active ? ' active' : '') },
              h('button', {
                type: 'button',
                role: 'tab',
                'aria-selected': page.active,
                className: 'bh-tab-main',
                title: (page.title || '页面') + '\n' + page.url,
                onClick: () => switchTab(page.id),
              }, page.title || page.url || '页面'),
              h('button', {
                type: 'button',
                className: 'bh-tab-close',
                title: '关闭标签',
                'aria-label': '关闭标签：' + (page.title || page.url || '页面'),
                disabled: commandDisabled,
                onClick: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  closeTab(page.id);
                },
              }, '×'))))
          : null,
        activePage && activePage.failure
          ? h('div', { className: 'bh-error bh-page-failure' },
            h('span', { className: 'bh-error-text' },
              '页面加载失败：' + (activePage.failure.description || '未知错误')
              + '（' + String(activePage.failure.code === undefined ? '未知代码' : activePage.failure.code) + '）'),
            h('button', {
              className: 'bh-retry',
              type: 'button',
              title: '重新加载当前页面',
              'aria-label': '重试加载当前页面',
              disabled: commandDisabled,
              onClick: () => navigate('reload'),
            }, '重试'))
          : null,
        state.lastError ? h('div', { className: 'bh-error' }, state.lastError.code + ' — ' + state.lastError.message) : null,
        h('div', { className: 'bh-viewport' },
          h('div', { className: 'bh-guest-host', ref: hostRef }),
          state.pages.length === 0 ? h('div', { className: 'bh-empty-overlay' }, h('div', { className: 'bh-empty' }, KICKOFF)) : null),
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
        }, 'agent-browser-auto.poll');
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
          }, 'agent-browser-auto.copy');
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
      }, 'agent-browser-auto.type');

      // 2) 注册 tab 正文。
      try {
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          ...(localeReady ? { locale: namespace } : {}),
        }, HandsBody)), 'agent-browser-auto.body');
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
        }, 'agent-browser-auto.close');
      } catch (error) {
        log('warn', 'close-handler registration failed', { error });
      }

      // 4) 插件卸载时回收全部 guest。
      ctx.effect(() => () => {
        for (const controller of controllers.values()) controller.dispose().catch(() => {});
        controllers.clear();
      }, 'agent-browser-auto.dispose');
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply,
    };
  },
});

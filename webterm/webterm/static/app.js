/* WebTerm front-end (no build step; xterm.js is loaded as a UMD global). */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const encoder = new TextEncoder();

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  // ------------------------------------------------------------ settings
  const SETTINGS_KEY = "webterm.settings";
  const DEFAULT_SETTINGS = { fontSize: 14, theme: "dark", cursorStyle: "block", cursorBlink: true };
  let settings = loadSettings();

  function loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* private mode etc. - settings just are not remembered */
    }
  }

  const THEMES = {
    dark: {
      background: "#0d1117", foreground: "#d6dde6", cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "#264f78",
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341",
      brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
    light: {
      background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", cursorAccent: "#ffffff",
      selectionBackground: "#b6d7ff",
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
      brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
  };
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function resolvedTheme() {
    if (settings.theme === "system") return darkQuery.matches ? "dark" : "light";
    return settings.theme === "light" ? "light" : "dark";
  }

  // Terminal output is not trusted (think "cat downloaded.txt"): only ever
  // open http(s) links, in a new tab without access to this page.
  function openLink(uri) {
    let url;
    try {
      url = new URL(uri);
    } catch {
      return;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      window.open(url.href, "_blank", "noopener,noreferrer");
    }
  }

  // OSC 8 hyperlinks can show text that differs from their target: ask first.
  const hyperlinkHandler = {
    allowNonHttpProtocols: false,
    activate: (_event, uri) => {
      confirmDialog("링크를 열까요?", uri, "열기").then((ok) => ok && openLink(uri));
    },
  };

  function termOptions() {
    return {
      linkHandler: hyperlinkHandler,
      fontSize: settings.fontSize,
      fontFamily: '"JetBrains Mono", "D2Coding", "Cascadia Mono", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
      theme: THEMES[resolvedTheme()],
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: 5000,
      macOptionIsMeta: true,
    };
  }

  function applySettings() {
    document.documentElement.dataset.theme = resolvedTheme();
    for (const tab of state.tabs) {
      tab.term.options.fontSize = settings.fontSize;
      tab.term.options.theme = THEMES[resolvedTheme()];
      tab.term.options.cursorStyle = settings.cursorStyle;
      tab.term.options.cursorBlink = settings.cursorBlink;
      tab.scheduleFit();
    }
  }
  darkQuery.addEventListener("change", () => settings.theme === "system" && applySettings());

  // ------------------------------------------------------------------ api
  const MESSAGES = {
    auth_failed: "사용자 이름 또는 비밀번호가 올바르지 않거나 로그인이 허용되지 않은 계정입니다.",
    password_expired: "비밀번호가 만료되었습니다. SSH 등으로 로그인해 비밀번호를 변경하세요.",
    too_many_attempts: "로그인 실패가 너무 많습니다. {retryAfter}초 후에 다시 시도하세요.",
    helper_unavailable: "서버의 인증 서비스(webterm-helper)에 연결할 수 없습니다. 관리자에게 문의하세요.",
    bad_origin: "허용되지 않은 출처(Origin)에서 보낸 요청입니다.",
    bad_csrf_token: "보안 토큰이 올바르지 않습니다. 페이지를 새로고침하세요.",
    cross_site_request: "다른 사이트에서 보낸 요청은 허용되지 않습니다.",
    unauthorized: "세션이 만료되었습니다. 다시 로그인하세요.",
    too_many_terminals: "터미널은 최대 {limit}개까지 열 수 있습니다.",
    exists: "같은 이름의 파일이 이미 있습니다.",
    not_found: "파일 또는 디렉터리를 찾을 수 없습니다.",
    permission_denied: "권한이 없습니다.",
    read_only: "읽기 전용 파일 시스템입니다.",
    not_a_directory: "대상 경로가 디렉터리가 아닙니다.",
    is_a_directory: "디렉터리는 받을 수 없습니다. tar 로 묶은 뒤 다운로드하세요.",
    not_a_regular_file: "일반 파일만 다운로드할 수 있습니다.",
    target_is_directory: "같은 이름의 디렉터리가 있어 업로드할 수 없습니다.",
    invalid_name: "파일 이름이 올바르지 않습니다.",
    invalid_path: "경로를 입력하세요.",
    name_too_long: "이름이 너무 깁니다.",
    no_space: "디스크 공간(또는 할당량)이 부족합니다.",
    too_large: "파일이 너무 큽니다. (최대 {limitText})",
    incomplete: "업로드가 중간에 끊겼습니다.",
    length_required: "파일 크기를 알 수 없습니다.",
    network: "서버에 연결할 수 없습니다. 네트워크를 확인하세요.",
    aborted: "취소되었습니다.",
  };

  class ApiError extends Error {
    constructor(status, code, data) {
      super(code);
      this.status = status;
      this.code = code;
      this.data = data || {};
    }
  }

  function errorText(err) {
    if (!(err instanceof ApiError)) return String(err && err.message ? err.message : err);
    const data = { ...err.data };
    if (data.limit) data.limitText = formatBytes(data.limit);
    const template = MESSAGES[err.code] || `오류가 발생했습니다. (${err.code})`;
    return template.replace(/\{(\w+)\}/g, (_, k) => (data[k] != null ? data[k] : ""));
  }

  async function api(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (state.csrf) headers["X-CSRF-Token"] = state.csrf;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "network");
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) throw new ApiError(res.status, data.error || `http_${res.status}`, data);
    return data;
  }

  // Errors from an authenticated call: a 401 sends the user back to login.
  function handleError(err) {
    if (err instanceof ApiError && err.status === 401) {
      sessionLost();
      return;
    }
    toast(errorText(err), "error");
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = n;
    let unit = -1;
    do {
      value /= 1024;
      unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
  }

  function formatDuration(sec) {
    if (sec >= 3600) return `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분`;
    if (sec >= 60) return `${Math.ceil(sec / 60)}분`;
    return `${Math.max(0, Math.floor(sec))}초`;
  }

  // --------------------------------------------------------------- state
  const state = {
    info: null,
    csrf: null,
    tabs: [],
    active: null,
    idleDeadline: null,
    timers: [],
  };

  // --------------------------------------------------------------- toasts
  function toast(text, kind = "info", ms = 4500) {
    const node = el("div", { class: `toast ${kind}`, text });
    $("#toasts").append(node);
    setTimeout(() => node.remove(), ms);
  }

  // -------------------------------------------------------------- dialogs
  function confirmDialog(title, text, okLabel = "확인") {
    const dialog = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    $("#confirm-ok").textContent = okLabel;
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    });
  }

  function openDialog(id) {
    closeMenus();
    const dialog = $(id);
    if (!dialog.open) dialog.showModal();
    return dialog;
  }

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => {
      if (state.active) state.active.focus();
    });
  });
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => btn.closest("dialog").close());
  });

  // ---------------------------------------------------------------- tabs
  class TermTab {
    constructor(id) {
      this.id = id;
      this.offset = 0;
      this.ws = null;
      this.retries = 0;
      this.status = "connecting";
      this.title = "터미널";
      this.exited = false;
      this.replaced = false;
      this.disposed = false;
      this.reconnectTimer = null;
      this.fitFrame = 0;

      this.el = el("div", { class: "term-pane", role: "tabpanel" });
      $("#terminals").append(this.el);
      this.term = new Terminal(termOptions());
      this.fit = new FitAddon.FitAddon();
      this.term.loadAddon(this.fit);
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => openLink(uri)));
      this.term.open(this.el);
      this.term.onData((data) => this.onInput(data));
      this.term.onBinary((data) => this.sendBytes(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
      this.term.onResize(({ cols, rows }) => {
        this.sendControl({ t: "resize", cols, rows });
        if (this === state.active) renderStatus();
      });
      this.term.onTitleChange((title) => {
        this.title = title || "터미널";
        renderTabs();
      });
      this.term.attachCustomKeyEventHandler((ev) => terminalKeyHandler(ev, this));
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
      this.resizeObserver.observe(this.el);
    }

    focus() {
      if (!this.disposed) this.term.focus();
    }

    scheduleFit() {
      cancelAnimationFrame(this.fitFrame);
      this.fitFrame = requestAnimationFrame(() => this.fitNow());
    }

    fitNow() {
      if (this.disposed || this.el.hidden || !this.el.clientWidth || !this.el.clientHeight) return;
      try {
        this.fit.fit();
      } catch {
        /* not rendered yet */
      }
    }

    setStatus(status) {
      this.status = status;
      renderTabs();
      if (this === state.active) renderStatus();
    }

    onInput(data) {
      if (this.exited) {
        if (data === "\r") this.restart();
        return;
      }
      if (this.replaced) {
        if (data === "\r") {
          this.replaced = false;
          this.connect();
        }
        return;
      }
      this.sendBytes(encoder.encode(data));
    }

    sendBytes(bytes) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(bytes);
        noteActivity();
      }
    }

    sendControl(msg) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    connect() {
      clearTimeout(this.reconnectTimer);
      if (this.disposed || !this.id) return;
      this.setStatus(this.retries ? "reconnecting" : "connecting");
      const url = new URL(`ws/terminals/${encodeURIComponent(this.id)}?offset=${this.offset}`, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        this.fitNow();
        this.sendControl({ t: "resize", cols: this.term.cols, rows: this.term.rows });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          this.onControl(msg);
          return;
        }
        const data = new Uint8Array(ev.data);
        this.offset += data.length;
        this.term.write(data);
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.onClose(ev);
      };
    }

    onControl(msg) {
      switch (msg.t) {
        case "hello":
          if (msg.reset) this.term.reset();
          this.offset = msg.offset;
          this.retries = 0;
          this.setStatus("connected");
          setIdle(msg.idleRemaining);
          break;
        case "pong":
          setIdle(msg.idleRemaining);
          break;
        case "exit":
          this.markExited("프로세스가 종료되었습니다.");
          break;
        default:
          break;
      }
    }

    onClose(ev) {
      if (this.disposed) return;
      if (ev.code === 4001) {
        sessionLost();
        return;
      }
      if (ev.code === 4004) {
        this.markExited("터미널 세션이 종료되었습니다.");
        return;
      }
      if (ev.code === 4000) {
        this.replaced = true;
        this.setStatus("replaced");
        this.term.write("\r\n\x1b[33m[다른 브라우저 창에서 이 터미널에 연결했습니다. Enter 키를 누르면 이 창으로 다시 가져옵니다.]\x1b[0m\r\n");
        return;
      }
      if (this.exited) return;
      const delay = Math.min(15000, 1000 * 2 ** this.retries);
      this.retries += 1;
      this.setStatus("reconnecting");
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    markExited(text) {
      if (this.exited) return;
      this.exited = true;
      this.setStatus("exited");
      this.term.write(`\r\n\x1b[2m[${text} Enter 키를 누르면 새 세션을 시작합니다.]\x1b[0m\r\n`);
    }

    async restart() {
      if (this.restarting) return;
      this.restarting = true;
      try {
        const info = await api("POST", "api/terminals", { cols: this.term.cols, rows: this.term.rows });
        this.id = info.id;
        this.offset = 0;
        this.retries = 0;
        this.exited = false;
        this.title = "터미널";
        this.term.reset();
        this.connect();
      } catch (err) {
        handleError(err);
      } finally {
        this.restarting = false;
      }
    }

    dispose() {
      this.disposed = true;
      clearTimeout(this.reconnectTimer);
      cancelAnimationFrame(this.fitFrame);
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        ws.close();
      }
      this.resizeObserver.disconnect();
      this.term.dispose();
      this.el.remove();
    }
  }

  function renderTabs() {
    const container = $("#tabs");
    container.replaceChildren(
      ...state.tabs.map((tab, index) => {
        const close = el("button", {
          class: "tab-close",
          title: "탭 닫기",
          "aria-label": "탭 닫기",
          text: "×",
          onclick: (ev) => {
            ev.stopPropagation();
            closeTab(tab);
          },
        });
        return el(
          "div",
          {
            class: `tab${tab === state.active ? " active" : ""}`,
            role: "tab",
            "aria-selected": tab === state.active ? "true" : "false",
            title: tab.title,
            onclick: () => activateTab(tab),
            onauxclick: (ev) => ev.button === 1 && closeTab(tab),
          },
          el("span", { class: `tab-state ${tab.status}` }),
          el("span", { class: "tab-title", text: `${index + 1}: ${tab.title}` }),
          close,
        );
      }),
    );
    if (state.active) {
      document.title = `${state.active.title} — ${state.info ? state.info.title : "WebTerm"}`;
    }
  }

  const STATUS_TEXT = {
    connecting: "연결 중…",
    reconnecting: "연결이 끊겼습니다. 다시 연결하는 중…",
    connected: "연결됨",
    exited: "세션 종료됨",
    replaced: "다른 창에서 사용 중",
  };

  function renderStatus() {
    const tab = state.active;
    const status = tab ? tab.status : "connecting";
    $("#status-dot").className = `status-dot ${status}`;
    $("#status-text").textContent = STATUS_TEXT[status] || status;
    $("#status-size").textContent = tab ? `${tab.term.cols}×${tab.term.rows}` : "";
  }

  function activateTab(tab) {
    state.active = tab;
    for (const t of state.tabs) t.el.hidden = t !== tab;
    renderTabs();
    renderStatus();
    requestAnimationFrame(() => {
      tab.fitNow();
      tab.focus();
    });
  }

  function addTab(id) {
    const tab = new TermTab(id);
    state.tabs.push(tab);
    activateTab(tab);
    return tab;
  }

  async function newTab() {
    if (state.info && state.tabs.length >= state.info.maxTerminals) {
      toast(errorText(new ApiError(409, "too_many_terminals", { limit: state.info.maxTerminals })), "error");
      return;
    }
    const tab = addTab(null);
    tab.fitNow();
    try {
      const info = await api("POST", "api/terminals", { cols: tab.term.cols, rows: tab.term.rows });
      tab.id = info.id;
      tab.connect();
    } catch (err) {
      removeTab(tab);
      handleError(err);
    }
  }

  function removeTab(tab) {
    const index = state.tabs.indexOf(tab);
    if (index < 0) return;
    tab.dispose();
    state.tabs.splice(index, 1);
    if (state.active === tab) {
      state.active = null;
      const next = state.tabs[Math.min(index, state.tabs.length - 1)];
      if (next) activateTab(next);
    }
    renderTabs();
  }

  async function closeTab(tab) {
    if (!tab.exited && tab.id) {
      const ok = await confirmDialog("터미널을 닫을까요?", "이 탭에서 실행 중인 프로그램도 함께 종료됩니다.", "닫기");
      if (!ok) return;
    }
    const id = tab.exited ? null : tab.id;
    removeTab(tab);
    if (id) api("DELETE", `api/terminals/${encodeURIComponent(id)}`).catch(() => {});
    if (!state.tabs.length) newTab();
  }

  function cycleTab(step) {
    if (!state.tabs.length) return;
    const index = state.tabs.indexOf(state.active);
    activateTab(state.tabs[(index + step + state.tabs.length) % state.tabs.length]);
  }

  // ------------------------------------------------------------ keyboard
  function appShortcut(ev) {
    if (ev.type !== "keydown" || !(ev.altKey && ev.shiftKey && !ev.ctrlKey && !ev.metaKey)) return null;
    switch (ev.code) {
      case "KeyN":
        return () => newTab();
      case "KeyW":
        return () => state.active && closeTab(state.active);
      case "ArrowLeft":
        return () => cycleTab(-1);
      case "ArrowRight":
        return () => cycleTab(1);
      default:
        return null;
    }
  }

  function terminalKeyHandler(ev, tab) {
    if (ev.type !== "keydown") return true;
    // App shortcuts are executed by the document listener below (the event
    // bubbles up from xterm's textarea); xterm.js must just ignore them.
    if (appShortcut(ev)) return false;
    const ctrlShift = ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
    if (ctrlShift && ev.code === "KeyC") {
      const selection = tab.term.getSelection();
      if (selection && navigator.clipboard) {
        navigator.clipboard.writeText(selection).catch(() => toast("클립보드에 복사할 수 없습니다.", "error"));
      }
      ev.preventDefault();
      return false;
    }
    if (ctrlShift && ev.code === "KeyV") {
      // Let the browser fire its native paste event; xterm.js handles it.
      return false;
    }
    return true;
  }

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeMenus();
    if ($("#app-view").hidden || document.querySelector("dialog[open]")) return;
    const action = appShortcut(ev);
    if (action) {
      ev.preventDefault();
      action();
    }
  });

  // ---------------------------------------------------------------- idle
  function setIdle(seconds) {
    if (typeof seconds !== "number") return;
    state.idleDeadline = Date.now() + seconds * 1000;
    renderIdle();
  }

  let lastActivityNote = 0;
  function noteActivity() {
    // The server counts terminal input as activity; mirror that locally
    // (the next pong corrects any difference).
    const now = Date.now();
    if (now - lastActivityNote < 5000 || !state.info || !state.info.idleTimeout) return;
    lastActivityNote = now;
    const deadline = now + state.info.idleTimeout * 1000;
    if (!state.idleDeadline || deadline > state.idleDeadline) {
      state.idleDeadline = deadline;
      renderIdle();
    }
  }

  function renderIdle() {
    if (!state.idleDeadline) return;
    const left = Math.max(0, Math.round((state.idleDeadline - Date.now()) / 1000));
    $("#status-idle").textContent = `세션 만료까지 ${formatDuration(left)}`;
    const warn = left <= 120;
    $("#idle-banner").hidden = !warn;
    if (warn) {
      $("#idle-text").textContent = left > 0
        ? `오랫동안 입력이 없어 ${formatDuration(left)} 후 세션이 종료됩니다.`
        : "세션이 곧 종료됩니다.";
    }
  }

  $("#idle-keep").addEventListener("click", async () => {
    try {
      const res = await api("POST", "api/activity", {});
      setIdle(res.idleRemaining);
      if (state.active) state.active.focus();
    } catch (err) {
      handleError(err);
    }
  });

  // --------------------------------------------------------------- menus
  function closeMenus() {
    for (const [btn, menu] of [["#actions-btn", "#actions-menu"], ["#user-btn", "#user-menu"]]) {
      $(menu).hidden = true;
      $(btn).setAttribute("aria-expanded", "false");
    }
  }

  function toggleMenu(btnSel, menuSel) {
    const menu = $(menuSel);
    const willOpen = menu.hidden;
    closeMenus();
    if (willOpen) {
      menu.hidden = false;
      $(btnSel).setAttribute("aria-expanded", "true");
      const first = menu.querySelector("button");
      if (first) first.focus();
    }
  }

  $("#actions-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleMenu("#actions-btn", "#actions-menu");
  });
  $("#user-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleMenu("#user-btn", "#user-menu");
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".menu")) closeMenus();
  });
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeMenus();
      const action = btn.dataset.action;
      if (action === "new-tab") newTab();
      else if (action === "upload") openUpload([]);
      else if (action === "download") openDownload();
      else if (action === "settings") openSettings();
      else if (action === "shortcuts") openDialog("#shortcuts-dialog");
      else if (action === "logout") logout();
    });
  });
  $("#tab-add").addEventListener("click", () => newTab());

  // -------------------------------------------------------------- upload
  let uploadQueue = [];
  let uploading = false;

  function openUpload(files) {
    const dialog = openDialog("#upload-dialog");
    if (!uploading) {
      uploadQueue = [];
      $("#upload-list").replaceChildren();
    }
    $("#upload-limit").textContent = state.info ? `파일당 최대 ${formatBytes(state.info.maxUploadBytes)}` : "";
    addUploadFiles(files);
    return dialog;
  }

  function addUploadFiles(files) {
    for (const file of files) {
      const bar = el("span");
      const msg = el("span", { class: "msg", text: "대기 중" });
      const li = el(
        "li",
        {},
        el("span", { class: "name", text: file.name, title: file.name }),
        el("span", { class: "size", text: formatBytes(file.size) }),
        el("span", { class: "bar" }, bar),
        msg,
      );
      $("#upload-list").append(li);
      uploadQueue.push({ file, li, bar, msg, state: "pending" });
    }
    $("#upload-start").disabled = uploading || !uploadQueue.some((i) => i.state === "pending");
  }

  function joinPath(dir, name) {
    const base = dir.trim() || "~";
    return base.endsWith("/") ? base + name : `${base}/${name}`;
  }

  function uploadFile(file, dir, overwrite, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const params = new URLSearchParams({ dir, name: file.name, overwrite: overwrite ? "1" : "0" });
      xhr.open("POST", `api/files/upload?${params}`);
      xhr.setRequestHeader("X-CSRF-Token", state.csrf || "");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, data.error || `http_${xhr.status}`, data));
      };
      xhr.onerror = () => reject(new ApiError(0, "network"));
      xhr.onabort = () => reject(new ApiError(0, "aborted"));
      xhr.send(file);
    });
  }

  async function runUploads() {
    if (uploading) return;
    uploading = true;
    $("#upload-start").disabled = true;
    const dir = $("#upload-dir").value.trim() || "~";
    const forceOverwrite = $("#upload-overwrite").checked;
    let done = 0;
    for (const item of uploadQueue) {
      if (item.state !== "pending") continue;
      item.state = "running";
      item.li.className = "";
      try {
        if (state.info && item.file.size > state.info.maxUploadBytes) {
          throw new ApiError(413, "too_large", { limit: state.info.maxUploadBytes });
        }
        let overwrite = forceOverwrite;
        if (!overwrite) {
          const exists = await api("GET", `api/files/stat?${new URLSearchParams({ path: joinPath(dir, item.file.name) })}`)
            .then(() => true, (err) => {
              if (err.status === 404) return false;
              if (err.code === "is_a_directory") throw new ApiError(400, "target_is_directory");
              throw err;
            });
          if (exists) {
            overwrite = await confirmDialog(
              "파일이 이미 있습니다",
              `${joinPath(dir, item.file.name)} 파일을 덮어쓸까요?`,
              "덮어쓰기",
            );
            openDialog("#upload-dialog");
            if (!overwrite) {
              item.state = "skipped";
              item.msg.textContent = "건너뜀";
              continue;
            }
          }
        }
        item.msg.textContent = "업로드 중…";
        const res = await uploadFile(item.file, dir, overwrite, (ratio) => {
          item.bar.style.width = `${Math.round(ratio * 100)}%`;
          item.msg.textContent = `업로드 중… ${Math.round(ratio * 100)}%`;
        });
        item.state = "done";
        item.li.className = "done";
        item.bar.style.width = "100%";
        item.msg.textContent = `완료: ${res.path}`;
        done += 1;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          uploading = false;
          sessionLost();
          return;
        }
        item.state = "failed";
        item.li.className = "failed";
        item.bar.style.width = "100%";
        item.msg.textContent = errorText(err);
      }
    }
    uploading = false;
    $("#upload-start").disabled = !uploadQueue.some((i) => i.state === "pending");
    if (done) toast(`${done}개 파일을 업로드했습니다.`, "ok");
  }

  $("#upload-start").addEventListener("click", runUploads);
  $("#upload-pick").addEventListener("click", () => $("#upload-input").click());
  $("#upload-input").addEventListener("change", (ev) => {
    addUploadFiles(Array.from(ev.target.files || []));
    ev.target.value = "";
  });

  function hasFiles(ev) {
    return ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
  }

  const dropZone = $("#drop-zone");
  dropZone.addEventListener("dragover", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dropZone.classList.add("over");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
  dropZone.addEventListener("drop", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dropZone.classList.remove("over");
    addUploadFiles(Array.from(ev.dataTransfer.files));
  });

  // Dropping files onto the terminal opens the upload dialog.
  const terminalsEl = $("#terminals");
  let dragDepth = 0;
  terminalsEl.addEventListener("dragenter", (ev) => {
    if (!hasFiles(ev)) return;
    dragDepth += 1;
    $("#drop-overlay").hidden = false;
  });
  terminalsEl.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("#drop-overlay").hidden = true;
  });
  terminalsEl.addEventListener("dragover", (ev) => hasFiles(ev) && ev.preventDefault());
  terminalsEl.addEventListener("drop", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    $("#drop-overlay").hidden = true;
    $("#upload-dir").value = "~";
    openUpload(Array.from(ev.dataTransfer.files));
    runUploads();
  });

  // ------------------------------------------------------------ download
  function openDownload() {
    $("#download-error").hidden = true;
    openDialog("#download-dialog");
    const input = $("#download-path");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  $("#download-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const path = $("#download-path").value.trim();
    const errorBox = $("#download-error");
    errorBox.hidden = true;
    $("#download-start").disabled = true;
    try {
      const info = await api("GET", `api/files/stat?${new URLSearchParams({ path })}`);
      const link = el("a", { href: `api/files/download?${new URLSearchParams({ path })}`, download: info.name });
      document.body.append(link);
      link.click();
      link.remove();
      $("#download-dialog").close();
      toast(`다운로드를 시작합니다: ${info.name} (${formatBytes(info.size)})`, "ok");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        $("#download-dialog").close();
        sessionLost();
        return;
      }
      errorBox.textContent = errorText(err);
      errorBox.hidden = false;
    } finally {
      $("#download-start").disabled = false;
    }
  });

  // ------------------------------------------------------------ settings
  const fontSelect = $("#set-font-size");
  for (let size = 10; size <= 24; size += 1) fontSelect.append(el("option", { value: size, text: `${size}px` }));

  function openSettings() {
    fontSelect.value = String(settings.fontSize);
    $("#set-theme").value = settings.theme;
    $("#set-cursor").value = settings.cursorStyle;
    $("#set-blink").checked = settings.cursorBlink;
    openDialog("#settings-dialog");
  }

  function onSettingChange() {
    settings = {
      fontSize: Number(fontSelect.value) || DEFAULT_SETTINGS.fontSize,
      theme: $("#set-theme").value,
      cursorStyle: $("#set-cursor").value,
      cursorBlink: $("#set-blink").checked,
    };
    saveSettings();
    applySettings();
  }
  for (const id of ["#set-font-size", "#set-theme", "#set-cursor", "#set-blink"]) {
    $(id).addEventListener("change", onSettingChange);
  }

  // ---------------------------------------------------------- lifecycle
  function bindTitle(title) {
    document.querySelectorAll('[data-bind="title"]').forEach((node) => {
      node.textContent = title;
    });
  }

  function teardownApp() {
    for (const tab of state.tabs) tab.dispose();
    state.tabs = [];
    state.active = null;
    state.csrf = null;
    state.idleDeadline = null;
    for (const timer of state.timers) clearInterval(timer);
    state.timers = [];
    $("#tabs").replaceChildren();
    $("#idle-banner").hidden = true;
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  }

  function showLogin(message, kind = "error") {
    teardownApp();
    $("#toasts").replaceChildren();
    $("#app-view").hidden = true;
    $("#login-view").hidden = false;
    const notice = state.info && state.info.notice;
    $("#login-notice").textContent = notice || "";
    $("#login-notice").hidden = !notice;
    const errorBox = $("#login-error");
    errorBox.textContent = message || "";
    errorBox.hidden = !message;
    errorBox.classList.toggle("info", kind === "info");
    document.title = state.info ? state.info.title : document.title;
    $("#login-pass").value = "";
    ($("#login-user").value ? $("#login-pass") : $("#login-user")).focus();
  }

  function sessionLost() {
    if (!$("#login-view").hidden) return;
    showLogin(MESSAGES.unauthorized);
  }

  async function startApp(info) {
    state.info = info;
    state.csrf = info.csrf;
    bindTitle(info.title);
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    $("#host-name").textContent = info.hostname;
    $("#user-name").textContent = info.user;
    $("#user-avatar").textContent = (info.user || "?").slice(0, 1);
    $("#user-info").replaceChildren(
      el("div", {}, el("strong", { text: info.user }), `@${info.hostname}`),
      el("div", { text: `홈: ${info.home}` }),
      el("div", { text: `WebTerm ${info.version}` }),
    );
    setIdle(info.idleRemaining);

    state.timers.push(
      setInterval(() => {
        for (const tab of state.tabs) tab.sendControl({ t: "ping" });
      }, 25000),
      setInterval(renderIdle, 1000),
    );

    let terminals = [];
    try {
      ({ terminals } = await api("GET", "api/terminals"));
    } catch (err) {
      handleError(err);
      return;
    }
    if (!terminals.length) {
      await newTab();
      return;
    }
    for (const t of terminals) {
      const tab = new TermTab(t.id);
      state.tabs.push(tab);
      tab.el.hidden = true;
    }
    activateTab(state.tabs[0]);
    for (const tab of state.tabs) tab.connect();
  }

  async function logout() {
    try {
      await api("POST", "api/logout", {});
    } catch {
      /* the session may already be gone */
    }
    showLogin("로그아웃되었습니다.", "info");
  }

  $("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const username = $("#login-user").value.trim();
    const password = $("#login-pass").value;
    const errorBox = $("#login-error");
    errorBox.classList.remove("info");
    if (!username || !password) {
      errorBox.textContent = "사용자 이름과 비밀번호를 입력하세요.";
      errorBox.hidden = false;
      return;
    }
    const button = $("#login-submit");
    button.disabled = true;
    button.textContent = "확인 중…";
    errorBox.hidden = true;
    try {
      await api("POST", "api/login", { username, password });
      $("#login-pass").value = "";
      const info = await api("GET", "api/session");
      if (!info.authenticated) throw new ApiError(401, "unauthorized");
      await startApp(info);
    } catch (err) {
      errorBox.textContent = errorText(err);
      errorBox.hidden = false;
      $("#login-pass").select();
    } finally {
      button.disabled = false;
      button.textContent = "로그인";
    }
  });

  async function boot() {
    document.documentElement.dataset.theme = resolvedTheme();
    let info;
    try {
      info = await api("GET", "api/session");
    } catch (err) {
      state.info = null;
      showLogin(errorText(err));
      return;
    }
    state.info = info;
    bindTitle(info.title);
    if (info.authenticated) await startApp(info);
    else showLogin();
  }

  boot();
})();

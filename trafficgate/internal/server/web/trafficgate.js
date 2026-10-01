/*!
 * TrafficGate agent — 가상 대기실 클라이언트
 *
 *  <script src="https://wait.example.com/trafficgate.js"></script>
 *
 *  // 기본 제어: 무거운 작업(페이지 이동/주문 등) 직전에 대기열 통과
 *  TrafficGate.start('event').then(function (pass) { location.href = '/event/buy'; });
 *  // 작업이 끝난 페이지에서 슬롯 반환
 *  TrafficGate.complete('event');
 *
 *  자세한 사용법은 docs/integration.md 참고
 */
(function (window, document) {
  'use strict';
  if (window.TrafficGate && window.TrafficGate.version) return;

  var VERSION = '1.0.0';
  var STORE_PREFIX = 'trafficgate:';
  var script = document.currentScript;

  // ---------------------------------------------------------------- 설정
  function inferServer() {
    try {
      if (script && script.src) {
        var u = new URL(script.src, location.href);
        return u.origin + u.pathname.replace(/\/trafficgate\.js$/, '');
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function detectLang() {
    var l = (document.documentElement.getAttribute('lang') || navigator.language || 'ko').toLowerCase();
    return l.indexOf('ko') === 0 ? 'ko' : (l.indexOf('en') === 0 ? 'en' : 'ko');
  }

  var config = {
    server: inferServer(),
    lang: detectLang(),
    ui: true,            // 대기 화면 표시
    cookie: true,        // 통과 시 tg_<세그먼트> 쿠키 저장 (같은 사이트 백엔드/nginx 검증용)
    httpCookie: false,   // 서버가 HttpOnly 쿠키를 설정 (TrafficGate 가 같은 도메인으로 프록시된 경우)
    failOpen: true,      // 대기열 서버 장애 시 통과시킴
    maxErrors: 4,        // 연속 오류 허용 횟수 (초과 시 failOpen)
    color: '',           // 강조 색상 (예: '#2563eb')
    zIndex: 2147483000
  };

  var TEXT = {
    ko: {
      title: '접속 대기 중입니다',
      message: '현재 접속자가 많아 순서대로 입장하고 있습니다. 잠시만 기다려 주세요.',
      myPosition: '나의 대기 순번',
      ahead: '앞 대기 {n}명',
      behind: '뒤 대기 {n}명',
      eta: '예상 대기 시간',
      etaUnknown: '계산 중…',
      etaSoon: '곧 입장합니다',
      about: '약 ',
      sec: '초', min: '분', hour: '시간',
      foot: '차례가 되면 자동으로 입장합니다. 새로고침해도 대기 순번은 유지됩니다.',
      cancel: '대기 취소',
      cancelled: '대기를 취소했습니다.',
      preTitle: '오픈 대기 중입니다',
      opensIn: '오픈까지 남은 시간',
      preNote: '오픈 시각이 되면 도착한 순서대로 자동 입장합니다.',
      preNoteRandom: '오픈 전에 도착한 분들의 입장 순서는 오픈 시각에 무작위로 정해집니다.',
      blockedTitle: '서비스 이용이 잠시 중단되었습니다',
      blockedMsg: '잠시 후 다시 이용해 주세요.',
      closedTitle: '종료되었습니다',
      closedMsg: '이용해 주셔서 감사합니다.',
      fullTitle: '대기 인원이 너무 많습니다',
      fullMsg: '대기열이 가득 찼습니다. 잠시 후 자동으로 다시 시도합니다.',
      passTitle: '입장합니다',
      retry: '다시 시도',
      close: '닫기',
      errorMsg: '대기열 서버 연결이 원활하지 않아 다시 시도하고 있습니다.',
      expiredMsg: '대기 시간이 초과되어 대기열에 다시 참여했습니다.',
      yourTurn: '입장 차례입니다',
      pos: '{n}번째'
    },
    en: {
      title: 'You are in the queue',
      message: 'We are experiencing high traffic. You will be let in automatically in order.',
      myPosition: 'Your position',
      ahead: '{n} ahead',
      behind: '{n} behind',
      eta: 'Estimated wait',
      etaUnknown: 'Calculating…',
      etaSoon: 'Almost there',
      about: '~',
      sec: 's', min: 'm', hour: 'h',
      foot: 'You will enter automatically. Refreshing keeps your place in line.',
      cancel: 'Leave queue',
      cancelled: 'You have left the queue.',
      preTitle: 'Opening soon',
      opensIn: 'Opens in',
      preNote: 'When it opens, visitors are let in in order of arrival.',
      preNoteRandom: 'The order of visitors who arrive before opening is randomized at opening time.',
      blockedTitle: 'Service temporarily unavailable',
      blockedMsg: 'Please try again later.',
      closedTitle: 'This event has ended',
      closedMsg: 'Thank you for your interest.',
      fullTitle: 'The queue is full',
      fullMsg: 'We will automatically retry shortly.',
      passTitle: 'Entering…',
      retry: 'Retry',
      close: 'Close',
      errorMsg: 'Having trouble reaching the queue server. Retrying…',
      expiredMsg: 'Your ticket expired, so you have re-joined the queue.',
      yourTurn: "It's your turn",
      pos: '#{n}'
    }
  };

  function t(opts, key, n) {
    var dict = TEXT[opts.lang] || TEXT.ko;
    var s = dict[key] != null ? dict[key] : TEXT.ko[key];
    return n != null ? s.replace('{n}', fmtNum(n, opts)) : s;
  }

  function fmtNum(n, opts) {
    try { return Number(n).toLocaleString(opts.lang === 'en' ? 'en-US' : 'ko-KR'); } catch (e) { return String(n); }
  }

  function fmtDuration(sec, opts) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + t(opts, 'hour') + (m ? ' ' + m + t(opts, 'min') : '');
    if (m > 0) return m + t(opts, 'min') + (s && m < 5 ? ' ' + s + t(opts, 'sec') : '');
    return s + t(opts, 'sec');
  }

  function fmtClock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var d = Math.floor(total / 86400);
    var h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    return (d > 0 ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) target[k] = src[k];
    }
    return target;
  }

  // ---------------------------------------------------------------- 저장소
  function sget(seg) {
    try { var v = window.sessionStorage.getItem(STORE_PREFIX + seg); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function sset(seg, v) {
    try { window.sessionStorage.setItem(STORE_PREFIX + seg, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }
  function sdel(seg) {
    try { window.sessionStorage.removeItem(STORE_PREFIX + seg); } catch (e) { /* ignore */ }
  }

  function setCookie(seg, token, ttl) {
    var c = 'tg_' + seg + '=' + token + '; path=/; max-age=' + ttl + '; samesite=lax';
    if (location.protocol === 'https:') c += '; secure';
    document.cookie = c;
  }

  // ---------------------------------------------------------------- API
  function api(server, path, query, keepalive) {
    var url = server + '/api/v1' + path + (query ? '?' + query : '');
    var ctrl = typeof AbortController !== 'undefined' && !keepalive ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    return fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: !!keepalive,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.ok || res.status === 429) return res.json();
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function segPath(seg) { return '/segments/' + encodeURIComponent(seg); }

  // ---------------------------------------------------------------- UI
  var CSS = [
    ':host{all:initial}',
    '.tg{--tg-accent:#2563eb;--tg-bg:#fff;--tg-fg:#111827;--tg-sub:#4b5563;--tg-line:#e5e7eb;--tg-track:#eef2f7;',
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;',
    'background:rgba(15,23,42,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);',
    'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Malgun Gothic","Segoe UI",Roboto,sans-serif;',
    'color:var(--tg-fg);line-height:1.5;-webkit-font-smoothing:antialiased}',
    '.tg.page{background:#f3f5f9}',
    '@media (prefers-color-scheme:dark){.tg{--tg-bg:#111827;--tg-fg:#f3f4f6;--tg-sub:#9ca3af;--tg-line:#1f2937;--tg-track:#1f2937}.tg.page{background:#0b1120}}',
    '.card{width:100%;max-width:420px;background:var(--tg-bg);border-radius:20px;padding:32px 28px 24px;box-sizing:border-box;',
    'box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center;outline:none}',
    '.spin{width:44px;height:44px;margin:0 auto 18px;border-radius:50%;border:4px solid var(--tg-track);border-top-color:var(--tg-accent);animation:r 1s linear infinite}',
    '@keyframes r{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.spin{animation-duration:3s}}',
    'h1{font-size:20px;margin:0 0 8px;font-weight:700;letter-spacing:-.2px}',
    'p{margin:0}',
    '.msg{font-size:14px;color:var(--tg-sub);white-space:pre-line}',
    '.box{margin:22px 0 6px;padding:18px 16px;border:1px solid var(--tg-line);border-radius:14px}',
    '.label{font-size:13px;color:var(--tg-sub)}',
    '.pos{font-size:40px;font-weight:800;color:var(--tg-accent);letter-spacing:-1px;margin:2px 0 12px;font-variant-numeric:tabular-nums}',
    '.bar{height:8px;border-radius:99px;background:var(--tg-track);overflow:hidden}',
    '.fill{height:100%;width:4%;border-radius:99px;background:var(--tg-accent);transition:width .8s ease}',
    '.meta{display:flex;justify-content:space-between;font-size:12px;color:var(--tg-sub);margin-top:8px;font-variant-numeric:tabular-nums}',
    '.eta{margin-top:12px;font-size:14px}',
    '.eta b{font-weight:700}',
    '.count{font-size:34px;font-weight:800;color:var(--tg-accent);margin:4px 0 8px;font-variant-numeric:tabular-nums;letter-spacing:-.5px}',
    '.note{font-size:12px;color:var(--tg-sub)}',
    '.notice{font-size:13px;color:#b45309;margin-top:12px;min-height:0}',
    '.notice:empty{display:none}',
    '.foot{font-size:12px;color:var(--tg-sub);margin-top:14px}',
    '.actions{margin-top:18px;display:flex;gap:8px;justify-content:center}',
    'button{font:inherit;font-size:14px;padding:9px 18px;border-radius:10px;border:1px solid var(--tg-line);background:transparent;color:var(--tg-fg);cursor:pointer}',
    'button:hover{background:var(--tg-track)}',
    'button:focus-visible{outline:2px solid var(--tg-accent);outline-offset:2px}',
    'button.primary{background:var(--tg-accent);border-color:var(--tg-accent);color:#fff}',
    '[hidden]{display:none!important}'
  ].join('');

  var TEMPLATE =
    '<div class="tg" part="backdrop">' +
    '<div class="card" role="dialog" aria-modal="true" aria-labelledby="tg-title" tabindex="-1">' +
    '<div class="spin" aria-hidden="true"></div>' +
    '<h1 id="tg-title" class="title"></h1>' +
    '<p class="msg"></p>' +
    '<div class="box wait" hidden>' +
    '<div class="label lbl-pos"></div>' +
    '<div class="pos" aria-live="polite"></div>' +
    '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div>' +
    '<div class="meta"><span class="ahead"></span><span class="behind"></span></div>' +
    '<div class="eta"></div>' +
    '</div>' +
    '<div class="box pre" hidden>' +
    '<div class="label lbl-open"></div>' +
    '<div class="count" aria-live="off"></div>' +
    '<p class="note"></p>' +
    '</div>' +
    '<p class="notice" role="status"></p>' +
    '<p class="foot"></p>' +
    '<div class="actions"><button type="button" class="cancel"></button><button type="button" class="retry primary" hidden></button><button type="button" class="close" hidden></button></div>' +
    '</div></div>';

  function UI(opts, page) {
    var host = document.createElement('div');
    host.setAttribute('data-trafficgate', '');
    host.style.position = 'fixed';
    host.style.zIndex = String(opts.zIndex);
    host.style.top = '0';
    host.style.left = '0';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var styled = false;
    try {
      if (root.adoptedStyleSheets !== undefined && typeof CSSStyleSheet === 'function') {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        styled = true;
      }
    } catch (e) { /* fallback */ }
    root.innerHTML = (styled ? '' : '<style>' + CSS + '</style>') + TEMPLATE;
    this.opts = opts;
    this.host = host;
    this.q = function (sel) { return root.querySelector(sel); };
    var wrap = this.q('.tg');
    if (page) wrap.className += ' page';
    if (opts.color) wrap.style.setProperty('--tg-accent', opts.color);
    this.q('.lbl-pos').textContent = t(opts, 'myPosition');
    this.q('.lbl-open').textContent = t(opts, 'opensIn');
    this.q('.cancel').textContent = t(opts, 'cancel');
    this.q('.retry').textContent = t(opts, 'retry');
    this.q('.close').textContent = t(opts, 'close');
    this.q('.foot').textContent = t(opts, 'foot');
  }

  UI.prototype.mount = function () {
    if (this.host.parentNode) return;
    var parent = document.body || document.documentElement;
    parent.appendChild(this.host);
    this.prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    // 스크린리더가 대기 안내를 읽도록 대화상자에 포커스를 둔다.
    try { this.q('.card').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  UI.prototype.unmount = function () {
    if (this.countdown) clearInterval(this.countdown);
    if (!this.host.parentNode) return;
    this.host.parentNode.removeChild(this.host);
    document.documentElement.style.overflow = this.prevOverflow || '';
  };

  UI.prototype.texts = function (title, msg) {
    this.q('.title').textContent = title;
    this.q('.msg').textContent = msg || '';
  };

  UI.prototype.mode = function (m) {
    this.q('.wait').hidden = m !== 'wait';
    this.q('.pre').hidden = m !== 'pre';
    this.q('.spin').hidden = !(m === 'wait' || m === 'pre' || m === 'pass');
    this.q('.foot').hidden = m !== 'wait';
    this.q('.cancel').hidden = !(m === 'wait' || m === 'pre');
    if (m !== 'pre' && this.countdown) { clearInterval(this.countdown); this.countdown = null; }
  };

  UI.prototype.notice = function (msg) { this.q('.notice').textContent = msg || ''; };

  UI.prototype.wait = function (r, info, progress) {
    var o = this.opts;
    this.mode('wait');
    this.texts((info && info.title) || t(o, 'title'), (info && info.message) || t(o, 'message'));
    this.q('.pos').textContent = t(o, 'pos', r.position);
    this.q('.ahead').textContent = t(o, 'ahead', Math.max(0, r.position - 1));
    this.q('.behind').textContent = t(o, 'behind', r.behind || 0);
    var pct = Math.max(4, Math.min(100, Math.round(progress * 100)));
    this.q('.fill').style.width = pct + '%';
    this.q('.bar').setAttribute('aria-valuenow', String(pct));
    var eta = this.q('.eta');
    eta.textContent = '';
    eta.appendChild(document.createTextNode(t(o, 'eta') + ' '));
    var b = document.createElement('b');
    if (r.eta_sec < 0) b.textContent = t(o, 'etaUnknown');
    else if (r.eta_sec <= 3) b.textContent = t(o, 'etaSoon');
    else b.textContent = t(o, 'about') + fmtDuration(r.eta_sec, o);
    eta.appendChild(b);
  };

  UI.prototype.pre = function (r, info) {
    var o = this.opts, self = this;
    this.mode('pre');
    this.texts((info && info.title) || t(o, 'preTitle'), (info && info.message) || '');
    this.q('.note').textContent = t(o, info && info.pre_queue_random ? 'preNoteRandom' : 'preNote');
    var target = Date.now() + (r.open_in_ms || 0);
    var tick = function () { self.q('.count').textContent = fmtClock(target - Date.now()); };
    tick();
    if (this.countdown) clearInterval(this.countdown);
    this.countdown = setInterval(tick, 1000);
  };

  UI.prototype.message = function (title, msg, buttons) {
    this.mode('msg');
    this.texts(title, msg);
    this.q('.retry').hidden = !(buttons && buttons.retry);
    this.q('.close').hidden = !(buttons && buttons.close);
  };

  UI.prototype.passing = function () {
    this.mode('pass');
    this.texts(t(this.opts, 'passTitle'), '');
    this.notice('');
  };

  // ---------------------------------------------------------------- 대기 처리
  var active = {};      // 세그먼트별 진행 중인 Waiter
  var beats = {};       // 세그먼트별 하트비트 타이머

  function Waiter(seg, opts, resolve, reject) {
    this.seg = seg;
    this.opts = opts;
    this.resolve = resolve;
    this.reject = reject;
    this.errors = 0;
    this.firstPos = 0;
    this.info = null;
    this.ticket = null;
    this.timer = null;
    this.stopped = false;
    this.ui = opts.ui ? new UI(opts, opts.page) : null;
    var self = this;
    this.onVisible = function () {
      if (document.visibilityState === 'visible' && self.ticket && !self.inflight && !self.stopped) {
        self.schedule(0, 'poll');
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);
    if (this.ui) {
      this.ui.q('.cancel').addEventListener('click', function () { self.cancel(); });
      // 다시 시도 버튼은 전체 페이지(게이트) 모드에서만 표시된다.
      this.ui.q('.retry').addEventListener('click', function () { location.reload(); });
      this.ui.q('.close').addEventListener('click', function () { self.ui.unmount(); });
    }
  }

  Waiter.prototype.query = function () {
    var p = [];
    if (!this.info) p.push('info=1');
    if (this.opts.httpCookie) p.push('set_cookie=1');
    return p.join('&');
  };

  Waiter.prototype.run = function () {
    var st = sget(this.seg);
    if (st && st.t && st.s === 'wait' && st.server === this.opts.server) {
      this.ticket = st.t;
      this.poll();
    } else {
      this.enter();
    }
  };

  Waiter.prototype.enter = function () {
    this.ticket = null;
    this.request(segPath(this.seg) + '/enter');
  };

  Waiter.prototype.poll = function () {
    if (!this.ticket) return this.enter();
    this.request(segPath(this.seg) + '/tickets/' + encodeURIComponent(this.ticket) + '/poll');
  };

  Waiter.prototype.request = function (path) {
    var self = this;
    if (this.stopped) return;
    this.inflight = true;
    api(this.opts.server, path, this.query()).then(function (r) {
      self.inflight = false;
      self.errors = 0;
      self.handle(r);
    }, function (err) {
      self.inflight = false;
      self.fail(err);
    });
  };

  Waiter.prototype.schedule = function (ms, what) {
    var self = this;
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    var jitter = ms > 0 ? ms * (0.85 + Math.random() * 0.3) : 0;
    this.timer = setTimeout(function () {
      self.timer = null;
      if (what === 'enter') self.enter(); else self.poll();
    }, jitter);
  };

  Waiter.prototype.show = function () {
    if (this.ui) this.ui.mount();
  };

  Waiter.prototype.handle = function (r) {
    if (this.stopped) return;
    var o = this.opts;
    if (r.info) this.info = r.info;
    switch (r.status) {
      case 'PASS':
        return this.pass(r);
      case 'WAIT':
      case 'PRE_WAIT':
        this.ticket = r.ticket;
        sset(this.seg, { t: r.ticket, s: 'wait', server: o.server });
        if (r.position > this.firstPos) this.firstPos = r.position;
        if (this.ui) {
          this.show();
          if (r.status === 'PRE_WAIT') this.ui.pre(r, this.info);
          else this.ui.wait(r, this.info, this.firstPos > 1 ? (this.firstPos - r.position) / (this.firstPos - 1) : 1);
          if (!this.keepNotice) this.ui.notice('');
          this.keepNotice = false;
        }
        if (o.onProgress) o.onProgress(r);
        return this.schedule(r.next_poll_ms || 2000, 'poll');
      case 'EXPIRED':
        sdel(this.seg);
        this.ticket = null;
        this.firstPos = 0;
        if (this.ui) { this.show(); this.ui.notice(t(o, 'expiredMsg')); this.keepNotice = true; }
        return this.schedule(300, 'enter');
      case 'FULL':
        if (this.ui) { this.show(); this.ui.message(t(o, 'fullTitle'), t(o, 'fullMsg')); }
        return this.schedule(r.next_poll_ms || 10000, 'enter');
      case 'RATE_LIMITED':
        return this.schedule(r.next_poll_ms || 5000, this.ticket ? 'poll' : 'enter');
      case 'BLOCKED':
        sdel(this.seg);
        if (this.ui) {
          this.show();
          this.ui.message(t(o, 'blockedTitle'), r.message || t(o, 'blockedMsg'), { retry: o.page, close: !o.page });
        }
        return this.finish(false, 'BLOCKED', r);
      case 'CLOSED':
        sdel(this.seg);
        if (this.ui) {
          this.show();
          this.ui.message(t(o, 'closedTitle'), r.message || t(o, 'closedMsg'), { close: !o.page });
        }
        if (r.redirect_url) setTimeout(function () { location.href = r.redirect_url; }, 2500);
        return this.finish(false, 'CLOSED', r);
      default:
        return this.fail(new Error('unexpected status ' + r.status));
    }
  };

  Waiter.prototype.pass = function (r) {
    var o = this.opts;
    var rec = {
      t: r.ticket || '', s: 'pass', server: o.server, token: r.token || '',
      exp: Date.now() + (r.token_ttl_sec || 0) * 1000, ttl: r.active_ttl_sec || 0
    };
    sset(this.seg, rec);
    if (o.cookie && !o.httpCookie && r.token) setCookie(this.seg, r.token, r.token_ttl_sec || 600);
    if (document.visibilityState === 'hidden') notifyTurn(o);
    if (this.ui) {
      if (o.page) this.ui.passing(); else this.ui.unmount();
    }
    if (o.hold && rec.t && rec.ttl) keepAlive(this.seg);
    this.finish(true, 'PASS', {
      segment: this.seg, ticket: rec.t, token: rec.token, bypass: !!r.bypass,
      waitedMs: r.waited_ms || 0, failOpen: false
    });
  };

  Waiter.prototype.fail = function (err) {
    var o = this.opts;
    this.errors++;
    if (err && err.status === 404) {
      if (window.console) console.warn('[TrafficGate] 세그먼트를 찾을 수 없습니다:', this.seg);
    }
    if (o.failOpen && (this.errors >= o.maxErrors || (err && err.status === 404))) {
      if (window.console) console.warn('[TrafficGate] 대기열 서버 오류로 통과 처리합니다(fail-open).', err);
      if (this.ui) this.ui.unmount();
      sdel(this.seg);
      return this.finish(true, 'PASS', { segment: this.seg, ticket: '', token: '', bypass: true, waitedMs: 0, failOpen: true });
    }
    if (this.ui) { this.show(); this.ui.notice(t(o, 'errorMsg')); }
    if (o.onError) o.onError(err);
    this.schedule(Math.min(1000 * Math.pow(2, this.errors), 10000), this.ticket ? 'poll' : 'enter');
  };

  Waiter.prototype.cancel = function () {
    var o = this.opts, ticket = this.ticket;
    this.stop();
    sdel(this.seg);
    if (ticket) api(o.server, segPath(this.seg) + '/tickets/' + encodeURIComponent(ticket) + '/complete', '', true).catch(function () {});
    if (this.ui) {
      this.ui.message(t(o, 'cancelled'), '', { retry: o.page, close: !o.page });
      if (o.page && window.history.length > 1) setTimeout(function () { history.back(); }, 800);
      else if (!o.page) { var ui = this.ui; setTimeout(function () { ui.unmount(); }, 1200); }
    }
    if (o.onCancel) o.onCancel();
    var e = new Error('cancelled');
    e.status = 'CANCELLED';
    this.settle(false, e);
  };

  Waiter.prototype.stop = function () {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  };

  Waiter.prototype.finish = function (ok, status, r) {
    var o = this.opts;
    this.stop();
    if (ok) {
      if (o.onPass) o.onPass(r);
      this.settle(true, r);
    } else {
      if (status === 'BLOCKED' && o.onBlock) o.onBlock(r);
      if (status === 'CLOSED' && o.onClosed) o.onClosed(r);
      var e = new Error(status.toLowerCase());
      e.status = status;
      e.response = r;
      this.settle(false, e);
    }
  };

  Waiter.prototype.settle = function (ok, v) {
    document.removeEventListener('visibilitychange', this.onVisible);
    if (active[this.seg] === this) delete active[this.seg];
    if (this.settled) return;
    this.settled = true;
    if (ok) this.resolve(v); else this.reject(v);
  };

  function notifyTurn(opts) {
    var original = document.title;
    document.title = '▶ ' + t(opts, 'yourTurn');
    var restore = function () {
      if (document.visibilityState === 'visible') {
        document.title = original;
        document.removeEventListener('visibilitychange', restore);
      }
    };
    document.addEventListener('visibilitychange', restore);
    try {
      if (window.Notification && Notification.permission === 'granted') new Notification(t(opts, 'yourTurn'));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 공개 API
  function start(seg, options) {
    if (!seg) return Promise.reject(new Error('segment is required'));
    var opts = assign({}, config, options);
    if (!opts.server) return Promise.reject(new Error('TrafficGate server is not configured'));
    if (active[seg]) active[seg].stop();
    return new Promise(function (resolve, reject) {
      var w = new Waiter(seg, opts, resolve, reject);
      active[seg] = w;
      w.run();
    });
  }

  function complete(seg) {
    stopKeepAlive(seg);
    if (active[seg]) active[seg].stop();
    var st = sget(seg);
    sdel(seg);
    if (!st || !st.t) return Promise.resolve(false);
    return api(st.server || config.server, segPath(seg) + '/tickets/' + encodeURIComponent(st.t) + '/complete', '', true)
      .then(function (r) { return !!(r && r.ok); }, function () { return false; });
  }

  function keepAlive(seg) {
    var st = sget(seg);
    if (!st || st.s !== 'pass' || !st.t || !st.ttl) return false;
    stopKeepAlive(seg);
    var path = segPath(seg) + '/tickets/' + encodeURIComponent(st.t) + '/alive';
    var beat = function () {
      api(st.server || config.server, path, '').then(function (r) {
        if (!r || !r.ok) stopKeepAlive(seg);
      }, function () { /* 일시적 오류는 다음 주기에 재시도 */ });
    };
    beat();
    beats[seg] = setInterval(beat, Math.max(1000, st.ttl * 1000 / 3));
    return true;
  }

  function stopKeepAlive(seg) {
    if (beats[seg]) { clearInterval(beats[seg]); delete beats[seg]; }
  }

  function token(seg) {
    var st = sget(seg);
    if (st && st.s === 'pass' && st.token && st.exp > Date.now()) return st.token;
    return null;
  }

  function go(seg, url, options) {
    return start(seg, options).then(function (pass) {
      location.href = url;
      return pass;
    });
  }

  // data-tg-segment 속성이 있는 링크/버튼은 클릭 시 대기열을 거친 뒤 이동한다.
  //   <a href="/event/buy" data-tg-segment="event">구매하기</a>
  //   <button type="submit" data-tg-segment="order">주문하기</button>  (폼 제출)
  function bindLinks() {
    document.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-tg-segment]') : null;
      if (!el || el.getAttribute('data-tg-passed') === '1') return;
      var seg = el.getAttribute('data-tg-segment');
      var hold = el.getAttribute('data-tg-hold') === 'true';
      ev.preventDefault();
      start(seg, { hold: hold }).then(function () {
        if (el.tagName === 'A' && el.href) {
          location.href = el.href;
        } else if (el.form) {
          el.setAttribute('data-tg-passed', '1');
          if (el.form.requestSubmit) el.form.requestSubmit(el); else el.form.submit();
          setTimeout(function () { el.removeAttribute('data-tg-passed'); }, 0);
        } else {
          el.setAttribute('data-tg-passed', '1');
          el.click();
          el.removeAttribute('data-tg-passed');
        }
      }, function () { /* 차단/취소 시 이동하지 않음 */ });
    }, true);
  }

  // nginx 게이트 모드: 서버가 내려준 대기 페이지에서 실행된다.
  function gate(cfg) {
    return start(cfg.segment, { server: cfg.server, page: true, httpCookie: true, cookie: false, failOpen: false })
      .then(function () {
        location.replace(cfg.returnURL || '/');
      }, function () { /* 차단/종료 안내 화면 유지 */ });
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function onLoad(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn);
  }

  var TrafficGate = {
    version: VERSION,
    configure: function (o) { assign(config, o); return config; },
    start: start,
    complete: complete,
    stop: complete,
    keepAlive: keepAlive,
    token: token,
    go: go,
    gate: gate
  };
  window.TrafficGate = TrafficGate;

  // ---------------------------------------------------------------- 자동 초기화
  //   <script src=".../trafficgate.js" data-segment="event" data-auto="basic"></script>
  //     data-auto="basic" : 페이지 진입 시 대기 → 통과 후 페이지 로드가 끝나면 슬롯 반환
  //     data-auto="hold"  : 페이지 진입 시 대기 → 통과 후 complete() 호출 전까지 슬롯 유지(구간 제어 시작)
  //   <script ... data-keepalive="event"></script> : 구간 중간 페이지에서 슬롯 유지
  //   <script ... data-complete="event"></script>  : 구간 마지막 페이지에서 슬롯 반환
  var ds = (script && script.dataset) || {};
  if (ds.server) config.server = ds.server.replace(/\/$/, '');
  if (ds.lang) config.lang = ds.lang;
  if (ds.color) config.color = ds.color;

  onReady(function () {
    var cfgEl = document.getElementById('trafficgate-config');
    if (cfgEl) {
      try { gate(JSON.parse(cfgEl.textContent)); } catch (e) { if (window.console) console.error('[TrafficGate]', e); }
      return;
    }
    bindLinks();
    if (ds.segment && ds.auto) {
      var hold = ds.auto === 'hold';
      start(ds.segment, { hold: hold }).then(function () {
        if (!hold) onLoad(function () { complete(ds.segment); });
      }, function () { /* 차단/종료/취소 */ });
    }
    if (ds.keepalive) keepAlive(ds.keepalive);
    if (ds.complete) onLoad(function () { complete(ds.complete); });
  });
})(window, document);

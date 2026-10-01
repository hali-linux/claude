/* TrafficGate 관리 콘솔 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const REFRESH_MS = 2000;
  const HISTORY_SEC = 300;
  const state = { segments: new Map(), cards: new Map(), system: null, timer: null, editing: null, guideSeg: null, guideTab: 'js' };

  // ------------------------------------------------------------ 공통
  async function api(method, path, body) {
    const headers = { 'X-Requested-With': 'TrafficGate' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
    if (res.status === 401 && path !== 'api/login') {
      showLogin();
    }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const nf = new Intl.NumberFormat('ko-KR');
  const fmt = (n) => nf.format(Math.round(n || 0));
  const fmtRate = (r) => (r >= 100 ? fmt(r) : (r || 0).toFixed(r >= 10 ? 1 : 2));

  function fmtDur(sec) {
    if (sec == null || sec < 0) return '–';
    sec = Math.round(sec);
    if (sec < 60) return sec + '초';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + '분' + (s && m < 10 ? ' ' + s + '초' : '');
    const h = Math.floor(m / 60);
    return h + '시간 ' + (m % 60) + '분';
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  function storageGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------ 로그인
  function showLogin() {
    stopRefresh();
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    setTimeout(() => { const u = $('#login-form [name=username]'); if (u) u.focus(); }, 0);
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    $('#login-error').textContent = '';
    try {
      await api('POST', 'api/login', { username: f.username.value, password: f.password.value });
      f.password.value = '';
      startApp();
    } catch (e) {
      $('#login-error').textContent = e.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    try { await api('POST', 'api/logout'); } catch (e) { /* ignore */ }
    showLogin();
  });

  // ------------------------------------------------------------ 앱 시작
  async function boot() {
    try {
      await api('GET', 'api/me');
      startApp();
    } catch (e) {
      showLogin();
    }
  }

  async function startApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    try {
      const me = await api('GET', 'api/me');
      $('#me').textContent = me.username;
      state.system = await api('GET', 'api/system');
      renderSystem();
    } catch (e) { /* refresh 에서 다시 시도 */ }
    await refresh();
    stopRefresh();
    state.timer = setInterval(refresh, REFRESH_MS);
  }

  function stopRefresh() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function renderSystem() {
    const s = state.system;
    if (!s) return;
    $('#sys-version').textContent = 'v' + s.version;
    const store = $('#sys-store');
    store.textContent = (s.store === 'redis' ? 'Redis 클러스터' : '메모리(단일 서버)') + (s.store_ok ? '' : ' · 연결 오류');
    store.classList.toggle('bad', !s.store_ok);
    $('#sys-foot').textContent = `TrafficGate ${s.version} · ${s.go_version} · 공개 주소 ${s.public_listen} · live window ${s.live_window} · wait ttl ${s.wait_ttl}`;
  }

  async function refresh() {
    try {
      const data = await api('GET', 'api/stats');
      $('#sys-live').classList.remove('stale');
      render(data.segments || []);
    } catch (e) {
      $('#sys-live').classList.add('stale');
    }
  }

  // ------------------------------------------------------------ 렌더링
  function render(stats) {
    let waiting = 0, active = 0, rate = 0;
    const seen = new Set();
    stats.forEach((st) => {
      const seg = st.segment;
      seen.add(seg.id);
      state.segments.set(seg.id, seg);
      waiting += st.waiting;
      active += st.active;
      rate += st.admit_rate;
      let card = state.cards.get(seg.id);
      if (!card) {
        card = createCard(seg.id);
        state.cards.set(seg.id, card);
        $('#segments').appendChild(card);
      }
      updateCard(card, st);
    });
    for (const [id, card] of state.cards) {
      if (!seen.has(id)) {
        card.remove();
        state.cards.delete(id);
        state.segments.delete(id);
      }
    }
    $('#empty').hidden = stats.length > 0;
    $('#sum-waiting').textContent = fmt(waiting);
    $('#sum-active').textContent = fmt(active);
    $('#sum-rate').textContent = fmtRate(rate) + '/s';
    $('#sum-segments').textContent = fmt(stats.length);
  }

  const MODE_LABEL = { queue: '대기열', bypass: '제어 해제', block: '차단' };

  function createCard(id) {
    const node = $('#segment-card').content.firstElementChild.cloneNode(true);
    node.dataset.id = id;
    $('.act-edit', node).addEventListener('click', () => openEdit(state.segments.get(id)));
    $('.act-guide', node).addEventListener('click', () => openGuide(id));
    $('.act-reset', node).addEventListener('click', () => resetSegment(id));
    $('.act-delete', node).addEventListener('click', () => deleteSegment(id));
    const input = $('.q-max', node);
    $('.q-apply', node).addEventListener('click', () => applyMax(id, input));
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyMax(id, input); });
    input.addEventListener('input', () => { input.dataset.dirty = '1'; });
    $$('.q-mode', node).forEach((b) => b.addEventListener('click', () => setMode(id, b.dataset.mode)));
    return node;
  }

  function updateCard(card, st) {
    const seg = st.segment;
    $('.seg-name', card).textContent = seg.name || seg.id;
    $('.seg-id', card).textContent = seg.id;
    const mode = $('.mode', card);
    mode.textContent = MODE_LABEL[seg.mode] || seg.mode;
    mode.className = 'badge mode ' + seg.mode;
    const stateBadge = $('.state', card);
    if (st.closed) { stateBadge.hidden = false; stateBadge.textContent = '종료됨'; }
    else if (st.pre_open) {
      stateBadge.hidden = false;
      stateBadge.textContent = '오픈 예정 ' + new Date(seg.open_at).toLocaleString('ko-KR');
    } else stateBadge.hidden = true;

    $('.m-waiting', card).textContent = fmt(st.waiting);
    $('.m-live', card).textContent = `활성 대기 ${fmt(st.live)} · 이탈 대기 ${fmt(st.waiting - st.live)}`;
    $('.m-active', card).textContent = `${fmt(st.active)} / ${fmt(seg.max_active)}`;
    const ratio = seg.max_active > 0 ? st.active / seg.max_active : (st.active > 0 ? 1 : 0);
    const fill = $('.meter-fill', card);
    fill.style.width = Math.min(100, ratio * 100) + '%';
    fill.classList.toggle('hot', ratio >= 0.8 && ratio < 1);
    fill.classList.toggle('full', ratio >= 1);
    $('.m-rate', card).textContent = fmtRate(st.admit_rate);
    $('.m-enter', card).textContent = `신규 진입 ${fmtRate(st.enter_rate)}/s`;
    $('.m-wait', card).textContent = st.avg_wait_sec > 0 ? fmtDur(st.avg_wait_sec) : '–';
    $('.m-eta', card).textContent = '신규 예상 대기 ' + (st.eta_sec < 0 ? '계산 불가' : fmtDur(st.eta_sec));
    const t = st.totals || {};
    $('.m-admitted', card).textContent = fmt(t.admitted);
    $('.m-totals', card).textContent = `완료 ${fmt(t.completed)} · 만료 ${fmt(t.expired)} · 이탈 ${fmt(t.abandoned)} · 취소 ${fmt(t.cancelled)}`;

    const input = $('.q-max', card);
    if (document.activeElement !== input && input.dataset.dirty !== '1') input.value = seg.max_active;
    $$('.q-mode', card).forEach((b) => {
      const on = b.dataset.mode === seg.mode;
      b.classList.toggle('on', on);
      b.classList.toggle('block', on && seg.mode === 'block');
      b.classList.toggle('bypass', on && seg.mode === 'bypass');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    drawChart(card, st);
  }

  function niceMax(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  function drawChart(card, st) {
    const W = 600, H = 140;
    const pts = st.series || [];
    const now = st.updated_at ? Math.floor(st.updated_at / 1000) : Math.floor(Date.now() / 1000);
    const from = now - HISTORY_SEC;
    let maxV = 0;
    pts.forEach((p) => { maxV = Math.max(maxV, p.waiting, p.active); });
    const top = niceMax(Math.max(maxV, 1));
    const x = (t) => ((t - from) / HISTORY_SEC) * W;
    const y = (v) => H - (v / top) * (H - 6) - 1;
    const line = (key) => pts.filter((p) => p.t >= from).map((p) => x(p.t).toFixed(1) + ',' + y(p[key]).toFixed(1)).join(' ');
    const wait = line('waiting');
    $('.line-wait', card).setAttribute('points', wait);
    $('.line-active', card).setAttribute('points', line('active'));
    const visible = pts.filter((p) => p.t >= from);
    if (visible.length > 1) {
      const first = visible[0], last = visible[visible.length - 1];
      $('.area-wait', card).setAttribute('d', `M${x(first.t).toFixed(1)},${H} L${wait.split(' ').join(' L')} L${x(last.t).toFixed(1)},${H} Z`);
    } else {
      $('.area-wait', card).setAttribute('d', '');
    }
    const grid = $('.grid', card);
    if (!grid.childNodes.length) {
      for (let i = 1; i <= 3; i++) {
        const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l.setAttribute('x1', '0'); l.setAttribute('x2', String(W));
        l.setAttribute('y1', String((H / 4) * i)); l.setAttribute('y2', String((H / 4) * i));
        grid.appendChild(l);
      }
    }
    $('.lg-max', card).textContent = '눈금 최대 ' + fmt(top);
  }

  // ------------------------------------------------------------ 빠른 조작
  async function patch(id, body, okMsg) {
    try {
      await api('PATCH', 'api/segments/' + encodeURIComponent(id), body);
      toast(okMsg);
      await refresh();
    } catch (e) {
      toast('변경 실패: ' + e.message, true);
    }
  }

  function applyMax(id, input) {
    const v = parseInt(input.value, 10);
    if (!(v >= 0)) { toast('0 이상의 숫자를 입력하세요', true); return; }
    delete input.dataset.dirty;
    patch(id, { max_active: v }, `진입 허용 수를 ${fmt(v)}명으로 변경했습니다`);
  }

  function setMode(id, mode) {
    const seg = state.segments.get(id);
    if (!seg || seg.mode === mode) return;
    if (mode === 'block' && !confirm(`[${id}] 차단 모드로 바꾸면 대기 중인 사용자를 포함해 모든 진입이 차단됩니다. 계속할까요?`)) return;
    if (mode === 'bypass' && !confirm(`[${id}] 제어를 해제하면 모든 사용자가 대기 없이 바로 입장합니다. 계속할까요?`)) return;
    patch(id, { mode }, `모드를 '${MODE_LABEL[mode]}'(으)로 변경했습니다`);
  }

  async function resetSegment(id) {
    if (!confirm(`[${id}] 대기열과 입장 중 슬롯을 모두 비웁니다. 대기 중인 사용자는 다시 줄을 서야 합니다. 계속할까요?`)) return;
    try {
      await api('POST', 'api/segments/' + encodeURIComponent(id) + '/reset');
      toast('대기열을 초기화했습니다');
      refresh();
    } catch (e) { toast('초기화 실패: ' + e.message, true); }
  }

  async function deleteSegment(id) {
    const typed = prompt(`세그먼트를 삭제하면 대기열과 통계가 모두 사라집니다.\n삭제하려면 ID(${id})를 입력하세요.`);
    if (typed !== id) return;
    try {
      await api('DELETE', 'api/segments/' + encodeURIComponent(id));
      toast('삭제했습니다');
      refresh();
    } catch (e) { toast('삭제 실패: ' + e.message, true); }
  }

  // ------------------------------------------------------------ 편집
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  }
  function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }

  const editDialog = $('#edit-dialog');
  const editForm = $('#edit-form');

  function openEdit(seg) {
    state.editing = seg ? seg.id : null;
    $('#edit-title').textContent = seg ? `세그먼트 편집 — ${seg.id}` : '새 세그먼트';
    $('#edit-error').textContent = '';
    const s = seg || { mode: 'queue', max_active: 100, active_ttl_sec: 30, pass_ttl_sec: 600, max_waiting: 0 };
    const f = editForm.elements;
    f.id.value = s.id || '';
    f.id.readOnly = !!seg;
    f.name.value = s.name || '';
    f.mode.value = s.mode || 'queue';
    f.max_active.value = s.max_active != null ? s.max_active : 100;
    f.active_ttl_sec.value = s.active_ttl_sec || 30;
    f.pass_ttl_sec.value = s.pass_ttl_sec || 600;
    f.max_waiting.value = s.max_waiting || 0;
    f.url_patterns.value = (s.url_patterns || []).join('\n');
    f.open_at.value = toLocalInput(s.open_at);
    f.close_at.value = toLocalInput(s.close_at);
    f.pre_queue_random.checked = !!s.pre_queue_random;
    f.title.value = s.title || '';
    f.message.value = s.message || '';
    f.block_message.value = s.block_message || '';
    f.closed_message.value = s.closed_message || '';
    f.closed_url.value = s.closed_url || '';
    editDialog.showModal();
    (seg ? f.name : f.id).focus();
  }

  editForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = editForm.elements;
    const num = (el) => parseInt(el.value, 10) || 0;
    const body = {
      id: f.id.value.trim(),
      name: f.name.value.trim(),
      mode: f.mode.value,
      max_active: num(f.max_active),
      active_ttl_sec: num(f.active_ttl_sec),
      pass_ttl_sec: num(f.pass_ttl_sec),
      max_waiting: num(f.max_waiting),
      url_patterns: f.url_patterns.value.split('\n').map((s) => s.trim()).filter(Boolean),
      open_at: fromLocalInput(f.open_at.value),
      close_at: fromLocalInput(f.close_at.value),
      pre_queue_random: f.pre_queue_random.checked,
      title: f.title.value.trim(),
      message: f.message.value.trim(),
      block_message: f.block_message.value.trim(),
      closed_message: f.closed_message.value.trim(),
      closed_url: f.closed_url.value.trim()
    };
    $('#edit-save').disabled = true;
    try {
      if (state.editing) await api('PUT', 'api/segments/' + encodeURIComponent(state.editing), body);
      else await api('POST', 'api/segments', body);
      editDialog.close();
      toast(state.editing ? '저장했습니다' : '세그먼트를 만들었습니다');
      refresh();
    } catch (e) {
      $('#edit-error').textContent = e.message;
    } finally {
      $('#edit-save').disabled = false;
    }
  });

  $('#new-segment').addEventListener('click', () => openEdit(null));
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ------------------------------------------------------------ 연동 가이드
  const guideDialog = $('#guide-dialog');
  const guideServer = $('#guide-server');

  function openGuide(id) {
    state.guideSeg = id;
    $('#guide-seg').textContent = id;
    guideServer.value = storageGet('tg.guideServer', 'https://wait.example.com');
    renderGuide();
    guideDialog.showModal();
  }

  guideServer.addEventListener('input', () => {
    storageSet('tg.guideServer', guideServer.value.trim());
    renderGuide();
  });

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    state.guideTab = tab.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === tab));
    renderGuide();
  }));

  function snippet(title, desc, code) {
    const wrap = document.createElement('div');
    const h = document.createElement('h4');
    h.textContent = title;
    wrap.appendChild(h);
    if (desc) {
      const p = document.createElement('p');
      p.textContent = desc;
      wrap.appendChild(p);
    }
    const box = document.createElement('div');
    box.className = 'snippet';
    const pre = document.createElement('pre');
    pre.textContent = code;
    const btn = document.createElement('button');
    btn.className = 'btn small copy';
    btn.textContent = '복사';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); toast('복사했습니다'); } catch (e) { toast('복사 실패 — 직접 선택해 복사하세요', true); }
    });
    box.appendChild(pre);
    box.appendChild(btn);
    wrap.appendChild(box);
    return wrap;
  }

  function renderGuide() {
    const seg = state.guideSeg;
    const server = (guideServer.value.trim() || 'https://wait.example.com').replace(/\/$/, '');
    const base = (state.system && state.system.gate_base_path) || '/__tg';
    const upstream = (state.system && state.system.public_listen || '127.0.0.1:8800').replace('0.0.0.0', '127.0.0.1');
    const body = $('#guide-body');
    body.textContent = '';
    if (state.guideTab === 'js') {
      body.appendChild(snippet('1. 버튼/링크 클릭 시 대기 (기본 제어 — NetFUNNEL nfStart/nfStop 방식)',
        '부하가 큰 페이지로 이동하기 직전에 대기열을 통과시키고, 이동한 페이지가 다 열리면 슬롯을 반환합니다.',
`<script src="${server}/trafficgate.js"></script>
<a href="/event/buy" data-tg-segment="${seg}">구매하기</a>

<!-- 또는 직접 호출 -->
<script>
  document.getElementById('buy').addEventListener('click', function (e) {
    e.preventDefault();
    TrafficGate.start('${seg}').then(function (pass) {
      location.href = '/event/buy';   // pass.token 을 서버로 보내 검증할 수도 있습니다
    });
  });
</script>`));
      body.appendChild(snippet('2. 이동한 페이지에서 슬롯 반환',
        '페이지 로드가 끝나면 자동으로 complete 를 호출해 다음 대기자가 입장할 수 있게 합니다.',
`<script src="${server}/trafficgate.js" data-complete="${seg}"></script>
<!-- 또는 원하는 시점에 직접: TrafficGate.complete('${seg}'); -->`));
      body.appendChild(snippet('3. 페이지 진입 자체를 대기시키기',
        '페이지가 열리면 대기 화면을 덮어 씌우고, 통과 후 페이지 로드가 끝나면 슬롯을 반환합니다.',
`<script src="${server}/trafficgate.js" data-segment="${seg}" data-auto="basic"></script>`));
      body.appendChild(snippet('4. 구간 제어 (여러 페이지에 걸친 결제 과정 등)',
        '구간 시작에서 hold 로 통과 → 중간 페이지에서 keepalive → 마지막 페이지에서 complete.',
`<!-- 구간 시작 페이지 -->
<a href="/order/step1" data-tg-segment="${seg}" data-tg-hold="true">주문하기</a>
<!-- 중간 페이지들 -->
<script src="${server}/trafficgate.js" data-keepalive="${seg}"></script>
<!-- 마지막 페이지 -->
<script src="${server}/trafficgate.js" data-complete="${seg}"></script>`));
    } else if (state.guideTab === 'nginx') {
      body.appendChild(snippet('nginx 설정 (웹 서버 앞단)',
        '애플리케이션 코드를 바꾸지 않고 특정 경로를 대기열로 보호합니다. 세그먼트의 URL 패턴을 쓰려면 ?segment= 를 빼세요.',
`upstream trafficgate { server ${upstream}; keepalive 64; }

server {
    # ... 기존 설정 ...

    # TrafficGate 대기 화면/API/에이전트
    location ^~ ${base}/ {
        proxy_pass http://trafficgate/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 통과 쿠키 검사 (내부 서브요청)
    location = /__trafficgate_auth {
        internal;
        proxy_pass http://trafficgate/gate/auth?segment=${seg};
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
        proxy_connect_timeout 1s;
        proxy_read_timeout 2s;
    }

    # 대기 화면 (원래 URL 그대로 표시)
    location @trafficgate_wait {
        proxy_pass http://trafficgate;
        proxy_set_header X-TrafficGate-Wait 1;
        proxy_set_header X-TrafficGate-Segment ${seg};
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 보호할 경로
    location /event/ {
        auth_request /__trafficgate_auth;
        error_page 401 = @trafficgate_wait;
        proxy_pass http://backend;
    }
}`));
      body.appendChild(snippet('게이트 모드 처리량',
        '게이트 모드에서는 입장 후 슬롯을 "슬롯 유지 시간" 동안 점유합니다. 초당 입장 수 ≈ 진입 허용 수 ÷ 슬롯 유지 시간.',
        `예) 진입 허용 수 300, 슬롯 유지 시간 30초 → 초당 약 10명 입장`));
    } else {
      body.appendChild(snippet('토큰 검증 API',
        '클라이언트가 보낸 통과 토큰(pass.token 또는 tg_' + seg + ' 쿠키)을 서버에서 확인합니다. 유효하면 200, 아니면 401.',
`curl -s -X POST ${server}/api/v1/verify \\
  -H 'Content-Type: application/json' \\
  -d '{"token":"<토큰>","segment":"${seg}"}'
# {"valid":true,"segment":"${seg}","ticket":"...","expires_at":1767225600}`));
      body.appendChild(snippet('직접 검증 (Java/Spring 예시)',
        '설정 파일의 security.token_secret 으로 HMAC-SHA256 서명을 확인합니다. 형식: v1.<payload>.<signature>',
`String[] p = token.split("\\\\.");
Mac mac = Mac.getInstance("HmacSHA256");
mac.init(new SecretKeySpec(secret.getBytes(UTF_8), "HmacSHA256"));
byte[] sig = mac.doFinal((p[0] + "." + p[1]).getBytes(UTF_8));
boolean ok = MessageDigest.isEqual(sig, Base64.getUrlDecoder().decode(p[2]));
JsonNode c = mapper.readTree(Base64.getUrlDecoder().decode(p[1]));
ok = ok && c.get("s").asText().equals("${seg}") && c.get("exp").asLong() > Instant.now().getEpochSecond();`));
    }
  }

  boot();
})();

/* ============================================================================
 * domain-d/app.js —— D 域（家庭协同）前端逻辑源文件
 * ---------------------------------------------------------------------------
 * 由 domain-d/inject.js 内联为独立 D 域脚本块（块 id="d-domain"）。
 *
 * 纪律（务必满足 .workbuddy/qa/_accept19.js 静态层门禁）：
 *   1) 不写 console.* / debugger；
 *   2) 不写 addEventListener('click') / closest('[data-action]') —— 复用主脚本的
 *      单一 click 委托入口（dispatch → switch(action) → case 'fam-*'）；
 *   3) 不写任何 on* 内联事件；所有交互只走 data-action + 派发表；
 *   4) setInterval 用于冷启动轮询（不在 setTimeout 行里带 fetch/load/plan/search）；
 *   5) data-action 与 case 'fam-*' 严格一一对应（双向覆盖，不可出现静默失效/死分支）；
 *   6) 不新增页面节点 id 属性（保持既有节点计数不变）；
 *   7) 不读/不写 STORE_KEY 对象（roomId 走独立 localStorage 键，避免改动既有域）。
 *
 * 身份：复用既有前端用户选择 State.currentUserId（容器 SQLite /api/users，id 1/2），
 *       不再假设 PG 里存在 users 行，也不向其塞种子。
 * ========================================================================== */

/* ---------- D 域私有状态（挂在全局，但不改 State 对象字面量） ---------- */
var FAM = {
  /* ★ 初值留空：由 famLoadFamily 回落到 rooms[0]（服务端按 last_message_at 倒序，即最新房间）。
   *   历史缺陷：初值写死 'default'，而 'default' 恰好在列表里 → 永远不回落，
   *   用户首屏落地在 default 房间（内容为空/全红线），招牌「换位翻译」零展示。 */
  roomId: (function(){ try { return window.localStorage.getItem('zy_family_room') || ''; } catch (e) { return ''; } })(),
  role: 'student',
  rooms: [],
  messages: [],
  dims: null,
  isFetching: false,
  fetched: false,
  fetchAt: 0,
  editId: null,
  wakeTimer: null,
  wakeOn: false
};

var FAM_ROLES = [
  { code: 'student', label: '学生' },
  { code: 'father',  label: '父亲' },
  { code: 'mother',  label: '母亲' },
  { code: 'teacher', label: '老师' }
];
var FAM_ROLE_LABEL = { student: '学生', father: '父亲', mother: '母亲', teacher: '老师' };

/* ---------- 视图容器：运行时动态创建，不改动任何既有 view 节点 ---------- */
function famEnsureView(){
  if (document.getElementById('view-family')) return;
  var sec = document.createElement('section');
  sec.id = 'view-family';
  sec.className = 'view-section';
  sec.innerHTML =
    '<div class="page-body">' +
      '<div class="fam-banner" id="fam-banner" hidden>' +
        '<i class="fa-solid fa-triangle-exclamation"></i>' +
        '<div class="fam-banner-txt"><b>服务唤醒中</b>：家庭协同模块正在启动，约需 30 秒，稍后自动重试。</div>' +
        '<button class="btn btn--brand" data-action="fam-retry">立即重试</button>' +
      '</div>' +
      '<div class="fam-rooms" id="fam-rooms"></div>' +
      '<div class="fam-timeline" id="fam-timeline"></div>' +
      '<div class="fam-composer">' +
        '<div class="fam-roles" id="fam-roles"></div>' +
        '<div class="fam-composer-row">' +
          '<textarea id="fam-input" placeholder="把想对家人说的话原样写下来（双向换位翻译只转译，不改写你的原话）"></textarea>' +
          '<button class="btn btn--brand" data-action="fam-send">发送</button>' +
        '</div>' +
        '<div class="fam-send-hint" id="fam-send-hint"></div>' +
      '</div>' +
      '<div class="fam-compare" id="fam-compare">' +
        '<div class="fam-compare-head"><b>双志愿表对比</b><span class="fam-compare-sub">只展示，不写入共识</span></div>' +
        '<div class="fam-compare-controls">' +
          '<label class="fam-cmp-label">角色 A<select id="fam-cmp-a" class="fam-cmp-select">' + famCmpOptions('student') + '</select></label>' +
          '<label class="fam-cmp-label">角色 B<select id="fam-cmp-b" class="fam-cmp-select">' + famCmpOptions('father') + '</select></label>' +
          '<button class="btn btn--brand" data-action="fam-cmp-run">对比</button>' +
        '</div>' +
        '<div class="fam-compare-result" id="fam-cmp-result"></div>' +
      '</div>' +
    '</div>';
  var app = document.getElementById('app');
  if (app) app.appendChild(sec);
  famRenderRoles();
}

/* ---------- 发送者身份段控件（EP-01 的 sender_role 选择） ---------- */
function famRenderRoles(){
  var box = document.getElementById('fam-roles');
  if (!box) return;
  var html = '';
  for (var i = 0; i < FAM_ROLES.length; i++) {
    var r = FAM_ROLES[i];
    var active = (FAM.role === r.code) ? ' active' : '';
    html += '<button class="fam-role-opt' + active + '" data-action="fam-sender-role" data-role="' + r.code + '">' + r.label + '</button>';
  }
  box.innerHTML = html;
}
if (typeof FAM === 'object') { FAM.role = 'student'; }

/* ---------- 对比视图：角色下拉选项 ---------- */
function famCmpOptions(selected){
  var html = '';
  for (var i = 0; i < FAM_ROLES.length; i++) {
    var r = FAM_ROLES[i];
    var sel = (r.code === selected) ? ' selected' : '';
    html += '<option value="' + r.code + '"' + sel + '>' + r.label + '</option>';
  }
  return html;
}

/* ---------- 渲染：房间列表（EP-10） ---------- */
function famRenderRooms(){
  var box = document.getElementById('fam-rooms');
  if (!box) return;
  if (!FAM.rooms.length) { box.innerHTML = ''; return; }
  var html = '';
  for (var i = 0; i < FAM.rooms.length; i++) {
    var rm = FAM.rooms[i];
    var active = (String(rm.room_id) === String(FAM.roomId)) ? ' active' : '';
    var cnt = (rm.message_count != null) ? rm.message_count : 0;
    html += '<button class="fam-room' + active + '" data-action="fam-select-room" data-room="' + String(rm.room_id).replace(/"/g, '') + '">' +
              '<div class="fam-room-name">会话 ' + String(rm.room_id).replace(/</g, '&lt;') + '</div>' +
              '<div class="fam-room-meta">' + cnt + ' 条 · ' + famFmtTime(rm.last_message_at) + '</div>' +
            '</button>';
  }
  box.innerHTML = html;
}

/* ---------- 渲染：时间线 + 5 态翻译主视图 + 原话折叠（EP-02 / EP-12 / §4） ---------- */
function famRenderTimeline(emptyReason){
  var box = document.getElementById('fam-timeline');
  if (!box) return;
  if (!FAM.messages.length) {
    /* ★ 空态文案必须区分「还没有对话」与「连不上 / 唤醒中」。
     *   离线却显示"还没有对话"是在误导用户（首次加载失败时尤其明显）。
     *   W3 验收要求：骨架先渲染、绝不白屏 —— 失败路径也必须走到这里。 */
    var copy = '还没有对话。在下方写下第一条原话，系统会把它翻译成家人更容易理解的说法。';
    if (emptyReason === 'offline') copy = '暂时连不上服务，稍后会自动重试。也可以点上方「立即重试」。';
    else if (emptyReason === 'waking') copy = '服务唤醒中，稍后会自动重试。';
    box.innerHTML = '<div class="fam-empty">' + copy + '</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < FAM.messages.length; i++) {
    html += famRenderMessage(FAM.messages[i]);
  }
  box.innerHTML = html;
}

function famRenderMessage(m){
  var state = m.translation_state || 'pending';
  var roleCls = 'fam-role--' + (m.sender_role || 'student');
  var head = '<div class="fam-msg-head">' +
      '<span class="fam-role ' + roleCls + '">' + (FAM_ROLE_LABEL[m.sender_role] || m.sender_role || '学生') + '</span>' +
      '<span class="fam-dir">' + ((m.direction === 'parent_to_child') ? '→ 孩子' : '→ 父母') + '</span>' +
      '<span class="fam-time">' + famFmtTime(m.created_at) + '</span>' +
    '</div>';

  var body = '';
  var folded = !!m.folded;

  /* ★ 原话块统一带「原话」标签：译文与原文必须一眼可辨，否则用户把译文当原文读。 */
  var rawBlock = '<div class="fam-raw"' + (folded ? ' hidden' : '') + '><b class="fam-tag fam-tag--raw">原话</b>' + famEsc(m.raw_text || '') + '</div>';

  if (state === 'ok') {
    body += '<div class="fam-translation"><b class="fam-tag fam-tag--trans">换位译文</b>' + famEsc(m.translation_text || '') + '</div>';
    body += rawBlock;
  } else if (state === 'pending') {
    body += '<div class="fam-pending">换位译文生成中…（原话已保存，不会丢失）</div>';
    body += rawBlock;
  } else if (state === 'stale') {
    body += '<div class="fam-state-note fam-state-note--stale">原话已更新，旧译文失效，可点「重译」生成新译文。</div>';
    body += rawBlock;
  } else if (state === 'failed') {
    body += '<div class="fam-state-note fam-state-note--failed">换位译文生成失败，原话已保留，可点「重译」重试。</div>';
    body += rawBlock;
  } else if (state === 'flagged') {
    body += '<div class="fam-state-note fam-state-note--flagged">该消息触发安全红线，未生成换位译文 —— 已转介专业支持资源，请优先关注当事人安全。</div>';
    body += rawBlock;
  } else {
    body += rawBlock;
  }

  var signals = famRenderSignals(m.signals);

  var actions = '<div class="fam-actions">';
  actions += '<button class="btn btn--ghost" data-action="fam-fold" data-id="' + m.id + '">' + (folded ? '展开原话' : '收起原话') + '</button>';
  actions += '<button class="btn btn--ghost" data-action="fam-edit" data-id="' + m.id + '">编辑原话</button>';
  /* ★ 翻译入口常驻（flagged 除外：红线态按设计不产出译文，给按钮＝死操作）。
   *   历史缺陷：按钮只在 stale/failed/pending 出现，ok 态没有任何入口 →
   *   招牌功能「双向换位翻译」在界面上不可发现。后端 EP-05 无状态守卫，ok 态可安全重译。 */
  if (state !== 'flagged') {
    var tLabel = (state === 'ok') ? '重新翻译' : (state === 'pending' ? '生成译文' : '重译');
    var tCls = (state === 'ok') ? 'btn--ghost' : 'btn--brand';
    actions += '<button class="btn ' + tCls + '" data-action="fam-translate" data-id="' + m.id + '">' + tLabel + '</button>';
  }
  actions += '<button class="btn btn--ghost" data-action="fam-extract" data-id="' + m.id + '">抽取职业信号</button>';
  actions += '<button class="btn btn--danger" data-action="fam-report" data-id="' + m.id + '">举报</button>';
  actions += '</div>';

  var editor = '';
  if (FAM.editId === m.id) {
    editor = '<div class="fam-editor">' +
        '<textarea id="fam-edit-input">' + famEsc(m.raw_text || '') + '</textarea>' +
        '<div class="fam-actions">' +
          '<button class="btn btn--brand" data-action="fam-save-edit" data-id="' + m.id + '">保存</button>' +
          '<button class="btn btn--ghost" data-action="fam-cancel-edit">取消</button>' +
        '</div>' +
      '</div>';
  }

  return '<div class="fam-msg" data-mid="' + m.id + '">' + head + body + signals + actions + editor + '</div>';
}

function famRenderSignals(sigs){
  if (!sigs || !sigs.length) return '';
  var html = '<div class="fam-signals">';
  for (var i = 0; i < sigs.length; i++) {
    var s = sigs[i];
    var stale = s.stale ? ' fam-sig--stale' : '';
    var conf = (s.confidence != null) ? Math.round(Number(s.confidence) * 100) + '%' : '';
    var label = s.axis_label || s.axis_code || '信号';
    var detail = [s.intent_code, s.concern_code, s.anchor_code].filter(Boolean).join(' · ');
    html += '<span class="fam-sig' + stale + '"><b>' + famEsc(label) + '</b>' +
            (detail ? ' ' + famEsc(detail) : '') +
            (conf ? '<span class="fam-sig-conf">' + conf + '</span>' : '') + '</span>';
  }
  html += '</div>';
  return html;
}

/* ---------- 工具 ---------- */
function famEsc(t){
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function famFmtTime(t){
  if (!t) return '';
  try {
    var d = new Date(t);
    if (isNaN(d.getTime())) return String(t);
    var p = function(n){ return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) { return String(t); }
}

/* ---------- 网络层：复用既有 API.fetchJSON（相对路径 / 抛错收口） ---------- */
function famUid(){ return (typeof State !== 'undefined' && State.currentUserId) ? State.currentUserId : 1; }

/* ★ 网络超时护栏（修复「冷启动 Render 代理挂住 1-3 分钟 → isFetching 全程卡死」）。
 *   用 AbortController 包一层并在 FAM_API_TIMEOUT 后 setTimeout(abort)；
 *   同时 race 一个超时 reject（Error('HTTP 503 (timeout)')），保证即便底层 fetch
 *   不支持 signal 也能在超时后走 waking 语义，而不是无限挂死。
 *   超时值可用环境变量 FAM_API_TIMEOUT_MS 覆盖（仅供测试加速，生产默认 10000ms）。 */
var FAM_API_TIMEOUT = (typeof process !== 'undefined' && process.env && process.env.FAM_API_TIMEOUT_MS)
  ? parseInt(process.env.FAM_API_TIMEOUT_MS, 10) || 10000
  : 10000;

function famApiWithTimeout(run){
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function(){
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
  }, FAM_API_TIMEOUT);
  var req = run(ctrl ? ctrl.signal : null);
  var guard = new Promise(function(_, rej){
    setTimeout(function(){ rej(new Error('HTTP 503 (timeout)')); }, FAM_API_TIMEOUT);
  });
  return Promise.race([req, guard]).then(function(v){
    clearTimeout(timer); return v;
  }, function(e){
    clearTimeout(timer); throw e;
  });
}

function famApiGet(path){
  return famApiWithTimeout(function(signal){
    return API.fetchJSON(path, signal ? { method: 'GET', signal: signal } : { method: 'GET' });
  });
}
function famApiSend(method, path, body){
  return famApiWithTimeout(function(signal){
    return API.fetchJSON(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: signal || undefined
    });
  });
}

function famIsWaking(err){
  if (!err || !err.message) return false;
  return err.message.indexOf('503') > -1 || err.message.indexOf('E_SERVICE_WAKING') > -1;
}

/* ---------- 冷启动 / 降级：503 横幅 + 轮询（≥5s，隐藏暂停） ---------- */
function famShowBanner(on){
  var b = document.getElementById('fam-banner');
  if (b) b.hidden = !on;
}
function famStartWake(){
  if (FAM.wakeTimer) return;
  FAM.wakeOn = true;
  FAM.wakeTimer = setInterval(function(){
    if (document.hidden) return;            // 标签页隐藏时不打接口（暂停）
    famApiGet('/api/health')
      .then(function(){ return famLoadFamily(true); })
      .catch(function(){ /* 仍未就绪，继续等 */ });
  }, 6000);
}
function famStopWake(){
  FAM.wakeOn = false;
  if (FAM.wakeTimer) { clearInterval(FAM.wakeTimer); FAM.wakeTimer = null; }
}
function famOnVisible(){
  if (FAM.wakeOn && !document.hidden && !FAM.wakeTimer) famStartWake();
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', famOnVisible);
}

/* ---------- 主加载（EP-10 房间 + EP-02 时间线） ---------- */
function famLoadFamily(silent){
  // ★ 看门狗：挂死超 15s 允许重入，避免唤醒轮询/重试空转死锁
  if (FAM.isFetching && Date.now() - (FAM.fetchAt || 0) < 15000) return Promise.resolve();
  FAM.isFetching = true;
  FAM.fetchAt = Date.now();
  return famApiGet('/api/family-rooms?userId=' + famUid() + '&page=1&size=50')
    .then(function(res){
      FAM.rooms = (res && res.data && res.data.list) ? res.data.list : [];
      // 若当前房间不在列表中（首次/被清），回落到最新房间
      var inList = FAM.rooms.some(function(r){ return String(r.room_id) === String(FAM.roomId); });
      if (!inList && FAM.rooms.length) FAM.roomId = String(FAM.rooms[0].room_id);
      famRenderRooms();
      return famLoadTimeline();
    })
    .then(function(){
      FAM.isFetching = false;
      FAM.fetched = true;
      famStopWake();
      famShowBanner(false);
    })
    .catch(function(err){
      FAM.isFetching = false;
      var waking = famIsWaking(err);
      // ★ fetched 之后数据已加载，服务抖动不再顶回大横幅（行内文案已兜底）
      if (waking && !FAM.fetched) {
        famShowBanner(true);
        if (!silent) famStartWake();
      }
      /* ★ 失败路径也必须渲染骨架文本，否则时间线区域是空白（骨架缺失＝近似白屏）。
       *   其它错误不再完全静默：至少让时间线给出「连不上」的真实说明。 */
      famRenderTimeline(waking ? 'waking' : 'offline');
    });
}

function famLoadTimeline(){
  return famApiGet('/api/family-messages?userId=' + famUid() + '&room_id=' + encodeURIComponent(FAM.roomId) + '&page=1&size=200')
    .then(function(res){
      FAM.messages = (res && res.data && res.data.list) ? res.data.list : [];
      famRenderTimeline();
      // ★ 成功即收横幅（时间线数据已就绪，不必再等 famLoadFamily 完整链路）
      famStopWake();
      famShowBanner(false);
    })
    .catch(function(err){
      var waking = famIsWaking(err);
      if (waking && !FAM.fetched) { famShowBanner(true); famStartWake(); }
      if (!FAM.messages.length) famRenderTimeline(waking ? 'waking' : 'offline');
    });
}

/* ---------- 派发处理器（case 'fam-*' 的实现，全部挂在 Controller 上） ---------- */
if (typeof Controller !== 'undefined') {
  Controller.famOpen = function(){
    famEnsureView();
    UI.switchView('family');
    famRenderRoles();
    famLoadFamily(false);
  };
  Controller.famSelectRoom = function(roomId){
    if (!roomId) return;
    FAM.roomId = String(roomId);
    try { window.localStorage.setItem('zy_family_room', FAM.roomId); } catch (e) {}
    famRenderRooms();
    FAM.messages = [];
    famRenderTimeline();
    famLoadTimeline();
  };
  Controller.famSetRole = function(role){
    FAM.role = role;
    famRenderRoles();
  };
  Controller.famSend = function(){
    var input = document.getElementById('fam-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) { var h = document.getElementById('fam-send-hint'); if (h) h.textContent = '原话不能为空'; return; }
    var hint = document.getElementById('fam-send-hint'); if (hint) hint.textContent = '发送中…';
    famApiSend('POST', '/api/family-messages', {
      userId: famUid(), room_id: FAM.roomId, sender_role: FAM.role || 'student',
      raw_text: text, auto_translate: true
    }).then(function(res){
      if (hint) hint.textContent = '';
      input.value = '';
      var saved = res && res.data && res.data.saved;
      if (saved && saved.room_id) {
        FAM.roomId = String(saved.room_id);
        try { window.localStorage.setItem('zy_family_room', FAM.roomId); } catch (e) {}
      }
      famLoadFamily(true).then(famLoadTimeline);
    }).catch(function(err){
      if (hint) hint.textContent = famIsWaking(err) ? '服务唤醒中，请稍后重试' : '发送失败，请重试';
      if (famIsWaking(err) && !FAM.fetched) { famShowBanner(true); famStartWake(); }
    });
  };
  Controller.famFold = function(id){
    var m = famFind(id); if (!m) return;
    m.folded = !m.folded;
    famRenderTimeline();
    famApiSend('PUT', '/api/family-messages/' + id + '/folded', { userId: famUid(), folded: !!m.folded })
      .catch(function(){});   // 折叠态持久化失败不阻断交互
  };
  Controller.famEdit = function(id){ FAM.editId = id; famRenderTimeline(); };
  Controller.famCancelEdit = function(){ FAM.editId = null; famRenderTimeline(); };
  Controller.famSaveEdit = function(id){
    var ta = document.getElementById('fam-edit-input'); if (!ta) return;
    var text = ta.value.trim();
    var m = famFind(id); if (!m) return;
    if (!text) return;
    famApiSend('PUT', '/api/family-messages/' + id + '/raw', {
      userId: famUid(), expected_raw_version: m.raw_version, raw_text: text
    }).then(function(res){
      FAM.editId = null;
      var saved = res && res.data && res.data.saved;
      if (saved) {
        m.raw_text = saved.raw_text; m.raw_version = saved.raw_version;
        m.translation_state = saved.translation_state; m.translation_text = saved.translation_text;
        m.translation_status = saved.translation_status;
      }
      famRenderTimeline();
    }).catch(function(err){
      if (err && err.message && err.message.indexOf('409') > -1) {
        FAM.editId = null; famLoadTimeline();   // 版本冲突：刷新后重试
      }
    });
  };
  Controller.famTranslate = function(id){
    famApiSend('POST', '/api/family-messages/' + id + '/translate', { userId: famUid() })
      .then(function(res){
        var saved = res && res.data && res.data.saved;
        var m = famFind(id);
        if (saved && m) {
          m.translation_state = saved.translation_state;
          m.translation_text = saved.translation_text;
          m.translation_status = saved.translation_status;
          if (saved.translation_version != null) m.translation_version = saved.translation_version;
          famRenderTimeline();
        }
      })
      .catch(function(err){
        if (famIsWaking(err) && !FAM.fetched) { famShowBanner(true); famStartWake(); }
      });
  };
  Controller.famExtract = function(id){
    famApiSend('POST', '/api/family-messages/' + id + '/extract-signal', { userId: famUid() })
      .then(function(){ return famLoadTimeline(); })
      .catch(function(err){ if (famIsWaking(err) && !FAM.fetched) { famShowBanner(true); famStartWake(); } });
  };
  Controller.famReport = function(id){
    famApiSend('POST', '/api/family-messages/' + id + '/report', { userId: famUid(), reason_code: 'red_line' })
      .then(function(){ var m = famFind(id); if (m) { m.is_flagged = true; m.translation_state = 'flagged'; famRenderTimeline(); } })
      .catch(function(err){ if (famIsWaking(err) && !FAM.fetched) { famShowBanner(true); famStartWake(); } });
  };
  Controller.famRetry = function(){
    famShowBanner(false);
    // ★ 3s 强制重入：挂死超过 3s 立即解锁，保证「立即重试」按钮永远有响应；
    //   3s 内的新鲜在途请求不动（避免与即将成功的请求竞争）。
    if (FAM.isFetching && Date.now() - (FAM.fetchAt || 0) >= 3000) {
      FAM.isFetching = false;
    }
    return famLoadFamily(false);
  };
  Controller.famCmpRun = function(){
    var sa = document.getElementById('fam-cmp-a');
    var sb = document.getElementById('fam-cmp-b');
    var box = document.getElementById('fam-cmp-result');
    if (!sa || !sb) return;
    var ra = sa.value, rb = sb.value;
    if (ra === rb) {
      if (box) box.innerHTML = '<div class="fam-cmp-empty">角色 A 与角色 B 不能相同</div>';
      return;
    }
    if (box) box.innerHTML = '<div class="fam-cmp-empty">对比中…</div>';
    famApiGet('/api/family-volunteers/compare?userId=' + famUid() + '&role_a=' + encodeURIComponent(ra) + '&role_b=' + encodeURIComponent(rb))
      .then(function(res){
        var d = res && res.data;
        if (d) famRenderCompare(d);
        // ★ 对比成功即收横幅（数据已就绪）
        famStopWake();
        famShowBanner(false);
      })
      .catch(function(err){
        if (famIsWaking(err) && !FAM.fetched) {
          famShowBanner(true);
          famStartWake();
          if (box) box.innerHTML = '<div class="fam-cmp-empty">服务唤醒中，稍后重试</div>';
        } else if (box) {
          box.innerHTML = '<div class="fam-cmp-empty">对比失败：' + famEsc(err && err.message ? err.message : '') + '</div>';
        }
      });
  };
}

function famFind(id){
  for (var i = 0; i < FAM.messages.length; i++) {
    if (String(FAM.messages[i].id) === String(id)) return FAM.messages[i];
  }
  return null;
}

/* ---------- 对比视图渲染（EP-14 三桶 + 分歧高亮） ---------- */
function famRole(code){ return FAM_ROLE_LABEL[code] || code; }

function famCmpItem(it, kind){
  var diff = (kind === 'both' && it.score_differs) ? ' fam-cmp-item--diff' : '';
  var scoreLine;
  if (kind === 'both') {
    scoreLine = '<div class="fam-cmp-score">A ' + famNum(it.score_a) + ' · B ' + famNum(it.score_b) +
      (it.score_differs ? ' <span class="fam-cmp-diff-flag">分数不一致</span>' : '') + '</div>';
  } else {
    scoreLine = '<div class="fam-cmp-score">' + famNum(it.score) + '</div>';
  }
  return '<div class="fam-cmp-item' + diff + '">' +
      '<span class="fam-cmp-kind">' + famEsc(it.kind) + '</span>' +
      '<span class="fam-cmp-name">' + famEsc(it.name) + '</span>' +
      scoreLine +
    '</div>';
}

function famCmpBucket(title, list, kind){
  var h = '<div class="fam-cmp-bucket fam-cmp-bucket--' + kind + '">';
  h += '<div class="fam-cmp-bucket-title">' + famEsc(title) + '（' + (list ? list.length : 0) + '）</div>';
  if (!list || !list.length) {
    h += '<div class="fam-cmp-empty">—</div>';
  } else {
    for (var i = 0; i < list.length; i++) h += famCmpItem(list[i], kind);
  }
  h += '</div>';
  return h;
}

function famRenderCompare(data){
  var box = document.getElementById('fam-cmp-result');
  if (!box) return;
  if (!data) { box.innerHTML = ''; return; }
  var counts = data.counts || {};
  var h = '<div class="fam-cmp-summary">';
  h += '<span>未共识 · ' + famRole(data.role_a) + ' 独有 ' + famNum(counts.only_a) + '</span>';
  h += '<span>共识 ' + famNum(counts.both) + '</span>';
  h += '<span>未共识 · ' + famRole(data.role_b) + ' 独有 ' + famNum(counts.only_b) + '</span>';
  h += '</div>';
  h += famCmpBucket('未共识 · ' + famRole(data.role_a) + ' 独有', data.only_a, 'a');
  h += famCmpBucket('共识（含分数差异提示，不计入列表分歧）', data.both, 'both');
  h += famCmpBucket('未共识 · ' + famRole(data.role_b) + ' 独有', data.only_b, 'b');
  box.innerHTML = h;
}

function famNum(n){ return (n == null ? 0 : n); }

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
 *
 * ★ 两端画面（本版核心，用户原话「学生看到了是一个画面，家长看的又是一个页面」）：
 *   1) 进「家庭」先过**身份门**（学生 / 父亲 / 母亲 / 老师），选一次写入独立 localStorage 键
 *      zy_family_role，刷新仍在；随时可「切换身份」回去重选（数据不删）。
 *   2) 未选身份时**只渲染身份门**，且**不发任何 /api/family-* 请求**（见 Controller.famOpen）。
 *   3) 两端不是两套内容，是**同一段对话的两个视角**：学生端看到「爸妈的话 · 换位给我听」，
 *      家长端看到「孩子的话 · 换位给我听」；同一条消息在两端的视角标签不同。
 *   4) 家长端多出「分歧项 · 三态表态」区（可接受 / 可协商 / 不可妥协），
 *      选「不可妥协」必须写理由（≥8 字）+ 替代方案（或勾选"没有替代方案"）——禁止裸否决；
 *      学生端**整段不出现**该区块。
 *   5) 服务端共识能力不可用（表未建 / PG 未就绪）时，表态区**整段隐藏**，不白屏、不编造。
 * ========================================================================== */

/* ---------- D 域私有状态（挂在全局，但不改 State 对象字面量） ---------- */
var FAM = {
  /* ★ 初值留空：由 famLoadFamily 回落到 rooms[0]（服务端按 last_message_at 倒序，即最新房间）。
   *   历史缺陷：初值写死 'default'，而 'default' 恰好在列表里 → 永远不回落，
   *   用户首屏落地在 default 房间（内容为空/全红线），招牌「换位翻译」零展示。 */
  roomId: (function(){ try { return window.localStorage.getItem('zy_family_room') || ''; } catch (e) { return ''; } })(),
  /* ★ 身份门（本版核心）：role 为空 = 还没选过身份 → 只渲染身份选择屏，不发任何 D 域请求。
   *   历史缺陷：role 初值写死 'student'，进来就默认「你是学生」——
   *   家长打开看到的是学生画面，学生打开看到的是家长画面，两端根本无法区分。
   *   现在改成持久读取 zy_family_role（独立 localStorage 键，不碰 STORE_KEY 对象）。 */
  role: (function(){ try { return String(window.localStorage.getItem('zy_family_role') || ''); } catch (e) { return ''; } })(),
  rooms: [],
  messages: [],
  dims: null,
  isFetching: false,
  fetched: false,
  fetchAt: 0,
  editId: null,
  wakeTimer: null,
  wakeOn: false,
  /* —— 分歧项 / 三态表态（家长端） —— */
  items: [],
  progress: null,
  stancePick: {},      /* item_id -> 暂选的 stance（未提交） */
  stanceError: {},     /* item_id -> 校验错误文案 */
  stanceDraft: {},     /* item_id -> 已输入但未提交的字段（重渲染时不擦掉用户打的字） */
  consensusReady: false, /* 服务端共识能力是否可用（不可用则整段不出现） */
  volunteers: []       /* 我的志愿表 */
};

var FAM_ROLES = [
  { code: 'student', label: '学生' },
  { code: 'father',  label: '父亲' },
  { code: 'mother',  label: '母亲' },
  { code: 'teacher', label: '老师' }
];
var FAM_ROLE_LABEL = { student: '学生', father: '父亲', mother: '母亲', teacher: '老师' };

/* 学生端 / 家长端判定：唯一落点（两端画面靠它分支，别在各处重复判断） */
function famIsStudent(){ return FAM.role === 'student'; }
function famIsParent(){ return FAM.role === 'father' || FAM.role === 'mother' || FAM.role === 'teacher'; }
/* 对方消息的视角文案：学生看家长 =「爸妈的话」，家长看学生 =「孩子的话」 */
function famOtherLabel(){ return famIsStudent() ? '爸妈的话' : '孩子的话'; }
function famSelfMsgLabel(){ return famIsStudent() ? '我说的话' : '我说的话'; }

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

      /* ============ 身份门：没选身份之前，这一屏是「唯一」内容，不发任何请求 ============ */
      '<div class="fam-gate" id="fam-gate">' +
        '<div class="fam-gate-card">' +
          '<div class="fam-gate-icon"><i class="fa-solid fa-people-roof"></i></div>' +
          '<div class="fam-gate-title">这个家里，你是哪位？</div>' +
          '<div class="fam-gate-sub">选一次就记住。学生看到的画面是「爸妈的话换位给我听」，家长看到的是「孩子的话换位给我听」——两边不是同一个页面。</div>' +
          '<div class="fam-roles" id="fam-roles"></div>' +
          '<div class="fam-gate-note">不用注册、不用邀请码；选错了随时能换，对话内容不会丢。</div>' +
        '</div>' +
      '</div>' +

      /* ============ 主区：选定身份后才出现 ============ */
      '<div class="fam-main" id="fam-main" hidden>' +
        '<div class="fam-idbar">' +
          '<span class="fam-idbar-chip" id="fam-idbar-chip"></span>' +
          '<button class="btn btn--ghost" data-action="fam-switch-role">切换身份</button>' +
        '</div>' +

        '<div class="fam-sec-head" id="fam-sec-head"></div>' +
        '<div class="fam-rooms" id="fam-rooms"></div>' +
        '<div class="fam-timeline" id="fam-timeline"></div>' +

        '<div class="fam-mine" id="fam-mine"></div>' +

        /* —— 家长端专属：分歧项三态表态 + 收敛进度（学生端整段不出现） —— */
        '<div class="fam-stance" id="fam-stance" hidden></div>' +

        '<div class="fam-composer" id="fam-composer">' +
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
      '</div>' +
    '</div>';
  var app = document.getElementById('app');
  if (app) app.appendChild(sec);
  famRenderRoles();
  famApplyRole();
}

/* ---------- 身份应用：门 / 主区 / 各端文案 一次收口（唯一开关） ---------- */
function famApplyRole(){
  var gate = document.getElementById('fam-gate');
  var main = document.getElementById('fam-main');
  var on = (FAM.role === 'student' || FAM.role === 'father' || FAM.role === 'mother' || FAM.role === 'teacher');
  if (gate) gate.hidden = on;
  if (main) main.hidden = !on;
  if (!on) return;
  famRenderIdbar();
  famRenderSecHead();
  famRenderMine();
  /* 学生端：表态区整段不出现（连同节点一起藏，不留空壳） */
  if (!famIsParent()) {
    var st = document.getElementById('fam-stance');
    if (st) { st.hidden = true; st.innerHTML = ''; }
  }
}

/* ---------- 顶栏：当前身份 + 切换入口 ---------- */
function famRenderIdbar(){
  var box = document.getElementById('fam-idbar-chip');
  if (!box) return;
  var tone = famIsStudent() ? 'fam-idbar-chip--student' : 'fam-idbar-chip--parent';
  box.className = 'fam-idbar-chip ' + tone;
  box.textContent = (famIsStudent() ? '学生视角' : '家长视角') + ' · ' + famRole(FAM.role);
}

/* ---------- 区块标题：两端各自的「换位给我听」 ---------- */
function famRenderSecHead(){
  var box = document.getElementById('fam-sec-head');
  if (!box) return;
  box.innerHTML = '<b>' + famEsc(famOtherLabel()) + ' · 换位给我听</b>' +
    '<span class="fam-sec-sub">下面是' + famEsc(famIsStudent() ? '爸妈' : '孩子') +
    '原话的「换位表达」——只转译语气，不改写内容；点「查看原话」看原句</span>';
}

/* ---------- 身份门：选身份（复用既有 data-action="fam-sender-role"，不再逐条选角色） ----------
 * ★ 用途改写（只增不减）：这个动作名原本是「每条消息选发送者角色」，
 *   现在由**身份门**承载 —— 进去时选一次、本地记住、随时可换。
 *   动作名保持不变，从而不破坏「data-action 与 case 双向覆盖」的静态门禁。 */
var FAM_IDENTITY_HINT = {
  student: '我看到的是「爸妈的话」',
  father:  '我看到的是「孩子的话」',
  mother:  '我看到的是「孩子的话」',
  teacher: '我看到的是「孩子的话」'
};
function famRenderRoles(){
  var box = document.getElementById('fam-roles');
  if (!box) return;
  var html = '';
  for (var i = 0; i < FAM_ROLES.length; i++) {
    var r = FAM_ROLES[i];
    var active = (FAM.role === r.code) ? ' active' : '';
    html += '<button class="fam-role-opt' + active + '" data-action="fam-sender-role" data-role="' + r.code + '">' +
              '<b>' + r.label + '</b>' +
              '<span>' + famEsc(FAM_IDENTITY_HINT[r.code] || '') + '</span>' +
            '</button>';
  }
  box.innerHTML = html;
}

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
  /* ★ 空态文案按「你是哪一端」分岔：学生等的是爸妈的话，家长等的是孩子的话。
   *   同一句「还没有对话」在两端都不成立，用户看了只会觉得"这功能没做"。 */
  var baseCopy = famIsStudent()
    ? '还没有爸妈的消息——先在下面写下你的想法，系统会把它换位成爸妈更容易听进去的说法。'
    : '孩子还没发言——你可以先把担心写下来，系统会把它换位成孩子更容易听进去的说法。';
  if (!FAM.messages.length) {
    /* ★ 空态文案必须区分「还没有对话」与「连不上 / 唤醒中」。
     *   离线却显示"还没有对话"是在误导用户（首次加载失败时尤其明显）。
     *   W3 验收要求：骨架先渲染、绝不白屏 —— 失败路径也必须走到这里。 */
    var copy = baseCopy;
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

/* 「我的消息 / 对方的消息」判定：两端视角的唯一落点 */
function famMsgIsMine(m){
  var mySide = famIsStudent() ? 'student' : 'parent';
  var msgSide = (m && m.sender_role === 'student') ? 'student' : 'parent';
  return mySide === msgSide;
}

function famRenderMessage(m){
  var state = m.translation_state || 'pending';
  var roleCls = 'fam-role--' + (m.sender_role || 'student');
  var mine = famMsgIsMine(m);
  var head = '<div class="fam-msg-head">' +
      '<span class="fam-role ' + roleCls + '">' + (FAM_ROLE_LABEL[m.sender_role] || m.sender_role || '学生') + '</span>' +
      '<span class="fam-dir">' + ((m.direction === 'parent_to_child') ? '→ 孩子' : '→ 父母') + '</span>' +
      '<span class="fam-time">' + famFmtTime(m.created_at) + '</span>' +
    '</div>' +
    /* ★ 两端画面正是靠这一行文案区分开的：
     *   自己这侧 = 「我这一侧 · 原话」；对方那侧 = 「爸妈的话 / 孩子的话 · 换位给我听」。 */
    '<div class="fam-side-tag">' + famEsc(mine ? '我这一侧 · 原话' : (famOtherLabel() + ' · 换位给我听')) + '</div>';

  var body = '';
  var folded = !!m.folded;

  /* ★ 原话块统一带「原话」标签：译文与原文必须一眼可辨，否则用户把译文当原文读。
   *   自己写的标「我的原话」，对方写的标「对方原话」。 */
  var rawTag = mine ? '我的原话' : '对方原话';
  var rawBlock = '<div class="fam-raw"' + (folded ? ' hidden' : '') + '><b class="fam-tag fam-tag--raw">' + rawTag + '</b>' + famEsc(m.raw_text || '') + '</div>';
  var transTag = mine ? '换位后的说法（对方会看到）' : '换位译文';

  if (state === 'ok') {
    body += '<div class="fam-translation"><b class="fam-tag fam-tag--trans">' + transTag + '</b>' + famEsc(m.translation_text || '') + '</div>';
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

  return '<div class="fam-msg' + (mine ? ' fam-msg--mine' : ' fam-msg--other') + '" data-mid="' + m.id + '">' + head + body + signals + actions + editor + '</div>';
}

function famRenderSignals(sigs){
  if (!sigs || !sigs.length) return '';
  var html = '<div class="fam-signals">';
  for (var i = 0; i < sigs.length; i++) {
    var s = sigs[i];
    var stale = s.stale ? ' fam-sig--stale' : '';
    var conf = (s.confidence != null) ? Math.round(Number(s.confidence) * 100) + '%' : '';
    var label = s.axis_label || '职业分歧';
    /* ★ 只显示人话标签，绝不显示枚举码。
     *   历史缺陷：这里曾拼 intent_code / concern_code / anchor_code，
     *   用户看到的是 CI_RESOLUTE · AN_NO_REGRET 这种内部码 —— 像开发日志。
     *   标签由服务端 shapeSignal 从 dim_* 维表解析；缺哪个就省哪个（不用码兜底）。 */
    var detail = [s.intent_label, s.concern_label, s.anchor_label].filter(Boolean).join(' · ');
    html += '<span class="fam-sig' + stale + '"><b>' + famEsc(label) + '</b>' +
            (detail ? ' ' + famEsc(detail) : '') +
            (conf ? '<span class="fam-sig-conf">' + conf + '</span>' : '') + '</span>';
  }
  html += '</div>';
  return html;
}

/* ============================================================================
 * 我的志愿表（两端各自显示自己那一侧）
 * ========================================================================== */
function famRenderMine(){
  var box = document.getElementById('fam-mine');
  if (!box) return;
  var list = FAM.volunteers || [];
  var h = '<div class="fam-mine-head"><b>我的志愿表</b>' +
          '<span class="fam-mine-sub">' + famEsc(famIsStudent() ? '我自己看上的' : '我希望的') + '</span></div>';
  if (!list.length) {
    h += '<div class="fam-mine-empty">' +
      famEsc(famIsStudent()
        ? '还没有志愿想法——去「找学校 / 找专业」加几所，这里会自动出现。'
        : '你还没有添加想法。可以先写下你的意见，再逐项表态。') +
      '</div>';
    box.innerHTML = h;
    return;
  }
  h += '<div class="fam-mine-list">';
  for (var i = 0; i < list.length; i++) {
    var v = list[i];
    h += '<span class="fam-mine-item"><i>' + famEsc(v.kind === 'college' ? '院校' : '专业') + '</i>' +
         famEsc(v.name || ('#' + v.ref_id)) + '</span>';
  }
  h += '</div>';
  if (FAM.progress) {
    var waiting = famNum(FAM.progress.total) - famNum(FAM.progress.settled) - famNum(FAM.progress.deferred);
    var settled = famNum(FAM.progress.settled);
    h += '<div class="fam-mine-diff">与' + famEsc(famIsStudent() ? '爸妈' : '孩子') + '的分歧项：<b>' + famNum(FAM.progress.total) + '</b> 项' +
         '（已定 <b>' + settled + '</b> · 待决 <b>' + famNum(FAM.progress.deferred) + '</b> · 未表态 <b>' + Math.max(0, waiting) + '</b>）</div>';
  }
  box.innerHTML = h;
}

/* ============================================================================
 * 家长端 · 分歧项 + 三态表态 + 收敛进度
 * ---------------------------------------------------------------------------
 * 「有则出现、无则不出现」：服务端共识能力不可用时（表未建 / 未就绪），
 * 连节点一起藏起来 —— 绝不渲染空壳，也绝不编造内容。
 * 学生端整段不出现（用户已锁定：学生端没有表态区）。
 * ========================================================================== */
var FAM_STANCE_OPTS = [
  { code: 'accept',     label: '可接受',   hint: '我没问题' },
  { code: 'negotiable', label: '可协商',   hint: '有条件' },
  { code: 'veto',       label: '不可妥协', hint: '我不接受' }
];
var FAM_STANCE_LABEL = { accept: '可接受', negotiable: '可协商', veto: '不可妥协' };
var FAM_STATUS_LABEL = { pending: '还有人没表态', settled: '已定', deferred: '待决' };

function famRenderStance(){
  var box = document.getElementById('fam-stance');
  if (!box) return;
  if (!famIsParent() || !FAM.consensusReady) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;

  var items = FAM.items || [];
  var pg = FAM.progress || { total: 0, settled: 0, pending: 0, deferred: 0 };
  var h = '<div class="fam-stance-head"><b>分歧项 · 你的态度</b>' +
          '<span class="fam-stance-sub">同一个问题，你和孩子各自表态。点「不可妥协」必须写清原因和替代方案，不能只说不行。</span></div>';
  h += '<div class="fam-progress">' +
         '<span class="fam-progress-chip fam-progress-chip--settled">已定 ' + famNum(pg.settled) + '</span>' +
         '<span class="fam-progress-chip fam-progress-chip--deferred">待决 ' + famNum(pg.deferred) + '</span>' +
         '<span class="fam-progress-chip fam-progress-chip--pending">未表态 ' + famNum(pg.pending) + '</span>' +
         '<span class="fam-progress-chip">共 ' + famNum(pg.total) + ' 项</span>' +
       '</div>';
  if (!items.length) {
    h += '<div class="fam-stance-empty">暂无分歧项。你们的志愿表还没有差异，先用下面的「双志愿表对比」看看，或者写几句你的担心。</div>';
    box.innerHTML = h;
    return;
  }
  for (var i = 0; i < items.length; i++) h += famStanceItemHTML(items[i]);
  box.innerHTML = h;
}

function famStanceItemHTML(it){
  var id = String(it.item_id);
  var picked = FAM.stancePick[id] || (it.my_stance && it.my_stance.stance) || '';
  var mine = it.my_stance || {};
  var err = FAM.stanceError[id] || '';
  /* ★ 草稿优先：用户已经打了一半的字，不能因为旁边点了另一项就被擦掉。 */
  var draft = FAM.stanceDraft[id] || null;
  var reasonVal = draft ? draft.reason : (mine.reason || '');
  var subVal = draft ? draft.sub : (picked === 'negotiable' ? (mine.condition || '') : (mine.substitute || ''));
  var noVal = draft ? draft.noSub : !!mine.no_substitute;
  var h = '<div class="fam-stance-item" data-item="' + famEsc(id) + '">';
  h += '<div class="fam-stance-item-head">' +
         '<span class="fam-stance-kind">' + famEsc(it.item_type === 'axis' ? '观念' : (it.item_type === 'college' ? '院校' : '专业')) + '</span>' +
         '<span class="fam-stance-name">' + famEsc(it.label || it.ref_key || '') + '</span>' +
         '<span class="fam-stance-status fam-stance-status--' + famEsc(it.status || 'pending') + '">' + famEsc(FAM_STATUS_LABEL[it.status] || '') + '</span>' +
       '</div>';
  h += '<div class="fam-stance-opts">';
  for (var i = 0; i < FAM_STANCE_OPTS.length; i++) {
    var o = FAM_STANCE_OPTS[i];
    var on = (picked === o.code) ? ' active' : '';
    h += '<button class="fam-stance-opt fam-stance-opt--' + o.code + on + '" data-action="fam-stance-set" data-item="' + famEsc(id) + '" data-stance="' + o.code + '">' +
           '<b>' + o.label + '</b><span>' + o.hint + '</span>' +
         '</button>';
  }
  h += '</div>';
  /* ★ 禁止裸否决：选了「不可妥协」才展开强制字段（理由 + 替代方案）；
   *   「可协商」展开条件字段（可留空）。都用 class 取，不用 id —— 一屏可能有多个项。 */
  if (picked === 'veto') {
    h += '<div class="fam-veto-fields">' +
           '<label class="fam-veto-label">因为什么？（至少 8 字）' +
             '<textarea class="fam-veto-reason" placeholder="例：这个专业本科毕业很难找到对口工作，我担心四年后没着落">' + famEsc(reasonVal) + '</textarea>' +
           '</label>' +
           '<label class="fam-veto-label">除非 / 替代方案（至少 4 字）' +
             '<textarea class="fam-veto-sub" placeholder="例：除非他能考上研究生，否则我不接受">' + famEsc(subVal) + '</textarea>' +
           '</label>' +
           '<label class="fam-veto-nosub"><input type="checkbox"' + (noVal ? ' checked' : '') + ' /><span>我确实没有替代方案，只是表达底线</span></label>' +
         '</div>';
  } else if (picked === 'negotiable') {
    h += '<div class="fam-veto-fields">' +
           '<label class="fam-veto-label">有什么条件？（可留空，写了更容易谈成）' +
             '<textarea class="fam-veto-sub" placeholder="例：会计可以，但必须考研 / 必须在省内">' + famEsc(subVal) + '</textarea>' +
           '</label>' +
         '</div>';
  }
  if (err) h += '<div class="fam-stance-err">' + famEsc(err) + '</div>';
  h += '<div class="fam-stance-actions">' +
         '<button class="btn btn--brand" data-action="fam-stance-submit" data-item="' + famEsc(id) + '">提交这项态度</button>' +
         (mine.stance ? '<span class="fam-stance-mine">已表态：' + famEsc(FAM_STANCE_LABEL[mine.stance] || '') + '</span>' : '') +
       '</div>';
  h += '</div>';
  return h;
}

function famStanceNode(id){
  var all = document.querySelectorAll('.fam-stance-item');
  for (var i = 0; i < all.length; i++) {
    if (all[i].getAttribute('data-item') === String(id)) return all[i];
  }
  return null;
}

/* 把 DOM 里已输入但未提交的强制字段存入草稿 —— 重渲染（例如点了旁边那一项）不擦字 */
function famStanceStash(){
  var all = document.querySelectorAll('.fam-stance-item');
  for (var i = 0; i < all.length; i++) {
    var id = String(all[i].getAttribute('data-item') || '');
    if (!id) continue;
    var r = all[i].querySelector('.fam-veto-reason');
    var s = all[i].querySelector('.fam-veto-sub');
    var n = all[i].querySelector('.fam-veto-nosub input');
    if (!r && !s && !n) continue;
    FAM.stanceDraft[id] = {
      reason: r ? String(r.value || '') : '',
      sub: s ? String(s.value || '') : '',
      noSub: n ? !!n.checked : false
    };
  }
}

/* 把后端错误码翻成人话（绝不把 [E_XXX] 这类内部码丢给用户看） */
function famErrText(err){
  var msg = (err && err.message) ? String(err.message) : '';
  if (msg.indexOf('E_VETO_REASON_REQUIRED') > -1) return '请说明你担心的原因（至少 8 字）';
  if (msg.indexOf('E_VETO_SUBSTITUTE_REQUIRED') > -1) return '请给出替代方案，或勾选「我没有替代方案」';
  if (msg.indexOf('E_ITEM_FORBIDDEN') > -1) return '这一项不属于你们的家庭';
  if (msg.indexOf('E_ITEM_NOT_FOUND') > -1) return '这一项已不存在，刷新后重试';
  if (msg.indexOf('E_STANCE_INVALID') > -1) return '请重新选择态度';
  if (msg.indexOf('409') > -1) return '这一项刚被更新过，已为你刷新';
  return '提交失败，请稍后重试';
}

/* ---------- 共识：读分歧项 + 收敛进度 ---------- */
function famLoadConsensus(){
  if (!FAM.role || !FAM.roomId) return Promise.resolve();
  return famApiGet('/api/family-consensus?userId=' + famUid() +
                   '&room_id=' + encodeURIComponent(FAM.roomId) +
                   '&viewer_role=' + encodeURIComponent(FAM.role))
    .then(function(res){
      var d = res && res.data;
      FAM.items = (d && d.items) ? d.items : [];
      FAM.progress = (d && d.progress) ? d.progress : { total: 0, settled: 0, pending: 0, deferred: 0 };
      FAM.consensusReady = true;
      famRenderStance();
      famRenderMine();
    })
    .catch(function(){
      /* ★ 表没建 / 服务未就绪 → 整段不出现。不白屏、不编造、不弹错误墙。 */
      FAM.consensusReady = false;
      FAM.items = [];
      FAM.progress = null;
      famRenderStance();
    });
}

/* ---------- 我的志愿表：读自己那一侧（学生侧只查 SQLite，无 PG 也能出） ---------- */
function famLoadMine(){
  if (!FAM.role) return Promise.resolve();
  return famApiGet('/api/family-volunteers?userId=' + famUid() +
                   '&owner_role=' + encodeURIComponent(FAM.role) + '&page=1&size=50')
    .then(function(res){
      FAM.volunteers = (res && res.data && res.data.list) ? res.data.list : [];
      famRenderMine();
    })
    .catch(function(){ FAM.volunteers = []; famRenderMine(); });
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
  if (!b) return;
  b.hidden = !on;
  b.style.display = on ? 'flex' : 'none';
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
      /* ★ 房间号这一刻才确定（可能回落到 rooms[0]），共识与志愿表都按 room_id 归属，
       *   所以放在这里读，而不是和 famLoadFamily 同时打 —— 否则第一发 consensus 会因
       *   FAM.roomId 还是空而直接 return，家长端永远看不到分歧项。 */
      if (FAM.role) { famLoadConsensus(); famLoadMine(); }
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
    famApplyRole();
    /* ★ 身份门：还没选身份 → 就停在「你是哪位」这一屏，绝不发任何 D 域请求。 */
    if (!FAM.role) return;
    famLoadFamily(false);
    famLoadMine();
  };
  Controller.famSwitchRole = function(){
    /* 回到身份门（清本地记住的身份）。数据不删，重新选回来还在。 */
    FAM.role = '';
    try { window.localStorage.removeItem('zy_family_role'); } catch (e) {}
    FAM.items = []; FAM.progress = null;
    FAM.stancePick = {}; FAM.stanceError = {}; FAM.stanceDraft = {};
    FAM.consensusReady = false; FAM.volunteers = [];
    famRenderRoles();
    famApplyRole();
  };
  Controller.famSelectRoom = function(roomId){
    if (!roomId) return;
    FAM.roomId = String(roomId);
    try { window.localStorage.setItem('zy_family_room', FAM.roomId); } catch (e) {}
    famRenderRooms();
    FAM.messages = [];
    famRenderTimeline();
    famLoadTimeline();
    if (FAM.role) famLoadConsensus();
  };
  Controller.famSetRole = function(role){
    if (role !== 'student' && role !== 'father' && role !== 'mother' && role !== 'teacher') return;
    FAM.role = role;
    try { window.localStorage.setItem('zy_family_role', role); } catch (e) {}
    /* 切身份 = 换一个画面，不丢数据：消息原样重渲染（换位方向随之翻转）。 */
    FAM.stancePick = {}; FAM.stanceError = {}; FAM.stanceDraft = {};
    FAM.consensusReady = false; FAM.items = []; FAM.progress = null; FAM.volunteers = [];
    famRenderRoles();
    famApplyRole();
    famRenderTimeline();
    famLoadFamily(false);
    famLoadMine();
  };
  Controller.famStanceSet = function(itemId, stance){
    if (!itemId) return;
    if (stance !== 'veto' && stance !== 'negotiable' && stance !== 'accept') return;
    if (FAM.stancePick[String(itemId)] === stance) return;   /* 同键重复点：不重渲染，免得擦掉已输入的字 */
    famStanceStash();
    FAM.stancePick[String(itemId)] = stance;
    FAM.stanceError[String(itemId)] = '';
    famRenderStance();
  };
  Controller.famStanceSubmit = function(itemId){
    var id = String(itemId || '');
    if (!id) return;
    var pick = FAM.stancePick[id];
    if (!pick) { FAM.stanceError[id] = '请先选一个态度'; famRenderStance(); return; }
    var node = famStanceNode(id);
    var rEl = node ? node.querySelector('.fam-veto-reason') : null;
    var sEl = node ? node.querySelector('.fam-veto-sub') : null;
    var nEl = node ? node.querySelector('.fam-veto-nosub input') : null;
    var reason = rEl ? String(rEl.value || '').trim() : '';
    var sub = sEl ? String(sEl.value || '').trim() : '';
    var noSub = nEl ? !!nEl.checked : false;
    var condition = '';
    if (pick === 'negotiable') { condition = sub; sub = ''; }
    /* ★ 禁止裸否决 —— 前端先拦一道（后端还有 400 [E_VETO_*] 兜底）：
     *   不合规就地标红、不发请求，用户不会先看到一次"提交失败"再猜哪里错了。 */
    if (pick === 'veto') {
      if (reason.length < 8) { FAM.stanceError[id] = '请说明你担心的原因（至少 8 字）'; famRenderStance(); return; }
      if (!sub && !noSub) { FAM.stanceError[id] = '请给出替代方案，或勾选「我没有替代方案」'; famRenderStance(); return; }
    }
    FAM.stanceError[id] = '';
    famApiSend('PUT', '/api/family-consensus/stance', {
      userId: famUid(), room_id: FAM.roomId, role: FAM.role, item_id: Number(id),
      stance: pick, reason: reason, substitute: sub, no_substitute: noSub, condition: condition
    }).then(function(res){
      delete FAM.stanceDraft[id];
      var d = res && res.data;
      if (d && d.progress) { FAM.progress = d.progress; famRenderMine(); }
      return famLoadConsensus();
    }).catch(function(err){
      FAM.stanceError[id] = famIsWaking(err) ? '服务唤醒中，请稍后重试' : famErrText(err);
      famRenderStance();
    });
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

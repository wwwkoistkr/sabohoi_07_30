/* 골프 페널티 정산표 — 엑셀형, 컬럼 리사이즈, 관리자 자료실, localStorage */
(function () {
  'use strict';

  var STORE_KEY = 'golf-penalty-sheet-v3';
  var DEFAULT_ROWS = 8;
  var DEFAULT_DATE_COUNT = 3;   // 앱 기본 날짜 개수(3개). 많아지면 접기로 처리.
  var isAdmin = false; // 관리자 로그인 여부 (수정/삭제 권한)
  var MAX_SCORE = 999; // 타수 입력 상한
  var adminToken = '';     // 서버가 로그인 성공 후 발급한 8시간 만료 토큰(메모리에만 보관)
  var assetsCache = [];    // 서버(R2)에서 받아온 자료실 목록
  var assetsLoaded = false;

  // 날짜가 많아 화면을 넘어가면 가운데 오래된 날짜 열을 자동으로 접어(숨겨)
  // 회원이름·평균타수·최근 날짜 몇 개가 한 화면에 보이게 함.
  var collapseEnabled = true;   // 접기 사용 여부
  var expandTimer = null;       // '초기화(펼쳐보기)' 후 자동 복귀 타이머

  var state = load();

  // ---------- 저장/로드 ----------
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        return normalizeState(d);
      }
    } catch (e) {}
    return normalizeState({});
  }
  // 번호 필드는 과거 백업/브라우저 캐시에 남아 있어도 즉시 제거한다.
  // 그 밖의 추가 필드(editTimes 등)는 그대로 보존해 전체 백업/복원이 손실 없이 동작한다.
  function stripStoredNumberData(data) {
    var out = Object.assign({}, data || {});
    out.members = Array.isArray(out.members) ? out.members.map(function (member) {
      var copy = Object.assign({}, member || {}); delete copy.phone; return copy;
    }) : [];
    if (out.manager && typeof out.manager === 'object') {
      out.manager = Object.assign({}, out.manager); delete out.manager.phone;
    }
    if (out.labels && typeof out.labels === 'object') {
      out.labels = Object.assign({}, out.labels); delete out.labels.colPhone;
    }
    return out;
  }
  function normalizeState(saved) {
    var out = stripStoredNumberData(saved);
    out.members = out.members.length ? out.members : makeDefaultMembers();
    out.dates = (out.dates && out.dates.length) ? out.dates : makeDefaultDates();
    out.cells = out.cells || {};
    out.editTimes = (out.editTimes && typeof out.editTimes === 'object') ? out.editTimes : {};
    out.manager = out.manager || { name: '' };
    out.widths = out.widths || {};
    out.labels = mergeLabels(out.labels);
    out.extra = normalizeExtra(out.extra);
    return out;
  }
  // 지출액/잔액 값을 항상 {expense, balance} 숫자 형태로 정규화
  function normalizeExtra(saved) {
    var out = (saved && typeof saved === 'object') ? Object.assign({}, saved) : {};
    out.expenses = {};
    if (saved && typeof saved === 'object') {
      if (Object.prototype.hasOwnProperty.call(saved, 'total')) out.total = Number(saved.total) || 0;
      if (saved.expenses && typeof saved.expenses === 'object') {
        Object.keys(saved.expenses).forEach(function (dateId) { out.expenses[dateId] = Number(saved.expenses[dateId]) || 0; });
      } else if (Number(saved.expense) > 0) {
        out.legacyExpense = Number(saved.expense) || 0;
      }
    }
    return out;
  }
  function expenseFor(dateId) {
    var direct = Number(state.extra && state.extra.expenses && state.extra.expenses[dateId]) || 0;
    if (direct) return direct;
    var latest = state.dates.slice().sort(function (a, b) { return b.iso.localeCompare(a.iso); })[0];
    return (latest && latest.id === dateId) ? (Number(state.extra && state.extra.legacyExpense) || 0) : 0;
  }
  function totalExpensesThrough(dateId) {
    var target = findDate(dateId);
    if (!target) return 0;
    var total = 0;
    state.dates.slice().sort(function (a, b) { return a.iso.localeCompare(b.iso); }).forEach(function (d) {
      if (d.iso <= target.iso) total += expenseFor(d.id);
    });
    return total;
  }
function baseTotalAmount() {
    return state.extra && Object.prototype.hasOwnProperty.call(state.extra, 'total') ? (Number(state.extra.total) || 0) : grandTotal();
  }
  function totalExpensesAll() {
    var total = 0;
    state.dates.forEach(function (d) { total += expenseFor(d.id); });
    return total;
  }
  function currentTotalAmount() { return baseTotalAmount() - totalExpensesAll(); }
  function balanceFor(dateId) { return baseTotalAmount() - totalExpensesThrough(dateId); }
  // 화면에 쓰이는 문구 기본값 (관리자 모드에서 수정 가능)
  function defaultLabels() {
    return {
      title: '사보회',                      // 상단 제목
      lost: '타수',                         // 날짜 칸 안 점수의 의미
      colName: '회원 이름',                // 이름 열 제목
    };
  }
  // 저장된 labels에 기본값을 덮어씌워 항상 모든 키가 존재하도록 병합
  function mergeLabels(saved) {
    var def = defaultLabels();
    if (!saved || typeof saved !== 'object') return def;
    var out = Object.assign({}, saved);
    delete out.colPhone;
    Object.keys(def).forEach(function (k) {
      var oldValue = (typeof saved[k] === 'string' && saved[k].trim()) ? saved[k] : '';
      if (k === 'title' && oldValue === '골프등급표') oldValue = '사보회';
      if (k === 'lost' && oldValue === '잃은 돈') oldValue = '타수';
      out[k] = oldValue || def[k];
    });
    return out;
  }
  // 개별 라벨 읽기 (없으면 기본값)
  function lostLabel() { return (state.labels && state.labels.lost) || '타수'; }
  function lbl(key) { return (state.labels && state.labels[key]) || defaultLabels()[key]; }
  function makeDefaultMembers() {
    var arr = [];
    for (var i = 0; i < DEFAULT_ROWS; i++) arr.push({ id: uid(), name: '' });
    return arr;
  }
  function makeDate(iso) { return { id: uid(), iso: iso }; }
  // 기본 날짜 3개(오늘 기준 최근 3일)를 만든다. 앱을 처음 열거나 완전 초기화했을 때 사용.
  function makeDefaultDates() {
    var arr = [];
    var p = function (n) { return String(n).padStart(2, '0'); };
    for (var i = DEFAULT_DATE_COUNT - 1; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var iso = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      arr.push(makeDate(iso));
    }
    return arr;
  }
  function saveLocal() { try { state = stripStoredNumberData(state); localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
  // save(): 로컬에 즉시 저장 + 서버(D1)에 디바운스 저장하여 모든 기기가 공유하게 함.
  function save() { saveLocal(); scheduleServerSave(); }
  // 입력이 끝난 뒤(포커스 해제) 미뤄둔 서버 데이터를 반영한다.
  function flushPendingServerData() {
    if (pendingServerData && !isEditing()) {
      var d = pendingServerData; pendingServerData = null;
      applyServerData(d);
    }
  }
  function uid() { return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ============================================================
  //  서버 동기화 (모바일 ↔ PC 실시간 연동)
  //  - 정산표 데이터를 서버(D1)에 저장/불러오기. R2는 이미지 전용이다.
  //  - localStorage 는 기기별로 분리돼 연동이 안 되므로 서버 저장본을 "정본"으로 사용.
  // ============================================================
  var serverRev = 0;            // 마지막으로 확인/저장한 서버 버전
  var serverSaveTimer = null;   // 디바운스 타이머
  var isSavingToServer = false; // 저장 중 중복 방지
  var pendingServerSave = false;// 저장 중에 또 변경되면 다시 저장
  var lastAppliedJson = '';     // 폴링 시 동일 데이터면 무시하기 위한 캐시
  var pendingServerData = null; // 입력 중이라 반영을 미룬 서버 데이터(입력 끝나면 적용)
  var pendingCellEdits = {};    // 완료를 누른 타수만 충돌 재시도용으로 보관
  var cellEditSequence = 0;
  var pendingExtraEdits = {}; // 총액·날짜별 지출도 409 충돌 뒤 다시 적용
  var extraEditSequence = 0;

  function serializeState() {
    return stripStoredNumberData(state);
  }
  function queueCellEdit(key, value, previous) {
    state.editTimes = state.editTimes || {};
    var firstEditedAt = Number(state.editTimes[key]) || (previous ? 0 : Date.now());
    pendingCellEdits[key] = { value: value, seq: ++cellEditSequence, editedAt: firstEditedAt };
    if (value && firstEditedAt) state.editTimes[key] = firstEditedAt; else delete state.editTimes[key];
  }
  function snapshotPendingCellEdits() {
    var copy = {};
    Object.keys(pendingCellEdits).forEach(function (key) { copy[key] = Object.assign({}, pendingCellEdits[key]); });
    return copy;
  }
  function replayPendingCellEdits() {
    state.editTimes = state.editTimes || {};
    Object.keys(pendingCellEdits).forEach(function (key) {
      var edit = pendingCellEdits[key];
      var value = Number(edit.value) || 0;
      if (value) {
        state.cells[key] = value;
        if (edit.editedAt) state.editTimes[key] = edit.editedAt; else delete state.editTimes[key];
      } else {
        delete state.cells[key];
        delete state.editTimes[key];
      }
    });
  }
  function clearSentCellEdits(sent) {
    var cleared = false;
    Object.keys(sent).forEach(function (key) {
      if (pendingCellEdits[key] && pendingCellEdits[key].seq === sent[key].seq) {
        delete pendingCellEdits[key];
        cleared = true;
      }
    });
    return cleared;
  }

  function queueExtraEdit(key, value, notify) {
    pendingExtraEdits[key] = { value: Number(value) || 0, seq: ++extraEditSequence, notify: !!notify };
  }
  function snapshotPendingExtraEdits() {
    var copy = {};
    Object.keys(pendingExtraEdits).forEach(function (key) { copy[key] = Object.assign({}, pendingExtraEdits[key]); });
    return copy;
  }
  function replayPendingExtraEdits() {
    if (!state.extra) state.extra = { expenses: {} };
    if (!state.extra.expenses) state.extra.expenses = {};
    Object.keys(pendingExtraEdits).forEach(function (key) {
      var edit = pendingExtraEdits[key];
      if (key === 'total') {
        state.extra.total = edit.value;
      } else if (key.indexOf('expense|') === 0) {
        var dateId = key.slice(8);
        if (edit.value) state.extra.expenses[dateId] = edit.value; else delete state.extra.expenses[dateId];
        delete state.extra.legacyExpense;
      }
    });
  }
  function clearSentExtraEdits(sent) {
    var shouldNotify = false;
    Object.keys(sent).forEach(function (key) {
      if (pendingExtraEdits[key] && pendingExtraEdits[key].seq === sent[key].seq) {
        if (sent[key].notify) shouldNotify = true;
        delete pendingExtraEdits[key];
      }
    });
    return shouldNotify;
  }
  var inputToast = null;
  var inputToastTimer = null;
  function showInputToast(message) {
    if (!inputToast) return;
    if (inputToastTimer) clearTimeout(inputToastTimer);
    inputToast.textContent = message || '입력되었습니다';
    inputToast.classList.remove('hidden');
    inputToastTimer = setTimeout(function () {
      inputToast.classList.add('hidden');
      inputToastTimer = null;
    }, 1400);
  }

  function scheduleServerSave() {
    if (serverSaveTimer) clearTimeout(serverSaveTimer);
    serverSaveTimer = setTimeout(function () {
      serverSaveTimer = null;   // ★타이머 소진 후 반드시 null 로 리셋(폴링이 막히지 않도록)
      saveToServer();
    }, 600); // 입력 후 0.6초 뒤 서버 저장
  }

  function saveToServer() {
    if (isSavingToServer) { pendingServerSave = true; return; }
    isSavingToServer = true;
    var payload = serializeState();
    var sentCellEdits = snapshotPendingCellEdits();
    var sentExtraEdits = snapshotPendingExtraEdits();
    lastAppliedJson = JSON.stringify(payload);
    fetch('/api/sheet', {
      method: 'PUT',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ data: payload, baseRev: serverRev })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      if (res.status === 409 && res.body && res.body.conflict) {
        // 다른 사람이 먼저 저장했으면 서버 최신본을 기준으로 완료된 내 타수만 다시 적용한다.
        serverRev = res.body.rev || serverRev;
        if (res.body.data) {
          state = normalizeState(res.body.data);
          replayPendingCellEdits();
          replayPendingExtraEdits();
          saveLocal();
          render();
        }
        isSavingToServer = false;
        scheduleServerSave();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        isSavingToServer = false;
        if (isAdmin) {
          pendingExtraEdits = {};
          pendingServerSave = false;
          handleAdminExpired();
          reloadFromServer();
        } else if (res.status === 403) {
          pendingCellEdits = {};
          pendingExtraEdits = {};
          pendingServerSave = false;
          alert('입력 후 24시간이 지난 타수의 수정·삭제와 총액·지출 변경은 관리자 로그인이 필요합니다. 서버 최신값으로 다시 맞춥니다.');
          reloadFromServer();
        }
        return;
      }
      if (res.body && res.body.ok) {
        serverRev = res.body.rev || serverRev;
        var shouldConfirmInput = clearSentCellEdits(sentCellEdits);
        if (clearSentExtraEdits(sentExtraEdits)) shouldConfirmInput = true;
        if (shouldConfirmInput) showInputToast('입력되었습니다');
      }
      isSavingToServer = false;
      if (pendingServerSave || Object.keys(pendingCellEdits).length || Object.keys(pendingExtraEdits).length) { pendingServerSave = false; scheduleServerSave(); }
    }).catch(function () {
      isSavingToServer = false; // 오프라인이면 완료된 타수는 로컬에 유지하고 잠시 뒤 재시도
      if (Object.keys(pendingCellEdits).length || Object.keys(pendingExtraEdits).length) setTimeout(scheduleServerSave, 1500);
    });
  }

  function reloadFromServer() {
    return fetch('/api/sheet').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) {
        serverRev = j.rev || 0;
        if (j.data && j.data.members) {
          lastAppliedJson = JSON.stringify(j.data);
          pendingServerData = null;
          applyServerData(j.data);
        }
      }
    }).catch(function () {});
  }

  // 사용자가 표 안의 입력칸에 타이핑 중인지(포커스) 확인 — 그러면 화면을 다시 그리지 않는다.
  function isEditing() {
    var ae = document.activeElement;
    return !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') &&
      ae.closest && (ae.closest('#view-sheet') || ae.closest('.sheet')));
  }

  // 서버에서 받은 데이터를 현재 state 에 적용.
  // ★입력(포커스) 중에는 render()로 DOM을 갈아치우면 input이 사라져 키패드가 닫히므로,
  //  타이핑 중이면 화면 갱신을 미룬다(입력이 끝난 뒤 blur 시점 등에 반영).
  function applyServerData(d) {
    if (!d || !d.members) return;
    if (isEditing()) { pendingServerData = d; return; }
    state = normalizeState(d);
    replayPendingCellEdits();
    replayPendingExtraEdits();
    saveLocal();
    render();
    renderAdmin && renderAdmin();
  }

  // 시작 시 서버 데이터 로드. 서버에 데이터가 있으면 그걸로 화면을 채운다.
  function loadFromServer() {
    return fetch('/api/sheet').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) {
        serverRev = j.rev || 0;
        if (j.data && j.data.members) {
          lastAppliedJson = JSON.stringify(j.data);
          applyServerData(j.data);
        } else {
          // 서버가 비어있으면(최초) 현재 로컬 데이터를 서버에 올려 정본으로 만든다.
          if (state.members && state.members.length) { scheduleServerSave(); }
        }
      }
    }).catch(function () {}); // 실패해도 로컬 데이터로 계속 동작
  }

  // 주기적 폴링: 다른 기기(모바일/PC)에서 바뀐 내용을 가져와 반영.
  function startPolling() {
    setInterval(function () {
      // 사용자가 입력칸에 타이핑 중이면(포커스) 화면을 갈아치우지 않음
      var ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ae.closest && ae.closest('#view-sheet')) return;
      if (isSavingToServer || serverSaveTimer) return; // 내가 저장 중이면 건너뜀
      fetch('/api/sheet').then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok && j.rev > serverRev && j.data && j.data.members) {
          serverRev = j.rev;
          var incoming = JSON.stringify(j.data);
          if (incoming !== lastAppliedJson) {
            lastAppliedJson = incoming;
            applyServerData(j.data);
          }
        }
      }).catch(function () {});
    }, 4000); // 4초마다 확인
  }

  // ---------- 숫자/날짜 ----------
  function fmt(n) { n = Number(n) || 0; return n.toLocaleString('ko-KR'); }
  function parseNum(str) {
    if (str == null) return 0;
    var v = String(str).replace(/[^\d.-]/g, '');
    var n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n);
  }
  function cellKey(m, d) { return m + '|' + d; }
  function fmtDate(iso) { if (!iso) return ''; var p = iso.split('-'); return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : iso; }
  function fmtDateFull(iso) { return iso ? iso.replace(/-/g, '.') : ''; }
  function todayIso() { var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  // ---------- 합계 ----------
  function memberTotal(id) { var s = 0; state.dates.forEach(function (d) { s += Number(state.cells[cellKey(id, d.id)]) || 0; }); return s; }
  function memberAverageScore(id) {
    var total = 0, participatedDays = 0;
    state.dates.forEach(function (d) {
      var score = Number(state.cells[cellKey(id, d.id)]) || 0;
      if (score > 0) { total += score; participatedDays++; }
    });
    return participatedDays ? total / participatedDays : 0;
  }
  function memberParticipationCount(id) {
    var count = 0;
    state.dates.forEach(function (d) {
      if ((Number(state.cells[cellKey(id, d.id)]) || 0) > 0) count++;
    });
    return count;
  }
  function fmtAverage(value) {
    if (!value) return '';
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  function dateTotal(id) { var s = 0; state.members.forEach(function (m) { s += Number(state.cells[cellKey(m.id, id)]) || 0; }); return s; }
  function grandTotal() { var s = 0; state.members.forEach(function (m) { s += memberTotal(m.id); }); return s; }
  function priorDatesForTieBreak(dateId) {
    var selected = findDate(dateId);
    if (!selected) return [];
    return state.dates.filter(function (d) { return d.iso < selected.iso; })
      .sort(function (a, b) { return b.iso.localeCompare(a.iso); });
  }
  function compareMembersForDate(a, b, dateId) {
    var scoreA = Number(state.cells[cellKey(a.id, dateId)]) || 0;
    var scoreB = Number(state.cells[cellKey(b.id, dateId)]) || 0;
    if (!scoreA && !scoreB) return state.members.indexOf(a) - state.members.indexOf(b);
    if (!scoreA) return 1;
    if (!scoreB) return -1;
    if (scoreA !== scoreB) return scoreA - scoreB;
    var attendanceDiff = memberParticipationCount(b.id) - memberParticipationCount(a.id);
    if (attendanceDiff) return attendanceDiff;
    var previousDates = priorDatesForTieBreak(dateId);
    for (var i = 0; i < previousDates.length; i++) {
      var previousA = Number(state.cells[cellKey(a.id, previousDates[i].id)]) || 0;
      var previousB = Number(state.cells[cellKey(b.id, previousDates[i].id)]) || 0;
      if (!previousA && previousB) return 1;
      if (previousA && !previousB) return -1;
      if (previousA !== previousB) return previousA - previousB;
    }
    return state.members.indexOf(a) - state.members.indexOf(b);
  }
  function membersByDateRank(dateId) {
    return state.members.slice().sort(function (a, b) { return compareMembersForDate(a, b, dateId); });
  }
  function rankFor(memberId, dateId) {
    var score = Number(state.cells[cellKey(memberId, dateId)]) || 0;
    if (!score) return '';
    var ranked = membersByDateRank(dateId).filter(function (m) {
      return (Number(state.cells[cellKey(m.id, dateId)]) || 0) > 0;
    });
    for (var i = 0; i < ranked.length; i++) if (ranked[i].id === memberId) return i + 1;
    return '';
  }
  function dateBestScore(dateId) {
    var best = 0;
    state.members.forEach(function (m) {
      var score = Number(state.cells[cellKey(m.id, dateId)]) || 0;
      if (score > 0 && (!best || score < best)) best = score;
    });
    return best;
  }
  function dateWinnerNames(dateId) {
    var winner = membersByDateRank(dateId).filter(function (m) {
      return (Number(state.cells[cellKey(m.id, dateId)]) || 0) > 0 && (m.name || '').trim();
    })[0];
    if (!winner) return '';
    return Array.from((winner.name || '').trim()).slice(0, 3).join('');
  }  function averageWinnerName() {
    var winner = membersByAverage().filter(function (m) {
      return memberParticipationCount(m.id) > 0 && (m.name || '').trim();
    })[0];
    if (!winner) return '';
    return Array.from((winner.name || '').trim()).slice(0, 3).join('');
  }
  function membersByAverage() {
    return state.members.map(function (m, index) {
      return {
        member: m,
        index: index,
        average: memberAverageScore(m.id),
        participatedDays: memberParticipationCount(m.id)
      };
    })
      .sort(function (a, b) {
        if (!a.participatedDays && !b.participatedDays) return a.index - b.index;
        if (!a.participatedDays) return 1;
        if (!b.participatedDays) return -1;
        return a.average - b.average || b.participatedDays - a.participatedDays || a.index - b.index;
      }).map(function (x) { return x.member; });
  }

  // ---------- 렌더 ----------
  var head = document.getElementById('sheet-head');
  var body = document.getElementById('sheet-body');
  var foot = document.getElementById('sheet-foot');

  function render() {
    _vd = computeVisibleDates();
    applyLabels();
    renderHead(); renderBody(); renderFoot(); applyWidths();
    // 표 너비와 2단 헤더의 실제 높이를 렌더 뒤 계산한다.
    requestAnimationFrame(function () { syncHeaderWidth(); syncStickyHeaderOffsets(); });
  }

  // 상단 제목 등 정적 DOM에 편집된 문구를 반영
  function applyLabels() {
    var h1 = document.querySelector('.app-header h1');
    if (h1) h1.innerHTML = '<i class="fas fa-golf-ball-tee"></i> ' + escapeHtml(lbl('title'));
    if (document.title !== lbl('title')) document.title = lbl('title');
  }

  // 표가 옆으로 길어질수록 상단 헤더 내부 폭을 표 너비만큼 넓혀
  // 버튼들이 "날짜가 늘어나는 길이만큼" 그 위에 자리하도록 함.
  function syncHeaderWidth() {
    var sheet = document.getElementById('sheet');
    var inner = document.getElementById('app-header-inner');
    if (!sheet || !inner) return;
    // 모바일(≤640px): 헤더는 화면폭에 고정(2단 배치)하므로 표 너비를 따라
    // 늘리지 않는다. 인라인 min-width를 비워 CSS 규칙에 맡긴다.
    if (window.innerWidth <= 640) { inner.style.minWidth = ''; return; }
    var tableW = sheet.getBoundingClientRect().width;
    // 좌우 패딩(28px)을 더해 표 오른쪽 끝까지 헤더가 이어지도록
    inner.style.minWidth = (tableW + 28) + 'px';
  }
  function syncStickyHeaderOffsets() {
    var firstRow = head && head.querySelector('.date-group-row');
    if (!firstRow) return;
    head.style.setProperty('--date-group-height', Math.ceil(firstRow.getBoundingClientRect().height) + 'px');
  }

  // 좁은 화면(모바일/태블릿/가로화면 등 900px 이하)인지 판단.
  // ★모바일에서는 사용자가 예전에 드래그로 넓혀 저장한 "모든" 컬럼 폭(이름·
  //  날짜·합계 전부)을 무시하고 CSS의 좁은 고정폭을 강제한다. 이렇게 해야 예전에 크게
  //  늘려둔 폭이 남아 표가 화면을 넘치고(가로 스크롤) 컬럼이 잘리는 문제가 사라진다.
  function isNarrow() { return window.innerWidth <= 900; }
  // 좁은 화면에서 저장 드래그 폭을 무시할지 여부 — 이제 모든 컬럼에 적용한다.
  function forceCss(key) { return isNarrow(); }

  function wStyle(key) {
    // 좁은 화면에서는 저장폭을 전혀 쓰지 않고 CSS(:root/미디어쿼리)에 맡긴다.
    if (forceCss(key)) return '';
    return state.widths[key] ? (' style="width:' + state.widths[key] + 'px;min-width:' + state.widths[key] + 'px"') : '';
  }

  // 현재 화면 폭에서 "최근 날짜 몇 개"를 보여줄 수 있는지 계산.
  // 반환: { visible: [표시할 date...], hiddenCount: 접힌 개수, hiddenTotal: 접힌 금액합 }
  function computeVisibleDates() {
    var dates = state.dates;
    // 접기 꺼짐 or 날짜가 적으면 전부 표시
    if (!collapseEnabled) return { visible: dates.slice(), hiddenCount: 0, hiddenIds: [] };

    var MAX_VISIBLE = 3; // 화면에 보이는 날짜는 최대 약 3일 + 합계

    // 접기 기능이 켜져 있을 때는 화면 폭(모바일/PC)에 관계없이 항상 최근 3일을 고정으로
    // 보여준다. (모바일에서도 PC와 동일하게 3일이 나오도록) 480px 이하 좁은 폰에서는
    // CSS가 컬럼 폭을 충분히 좁혀두었으므로 3일이 화면 안에 들어간다.
    var visible = [];
    for (var i = dates.length - 1; i >= 0 && visible.length < MAX_VISIBLE; i--) {
      visible.unshift(dates[i]);
    }
    var visibleIds = {};
    visible.forEach(function (d) { visibleIds[d.id] = true; });
    var hiddenIds = [];
    dates.forEach(function (d) { if (!visibleIds[d.id]) hiddenIds.push(d.id); });
    return { visible: visible, hiddenCount: hiddenIds.length, hiddenIds: hiddenIds };
  }
  // CSS 변수 px값 읽기(없으면 기본)
  function cssPx(varName, def) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(varName);
    var n = parseInt(v, 10); return isNaN(n) ? def : n;
  }
  // 열의 실제 지정폭(사용자가 리사이즈했으면 그 값, 아니면 CSS 변수)
  function colW(key, varName, def) {
    // 좁은 화면에서는 저장된 드래그 폭을 전부 무시하고 CSS 좁은 폭 사용
    if (forceCss(key)) return cssPx(varName, def);
    if (state.widths[key]) return state.widths[key];
    return cssPx(varName, def);
  }
  // 접힌 날짜들의 합계(회원 기준 memberTotal에서 접힌 부분만 필요할 때 사용)
  function hiddenMemberTotal(mid, hiddenIds) {
    var s = 0; for (var i = 0; i < hiddenIds.length; i++) s += Number(state.cells[cellKey(mid, hiddenIds[i])]) || 0; return s;
  }
  function hiddenGrandTotal(hiddenIds) {
    var s = 0; state.members.forEach(function (m) { s += hiddenMemberTotal(m.id, hiddenIds); }); return s;
  }

  var _vd = { visible: [], hiddenCount: 0, hiddenIds: [] }; // 마지막 계산 결과 캐시
  var memberSortMode = { type: 'average', dateId: '' };
  function membersForDisplay() {
    if (memberSortMode.type === 'date' && findDate(memberSortMode.dateId)) return membersByDateRank(memberSortMode.dateId);
    return membersByAverage();
  }
  function renderHead() {
    var h = '<tr class="date-group-row">';
    h += '<th class="col-no" rowspan="2">No</th>';
    h += '<th class="col-name" rowspan="2" data-col="name"' + wStyle('name') + '>' + escapeHtml(lbl('colName')) + '<span class="col-resize" data-rz="name"></span></th>';
    h += '<th class="col-total" rowspan="2"><div class="average-head"><span>평균타수</span><button type="button" class="average-sort-btn" data-sort-average="1" title="평균타수가 낮은 회원부터 정렬">정렬</button></div></th>';
    if (_vd.hiddenCount > 0) {
      h += '<th class="col-fold" rowspan="2" title="숨겨진 날짜 ' + _vd.hiddenCount + '개 · 눌러서 전체 펼치기"><div class="fold-head"><span class="fold-dots">···</span><span class="fold-cnt">+' + _vd.hiddenCount + '일</span></div></th>';
    }
    _vd.visible.forEach(function (d) {
      h += '<th class="col-date-group" colspan="2"><div class="date-head"><span class="date-text">' + fmtDate(d.iso) + '</span><span class="date-sub">' + fmtDateFull(d.iso) + '</span><button type="button" class="date-sort-btn" data-sort-date="' + d.id + '" title="이 날짜 순위대로 회원 행 정렬">정렬</button>' + (isAdmin ? '<button class="date-del" data-del-date="' + d.id + '" title="이 날짜 삭제"><i class="fas fa-xmark"></i></button>' : '') + '</div></th>';
    });
    h += '</tr><tr class="date-sub-row">';
    _vd.visible.forEach(function (d) {
      h += '<th class="col-date col-score" data-col="date:' + d.id + '"' + wStyle('date:' + d.id) + '>' + escapeHtml(lostLabel()) + '<span class="col-resize" data-rz="date:' + d.id + '"></span></th>';
      h += '<th class="col-rank">순위</th>';
    });
    h += '</tr>';
    head.innerHTML = h;
  }

  // 모든 입력칸은 누구나 자유롭게 입력·수정 가능(잠금 없음).
  function inputCls(baseCls, hasValue) {
    return baseCls;
  }

  function renderBody() {
    var h = '';
    membersForDisplay().forEach(function (m, idx) {
      h += '<tr>';
      h += '<td class="cell-no">' + (idx + 1) + (isAdmin ? '<button class="row-del" data-del-member="' + m.id + '" title="이 회원 행 삭제"><i class="fas fa-xmark"></i></button>' : '') + '</td>';
      h += '<td class="cell-name" data-col="name"' + wStyle('name') + '><input type="text" maxlength="4" class="' + inputCls('name-input', !!m.name) + '" data-name="' + m.id + '" value="' + escapeHtml(m.name) + '" placeholder="이름4자" /></td>';
      h += '<td class="cell-total" data-average-member="' + m.id + '">' + fmtAverage(memberAverageScore(m.id)) + '</td>';
      if (_vd.hiddenCount > 0) h += '<td class="cell-fold" title="숨겨진 날짜"></td>';
      _vd.visible.forEach(function (d) {
        var val = state.cells[cellKey(m.id, d.id)];
        h += '<td class="cell-money" data-col="date:' + d.id + '"' + wStyle('date:' + d.id) + '><input type="text" inputmode="none" readonly maxlength="3" data-m="' + m.id + '" data-d="' + d.id + '" class="' + inputCls('money-input', !!val) + (val ? ' has-val' : '') + '" value="' + (val ? fmt(val) : '') + '" placeholder="0" aria-label="' + escapeHtml((m.name || '회원') + ' ' + fmtDateFull(d.iso) + ' 타수 입력') + '" /></td>';
        h += '<td class="cell-rank" data-rank-member="' + m.id + '" data-rank-date="' + d.id + '">' + (rankFor(m.id, d.id) || '') + '</td>';
      });
      h += '</tr>';
    });
    body.innerHTML = h;
  }

  function renderFoot() {
    var h = '<tr class="foot-winner-row"><td class="foot-label" colspan="2"><i class="fas fa-trophy"></i>날짜별 1등</td>';
    h += '<td class="foot-average foot-average-winner" data-average-winner="1">' + escapeHtml(averageWinnerName()) + '</td>';
    if (_vd.hiddenCount > 0) h += '<td class="foot-fold"></td>';
    _vd.visible.forEach(function (d) {
      h += '<td colspan="2" class="foot-winner" data-winner-date="' + d.id + '">' + escapeHtml(dateWinnerNames(d.id)) + '</td>';
    });
    h += '</tr>';

    var valueSpan = (_vd.hiddenCount > 0 ? 1 : 0) + (_vd.visible.length * 2);
    if (valueSpan < 1) valueSpan = 1;
    var total = baseTotalAmount();
    h += '<tr class="foot-extra-row foot-total-row"><td class="foot-extra-label" colspan="3"><i class="fas fa-coins"></i>총액</td><td colspan="' + valueSpan + '" class="foot-extra-cell foot-total-cell"><input type="text" inputmode="numeric" pattern="[0-9]*" class="extra-input total-input has-val' + (isAdmin ? '' : ' locked') + '" data-total-amount="1" value="' + fmt(total) + '" placeholder="0"' + (isAdmin ? '' : ' readonly aria-readonly="true"') + ' /></td></tr>';

    h += '<tr class="foot-extra-row foot-expense-row"><td class="foot-extra-label" colspan="3"><i class="fas fa-money-bill-wave"></i>날짜별 지출</td>';
    if (_vd.hiddenCount > 0) h += '<td class="foot-extra-filler"></td>';
    _vd.visible.forEach(function (d) {
      var ex = expenseFor(d.id);
      h += '<td colspan="2" class="foot-extra-cell foot-date-value"><input type="text" inputmode="none" readonly class="extra-input' + (ex ? ' has-val' : '') + (isAdmin ? '' : ' locked') + '" data-expense-date="' + d.id + '" value="' + (ex ? fmt(ex) : '') + '" placeholder="0"' + (isAdmin ? '' : ' aria-readonly="true"') + ' /></td>';
    });
    h += '</tr>';

    h += '<tr class="foot-extra-row foot-balance-row"><td class="foot-extra-label" colspan="3"><i class="fas fa-wallet"></i>날짜별 잔액</td>';
    if (_vd.hiddenCount > 0) h += '<td class="foot-extra-filler"></td>';
    _vd.visible.forEach(function (d) {
      var balance = balanceFor(d.id);
      h += '<td colspan="2" class="foot-extra-cell foot-balance-cell foot-date-value' + (balance < 0 ? ' neg' : '') + '" data-balance-date="' + d.id + '">' + fmt(balance) + '</td>';
    });
    h += '</tr>';
    foot.innerHTML = h;
  }
  function applyWidths() {
    var narrow = isNarrow();
    Object.keys(state.widths).forEach(function (key) {
      var w = state.widths[key];
      var els = document.querySelectorAll('[data-col="' + key.replace(/"/g, '') + '"]');
      // ★좁은 화면(모바일)에서는 저장폭을 "모든 컬럼"에 대해 적용하지 않고 인라인 스타일을
      //  제거해 CSS(:root/미디어쿼리)의 좁은 고정폭이 그대로 먹도록 한다. 이게 예전에 크게
      //  늘려둔 폭 때문에 표가 화면을 넘치던 문제의 근본 해결이다.
      if (narrow) {
        els.forEach(function (el) { el.style.width = ''; el.style.minWidth = ''; });
        return;
      }
      els.forEach(function (el) { el.style.width = w + 'px'; el.style.minWidth = w + 'px'; });
    });
  }

  function refreshTotals() {
    state.members.forEach(function (m) {
      state.dates.forEach(function (d) {
        var el = body.querySelector('[data-rank-member="' + m.id + '"][data-rank-date="' + d.id + '"]');
        if (el) el.textContent = rankFor(m.id, d.id) || '';
      });
      var average = body.querySelector('[data-average-member="' + m.id + '"]');
      if (average) average.textContent = fmtAverage(memberAverageScore(m.id));
    });
    state.dates.forEach(function (d) {
      var winner = foot.querySelector('[data-winner-date="' + d.id + '"]');
      if (winner) winner.textContent = dateWinnerNames(d.id);
    });
    var averageWinner = foot.querySelector('[data-average-winner]');
    if (averageWinner) averageWinner.textContent = averageWinnerName();
    var g = foot.querySelector('[data-total-amount]'); if (g && document.activeElement !== g) g.value = fmt(baseTotalAmount());
    refreshBalance();
  }

  function findMember(id) { for (var i = 0; i < state.members.length; i++) if (state.members[i].id === id) return state.members[i]; return null; }
  function findDate(id) { for (var i = 0; i < state.dates.length; i++) if (state.dates[i].id === id) return state.dates[i]; return null; }

  head.addEventListener('click', function (e) {
    var averageSortButton = e.target.closest('[data-sort-average]');
    var dateSortButton = e.target.closest('[data-sort-date]');
    if (!averageSortButton && !dateSortButton) return;
    memberSortMode = dateSortButton
      ? { type: 'date', dateId: dateSortButton.getAttribute('data-sort-date') }
      : { type: 'average', dateId: '' };
    renderBody();
    applyWidths();
    var tableWrap = document.getElementById('table-wrap');
    if (tableWrap) tableWrap.scrollTop = 0;
  });
  // ---------- 입력 ----------
  // 타수는 빠른 숫자판의 완료 버튼에서만 저장하고, 여기서는 회원 이름만 처리한다.
  body.addEventListener('input', function (e) {
    var t = e.target;
    if (t.matches('.name-input')) {
      if (!isAdmin && !t.value.trim() && (t.dataset.originalValue || '').trim()) {
        t.value = t.dataset.originalValue;
        alert('기존 회원 이름 삭제는 관리자만 할 수 있습니다.');
        return;
      }
      var m1 = findMember(t.getAttribute('data-name'));
      if (m1) { m1.name = t.value; save(); }
    }
  });
  // 잔액(자동 계산: 총액 - 해당 날짜까지의 누적 지출)을 실시간 갱신 (표 안 tfoot 셀)
  function refreshBalance() {
    state.dates.forEach(function (d) {
      var el = foot.querySelector('[data-balance-date="' + d.id + '"]');
      if (!el) return;
      var balance = balanceFor(d.id);
      el.textContent = fmt(balance);
      el.classList.toggle('neg', balance < 0);
    });
  }
  // ============================================================
  //  총액·날짜별 지출 입력 — 관리자만 입력·수정 가능
  //  ★★모바일 키패드 사라짐 방지 (표에 이어붙인 상태에서도 안정) ★★
  //   입력칸은 render 때마다 새로 생성되므로, 특정 엘리먼트가 아니라 foot(tfoot)에
  //   "이벤트 위임"으로 바인딩한다(엘리먼트가 파괴돼도 리스너가 살아있음).
  //   1) 입력 중에는 서버 저장을 걸지 않음 → 409/applyServerData→render 연쇄 없음(DOM 안 갈아엎음)
  //   2) 입력 중 render 는 pendingServerData 로 미룸(isEditing 방어) → 입력칸 파괴 안 됨
  //   3) 실시간 천단위 콤마 + 커서 보정
  var expensePad = document.getElementById('expense-quick-pad');
  var expenseQuickCur = document.getElementById('expense-quick-cur');
  var expenseQuickLabel = document.getElementById('expense-quick-label');
  var expenseTarget = null;
  var expenseDraft = '';
  var expenseReplaceOnNextDigit = true;

  function savedExpenseValue(t) {
    return t ? expenseFor(t.getAttribute('data-expense-date')) : 0;
  }
  function updateExpenseQuickPreview() {
    if (!expenseTarget) return;
    var value = parseNum(expenseDraft);
    expenseTarget.value = value ? fmt(value) : '';
    expenseTarget.classList.toggle('has-val', !!value);
    expenseQuickCur.textContent = value ? fmt(value) : '0';
  }
  function keepExpenseTargetVisible(t) {
    var wrap = document.getElementById('table-wrap');
    if (!wrap || window.innerWidth > 900) return;
    var r = t.getBoundingClientRect();
    var openAreaRight = window.innerWidth - expensePad.offsetWidth - 18;
    if (r.right > openAreaRight) wrap.scrollLeft += (r.right - openAreaRight + 8);
  }  function positionExpenseQuickPad(t) {
    if (!t || expensePad.classList.contains('hidden')) return;
    var r = t.getBoundingClientRect();
    var padH = expensePad.offsetHeight || 230;
    var header = document.getElementById('app-header');
    var minTop = header ? Math.ceil(header.getBoundingClientRect().bottom + 6) : 8;
    var maxTop = Math.max(minTop, window.innerHeight - padH - 8);
    var top = Math.max(minTop, Math.min(maxTop, r.top + (r.height / 2) - (padH / 2)));
    expensePad.style.left = 'auto';
    expensePad.style.right = '8px';
    expensePad.style.top = top + 'px';
  }
  function openExpenseQuickPad(t) {
    if (!isAdmin || !t) return;
    if (qpTarget) closeQuickPad(false);
    if (expenseTarget && expenseTarget !== t) closeExpenseQuickPad(false);
    expenseTarget = t;
    var current = savedExpenseValue(t);
    expenseDraft = current ? String(current) : '';
    expenseReplaceOnNextDigit = true;
    var date = findDate(t.getAttribute('data-expense-date'));
    expenseQuickLabel.textContent = (date ? fmtDateFull(date.iso) : '날짜') + ' · 지출';
    expensePad.classList.remove('hidden');
    keepExpenseTargetVisible(t);
    positionExpenseQuickPad(t);
    updateExpenseQuickPreview();
  }
  function enterExpensePreset(value) {
    if (!expenseTarget) return;
    expenseDraft = String(Math.max(0, Number(value) || 0));
    expenseReplaceOnNextDigit = true;
    updateExpenseQuickPreview();
  }
  function enterExpenseDigit(digit) {
    if (!expenseTarget || !/^[0-9]$/.test(String(digit))) return;
    var next = expenseReplaceOnNextDigit ? String(digit) : (expenseDraft + String(digit));
    expenseReplaceOnNextDigit = false;
    expenseDraft = next.replace(/^0+(?=\d)/, '').slice(0, 9);
    updateExpenseQuickPreview();
  }
  function clearExpenseDraft() {
    if (!expenseTarget) return;
    expenseDraft = '';
    expenseReplaceOnNextDigit = true;
    updateExpenseQuickPreview();
  }
  function closeExpenseQuickPad(committed) {
    if (expenseTarget && !committed) {
      var original = savedExpenseValue(expenseTarget);
      expenseTarget.value = original ? fmt(original) : '';
      expenseTarget.classList.toggle('has-val', !!original);
    }
    expensePad.classList.add('hidden');
    expenseTarget = null;
    expenseDraft = '';
    expenseReplaceOnNextDigit = true;
  }
  function completeExpenseQuickPad() {
    if (!expenseTarget || !isAdmin) return;
    var target = expenseTarget;
    var dateId = target.getAttribute('data-expense-date');
    var previous = savedExpenseValue(target);
    var value = Math.max(0, parseNum(expenseDraft));
    if (value !== previous) {
      if (!state.extra) state.extra = { expenses: {} };
      if (!state.extra.expenses) state.extra.expenses = {};
      if (value) state.extra.expenses[dateId] = value; else delete state.extra.expenses[dateId];
      delete state.extra.legacyExpense;
      queueExtraEdit('expense|' + dateId, value, true);
      saveLocal();
      scheduleServerSave();
    } else {
      showInputToast('입력되었습니다');
    }
    closeExpenseQuickPad(true);
    target.value = value ? fmt(value) : '';
    target.classList.toggle('has-val', !!value);
    refreshBalance();
  }

  expensePad.addEventListener('mousedown', function (e) { e.preventDefault(); });
  expensePad.addEventListener('click', function (e) {
    var preset = e.target.closest('[data-expense-value]');
    if (preset) enterExpensePreset(preset.getAttribute('data-expense-value'));
    else if (e.target.closest('[data-expense-clear]')) clearExpenseDraft();
    else if (e.target.closest('[data-expense-done]')) completeExpenseQuickPad();
  });
  document.addEventListener('mousedown', function (e) {
    if (expensePad.classList.contains('hidden')) return;
    if (e.target.closest('#expense-quick-pad')) return;
    if (expenseTarget && e.target === expenseTarget) return;
    closeExpenseQuickPad(false);
  });

  foot.addEventListener('focus', function (e) {
    var t = e.target; if (!t.matches('.extra-input') || !isAdmin) return;
    t.dataset.originalValue = t.value;
    if (t.hasAttribute('data-expense-date')) {
      openExpenseQuickPad(t);
      return;
    }
    setTimeout(function () { try { t.select(); } catch (x) {} }, 0);
  }, true);
  foot.addEventListener('input', function (e) {
    var t = e.target; if (!t.matches('.extra-input') || !isAdmin) return;
    if (t.hasAttribute('data-expense-date')) {
      expenseDraft = String(parseNum(t.value) || '');
      expenseReplaceOnNextDigit = false;
      updateExpenseQuickPreview();
      return;
    }
    var num = Math.max(0, parseNum(t.value));
    if (!state.extra) state.extra = { expenses: {} };
    state.extra.total = num;
    t.classList.toggle('has-val', !!num);
    var before = t.value;
    var caret = t.selectionStart == null ? before.length : t.selectionStart;
    var digitsBeforeCaret = before.slice(0, caret).replace(/[^\d]/g, '').length;
    var formatted = num ? fmt(num) : '';
    t.value = formatted;
    var pos = 0, seen = 0;
    while (pos < formatted.length && seen < digitsBeforeCaret) {
      if (/\d/.test(formatted[pos])) seen++;
      pos++;
    }
    try { t.setSelectionRange(pos, pos); } catch (x) {}
    refreshBalance();
    saveLocal();
  });
  foot.addEventListener('keydown', function (e) {
    var t = e.target; if (!t.matches('[data-expense-date]') || !isAdmin) return;
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); enterExpenseDigit(e.key); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); clearExpenseDraft(); }
    else if (e.key === 'Enter') { e.preventDefault(); completeExpenseQuickPad(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeExpenseQuickPad(false); }
  });
  foot.addEventListener('blur', function (e) {
    var t = e.target; if (!t.matches('.extra-input') || !isAdmin) return;
    if (t.hasAttribute('data-expense-date')) {
      setTimeout(function () {
        if (expenseTarget === t && document.activeElement !== t) closeExpenseQuickPad(false);
      }, 0);
      return;
    }
    var num = parseNum(t.value);
    var original = parseNum(t.dataset.originalValue);
    t.value = num ? fmt(num) : '';
    if (num !== original) {
      queueExtraEdit('total', num, false);
      scheduleServerSave();
    }
    setTimeout(flushPendingServerData, 50);
  }, true);
  window.addEventListener('resize', function () {
    if (expenseTarget) positionExpenseQuickPad(expenseTarget);
  });
  body.addEventListener('focus', function (e) {
    var t = e.target;
    if (t.matches('.name-input, .money-input')) t.dataset.originalValue = t.value;
    if (!t.matches('.money-input')) return;
    var num = parseNum(t.value); t.value = num ? String(num) : '';
    setTimeout(function () { try { t.select(); } catch (x) {} }, 0);
    openQuickPad(t); // 자주 쓰는 타수 빠른입력 도우미 표시
  }, true);
  body.addEventListener('blur', function (e) {
    var t = e.target; if (!t.matches('.money-input')) return;
    var num = parseNum(t.value); t.value = num ? fmt(num) : '';
    renderBody(); applyWidths();
    setTimeout(flushPendingServerData, 50);
  }, true);
  // 이름/타수 입력칸 등에서도 포커스 해제되면 미뤄둔 데이터 반영
  body.addEventListener('focusout', function () { setTimeout(flushPendingServerData, 100); });

  // PC 키보드도 숫자판과 같은 임시 입력 규칙을 사용한다. Enter=완료, Esc=취소.
  body.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t.matches('.money-input')) {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); enterQuickDigit(e.key); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); clearQuickDraft(); }
      else if (e.key === 'Enter') { e.preventDefault(); completeQuickPad(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeQuickPad(false); }
      return;
    }
    if (e.key !== 'Enter' || !t.matches('.name-input')) return;
    e.preventDefault();
    var id = t.getAttribute('data-name');
    var idx = -1;
    for (var i = 0; i < state.members.length; i++) if (state.members[i].id === id) { idx = i; break; }
    if (idx === -1) return;
    if (idx === state.members.length - 1) {
      state.members.push({ id: uid(), name: '' });
      save(); render();
    }
    var rows = body.querySelectorAll('tr');
    var next = rows[idx + 1];
    var el = next && next.querySelector('.name-input');
    if (el) { el.focus(); try { el.select(); } catch (x) {} }
  });

  // ---------- 자주 쓰는 타수 빠른입력 도우미 ----------
  var quickPad = document.getElementById('quick-pad');
  var quickCur = document.getElementById('quick-cur');
  var quickLabel = document.getElementById('quick-label');
  inputToast = document.getElementById('input-toast');
  var qpTarget = null;
  var qpDraft = '';
  var qpReplaceOnNextDigit = true;

  function qpCanEdit() { return true; }

  function savedQuickValue(t) {
    if (!t) return 0;
    return Number(state.cells[cellKey(t.getAttribute('data-m'), t.getAttribute('data-d'))]) || 0;
  }

  function updateQuickPreview() {
    if (!qpTarget) return;
    var display = qpDraft || '0';
    qpTarget.value = qpDraft;
    qpTarget.classList.toggle('has-val', !!parseNum(qpDraft));
    quickCur.textContent = display;
  }

  function keepTargetVisibleBesidePad(t) {
    var wrap = document.getElementById('table-wrap');
    if (!wrap || window.innerWidth > 900) return;
    var r = t.getBoundingClientRect();
    var openAreaRight = window.innerWidth - quickPad.offsetWidth - 18;
    if (r.right > openAreaRight) wrap.scrollLeft += (r.right - openAreaRight + 8);
  }

  function openQuickPad(t) {
    if (!qpCanEdit(t)) return;
    if (expenseTarget) closeExpenseQuickPad(false);
    if (qpTarget && qpTarget !== t) closeQuickPad(false);
    qpTarget = t;
    var current = savedQuickValue(t);
    qpDraft = current ? String(current) : '';
    qpReplaceOnNextDigit = true;
    var member = findMember(t.getAttribute('data-m'));
    var date = findDate(t.getAttribute('data-d'));
    quickLabel.textContent = ((member && member.name) || '이름 없음') + ' · ' + (date ? fmtDateFull(date.iso) : '날짜');
    quickPad.classList.remove('hidden');
    keepTargetVisibleBesidePad(t);
    positionQuickPad(t);
    updateQuickPreview();
  }

  function positionQuickPad(t) {
    if (!t || quickPad.classList.contains('hidden')) return;
    var r = t.getBoundingClientRect();
    var padH = quickPad.offsetHeight || 250;
    var header = document.getElementById('app-header');
    var minTop = header ? Math.ceil(header.getBoundingClientRect().bottom + 6) : 8;
    var maxTop = Math.max(minTop, window.innerHeight - padH - 8);
    var top = Math.max(minTop, Math.min(maxTop, r.top + (r.height / 2) - (padH / 2)));
    quickPad.style.left = 'auto';
    quickPad.style.right = '8px';
    quickPad.style.top = top + 'px';
  }

  function enterQuickDigit(digit) {
    if (!qpTarget || !/^[0-9]$/.test(String(digit))) return;
    var next = qpReplaceOnNextDigit ? String(digit) : (qpDraft + String(digit));
    qpReplaceOnNextDigit = false;
    next = next.replace(/^0+(?=\d)/, '').slice(0, 3);
    if ((Number(next) || 0) > MAX_SCORE) next = String(MAX_SCORE);
    qpDraft = next;
    updateQuickPreview();
  }

  function enterQuickScore(score) {
    if (!qpTarget) return;
    var value = Math.min(MAX_SCORE, Math.max(0, Number(score) || 0));
    qpDraft = value ? String(value) : '';
    qpReplaceOnNextDigit = true;
    updateQuickPreview();
  }

  function clearQuickDraft() {
    if (!qpTarget) return;
    qpDraft = '';
    qpReplaceOnNextDigit = true;
    updateQuickPreview();
  }

  function closeQuickPad(committed) {
    if (qpTarget && !committed) {
      var original = savedQuickValue(qpTarget);
      qpTarget.value = original ? fmt(original) : '';
      qpTarget.classList.toggle('has-val', !!original);
    }
    quickPad.classList.add('hidden');
    qpTarget = null;
    qpDraft = '';
    qpReplaceOnNextDigit = true;
  }

  function scoreEditExpiredForUser(key, previous) {
    if (isAdmin || !previous) return false;
    var editedAt = Number(state.editTimes && state.editTimes[key]) || 0;
    return !editedAt || Date.now() - editedAt >= (24 * 60 * 60 * 1000);
  }
  function completeQuickPad() {
    if (!qpTarget) return;
    var target = qpTarget;
    var key = cellKey(target.getAttribute('data-m'), target.getAttribute('data-d'));
    var previous = Number(state.cells[key]) || 0;
    var value = Math.min(MAX_SCORE, Math.max(0, parseNum(qpDraft)));

    if (value !== previous && scoreEditExpiredForUser(key, previous)) {
      alert('입력 후 24시간이 지난 타수는 관리자 모드에서만 수정할 수 있습니다.');
      qpDraft = String(previous);
      qpReplaceOnNextDigit = true;
      updateQuickPreview();
      return;
    }
    if (value !== previous) {
      if (value) state.cells[key] = value; else delete state.cells[key];
      queueCellEdit(key, value, previous);
      saveLocal();
      scheduleServerSave();
    } else {
      showInputToast('입력되었습니다');
    }
    closeQuickPad(true);
    renderBody();
    applyWidths();
    refreshTotals();
  }

  quickPad.addEventListener('mousedown', function (e) { e.preventDefault(); });
  quickPad.addEventListener('click', function (e) {
    var score = e.target.closest('[data-score]');
    var clear = e.target.closest('[data-clear]');
    var done = e.target.closest('.qp-done');
    if (score) enterQuickScore(score.getAttribute('data-score'));
    else if (clear) clearQuickDraft();
    else if (done) completeQuickPad();
  });
  // 숫자판 밖을 누르면 임시값을 취소한다. 완료를 눌러야만 저장된다.
  document.addEventListener('mousedown', function (e) {
    if (quickPad.classList.contains('hidden')) return;
    if (e.target.closest('#quick-pad')) return;
    if (e.target.closest('.money-input')) return;
    closeQuickPad(false);
  });
  var resizeReRenderTimer = null;
  window.addEventListener('resize', function () {
    if (qpTarget) positionQuickPad(qpTarget);
    syncHeaderWidth(); syncStickyHeaderOffsets();
    // 화면 폭이 바뀌면 접힘 개수도 달라지므로 다시 렌더(입력 중이면 건너뜀)
    if (resizeReRenderTimer) clearTimeout(resizeReRenderTimer);
    resizeReRenderTimer = setTimeout(function () {
      var ae = document.activeElement;
      if (ae && (ae.classList && (ae.classList.contains('name-input') || ae.classList.contains('money-input')))) return;
      // 폭이 바뀌면 좁은화면 판정도 달라질 수 있으므로 항상 다시 렌더
      render();
    }, 250);
  });
  // 표를 가로로 스크롤하면 상단 헤더도 같은 위치로 스크롤 → 버튼이 표 위를 따라감
  var tableWrapEl = document.getElementById('table-wrap');
  var appHeaderEl = document.getElementById('app-header');
  tableWrapEl.addEventListener('scroll', function () {
    if (qpTarget) positionQuickPad(qpTarget);
    if (appHeaderEl) appHeaderEl.scrollLeft = tableWrapEl.scrollLeft;
  });
  // 헤더를 직접 스크롤해도 표가 같이 움직이도록(양방향 동기화)
  if (appHeaderEl) {
    appHeaderEl.addEventListener('scroll', function () {
      tableWrapEl.scrollLeft = appHeaderEl.scrollLeft;
    });
  }

  // ---------- 회원/날짜 삭제 ----------
  body.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del-member]'); if (!del) return;
    if (!isAdmin || !adminToken) { alert('회원 삭제는 관리자만 할 수 있습니다.'); return; }
    var id = del.getAttribute('data-del-member'); var m = findMember(id);
    var label = (m && m.name) ? ('"' + m.name + '"') : '이';
    if (confirm(label + ' 회원 행을 삭제할까요?')) {
      state.members = state.members.filter(function (x) { return x.id !== id; });
      Object.keys(state.cells).forEach(function (k) { if (k.split('|')[0] === id) delete state.cells[k]; });
      save(); render();
    }
  });
  // 접힘 열('···+N일') 클릭 → 전체 날짜 펼쳐보기(15초 후 자동 복귀)
  head.addEventListener('click', function (e) {
    if (e.target.closest('.col-fold')) { expandAllTemporarily(); }
  });
  body.addEventListener('click', function (e) {
    if (e.target.closest('.cell-fold')) { expandAllTemporarily(); }
  });

  head.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del-date]'); if (!del) return;
    if (!isAdmin || !adminToken) { alert('날짜 삭제는 관리자만 할 수 있습니다.'); return; }
    var id = del.getAttribute('data-del-date'); var d = null;
    for (var i = 0; i < state.dates.length; i++) if (state.dates[i].id === id) d = state.dates[i];
    if (d && confirm('"' + fmtDateFull(d.iso) + '" 날짜 열을 삭제할까요? 해당 타수도 삭제됩니다.')) {
      state.dates = state.dates.filter(function (x) { return x.id !== id; });
      Object.keys(state.cells).forEach(function (k) { if (k.split('|')[1] === id) delete state.cells[k]; });
      delete state.widths['date:' + id];
      save(); render();
    }
  });

  // ---------- 회원/날짜 추가 ----------
  document.getElementById('btn-add-member').addEventListener('click', function () {
    state.members.push({ id: uid(), name: '' }); save(); render();
    var inputs = body.querySelectorAll('.name-input'); if (inputs.length) inputs[inputs.length - 1].focus();
  });
  // 선택한 날짜(iso: YYYY-MM-DD)를 실제로 표에 추가
  function addDateColumn(iso) {
    if (!iso) return;
    // 같은 날짜가 이미 있으면 중복 추가하지 않음
    for (var i = 0; i < state.dates.length; i++) {
      if (state.dates[i].iso === iso) {
        alert('이미 추가된 날짜입니다: ' + fmtDateFull(iso));
        return;
      }
    }
    var newId = uid();
    // 새 날짜 열은 "직전 날짜 열과 같은 너비"로 생성 (사용자가 조절한 폭을 그대로 상속)
    if (state.dates.length) {
      var lastDate = state.dates[state.dates.length - 1];
      var lastW = state.widths['date:' + lastDate.id];
      if (lastW) state.widths['date:' + newId] = lastW;
    }
    state.dates.push({ id: newId, iso: iso });
    state.dates.sort(function (a, b) { return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0; });
    save(); render();
    // 접기 상태면 최근 날짜가 이미 화면에 보이므로 왼쪽(0) 유지,
    // 펼침 상태면 오른쪽 끝(새 날짜)으로 스크롤
    document.getElementById('table-wrap').scrollLeft = collapseEnabled ? 0 : 99999;
  }

  // 날짜추가 버튼 → 브라우저 기본 달력(캘린더)을 바로 띄움
  var datePicker = document.getElementById('date-picker');
  document.getElementById('btn-add-date').addEventListener('click', function () {
    datePicker.value = todayIso(); // 오늘 날짜에서 시작
    // showPicker(): 최신 브라우저에서 달력을 즉시 표시
    if (typeof datePicker.showPicker === 'function') {
      try { datePicker.showPicker(); return; } catch (e) {}
    }
    // 폴백: 포커스 후 클릭(구형 브라우저)
    datePicker.focus(); datePicker.click();
  });
  // 달력에서 날짜를 클릭(선택)하면 즉시 열 추가
  datePicker.addEventListener('change', function () {
    var iso = datePicker.value; // 이미 YYYY-MM-DD 형식
    datePicker.value = '';
    addDateColumn(iso);
  });

  // ---------- 초기화(=전체 펼쳐보기) ----------
  // 버튼을 누르면 접혀 있던 모든 날짜를 펼쳐 보여주고, 약 15초 후 원래(접힘) 상태로 복귀.
  var EXPAND_SECONDS = 15;
  function expandAllTemporarily() {
    collapseEnabled = false;      // 접기 해제 → 전체 표시
    if (expandTimer) clearTimeout(expandTimer);
    render();
    document.getElementById('table-wrap').scrollLeft = 0; // 처음(오래된 날짜)부터 보이게
    showExpandNotice(EXPAND_SECONDS);
    expandTimer = setTimeout(function () {
      collapseEnabled = true;     // 다시 접힘
      expandTimer = null;
      render();
      hideExpandNotice();
    }, EXPAND_SECONDS * 1000);
  }
  // 펼침 상태 안내 배너 + 남은 초 카운트다운
  var noticeTimer = null;
  function showExpandNotice(sec) {
    var banner = document.getElementById('mode-banner');
    if (!banner) return;
    banner.dataset.prev = banner.dataset.prev || banner.innerHTML;
    var left = sec;
    function paint() {
      banner.className = 'mode-banner mode-expand';
      banner.innerHTML = '<i class="fas fa-eye"></i><span class="mode-banner-text">전체 날짜를 펼쳐 보는 중 · <b>' + left + '초</b> 후 자동으로 접힙니다 · <button id="collapse-now" class="banner-btn">지금 접기</button></span>';
    }
    paint();
    if (noticeTimer) clearInterval(noticeTimer);
    noticeTimer = setInterval(function () {
      left--; if (left <= 0) { clearInterval(noticeTimer); noticeTimer = null; return; }
      paint();
    }, 1000);
  }
  function hideExpandNotice() {
    if (noticeTimer) { clearInterval(noticeTimer); noticeTimer = null; }
    updateAdminBtn(); // 배너를 원래(모드) 문구로 복원
  }
  // '지금 접기' 버튼(배너 안) 클릭
  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'collapse-now') {
      if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
      collapseEnabled = true; render(); hideExpandNotice();
    }
  });

  document.getElementById('btn-clear').addEventListener('click', expandAllTemporarily);

  // 관리자 전용: 정산표 완전 초기화(데이터 삭제)는 관리자 화면에서 수행
  function fullReset() {
    if (!isAdmin || !adminToken) { alert('초기화는 관리자만 할 수 있습니다.'); return; }
    if (confirm('정산표(회원/날짜/타수)를 완전히 초기화할까요?\n※ R2 자료실 이미지는 유지됩니다.')) {
      state.members = makeDefaultMembers();
      state.dates = makeDefaultDates();
      state.cells = {}; state.manager = { name: '' }; state.widths = {};
      state.labels = defaultLabels();
      state.extra = { expenses: {} };
      collapseEnabled = true;
      save(); render();
    }
  }

  // ---------- CSV ----------
  function exportCsv() {
    var rows = [];
    var header = ['No', '회원 이름', '평균타수'];
    state.dates.forEach(function (d) { header.push(fmtDateFull(d.iso) + ' 타수'); header.push(fmtDateFull(d.iso) + ' 순위'); });
    rows.push(header);
    membersByAverage().forEach(function (m, i) {
      var row = [i + 1, m.name || '', fmtAverage(memberAverageScore(m.id))];
      state.dates.forEach(function (d) { row.push(state.cells[cellKey(m.id, d.id)] || 0); row.push(rankFor(m.id, d.id) || ''); });
      rows.push(row);
    });
    var winnerRow = ['', '날짜별 1등', averageWinnerName()];
    state.dates.forEach(function (d) { winnerRow.push(dateBestScore(d.id) || ''); winnerRow.push(dateWinnerNames(d.id)); });
    rows.push(winnerRow);
    var span = state.dates.length * 2;
    var totalRow = ['', '총액', '']; for (var i = 0; i < span - 1; i++) totalRow.push(''); totalRow.push(baseTotalAmount()); rows.push(totalRow);
    var expRow = ['', '날짜별 지출', '']; state.dates.forEach(function (d) { expRow.push(expenseFor(d.id)); expRow.push(''); }); rows.push(expRow);
    var balRow = ['', '날짜별 잔액', '']; state.dates.forEach(function (d) { balRow.push(balanceFor(d.id)); balRow.push(''); }); rows.push(balRow);
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        var v = String(c == null ? '' : c);
        return v.includes(',') || v.includes('"') || v.includes(String.fromCharCode(10)) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join(String.fromCharCode(10));
    var blob = new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, '사보회_' + todayIso() + '.csv');
  }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  document.getElementById('btn-export').addEventListener('click', exportCsv);

  // ---------- 컬럼 리사이즈 (마우스 + 터치) ----------
  // ★모바일(좁은 화면)에서는 드래그 리사이즈를 비활성화한다. 좁은 화면에서 손가락 드래그로
  //  컬럼을 늘리면 표가 화면을 넘쳐 다른 컬럼이 잘리는 불안정 문제가 있었다. 모바일은 항상
  //  화면에 맞는 안정적인 고정폭을 유지하고, 리사이즈는 PC(넓은 화면) 전용으로 둔다.
  var rz = null;
  function startResize(key, startX, thEl) {
    if (isNarrow()) return; // 모바일에서는 리사이즈 금지
    rz = { key: key, startX: startX, startW: thEl.getBoundingClientRect().width };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }
  function moveResize(x) {
    if (!rz) return;
    var w = Math.max(40, Math.round(rz.startW + (x - rz.startX)));
    state.widths[rz.key] = w;
    document.querySelectorAll('[data-col="' + rz.key + '"]').forEach(function (el) { el.style.width = w + 'px'; el.style.minWidth = w + 'px'; });
  }
  function endResize() { if (rz) { rz = null; document.body.style.userSelect = ''; document.body.style.cursor = ''; save(); syncHeaderWidth(); } }

  head.addEventListener('mousedown', function (e) {
    var handle = e.target.closest('.col-resize'); if (!handle) return;
    e.preventDefault();
    startResize(handle.getAttribute('data-rz'), e.clientX, handle.closest('th'));
  });
  document.addEventListener('mousemove', function (e) { if (rz) moveResize(e.clientX); });
  document.addEventListener('mouseup', endResize);

  head.addEventListener('touchstart', function (e) {
    var handle = e.target.closest('.col-resize'); if (!handle) return;
    var t = e.touches[0];
    startResize(handle.getAttribute('data-rz'), t.clientX, handle.closest('th'));
  }, { passive: true });
  document.addEventListener('touchmove', function (e) { if (rz) { moveResize(e.touches[0].clientX); e.preventDefault(); } }, { passive: false });
  document.addEventListener('touchend', endResize);

  // ============================================================
  //  관리자 모드
  // ============================================================
  var loginModal = document.getElementById('login-modal');
  var loginId = document.getElementById('login-id');
  var loginPw = document.getElementById('login-pw');
  var loginError = document.getElementById('login-error');
  var viewSheet = document.getElementById('view-sheet');
  var viewAdmin = document.getElementById('view-admin');

  var btnAdmin = document.getElementById('btn-admin');
  var loginOk = document.getElementById('login-ok');
  var authExpiryAlertShown = false;

  function adminHeaders(extra) {
    var headers = {};
    Object.keys(extra || {}).forEach(function (key) { headers[key] = extra[key]; });
    if (adminToken) headers.Authorization = 'Bearer ' + adminToken;
    return headers;
  }

  function endAdminSession(showMessage) {
    isAdmin = false;
    adminToken = '';
    if (expenseTarget) closeExpenseQuickPad(false);
    if (qpTarget) closeQuickPad(false);
    updateAdminBtn();
    if (viewAdmin && !viewAdmin.classList.contains('hidden')) closeAdmin();
    else render();
    if (showMessage) alert('관리자 인증이 만료되었습니다. 다시 로그인해 주세요.');
  }

  function handleAdminExpired() {
    if (authExpiryAlertShown) return;
    authExpiryAlertShown = true;
    endAdminSession(true);
  }

  function updateAdminBtn() {
    btnAdmin.innerHTML = isAdmin
      ? '<i class="fas fa-lock-open"></i><span class="btn-text"> 관리자ON</span>'
      : '<i class="fas fa-user-shield"></i><span class="btn-text"> 관리자</span>';
    btnAdmin.classList.toggle('admin-on', isAdmin);
    var banner = document.getElementById('mode-banner');
    if (banner) {
      if (isAdmin) {
        banner.className = 'mode-banner mode-admin';
        banner.innerHTML = '<i class="fas fa-lock-open"></i><span class="mode-banner-text">관리자 모드 · 모든 값을 <b>수정·삭제</b>할 수 있습니다</span>';
      } else {
        banner.className = 'mode-banner mode-user';
        banner.innerHTML = '<i class="fas fa-pen"></i><span class="mode-banner-text">일반 사용자 모드 · 타수는 입력 후 <b>24시간 안에 수정·지움</b>할 수 있습니다. 이후 수정·삭제와 총액·날짜별 지출은 관리자만 가능합니다.</span>';
      }
    }
  }

  btnAdmin.addEventListener('click', function () {
    if (isAdmin) { openAdmin(); return; }
    loginError.classList.add('hidden'); loginId.value = ''; loginPw.value = '';
    loginModal.classList.remove('hidden');
    setTimeout(function () { loginId.focus(); }, 50);
  });
  document.getElementById('login-cancel').addEventListener('click', function () { loginModal.classList.add('hidden'); });
  loginModal.addEventListener('click', function (e) { if (e.target === loginModal) loginModal.classList.add('hidden'); });
  function tryLogin() {
    var username = loginId.value.trim();
    var password = loginPw.value;
    if (!username || !password) { loginError.textContent = '아이디와 비밀번호를 입력해 주세요.'; loginError.classList.remove('hidden'); return; }
    loginError.classList.add('hidden');
    loginOk.disabled = true;
    loginOk.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 확인 중…';
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, d: d }; });
    }).then(function (res) {
      if (res.status === 200 && res.d && res.d.token) {
        isAdmin = true;
        adminToken = res.d.token;
        authExpiryAlertShown = false;
        loginPw.value = '';
        loginModal.classList.add('hidden');
        updateAdminBtn(); render(); openAdmin();
        return;
      }
      loginError.textContent = res.status === 429
        ? '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.'
        : '아이디 또는 비밀번호가 올바르지 않습니다.';
      loginError.classList.remove('hidden');
    }).catch(function () {
      loginError.textContent = '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      loginError.classList.remove('hidden');
    }).then(function () {
      loginOk.disabled = false;
      loginOk.textContent = '로그인';
    });
  }
  loginOk.addEventListener('click', tryLogin);
  loginPw.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryLogin(); });
  loginId.addEventListener('keydown', function (e) { if (e.key === 'Enter') loginPw.focus(); });

  function openAdmin() {
    if (!isAdmin || !adminToken) { endAdminSession(false); return; }
    viewSheet.classList.add('hidden'); viewAdmin.classList.remove('hidden'); renderAdmin();
  }
  function closeAdmin() { viewAdmin.classList.add('hidden'); viewSheet.classList.remove('hidden'); render(); }
  document.getElementById('btn-admin-close').addEventListener('click', closeAdmin);

  // 관리자 로그아웃
  document.getElementById('btn-logout').addEventListener('click', function () {
    endAdminSession(false);
    alert('관리자 모드를 종료했습니다. 타수는 입력 후 24시간 안에만 수정·지움할 수 있습니다.');
  });

  function updateAssetCount() {
    var el = document.getElementById('asset-count-num');
    if (el) el.textContent = assetsCache.length;
  }

  function renderAdmin() {
    // 요약
    var totalPenalty = grandTotal();
    var namedMembers = state.members.filter(function (m) { return m.name.trim(); }).length;
    document.getElementById('admin-summary').innerHTML =
      '<div class="summary-item"><div class="num">' + namedMembers + '</div><div class="lbl">등록 회원</div></div>' +
      '<div class="summary-item"><div class="num">' + state.dates.length + '</div><div class="lbl">골프 날짜</div></div>' +
      '<div class="summary-item"><div class="num">' + fmt(totalPenalty) + '</div><div class="lbl">누적 타수</div></div>' +
      '<div class="summary-item"><div class="num" id="asset-count-num">' + assetsCache.length + '</div><div class="lbl">자료 개수</div></div>';
    // 화면 문구 편집칸에 현재 값 채우기
    fillLabelInputs();
    // 날짜 관리 목록(금액 비우기 · 날짜 삭제) 렌더
    renderDateManage();
    // 서버(R2)에서 자료실 목록을 불러와 렌더
    loadAssetsFromServer();
  }

  // ---------- 날짜 관리(타수 비우기 · 날짜 삭제) ----------
  // 특정 날짜의 금액 입력 개수(0이 아닌 셀 수)
  function dateFilledCount(id) {
    var n = 0;
    state.members.forEach(function (m) {
      var v = Number(state.cells[cellKey(m.id, id)]) || 0;
      if (v) n++;
    });
    return n;
  }
  function renderDateManage() {
    var box = document.getElementById('admin-date-list');
    if (!box) return;
    if (!state.dates.length) {
      box.innerHTML = '<div class="date-manage-empty"><i class="fas fa-circle-info"></i> 등록된 날짜가 없습니다.</div>';
      return;
    }
    // 최근 날짜가 위로 오도록 역순 정렬해서 표시
    var arr = state.dates.slice().sort(function (a, b) { return a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0; });
    var h = '';
    arr.forEach(function (d) {
      var filled = dateFilledCount(d.id);
      var tot = dateTotal(d.id);
      h += '<div class="date-manage-row">' +
        '<div class="dm-info">' +
          '<span class="dm-date">' + escapeHtml(fmtDateFull(d.iso)) + '</span>' +
          '<span class="dm-sub">' + (filled ? (filled + '명 · 합계 ' + fmt(tot) + '타') : '입력 없음') + '</span>' +
        '</div>' +
        '<div class="dm-btns">' +
          '<button class="btn btn-gray dm-clear" data-clear-date="' + d.id + '"' + (filled ? '' : ' disabled') + '><i class="fas fa-eraser"></i> 타수 비우기</button>' +
          '<button class="btn btn-red dm-del" data-del-date-adm="' + d.id + '"><i class="fas fa-trash-can"></i> 날짜 삭제</button>' +
        '</div>' +
      '</div>';
    });
    box.innerHTML = h;
  }
  (function wireDateManage() {
    var box = document.getElementById('admin-date-list');
    if (!box) return;
    box.addEventListener('click', function (e) {
      if (!isAdmin || !adminToken) return;
      var clearBtn = e.target.closest('[data-clear-date]');
      var delBtn = e.target.closest('[data-del-date-adm]');
      if (clearBtn) {
        var cid = clearBtn.getAttribute('data-clear-date');
        var cd = findDate(cid);
        if (cd && confirm('"' + fmtDateFull(cd.iso) + '" 날짜의 입력 타수를 모두 비울까요?\n※ 날짜 열은 그대로 두고 타수만 지웁니다.')) {
          state.members.forEach(function (m) { delete state.cells[cellKey(m.id, cid)]; });
          save(); render(); renderDateManage();
        }
      } else if (delBtn) {
        var did = delBtn.getAttribute('data-del-date-adm');
        var dd = findDate(did);
        if (dd && confirm('"' + fmtDateFull(dd.iso) + '" 날짜 열을 완전히 삭제할까요?\n※ 해당 날짜의 모든 타수도 함께 삭제됩니다.')) {
          state.dates = state.dates.filter(function (x) { return x.id !== did; });
          Object.keys(state.cells).forEach(function (k) { if (k.split('|')[1] === did) delete state.cells[k]; });
          delete state.widths['date:' + did];
          save(); render(); renderDateManage();
        }
      }
    });
  })();

  // ---------- 화면 문구(라벨) 수정 ----------
  function fillLabelInputs() {
    var map = { 'lbl-title': 'title', 'lbl-lost': 'lost', 'lbl-name': 'colName' };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = lbl(map[id]);
    });
  }
  (function wireLabelEditor() {
    var saveBtn = document.getElementById('lbl-save');
    var resetBtn = document.getElementById('lbl-reset');
    if (saveBtn) saveBtn.addEventListener('click', function () {
      if (!isAdmin || !adminToken) { alert('문구 수정은 관리자만 할 수 있습니다.'); return; }
      var get = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
      state.labels = mergeLabels({
        title: get('lbl-title'), lost: get('lbl-lost'),
        colName: get('lbl-name')
      });
      save(); fillLabelInputs(); render();
      alert('화면 문구를 저장했습니다.');
    });
    if (resetBtn) resetBtn.addEventListener('click', function () {
      if (!isAdmin || !adminToken) return;
      if (!confirm('화면 문구를 모두 기본값으로 되돌릴까요?')) return;
      state.labels = defaultLabels();
      save(); fillLabelInputs(); render();
    });
  })();

  // 서버에서 자료실 목록 로드
  function loadAssetsFromServer() {
    var list = document.getElementById('asset-list');
    list.innerHTML = '<div class="asset-empty"><i class="fas fa-spinner fa-spin"></i> 자료를 불러오는 중…</div>';
    fetch('/api/assets')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        assetsCache = (d && d.ok && d.assets) ? d.assets : [];
        assetsLoaded = true;
        updateAssetCount();
        renderAssets();
      })
      .catch(function () {
        list.innerHTML = '<div class="asset-empty"><i class="fas fa-triangle-exclamation"></i> 자료실을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>';
      });
  }

  function renderAssets() {
    var list = document.getElementById('asset-list');
    if (!assetsCache.length) { list.innerHTML = '<div class="asset-empty"><i class="fas fa-folder-open"></i> 등록된 자료가 없습니다. 이미지를 추가해 보세요.</div>'; return; }
    var h = '';
    assetsCache.forEach(function (a) {
      h += '<div class="asset-item">' +
        (isAdmin ? '<button class="asset-del" data-del-asset="' + a.id + '" title="삭제"><i class="fas fa-trash"></i></button>' : '') +
        (isAdmin ? '<button class="asset-edit" data-edit-asset="' + a.id + '" title="이름 수정"><i class="fas fa-pen"></i></button>' : '') +
        '<img src="' + a.url + '" alt="' + escapeHtml(a.name) + '" data-view="' + a.id + '" loading="lazy" />' +
        '<div class="asset-cap">' + escapeHtml(a.name) + '</div>' +
        '</div>';
    });
    list.innerHTML = h;
  }

  // 자료 추가 (서버 R2 업로드)
  var assetName = document.getElementById('asset-name');
  var assetFile = document.getElementById('asset-file');
  var pendingFile = null;
  assetFile.addEventListener('change', function () {
    var f = assetFile.files[0]; if (!f) { pendingFile = null; return; }
    if (f.size > 8 * 1024 * 1024) { alert('이미지 용량이 큽니다(최대 8MB). 더 작은 이미지를 사용해 주세요.'); assetFile.value = ''; return; }
    pendingFile = f;
  });
  document.getElementById('asset-save').addEventListener('click', function () {
    if (!isAdmin || !adminToken) { alert('자료 등록은 관리자만 할 수 있습니다.'); return; }
    if (!pendingFile) { alert('이미지를 먼저 선택해 주세요.'); return; }
    var name = assetName.value.trim() || pendingFile.name || '자료';
    var saveBtn = document.getElementById('asset-save');
    var origHtml = saveBtn.innerHTML;
    saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 업로드 중…';

    var fd = new FormData();
    fd.append('file', pendingFile);
    fd.append('name', name);
    fetch('/api/assets', { method: 'POST', headers: adminHeaders(), body: fd })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 401) { handleAdminExpired(); return; }
        if (!res.d || !res.d.ok) { alert('업로드 실패: ' + ((res.d && res.d.error) || '알 수 없는 오류')); return; }
        assetName.value = ''; assetFile.value = ''; pendingFile = null;
        loadAssetsFromServer();
      })
      .catch(function () { alert('네트워크 오류로 업로드에 실패했습니다.'); })
      .then(function () { saveBtn.disabled = false; saveBtn.innerHTML = origHtml; });
  });

  // 자료 삭제 / 크게보기
  document.getElementById('asset-list').addEventListener('click', function (e) {
    var edit = e.target.closest('[data-edit-asset]');
    if (edit) {
      if (!isAdmin || !adminToken) return;
      var eid = edit.getAttribute('data-edit-asset');
      var cur = null; for (var j = 0; j < assetsCache.length; j++) if (assetsCache[j].id === eid) cur = assetsCache[j];
      var newName = prompt('자료 이름을 수정하세요.', (cur && cur.name) || '');
      if (newName == null) return;
      newName = newName.trim();
      if (!newName) { alert('이름을 입력해 주세요.'); return; }
      fetch('/api/assets/' + encodeURIComponent(eid), {
        method: 'PATCH',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: newName })
      })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
        .then(function (res) {
          if (res.status === 401) { handleAdminExpired(); return; }
          if (!res.d || !res.d.ok) { alert('이름 수정 실패: ' + ((res.d && res.d.error) || '오류')); return; }
          loadAssetsFromServer();
        })
        .catch(function () { alert('네트워크 오류로 이름 수정에 실패했습니다.'); });
      return;
    }
    var del = e.target.closest('[data-del-asset]');
    if (del) {
      if (!isAdmin || !adminToken) return;
      var id = del.getAttribute('data-del-asset');
      if (!confirm('이 자료를 삭제할까요? (서버에서 영구 삭제됩니다)')) return;
      fetch('/api/assets/' + encodeURIComponent(id), { method: 'DELETE', headers: adminHeaders() })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
        .then(function (res) {
          if (res.status === 401) { handleAdminExpired(); return; }
          if (!res.d || !res.d.ok) { alert('삭제 실패: ' + ((res.d && res.d.error) || '오류')); return; }
          loadAssetsFromServer();
        })
        .catch(function () { alert('네트워크 오류로 삭제에 실패했습니다.'); });
      return;
    }
    var view = e.target.closest('[data-view]');
    if (view) {
      var vid = view.getAttribute('data-view');
      var a = null; for (var i = 0; i < assetsCache.length; i++) if (assetsCache[i].id === vid) a = assetsCache[i];
      if (a) { document.getElementById('img-big').src = a.url; document.getElementById('img-caption').textContent = a.name; document.getElementById('img-modal').classList.remove('hidden'); }
    }
  });
  document.getElementById('img-close').addEventListener('click', function () { document.getElementById('img-modal').classList.add('hidden'); });
  document.getElementById('img-modal').addEventListener('click', function (e) { if (e.target.id === 'img-modal') document.getElementById('img-modal').classList.add('hidden'); });

  // 관리자: CSV / 백업 / 복원
  document.getElementById('admin-export').addEventListener('click', exportCsv);
  var adminResetBtn = document.getElementById('admin-reset');
  if (adminResetBtn) adminResetBtn.addEventListener('click', fullReset);
  document.getElementById('admin-backup').addEventListener('click', function () {
    // D1 전체 데이터(회원/날짜/타수/금액/문구/추가 필드)를 백업. 자료실 이미지는 R2에서 별도 관리.
    var blob = new Blob([JSON.stringify(serializeState(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, '골프정산_백업_' + todayIso() + '.json');
  });
  document.getElementById('admin-restore').addEventListener('change', function (e) {
    if (!isAdmin || !adminToken) { e.target.value = ''; alert('백업 복원은 관리자만 할 수 있습니다.'); return; }
    var f = e.target.files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (!d || !d.members) throw new Error('형식오류');
        state = normalizeState(d);
        save();
        render(); renderAdmin();
        alert('정산 데이터를 복원했습니다. (자료실 이미지는 서버에 그대로 유지됩니다)');
      } catch (x) { alert('올바른 백업 파일이 아닙니다.'); }
      e.target.value = '';
    };
    reader.readAsText(f);
  });

  // ---------- 시작 ----------
  updateAdminBtn();
  render();
  window.addEventListener('load', syncHeaderWidth);
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(syncHeaderWidth); }

  // 서버(D1)에서 공유 데이터 로드 → 화면 반영 → 이후 4초마다 폴링하여 다른 기기 변경 동기화.
  // 이렇게 하면 모바일에서 추가한 날짜가 PC에도, PC에서 추가한 날짜가 모바일에도 실시간 반영됨.
  loadFromServer().then(function () { startPolling(); });
})();

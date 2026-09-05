(function () {
  "use strict";

  // auth 관련 window 이벤트는 js/firebase.js(module script)가 나중에 로드되어
  // onAuthStateChanged 콜백이 비동기(IndexedDB 접근)로 언제 fire될지 보장되지 않으므로,
  // DOMContentLoaded를 기다리지 않고 스크립트 최상단에서 최대한 빨리 등록한다.
  // (app.js는 classic script로 body 맨 끝에 있어 DOM 접근 자체는 이미 안전하다.)
  window.addEventListener("pt-auth-signed-in", handleAuthSignedIn);
  window.addEventListener("pt-auth-signed-out", handleAuthSignedOut);
  window.addEventListener("pt-records-updated", handleRecordsUpdated);
  window.addEventListener("pt-auth-error", handleAuthError);
  window.addEventListener("pt-sync-error", handleSyncError);

  // 로그인 여부를 아직 모르는 초기 상태에는 로그인 화면을 보여준다.
  document.getElementById("authGate").hidden = false;

  var PROFILE_KEY = "periodTracker.profile.v1";

  var SYMPTOM_TAGS = [
    "두통", "복통", "요통", "부종", "기분 변화",
    "피로감", "유방 압통", "메스꺼움", "식욕 변화", "여드름"
  ];

  var MAX_RECORDS_FOR_PREDICTION = 6;
  var DEFAULT_PERIOD_LENGTH = 5;
  var OVULATION_OFFSET_DAYS = 14;
  var BANNER_THRESHOLD_DAYS = 3;

  // 나이대별 평균 생리 주기(일) - 기록이 1건뿐일 때 추정치로 사용
  function defaultCycleLengthForAge(age) {
    if (!age && age !== 0) return 28;
    if (age < 20) return 30;
    if (age < 35) return 28;
    if (age < 45) return 27;
    return 25;
  }

  // ---------- date helpers (local time, no timezone drift) ----------

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatDate(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function parseDate(str) {
    var parts = str.split("-");
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function addDays(date, n) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  function diffDays(a, b) {
    var msPerDay = 24 * 60 * 60 * 1000;
    var utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((utcB - utcA) / msPerDay);
  }

  function todayDate() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function todayStr() {
    return formatDate(todayDate());
  }

  function uid() {
    return "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  // ---------- storage ----------

  function loadProfile() {
    try {
      var raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return { age: null };
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { age: null };
      return { age: typeof parsed.age === "number" ? parsed.age : null };
    } catch (e) {
      console.error("프로필을 불러오지 못했습니다.", e);
      return { age: null };
    }
  }

  function saveProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      return true;
    } catch (e) {
      console.error("프로필을 저장하지 못했습니다.", e);
      return false;
    }
  }

  function updateProfileSummary() {
    var el = document.getElementById("profileSummaryValue");
    el.textContent = state.profile.age != null ? "나이 " + state.profile.age + "세" : "나이 미입력";
  }

  // ---------- state ----------

  var state = {
    records: [],
    profile: loadProfile(),
    calendarMonth: new Date(todayDate().getFullYear(), todayDate().getMonth(), 1),
    selectedTags: [],
    uid: null
  };

  var selectedCellEl = null;

  // ---------- auth / sync ----------

  var syncErrorTimer = null;

  function showAppShell(email) {
    document.getElementById("authGate").hidden = true;
    document.getElementById("appShell").hidden = false;
    document.getElementById("userBar").hidden = false;
    document.getElementById("userEmail").textContent = email || "";
    var authErrorEl = document.getElementById("authError");
    authErrorEl.hidden = true;
    authErrorEl.textContent = "";
  }

  function showAuthGate() {
    document.getElementById("appShell").hidden = true;
    document.getElementById("authGate").hidden = false;
    document.getElementById("userBar").hidden = true;
    document.getElementById("userEmail").textContent = "";
  }

  function showAuthError(message) {
    var el = document.getElementById("authError");
    el.textContent = message || "로그인에 실패했습니다.";
    el.hidden = false;
  }

  function showSyncErrorBanner(message) {
    var el = document.getElementById("syncErrorBanner");
    el.textContent = message || "동기화에 실패했습니다.";
    el.hidden = false;
    if (syncErrorTimer) clearTimeout(syncErrorTimer);
    syncErrorTimer = setTimeout(function () {
      el.hidden = true;
    }, 5000);
  }

  function handleAuthSignedIn(e) {
    try {
      var detail = (e && e.detail) || {};
      state.uid = detail.uid || null;
      showAppShell(detail.email);
    } catch (err) {
      console.error("로그인 상태 반영 중 오류가 발생했습니다.", err);
    }
  }

  function handleAuthSignedOut() {
    try {
      state.uid = null;
      state.records = [];
      showAuthGate();
    } catch (err) {
      console.error("로그아웃 상태 반영 중 오류가 발생했습니다.", err);
    }
  }

  function handleRecordsUpdated(e) {
    try {
      var detail = (e && e.detail) || {};
      state.records = Array.isArray(detail.records) ? detail.records : [];
      renderCalendar();
    } catch (err) {
      console.error("기록 동기화 반영 중 오류가 발생했습니다.", err);
    }
  }

  function handleAuthError(e) {
    try {
      var detail = (e && e.detail) || {};
      showAuthError(detail.message);
    } catch (err) {
      console.error("로그인 오류 반영 중 오류가 발생했습니다.", err);
    }
  }

  function handleSyncError(e) {
    try {
      var detail = (e && e.detail) || {};
      showSyncErrorBanner(detail.message);
    } catch (err) {
      console.error("동기화 오류 반영 중 오류가 발생했습니다.", err);
    }
  }

  function sortedByStart(records) {
    return records.slice().sort(function (a, b) {
      return parseDate(a.startDate) - parseDate(b.startDate);
    });
  }

  // ---------- prediction ----------

  function computePrediction(records, profile) {
    if (records.length === 0) {
      return { available: false };
    }

    var sorted = sortedByStart(records);
    var lastRecord = sorted[sorted.length - 1];
    var lastStart = parseDate(lastRecord.startDate);

    // 기록이 1건뿐이면 나이대별 평균 주기로 추정
    if (records.length === 1) {
      var ageCycleLength = defaultCycleLengthForAge(profile ? profile.age : null);
      var ageNextStart = addDays(lastStart, ageCycleLength);
      var agePeriodLen = lastRecord.endDate
        ? diffDays(parseDate(lastRecord.startDate), parseDate(lastRecord.endDate)) + 1
        : DEFAULT_PERIOD_LENGTH;
      var ageOvulation = addDays(ageNextStart, -OVULATION_OFFSET_DAYS);

      return {
        available: true,
        isEstimate: true,
        avgCycleLength: ageCycleLength,
        avgPeriodLength: lastRecord.endDate ? agePeriodLen : null,
        nextPeriodStart: ageNextStart,
        nextPeriodEnd: addDays(ageNextStart, agePeriodLen - 1),
        ovulationDate: ageOvulation
      };
    }

    var recent = sorted.slice(Math.max(0, sorted.length - MAX_RECORDS_FOR_PREDICTION));

    var cycleLengths = [];
    for (var i = 1; i < recent.length; i++) {
      var d = diffDays(parseDate(recent[i - 1].startDate), parseDate(recent[i].startDate));
      if (d > 0) cycleLengths.push(d);
    }

    if (cycleLengths.length === 0) {
      return { available: false };
    }

    var avgCycleLength = cycleLengths.reduce(function (a, b) { return a + b; }, 0) / cycleLengths.length;

    var periodLengths = [];
    recent.forEach(function (r) {
      if (r.endDate) {
        var len = diffDays(parseDate(r.startDate), parseDate(r.endDate)) + 1;
        if (len > 0) periodLengths.push(len);
      }
    });
    var avgPeriodLength = periodLengths.length
      ? periodLengths.reduce(function (a, b) { return a + b; }, 0) / periodLengths.length
      : null;

    var roundedCycle = Math.round(avgCycleLength);
    var nextPeriodStart = addDays(lastStart, roundedCycle);
    var ovulationDate = addDays(nextPeriodStart, -OVULATION_OFFSET_DAYS);
    var predictedPeriodLen = avgPeriodLength ? Math.round(avgPeriodLength) : DEFAULT_PERIOD_LENGTH;
    var nextPeriodEnd = addDays(nextPeriodStart, predictedPeriodLen - 1);

    return {
      available: true,
      isEstimate: false,
      avgCycleLength: avgCycleLength,
      avgPeriodLength: avgPeriodLength,
      nextPeriodStart: nextPeriodStart,
      nextPeriodEnd: nextPeriodEnd,
      ovulationDate: ovulationDate,
      basedOnCount: recent.length
    };
  }

  // ---------- record lookup ----------

  function findRecordForDate(dateStr) {
    var found = null;
    state.records.forEach(function (r) {
      if (dateStr < r.startDate) return;
      if (r.endDate) {
        if (dateStr <= r.endDate) found = r;
      } else {
        // ongoing period: covers startDate..today
        if (dateStr <= todayStr()) found = r;
      }
    });
    return found;
  }

  function isPredictedPeriodDate(dateStr, prediction) {
    if (!prediction.available) return false;
    var d = parseDate(dateStr);
    return d >= prediction.nextPeriodStart && d <= prediction.nextPeriodEnd;
  }

  function isPredictedOvulationDate(dateStr, prediction) {
    if (!prediction.available) return false;
    return dateStr === formatDate(prediction.ovulationDate);
  }

  // ---------- rendering: countdown / banner ----------

  function renderCountdown(prediction) {
    var valueEl = document.getElementById("countdownValue");
    var nextEl = document.getElementById("nextPeriodDate");
    var ovulEl = document.getElementById("ovulationDate");
    var banner = document.getElementById("banner");
    var basisEl = document.getElementById("predictionBasis");
    var calendarBtn = document.getElementById("addToCalendarBtn");

    if (!prediction.available) {
      valueEl.textContent = "데이터가 더 필요합니다";
      nextEl.textContent = "-";
      ovulEl.textContent = "-";
      banner.hidden = true;
      basisEl.hidden = true;
      calendarBtn.hidden = true;
      return;
    }

    nextEl.textContent = formatDate(prediction.nextPeriodStart);
    ovulEl.textContent = formatDate(prediction.ovulationDate);
    calendarBtn.hidden = false;

    basisEl.hidden = false;
    basisEl.textContent = prediction.isEstimate
      ? "* 기록 1건 + 나이대 평균(" + prediction.avgCycleLength + "일) 기준 추정치예요. 기록이 쌓이면 실제 평균으로 자동 보정됩니다."
      : "최근 " + prediction.basedOnCount + "회 기록의 평균 주기(" + Math.round(prediction.avgCycleLength) + "일) 기준이에요.";

    var dDay = diffDays(todayDate(), prediction.nextPeriodStart);

    if (dDay > 0) {
      valueEl.textContent = "D-" + dDay;
    } else if (dDay === 0) {
      valueEl.textContent = "D-DAY";
    } else {
      valueEl.textContent = "D+" + Math.abs(dDay);
    }

    if (dDay >= 0 && dDay <= BANNER_THRESHOLD_DAYS) {
      banner.hidden = false;
      banner.textContent = dDay === 0
        ? "🌸 오늘 생리 예정일이에요"
        : "🌸 다음 생리 예정일까지 D-" + dDay;
      maybeShowNativeNotification(dDay);
    } else {
      banner.hidden = true;
    }
  }

  // ---------- reminders: browser notification ----------

  var NOTIFY_LAST_KEY = "periodTracker.lastNotified.v1";

  function updateNotifyButtonLabel() {
    var btn = document.getElementById("enableNotifyBtn");
    if (!("Notification" in window)) {
      btn.textContent = "🔔 이 브라우저는 알림 미지원";
      btn.disabled = true;
      return;
    }
    if (Notification.permission === "granted") {
      btn.textContent = "🔔 브라우저 알림 켜짐";
      btn.classList.add("active");
    } else {
      btn.textContent = "🔔 브라우저 알림 켜기";
      btn.classList.remove("active");
    }
  }

  function requestNotifyPermission() {
    if (!("Notification" in window)) {
      alert("이 브라우저는 알림을 지원하지 않아요.");
      return;
    }
    Notification.requestPermission().then(function () {
      updateNotifyButtonLabel();
    });
  }

  function maybeShowNativeNotification(dDay) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var last = null;
    try {
      last = localStorage.getItem(NOTIFY_LAST_KEY);
    } catch (e) {
      // 알림 발송 여부 기록 실패는 무시하고 계속 진행
    }
    var today = todayStr();
    if (last === today) return;

    var body = dDay === 0
      ? "오늘이 생리 예정일이에요."
      : "다음 생리 예정일까지 D-" + dDay + " 남았어요.";
    try {
      new Notification("생리주기 캘린더", { body: body });
      localStorage.setItem(NOTIFY_LAST_KEY, today);
    } catch (e) {
      console.error("알림을 표시하지 못했습니다.", e);
    }
  }

  // ---------- reminders: calendar (.ics) export ----------

  function toICSDate(date) {
    return date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate());
  }

  function buildICS(prediction) {
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//PeriodTracker//KO",
      "CALSCALE:GREGORIAN"
    ];

    var stamp = toICSDate(todayDate()) + "T000000Z";

    lines.push(
      "BEGIN:VEVENT",
      "UID:" + uid() + "@period-tracker",
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + toICSDate(prediction.nextPeriodStart),
      "DTEND;VALUE=DATE:" + toICSDate(addDays(prediction.nextPeriodStart, 1)),
      "SUMMARY:생리 예정일",
      "DESCRIPTION:배란 예정일 " + formatDate(prediction.ovulationDate),
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:생리 예정일이 " + BANNER_THRESHOLD_DAYS + "일 남았어요",
      "TRIGGER:-P" + BANNER_THRESHOLD_DAYS + "D",
      "END:VALARM",
      "END:VEVENT"
    );

    lines.push(
      "BEGIN:VEVENT",
      "UID:" + uid() + "@period-tracker",
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + toICSDate(prediction.ovulationDate),
      "DTEND;VALUE=DATE:" + toICSDate(addDays(prediction.ovulationDate, 1)),
      "SUMMARY:배란 예정일",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:배란 예정일이 하루 남았어요",
      "TRIGGER:-P1D",
      "END:VALARM",
      "END:VEVENT"
    );

    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  function downloadICS(prediction) {
    var ics = buildICS(prediction);
    // data: URI + text/calendar MIME: 아이폰/안드로이드에서는 캘린더 앱의
    // "일정 추가" 화면이 바로 뜨고, 데스크톱 브라우저에서는 .ics 파일로 저장된다.
    var dataUri = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    var a = document.createElement("a");
    a.href = dataUri;
    a.setAttribute("download", "생리예정일-" + formatDate(prediction.nextPeriodStart) + ".ics");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---------- rendering: stats ----------

  function renderStats(prediction) {
    var cycleEl = document.getElementById("avgCycleLength");
    var cycleLabelEl = document.getElementById("avgCycleLabel");
    var periodEl = document.getElementById("avgPeriodLength");
    var countEl = document.getElementById("recordCount");

    countEl.textContent = String(state.records.length);
    cycleEl.textContent = prediction.available ? Math.round(prediction.avgCycleLength) : "-";
    cycleLabelEl.textContent = prediction.available && prediction.isEstimate
      ? "추정 주기 (일)"
      : "평균 주기 (일)";
    periodEl.textContent = (prediction.available && prediction.avgPeriodLength)
      ? Math.round(prediction.avgPeriodLength)
      : "-";
  }

  // ---------- rendering: cycle chart ----------

  function formatShortDate(dateStr) {
    var parts = dateStr.split("-");
    return Number(parts[1]) + "/" + Number(parts[2]);
  }

  function getRecentCycleLengths(records) {
    if (records.length < 2) return [];
    var sorted = sortedByStart(records);
    var recent = sorted.slice(Math.max(0, sorted.length - MAX_RECORDS_FOR_PREDICTION));
    var result = [];
    for (var i = 1; i < recent.length; i++) {
      var length = diffDays(parseDate(recent[i - 1].startDate), parseDate(recent[i].startDate));
      if (length > 0) {
        result.push({ length: length, label: formatShortDate(recent[i].startDate) });
      }
    }
    return result;
  }

  function renderCycleChart(records) {
    var chartEl = document.getElementById("cycleChart");
    var emptyEl = document.getElementById("cycleChartEmpty");
    var data = getRecentCycleLengths(records);

    if (data.length === 0) {
      chartEl.hidden = true;
      emptyEl.hidden = false;
      chartEl.innerHTML = "";
      return;
    }

    emptyEl.hidden = true;
    chartEl.hidden = false;

    var lengths = data.map(function (d) { return d.length; });
    var min = Math.min.apply(null, lengths);
    var max = Math.max.apply(null, lengths);
    var range = max - min;

    chartEl.innerHTML = data.map(function (d, i) {
      var heightPct = range === 0 ? 60 : 20 + ((d.length - min) / range) * 80;
      var isLatest = i === data.length - 1;
      return '<div class="cycle-bar-col' + (isLatest ? " is-latest" : "") + '">' +
        '<span class="cycle-bar-value">' + d.length + '</span>' +
        '<div class="cycle-bar" style="height:' + heightPct + '%"></div>' +
        '<span class="cycle-bar-label">' + d.label + '</span>' +
        '</div>';
    }).join("");
  }

  // ---------- rendering: calendar ----------

  function renderCalendar() {
    var titleEl = document.getElementById("calendarTitle");
    var gridEl = document.getElementById("calendarGrid");
    var year = state.calendarMonth.getFullYear();
    var month = state.calendarMonth.getMonth();

    titleEl.textContent = year + "년 " + (month + 1) + "월";

    var prediction = computePrediction(state.records, state.profile);
    var todayS = todayStr();

    var firstDay = new Date(year, month, 1);
    var startOffset = firstDay.getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();

    var html = "";

    for (var i = 0; i < startOffset; i++) {
      html += '<div class="day-cell empty"></div>';
    }

    for (var day = 1; day <= daysInMonth; day++) {
      var cellDate = new Date(year, month, day);
      var dateStr = formatDate(cellDate);
      var classes = ["day-cell"];
      var record = findRecordForDate(dateStr);

      if (dateStr === todayS) classes.push("today");

      if (record) {
        classes.push("period");
        if (dateStr === record.startDate) classes.push("period-start");
        if (record.endDate && dateStr === record.endDate) classes.push("period-end");
        if (record.memo || (record.symptoms && record.symptoms.length)) classes.push("has-note");
      } else if (isPredictedPeriodDate(dateStr, prediction)) {
        classes.push("predicted-period");
      } else if (isPredictedOvulationDate(dateStr, prediction)) {
        classes.push("predicted-ovulation");
      }

      html += '<div class="' + classes.join(" ") + '" data-date="' + dateStr + '">' + day + "</div>";
    }

    gridEl.innerHTML = html;
    selectedCellEl = null;

    Array.prototype.forEach.call(gridEl.querySelectorAll(".day-cell:not(.empty)"), function (cell) {
      cell.addEventListener("click", function () {
        if (selectedCellEl) selectedCellEl.classList.remove("selected");
        cell.classList.add("selected");
        selectedCellEl = cell;
        onDateClick(cell.getAttribute("data-date"));
      });
    });

    renderCountdown(prediction);
    renderStats(prediction);
    renderCycleChart(state.records);
  }

  // ---------- date click -> detail or new record ----------

  function onDateClick(dateStr) {
    var record = findRecordForDate(dateStr);
    if (record) {
      openDetailModal(record);
    } else {
      openFormModal(null, dateStr);
    }
  }

  // ---------- detail modal ----------

  function openDetailModal(record) {
    var titleEl = document.getElementById("detailModalTitle");
    var bodyEl = document.getElementById("detailModalBody");

    titleEl.textContent = "생리 기록";

    var duration = record.endDate
      ? diffDays(parseDate(record.startDate), parseDate(record.endDate)) + 1
      : null;

    var html = '<div class="detail-dates">' + record.startDate + " ~ " + (record.endDate || "진행 중") + "</div>";
    html += '<div class="detail-duration">' + (duration ? duration + "일간" : "종료일 미입력") + "</div>";

    if (record.symptoms && record.symptoms.length) {
      html += '<div class="detail-tags">';
      record.symptoms.forEach(function (tag) {
        html += '<span class="detail-tag">' + escapeHtml(tag) + "</span>";
      });
      html += "</div>";
    }

    if (record.memo) {
      html += '<div class="detail-memo">' + escapeHtml(record.memo) + "</div>";
    } else {
      html += '<div class="detail-empty">메모가 없습니다</div>';
    }

    html += '<div class="detail-actions"><button class="btn primary" id="editRecordBtn">수정하기</button></div>';

    bodyEl.innerHTML = html;

    document.getElementById("editRecordBtn").addEventListener("click", function () {
      closeModal("detailModal");
      openFormModal(record);
    });

    showModal("detailModal");
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- form modal ----------

  function renderTagChips() {
    var wrap = document.getElementById("symptomTags");
    wrap.innerHTML = SYMPTOM_TAGS.map(function (tag) {
      var selected = state.selectedTags.indexOf(tag) !== -1;
      return '<button type="button" class="tag-chip' + (selected ? " selected" : "") + '" data-tag="' + tag + '">' + tag + "</button>";
    }).join("");

    Array.prototype.forEach.call(wrap.querySelectorAll(".tag-chip"), function (chip) {
      chip.addEventListener("click", function () {
        var tag = chip.getAttribute("data-tag");
        var idx = state.selectedTags.indexOf(tag);
        if (idx === -1) {
          state.selectedTags.push(tag);
        } else {
          state.selectedTags.splice(idx, 1);
        }
        renderTagChips();
      });
    });
  }

  function openFormModal(record, prefillDate) {
    var titleEl = document.getElementById("formModalTitle");
    var idEl = document.getElementById("recordId");
    var startEl = document.getElementById("startDate");
    var endEl = document.getElementById("endDate");
    var memoEl = document.getElementById("memo");
    var deleteBtn = document.getElementById("deleteRecordBtn");

    if (record) {
      titleEl.textContent = "기록 수정";
      idEl.value = record.id;
      startEl.value = record.startDate;
      endEl.value = record.endDate || "";
      memoEl.value = record.memo || "";
      state.selectedTags = (record.symptoms || []).slice();
      deleteBtn.hidden = false;
    } else {
      titleEl.textContent = "기록 추가";
      idEl.value = "";
      startEl.value = prefillDate || todayStr();
      endEl.value = "";
      memoEl.value = "";
      state.selectedTags = [];
      deleteBtn.hidden = true;
    }

    renderTagChips();
    showModal("formModal");
    startEl.focus();
  }

  function onFormSubmit(e) {
    e.preventDefault();

    var id = document.getElementById("recordId").value;
    var startDate = document.getElementById("startDate").value;
    var endDate = document.getElementById("endDate").value;
    var memo = document.getElementById("memo").value.trim();

    if (!startDate) {
      alert("시작일을 선택해주세요.");
      return;
    }
    if (endDate && endDate < startDate) {
      alert("종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }
    if (!state.uid) {
      alert("로그인 후 이용해주세요.");
      return;
    }

    var recordId = id || uid();
    var data = {
      startDate: startDate,
      endDate: endDate || null,
      symptoms: state.selectedTags.slice(),
      memo: memo
    };

    try {
      window.PTFirebase.setRecord(state.uid, recordId, data).catch(function () {});
    } catch (err) {
      console.error("기록을 저장하지 못했습니다.", err);
    }

    closeModal("formModal");
  }

  function onDeleteRecord() {
    var id = document.getElementById("recordId").value;
    if (!id) return;
    if (!confirm("이 기록을 삭제할까요?")) return;
    if (!state.uid) return;

    try {
      window.PTFirebase.deleteRecord(state.uid, id).catch(function () {});
    } catch (err) {
      console.error("기록을 삭제하지 못했습니다.", err);
    }

    closeModal("formModal");
  }

  // ---------- modal helpers ----------

  function showModal(id) {
    document.getElementById(id).hidden = false;
  }

  function closeModal(id) {
    document.getElementById(id).hidden = true;
    if (selectedCellEl) {
      selectedCellEl.classList.remove("selected");
      selectedCellEl = null;
    }
  }

  // ---------- init ----------

  function init() {
    var loginBtn = document.getElementById("googleLoginBtn");
    if (loginBtn) {
      loginBtn.addEventListener("click", function () {
        try {
          var authErrorEl = document.getElementById("authError");
          authErrorEl.hidden = true;
          if (window.PTFirebase && window.PTFirebase.signIn) {
            window.PTFirebase.signIn();
          }
        } catch (err) {
          console.error("로그인 시도 중 오류가 발생했습니다.", err);
        }
      });
    }

    var logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        try {
          if (window.PTFirebase && window.PTFirebase.signOutUser) {
            window.PTFirebase.signOutUser();
          }
        } catch (err) {
          console.error("로그아웃 시도 중 오류가 발생했습니다.", err);
        }
      });
    }

    updateNotifyButtonLabel();
    document.getElementById("enableNotifyBtn").addEventListener("click", requestNotifyPermission);
    document.getElementById("addToCalendarBtn").addEventListener("click", function () {
      var prediction = computePrediction(state.records, state.profile);
      if (prediction.available) downloadICS(prediction);
    });

    var profileAgeEl = document.getElementById("profileAge");
    if (state.profile.age != null) {
      profileAgeEl.value = state.profile.age;
    }
    updateProfileSummary();
    profileAgeEl.addEventListener("change", function () {
      var val = parseInt(profileAgeEl.value, 10);
      state.profile.age = isNaN(val) ? null : val;
      saveProfile(state.profile);
      updateProfileSummary();
      renderCalendar();
    });

    document.getElementById("prevMonth").addEventListener("click", function () {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
      renderCalendar();
    });

    document.getElementById("nextMonth").addEventListener("click", function () {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
      renderCalendar();
    });

    document.getElementById("addRecordBtn").addEventListener("click", function () {
      openFormModal(null, todayStr());
    });

    document.getElementById("recordForm").addEventListener("submit", onFormSubmit);
    document.getElementById("deleteRecordBtn").addEventListener("click", onDeleteRecord);

    Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (btn) {
      btn.addEventListener("click", function () {
        closeModal(btn.getAttribute("data-close"));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll(".modal-overlay"), function (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeModal(overlay.id);
      });
    });

    renderCalendar();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

(function () {
  "use strict";

  var STORAGE_KEY = "periodTracker.records.v1";
  var PROFILE_KEY = "periodTracker.profile.v1";

  var SYMPTOM_TAGS = [
    "두통", "복통", "요통", "부종", "기분 변화",
    "피로감", "유방 압통", "메스꺼움", "식욕 변화", "여드름"
  ];

  var MAX_RECORDS_FOR_PREDICTION = 6;
  var DEFAULT_PERIOD_LENGTH = 5;
  var OVULATION_OFFSET_DAYS = 14;
  var BANNER_THRESHOLD_DAYS = 3;
  var ESTIMATED_END_OFFSET_DAYS = 7;
  // 간격이 평소 주기의 이 배수를 넘으면 사이에 놓친 생리가 있었을 가능성이 높다고 본다
  var SKIP_GAP_RATIO = 1.5;
  var MISSED_KEY = "periodTracker.missedCycles.v1";

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

  function loadRecords() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (e) {
      console.error("기록을 불러오지 못했습니다.", e);
      return [];
    }
  }

  function saveRecords(records) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      return true;
    } catch (e) {
      console.error("기록을 저장하지 못했습니다.", e);
      return false;
    }
  }

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

  // 예정일 놓침 기록: { recordId, count } - 마지막 기록(recordId) 이후 놓친 주기 수
  function loadMissed() {
    try {
      var raw = localStorage.getItem(MISSED_KEY);
      if (!raw) return { recordId: null, count: 0 };
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { recordId: null, count: 0 };
      return {
        recordId: typeof parsed.recordId === "string" ? parsed.recordId : null,
        count: typeof parsed.count === "number" && parsed.count > 0 ? parsed.count : 0
      };
    } catch (e) {
      console.error("놓친 주기 정보를 불러오지 못했습니다.", e);
      return { recordId: null, count: 0 };
    }
  }

  function saveMissed(missed) {
    try {
      localStorage.setItem(MISSED_KEY, JSON.stringify(missed));
      return true;
    } catch (e) {
      console.error("놓친 주기 정보를 저장하지 못했습니다.", e);
      return false;
    }
  }

  function updateProfileSummary() {
    var el = document.getElementById("profileSummaryValue");
    el.textContent = state.profile.age != null ? "나이 " + state.profile.age + "세" : "나이 미입력";
  }

  // ---------- state ----------

  var state = {
    records: loadRecords(),
    profile: loadProfile(),
    missed: loadMissed(),
    calendarMonth: new Date(todayDate().getFullYear(), todayDate().getMonth(), 1),
    selectedTags: []
  };

  var selectedCellEl = null;

  function sortedByStart(records) {
    return records.slice().sort(function (a, b) {
      return parseDate(a.startDate) - parseDate(b.startDate);
    });
  }

  // 실제 종료일이 없을 때 항상 같은 값(시작일 + 7일)을 돌려주는 순수 함수라,
  // 새로고침해도 매번 동일하게 계산되어 저장 여부와 무관하게 안정적이다.
  // (예전 데이터에 estimatedEndDate 필드가 없어도 이 폴백으로 그대로 동작한다.)
  function getEstimatedEndDate(record) {
    if (record.estimatedEndDate) return record.estimatedEndDate;
    return formatDate(addDays(parseDate(record.startDate), ESTIMATED_END_OFFSET_DAYS));
  }

  // 실제 종료일이 있으면 그것을 우선 사용하고, 없으면 종료 예상일을 사용한다.
  function getEffectiveEnd(record) {
    if (record.endDate) {
      return { date: record.endDate, isEstimate: false };
    }
    return { date: getEstimatedEndDate(record), isEstimate: true };
  }

  // ---------- prediction ----------

  // 기록 간격 목록. skippedBefore 가 표시된 기록은 앞 기록과의 사이에 놓친 생리가 있어
  // 실제 주기가 아니므로 skipped: true 로 표시하고 평균 계산에서 뺀다.
  function getCycleIntervals(sortedRecords) {
    var result = [];
    for (var i = 1; i < sortedRecords.length; i++) {
      var length = diffDays(parseDate(sortedRecords[i - 1].startDate), parseDate(sortedRecords[i].startDate));
      if (length > 0) {
        result.push({ length: length, record: sortedRecords[i], skipped: !!sortedRecords[i].skippedBefore });
      }
    }
    return result;
  }

  // 마지막 기록 이후 "예정일 놓침"으로 넘긴 주기 수 (다른 기록이 추가되면 자동으로 무효)
  function missedCountFor(lastRecord) {
    return state.missed.recordId === lastRecord.id ? state.missed.count : 0;
  }

  function computePrediction(records, profile, missedCount) {
    if (records.length === 0) {
      return { available: false };
    }

    var sorted = sortedByStart(records);
    var lastRecord = sorted[sorted.length - 1];
    var lastStart = parseDate(lastRecord.startDate);
    var recent = sorted.slice(Math.max(0, sorted.length - MAX_RECORDS_FOR_PREDICTION));

    var intervals = getCycleIntervals(recent);
    var cycleLengths = [];
    var skippedCount = 0;
    intervals.forEach(function (it) {
      if (it.skipped) skippedCount++;
      else cycleLengths.push(it.length);
    });

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

    // 기록이 1건뿐이거나, 건너뛴 주기를 빼면 남는 간격이 없으면 나이대별 평균 주기로 추정
    var isEstimate = cycleLengths.length === 0;
    var avgCycleLength = isEstimate
      ? defaultCycleLengthForAge(profile ? profile.age : null)
      : cycleLengths.reduce(function (a, b) { return a + b; }, 0) / cycleLengths.length;

    var roundedCycle = Math.round(avgCycleLength);
    var missed = missedCount || 0;
    // 놓친 주기 수만큼 한 주기씩 뒤로 넘긴다
    var nextPeriodStart = addDays(lastStart, roundedCycle * (missed + 1));
    var ovulationDate = addDays(nextPeriodStart, -OVULATION_OFFSET_DAYS);
    var predictedPeriodLen = avgPeriodLength ? Math.round(avgPeriodLength) : DEFAULT_PERIOD_LENGTH;
    var nextPeriodEnd = addDays(nextPeriodStart, predictedPeriodLen - 1);

    // 예정일이 지나고 평균 주기의 절반이 더 지나면 (= 마지막 기록부터 주기의 1.5배)
    // 기록을 놓쳤을 수 있으므로 "예정일 놓침" 버튼을 보여준다
    var overdueFrom = addDays(nextPeriodStart, Math.round(roundedCycle * (SKIP_GAP_RATIO - 1)));

    return {
      available: true,
      isEstimate: isEstimate,
      avgCycleLength: avgCycleLength,
      avgPeriodLength: avgPeriodLength,
      nextPeriodStart: nextPeriodStart,
      nextPeriodEnd: nextPeriodEnd,
      ovulationDate: ovulationDate,
      basedOnCount: recent.length,
      skippedCount: skippedCount,
      missedCount: missed,
      isOverdue: todayDate() >= overdueFrom,
      lastRecord: lastRecord
    };
  }

  function currentPrediction() {
    if (state.records.length === 0) return { available: false };
    var last = sortedByStart(state.records)[state.records.length - 1];
    return computePrediction(state.records, state.profile, missedCountFor(last));
  }

  // ---------- record lookup ----------

  function findRecordForDate(dateStr) {
    var found = null;
    state.records.forEach(function (r) {
      if (dateStr < r.startDate) return;
      // 실제 종료일이 있으면 그 날짜까지, 없으면 종료 예상일(시작일+7일)까지로
      // 고정된다 - 오늘 날짜가 얼마나 지났든 임의로 연장하지 않는다.
      if (dateStr <= getEffectiveEnd(r).date) found = r;
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
    var missedBtn = document.getElementById("missedCycleBtn");
    var undoMissedBtn = document.getElementById("undoMissedBtn");
    var overdueEl = document.getElementById("overdueHint");

    if (!prediction.available) {
      valueEl.textContent = "데이터가 더 필요합니다";
      nextEl.textContent = "-";
      ovulEl.textContent = "-";
      banner.hidden = true;
      basisEl.hidden = true;
      calendarBtn.hidden = true;
      missedBtn.hidden = true;
      undoMissedBtn.hidden = true;
      overdueEl.hidden = true;
      return;
    }

    nextEl.textContent = formatDate(prediction.nextPeriodStart);
    ovulEl.textContent = formatDate(prediction.ovulationDate);
    calendarBtn.hidden = false;
    missedBtn.hidden = !prediction.isOverdue;
    undoMissedBtn.hidden = prediction.missedCount === 0;
    overdueEl.hidden = !prediction.isOverdue;

    var basis;
    if (prediction.isEstimate && prediction.skippedCount > 0) {
      basis = "* 건너뛴 주기를 빼면 남는 주기 기록이 없어 나이대 평균(" + prediction.avgCycleLength + "일)으로 추정했어요.";
    } else if (prediction.isEstimate) {
      basis = "* 기록 1건 + 나이대 평균(" + prediction.avgCycleLength + "일) 기준 추정치예요. 기록이 쌓이면 실제 평균으로 자동 보정됩니다.";
    } else {
      basis = "최근 " + prediction.basedOnCount + "회 기록의 평균 주기(" + Math.round(prediction.avgCycleLength) + "일) 기준이에요.";
      if (prediction.skippedCount > 0) basis += " (건너뛴 주기 " + prediction.skippedCount + "회 제외)";
    }
    if (prediction.missedCount > 0) {
      basis += " 놓친 예정일 " + prediction.missedCount + "회를 반영해 다음 주기로 넘겼어요.";
    }
    basisEl.hidden = false;
    basisEl.textContent = basis;

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
    return getCycleIntervals(recent).map(function (it) {
      return { length: it.length, label: formatShortDate(it.record.startDate), skipped: it.skipped };
    });
  }

  function renderCycleChart(records) {
    var chartEl = document.getElementById("cycleChart");
    var emptyEl = document.getElementById("cycleChartEmpty");
    var noteEl = document.getElementById("cycleChartNote");
    var data = getRecentCycleLengths(records);

    if (data.length === 0) {
      chartEl.hidden = true;
      emptyEl.hidden = false;
      noteEl.hidden = true;
      chartEl.innerHTML = "";
      return;
    }

    emptyEl.hidden = true;
    chartEl.hidden = false;

    // 건너뛴 간격은 실제 주기가 아니라 막대 높이 스케일 계산에서도 뺀다
    var lengths = data.filter(function (d) { return !d.skipped; }).map(function (d) { return d.length; });
    var min = lengths.length ? Math.min.apply(null, lengths) : 0;
    var max = lengths.length ? Math.max.apply(null, lengths) : 0;
    var range = max - min;
    noteEl.hidden = lengths.length === data.length;

    chartEl.innerHTML = data.map(function (d, i) {
      var heightPct = d.skipped ? 100 : (range === 0 ? 60 : 20 + ((d.length - min) / range) * 80);
      var classes = "cycle-bar-col";
      if (d.skipped) classes += " is-skipped";
      else if (i === data.length - 1) classes += " is-latest";
      return '<div class="' + classes + '"' + (d.skipped ? ' title="건너뛴 주기 (평균 제외)"' : "") + '>' +
        '<span class="cycle-bar-value">' + (d.skipped ? "⏭" : "") + d.length + '</span>' +
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

    var prediction = currentPrediction();
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
        var endInfo = getEffectiveEnd(record);
        classes.push("period");
        if (dateStr === record.startDate) classes.push("period-start");
        if (dateStr === endInfo.date) {
          classes.push("period-end");
          if (endInfo.isEstimate) classes.push("period-estimated-end");
        }
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

    var endInfo = getEffectiveEnd(record);
    var duration = diffDays(parseDate(record.startDate), parseDate(endInfo.date)) + 1;
    var endLabel = endInfo.isEstimate ? endInfo.date + " (예상)" : endInfo.date;

    var html = '<div class="detail-dates">' + record.startDate + " ~ " + endLabel + "</div>";
    html += '<div class="detail-duration">' + duration + "일간"
      + (endInfo.isEstimate ? " · 종료일 미입력, 예상치예요" : "") + "</div>";

    if (record.symptoms && record.symptoms.length) {
      html += '<div class="detail-tags">';
      record.symptoms.forEach(function (tag) {
        html += '<span class="detail-tag">' + escapeHtml(tag) + "</span>";
      });
      html += "</div>";
    }

    if (record.skippedBefore) {
      html += '<div class="detail-tags"><span class="detail-tag skip">⏭ 이전 주기 건너뜀 · 주기 계산에서 제외</span></div>';
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
    var skippedEl = document.getElementById("skippedBefore");

    if (record) {
      titleEl.textContent = "기록 수정";
      idEl.value = record.id;
      startEl.value = record.startDate;
      endEl.value = record.endDate || "";
      memoEl.value = record.memo || "";
      state.selectedTags = (record.symptoms || []).slice();
      skippedEl.checked = !!record.skippedBefore;
      deleteBtn.hidden = false;
    } else {
      titleEl.textContent = "기록 추가";
      idEl.value = "";
      startEl.value = prefillDate || todayStr();
      endEl.value = "";
      memoEl.value = "";
      state.selectedTags = [];
      // "예정일 놓침"을 눌러둔 상태에서 그 뒤 기록을 추가하면 기본으로 체크해둔다
      var sorted = sortedByStart(state.records);
      var last = sorted[sorted.length - 1];
      skippedEl.checked = !!last && missedCountFor(last) > 0 && startEl.value > last.startDate;
      deleteBtn.hidden = true;
    }

    renderTagChips();
    showModal("formModal");
    startEl.focus();
  }

  // 앞 기록과의 간격이 이 일수 이상이면 사이에 놓친 생리가 있었는지 물어본다
  function skipGapThreshold(records) {
    var p = computePrediction(records, state.profile, 0);
    var reference = p.available ? p.avgCycleLength : defaultCycleLengthForAge(state.profile.age);
    return Math.round(reference * SKIP_GAP_RATIO);
  }

  function onFormSubmit(e) {
    e.preventDefault();

    var id = document.getElementById("recordId").value;
    var startDate = document.getElementById("startDate").value;
    var endDate = document.getElementById("endDate").value;
    var memo = document.getElementById("memo").value.trim();
    var skippedBefore = document.getElementById("skippedBefore").checked;

    if (!startDate) {
      alert("시작일을 선택해주세요.");
      return;
    }
    if (endDate && endDate < startDate) {
      alert("종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }

    // 실제 종료일을 입력하지 않았으면 시작일 + 7일을 종료 예상일로 계산해 저장한다.
    // 실제 종료일이 있으면 종료 예상일은 필요 없으므로 비워둔다 (실제 값이 항상 우선).
    var estimatedEndDate = endDate ? null : formatDate(addDays(parseDate(startDate), ESTIMATED_END_OFFSET_DAYS));

    var others = sortedByStart(state.records.filter(function (r) { return r.id !== id; }));
    var prev = null;
    var next = null;
    others.forEach(function (r) {
      if (r.startDate < startDate) prev = r;
      else if (!next && r.startDate > startDate) next = r;
    });
    var original = id ? state.records.find(function (r) { return r.id === id; }) : null;
    var startChanged = !original || original.startDate !== startDate;
    var threshold = skipGapThreshold(others);

    // 앞 기록이 없으면 건너뛸 간격 자체가 없다
    if (!prev) skippedBefore = false;

    if (prev && !skippedBefore && startChanged) {
      var gap = diffDays(parseDate(prev.startDate), parseDate(startDate));
      if (gap >= threshold && confirm(
        "이전 기록(" + prev.startDate + ")과 " + gap + "일 차이가 나요.\n" +
        "사이에 기록하지 못한 생리가 있었나요?\n\n" +
        "확인: 놓친 생리 있음 (이 간격은 주기 계산에서 제외)\n" +
        "취소: 그대로 저장 (주기가 길었던 것)"
      )) {
        skippedBefore = true;
      }
    }

    // 놓쳤던 생리를 나중에 채워 넣은 경우, 다음 기록의 "놓친 생리 있음" 표시를 풀어준다
    if (next && next.skippedBefore && startChanged) {
      var gapToNext = diffDays(parseDate(startDate), parseDate(next.startDate));
      if (gapToNext < threshold && confirm(
        "다음 기록(" + next.startDate + ")에 '이전에 놓친 생리 있음' 표시가 있어요.\n" +
        "지금 기록이 그 놓친 생리라면 표시를 해제할까요?"
      )) {
        next.skippedBefore = false;
      }
    }

    if (id) {
      var idx = state.records.findIndex(function (r) { return r.id === id; });
      if (idx !== -1) {
        state.records[idx] = {
          id: id,
          startDate: startDate,
          endDate: endDate || null,
          estimatedEndDate: estimatedEndDate,
          symptoms: state.selectedTags.slice(),
          memo: memo,
          skippedBefore: skippedBefore
        };
      }
    } else {
      state.records.push({
        id: uid(),
        startDate: startDate,
        endDate: endDate || null,
        estimatedEndDate: estimatedEndDate,
        symptoms: state.selectedTags.slice(),
        memo: memo,
        skippedBefore: skippedBefore
      });
    }

    saveRecords(state.records);
    closeModal("formModal");
    renderCalendar();
  }

  function onDeleteRecord() {
    var id = document.getElementById("recordId").value;
    if (!id) return;
    if (!confirm("이 기록을 삭제할까요?")) return;

    state.records = state.records.filter(function (r) { return r.id !== id; });
    saveRecords(state.records);
    closeModal("formModal");
    renderCalendar();
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
    updateNotifyButtonLabel();
    document.getElementById("enableNotifyBtn").addEventListener("click", requestNotifyPermission);
    document.getElementById("addToCalendarBtn").addEventListener("click", function () {
      var prediction = currentPrediction();
      if (prediction.available) downloadICS(prediction);
    });

    document.getElementById("missedCycleBtn").addEventListener("click", function () {
      var prediction = currentPrediction();
      if (!prediction.available) return;
      if (!confirm(
        "예정일(" + formatDate(prediction.nextPeriodStart) + ")에 생리를 했는데 기록을 놓쳤나요?\n" +
        "확인을 누르면 다음 주기 예정일로 넘겨드려요.\n\n" +
        "주기가 늦어지는 중이라면 취소를 눌러 그대로 두세요."
      )) return;
      state.missed = { recordId: prediction.lastRecord.id, count: prediction.missedCount + 1 };
      saveMissed(state.missed);
      renderCalendar();
    });
    document.getElementById("undoMissedBtn").addEventListener("click", function () {
      var prediction = currentPrediction();
      if (!prediction.available || prediction.missedCount === 0) return;
      state.missed = { recordId: prediction.lastRecord.id, count: prediction.missedCount - 1 };
      saveMissed(state.missed);
      renderCalendar();
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

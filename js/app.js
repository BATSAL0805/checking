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

  // ---------- state ----------

  var state = {
    records: loadRecords(),
    profile: loadProfile(),
    calendarMonth: new Date(todayDate().getFullYear(), todayDate().getMonth(), 1),
    selectedTags: []
  };

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

    if (!prediction.available) {
      valueEl.textContent = "데이터가 더 필요합니다";
      nextEl.textContent = "-";
      ovulEl.textContent = "-";
      banner.hidden = true;
      basisEl.hidden = true;
      return;
    }

    nextEl.textContent = formatDate(prediction.nextPeriodStart);
    ovulEl.textContent = formatDate(prediction.ovulationDate);

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
    } else {
      banner.hidden = true;
    }
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

    Array.prototype.forEach.call(gridEl.querySelectorAll(".day-cell:not(.empty)"), function (cell) {
      cell.addEventListener("click", function () {
        onDateClick(cell.getAttribute("data-date"));
      });
    });

    renderCountdown(prediction);
    renderStats(prediction);
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

    if (id) {
      var idx = state.records.findIndex(function (r) { return r.id === id; });
      if (idx !== -1) {
        state.records[idx] = {
          id: id,
          startDate: startDate,
          endDate: endDate || null,
          symptoms: state.selectedTags.slice(),
          memo: memo
        };
      }
    } else {
      state.records.push({
        id: uid(),
        startDate: startDate,
        endDate: endDate || null,
        symptoms: state.selectedTags.slice(),
        memo: memo
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
  }

  // ---------- init ----------

  function init() {
    var profileAgeEl = document.getElementById("profileAge");
    if (state.profile.age != null) {
      profileAgeEl.value = state.profile.age;
    }
    profileAgeEl.addEventListener("change", function () {
      var val = parseInt(profileAgeEl.value, 10);
      state.profile.age = isNaN(val) ? null : val;
      saveProfile(state.profile);
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
        if (e.target === overlay) overlay.hidden = true;
      });
    });

    renderCalendar();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

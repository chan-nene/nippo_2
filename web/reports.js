// Daily report and supervisor report screens.
const REPORT_RENDER_BATCH_MEMBERS = 2;
const REPORT_RENDER_BATCH_ROWS = 50;
// trueにすると、全員・チーム等のフィルタにも自分の日報を含める。
const INCLUDE_SELF_IN_MEMBER_FILTERS = false;
let reportTableRenderSession = null;

const TABLE_COLUMN_WIDTH_PROFILES = Object.freeze({
  compact: { user: 88, date: 96, name: 255, detail: 450, comment: 176 },
  standard: { user: 96, date: 104, name: 285, detail: 525, comment: 176 },
  medium: { user: 104, date: 112, name: 308, detail: 585, comment: 194 },
  large: { user: 112, date: 120, name: 330, detail: 630, comment: 212 },
  xlarge: { user: 124, date: 132, name: 360, detail: 690, comment: 230 },
});
const TABLE_COLUMN_MIN_WIDTH_PROFILES = Object.freeze({
  // 折り返しを許容して画面内に収める。40pxは列幅設定の保存可能な下限。
  compact: { user: 40, date: 40, name: 40, detail: 40, comment: 40 },
  standard: { user: 40, date: 40, name: 40, detail: 40, comment: 40 },
  medium: { user: 40, date: 40, name: 40, detail: 40, comment: 40 },
  large: { user: 40, date: 40, name: 40, detail: 40, comment: 40 },
  xlarge: { user: 40, date: 40, name: 40, detail: 40, comment: 40 },
});
const TABLE_COLUMN_MAX_WIDTHS = Object.freeze({
  user: 360,
  date: 220,
  name: 520,
  detail: 720,
  comment: 620,
});
const TABLE_FONT_SIZES = Object.freeze([
  "compact",
  "standard",
  "medium",
  "large",
  "xlarge",
]);
let tableColumnResizeState = null;
let editingSnapshot = null;
let activeRichEditor = null;
let richSelectionDrag = null;
const RICH_FIELD_NAMES = { business_name: "business_name_rich_text", business_detail: "business_detail_rich_text", reply_text: "reply_rich_text", comment: "comment_rich_text" };
let periodPresetIndicatorWasVisible = false;

function getTableColumnKind(columnId) {
  if (["user", "date", "name", "detail"].includes(columnId)) return columnId;
  return String(columnId || "").startsWith("comment:") ? "comment" : "";
}

function clampTableColumnWidth(columnKind, width, fontSize = state.fontSize) {
  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const minimum = TABLE_COLUMN_MIN_WIDTH_PROFILES[size][columnKind];
  const maximum = TABLE_COLUMN_MAX_WIDTHS[columnKind];
  return Math.round(Math.min(maximum, Math.max(minimum, Number(width))));
}

function normalizeColumnWidthProfile(profile, fontSize = state.fontSize) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const normalized = {};
  Object.entries(profile).forEach(([columnId, width]) => {
    const columnKind = getTableColumnKind(columnId);
    if (!columnKind || !Number.isFinite(Number(width))) return;
    normalized[columnId] = clampTableColumnWidth(columnKind, width, size);
  });
  return normalized;
}

function parseStoredColumnWidths(rawValue, fontSize = state.fontSize) {
  let parsed = rawValue;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed || "{}");
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const sharedProfile = normalizeColumnWidthProfile(parsed, size);
  if (Object.keys(sharedProfile).length) return sharedProfile;

  // Migrate the former per-font-size format to one shared profile. Prefer the
  // profile matching the restored font size so the current appearance is kept.
  const legacyProfileOrder = [size, ...TABLE_FONT_SIZES].filter(
    (candidate, index, values) => values.indexOf(candidate) === index,
  );
  for (const legacySize of legacyProfileOrder) {
    const migratedProfile = normalizeColumnWidthProfile(parsed[legacySize], size);
    if (Object.keys(migratedProfile).length) return migratedProfile;
  }
  return {};
}

function getTableColumnWidth(columnId, columnKind, fontSize = state.fontSize) {
  const size = TABLE_COLUMN_WIDTH_PROFILES[fontSize] ? fontSize : "large";
  const storedWidth = state.columnWidths?.[columnId];
  const width = Number.isFinite(Number(storedWidth))
    ? Number(storedWidth)
    : TABLE_COLUMN_WIDTH_PROFILES[size][columnKind];
  return clampTableColumnWidth(columnKind, width, size);
}

function setTableColumnWidth(columnId, columnKind, width) {
  const fontSize = TABLE_COLUMN_WIDTH_PROFILES[state.fontSize]
    ? state.fontSize
    : "large";
  const normalizedWidth = clampTableColumnWidth(columnKind, width, fontSize);
  state.columnWidths = {
    ...(state.columnWidths || {}),
    [columnId]: normalizedWidth,
  };
  return normalizedWidth;
}

function isMemberFilterLevelEnabled(level) {
  return Array.isArray(state.memberFilterLevels) &&
    state.memberFilterLevels.includes(level) &&
    (!Array.isArray(state.memberFilterAllowedLevels) ||
      state.memberFilterAllowedLevels.includes(level));
}

function memberMatchesTeamEntry(member, teamEntry) {
  return Array.isArray(member?.team_path) &&
    member.team_path.some((team) => team?.team_id === teamEntry?.team_id);
}

function getAvailableTeamFilterScopes() {
  if (state.restrictToSelf) return [];
  const members = Array.isArray(state.viewableMembers)
    ? state.viewableMembers
    : [];
  const scopes = [];
  const seenTeamIds = new Set();
  ["department", "section"].forEach((level) => {
    if (!isMemberFilterLevelEnabled(level)) return;
    members.forEach((member) => {
      (Array.isArray(member?.team_path) ? member.team_path : []).forEach((team) => {
        const teamLevel = team?.team_type;
        const teamId = String(team?.team_id || "");
        if (teamLevel !== level || !teamId || seenTeamIds.has(teamId)) return;
        seenTeamIds.add(teamId);
        const memberCount = members.filter(
          (candidate) =>
            (INCLUDE_SELF_IN_MEMBER_FILTERS || candidate.employee_id !== state.employeeId) &&
            memberMatchesTeamEntry(candidate, team),
        ).length;
        if (memberCount > 0) {
          scopes.push({
            level,
            scope: `team:${teamId}`,
            team,
            memberCount,
          });
        }
      });
    });
  });
  return scopes;
}

function isAvailableMemberScope(scope) {
  if (state.restrictToSelf) {
    return scope === "self" && state.canInputOwnReport;
  }
  if (scope === "self") {
    return state.canInputOwnReport;
  }
  if (scope === "member") return isMemberFilterLevelEnabled("member");
  if (scope?.startsWith("team:")) {
    return getAvailableTeamFilterScopes().some((item) => item.scope === scope);
  }
  if (scope === "all") return hasCommentTargetMembers();
  return ["team", "subordinates"].includes(scope);
}

function clearSubordinateFilters() {
  state.memberScope = getDefaultMemberScope();
  state.selectedSubordinateId = "";
  updateSubordinateFilterUi();
  renderTable();
}

function getDefaultMemberScope() {
  if (state.restrictToSelf) return "self";
  if (hasCommentTargetMembers()) return "all";
  if (state.canInputOwnReport) return "self";
  return getAvailableTeamFilterScopes()[0]?.scope || "all";
}

function hasCommentTargetMembers() {
  return state.viewableMembers.some((member) =>
    Array.isArray(member.relations) &&
    member.relations.includes("assigned_subordinate"),
  );
}

function setMemberScope(scope) {
  if (
    !["all", "self", "team", "subordinates"].includes(scope) &&
    !scope?.startsWith("team:")
  ) return;
  if (!isAvailableMemberScope(scope)) return;
  state.memberScope =
    scope === "all" && !hasCommentTargetMembers() && state.canInputOwnReport
      ? getDefaultMemberScope()
      : scope;
  state.selectedSubordinateId = "";
  updateSubordinateFilterUi();
  renderTable();
}

function toggleSubordinateFilter(employeeId) {
  if (
    state.restrictToSelf ||
    !employeeId ||
    !isMemberFilterLevelEnabled("member")
  ) return;
  state.selectedSubordinateId = employeeId;
  state.memberScope = "member";
  updateSubordinateFilterUi();
  renderTable();
}

function updateSubordinateFilterUi() {
  const container = $("bossSearchControl");
  if (!container) return;

  container.querySelectorAll("[data-member-scope]").forEach((button) => {
    const isActive =
      !state.selectedSubordinateId && button.dataset.memberScope === state.memberScope;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  container.querySelectorAll(".member-switch-button[data-id]").forEach((btn) => {
    const isActive =
      state.memberScope === "member" && btn.dataset.id === state.selectedSubordinateId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function getDirtyCounts() {
  const reports = state.reportChanges.size;
  const comments = state.commentChanges.size + (state.conversationChanges?.size || 0);
  return {
    reports,
    comments,
    total: reports + comments,
  };
}

function syncChrome() {
  const model = getChromeModel();
  renderActionButtons(model.actions);
  const settingsSaveButton = $("saveSettingsButton");
  const settingsIndicator = settingsSaveButton?.querySelector?.(
    ".save-pending-indicator",
  );
  if (settingsIndicator) {
    const settingsDirty =
      typeof isSettingsDirty === "function" && isSettingsDirty();
    settingsIndicator.classList.toggle("hidden", !settingsDirty);
  }
  syncNativeUnsavedState(hasUnsavedChanges());
}

function syncNativeUnsavedState(hasUnsavedChanges) {
  if (lastNativeUnsavedState === hasUnsavedChanges) return;
  lastNativeUnsavedState = hasUnsavedChanges;
  const setter = window.pywebview?.api?.set_unsaved_changes;
  if (typeof setter !== "function") return;

  Promise.resolve(setter(hasUnsavedChanges)).catch(() => {
    lastNativeUnsavedState = null;
  });
}

function syncMissingCommentCount() {
  const button = $("showMissingCommentsButton");
  if (!button) return;
  button.classList.toggle("hidden", state.isDirector);
  if (state.isDirector) return;
  const summary = getMissingCommentSummary();
  const isLoading = state.busyAction === "load";
  const controlsBusy = state.isBusy && state.busyAction !== "save";
  button.disabled = controlsBusy || summary.count === 0;
  let label = button.querySelector(":scope > .missing-filter-label");
  let badge = button.querySelector(":scope > .missing-count-badge");
  if (!label) {
    label = document.createElement("span");
    label.className = "missing-filter-label";
    label.textContent = "未コメントのみ";
    button.appendChild(label);
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "missing-count-badge";
    badge.setAttribute("aria-hidden", "true");
    button.appendChild(badge);
  }
  badge.className = [
    "missing-count-badge",
    isLoading ? "is-loading" : "",
    !isLoading && summary.hasOverdue ? "is-overdue" : "",
    !isLoading && summary.count === 0 ? "is-empty" : "",
  ]
    .filter(Boolean)
    .join(" ");
  badge.textContent = isLoading ? "…" : `${summary.count}日`;
  let statusDescription = "未コメントの日報はありません。対象0日";
  if (isLoading) {
    statusDescription = "未コメントの日数を確認中";
  } else if (summary.count > 0) {
    const overdueDescription = summary.hasOverdue
      ? "、過去日の未コメントあり"
      : "";
    statusDescription = `未コメントの日報だけを表示、対象${summary.count}日${overdueDescription}`;
  }
  const todayScopeDescription = state.includeTodayInMissingComments
    ? "今日分を含む"
    : "今日分は対象外";
  const rangeDescription =
    summary.rangeStart &&
    summary.rangeEnd &&
    summary.rangeStart <= summary.rangeEnd
      ? `、${formatNavigationDate(summary.rangeStart, true)}から${formatNavigationDate(summary.rangeEnd, true)}までを集計（${todayScopeDescription}）`
      : `、${todayScopeDescription}`;
  const description = `${statusDescription}${rangeDescription}`;
  button.setAttribute("aria-label", description);
  button.removeAttribute("title");
}

function exitMissingCommentsFilter() {
  if (!state.showMissingCommentsOnly) return false;
  const previous = state.periodBeforeMissing || {
    preset: "default",
    startDate: "",
    endDate: "",
    memberScope: getDefaultMemberScope(),
    selectedSubordinateId: "",
  };
  state.activePeriodPreset = previous.preset || "default";
  // 再起動後は退避期間がないため、空の日付を渡して直近を再計算する。
  state.startDate = previous.startDate || "";
  state.endDate = previous.endDate || "";
  const selectedMemberIsAvailable = state.viewableMembers.some(
    (member) =>
      member.employee_id === previous.selectedSubordinateId &&
      member.employee_id !== state.employeeId,
  );
  const canRestoreMemberSelection =
    previous.memberScope === "member" && selectedMemberIsAvailable &&
    isMemberFilterLevelEnabled("member");
  const canRestoreScope =
    previous.memberScope !== "member" &&
    isAvailableMemberScope(previous.memberScope);
  state.memberScope =
    canRestoreMemberSelection || canRestoreScope
      ? previous.memberScope
      : getDefaultMemberScope();
  state.selectedSubordinateId = canRestoreMemberSelection
    ? previous.selectedSubordinateId
    : "";
  state.showMissingCommentsOnly = false;
  state.periodBeforeMissing = null;
  const startInput = $("startDate");
  const endInput = $("endDate");
  if (startInput) startInput.value = state.startDate;
  if (endInput) endInput.value = state.endDate;
  updateSubordinateFilterUi();
  syncPeriodPresets();
  return true;
}

function getPeriodPresetOptions() {
  return [
    ...document.querySelectorAll('.period-presets [role="radio"]'),
  ];
}

function isCurrentPeriodPreset(name) {
  if (name === "default") {
    // 直近も、今日を基準に設定された稼働日の範囲と一致するときだけ選択表示する。
    const today = getTodayJST();
    return (
      state.startDate === offsetWorkingDate(today, Number(savedSettings?.default_start_offset_days ?? -2)) &&
      state.endDate === offsetWorkingDate(today, Number(savedSettings?.default_end_offset_days ?? 0))
    );
  }
  if (!["month", "week"].includes(name)) return true;
  const range = getPresetRange(name);
  return (
    range.startDate === state.startDate &&
    range.endDate === state.endDate
  );
}

function updatePeriodPresetIndicator(options = {}) {
  const group = document.querySelector(".period-presets");
  const indicator = group?.querySelector(".period-presets-indicator");
  const immediate = options?.immediate === true;
  if (!group || !indicator) return;

  // The report panel is display:none while the user is in administration or
  // settings. Measuring the controls in that state yields offsetLeft=0, which
  // would make the indicator animate from the first button when the panel is
  // shown again. Keep the last valid position until the controls are visible.
  if (!group.getClientRects().length) {
    periodPresetIndicatorWasVisible = false;
    return;
  }

  const becameVisible = !periodPresetIndicatorWasVisible;
  periodPresetIndicatorWasVisible = true;
  const selected = getPeriodPresetOptions().find(
    (option) => option.getAttribute("aria-checked") === "true",
  );
  if (!selected) {
    if (immediate || becameVisible) {
      const previousTransition = indicator.style.transition;
      indicator.style.transition = "none";
      indicator.style.opacity = "0";
      void indicator.offsetWidth;
      indicator.style.transition = previousTransition;
    } else {
      indicator.style.opacity = "0";
    }
    return;
  }

  const applyPosition = () => {
    indicator.style.removeProperty("opacity");
    indicator.style.width = `${selected.offsetWidth}px`;
    indicator.style.transform = `translate3d(${selected.offsetLeft}px, 0, 0)`;
  };
  if (!immediate && !becameVisible) {
    applyPosition();
    return;
  }

  // Initial restoration and the first frame after returning from a hidden
  // view are placement, not user interaction. Apply them without a motion
  // transition, then restore the normal transition for subsequent changes.
  const previousTransition = indicator.style.transition;
  indicator.style.transition = "none";
  applyPosition();
  void indicator.offsetWidth;
  indicator.style.transition = previousTransition;
}

function updatePeriodPresetRovingTabindex(focusedIndex) {
  getPeriodPresetOptions().forEach((option, index) => {
    option.tabIndex = index === focusedIndex ? 0 : -1;
  });
}

function initializePeriodPresetControl() {
  const group = document.querySelector(".period-presets");
  if (!group || group.dataset.initialized === "true") return;
  group.dataset.initialized = "true";
  const options = getPeriodPresetOptions();
  options.forEach((option, index) => {
    option.addEventListener("click", () => {
      applyPreset(option.dataset.periodMode);
    });
    option.addEventListener("keydown", (event) => {
      const optionCount = options.length;
      let nextIndex = -1;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % optionCount;
      if (event.key === "ArrowLeft") {
        nextIndex = (index - 1 + optionCount) % optionCount;
      }
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = optionCount - 1;
      if (nextIndex >= 0) {
        event.preventDefault();
        movePeriodPresetFocus(nextIndex);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        applyPreset(option.dataset.periodMode);
      }
    });
  });
  window.addEventListener("resize", () => updatePeriodPresetIndicator(), {
    passive: true,
  });
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => updatePeriodPresetIndicator()).observe(group);
  }
  syncPeriodPresets({ immediate: true });
  requestAnimationFrame(() => updatePeriodPresetIndicator({ immediate: true }));
}

function movePeriodPresetFocus(index) {
  const options = getPeriodPresetOptions();
  if (!options.length) return;
  const step = index >= options.length ? 1 : -1;
  let next = index;
  for (let count = 0; count < options.length; count += 1) {
    const option = options[next];
    if (option && !option.hasAttribute("data-disabled") && !option.disabled) {
      updatePeriodPresetRovingTabindex(next);
      option.focus({ preventScroll: true });
      return;
    }
    next = (next + step + options.length) % options.length;
  }
}

function syncPeriodPresets(config = {}) {
  const controlsBusy = state.isBusy && state.busyAction !== "save";
  if ($("showHolidays")) $("showHolidays").disabled = controlsBusy;
  if ($("commentColumnButton")) {
    $("commentColumnButton").disabled = controlsBusy;
    $("showAllCommentColumns").disabled = controlsBusy;
    $("commentColumnOptions").querySelectorAll("input").forEach(input => { input.disabled = controlsBusy; });
    if (controlsBusy) closeCommentColumnMenu();
  }
  $("reportPanel")?.classList.toggle(
    "is-missing-mode",
    state.showMissingCommentsOnly,
  );
  const exitMissingButton = $("exitMissingCommentsButton");
  if (exitMissingButton) exitMissingButton.disabled = controlsBusy;
  const presets = {
    month: $("presetMonthButton"),
    week: $("presetWeekButton"),
    default: $("presetDefaultButton"),
  };
  Object.entries(presets).forEach(([name, button]) => {
    if (!button) return;
    const isActive =
      !state.showMissingCommentsOnly &&
      state.activePeriodPreset === name &&
      isCurrentPeriodPreset(name);
    button.disabled = controlsBusy;
    button.classList.toggle("is-active", isActive);
    button.dataset.state = isActive ? "on" : "off";
    button.setAttribute("aria-checked", String(isActive));
    button.setAttribute("aria-pressed", String(isActive));
  });
  const options = getPeriodPresetOptions();
  const activeIndex = options.findIndex(
    (option) => option.getAttribute("aria-checked") === "true",
  );
  const fallbackIndex = options.findIndex(
    (option) => option.dataset.periodMode === state.activePeriodPreset,
  );
  updatePeriodPresetRovingTabindex(
    activeIndex >= 0 ? activeIndex : fallbackIndex >= 0 ? fallbackIndex : options.length - 1,
  );
  updatePeriodPresetIndicator(config);
  const missingButton = $("showMissingCommentsButton");
  if (missingButton) {
    missingButton.classList.toggle("hidden", state.isDirector);
    missingButton.disabled = controlsBusy;
    missingButton.classList.toggle(
      "is-active",
      state.showMissingCommentsOnly,
    );
    missingButton.setAttribute(
      "aria-pressed",
      String(state.showMissingCommentsOnly),
    );
  }
  syncMissingCommentCount();
  syncPeriodDateRange();
  syncPeriodShiftButtons();
}

function syncPeriodDateRange() {
  const rangeElement = $("periodDateRange");
  if (!rangeElement) return;
  const rangeText = formatPeriodDateRange(state.startDate, state.endDate);
  if (rangeElement.textContent !== rangeText) {
    rangeElement.textContent = rangeText;
  }
}

function formatPeriodDateRange(startDate, endDate) {
  if (!startDate && !endDate) return "";
  if (!startDate || !endDate) return startDate || endDate;

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const validDates = !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime());
  if (!validDates) return `${startDate} ~ ${endDate}`;
  if (state.activePeriodPreset === "month" && !state.showMissingCommentsOnly) {
    return `${start.getUTCMonth() + 1}月`;
  }
  if (startDate === endDate) return formatCompactPeriodDate(start);

  const differentYear = start.getUTCFullYear() !== end.getUTCFullYear();
  return `${formatCompactPeriodDate(start, differentYear)} ~ ${formatCompactPeriodDate(end, differentYear)}`;
}

function formatCompactPeriodDate(date, includeYear = false) {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const weekday = ["week", "default"].includes(state.activePeriodPreset)
    ? `(${["日", "月", "火", "水", "木", "金", "土"][date.getUTCDay()]})`
    : "";
  return includeYear
    ? `${date.getUTCFullYear()}/${month}/${day}${weekday}`
    : `${month}/${day}${weekday}`;
}

function syncPeriodShiftButtons() {
  const controlsBusy = state.isBusy && state.busyAction !== "save";
  const stepLabel = $("periodShiftStepLabel");
  if (stepLabel) stepLabel.textContent = getPeriodShiftStepLabel();
  const navigation = document.querySelector("#reportPanel .period-navigation");
  if (navigation instanceof HTMLElement) {
    navigation.classList.toggle(
      "is-missing-range",
      state.showMissingCommentsOnly,
    );
    navigation.setAttribute(
      "aria-label",
      state.showMissingCommentsOnly
        ? `${getPeriodShiftStepLabel()}。期間移動は利用できません`
        : "表示期間を移動",
    );
  }
  [
    ["periodPrevButton", -1],
    ["periodNextButton", 1],
  ].forEach(([buttonId, direction]) => {
    const button = $(buttonId);
    if (!button) return;
    const isPrevious = direction < 0;
    const label = getDateShiftDirectionLabel(isPrevious);
    const labelElement = button.querySelector(".period-shift-label");
    if (labelElement) labelElement.textContent = label;
    const target = getShiftedPeriodRange(direction);
    const hasTarget = Boolean(target.startDate && target.endDate);
    const description = hasTarget
      ? `${label}、${formatNavigationDateRangeDescription(target.startDate, target.endDate)}`
      : `${label}へ移動`;
    button.disabled =
      controlsBusy || state.showMissingCommentsOnly || !hasTarget;
    button.setAttribute("aria-label", description);
    button.removeAttribute("title");
  });
}

function getPeriodShiftStepLabel() {
  if (state.showMissingCommentsOnly) {
    return "未コメント";
  }
  if (state.activePeriodPreset === "month") return "1か月";
  if (state.activePeriodPreset === "week") return "1週間";
  return "1稼働日";
}

function getChromeModel() {
  const dirty = getDirtyCounts();
  return {
    dirty,
    actions: {
      refresh: getRefreshButtonModel(),
      save: getSaveButtonModel(dirty),
    },
  };
}

function getRefreshButtonModel() {
  if (state.busyAction === "load") {
    return {
      disabled: true,
      icon: "loader",
      label: "取得中...",
      ariaLabel: "最新データを取得中",
    };
  }

  return {
    disabled: state.isBusy && state.busyAction !== "save",
    icon: "refresh",
    label: "最新データを取得",
    ariaLabel: "最新データを取得",
  };
}

function getSaveButtonModel(dirty) {
  if (state.busyAction === "save") {
    return {
      disabled: true,
      label: "保存",
      hasPendingChanges: dirty.total > 0,
      ariaLabel: dirty.total > 0 ? `保存 未保存${dirty.total}件` : "保存",
    };
  }

  return {
    disabled: state.isBusy || dirty.total === 0,
    label: "保存",
    hasPendingChanges: dirty.total > 0,
    ariaLabel: dirty.total > 0 ? `保存 未保存${dirty.total}件` : "保存",
  };
}

function renderActionButtons(actions) {
  renderActionButton("refreshButton", actions.refresh);
  renderActionButton("saveButton", actions.save);
}

function renderActionButton(id, model) {
  const button = $(id);
  if (!button) return;
  const signature = JSON.stringify(model);
  if (
    actionButtonSignatures.get(id) === signature &&
    button.disabled === Boolean(model.disabled)
  ) {
    return;
  }
  actionButtonSignatures.set(id, signature);
  button.disabled = model.disabled;

  const children = [];
  if (id === "refreshButton") {
    const icon = document.createElement("span");
    icon.className = "toolbar-button-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = renderToolbarIcon(model.icon);
    children.push(icon);
  } else {
    const label = document.createElement("span");
    label.className = "toolbar-button-label";
    label.textContent = model.label;
    children.push(label);
    if (model.hasPendingChanges) {
      const indicator = document.createElement("span");
      indicator.className = "save-pending-indicator";
      indicator.setAttribute("aria-hidden", "true");
      children.push(indicator);
    }
  }
  if (model.ariaLabel) {
    button.setAttribute("aria-label", model.ariaLabel);
  } else {
    button.removeAttribute("aria-label");
  }
  button.replaceChildren(...children);
}

function renderToolbarIcon(icon) {
  const paths = {
    refresh:
      '<path fill="currentColor" fill-rule="evenodd" d="M4.5 2.5a1 1 0 0 1 1 1v1.572A9.5 9.5 0 1 1 12 21.5c-4.87 0-8.882-3.663-9.435-8.384a1 1 0 0 1 1.986-.232A7.501 7.501 0 0 0 19.5 12 7.5 7.5 0 0 0 6.41 7H9a1 1 0 0 1 0 2H4.5a1 1 0 0 1-1-1.024V3.5a1 1 0 0 1 1-1Z" clip-rule="evenodd" />',
    check: '<path d="m5 12 4 4L19 6" />',
    loader: '<path d="M21 12a9 9 0 0 1-9 9" /><path d="M3 12a9 9 0 0 1 9-9" />',
  };
  const className =
    icon === "loader"
      ? "is-spinning is-loader-icon"
      : icon === "refresh"
        ? "is-refresh-icon"
        : "";
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${paths[icon] || paths.check}</svg>`;
}

const REPORT_LOAD_ERROR_MESSAGE =
  "日報データを読み込めませんでした。「再読み込み」を押してください。";
const REPORT_LOAD_FAILURE_TOAST =
  "最新データを取得できませんでした。もう一度お試しください。";
const REPORT_PARTIAL_LOAD_MESSAGE =
  "一部のデータを読み込めませんでした。もう一度「最新データを取得」を押してください。";
const REPORT_SAVE_SUCCESS_MESSAGE = "変更を保存しました。";
const REPORT_SAVE_PARTIAL_MESSAGE =
  "一部の変更を保存できませんでした。もう一度保存してください。";
const REPORT_SAVE_FAILURE_MESSAGE =
  "変更を保存できませんでした。もう一度保存してください。";
const REPORT_SAVE_CACHE_WARNING =
  "変更は保存されましたが、表示を更新できませんでした。「最新データを取得」を押してください。";

function notifyCsvLoadFailures(result) {
  const reportFailures = Array.isArray(result?.report_load_failures)
    ? result.report_load_failures
    : [];
  const commentFailures = Array.isArray(result?.comment_load_failures)
    ? result.comment_load_failures
    : [];
  const namesFor = (failures, idKey) => {
    const names = failures
      .map((failure) =>
        String(failure?.display_name || failure?.[idKey] || "").trim(),
      )
      .filter(Boolean);
    return [...new Set(names)];
  };
  const reportNames = namesFor(reportFailures, "employee_id");
  const commentNames = namesFor(commentFailures, "superior_employee_id");
  if (reportNames.length) {
    notify({
      text: `日報を読み込めませんでした：${reportNames.join("、")}`,
      type: "warning",
      scope: "reports",
      source: "load",
      autoHide: false,
    });
  }
  if (commentNames.length) {
    notify({
      text: `上司コメントを読み込めませんでした：${commentNames.join("、")}`,
      type: "warning",
      scope: "reports",
      source: "load",
      autoHide: false,
    });
  }
  return reportFailures.length > 0 || commentFailures.length > 0;
}

async function refreshData() {
  finishEditing();
  if (!(await confirmDiscardUnsaved("最新データを取得"))) return;
  discardDirtyEdits();
  await loadData({ preserveDirty: false, forceRefresh: true, manual: true });
}

function discardDirtyEdits() {
  state.reportChanges.clear();
  state.commentChanges.clear();
  state.conversationChanges?.clear();
  syncChrome();
}

function clearReportViewForLoadFailure() {
  disposeReportTableRender();
  state.rows = [];
  if (state.reportChanges.size === 0) state.reportRevision = "";
  state.viewableMembers = [];
  state.currentTeam = [];
  state.hasInitializedReportView = false;
  state.missingCommentDates = null;
  state.missingCommentRangeStart = "";
  state.missingCommentRangeEnd = "";
  state.missingCommentMemberCounts = {};
  $("tableWrap")?.replaceChildren();
  showMain(false);
}

async function loadData({
  silent = false,
  preserveDirty = true,
  preserveTableScroll = false,
  forceRefresh = false,
  manual = false,
  transition = false,
  viewSequence,
} = {}) {
  finishEditing();
  const requestSequence = ++state.loadRequestSequence;
  const hadData = Boolean(state.hasInitializedReportView);
  if (transition || !hadData) {
    disposeReportTableRender();
    showMain(false);
    $("tableWrap")?.replaceChildren();
  }
  clearScreenLoadError("reports");
  setBusy(true, "load");
  let result;
  try {
    result = await window.pywebview.api.load_data({
      start_date: state.startDate || null,
      end_date: state.endDate || null,
      period_preset: state.showMissingCommentsOnly
        ? "missing"
        : state.legacyLoadPreset || state.activePeriodPreset || null,
      force_refresh: forceRefresh,
    });
  } catch (error) {
    if (requestSequence !== state.loadRequestSequence) return;
    console.error("日報データの読み込みに失敗しました。", error);
    const hasDisplay = hadData && !transition;
    if (transition || !hadData) {
      clearReportViewForLoadFailure();
    }
    if (hasDisplay) {
      if (manual) {
        notify({
          text: REPORT_LOAD_FAILURE_TOAST,
          type: "error",
          source: "load",
        });
      }
    } else {
      showScreenLoadError(
        "reports",
        REPORT_LOAD_ERROR_MESSAGE,
        "error",
      );
    }
    return { ok: false };
  } finally {
    if (requestSequence === state.loadRequestSequence) setBusy(false);
  }
  if (requestSequence !== state.loadRequestSequence) return;
  if (
    viewSequence !== undefined &&
    viewSequence !== viewSwitchSequence
  ) {
    return { ok: false, stale: true };
  }
  if (!result.ok) {
    if (result.storage_error === true) {
      state.accessDenied = false;
      if (transition || !hadData) clearReportViewForLoadFailure();
      showScreenLoadError(
        "reports",
        result.message || REPORT_LOAD_ERROR_MESSAGE,
        "error",
      );
      return { ok: false, storageError: true };
    }
    const accessDenied =
      result.access_denied === true || result.employee_registered === false;
    if (accessDenied) {
      state.accessDenied = true;
      clearReportViewForLoadFailure();
      updateViewAvailability();
      updateViewChrome();
      showScreenLoadError(
        "reports",
        result.message || REPORT_LOAD_ERROR_MESSAGE,
        "error",
      );
      return { ok: false, accessDenied: true };
    }
    const hasDisplay = hadData && !transition;
    if (transition || !hadData) {
      clearReportViewForLoadFailure();
    }
    if (hasDisplay) {
      if (manual) {
        notify({
          text: REPORT_LOAD_FAILURE_TOAST,
          type: "error",
          source: "load",
        });
      }
    } else {
      showScreenLoadError(
        "reports",
        REPORT_LOAD_ERROR_MESSAGE,
        "error",
      );
    }
    return { ok: false };
  }
  state.accessDenied = false;
  if (forceRefresh && !result.cache_warning_count && !result.refresh_result?.failed) {
    state.reportRefreshPending = false;
  }
  state.displayName = result.data.display_name || result.data.employee_id || "";
  syncCurrentUserDisplay();
  state.canInputOwnReport = result.data.can_input_own_report !== false;
  state.restrictToSelf = result.data.restrict_to_self === true;
  state.isSuperior = Boolean(result.data.is_superior);
  state.isDirector = Boolean(result.data.is_director);
  state.hasInitializedReportView = true;
  state.viewableMembers = Array.isArray(result.data.viewable_members)
    ? result.data.viewable_members
    : [
        ...new Map(
          (Array.isArray(result.data.rows) ? result.data.rows : []).map((row) => [
            row.employee_id,
            {
              employee_id: row.employee_id,
              display_name: row.display_name || row.employee_id,
              relations:
                row.employee_id === result.data.employee_id &&
                state.canInputOwnReport
                  ? ["self", "same_organization"]
                  : result.data.is_superior
                    ? ["assigned_subordinate"]
                    : [],
              team_path: [],
            },
          ]),
        ).values(),
      ];
  state.currentTeam = Array.isArray(result.data.current_team)
    ? result.data.current_team
    : [];
  state.memberFilterAllowedLevels = normalizeAllowedMemberFilterLevels(
    result.data.allowed_member_filter_levels,
  );
  state.memberFilterLevels = normalizeMemberFilterLevels(
    state.memberFilterPreference, state.memberFilterLevels,
  ).filter((level) => state.memberFilterAllowedLevels.includes(level));
  state.myRank = Number.isFinite(result.data.my_rank)
    ? result.data.my_rank
    : 9999;
  state.rows = Array.isArray(result.data.rows) ? result.data.rows : [];
  hydrateConversations();
  // 下書きを引き継ぐ再表示では、その下書きの基準となった版も維持する。
  if (!preserveDirty || state.reportChanges.size === 0) {
    state.reportRevision = result.data.report_revision || "";
  }
  state.holidayDates = new Set(
    Array.isArray(result.data.holiday_dates) ? result.data.holiday_dates : [],
  );
  state.cacheGeneration = Number(result.cache_generation || 0);
  const missingCommentSummary = result.data.missing_comment_summary;
  applyMissingCommentSummary(missingCommentSummary);
  state.startDate = result.data.start_date || state.startDate;
  state.endDate = result.data.end_date || state.endDate;
  state.legacyLoadPreset = "";
  $("startDate").value = state.startDate;
  $("endDate").value = state.endDate;
  syncPeriodPresets();
  if (preserveDirty) {
    reapplyDirtyEditsToRows();
  }
  state.expandedReplies.clear();

  const container = $("bossSearchControl");
  if (container) {
    const individualFilterEnabled =
      state.restrictToSelf || isMemberFilterLevelEnabled("member");
    const selfButton = $("showSelfButton");
    selfButton?.classList.toggle("hidden", !state.canInputOwnReport);
    const subordinates = state.viewableMembers.map((member) => ({
      id: member.employee_id,
      name: member.display_name || member.employee_id,
      relations: Array.isArray(member.relations) ? member.relations : [],
    }));
    const commentTargetMembers = subordinates.filter((member) =>
      member.relations.includes("assigned_subordinate"),
    );

    const filterMembers = state.restrictToSelf ? [] : subordinates.filter(
      (member) => member.id !== state.employeeId,
    );
    const availableIds = new Set(filterMembers.map((sub) => sub.id));
    if (!individualFilterEnabled || !availableIds.has(state.selectedSubordinateId)) {
      state.selectedSubordinateId = "";
      if (state.memberScope === "member") state.memberScope = "all";
    }
    if (!state.canInputOwnReport && state.memberScope === "self") {
      state.memberScope = getDefaultMemberScope();
    }
    if (!isAvailableMemberScope(state.memberScope)) {
      state.memberScope = getDefaultMemberScope();
    }

    const existingTeamFilters = container.querySelectorAll("[data-team-filter]");
    existingTeamFilters.forEach((button) => button.remove());
    const existingTags = container.querySelectorAll(
      ".member-switch-button[data-id]",
    );
    existingTags.forEach((t) => t.remove());

    getAvailableTeamFilterScopes().forEach(({ level, scope, team }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "member-switch-button";
      btn.dataset.memberScope = scope;
      btn.dataset.teamFilter = team.team_id;
      const label = document.createElement("span");
      label.className = "relative";
      const teamName = team.team_name || MEMBER_FILTER_LABELS[level];
      label.textContent = teamName;
      btn.appendChild(label);
      btn.setAttribute("aria-label", teamName);
      btn.title = teamName;
      btn.setAttribute("aria-pressed", "false");
      container.appendChild(btn);
    });

    const individualMembers = individualFilterEnabled ? filterMembers : [];
    individualMembers.forEach((sub) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "member-switch-button";
      btn.dataset.id = sub.id;
      const label = document.createElement("span");
      label.className = "relative";
      label.textContent = sub.name;
      btn.appendChild(label);
      btn.setAttribute("aria-label", sub.name);
      btn.title = sub.name;
      btn.setAttribute("aria-pressed", "false");
      container.appendChild(btn);
    });

    const allButton = $("showAllSubordinatesButton");
    if (allButton) {
      setMemberFilterButtonLabel(allButton, "全員");
      allButton.classList.toggle("hidden", commentTargetMembers.length === 0);
    }
    updateSubordinateFilterUi();
  }

  updateViewAvailability();
  updateViewChrome();
  syncChrome();
  renderTable({ preserveScroll: preserveTableScroll });
  showMain(true);
  const refreshResult = result.refresh_result || {};
  const warningCount = Number(result.data.load_warning_count || 0);
  const refreshFailed = Number(refreshResult.failed || 0);
  const dataLoadPartial = result.data_load_status === "partial";
  // A successful API response is authoritative for the current read. Remove
  // stale load toasts before adding only the failures from this response.
  clearLoadToasts("reports");
  const hasCsvFailures = notifyCsvLoadFailures(result);
  if (dataLoadPartial || refreshFailed > 0 || warningCount > 0) {
    showScreenLoadError("reports", REPORT_PARTIAL_LOAD_MESSAGE, "warning");
  } else {
    clearScreenLoadError("reports");
    if (manual) {
      notify({
        text: "最新データを取得しました。",
        type: "success",
      });
    }
  }
  return {
    ok: true,
    partial: dataLoadPartial || refreshFailed > 0 || warningCount > 0 || hasCsvFailures,
  };
}

function setMemberFilterButtonLabel(button, text) {
  if (!button) return;
  let label = button.querySelector(":scope > .relative");
  if (!label) {
    label = document.createElement("span");
    label.className = "relative";
    button.replaceChildren(label);
  }
  label.textContent = text;
}

function reapplyDirtyEditsToRows() {
  reapplyConversationDrafts();
  if (state.reportChanges.size === 0 && state.commentChanges.size === 0) return;

  const rowsByKey = new Map(
    state.rows.map((row) => [`${row.employee_id}|${row.date}`, row]),
  );

  for (const [key, change] of state.reportChanges.entries()) {
    const row = rowsByKey.get(key);
    if (!row) continue;

    Object.entries(change.fields).forEach(([field, value]) => {
      row[field] = value;
    });
    for (const [superiorId, reply] of Object.entries(change.replies)) {
      const cell = (row.comments || []).find(
        (candidate) => candidate.superior_employee_id === superiorId,
      );
      if (cell) { cell.reply_text = reply; cell.reply_rich_text = change.replyFormats?.[superiorId]; }
    }
  }

  for (const change of state.commentChanges.values()) {
    const row = rowsByKey.get(
      `${change.subordinate_employee_id}|${change.date}`,
    );
    if (!row) continue;

    const cell = (row.comments || []).find(
      (candidate) =>
        candidate.superior_employee_id === change.superior_employee_id,
    );
    if (!cell) continue;

    cell.comment = change.comment;
    cell.comment_rich_text = change.comment_rich_text;
  }
}

async function handleDateChange() {
  finishEditing();
  const startDate = $("startDate").value;
  const endDate = $("endDate").value;
  if (!startDate || !endDate || startDate > endDate) return;
  if (!(await confirmDiscardUnsaved("日付範囲を変更"))) {
    $("startDate").value = state.startDate;
    $("endDate").value = state.endDate;
    return;
  }
  discardDirtyEdits();
  state.startDate = startDate;
  state.endDate = endDate;
  state.activePeriodPreset = "";
  state.showMissingCommentsOnly = false;
  state.periodBeforeMissing = null;
  state.legacyLoadPreset = "";
  await loadData();
  persistUiState();
}

async function shiftDateRange(direction) {
  finishEditing();
  const startInput = $("startDate");
  const endInput = $("endDate");
  const currentStartDate = startInput.value || state.startDate;
  const currentEndDate = endInput.value || state.endDate;
  if (!currentStartDate || !currentEndDate) return;

  const { startDate, endDate } = getShiftedPeriodRange(
    direction,
    currentStartDate,
    currentEndDate,
  );
  if (!startDate || !endDate) return;

  if (!(await confirmDiscardUnsaved("日付範囲を変更"))) return;
  discardDirtyEdits();
  startInput.value = startDate;
  endInput.value = endDate;
  state.startDate = startDate;
  state.endDate = endDate;
  state.showMissingCommentsOnly = false;
  state.periodBeforeMissing = null;
  state.legacyLoadPreset = "";
  await loadData();
  persistUiState();
}

function getShiftedPeriodRange(
  direction,
  startDate = state.startDate,
  endDate = state.endDate,
) {
  const step = direction < 0 ? -1 : 1;
  if (!startDate || !endDate) return { startDate: "", endDate: "" };
  if (state.activePeriodPreset === "month") {
    return getCalendarMonthRange(startDate, step);
  }
  if (state.activePeriodPreset === "default") {
    return {
      startDate: offsetWorkingDate(startDate, step),
      endDate: offsetWorkingDate(endDate, step),
    };
  }
  const deltaDays = state.activePeriodPreset === "week" ? step * 7 : step;
  return {
    startDate: offsetDateStr(startDate, deltaDays),
    endDate: offsetDateStr(endDate, deltaDays),
  };
}

function offsetWorkingDate(dateStr, workingDays) {
  const direction = workingDays < 0 ? -1 : 1;
  let remaining = Math.abs(workingDays);
  let candidate = dateStr;
  while (remaining > 0) {
    candidate = offsetDateStr(candidate, direction);
    const day = new Date(`${candidate}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6 && !state.holidayDates.has(candidate)) {
      remaining -= 1;
    }
  }
  return candidate;
}

function formatDisplayDateHTML(value) {
  if (!value) return "";
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(value));
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const day = d.getUTCDay();
  const weekdayClass =
    day === 0 ? "date-weekday-sun" : day === 6 ? "date-weekday-sat" : "";
  const weekday = weekdayClass
    ? `<span class="${weekdayClass}">${days[day]}</span>`
    : days[day];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} <span class="date-weekday">(${weekday})</span>`;
}

async function applyPreset(presetName) {
  if (presetName !== "missing" && !PERIOD_MODES.includes(presetName)) return;
  finishEditing();
  const action = presetName === "missing" ? "表示を切り替え" : "日付範囲を変更";
  if (!(await confirmDiscardUnsaved(action))) return;
  discardDirtyEdits();

  if (presetName === "missing" && state.showMissingCommentsOnly) {
    exitMissingCommentsFilter();
  } else if (presetName === "missing") {
    state.periodBeforeMissing = {
      preset: state.activePeriodPreset,
      startDate: state.startDate,
      endDate: state.endDate,
      memberScope: state.memberScope,
      selectedSubordinateId: state.selectedSubordinateId,
    };
    const range = getPresetRange("missing");
    state.startDate = range.startDate;
    state.endDate = range.endDate;
    state.showMissingCommentsOnly = true;
    // 自分自身にはコメントしないため、自分のみ表示では未コメントが
    // 必ず空になる。未コメント表示中だけ全員へ切り替え、解除時には
    // 保存した自分のみの状態を復元する。
    if (state.periodBeforeMissing.memberScope === "self") {
      state.memberScope = "all";
      state.selectedSubordinateId = "";
    } else {
      // その他の担当者フィルタは未コメント条件と組み合わせて維持する。
      state.memberScope = state.periodBeforeMissing.memberScope;
      state.selectedSubordinateId = state.periodBeforeMissing.selectedSubordinateId;
    }
    updateSubordinateFilterUi();
  } else {
    const range = getPresetRange(presetName);
    state.activePeriodPreset = presetName;
    state.startDate = range.startDate;
    state.endDate = range.endDate;
    state.showMissingCommentsOnly = false;
    state.periodBeforeMissing = null;
  }
  state.legacyLoadPreset = "";
  $("startDate").value = state.startDate;
  $("endDate").value = state.endDate;
  await loadData({ transition: presetName === "missing" });
  persistUiState();
}

function getPresetRange(presetName, today = getTodayJST()) {
  if (presetName === "month") {
    return getCalendarMonthRange(today);
  }
  if (presetName === "week") {
    return getMondayBasedWeekRange(today);
  }
  if (presetName === "previousWorkday") {
    // 休日設定を含む判定はバックエンドで行い、loadData の応答で日付を確定する。
    return { startDate: "", endDate: "" };
  }
  if (presetName === "today") {
    return { startDate: today, endDate: today };
  }
  if (presetName === "previousWeek") {
    return getMondayBasedWeekRange(today, -1);
  }
  if (presetName === "thisWeek") {
    return getMondayBasedWeekRange(today);
  }
  if (presetName === "previousMonth") {
    return getCalendarMonthRange(today, -1);
  }
  if (presetName === "thisMonth") {
    return getCalendarMonthRange(today);
  }
  if (presetName === "missing") {
    const configuredStart =
      state.missingCommentRangeStart || state.missingCommentStartDate;
    const defaultPastDays = Math.max(
      0,
      Number.parseInt($("defaultStartOffsetDays")?.value || "0", 10) || 0,
    );
    const startDate = configuredStart || offsetDateStr(today, -defaultPastDays);
    const endDate =
      state.missingCommentRangeEnd ||
      (state.includeTodayInMissingComments
        ? today
        : offsetDateStr(today, -1));
    return {
      startDate: [startDate <= endDate ? startDate : endDate, offsetDateStr(today, -365)].sort().at(-1),
      endDate,
    };
  }
  if (presetName === "default") {
    // 会社休日を含む稼働日計算はバックエンドで行い、応答で日付を確定する。
    return { startDate: "", endDate: "" };
  }
  return { startDate: "", endDate: "" };
}

function getMondayBasedWeekRange(referenceDate, weekOffset = 0) {
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  const daysFromMonday = (reference.getUTCDay() + 6) % 7;
  const startDate = offsetDateStr(
    referenceDate,
    weekOffset * 7 - daysFromMonday,
  );
  return { startDate, endDate: offsetDateStr(startDate, 6) };
}

function getCalendarMonthRange(referenceDate, monthOffset = 0) {
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  const start = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth() + monthOffset,
      1,
    ),
  );
  const nextMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  nextMonth.setUTCDate(0);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: nextMonth.toISOString().slice(0, 10),
  };
}

function getReportBatchEnd(rows, start, minimum = 0) {
  let end = start;
  let members = 0;
  const useRowThreshold = !state.showMissingCommentsOnly
    && ["week", "default"].includes(state.activePeriodPreset);
  const minimumRows = Math.max(minimum, useRowThreshold ? REPORT_RENDER_BATCH_ROWS : 0);
  const minimumMembers = useRowThreshold ? 0 : REPORT_RENDER_BATCH_MEMBERS;
  // Finish the current employee's rows even when that crosses the row threshold.
  while (end < rows.length && (members < minimumMembers || end < start + minimumRows)) {
    const employeeId = rows[end].employee_id;
    do { end += 1; } while (end < rows.length && rows[end].employee_id === employeeId);
    members += 1;
  }
  return end;
}

function disposeReportTableRender() {
  const session = reportTableRenderSession;
  if (!session) return;
  reportTableRenderSession = null;
  if (session.frame !== null) cancelAnimationFrame(session.frame);
  session.observer?.disconnect();
  session.scroll.removeEventListener("scroll", session.schedule);
}

function appendNextReportBatch(session = reportTableRenderSession) {
  if (!session || session !== reportTableRenderSession || !session.scroll.isConnected
      || session.loaded >= session.rows.length) return false;
  const end = getReportBatchEnd(session.rows, session.loaded);
  session.body.insertAdjacentHTML("beforeend",
    renderReportRows(session.rows.slice(session.loaded, end), session.context, session.loaded > 0));
  session.loaded = end;
  session.schedule();
  return true;
}

function renderTable({ preserveScroll = false } = {}) {
  const wrap = $("tableWrap");
  const previous = preserveScroll ? reportTableRenderSession : null;
  const scrollState = preserveScroll ? captureTableScrollState(wrap) : null;
  disposeReportTableRender();
  const rows = getFilteredRows();
  syncCommentColumnControl(rows);
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty">${escapeHtml(getEmptyMessage())}</div>`;
    return;
  }

  const context = createTableRenderContext(rows);
  let minimum = 0;
  if (previous) {
    const lastKey = getReportRowKey(previous.rows[previous.loaded - 1]);
    const lastIndex = rows.findIndex((row) => getReportRowKey(row) === lastKey);
    minimum = Math.max(minimum, lastIndex >= 0 ? lastIndex + 1 : previous.loaded);
  }
  if (state.pendingReplyFocusKey) {
    const focusIndex = rows.findIndex((row) =>
      state.pendingReplyFocusKey.startsWith(`${row.employee_id}|${row.date}|`));
    minimum = Math.max(minimum, focusIndex + 1);
  }
  const loaded = getReportBatchEnd(rows, 0, minimum);
  wrap.innerHTML = renderTableShell({
    header: renderTableHeader(context),
    body: renderReportRows(rows.slice(0, loaded), context),
    columns: context.columns,
  });
  const scroll = wrap.querySelector(".table-scroll");
  const session = {
    rows, context, loaded, scroll, body: scroll.querySelector("tbody"),
    frame: null, observer: null, schedule: null,
  };
  session.schedule = () => {
    if (session !== reportTableRenderSession || session.frame !== null
        || session.loaded >= rows.length) return;
    session.frame = requestAnimationFrame(() => {
      session.frame = null;
      if (session !== reportTableRenderSession || !scroll.isConnected || scroll.clientHeight === 0) return;
      if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= scroll.clientHeight * 3) {
        appendNextReportBatch(session);
      }
    });
  };
  reportTableRenderSession = session;
  scroll.addEventListener("scroll", session.schedule, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    session.observer = new ResizeObserver(session.schedule);
    session.observer.observe(scroll);
    session.observer.observe(session.body);
  }
  restoreTableScrollState(wrap, scrollState);
  focusPendingReplyEditor();
  session.schedule();
}

function captureTableScrollState(wrap) {
  const scroll = wrap.querySelector(".table-scroll");
  if (!(scroll instanceof HTMLElement)) return null;

  const viewport = scroll.getBoundingClientRect();
  const header = scroll.querySelector("thead");
  const contentTop = header
    ? header.getBoundingClientRect().bottom
    : viewport.top;
  const anchors = [...scroll.querySelectorAll("tbody tr[data-scroll-key]")]
    .map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        key: row.dataset.scrollKey || "",
        offsetTop: rect.top - contentTop,
        rect,
      };
    })
    .filter(
      ({ key, rect }) =>
        key && rect.bottom > contentTop + 1 && rect.top < viewport.bottom - 1,
    )
    .slice(0, 12)
    .map(({ key, offsetTop }) => ({ key, offsetTop }));

  return {
    scrollTop: scroll.scrollTop,
    scrollLeft: scroll.scrollLeft,
    anchors,
  };
}

function restoreTableScrollState(wrap, scrollState) {
  if (!scrollState) return;
  const scroll = wrap.querySelector(".table-scroll");
  if (!(scroll instanceof HTMLElement)) return;

  scroll.scrollTop = scrollState.scrollTop;
  scroll.scrollLeft = scrollState.scrollLeft;

  for (const anchor of scrollState.anchors) {
    const target = [...scroll.querySelectorAll("tbody tr[data-scroll-key]")].find(
      (row) => row.dataset.scrollKey === anchor.key,
    );
    if (!target) continue;
    const header = scroll.querySelector("thead");
    const contentTop = header
      ? header.getBoundingClientRect().bottom
      : scroll.getBoundingClientRect().top;
    const offsetDelta =
      target.getBoundingClientRect().top - contentTop - anchor.offsetTop;
    scroll.scrollTop += offsetDelta;
    break;
  }
}

function createTableRenderContext(rows) {
  const availableComments = getApplicableCommentColumns(rows);
  const sampleComments = availableComments.filter((cell) =>
    state.memberScope === "self" || !state.hiddenCommenterIds?.has(String(cell.superior_employee_id)));

  return {
    sampleComments,
    commenterIds: sampleComments.map((cell) => cell.superior_employee_id),
    columns: createTableColumnDefinitions(availableComments).filter((column, index) =>
      column.kind !== "comment" || sampleComments.includes(availableComments[index - 4])),
  };
}

function closeCommentColumnMenu() {
  $("commentColumnMenu").classList.add("hidden");
  $("commentColumnButton").setAttribute("aria-expanded", "false");
}

function setupCommentColumnControl() {
  const control = $("commentColumnControl");
  const button = $("commentColumnButton");
  button.addEventListener("click", () => {
    finishEditing();
    const open = button.getAttribute("aria-expanded") !== "true";
    $("commentColumnMenu").classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
  });
  $("commentColumnOptions").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-commenter-id]");
    if (!input || state.isBusy) return;
    finishEditing();
    if (input.checked) state.hiddenCommenterIds.delete(input.dataset.commenterId);
    else state.hiddenCommenterIds.add(input.dataset.commenterId);
    renderTable({ preserveScroll: true });
  });
  $("showAllCommentColumns").addEventListener("click", () => {
    if (state.isBusy) return;
    finishEditing();
    state.hiddenCommenterIds.clear();
    renderTable({ preserveScroll: true });
  });
  document.addEventListener("click", (event) => {
    if (!control.contains(event.target)) closeCommentColumnMenu();
  });
  control.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommentColumnMenu();
      button.focus();
    }
  });
  control.addEventListener("focusout", (event) => {
    // Label text/padding briefly blurs the button before the label focuses
    // its checkbox. Outside pointer clicks are handled by the click listener.
    if (event.relatedTarget && !control.contains(event.relatedTarget)) closeCommentColumnMenu();
  });
}

function syncCommentColumnControl(rows) {
  const control = $("commentColumnControl");
  if (!control) return;
  const available = getApplicableCommentColumns(rows);
  const enabled = state.isSuperior && state.memberScope !== "self" && available.length > 0;
  control.classList.toggle("hidden", !enabled);
  if (!enabled) closeCommentColumnMenu();
  const options = $("commentColumnOptions");
  const signature = JSON.stringify(available.map(cell => [String(cell.superior_employee_id), cell.superior_name]));
  if (options.dataset.signature !== signature) {
    options.innerHTML = available.map(cell => {
      const id = String(cell.superior_employee_id);
      return `<label><input type="checkbox" data-commenter-id="${escapeHtml(id)}"><span>${escapeHtml(cell.superior_name)}${id === String(state.employeeId) ? "（自分）" : ""}</span></label>`;
    }).join("");
    options.dataset.signature = signature;
  }
  let visible = 0;
  options.querySelectorAll("input").forEach(input => {
    input.checked = !state.hiddenCommenterIds.has(input.dataset.commenterId);
    input.disabled = state.isBusy;
    if (input.checked) visible++;
  });
  $("commentColumnButton").textContent = `上司列：${visible === available.length ? "すべて" : `${visible}/${available.length}`} ▾`;
}

function getApplicableCommentColumns(rows) {
  const columnsByCommenter = new Map();
  rows.forEach((row) => {
    getVisibleComments(row.comments || []).forEach((cell) => {
      const commenterId = String(cell?.superior_employee_id || "");
      if (!commenterId || cell.applies === false || columnsByCommenter.has(commenterId)) {
        return;
      }
      columnsByCommenter.set(commenterId, cell);
    });
  });
  const columns = [...columnsByCommenter.values()].filter((cell) => {
    // 部長本人には部長列を常に見せる。それ以外の利用者は自分のみ表示
    // のときだけ部長列を表示し、俯瞰用の表示では列を隠す。
    if (state.isDirector || state.memberScope === "self") return true;
    return cell.superior_affiliation_type !== "director";
  });
  return columns.sort((left, right) => {
    const leftRank = Number.isFinite(Number(left?.rank))
      ? Number(left.rank)
      : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isFinite(Number(right?.rank))
      ? Number(right.rank)
      : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || String(left?.superior_employee_id || "").localeCompare(
      String(right?.superior_employee_id || ""),
    );
  });
}

function createTableColumnDefinitions(sampleComments) {
  const columns = [
    { id: "user", kind: "user", className: "user-col", label: "名前" },
    { id: "date", kind: "date", className: "date-col", label: "日付" },
    { id: "name", kind: "name", className: "name-col", label: "業務名" },
    { id: "detail", kind: "detail", className: "detail-col", label: "業務詳細" },
  ];
  sampleComments.forEach((cell, index) => {
    const isCurrentUser = cell.superior_employee_id === state.employeeId;
    columns.push({
      id: `comment:${index}`,
      kind: "comment",
      className: `comment-col${isCurrentUser ? " self-comment-col" : ""}`,
      isCurrentUser,
      label: cell.superior_name,
    });
  });
  return columns.map((column) => ({
    ...column,
    width: getTableColumnWidth(column.id, column.kind),
    minWidth: TABLE_COLUMN_MIN_WIDTH_PROFILES[state.fontSize][column.kind],
    maxWidth: TABLE_COLUMN_MAX_WIDTHS[column.kind],
  }));
}

function renderTableShell({ header, body, columns }) {
  const totalWidth = columns.reduce((total, column) => total + column.width, 0);
  const userColumn = columns.find((column) => column.kind === "user");
  const columnMarkup = columns
    .map(
      (column) =>
        `<col data-column-id="${escapeHtml(column.id)}" data-column-kind="${column.kind}" style="width:${column.width}px">`,
    )
    .join("");
  return `<div class="table-scroll">
    <div class="column-resize-guide" aria-hidden="true"></div>
    <div class="table-content" style="width:${totalWidth}px;--sticky-date-left:${userColumn.width}px">
      <table><colgroup>${columnMarkup}</colgroup>${header}<tbody>${body}</tbody></table>
    </div>
  </div>`;
}

function renderTableHeader(context) {
  return `<thead><tr>${context.columns.map(renderResizableHeader).join("")}</tr></thead>`;
}

function renderResizableHeader(column) {
  const columnId = escapeHtml(column.id);
  const label = `<span class="column-header-label">${escapeHtml(column.label)}</span>`;
  const selfLabel = column.isCurrentUser
    ? '<span class="column-header-you">自分</span>'
    : "";
  const headerContent = `<span class="column-header-content">${label}${selfLabel}</span>`;
  return `<th class="${column.className}" data-column-id="${columnId}"${column.isCurrentUser ? ' aria-label="自分の上司コメント列"' : ""}>
    ${headerContent}
    <span class="column-resize-handle" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(column.label)}列の幅を変更" aria-valuemin="${column.minWidth}" aria-valuemax="${column.maxWidth}" aria-valuenow="${column.width}" data-column-id="${columnId}" data-column-kind="${column.kind}" tabindex="0"></span>
  </th>`;
}

function getVisibleComments(comments = []) {
  if (!Array.isArray(comments)) return [];
  if (state.memberScope !== "self" || !state.isSuperior) return comments;
  return comments.filter(
    (cell) => cell?.superior_employee_id !== state.employeeId,
  );
}

function renderReportRows(rows, context, hasPreviousGroups = false) {
  const groups = [];
  rows.forEach((row) => {
    let group = groups.at(-1);
    if (!group || group.employeeId !== row.employee_id) {
      group = { employeeId: row.employee_id, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  });
  return groups
    .map((group, groupIndex) => {
      const member = getViewableMember(group.employeeId);
      const displayName =
        member?.display_name || group.rows[0]?.display_name || group.employeeId;
      return group.rows
        .map((row, idx) => renderReportRow(row, idx, context, {
          displayName,
          rowSpan: group.rows.length,
          showUserCell: idx === 0,
          isGroupEnd: idx === group.rows.length - 1,
          showGroupDivider: (hasPreviousGroups || groupIndex > 0) && idx === 0,
        }))
        .join("");
    })
    .join("");
}

function getViewableMember(employeeId) {
  return state.viewableMembers.find((member) => member.employee_id === employeeId);
}

function renderReportRow(row, idx, context, memberContext) {
  const contentCells = row.__holidayPlaceholder
    ? renderHolidayPlaceholderCells(context, row)
    : `${renderReportNameCell(row)}
    ${renderReportDetailCell(row)}
    ${renderCommentCells(row, context)}`;
  const rowClass = [
    renderReportRowClass(row, idx, context),
    memberContext.showGroupDivider ? "member-group-start" : "",
    memberContext.isGroupEnd ? "member-group-end" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<tr class="${rowClass}" data-scroll-key="${escapeHtml(getReportRowKey(row))}">
    ${renderUserCell(memberContext)}
    ${renderDateCell(row, idx, context)}
    ${contentCells}
  </tr>`;
}

function renderUserCell(memberContext) {
  if (!memberContext?.showUserCell) return "";
  return `<th class="user-col" scope="rowgroup" rowspan="${memberContext.rowSpan}">
    <div class="user-content">
      <strong>${escapeHtml(memberContext.displayName)}</strong>
    </div>
  </th>`;
}

function renderHolidayPlaceholderCells(context, row) {
  return `<td class="name-col holiday-placeholder-cell" aria-label="休日のため日報なし"></td>
    <td class="detail-col holiday-placeholder-cell"></td>
    ${renderCommentCells(row, context)}`;
}

function renderReportRowClass(row, idx, context) {
  return [
    row.is_holiday ? "holiday" : "",
    row.__holidayPlaceholder ? "holiday-placeholder" : "",
    row.is_today ? "is-today" : "",
    rowHasReportData(row) ? "has-report-data" : "is-report-empty",
    rowHasVisibleBossComment(row) ? "has-boss-comment" : "",
    rowNeedsBossComment(row) ? "needs-boss-comment" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderDateCell(row, idx, context) {
  const holidayLabel = renderHolidayLabel(row);
  const todayAriaLabel = row.is_today
    ? ` aria-label="今日、${escapeHtml(formatNavigationDate(row.date, true))}"`
    : "";
  const content = renderCellFrame(
    `<div class="date-primary">
        <span class="date-value">${formatDisplayDateHTML(row.date)}</span>
        ${holidayLabel}
      </div>
      ${row.is_today ? '<span class="date-today-label">本日</span>' : ''}
      `,
    "cell-frame-static date-content",
  );
  return `<td class="date-col"${todayAriaLabel}>${content}</td>`;
}

function renderHolidayLabel(row) {
  return row.holiday_description
    ? `<span class="cell-sub-label">${escapeHtml(row.holiday_description)}</span>`
    : "";
}

function rowHasVisibleBossComment(row) {
  return getVisibleComments(row.comments || []).some((cell) =>
    normalizeCellValue(cell.comment),
  );
}

function renderReportNameCell(row) {
  return `<td class="${renderReportTdClass("name-col", row, "business_name")}">${renderEditableCell({
    kind: "report",
    type: "name",
    field: "business_name",
    rowIndex: row.__index,
    value: row.business_name,
    editable: row.can_edit_report,
    showEmptyIcon: !row.is_holiday,
    editLabel: `${formatNavigationDate(row.date, true)}の業務名`,
  })}<span class="cell-unsaved-marker" aria-hidden="true"></span></td>`;
}

function renderReportDetailCell(row) {
  return `<td class="${renderReportTdClass("detail-col", row, "business_detail")}">${renderEditableCell({
    kind: "report",
    type: "details",
    field: "business_detail",
    rowIndex: row.__index,
    value: row.business_detail,
    editable: row.can_edit_report,
    showEmptyIcon: !row.is_holiday,
    editLabel: `${formatNavigationDate(row.date, true)}の業務詳細`,
  })}<span class="cell-unsaved-marker" aria-hidden="true"></span></td>`;
}

function renderReportTdClass(baseClass, row, field) {
  return [baseClass, isReportFieldDirty(row, field) ? "is-dirty-cell" : ""]
    .filter(Boolean)
    .join(" ");
}

function renderCommentCells(row, context) {
  const visibleComments = getVisibleComments(row.comments || []);
  const commentsByCommenter = new Map(
    visibleComments.map((cell) => [cell.superior_employee_id, cell]),
  );
  return context.commenterIds
    .map((commenterId) => {
      const cell = commentsByCommenter.get(commenterId);
      if (!cell || cell.applies === false) {
        const superiorName =
          context.sampleComments.find(
            (sample) => sample.superior_employee_id === commenterId,
          )?.superior_name || commenterId;
        return renderNotApplicableCommentCell(superiorName);
      }
      if (cell.load_failed === true || cell.available === false) {
        const superiorName = cell.superior_name || commenterId;
        return `<td class="comment-col comment-load-failed" data-load-failed="true" aria-label="${escapeHtml(superiorName)}のコメントを読み込めませんでした"><span aria-hidden="true">ー</span></td>`;
      }
      const originalIndex = row.comments.indexOf(cell);
      return renderCommentCell(row, cell, row.__index, originalIndex);
    })
    .map((markup, index) => context.commenterIds[index] === state.employeeId
      ? markup.replace('class="comment-col', 'class="comment-col self-comment-col')
      : markup)
    .join("");
}

function renderNotApplicableCommentCell(superiorName) {
  return `<td class="comment-col comment-not-applicable" aria-label="${escapeHtml(superiorName)}のコメント対象外"></td>`;
}

function getDateShiftDirectionLabel(isPrevious) {
  if (state.activePeriodPreset === "month") {
    return isPrevious ? "前月" : "翌月";
  }
  if (state.activePeriodPreset === "week") {
    return isPrevious ? "前週" : "翌週";
  }
  if (state.activePeriodPreset === "day") {
    return isPrevious ? "前日" : "翌日";
  }
  return isPrevious ? "前の期間" : "次の期間";
}

function formatNavigationDateRangeDescription(startDate, endDate) {
  const formattedStart = formatNavigationDate(startDate, true);
  if (startDate === endDate) return `${formattedStart}の表示へ移動`;
  return `${formattedStart}から${formatNavigationDate(
    endDate,
    true,
  )}の表示へ移動`;
}

function formatNavigationDate(value, includeYearAndMonth) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const weekday = weekdays[date.getUTCDay()];
  const dayAndWeekday = `${date.getUTCDate()}(${weekday})`;
  if (!includeYearAndMonth) return dayAndWeekday;
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日（${weekday}）`;
}

function focusPendingReplyEditor() {
  if (!state.pendingReplyFocusKey) return;
  const replyKey = state.pendingReplyFocusKey;
  const target = Array.from(
    document.querySelectorAll(
      ".editable-content.reply-content[data-reply-key]",
    ),
  ).find((element) => element.dataset.replyKey === replyKey);
  state.pendingReplyFocusKey = "";
  if (target instanceof HTMLElement) {
    startEditingTarget(target, { preventScroll: true });
  }
}

function getReplyKey(row, cell) {
  return `${row.employee_id}|${row.date}|${cell.superior_employee_id}`;
}

function renderCommentCell(row, cell, rowIndex, commentIndex) {
  return renderConversationCell(row, cell, rowIndex, commentIndex);
}

function createCommentRenderContext(row, cell, rowIndex, commentIndex) {
  const canEditComment = Boolean(cell.editable);
  const canAddBossComment = canEditComment;
  const hasBossComment = Boolean(String(cell.comment || "").trim());
  const hasReply = Boolean(String(cell.reply_text || "").trim());
  const canEditReply =
    row.can_edit_report && hasBossComment;

  return {
    row,
    cell,
    rowIndex,
    commentIndex,
    canEditComment,
    canAddBossComment,
    hasBossComment,
    hasReply,
    canEditReply,
    replyKey: getReplyKey(row, cell),
  };
}

function renderBossCommentCell(context) {
  const dirtyClass = isBossCommentDirty(context.row, context.cell)
    ? " is-dirty-cell"
    : "";
  return `<td class="comment-col${dirtyClass}"><div class="comment-stack">${renderBossCommentActions(context)}${renderBossCommentDisplay(context)}${renderBossReplyPreview(context)}</div></td>`;
}

function renderBossCommentActions(context) {
  if (!context.canAddBossComment) return "";
  return `<div class="cell-frame boss-comment-actions${context.hasBossComment ? " hidden" : ""}" data-boss-comment-actions="true">
    <button class="boss-comment-link" type="button" data-action="sign-comment" data-row="${context.rowIndex}" data-comment="${context.commentIndex}" aria-label="サインを記入" title="サインを記入">サイン</button>
  </div>`;
}

function renderBossCommentDisplay(context) {
  if (context.hasBossComment) {
    return renderBossCommentEditor(context, context.canEditComment);
  }

  return renderEditableCell({
    kind: "comment",
    type: "boss",
    field: "comment",
    rowIndex: context.rowIndex,
    commentIndex: context.commentIndex,
    value: "",
    editable: context.canEditComment,
    showEmptyIcon: false,
    hidden: false,
    editLabel: `${formatNavigationDate(context.row.date, true)}の${context.cell.superior_name || "上司"}へのコメント`,
  });
}

function renderBossCommentEditor(context, editable) {
  return renderEditableCell({
    kind: "comment",
    type: "boss",
    field: "comment",
    rowIndex: context.rowIndex,
    commentIndex: context.commentIndex,
    value: context.cell.comment,
    editable,
    showEmptyIcon: false,
    dirty: isBossCommentDirty(context.row, context.cell),
    editLabel: `${formatNavigationDate(context.row.date, true)}の${context.cell.superior_name || "上司"}へのコメント`,
  });
}

function renderBossReplyPreview(context) {
  if (!context.hasReply) return "";
  return `<div class="reply-section is-expanded">${renderReplyCard(context)}</div>`;
}

function renderDailyCommentCell(context) {
  return `<td class="comment-col"><div class="comment-stack">${renderBossCommentEditor(context, false)}${renderReplySection(context)}</div></td>`;
}

function renderReplySection(context) {
  if (!canShowReplySection(context)) return "";
  const stateClass = isReplySectionExpanded(context)
    ? " is-expanded"
    : " is-collapsed";
  return `<div class="reply-section${stateClass}">${renderReplyToggleButton(context)}${renderReplyCard(context)}</div>`;
}

function canShowReplySection(context) {
  return context.canEditReply || context.hasReply;
}

function isReplySectionExpanded(context) {
  return context.hasReply || state.expandedReplies.has(context.replyKey);
}

function renderReplyToggleButton(context) {
  if (!context.canEditReply || isReplySectionExpanded(context)) return "";
  return renderReplyToggleButtonMarkup(
    context.rowIndex,
    context.commentIndex,
  );
}

function renderReplyToggleButtonMarkup(rowIndex, commentIndex) {
  return `<button class="reply-toggle-button" type="button" data-action="toggle-reply" data-row="${rowIndex}" data-comment="${commentIndex}" aria-label="返信する" title="返信する"><svg class="reply-toggle-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg></button>`;
}

function renderReplyCard(context) {
  if (!isReplySectionExpanded(context)) return "";
  return `<div class="cell-frame reply-card" aria-label="部下返信"><div class="reply-card-content">${renderReplyEditor(context)}</div></div>`;
}

function renderReplyEditor(context) {
  if (!isReplySectionExpanded(context)) return "";

  return renderEditableCell({
    kind: "reply",
    type: "reply",
    rowIndex: context.rowIndex,
    commentIndex: context.commentIndex,
    value: context.cell.reply_text || "",
    editable: context.canEditReply,
    showEmptyIcon: false,
    dirty: isReplyDirty(context.row, context.cell),
    dataAttributes: { "reply-key": context.replyKey },
    editLabel: `${formatNavigationDate(context.row.date, true)}の${context.cell.superior_name || "上司"}への返信`,
  });
}

function getReportRowKey(row) {
  return `${row.employee_id}|${row.date}`;
}

function getOrCreateReportChange(row) {
  const key = getReportRowKey(row);
  let change = state.reportChanges.get(key);
  if (!change) {
    change = { date: row.date, fields: {}, replies: {} };
    state.reportChanges.set(key, change);
  }
  return change;
}

function recordReportFieldChange(row, field, value, rich = plainRichText(value)) {
  row[field] = value;
  row[RICH_FIELD_NAMES[field]] = rich;
  const change = getOrCreateReportChange(row);
  change.fields[field] = value;
  change.fields[RICH_FIELD_NAMES[field]] = rich;
}

function recordReplyChange(row, cell, value, rich = plainRichText(value)) {
  cell.reply_text = value;
  cell.reply_rich_text = rich;
  const change = getOrCreateReportChange(row);
  change.replies[cell.superior_employee_id] = value;
  (change.replyFormats ||= {})[cell.superior_employee_id] = rich;
}

function recordCommentChange(row, cell, value, rich = plainRichText(value)) {
  cell.comment = value;
  cell.comment_rich_text = rich;
  state.commentChanges.set(getReplyKey(row, cell), {
    subordinate_employee_id: row.employee_id,
    superior_employee_id: cell.superior_employee_id,
    date: row.date,
    comment: value,
    comment_rich_text: rich,
  });
}

function isReportFieldDirty(row, field) {
  const change = state.reportChanges.get(getReportRowKey(row));
  return Boolean(
    change && Object.prototype.hasOwnProperty.call(change.fields, field),
  );
}

function isReplyDirty(row, cell) {
  const change = state.reportChanges.get(getReportRowKey(row));
  return Boolean(
    change &&
      Object.prototype.hasOwnProperty.call(
        change.replies,
        cell.superior_employee_id,
      ),
  );
}

function isBossCommentDirty(row, cell) {
  if (state.commentChanges.has(getReplyKey(row, cell))) return true;
  const initial = cell.messages?.find(message => message.message_kind === "initial_comment" && !message.deleted_at);
  return Boolean(initial && state.conversationChanges?.has(
    conversationDraftKey(messageOperation(row, cell, initial, initial.is_new ? "create" : "edit")),
  ));
}

function renderEditableCell({
  kind,
  type,
  field = "",
  rowIndex,
  commentIndex = "",
  value,
  editable,
  dirty = false,
  showEmptyIcon = true,
  hidden = false,
  dataAttributes = {},
  editLabel = "セル",
}) {
  const display = displayText(value);
  const empty = isEmpty(value);
  const classes = [
    "cell-frame",
    "editable-content",
    `${type}-content`,
    empty ? "is-empty" : "",
    !showEmptyIcon ? "empty-icon-hidden" : "",
    editable ? "is-editable" : "is-readonly",
    dirty ? "is-dirty" : "",
    hidden ? "hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const accessibilityAttributes = editable
    ? ` role="button" tabindex="0" aria-label="${escapeHtml(`${editLabel}を${empty ? "入力" : "編集"}`)}"`
    : "";
  const serializedDataAttributes = Object.entries(dataAttributes)
    .map(([name, attributeValue]) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) return "";
      return ` data-${name}="${escapeHtml(attributeValue)}"`;
    })
    .join("");
  const content = empty && editable && showEmptyIcon
    ? renderEmptyEditableIcon()
    : window.NippoRichText.render(getCellRichText(kind, rowIndex, commentIndex, field), display);
  return `<div class="${classes}" data-kind="${kind}" data-type="${type}" data-row="${rowIndex}" data-field="${field}" data-comment="${commentIndex}" data-editable="${editable ? "true" : "false"}"${accessibilityAttributes}${serializedDataAttributes}>${content}</div>`;
}

function renderEmptyEditableIcon() {
  return `<span class="editable-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M16.793 2.793a3.121 3.121 0 1 1 4.414 4.414l-8.5 8.5A1 1 0 0 1 12 16H9a1 1 0 0 1-1-1v-3a1 1 0 0 1 .293-.707l8.5-8.5Zm3 1.414a1.121 1.121 0 0 0-1.586 0L10 12.414V14h1.586l8.207-8.207a1.121 1.121 0 0 0 0-1.586ZM6 5a1 1 0 0 1-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 1-1-1v-4a1 1 0 1 1 2 0v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h4a1 1 0 1 1 0 2H6Z" clip-rule="evenodd" /></svg></span>`;
}

function renderCellFrame(content, extraClass = "") {
  const classes = ["cell-frame", extraClass].filter(Boolean).join(" ");
  return `<div class="${classes}">${content}</div>`;
}

function normalizeCellValue(value) {
  const text = String(value ?? "");
  return text.trim() ? text : "";
}

function displayText(value) {
  return normalizeCellValue(value);
}

function isEmpty(value) {
  return normalizeCellValue(value) === "";
}

function getRenderedTableColumn(columnId) {
  return [...document.querySelectorAll("#tableWrap col[data-column-id]")].find(
    (column) => column.dataset.columnId === columnId,
  );
}

function getRenderedColumnResizeHandle(columnId) {
  return [
    ...document.querySelectorAll("#tableWrap .column-resize-handle[data-column-id]"),
  ].find((handle) => handle.dataset.columnId === columnId);
}

function applyColumnWidthsToRenderedTable() {
  const tableContent = document.querySelector("#tableWrap .table-content");
  const columns = [
    ...document.querySelectorAll("#tableWrap col[data-column-id][data-column-kind]"),
  ];
  if (!(tableContent instanceof HTMLElement) || !columns.length) return;

  let totalWidth = 0;
  let userWidth = 0;
  columns.forEach((column) => {
    const { columnId, columnKind } = column.dataset;
    const width = getTableColumnWidth(columnId, columnKind);
    column.style.width = `${width}px`;
    totalWidth += width;
    if (columnKind === "user") userWidth = width;
    const handle = getRenderedColumnResizeHandle(columnId);
    if (handle) {
      handle.setAttribute(
        "aria-valuemin",
        String(TABLE_COLUMN_MIN_WIDTH_PROFILES[state.fontSize][columnKind]),
      );
      handle.setAttribute(
        "aria-valuemax",
        String(TABLE_COLUMN_MAX_WIDTHS[columnKind]),
      );
      handle.setAttribute("aria-valuenow", String(width));
    }
  });
  tableContent.style.width = `${totalWidth}px`;
  tableContent.style.setProperty("--sticky-date-left", `${userWidth}px`);
  activeRichEditor?.reposition();
}

function positionColumnResizeGuide(clientX) {
  const scroll = document.querySelector("#tableWrap .table-scroll");
  const guide = document.querySelector("#tableWrap .column-resize-guide");
  if (!(scroll instanceof HTMLElement) || !(guide instanceof HTMLElement)) return;
  const bounds = scroll.getBoundingClientRect();
  guide.style.left = `${clientX}px`;
  guide.style.top = `${bounds.top}px`;
  guide.style.height = `${bounds.height}px`;
}

function startColumnResize(event) {
  const handle = event.target.closest(".column-resize-handle");
  if (!(handle instanceof HTMLElement) || event.button !== 0) return;
  const { columnId, columnKind } = handle.dataset;
  const column = getRenderedTableColumn(columnId);
  if (!column || !columnKind) return;

  finishEditing();
  const startWidth = getTableColumnWidth(columnId, columnKind);
  tableColumnResizeState = {
    pointerId: event.pointerId,
    handle,
    columnId,
    columnKind,
    startX: event.clientX,
    startWidth,
  };
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("is-active");
  document.body.classList.add("is-resizing-column");
  document
    .querySelector("#tableWrap .column-resize-guide")
    ?.classList.add("is-visible");
  positionColumnResizeGuide(event.clientX);
  event.preventDefault();
}

function moveColumnResize(event) {
  if (
    !tableColumnResizeState ||
    event.pointerId !== tableColumnResizeState.pointerId
  ) {
    return;
  }
  const width = setTableColumnWidth(
    tableColumnResizeState.columnId,
    tableColumnResizeState.columnKind,
    tableColumnResizeState.startWidth + event.clientX - tableColumnResizeState.startX,
  );
  applyColumnWidthsToRenderedTable();
  tableColumnResizeState.handle.setAttribute("aria-valuenow", String(width));
  positionColumnResizeGuide(event.clientX);
}

function finishColumnResize(event) {
  if (
    !tableColumnResizeState ||
    event.pointerId !== tableColumnResizeState.pointerId
  ) {
    return;
  }
  const { handle } = tableColumnResizeState;
  if (handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId);
  }
  handle.classList.remove("is-active");
  document.body.classList.remove("is-resizing-column");
  document
    .querySelector("#tableWrap .column-resize-guide")
    ?.classList.remove("is-visible");
  tableColumnResizeState = null;
  persistUiState();
}

function handleColumnResizeKeydown(event, handle) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
  const { columnId, columnKind } = handle.dataset;
  const direction = event.key === "ArrowRight" ? 1 : -1;
  const step = event.shiftKey ? 24 : 8;
  setTableColumnWidth(
    columnId,
    columnKind,
    getTableColumnWidth(columnId, columnKind) + direction * step,
  );
  applyColumnWidthsToRenderedTable();
  persistUiState();
  event.preventDefault();
  return true;
}

// 名前・日付は標準幅を優先し、残りを業務名:業務詳細:各上司=1.5:2.5:1で配分する。
function fitColumnWidthsToViewport() {
  const scroll = document.querySelector("#tableWrap .table-scroll");
  if (!scroll || scroll.clientWidth === 0) return;
  const columns = [...scroll.querySelectorAll("col[data-column-id]")];
  if (!columns.length) return;
  const minimums = TABLE_COLUMN_MIN_WIDTH_PROFILES[state.fontSize];
  const tableStyle = getComputedStyle(scroll.querySelector("table"));
  const borderWidth = parseFloat(tableStyle.borderLeftWidth) + parseFloat(tableStyle.borderRightWidth);
  let remaining = Math.floor(scroll.clientWidth - borderWidth);
  // Manual drag limits must not become the preferred widths for automatic fitting.
  const defaults = TABLE_COLUMN_WIDTH_PROFILES[state.fontSize];
  const fixed = columns.filter(col => col.dataset.columnKind === 'user');
  // Automatic fitting keeps the full date and weekday on one line. Manual limits stay at 40px.
  const minimumTotal = columns.reduce((sum, col) => sum + (col.dataset.columnKind === "date" ? defaults.date : minimums[col.dataset.columnKind]), 0);
  const preferredExtra = fixed.reduce((sum, col) => sum + defaults[col.dataset.columnKind] - minimums[col.dataset.columnKind], 0);
  const fixedScale = preferredExtra ? Math.min(1, Math.max(0, (remaining - minimumTotal) / preferredExtra)) : 0;
  let flexible = [];
  for (const column of columns) {
    const { columnId, columnKind } = column.dataset;
    if (columnKind === "user" || columnKind === "date") {
      remaining -= setTableColumnWidth(columnId, columnKind, columnKind === "date" ? defaults.date : minimums[columnKind] + Math.floor((defaults[columnKind] - minimums[columnKind]) * fixedScale));
    } else {
      const weight = columnKind === "detail" ? 2.5 : columnKind === "name" ? 1.5 : 1;
      flexible.push({ id: columnId, kind: columnKind, weight });
    }
  }
  // 上下限に達した列を確定し、残りの幅を残りの列へ再配分する。
  while (flexible.length) {
    const totalWeight = flexible.reduce((sum, column) => sum + column.weight, 0);
    const limited = flexible.filter((column) => {
      const width = remaining * column.weight / totalWeight;
      return width < minimums[column.kind] || width > TABLE_COLUMN_MAX_WIDTHS[column.kind];
    });
    if (limited.length) {
      const available = remaining;
      for (const column of limited) {
        remaining -= setTableColumnWidth(column.id, column.kind, available * column.weight / totalWeight);
      }
      flexible = flexible.filter((column) => !limited.includes(column));
      continue;
    }
    // 累積値で丸め、端数による横スクロールを防ぐ。
    let cumulativeWeight = 0;
    let allocated = 0;
    for (const column of flexible) {
      cumulativeWeight += column.weight;
      const boundary = Math.round(remaining * cumulativeWeight / totalWeight);
      setTableColumnWidth(column.id, column.kind, boundary - allocated);
      allocated = boundary;
    }
    break;
  }
  applyColumnWidthsToRenderedTable();
  scroll.scrollLeft = 0;
  persistUiState();
}

function resetColumnWidths() {
  state.columnWidths = {};
  applyColumnWidthsToRenderedTable();
  const scroll = document.querySelector("#tableWrap .table-scroll");
  if (scroll) scroll.scrollLeft = 0;
  persistUiState();
}

function handleTableClick(event) {
  const conversationButton=event.target.closest("[data-conversation-action]");
  if(conversationButton) {handleConversationAction(conversationButton);return;}
  if (event.target.closest(".column-resize-handle")) return;
  const signComment = event.target.closest('[data-action="sign-comment"]');
  if (signComment) {
    applyBossCommentSignature(signComment);
    return;
  }
  const editComment = event.target.closest('[data-action="edit-comment"]');
  if (editComment) {
    openBossCommentEditor(editComment);
    return;
  }
  const replyToggle = event.target.closest('[data-action="toggle-reply"]');
  if (replyToggle) {
    toggleReplyEditor(replyToggle);
    return;
  }
  beginCellEditing(event);
}

function handleTableKeydown(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const resizeHandle = target.closest(".column-resize-handle");
  if (resizeHandle instanceof HTMLElement) {
    handleColumnResizeKeydown(event, resizeHandle);
    return;
  }
  if (target.matches("textarea") || target.closest(".rich-text-editor")) return;

  const editable = target.closest(".editable-content");
  if (!(editable instanceof HTMLElement)) return;

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    startEditingTarget(editable);
  }
}

function toggleReplyEditor(button) {
  const rowIndex = Number(button.dataset.row);
  const commentIndex = Number(button.dataset.comment);
  const row = state.rows[rowIndex];
  const cell = row?.comments?.[commentIndex];
  if (!row || !cell) return;

  const replyKey = getReplyKey(row, cell);
  state.expandedReplies.add(replyKey);
  state.pendingReplyFocusKey = replyKey;
  renderTable({ preserveScroll: true });
}

function openBossCommentEditor(button) {
  const { target } = getBossCommentTarget(button);
  if (!target) return;
  startEditingTarget(target, { preventScroll: true });
}

function applyBossCommentSignature(button) {
  const { row, cell } = getBossCommentTarget(button);
  if (!row || !cell) return;
  button.closest(".boss-comment-actions")?.classList.add("hidden");
  finishEditing();
  const signature = normalizeCellValue(state.commentSignature || cell.superior_name);
  recordCommentChange(row, cell, signature);
  syncChrome();
  renderTable({ preserveScroll: true });
}

function getBossCommentTarget(button) {
  const rowIndex = Number(button.dataset.row);
  const commentIndex = Number(button.dataset.comment);
  const row = state.rows[rowIndex];
  const cell = row?.comments?.[commentIndex];
  const target = document.querySelector(
    `.editable-content.boss-content[data-row="${rowIndex}"][data-comment="${commentIndex}"]`,
  );
  return { row, cell, target: target instanceof HTMLElement ? target : null };
}

function getCellRichText(kind, rowIndex, commentIndex, field) {
  if(kind === "message") return conversationMessage(rowIndex,commentIndex,field)?.message_rich_text;
  const row = state.rows[Number(rowIndex)];
  const cell = row?.comments?.[Number(commentIndex)];
  return kind === "report" ? row?.[RICH_FIELD_NAMES[field]]
    : kind === "reply" ? cell?.reply_rich_text : cell?.comment_rich_text;
}

function plainRichText(value) {
  return window.NippoRichText.serialize(window.NippoRichText.fromPlain(value).doc);
}

function handleCellPointerDown(event) {
  if (event.button !== 0 || event.target.closest('button, .column-resize-handle, .rich-text-menu')) return;
  const target = getEditableTargetFromEvent(event);
  if (!target || target.dataset.editable !== "true") return;
  // Enter the editor before selection starts, so native display selection is never discarded.
  // Capture the gesture on the stable cell wrapper, including reply-card padding.
  if (target === currentEditingElement && activeRichEditor?.dom.contains(event.target)) return;
  event.preventDefault();
  startEditingTarget(target, { preventScroll: true, pointer: true });
  const anchor = activeRichEditor.positionAt(event.clientX,event.clientY);
  activeRichEditor.select(anchor);
  richSelectionDrag = { pointerId:event.pointerId, target, anchor };
  target.setPointerCapture(event.pointerId);
}

function handleCellPointerMove(event) {
  if (!richSelectionDrag || event.pointerId !== richSelectionDrag.pointerId || !activeRichEditor) return;
  event.preventDefault();
  activeRichEditor.select(richSelectionDrag.anchor, activeRichEditor.positionAt(event.clientX,event.clientY));
}

function handleCellPointerUp(event) {
  if (!richSelectionDrag || event.pointerId !== richSelectionDrag.pointerId) return;
  const drag = richSelectionDrag;
  richSelectionDrag = null;
  if (drag.target.hasPointerCapture(event.pointerId)) drag.target.releasePointerCapture(event.pointerId);
}

function beginCellEditing(event) {
  const target = getEditableTargetFromEvent(event);
  if (!(target instanceof HTMLElement)) return;
  startEditingTarget(target, { preventScroll: true });
}

function getEditableTargetFromEvent(event) {
  if (event.target.closest('.conversation-card-header')) return null;
  const directTarget = event.target.closest(".editable-content");
  if (directTarget instanceof HTMLElement) return directTarget;

  const replyTarget = event.target.closest(".reply-card")?.querySelector(".reply-content");
  if (replyTarget instanceof HTMLElement) return replyTarget;

  const cell = event.target.closest("td.name-col, td.detail-col, td.comment-col");
  if (!(cell instanceof HTMLElement)) return null;

  const cellTarget = cell.querySelector(':scope > .editable-content, :scope > .comment-stack > .editable-content[data-kind="comment"], :scope > .comment-stack > .conversation-initial > .editable-content');
  return cellTarget instanceof HTMLElement ? cellTarget : null;
}

function startEditingTarget(target, { preventScroll = false, pointer = false } = {}) {
  if (target.dataset.editable !== "true") return;
  if (target === currentEditingElement) return;

  finishEditing();
  const row = state.rows[Number(target.dataset.row)];
  const commentCell = row?.comments?.[Number(target.dataset.comment)];
  const reportChange = row
    ? state.reportChanges.get(getReportRowKey(row))
    : null;
  const message=target.dataset.kind === "message" ? conversationMessage(target.dataset.row,target.dataset.comment,target.dataset.field) : null;
  const messageOp=message ? messageOperation(row,commentCell,message,message.is_new?"create":"edit") : null;
  const messageDraftKey=messageOp ? conversationDraftKey(messageOp) : "";
  const commentKey = row && commentCell ? getReplyKey(row, commentCell) : "";
  editingSnapshot = {
    message, messageOriginal:message ? {...message} : null, messageDraftKey, messageDraft:state.conversationChanges?.get(messageDraftKey),
    kind: target.dataset.kind,
    row,
    field: target.dataset.field || "",
    commentCell,
    originalValue:
      message ? message.message_text : target.dataset.kind === "report"
        ? normalizeCellValue(row?.[target.dataset.field])
        : target.dataset.kind === "reply"
          ? normalizeCellValue(commentCell?.reply_text)
          : normalizeCellValue(commentCell?.comment),
    reportChange: reportChange
      ? cloneReportChange(reportChange)
      : null,
    commentChange: commentKey ? state.commentChanges.get(commentKey) : null,
    commentKey,
    originalRich: getCellRichText(target.dataset.kind, target.dataset.row, target.dataset.comment, target.dataset.field),
    elementDirty: target.classList.contains("is-dirty"),
    cellDirty: Boolean(target.closest("td")?.classList.contains("is-dirty-cell")),
    elementHidden: target.classList.contains("hidden"),
    actionsHidden: Boolean(target.closest("td")?.querySelector(".boss-comment-actions")?.classList.contains("hidden")),
  };
  const actions = target.closest("td")?.querySelector(".boss-comment-actions");
  actions?.classList.add("hidden");
  target.classList.remove("hidden");
  currentEditingElement = target;
  currentEditingElement.classList.add("is-editing");

  const minHeight = getEditingBaseHeight(target);
  const rich = getCellRichText(target.dataset.kind,target.dataset.row,target.dataset.comment,target.dataset.field)
    || plainRichText(target.textContent);
  target.replaceChildren();
  activeRichEditor = window.NippoRichText.create(target, rich, {
    label: target.getAttribute("aria-label")?.replace(/を(?:入力|編集)$/, ""),
    minHeight,
    onChange: (text, document) => {
      const row = state.rows[Number(target.dataset.row)];
      if (target.dataset.kind === "message") {
        const cell=row.comments[Number(target.dataset.comment)];
        recordMessageChange(row,cell,message,text,document);
        target.closest("td")?.querySelector(".boss-comment-actions")?.classList.toggle("hidden",!canSignConversation(cell));
        const dirty = isConversationMessageDirty(row,cell,message);
        target.closest(".conversation-card")?.classList.toggle("is-dirty", dirty);
        target.classList.toggle("is-dirty", dirty);
      } else if (target.dataset.kind === "report") {
        recordReportFieldChange(row,target.dataset.field,text,document);
        markReportFieldDirtyUi(target.dataset.row,target.dataset.field);
      } else {
        const cell=row.comments[Number(target.dataset.comment)];
        if (target.dataset.kind === "reply") recordReplyChange(row,cell,text,document);
        else recordCommentChange(row,cell,text,document);
        markCurrentEditingDirtyUi();
      }
      syncChrome();
    },
    onCancel: cancelEditing,
    onTab: moveEditingFocus,
    onLimit: () => notify({text:"文章は20,000文字以内にしてください。",type:"warning"}),
  });
  if (!pointer) activeRichEditor.focusEnd();
}

function cancelEditing() {
  if (!currentEditingElement) return;
  const editingElement = currentEditingElement;
  const snapshot = editingSnapshot;
  activeRichEditor?.destroy();
  activeRichEditor = null;
  if (snapshot?.message) {
    Object.assign(snapshot.message,snapshot.messageOriginal);
    if(snapshot.messageDraft)state.conversationChanges.set(snapshot.messageDraftKey,snapshot.messageDraft);
    else state.conversationChanges.delete(snapshot.messageDraftKey);
    syncConversationInitial(snapshot.commentCell);
    editingElement.closest(".conversation-card")?.classList.toggle("is-dirty", isConversationMessageDirty(snapshot.row,snapshot.commentCell,snapshot.message));
  }
  if (snapshot?.row) {
    if (snapshot.kind === "report") { snapshot.row[snapshot.field] = snapshot.originalValue; snapshot.row[RICH_FIELD_NAMES[snapshot.field]] = snapshot.originalRich; }
    if (snapshot.kind === "reply" && snapshot.commentCell) { snapshot.commentCell.reply_text = snapshot.originalValue; snapshot.commentCell.reply_rich_text = snapshot.originalRich; }
    if (snapshot.kind === "comment" && snapshot.commentCell) { snapshot.commentCell.comment = snapshot.originalValue; snapshot.commentCell.comment_rich_text = snapshot.originalRich; }
    const reportKey = getReportRowKey(snapshot.row);
    if (snapshot.reportChange) state.reportChanges.set(reportKey, snapshot.reportChange);
    else state.reportChanges.delete(reportKey);
    if (snapshot.commentKey) {
      if (snapshot.commentChange) state.commentChanges.set(snapshot.commentKey, snapshot.commentChange);
      else state.commentChanges.delete(snapshot.commentKey);
    }
  }
  editingElement.innerHTML =
    isEmpty(snapshot?.originalValue) && !editingElement.classList.contains("empty-icon-hidden")
      ? renderEmptyEditableIcon()
      : window.NippoRichText.render(snapshot?.originalRich,snapshot?.originalValue || "");
  editingElement.classList.toggle("is-empty", isEmpty(snapshot?.originalValue));
  editingElement.classList.toggle("is-dirty", Boolean(snapshot?.elementDirty));
  editingElement.closest("td")?.classList.toggle("is-dirty-cell", Boolean(snapshot?.cellDirty));
  editingElement.classList.toggle("hidden", Boolean(snapshot?.elementHidden));
  editingElement.closest("td")?.querySelector(".boss-comment-actions")?.classList.toggle(
    "hidden",
    Boolean(snapshot?.actionsHidden),
  );
  editingElement.classList.remove("is-editing");
  discardEmptyNewReply(editingElement);
  currentEditingElement = null;
  editingSnapshot = null;
  syncChrome();
}

function moveEditingFocus(direction) {
  if (!activeRichEditor) return;
  const nextTarget = findHorizontalEditableTarget(direction);
  finishEditing();
  if (nextTarget instanceof HTMLElement) {
    startEditingTarget(nextTarget);
  }
}

function findHorizontalEditableTarget(direction) {
  let editables = getVisibleEditableTargets();
  const current = currentEditingElement;
  const index = editables.indexOf(current);
  if (index < 0) return null;
  while (direction > 0 && index === editables.length - 1 && appendNextReportBatch()) {
    editables = getVisibleEditableTargets();
  }
  return editables[index + direction] || null;
}

function getVisibleEditableTargets() {
  return Array.from(
    document.querySelectorAll('#tableWrap .editable-content[data-editable="true"]'),
  ).filter((element) => element instanceof HTMLElement && element.offsetParent);
}

function getEditingBaseHeight(target) {
  if (target.closest(".comment-stack")) {
    return target.clientHeight;
  }

  const cell = target.closest("td");
  if (!(cell instanceof HTMLElement)) return target.clientHeight;

  const cellStyle = window.getComputedStyle(cell);
  const paddingTop = Number.parseFloat(cellStyle.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(cellStyle.paddingBottom) || 0;
  const availableCellHeight = cell.clientHeight - paddingTop - paddingBottom;
  return Math.max(target.clientHeight, availableCellHeight);
}

function finishEditingOnOutsideClick(event) {
  if (!currentEditingElement) return;
  if (event.target.closest(".rich-text-menu")) return;
  const frame = currentEditingElement.closest(".reply-card") || currentEditingElement;
  if (frame.contains(event.target)) return;
  finishEditing();
}

function finishEditing() {
  if (!currentEditingElement) return;
  const element = currentEditingElement;
  const data = {...element.dataset};
  activeRichEditor?.flush();
  activeRichEditor?.destroy();
  activeRichEditor = null;
  const row=state.rows[Number(data.row)],cell=row?.comments?.[Number(data.comment)];
  const text = data.kind === "message" ? conversationMessage(data.row,data.comment,data.field)?.message_text : data.kind === "report" ? row?.[data.field] : data.kind === "reply" ? cell?.reply_text : cell?.comment;
  const rich=getCellRichText(data.kind,data.row,data.comment,data.field);
  element.innerHTML = isEmpty(text) && !element.classList.contains("empty-icon-hidden")
    ? renderEmptyEditableIcon() : window.NippoRichText.render(rich,text);
  element.classList.toggle("is-empty",isEmpty(text));
  element.classList.remove("is-editing");
  const label=element.getAttribute("aria-label");
  if (label) element.setAttribute("aria-label",label.replace(/を(?:入力|編集)$/,`を${isEmpty(text)?"入力":"編集"}`));
  if (data.kind === "comment") {
    element.classList.remove("hidden");
    element.parentElement?.querySelector(".boss-comment-actions")?.classList.toggle("hidden",!isEmpty(text));
  }
  if (data.kind === "reply" && isEmpty(text) && data.replyKey) {
    state.expandedReplies.delete(data.replyKey);
    const section=element.closest(".reply-section");
    if (section) {
      section.classList.remove("is-expanded"); section.classList.add("is-collapsed");
      section.innerHTML=renderReplyToggleButtonMarkup(data.row,data.comment);
    }
  }
  richSelectionDrag = null;
  discardEmptyNewReply(element);
  if(data.kind==='message' && cell) {
    element.closest('td')?.querySelector?.('.boss-comment-actions')?.classList.toggle('hidden',!canSignConversation(cell));
  }
  currentEditingElement=null;
  editingSnapshot=null;
}

function rowHasReportData(row) {
  return Boolean(
    normalizeCellValue(row.business_name) ||
      normalizeCellValue(row.business_detail),
  );
}

function rowNeedsBossComment(row) {
  if (!row || !row.needs_review) return false;
  const myCell = (row.comments || []).find(
    (cell) => cell.superior_employee_id === state.employeeId && cell.editable,
  );
  return Boolean(myCell && (isEmpty(myCell.comment) || isBossCommentDirty(row, myCell)));
}

function rowMatchesMissingCommentFilter(row) {
  return rowNeedsBossComment(row) && (
    state.includeEmptyReportDaysInMissingComments || rowHasReportData(row)
  );
}

function getMissingCommentSummary({ useCurrentRows = false } = {}) {
  const today = getTodayJST();
  const rangeEnd =
    state.missingCommentRangeEnd ||
    (state.includeTodayInMissingComments ? today : offsetDateStr(today, -1));
  const emptySummary = {
    count: 0,
    hasOverdue: false,
    dates: [],
    rangeStart: state.missingCommentRangeStart || "",
    rangeEnd,
  };
  if (!state.isSuperior) return emptySummary;
  const rangeStart =
    state.missingCommentRangeStart || state.missingCommentStartDate || "";
  const sourceDates = useCurrentRows || !Array.isArray(state.missingCommentDates)
    ? state.rows.filter(rowMatchesMissingCommentFilter).map((row) => row.date)
    : state.missingCommentDates;
  const dates = [
    ...new Set(
      sourceDates.filter(
        (date) =>
          date &&
          date <= rangeEnd &&
          (!rangeStart || date >= rangeStart),
      ),
    ),
  ].sort();
  return {
    count: dates.length,
    hasOverdue: dates.some((date) => date < today),
    dates,
    rangeStart,
    rangeEnd,
  };
}

function getFilteredRows() {
  const indexedRows = state.rows.map((row, index) => ({
    ...row,
    __index: index,
  }));

  const filteredByDate = indexedRows.filter((row) => {
    if (state.startDate && row.date < state.startDate) return false;
    if (state.endDate && row.date > state.endDate) return false;
    return true;
  });

  const selectedId = state.selectedSubordinateId;
  const allowedIds = new Set(
    state.viewableMembers
      .filter((member) => {
        const relations = Array.isArray(member.relations) ? member.relations : [];
        const isCurrentUser = member.employee_id === state.employeeId;
        const includeCurrentUser =
          INCLUDE_SELF_IN_MEMBER_FILTERS && state.canInputOwnReport;
        if (state.restrictToSelf) {
          return state.canInputOwnReport && isCurrentUser;
        }
        if (state.memberScope === "self") {
          return state.canInputOwnReport && isCurrentUser;
        }
        if (isCurrentUser && !includeCurrentUser) return false;
        if (state.memberScope?.startsWith("team:")) {
          const teamScope = getAvailableTeamFilterScopes().find(
            (scope) => scope.scope === state.memberScope,
          );
          return Boolean(
            teamScope && memberMatchesTeamEntry(member, teamScope.team),
          );
        }
        if (state.memberScope === "team") return relations.includes("same_organization");
        if (state.memberScope === "subordinates") {
          return relations.includes("assigned_subordinate") || includeCurrentUser;
        }
        if (state.memberScope === "all") {
          return !isCurrentUser;
        }
        if (state.memberScope === "member") return member.employee_id === selectedId;
        return true;
      })
      .map((member) => member.employee_id),
  );
  let visibleRows = filteredByDate.filter((row) => allowedIds.has(row.employee_id));
  if (!state.showHolidays) {
    visibleRows = visibleRows.filter((row) => !row.is_holiday || rowHasReportData(row));
  }
  if (state.showMissingCommentsOnly) {
    visibleRows = visibleRows.filter(rowMatchesMissingCommentFilter);
  }

  const memberOrder = new Map(
    state.viewableMembers.map((member, index) => [member.employee_id, index]),
  );
  return collapseEmptyHolidayRows(visibleRows).sort((left, right) => {
    const memberDelta =
      (memberOrder.get(left.employee_id) ?? Number.MAX_SAFE_INTEGER) -
      (memberOrder.get(right.employee_id) ?? Number.MAX_SAFE_INTEGER);
    if (memberDelta) return memberDelta;
    return left.date.localeCompare(right.date);
  });
}

function collapseEmptyHolidayRows(rows) {
  const holidayDatesWithReports = new Set(
    rows
      .filter((row) => row.is_holiday && rowHasReportData(row))
      .map((row) => `${row.employee_id}|${row.date}`),
  );
  const placeholderDates = new Set();

  return rows.flatMap((row) => {
    if (!row.is_holiday) return [row];
    if (row.can_edit_report) return [row];
    const holidayKey = `${row.employee_id}|${row.date}`;
    if (rowHasReportData(row)) return [row];
    if (
      holidayDatesWithReports.has(holidayKey) ||
      placeholderDates.has(holidayKey)
    ) {
      return [];
    }
    placeholderDates.add(holidayKey);
    return [{ ...row, __holidayPlaceholder: true }];
  });
}

function getEmptyMessage() {
  if (state.showMissingCommentsOnly) {
    return "未コメントの日報はありません。";
  }
  return "条件に一致するメンバーの日報はありません。";
}

function markReportFieldDirtyUi(rowIndex, field) {
  if (rowIndex === undefined || rowIndex === "" || !field) return;
  document
    .querySelectorAll(
      `.editable-content[data-kind="report"][data-row="${rowIndex}"][data-field="${field}"]`,
    )
    .forEach((element) => {
      element.closest("td")?.classList.add("is-dirty-cell");
    });
}

function markCurrentEditingDirtyUi() {
  currentEditingElement?.classList.add("is-dirty");
  if (currentEditingElement?.dataset.kind === "comment") {
    currentEditingElement.closest("td")?.classList.add("is-dirty-cell");
  }
}

function cloneReportChange(change) {
  return {
    date: change.date,
    fields: { ...(change.fields || {}) },
    replies: { ...(change.replies || {}) },
    replyFormats: { ...(change.replyFormats || {}) },
  };
}

function createReportSaveEntry(key, change) {
  const snapshot = cloneReportChange(change);
  const update = Object.keys(snapshot.fields).length
    ? { date: snapshot.date, ...snapshot.fields }
    : null;
  const replies = Object.entries(snapshot.replies).map(
    ([superiorEmployeeId, reply]) => ({
      date: snapshot.date,
      reply_to_employee_id: superiorEmployeeId,
      reply_text: reply,
      reply_rich_text: snapshot.replyFormats[superiorEmployeeId] || plainRichText(reply),
    }),
  );
  return { key, snapshot, update, replyUpdates: replies };
}

function createCommentSaveEntry(key, change) {
  const snapshot = {
    subordinate_employee_id: change.subordinate_employee_id,
    superior_employee_id: change.superior_employee_id,
    date: change.date,
    comment: change.comment,
    comment_rich_text: change.comment_rich_text,
  };
  return {
    key,
    snapshot,
    update: {
      subordinate_employee_id: snapshot.subordinate_employee_id,
      date: snapshot.date,
      comment: snapshot.comment,
      comment_rich_text: snapshot.comment_rich_text,
    },
  };
}

function hasSameObjectEntries(left, right) {
  const leftEntries = Object.entries(left || {});
  const rightEntries = Object.entries(right || {});
  return (
    leftEntries.length === rightEntries.length &&
    rightEntries.every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(left || {}, key) &&
        left[key] === value,
    )
  );
}

function reportChangeMatchesSnapshot(change, snapshot) {
  return Boolean(change) &&
    change.date === snapshot.date &&
    hasSameObjectEntries(change.fields, snapshot.fields) &&
    hasSameObjectEntries(change.replies, snapshot.replies) &&
    hasSameObjectEntries(change.replyFormats, snapshot.replyFormats);
}

function commentChangeMatchesSnapshot(change, snapshot) {
  return Boolean(change) &&
    change.subordinate_employee_id === snapshot.subordinate_employee_id &&
    change.superior_employee_id === snapshot.superior_employee_id &&
    change.date === snapshot.date &&
    change.comment === snapshot.comment && change.comment_rich_text === snapshot.comment_rich_text;
}

function applySavedReportEntry(entry) {
  const currentChange = state.reportChanges.get(entry.key);
  if (currentChange && !reportChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    return;
  }
  const row = state.rows.find(
    (candidate) =>
      candidate.employee_id === state.employeeId &&
      candidate.date === entry.snapshot.date,
  );
  if (!row) return;
  Object.entries(entry.snapshot.fields).forEach(([field, value]) => {
    row[field] = value;
  });
  const comments = Array.isArray(row.comments) ? row.comments : [];
  Object.entries(entry.snapshot.replies).forEach(([superiorId, reply]) => {
    const cell = comments.find(
      (candidate) => candidate.superior_employee_id === superiorId,
    );
    if (cell) { cell.reply_text = reply; cell.reply_rich_text = entry.snapshot.replyFormats[superiorId]; }
  });
}

function applyMissingCommentSummary(missingCommentSummary) {
  state.missingCommentDates = Array.isArray(missingCommentSummary?.dates)
    ? missingCommentSummary.dates
    : null;
  state.missingCommentRangeStart = missingCommentSummary?.start_date || "";
  state.missingCommentRangeEnd = missingCommentSummary?.end_date || "";
  state.missingCommentMemberCounts =
    missingCommentSummary?.member_counts &&
    typeof missingCommentSummary.member_counts === "object"
      ? { ...missingCommentSummary.member_counts }
      : {};
}

function applySavedReviewPatch(patch) {
  applyMissingCommentSummary(patch.missing_comment_summary);
  state.cacheGeneration = Number(patch.cache_generation || state.cacheGeneration || 0);
  const flags = new Map(patch.rows.map((row) => [`${row.employee_id}|${row.date}`, row.needs_review]));
  for (const row of state.rows) {
    const key = `${row.employee_id}|${row.date}`;
    if (flags.has(key)) row.needs_review = flags.get(key);
  }
  for (const member of state.viewableMembers || []) {
    member.pending_review_count = state.missingCommentMemberCounts[member.employee_id] || 0;
  }
}

function applySavedCommentEntry(entry) {
  const currentChange = state.commentChanges.get(entry.key);
  if (currentChange && !commentChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    return;
  }
  const row = state.rows.find(
    (candidate) =>
      candidate.employee_id === entry.snapshot.subordinate_employee_id &&
      candidate.date === entry.snapshot.date,
  );
  if (!row) return;
  const cell = (Array.isArray(row.comments) ? row.comments : []).find(
    (candidate) =>
      candidate.superior_employee_id === entry.snapshot.superior_employee_id,
  );
  if (cell) { cell.comment = entry.snapshot.comment; cell.comment_rich_text = entry.snapshot.comment_rich_text; }
}

function commitSavedReportEntry(entry) {
  const currentChange = state.reportChanges.get(entry.key);
  if (reportChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    state.reportChanges.delete(entry.key);
  }
}

function commitSavedCommentEntry(entry) {
  const currentChange = state.commentChanges.get(entry.key);
  if (commentChangeMatchesSnapshot(currentChange, entry.snapshot)) {
    state.commentChanges.delete(entry.key);
  }
}

async function saveUpdates() {
  if (state.isBusy) {
    syncChrome();
    return false;
  }

  finishEditing();
  const reportEntries = Array.from(state.reportChanges.entries()).map(
    ([key, change]) => createReportSaveEntry(key, change),
  );
  const commentEntries = Array.from(state.commentChanges.entries()).map(
    ([key, change]) => createCommentSaveEntry(key, change),
  );
  const conversationEntries=Array.from(state.conversationChanges?.entries() || []).map(([key,op])=>({key,op:{...op}}));
  if (!reportEntries.length && !commentEntries.length && !conversationEntries.length) {
    syncChrome();
    return false;
  }

  setBusy(true, "save");
  let result;
  try {
    result = await window.pywebview.api.save_updates({
      conversation_updates: conversationEntries.map(entry=>entry.op),
      user_updates: reportEntries.map(({ update }) => update).filter(Boolean),
      reply_updates: reportEntries.flatMap(({ replyUpdates }) => replyUpdates),
      report_revision: state.reportRevision,
      comment_updates: commentEntries.map(({ update }) => update),
      view_request: { start_date: state.startDate || null, end_date: state.endDate || null },
    });
  } catch (error) {
    console.error("日報の保存に失敗しました。", error);
    notify({ text: REPORT_SAVE_FAILURE_MESSAGE, type: "error" });
    return false;
  } finally {
    setBusy(false);
  }

  if (result?.no_targets === true) {
    syncChrome();
    return false;
  }

  const conversationUser=conversationEntries.some(({op})=>op.subordinate_employee_id===state.employeeId);
  const conversationComment=conversationEntries.some(({op})=>op.superior_employee_id===state.employeeId);
  const userSaved =
    (reportEntries.length === 0 && !conversationUser) || result?.result?.user?.saved === true;
  const commentSaved =
    (commentEntries.length === 0 && !conversationComment) || result?.result?.comment?.saved === true;
  const reportChangesSaved = (reportEntries.length > 0 || conversationUser) && userSaved;
  if (reportChangesSaved) state.reportRevision = result.result.user.revision;
  const commentChangesSaved = (commentEntries.length > 0 || conversationComment) && commentSaved;
  const anySaved = reportChangesSaved || commentChangesSaved;
  const allSaved = result?.ok === true && userSaved && commentSaved;
  let displayUpdateFailed = result?.cache_sync_failed === true;

  if (anySaved) {
    finishEditing();
    for(const {op} of conversationEntries) {
      const saved=op.subordinate_employee_id===state.employeeId ? userSaved : commentSaved;
      if (!saved) continue;
      commitSavedConversationOperation(op);
    }
    try {
      if (reportChangesSaved) {
        reportEntries.forEach((entry) => applySavedReportEntry(entry));
      }
      if (commentChangesSaved) {
        commentEntries.forEach((entry) => applySavedCommentEntry(entry));
      }
    } catch (error) {
      displayUpdateFailed = true;
      console.error("日報の保存結果を画面に反映できませんでした。", error);
    }
    if (reportChangesSaved) {
      reportEntries.forEach((entry) => commitSavedReportEntry(entry));
    }
    if (commentChangesSaved) {
      commentEntries.forEach((entry) => commitSavedCommentEntry(entry));
    }
    try {
      if (commentChangesSaved || conversationEntries.length) {
        let refreshResult;
        if (!conversationEntries.length && result.review_patch && !result.cache_sync_failed) {
          applySavedReviewPatch(result.review_patch);
          refreshResult = { ok: true };
          syncChrome();
          renderTable({ preserveScroll: true });
        } else {
          refreshResult = await loadData({
            silent: true,
            preserveDirty: true,
            preserveTableScroll: true,
          });
        }
        if (refreshResult?.ok !== true) {
          displayUpdateFailed = true;
          syncChrome();
          renderTable({ preserveScroll: true });
        } else if (
          state.showMissingCommentsOnly &&
          getMissingCommentSummary().count === 0
        ) {
          exitMissingCommentsFilter();
          persistUiState();
          const restoredResult = await loadData({
            silent: true,
            preserveDirty: true,
            preserveTableScroll: true,
          });
          if (restoredResult?.ok !== true) displayUpdateFailed = true;
        }
      } else {
        syncChrome();
        renderTable({ preserveScroll: true });
      }
    } catch (error) {
      displayUpdateFailed = true;
      console.error("日報の保存結果を画面に反映できませんでした。", error);
    }
  } else {
    syncChrome();
  }

  if (result?.report_conflict === true || result?.report_format === true) {
    notify({
      text: result.result?.user?.error || result.message || "日報の形式または更新状態を確認してください。",
      type: "error",
      autoHide: false,
      source: "save",
    });
    syncChrome();
    return false;
  }
  if (result?.csv_locked === true) {
    notify({
      text:
        result.message ||
        "CSVが使用中です。Excelなどで開いている場合は閉じてから、もう一度保存してください。",
      type: "error",
      autoHide: false,
      source: "save",
    });
    syncChrome();
    return false;
  }
  if (result?.csv_readonly === true) {
    notify({
      text: result.message || "CSVを読み取り専用に設定できませんでした。",
      type: "error",
      autoHide: false,
      source: "save",
    });
    syncChrome();
    return false;
  }

  if (allSaved) {
    if (displayUpdateFailed) {
      notify({
        text: REPORT_SAVE_CACHE_WARNING,
        type: "warning",
        autoHide: false,
        source: "save",
      });
    } else {
      notify({ text: REPORT_SAVE_SUCCESS_MESSAGE, type: "success" });
    }
    return true;
  }

  if (anySaved) {
    notify({ text: REPORT_SAVE_PARTIAL_MESSAGE, type: "error" });
    if (displayUpdateFailed) {
      notify({
        text: REPORT_SAVE_CACHE_WARNING,
        type: "warning",
        autoHide: false,
        source: "save",
      });
    }
    return false;
  }

  notify({ text: REPORT_SAVE_FAILURE_MESSAGE, type: "error" });
  return false;
}

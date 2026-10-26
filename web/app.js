// Shared application state, shell behavior, and startup.
const MEMBER_FILTER_LEVELS = Object.freeze(["department", "section", "member"]);
const MEMBER_FILTER_LABELS = Object.freeze({
  department: "係",
  section: "チーム",
  member: "個人",
});
function normalizeMemberFilterLevels(value, fallback = []) {
  const parseLevels = (raw) => {
    const values = Array.isArray(raw)
      ? raw.map((item) => String(item).trim())
      : String(raw ?? "")
          .replaceAll(";", ",")
          .split(",")
          .map((item) => item.trim());
    return values;
  };
  const fallbackLevels = MEMBER_FILTER_LEVELS.filter((level) =>
    parseLevels(fallback).includes(level),
  );
  if (value === "auto") return MEMBER_FILTER_LEVELS.filter((level) =>
    level !== "member" && state.memberFilterAllowedLevels.includes(level));
  if (value === undefined || value === null) return fallbackLevels;
  const rawLevels = parseLevels(value);
  const normalized = MEMBER_FILTER_LEVELS.filter((level) => rawLevels.includes(level));
  if (normalized.length || rawLevels.every((level) => !level)) return normalized;
  return fallbackLevels;
}

const state = {
  employeeId: "",
  displayName: "",
  canInputOwnReport: true,
  isSuperior: false,
  isDirector: false,
  isAdmin: false,
  restrictToSelf: false,
  activeView: "reports",
  hasInitializedReportView: false,
  memberScope: "all",
  viewableMembers: [],
  currentTeam: [],
  selectedSubordinateId: "",
  expandedReplies: new Set(),
  pendingReplyFocusKey: "",

  rows: [],
  reportRevision: "",
  reportChanges: new Map(),
  commentChanges: new Map(),
  conversationChanges: new Map(),
  startDate: "",
  activePeriodPreset: "default",
  periodBeforeMissing: null,
  legacyLoadPreset: "",
  myRank: 9999,
  isBusy: false,
  busyAction: "",
  showMissingCommentsOnly: false,
  missingCommentStartDate: "",
  includeTodayInMissingComments: false,
  includeEmptyReportDaysInMissingComments: true,
  missingCommentDates: null,
  missingCommentRangeStart: "",
  missingCommentRangeEnd: "",
  missingCommentMemberCounts: {},
  commentSignature: "",
  settingsSnapshot: "",
  colorTheme: document.documentElement.dataset.theme || "light",
  colorPalette: document.documentElement.dataset.colorPalette || "blue",
  fontSize: "standard",
  columnWidths: {},
  hiddenCommenterIds: new Set(),
  memberFilterLevels: [],
  memberFilterAllowedLevels: null,
  settingsContext: {
    has_comment_targets: false,
    current_team: [],
    affiliation_type: "",
    allowed_member_filter_levels: [...MEMBER_FILTER_LEVELS],
  },
  holidayDates: new Set(),
  accessDenied: false,
  closeApproved: false,
  loadRequestSequence: 0,
  cacheGeneration: 0,
};

const COLOR_PALETTES = Object.freeze(["blue_white", "blue", "default"]);

let currentEditingElement = null;
let uiStateSaveQueue = Promise.resolve();
let lastNativeUnsavedState = null;
let pendingConfirmation = null;
const TOAST_SCOPES = Object.freeze(["reports", "calendar", "admin", "settings"]);
const TOAST_TYPES = Object.freeze(["success", "info", "warning", "error"]);
const TOAST_VISIBLE_LIMIT = 3;
const TOAST_FADE_DURATION = 300;
const TOAST_DURATIONS = Object.freeze({
  success: 4000,
  info: 4000,
  warning: 7000,
  error: 7000,
});
const toastState = {
  screens: new Map(),
  nextId: 1,
  modalOpen: false,
};
let viewSwitchSequence = 0;
const actionButtonSignatures = new Map();
const PERIOD_MODES = ["month", "week", "default"];
const LEGACY_PERIOD_MODE_MAP = Object.freeze({
  last7days: "default",
  previousWorkday: "default",
  today: "default",
  day: "default",
  previousWeek: "week",
  thisWeek: "week",
  previousMonth: "month",
  thisMonth: "month",
});

const $ = (id) => document.getElementById(id);

function normalizeColorTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function normalizeColorPalette(value) {
  return COLOR_PALETTES.includes(value) ? value : "blue";
}

function normalizeColorAppearance(themeValue, paletteValue) {
  const theme = normalizeColorTheme(themeValue);
  const palette = normalizeColorPalette(paletteValue);
  return { theme, palette };
}

function normalizeAllowedMemberFilterLevels(value) {
  if (value === undefined || value === null) {
    return [...MEMBER_FILTER_LEVELS];
  }
  return normalizeMemberFilterLevels(value, MEMBER_FILTER_LEVELS);
}

function getSettingsContext(source = {}) {
  const context = source?.settings_context || source || {};
  return {
    has_comment_targets: context.has_comment_targets === true,
    current_team: Array.isArray(context.current_team)
      ? context.current_team
      : [],
    affiliation_type: String(context.affiliation_type || ""),
    allowed_member_filter_levels: normalizeAllowedMemberFilterLevels(
      context.allowed_member_filter_levels,
    ),
  };
}

function applySettingsContext(source = {}) {
  const context = getSettingsContext(source);
  state.settingsContext = context;
  state.memberFilterAllowedLevels = [
    ...context.allowed_member_filter_levels,
  ];

  const commentSettings = $("commentFeatureSettings");
  commentSettings?.classList.toggle(
    "hidden",
    !context.has_comment_targets,
  );

  $("memberFilterOptions")?.closest(".settings-field")?.classList.toggle(
    "hidden", context.allowed_member_filter_levels.length === 0,
  );
  document.querySelectorAll("[data-member-filter-level]").forEach((input) => {
    const allowed = context.allowed_member_filter_levels.includes(input.value);
    const option = input.closest(".member-filter-option");
    option?.classList.toggle("hidden", !allowed);
    input.disabled = !allowed;
  });
}

let colorThemeTransitionReleaseFrame = null;

function suppressColorThemeTransitions() {
  const root = document.documentElement;
  root.classList.add("is-color-theme-switching");
  void root.offsetWidth;
  if (colorThemeTransitionReleaseFrame !== null) {
    cancelAnimationFrame(colorThemeTransitionReleaseFrame);
  }
  colorThemeTransitionReleaseFrame = requestAnimationFrame(() => {
    colorThemeTransitionReleaseFrame = requestAnimationFrame(() => {
      root.classList.remove("is-color-theme-switching");
      colorThemeTransitionReleaseFrame = null;
    });
  });
}

function applyColorTheme(value) {
  const theme = normalizeColorTheme(value);
  state.colorTheme = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  syncColorThemeControls(theme);
}

function syncColorPaletteControls(palette = state.colorPalette) {
  document
    .querySelectorAll("[data-color-palette-option]")
    .forEach((input) => {
      input.checked = input.value === palette;
    });
}

function applyColorPalette(value) {
  const palette = normalizeColorPalette(value);
  state.colorPalette = palette;
  document.documentElement.dataset.colorPalette = palette;
  syncColorPaletteControls(palette);
}

function applyColorAppearance(themeValue, paletteValue) {
  const appearance = normalizeColorAppearance(themeValue, paletteValue);
  applyColorTheme(appearance.theme);
  applyColorPalette(appearance.palette);
  return appearance;
}

function previewColorPalette(value) {
  const palette = normalizeColorPalette(value);
  const appearance = normalizeColorAppearance(state.colorTheme, palette);
  suppressColorThemeTransitions();
  applyColorAppearance(appearance.theme, appearance.palette);
  window.markColorPalettePersisted?.(appearance.palette);
  syncChrome();
  persistUiState();
}

function getColorThemeOptions() {
  return [
    ...document.querySelectorAll("#colorThemeControl [role=\"radio\"]"),
  ];
}

function updateColorThemeIndicator() {
  const group = $("colorThemeControl");
  const indicator = group?.querySelector(".theme-indicator");
  const selected = getColorThemeOptions().find(
    (option) => option.getAttribute("aria-checked") === "true",
  );
  if (!indicator || !selected) return;
  indicator.style.width = `${selected.offsetWidth}px`;
  indicator.style.transform = `translate3d(${selected.offsetLeft}px, 0, 0)`;
}

function updateColorThemeRovingTabindex(focusedIndex) {
  getColorThemeOptions().forEach((option, index) => {
    option.tabIndex = index === focusedIndex ? 0 : -1;
  });
}

function syncColorThemeControls(theme = state.colorTheme) {
  const options = getColorThemeOptions();
  const selectedIndex = options.findIndex(
    (option) => option.dataset.themeOption === theme,
  );
  options.forEach((option, index) => {
    const selected = index === selectedIndex;
    option.dataset.state = selected ? "on" : "off";
    option.setAttribute("aria-checked", String(selected));
  });
  if (selectedIndex >= 0) updateColorThemeRovingTabindex(selectedIndex);
  updateColorThemeIndicator();
  document
    .querySelectorAll("[data-theme-setting-option]")
    .forEach((input) => {
      input.checked = input.value === theme;
    });
}

function setColorTheme(value, focus = true) {
  const appearance = normalizeColorAppearance(value, state.colorPalette);
  const settingsWereDirty =
    typeof isSettingsDirty === "function" && isSettingsDirty();
  suppressColorThemeTransitions();
  applyColorAppearance(appearance.theme, appearance.palette);
  window.markColorPalettePersisted?.(appearance.palette);
  if (!settingsWereDirty && typeof getSettingsDraftSnapshot === "function") {
    state.settingsSnapshot = getSettingsDraftSnapshot();
  }
  syncChrome();
  persistUiState();
  if (focus) {
    getColorThemeOptions()
      .find((option) => option.dataset.themeOption === appearance.theme)
      ?.focus({ preventScroll: true });
  }
}

function colorThemeKeyboardIndex(event, currentIndex, optionCount) {
  if (event.key === "ArrowRight") return (currentIndex + 1) % optionCount;
  if (event.key === "ArrowLeft") {
    return (currentIndex - 1 + optionCount) % optionCount;
  }
  if (event.key === "Home") return 0;
  if (event.key === "End") return optionCount - 1;
  return -1;
}

function moveColorThemeFocus(index) {
  const options = getColorThemeOptions();
  const step = index >= options.length ? 1 : -1;
  let next = index;
  for (let count = 0; count < options.length; count += 1) {
    const option = options[next];
    if (option && !option.hasAttribute("data-disabled") && !option.disabled) {
      updateColorThemeRovingTabindex(next);
      option.focus({ preventScroll: true });
      return;
    }
    next = (next + step + options.length) % options.length;
  }
}

function initializeColorThemeControl() {
  const group = $("colorThemeControl");
  if (!group) return;
  const options = getColorThemeOptions();
  options.forEach((option, index) => {
    option.addEventListener("click", () => {
      setColorTheme(option.dataset.themeOption);
    });
    option.addEventListener("keydown", (event) => {
      const nextIndex = colorThemeKeyboardIndex(event, index, options.length);
      if (nextIndex >= 0) {
        event.preventDefault();
        moveColorThemeFocus(nextIndex);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setColorTheme(option.dataset.themeOption);
      }
    });
  });
  group.addEventListener("keydown", (event) => {
    if (event.target !== group) return;
    const currentIndex = options.findIndex((option) => option.tabIndex === 0);
    const baseIndex = currentIndex < 0 ? 0 : currentIndex;
    const nextIndex = colorThemeKeyboardIndex(
      event,
      baseIndex,
      options.length,
    );
    if (nextIndex >= 0) {
      event.preventDefault();
      moveColorThemeFocus(nextIndex);
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      setColorTheme(options[baseIndex]?.dataset.themeOption);
    }
  });
  window.addEventListener("resize", updateColorThemeIndicator, { passive: true });
  if ("ResizeObserver" in window) {
    new ResizeObserver(updateColorThemeIndicator).observe(group);
  }
  syncColorThemeControls();
  requestAnimationFrame(updateColorThemeIndicator);
}

function bindEvents() {
  $("saveSettingsButton").addEventListener("click", saveSettings);
  $("settingsPanel").addEventListener("input", syncSettingsDirtyState);
  $("settingsPanel").addEventListener("change", syncSettingsDirtyState);
  $("colorPaletteOptions")?.addEventListener("change", (event) => {
    if (event.target.matches("[data-color-palette-option]")) {
      previewColorPalette(event.target.value);
    }
  });
  $("appearanceModeOptions")?.addEventListener("change", (event) => {
    if (event.target.matches("[data-theme-setting-option]")) {
      setColorTheme(event.target.value, false);
    }
  });
  $("refreshButton").addEventListener("click", refreshData);
  $("saveButton").addEventListener("click", saveUpdates);
  $("cancelActionConfirmButton").addEventListener("click", () => {
    resolveConfirmationDialog(false);
  });
  $("confirmActionConfirmButton").addEventListener("click", () => {
    resolveConfirmationDialog(true);
  });
  $("actionConfirmDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    resolveConfirmationDialog(false);
  });
  $("actionConfirmDialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) resolveConfirmationDialog(false);
  });
  $("fitColumnWidthsButton").addEventListener("click", () => {
    closeFontSizeMenu();
    fitColumnWidthsToViewport();
  });
  $("resetColumnWidthsButton").addEventListener("click", () => {
    closeFontSizeMenu();
    resetColumnWidths();
    $("fontSizeButton").focus();
  });
  $("openSettingsButton").addEventListener("click", () => void switchView("settings"));
  $("calendarViewButton").addEventListener("click", () => void switchView("calendar"));
  $("adminViewButton").addEventListener("click", () => void switchView("admin"));
  $("settingsReloadButton")?.addEventListener("click", () => {
    void reloadCurrentView();
  });
  $("reportLoadRetryButton")?.addEventListener("click", () => {
    void reloadCurrentView();
  });
  $("settingsLoadRetryButton")?.addEventListener("click", () => {
    void reloadCurrentView();
  });
  $("adminLoadRetryButton")?.addEventListener("click", () => {
    void reloadCurrentView();
  });
  $("fontSizeButton").addEventListener("click", toggleFontSizeMenu);
  $("fontSizeMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-font-size]");
    if (button) setFontSize(button.dataset.fontSize);
  });
  initializeColorThemeControl();
  initializeFlatpickrDateInputs();

  initializePeriodPresetControl();

  setupConversationUi();
  setupCommentColumnControl();
  $("showHolidays")?.addEventListener("change", () => {
    finishEditing();
    state.showHolidays = $("showHolidays").checked;
    renderTable();
    persistUiState();
  });
  $("periodPrevButton")?.addEventListener("click", () => shiftDateRange(-1));
  $("periodNextButton")?.addEventListener("click", () => shiftDateRange(1));

  const btnMissingComments = $("showMissingCommentsButton");
  if (btnMissingComments) {
    btnMissingComments.addEventListener("click", () => applyPreset("missing"));
  }
  $("exitMissingCommentsButton")?.addEventListener("click", () =>
    applyPreset("missing"),
  );

  $("bossSearchControl").addEventListener("click", (e) => {
    const scopeButton = e.target.closest("[data-member-scope]");
    if (scopeButton) {
      setMemberScope(scopeButton.dataset.memberScope);
      return;
    }
    const tag = e.target.closest(".member-switch-button[data-id]");
    if (tag) toggleSubordinateFilter(tag.dataset.id);
  });
  $("bossSearchControl").addEventListener(
    "wheel",
    (event) => {
      const list = event.currentTarget;
      if (list.scrollWidth <= list.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    },
    { passive: false },
  );
  $("tableWrap").addEventListener("click", handleTableClick);
  $("tableWrap").addEventListener("keydown", handleTableKeydown);
  $("tableWrap").addEventListener("pointerdown", handleCellPointerDown);
  $("tableWrap").addEventListener("pointermove", handleCellPointerMove);
  $("tableWrap").addEventListener("pointerup", handleCellPointerUp);
  $("tableWrap").addEventListener("pointercancel", handleCellPointerUp);
  $("tableWrap").addEventListener("pointerdown", startColumnResize);
  $("tableWrap").addEventListener("pointermove", moveColumnResize);
  $("tableWrap").addEventListener("pointerup", finishColumnResize);
  $("tableWrap").addEventListener("pointercancel", finishColumnResize);
  document.addEventListener("keydown", handleGlobalShortcut);
  $("dailyViewButton").addEventListener("click", () => void switchView("reports"));
  window.adminMasters?.initialize();
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("resize", () => positionToast());

  const messageList = $("messageList");
  messageList?.addEventListener("click", (event) => {
    if (event.target.closest(".message-close-button")) dismissToast(event);
  });
  messageList?.addEventListener("pointerover", (event) => {
    const message = event.target.closest(".message");
    if (!message || (event.relatedTarget && message.contains(event.relatedTarget))) {
      return;
    }
    pauseToast(message.dataset.toastId, "hover");
  });
  messageList?.addEventListener("pointerout", (event) => {
    const message = event.target.closest(".message");
    if (!message || (event.relatedTarget && message.contains(event.relatedTarget))) {
      return;
    }
    resumeToast(message.dataset.toastId, "hover");
  });
  messageList?.addEventListener("focusin", (event) => {
    const closeButton = event.target.closest(".message-close-button");
    if (!closeButton) return;
    pauseToast(closeButton.closest(".message")?.dataset.toastId, "focus");
  });
  messageList?.addEventListener("focusout", (event) => {
    const message = event.target.closest(".message");
    if (!message) return;
    requestAnimationFrame(() => {
      if (!message.contains(document.activeElement)) {
        resumeToast(message.dataset.toastId, "focus");
      }
    });
  });
  if (typeof MutationObserver === "function") {
    new MutationObserver(syncToastModalState).observe(document.body, {
      attributes: true,
      attributeFilter: ["open"],
      subtree: true,
    });
  }
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", syncToastModalState);
  });
  syncToastModalState();

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#fontSizeControl")) closeFontSizeMenu();

    // 編集モード中のボタン押下中は is-pressing を付けホバーを抑制
    if (currentEditingElement) document.body.classList.add("is-pressing");
  });
  document.addEventListener("click", finishEditingOnOutsideClick, true);
  document.addEventListener("mouseup", () =>
    document.body.classList.remove("is-pressing"),
  );
}

function initializeFlatpickrDateInputs() {
  if (typeof window.flatpickr !== "function") return;
  const locale = window.flatpickr.l10ns?.ja || {};
  const common = {
    locale,
    dateFormat: "Y-m-d",
    altInput: true,
    altFormat: "Y/m/d",
    altInputClass: "period-field-flatpickr-input",
    allowInput: false,
    disableMobile: true,
    onReady: (_, __, instance) => {
      instance.altInput?.setAttribute(
        "aria-label",
        instance.input.getAttribute("aria-label") || "日付",
      );
      instance.input.closest(".period-field-group")?.addEventListener("click", (event) => {
        if (event.target === instance.altInput) return;
        instance.open();
      });
    },
  };
  const settingsStart = $("missingCommentStartDate");
  if (settingsStart) window.flatpickr(settingsStart, { ...common });
}

function syncFlatpickrDateInput(inputId) {
  const input = $(inputId);
  input?._flatpickr?.setDate(input.value || null, false);
}

function restoreUiState(settings) {
  state.showHolidays = settings.ui_show_holidays !== false;
  $("showHolidays").checked = state.showHolidays;
  state.memberFilterPreference = settings.ui_member_filter_levels;
  applyColorAppearance(settings.ui_color_theme, settings.ui_color_palette);
  state.memberFilterLevels = normalizeMemberFilterLevels(
    settings.ui_member_filter_levels,
  ).filter((level) =>
    (state.memberFilterAllowedLevels || MEMBER_FILTER_LEVELS).includes(level),
  );
  const requestedPreset = String(settings.ui_period_preset ?? "default").trim();
  const supportedPresets = new Set([
    ...PERIOD_MODES,
    ...Object.keys(LEGACY_PERIOD_MODE_MAP),
    "missing",
    "",
  ]);
  const savedPreset = supportedPresets.has(requestedPreset)
    ? requestedPreset
    : "default";
  const savedStartDate = String(settings.ui_start_date || "").trim();
  const savedEndDate = String(settings.ui_end_date || "").trim();

  state.periodBeforeMissing = null;
  state.legacyLoadPreset = "";
  if (savedPreset === "missing") {
    const range = getPresetRange("missing");
    state.activePeriodPreset = "default";
    state.showMissingCommentsOnly = true;
    state.startDate = range.startDate;
    state.endDate = range.endDate;
  } else {
    const periodMode = LEGACY_PERIOD_MODE_MAP[savedPreset] ?? savedPreset;
    const restoredRange = getRestorablePeriodRange(
      periodMode,
      savedStartDate,
      savedEndDate,
    );
    const range = restoredRange || getPresetRange(periodMode);
    const hasUsableCustomRange = periodMode !== "" || Boolean(restoredRange);
    state.activePeriodPreset = hasUsableCustomRange ? periodMode : "default";
    state.showMissingCommentsOnly = false;
    state.legacyLoadPreset = "";
    state.startDate = hasUsableCustomRange ? range.startDate : "";
    state.endDate = hasUsableCustomRange ? range.endDate : "";
  }
  state.fontSize = ["compact", "standard", "medium", "large", "xlarge"].includes(
    settings.ui_font_size,
  )
    ? settings.ui_font_size
    : "standard";
  state.columnWidths = parseStoredColumnWidths(settings.ui_column_widths);
  syncPeriodPresets({ immediate: true });
  applyFontSize();
  // fillSettings runs before this initializer and cannot read the theme from
  // a settings-page control anymore. Re-baseline the draft after restoring
  // the persisted theme and all other UI state.
  if (typeof markSettingsClean === "function") markSettingsClean();
}

function persistUiState() {
  const api = window.pywebview?.api;
  if (typeof api?.save_ui_state !== "function") return;
  const periodPreset = state.showMissingCommentsOnly
    ? "missing"
    : state.activePeriodPreset;
  const shouldPersistDates =
    !state.showMissingCommentsOnly &&
    ["month", "week", ""].includes(state.activePeriodPreset);
  const payload = {
    period_preset: periodPreset,
    ui_show_holidays: state.showHolidays === true,
    start_date: shouldPersistDates ? state.startDate : "",
    end_date: shouldPersistDates ? state.endDate : "",
    font_size: state.fontSize,
    column_widths: state.columnWidths,
    ui_color_theme: state.colorTheme,
    ui_color_palette: state.colorPalette,
  };
  uiStateSaveQueue = uiStateSaveQueue
    .catch((error) => {
      console.error("表示状態の保存に失敗しました。", error);
    })
    .then(() => api.save_ui_state(payload))
    .then((result) => {
      if (result?.ok === false) {
        console.error(
          "表示状態の保存に失敗しました。",
          result.message || result,
        );
      }
      return result;
    })
    .catch((error) => {
      console.error("表示状態の保存に失敗しました。", error);
    });
}

function getRestorablePeriodRange(periodMode, startDate, endDate) {
  if (
    !isValidIsoDate(startDate) ||
    !isValidIsoDate(endDate) ||
    startDate > endDate
  ) {
    return null;
  }
  const range = { startDate, endDate };
  if (periodMode === "month") {
    const expected = getCalendarMonthRange(startDate);
    return expected.startDate === startDate && expected.endDate === endDate
      ? range
      : null;
  }
  if (periodMode === "week") {
    const expected = getMondayBasedWeekRange(startDate);
    return expected.startDate === startDate && expected.endDate === endDate
      ? range
      : null;
  }
  if (periodMode === "day") return startDate === endDate ? range : null;
  if (periodMode !== "") return null;
  const inclusiveDays =
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) -
        Date.parse(`${startDate}T00:00:00Z`)) /
        86400000,
    ) + 1;
  return inclusiveDays <= 366 ? range : null;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

// UTC+9（JST）の今日の日付を "YYYY-MM-DD" で返す

function getTodayJST() {
  const jst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
  return [
    jst.getUTCFullYear(),
    String(jst.getUTCMonth() + 1).padStart(2, "0"),
    String(jst.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// ISO日付文字列に日数を加算して ISO文字列で返す（タイムゾーン非依存）

function offsetDateStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toggleFontSizeMenu() {
  const menu = $("fontSizeMenu");
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  $("fontSizeButton").setAttribute("aria-expanded", String(willOpen));
}

function closeFontSizeMenu() {
  $("fontSizeMenu").classList.add("hidden");
  $("fontSizeButton").setAttribute("aria-expanded", "false");
}

function setFontSize(fontSize) {
  if (!["compact", "standard", "medium", "large", "xlarge"].includes(fontSize)) return;
  state.fontSize = fontSize;
  applyFontSize();
  closeFontSizeMenu();
  persistUiState();
}

function applyFontSize() {
  document.body.dataset.fontSize = state.fontSize;
  $("fontSizeButton").classList.remove("is-active");
  $("fontSizeMenu")
    .querySelectorAll("[data-font-size]")
    .forEach((button) => {
      const isActive = button.dataset.fontSize === state.fontSize;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
  });
  applyColumnWidthsToRenderedTable();
  positionToast();
}

function showSettings(visible) {
  return switchView(visible ? "settings" : "reports");
}

function showMain(visible) {
  // ツールバーは常時表示。テーブルだけ出し入れする
  $("tableWrap").classList.toggle("hidden", !visible);
}

const SCREEN_LOAD_ERROR_IDS = Object.freeze({
  reports: ["reportLoadError", "reportLoadErrorMessage"],
  calendar: ["adminLoadError", "adminLoadErrorMessage"],
  admin: ["adminLoadError", "adminLoadErrorMessage"],
  settings: ["settingsLoadError", "settingsLoadErrorMessage"],
});

function showScreenLoadError(view, message, type = "error") {
  const ids = SCREEN_LOAD_ERROR_IDS[view];
  if (!ids) return;
  const [containerId, messageId] = ids;
  const container = $(containerId);
  const messageElement = $(messageId);
  if (!container || !messageElement) return;
  const tone = type === "warning" ? "warning" : "error";
  container.classList.remove("hidden", "warning", "error");
  container.classList.add(tone);
  container.setAttribute("role", tone === "warning" ? "status" : "alert");
  container.setAttribute("aria-live", tone === "warning" ? "polite" : "assertive");
  messageElement.textContent = String(message || "");
}

function clearScreenLoadError(view) {
  const ids = SCREEN_LOAD_ERROR_IDS[view];
  if (!ids) return;
  const [containerId, messageId] = ids;
  const container = $(containerId);
  const messageElement = $(messageId);
  container?.classList.add("hidden");
  container?.classList.remove("warning", "error");
  if (messageElement) messageElement.textContent = "";
}

function hasUnsavedChanges() {
  return (
    getDirtyCounts().total > 0 ||
    Boolean(window.isSettingsDirty?.()) ||
    Boolean(window.adminMasters?.hasUnsaved?.())
  );
}

function hasUnsavedChangesForView(view) {
  if (view === "reports") return getDirtyCounts().total > 0;
  if (view === "settings") return Boolean(window.isSettingsDirty?.());
  if (view === "admin") return Boolean(window.adminMasters?.hasUnsaved?.());
  return false;
}

function discardUnsavedChangesForView(view) {
  if (view === "reports") {
    discardDirtyEdits();
    return;
  }
  if (view === "settings") {
    window.discardSettingsChanges?.();
    return;
  }
  if (view === "admin") {
    window.adminMasters?.discardUnsaved?.();
  }
}

function requestConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmTone = "primary",
  confirmationVariant = "",
}) {
  const dialog = $("actionConfirmDialog");
  if (!dialog) return Promise.resolve(false);

  if (pendingConfirmation) resolveConfirmationDialog(false);

  const confirmation = { resolve: null, previousFocus: document.activeElement };
  const promise = new Promise((resolve) => {
    confirmation.resolve = resolve;
  });
  pendingConfirmation = confirmation;

  $("actionConfirmDialogTitle").textContent = title;
  $("actionConfirmDialogDescription").textContent = description;
  $("cancelActionConfirmButton").textContent = cancelLabel;
  const confirmButton = $("confirmActionConfirmButton");
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `dialog-button ${
    confirmTone === "danger" ? "danger" : "primary"
  }`;
  if (confirmationVariant) {
    dialog.dataset.confirmationVariant = confirmationVariant;
  } else {
    delete dialog.dataset.confirmationVariant;
  }

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  syncToastModalState();
  requestAnimationFrame(() => {
    if (pendingConfirmation === confirmation) $("cancelActionConfirmButton").focus();
  });
  return promise;
}

function resolveConfirmationDialog(confirmed) {
  const confirmation = pendingConfirmation;
  if (!confirmation) return;
  pendingConfirmation = null;
  const dialog = $("actionConfirmDialog");
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
  syncToastModalState();
  delete dialog.dataset.confirmationVariant;
  confirmation.resolve(Boolean(confirmed));
  if (confirmation.previousFocus?.isConnected) confirmation.previousFocus.focus();
}

async function confirmDiscardForView(view, action) {
  if (!hasUnsavedChangesForView(view)) return true;
  return requestConfirmationDialog({
    title: "未保存の変更があります",
    description: `${action}すると、保存していない変更は失われます。`,
    confirmLabel: `破棄して${action}`,
    cancelLabel: "このまま編集を続ける",
    confirmTone: "danger",
  });
}

async function confirmDiscardUnsaved(action) {
  return confirmDiscardForView(state.activeView, action);
}

function handleBeforeUnload(event) {
  if (state.closeApproved || !hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
}

async function closeNativeWindow() {
  const api = window.pywebview?.api;
  if (typeof api?.close_window !== "function") return;
  state.closeApproved = true;
  const result = await api.close_window();
  if (!result?.ok) state.closeApproved = false;
}

function requestNativeCloseConfirmation() {
  if (!hasUnsavedChanges()) {
    void closeNativeWindow();
    return;
  }
  requestConfirmationDialog({
    title: "未保存の変更があります",
    description: "アプリを終了すると、保存していない変更は失われます。",
    confirmLabel: "破棄して終了",
    cancelLabel: "終了しない",
    confirmTone: "danger",
  }).then((confirmed) => {
    if (confirmed) void closeNativeWindow();
  });
}

function handleGlobalShortcut(event) {
  if (event.isComposing || event.keyCode === 229) return;
  if (!event.ctrlKey || event.altKey || event.key.toLowerCase() !== "s") return;
  event.preventDefault();
  if (state.isBusy) return;
  if (state.activeView === "admin") {
    return;
  }
  if (state.activeView === "calendar") return;
  if (state.activeView === "settings") {
    window.saveSettings?.();
    return;
  }
  if (getDirtyCounts().total === 0) return;
  saveUpdates();
}

function notify({
  text,
  type = "info",
  autoHide,
  scope = state.activeView,
  source = "",
  anchorId = "",
}) {
  const messageList = $("messageList");
  if (!messageList) return;

  const normalizedType = normalizeToastType(type);
  const messageText = String(text ?? "");
  const toastScope = normalizeToastScope(scope);
  const shouldAutoHide = autoHide === undefined
    ? shouldAutoHideToast(normalizedType)
    : Boolean(autoHide);
  syncToastModalState();

  let toast = findToast(toastScope, normalizedType, messageText);
  if (toast) {
    clearToastTimeouts(toast);
    toast.autoHide = shouldAutoHide;
    toast.source = source || toast.source;
    toast.anchorId = anchorId || toast.anchorId;
    toast.phase = "visible";
    toast.remainingMs = shouldAutoHide ? getToastDuration(normalizedType) : 0;
    toast.fadeRemainingMs = TOAST_FADE_DURATION;
  } else {
    toast = {
      id: String(toastState.nextId++),
      type: normalizedType,
      text: messageText,
      scope: toastScope,
      source,
      anchorId,
      autoHide: shouldAutoHide,
      phase: "visible",
      remainingMs: shouldAutoHide ? getToastDuration(normalizedType) : 0,
      fadeRemainingMs: TOAST_FADE_DURATION,
      timerId: null,
      fadeTimer: null,
      timerStartedAt: 0,
      fadeStartedAt: 0,
      pauseReasons: new Set(),
    };
    getScreenToasts(toastScope).push(toast);
  }

  renderToasts();
}

function positionToast(anchorId = "") {
  const region = $("statusRegion");
  if (!region) return;

  const anchorSelectors = {
    reports: "#reportPanel .report-toolbar",
    calendar: "#adminPanel .fiscal-calendar-toolbar",
    admin: "#adminReloadButton",
    settings: "#settingsReloadButton",
  };
  const anchor = document.querySelector(
    anchorId ? `#${anchorId}` : anchorSelectors[state.activeView],
  );
  if (!anchor) return;

  const anchorRect = anchor.getBoundingClientRect();
  const top = state.activeView === "settings"
    ? getAdminToastTop()
    : Math.max(0, Math.round(anchorRect.bottom + 8));
  region.style.setProperty("--toast-top", `${top}px`);
  region.style.setProperty("--toast-right", "8px");
}

function getAdminToastTop() {
  const adminReloadButton = $("adminReloadButton");
  const visibleAnchorBottom = adminReloadButton?.getBoundingClientRect().bottom || 0;
  if (visibleAnchorBottom > 0) return Math.round(visibleAnchorBottom + 8);

  const content = $("mainPanel");
  const adminPanel = $("adminPanel");
  if (!content || !adminPanel || !adminReloadButton) return 0;

  const contentTop = content.getBoundingClientRect().top;
  const contentPaddingTop = Number.parseFloat(getComputedStyle(content).paddingTop) || 0;
  const adminPaddingTop = Number.parseFloat(getComputedStyle(adminPanel).paddingTop) || 0;
  const reloadButtonHeight = Number.parseFloat(
    getComputedStyle(adminReloadButton).height,
  ) || 0;
  return Math.max(
    0,
    Math.round(
      contentTop + contentPaddingTop + adminPaddingTop + reloadButtonHeight + 8,
    ),
  );
}

function shouldAutoHideToast(type) {
  return type === undefined || TOAST_TYPES.includes(type);
}

function normalizeToastType(type) {
  return TOAST_TYPES.includes(type) ? type : "info";
}

function normalizeToastScope(scope) {
  return TOAST_SCOPES.includes(scope) ? scope : state.activeView;
}

function getToastDuration(type) {
  return TOAST_DURATIONS[type];
}

function getScreenToasts(scope) {
  let toasts = toastState.screens.get(scope);
  if (!toasts) {
    toasts = [];
    toastState.screens.set(scope, toasts);
  }
  return toasts;
}

function findToast(scope, type, text) {
  return (
    toastState.screens
      .get(scope)
      ?.find((item) => item.type === type && item.text === text) || null
  );
}

function clearLoadToasts(scope) {
  const toasts = toastState.screens.get(scope);
  if (!toasts) return;
  const remaining = toasts.filter((toast) => {
    const shouldRemove =
      toast.source === "load" && ["warning", "error"].includes(toast.type);
    if (shouldRemove) {
      toast.removed = true;
      clearToastTimeouts(toast);
    }
    return !shouldRemove;
  });
  if (remaining.length) toastState.screens.set(scope, remaining);
  else toastState.screens.delete(scope);
  renderToasts();
}

function findRenderedToast(toastId) {
  const messageList = $("messageList");
  if (!messageList) return null;
  return [...messageList.children].find(
    (message) => message.dataset.toastId === toastId,
  ) || null;
}

function createToastElement(toast) {
  const message = document.createElement("div");
  const messageText = document.createElement("span");
  const closeButton = document.createElement("button");

  message.dataset.toastId = toast.id;
  message.dataset.toastScope = toast.scope;
  messageText.className = "message-text";
  messageText.textContent = toast.text;
  closeButton.className = "message-close-button";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "通知を閉じる");
  closeButton.setAttribute("data-allow-when-busy", "");
  closeButton.textContent = "×";
  message.append(messageText, closeButton);
  return message;
}

function updateToastElement(message, toast) {
  message.className = `message ${toast.type}`;
  if (toast.phase === "fading") message.classList.add("is-fading");
  message.setAttribute(
    "role",
    toast.type === "warning" || toast.type === "error" ? "alert" : "status",
  );
  message.setAttribute(
    "aria-live",
    toast.type === "warning" || toast.type === "error" ? "assertive" : "polite",
  );
  message.dataset.toastId = toast.id;
  message.dataset.toastScope = toast.scope;
  message.querySelector(".message-text").textContent = toast.text;
}

function getVisibleToasts() {
  return [...toastState.screens.values()].flat()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, TOAST_VISIBLE_LIMIT);
}

function renderToasts() {
  const region = $("statusRegion");
  const messageList = $("messageList");
  if (!region || !messageList) return;

  const visibleToasts = getVisibleToasts();
  const visibleIds = new Set(visibleToasts.map((toast) => toast.id));
  [...messageList.children].forEach((message) => {
    if (!visibleIds.has(message.dataset.toastId)) message.remove();
  });
  visibleToasts.forEach((toast) => {
    const message = findRenderedToast(toast.id) || createToastElement(toast);
    updateToastElement(message, toast);
    messageList.append(message);
  });

  region.classList.toggle("modal-hidden", toastState.modalOpen);
  region.setAttribute("aria-hidden", String(toastState.modalOpen));
  positionToast(visibleToasts[0]?.anchorId || "");
  syncToastTimers();
}

function clearToastTimeouts(toast) {
  if (toast.timerId !== null) clearTimeout(toast.timerId);
  if (toast.fadeTimer !== null) clearTimeout(toast.fadeTimer);
  toast.timerId = null;
  toast.fadeTimer = null;
  toast.timerStartedAt = 0;
  toast.fadeStartedAt = 0;
}

function pauseToastTimer(toast) {
  if (toast.timerId !== null) {
    toast.remainingMs = Math.max(
      0,
      toast.remainingMs - (Date.now() - toast.timerStartedAt),
    );
    clearTimeout(toast.timerId);
    toast.timerId = null;
    toast.timerStartedAt = 0;
  }
  if (toast.fadeTimer !== null) {
    toast.fadeRemainingMs = Math.max(
      0,
      toast.fadeRemainingMs - (Date.now() - toast.fadeStartedAt),
    );
    clearTimeout(toast.fadeTimer);
    toast.fadeTimer = null;
    toast.fadeStartedAt = 0;
    findRenderedToast(toast.id)?.classList.remove("is-fading");
  }
}

function isToastDisplayed(toast) {
  return getVisibleToasts().includes(toast);
}

function canRunToastTimer(toast) {
  return toast.autoHide &&
    isToastDisplayed(toast) &&
    !toastState.modalOpen &&
    toast.pauseReasons.size === 0;
}

function syncToastTimer(toast) {
  if (!toast.autoHide || toast.removed) {
    pauseToastTimer(toast);
    return;
  }
  if (!canRunToastTimer(toast)) {
    pauseToastTimer(toast);
    return;
  }
  if (toast.phase === "fading") {
    if (toast.fadeRemainingMs <= 0) {
      removeToast(toast);
      return;
    }
    findRenderedToast(toast.id)?.classList.add("is-fading");
    if (toast.fadeTimer === null) {
      toast.fadeStartedAt = Date.now();
      toast.fadeTimer = setTimeout(() => {
        toast.fadeTimer = null;
        toast.fadeRemainingMs = 0;
        removeToast(toast);
      }, toast.fadeRemainingMs);
    }
    return;
  }
  if (toast.timerId !== null) return;
  if (toast.remainingMs <= 0) {
    beginToastFade(toast);
    return;
  }
  toast.timerStartedAt = Date.now();
  toast.timerId = setTimeout(() => {
    toast.timerId = null;
    toast.timerStartedAt = 0;
    toast.remainingMs = 0;
    beginToastFade(toast);
  }, toast.remainingMs);
}

function syncToastTimers() {
  for (const toasts of toastState.screens.values()) {
    toasts.forEach(syncToastTimer);
  }
}

function beginToastFade(toast) {
  if (toast.removed || toast.phase === "fading") return;
  toast.phase = "fading";
  toast.fadeRemainingMs = TOAST_FADE_DURATION;
  findRenderedToast(toast.id)?.classList.add("is-fading");
  syncToastTimer(toast);
}

function removeToast(toast) {
  if (!toast || toast.removed) return;
  toast.removed = true;
  clearToastTimeouts(toast);
  const screenToasts = toastState.screens.get(toast.scope);
  const index = screenToasts?.indexOf(toast) ?? -1;
  if (index >= 0) screenToasts.splice(index, 1);
  if (screenToasts?.length === 0) toastState.screens.delete(toast.scope);
  renderToasts();
}

function pauseToast(toastId, reason) {
  const toast = findToastById(toastId);
  if (!toast || !toast.autoHide) return;
  toast.pauseReasons.add(reason);
  pauseToastTimer(toast);
}

function resumeToast(toastId, reason) {
  const toast = findToastById(toastId);
  if (!toast || !toast.autoHide) return;
  toast.pauseReasons.delete(reason);
  syncToastTimer(toast);
}

function findToastById(toastId) {
  if (!toastId) return null;
  for (const toasts of toastState.screens.values()) {
    const toast = toasts.find((item) => item.id === toastId);
    if (toast) return toast;
  }
  return null;
}

function clearToastInteractionPauses() {
  for (const toasts of toastState.screens.values()) {
    toasts.forEach((toast) => toast.pauseReasons.clear());
  }
}

function dismissToast(event) {
  const toastId = event?.target?.closest?.(".message")?.dataset.toastId;
  const toast = toastId
    ? findToastById(toastId)
    : getVisibleToasts()[0];
  if (toast) removeToast(toast);
}

function syncToastModalState() {
  const modalOpen = Boolean(document.querySelector("dialog[open]"));
  toastState.modalOpen = modalOpen;
  const region = $("statusRegion");
  region?.classList.toggle("modal-hidden", modalOpen);
  region?.setAttribute("aria-hidden", String(modalOpen));
  syncToastTimers();
}

function setBusy(busy, action = "") {
  const previousAction = state.busyAction;
  const saveBusy =
    (busy && action === "save") || (!busy && previousAction === "save");
  state.isBusy = busy;
  state.busyAction = busy ? action : "";
  if (saveBusy) {
    syncChrome();
    syncPeriodPresets();
    return;
  }
  document.querySelectorAll("button").forEach((button) => {
    if (button.hasAttribute("data-allow-when-busy")) return;
    if (busy) {
      // Preserve controls that are intrinsically disabled (for example, the
      // protected administrator delete action). Only buttons enabled before
      // this busy period are restored when the operation finishes.
      if (!button.disabled) button.dataset.busyDisabled = "true";
      button.disabled = true;
      return;
    }
    if (!button.hasAttribute("data-busy-disabled")) return;
    button.removeAttribute("data-busy-disabled");
    button.disabled = false;
  });
  syncChrome();
  syncPeriodPresets();
}

async function reloadCurrentView() {
  if (state.activeView === "reports") return refreshData();
  if (state.activeView === "calendar") {
    if (typeof window.adminMasters?.reloadCalendar !== "function") {
      showScreenLoadError("calendar", "カレンダーの再読み込み機能を利用できません。", "error");
      return false;
    }
    return window.adminMasters.reloadCalendar({ manual: true });
  }
  if (state.activeView === "admin") {
    if (typeof window.adminMasters?.reload !== "function") {
      showScreenLoadError("admin", "管理の再読み込み機能を利用できません。", "error");
      return false;
    }
    return window.adminMasters.reload({ manual: true });
  }
  if (state.activeView === "settings") {
    if (typeof window.reloadSettings !== "function") {
      showScreenLoadError("settings", "設定の再読み込み機能を利用できません。", "error");
      return false;
    }
    return window.reloadSettings({ manual: true });
  }
  return false;
}

function shouldRefreshReportFiles() {
  return state.reportRefreshPending === true;
}

function markReportDataStale() {
  state.reportRefreshPending = true;
}

async function loadViewForSwitch(view, viewSequence) {
  if (view === "reports") {
    if (typeof loadData !== "function") {
      showScreenLoadError("reports", "日報の読み込み機能を利用できません。", "error");
      return false;
    }
    return loadData({
      preserveDirty: false,
      forceRefresh: shouldRefreshReportFiles(),
      transition: true,
      viewSequence,
    });
  }
  if (view === "admin") {
    if (typeof window.adminMasters?.activate !== "function") {
      showScreenLoadError("admin", "管理の読み込み機能を利用できません。", "error");
      return false;
    }
    return window.adminMasters.activate({ viewSequence });
  }
  if (view === "calendar") {
    if (typeof window.adminMasters?.activateCalendar !== "function") {
      showScreenLoadError("calendar", "カレンダーの読み込み機能を利用できません。", "error");
      return false;
    }
    return window.adminMasters.activateCalendar({ viewSequence });
  }
  if (view === "settings") {
    if (typeof window.loadSettings !== "function") {
      showScreenLoadError("settings", "設定の読み込み機能を利用できません。", "error");
      return false;
    }
    return window.loadSettings({
      manual: false,
      transition: true,
      confirm: false,
      viewSequence,
    });
  }
  return false;
}

function completeViewSwitch(view, previousView) {
  discardUnsavedChangesForView(previousView);
  const sequence = ++viewSwitchSequence;
  clearToastInteractionPauses();
  state.activeView = view;
  const isSettings = view === "settings";
  const isAdmin = view === "admin";
  const isCalendar = view === "calendar";
  $("settingsPanel").classList.toggle("hidden", !isSettings);
  $("adminPanel").classList.toggle("hidden", !isAdmin && !isCalendar);
  $("adminPanel").classList.toggle("is-calendar-reader", isCalendar);
  $("reportPanel").classList.toggle("hidden", isSettings || isAdmin || isCalendar);
  updateViewChrome();
  syncChrome();
  renderToasts();
  if (!isSettings && !isAdmin && !isCalendar) syncPeriodPresets({ immediate: true });
  const result = loadViewForSwitch(view, sequence);
  if (result && typeof result.then === "function") {
    return result.then((loaded) =>
      sequence === viewSwitchSequence ? loaded : false,
    );
  }
  return sequence === viewSwitchSequence ? result : false;
}

function switchView(view) {
  if (!TOAST_SCOPES.includes(view)) return false;
  if (state.activeView === view) return true;
  finishEditing();
  const previousView = state.activeView;
  if (hasUnsavedChangesForView(previousView)) {
    return confirmDiscardForView(previousView, "画面を移動").then((confirmed) =>
      confirmed ? completeViewSwitch(view, previousView) : false,
    );
  }
  return completeViewSwitch(view, previousView);
}

function updateViewAvailability() {
  // The report screen is shared by every role; permissions are row-specific.
  const adminButton = $("adminViewButton");
  if (adminButton) {
    adminButton.classList.toggle("hidden", state.accessDenied || !state.isAdmin);
  }
  $("dailyViewButton")?.classList.remove("hidden");
  $("calendarViewButton")?.classList.remove("hidden");
  $("openSettingsButton")?.classList.remove("hidden");
}

function updateViewChrome() {
  const isReportView = state.activeView === "reports";
  const isSettingsView = state.activeView === "settings";
  const isAdminView = state.activeView === "admin";
  const isCalendarView = state.activeView === "calendar";
  $("dailyViewButton").classList.toggle(
    "is-active",
    isReportView && !isSettingsView && !isAdminView && !isCalendarView,
  );
  $("calendarViewButton").classList.toggle("is-active", isCalendarView);
  $("adminViewButton").classList.toggle("is-active", isAdminView);
  $("openSettingsButton").classList.toggle("is-active", isSettingsView);
  document.body.classList.toggle("is-boss-view", state.isSuperior && isReportView);
  document.body.classList.toggle("is-settings-view", isSettingsView);
  document.body.classList.toggle("is-admin-view", isAdminView);
  document.body.classList.toggle("is-calendar-view", isCalendarView);
  const bossFilterArea = $("bossFilterArea");
  if (bossFilterArea) {
    bossFilterArea.classList.toggle(
      "hidden",
      !isReportView || isSettingsView || isAdminView || isCalendarView,
    );
  }
  const missingCommentsFilterGroup = $("missingCommentsFilterGroup");
  if (missingCommentsFilterGroup) {
    missingCommentsFilterGroup.classList.toggle(
      "hidden",
      !isReportView || !state.isSuperior || isSettingsView || isAdminView || isCalendarView,
    );
  }
}

function syncCurrentUserDisplay() {
  const userName = $("currentUserName");
  if (!userName) return;
  const employeeId = state.employeeId || "未取得";
  userName.textContent = employeeId;
  $("currentUserDisplay")?.setAttribute(
    "aria-label",
    `ログイン中のユーザー: ${employeeId}`,
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const startupDialog = document.getElementById("startupDialog");
startupDialog?.showModal();
startupDialog?.addEventListener("cancel", (event) => event.preventDefault());

window.addEventListener("pywebviewready", async () => {
  bindEvents();
  syncChrome();
  updateViewChrome();
  let initial;
  try {
    initial = await window.pywebview.api.get_initial_state();
  } catch (error) {
    console.error("初期状態の取得に失敗しました。", error);
    const message = document.getElementById("startupMessage");
    if (message) message.textContent = "起動に失敗しました。ウィンドウを閉じて再起動してください。";
    showScreenLoadError(
      "reports",
      REPORT_LOAD_ERROR_MESSAGE,
      "error",
    );
    return;
  }
  startupDialog?.close();
  state.employeeId = initial.employee_id || "";
  state.isAdmin = initial.is_admin === true;
  window.adminMasters?.setMinimumFiscalYear?.(
    initial.calendar_min_fiscal_year,
  );
  window.adminMasters?.setCurrentEmployeeId?.(state.employeeId);
  state.accessDenied =
    initial.access_denied === true || initial.employee_registered === false;
  updateViewAvailability();
  syncCurrentUserDisplay();
  fillSettings(initial.settings || {}, initial.settings_context || initial);
  restoreUiState(initial.settings || {});
  if (state.accessDenied) {
    clearReportViewForLoadFailure();
    showScreenLoadError(
      "reports",
      initial.access_denied_message || REPORT_LOAD_ERROR_MESSAGE,
      "error",
    );
    return;
  }
  if (!initial.settings_complete) {
    setSettingsSetupNotice?.(true);
    await switchView("settings");
    return;
  }
  await loadData({ forceRefresh: true });
});

// Settings screen behavior and validation.
const SETTINGS_LOAD_ERROR_MESSAGE =
  "設定を読み込めませんでした。「再読み込み」を押してください。";
const SETTINGS_LOAD_FAILURE_TOAST =
  "設定を読み込めませんでした。もう一度お試しください。";
const SETTINGS_SAVE_FAILURE_MESSAGE =
  "設定を保存できませんでした。もう一度保存してください。";
let settingsLoaded = false;
let savedSettings = null;
let settingsLoadSequence = 0;
let settingsLoading = false;

function fillSettings(settings, context = null) {
  applySettingsContext(context || {});
  const appearance = normalizeColorAppearance(
    settings.ui_color_theme,
    settings.ui_color_palette,
  );
  savedSettings = {
    ...(settings || {}),
    ui_color_theme: appearance.theme,
    ui_color_palette: appearance.palette,
  };
  settingsLoaded = true;
  const startOffset = Number(settings.default_start_offset_days ?? -2);
  const endOffset = Number(settings.default_end_offset_days ?? 0);
  $("defaultStartOffsetDays").value = String(
    clampNumber(Math.abs(Math.min(0, startOffset)), 0, 5),
  );
  $("defaultEndOffsetDays").value = String(clampNumber(endOffset, 0, 5));
  $("missingCommentStartDate").value = settings.missing_comment_start_date || "";
  syncFlatpickrDateInput("missingCommentStartDate");
  $("includeTodayInMissingComments").checked = Boolean(
    settings.include_today_in_missing_comments,
  );
  $("includeEmptyReportDaysInMissingComments").checked =
    settings.include_empty_report_days_in_missing_comments !== false;
  $("commentSignature").value = settings.comment_signature || "";
  syncColorPaletteControls(appearance.palette);
  const memberFilterLevels = normalizeMemberFilterLevels(
    settings.ui_member_filter_levels,
  );
  document
    .querySelectorAll("[data-member-filter-level]")
    .forEach((input) => {
      input.checked = memberFilterLevels.includes(input.value);
    });
  state.missingCommentStartDate = settings.missing_comment_start_date || "";
  state.includeTodayInMissingComments = Boolean(
    settings.include_today_in_missing_comments,
  );
  state.includeEmptyReportDaysInMissingComments =
    settings.include_empty_report_days_in_missing_comments !== false;
  state.commentSignature = settings.comment_signature || "";
  markSettingsClean();
}

function setSettingsSetupNotice(visible) {
  $("settingsSetupNotice")?.classList.toggle("hidden", !visible);
}

function setSettingsSaveError(message = "") {
  const error = $("settingsSaveError");
  if (!error) return;
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function setSettingsContentVisible(visible) {
  $("settingsCard")?.classList.toggle("hidden", !visible);
}

function setSettingsLoadFailure({ manual, hasDisplay }) {
  if (!hasDisplay) setSettingsContentVisible(false);
  if (hasDisplay && manual) {
    notify({
      text: SETTINGS_LOAD_FAILURE_TOAST,
      type: "error",
      source: "load",
    });
  } else if (!hasDisplay) {
    showScreenLoadError("settings", SETTINGS_LOAD_ERROR_MESSAGE, "error");
  }
}

function discardSettingsChanges() {
  if (!settingsLoaded || !savedSettings) return;
  suppressColorThemeTransitions();
  applyColorPalette(savedSettings.ui_color_palette);
  fillSettings(savedSettings, state.settingsContext);
  clearSettingsErrors();
  setSettingsSaveError("");
  markSettingsClean();
}

async function loadSettings({
  manual = false,
  transition = false,
  confirm = true,
  viewSequence,
} = {}) {
  if (confirm && !(await confirmDiscardForView("settings", "設定を再読み込み"))) {
    return false;
  }
  if (confirm) discardSettingsChanges();
  if (settingsLoading) return false;

  const hadSettings = settingsLoaded;
  const hasDisplay = hadSettings && !transition;
  if (transition || !hadSettings) setSettingsContentVisible(false);
  clearScreenLoadError("settings");
  setSettingsSaveError("");
  const api = window.pywebview?.api;
  if (typeof api?.load_settings !== "function") {
    setSettingsLoadFailure({ manual, hasDisplay });
    return false;
  }

  const requestSequence = ++settingsLoadSequence;
  settingsLoading = true;
  setBusy(true, "settings-load");
  let result;
  try {
    result = await api.load_settings();
  } catch (error) {
    if (requestSequence !== settingsLoadSequence) return false;
    console.error("設定の読み込みに失敗しました。", error);
    setSettingsLoadFailure({ manual, hasDisplay });
    return false;
  } finally {
    if (requestSequence === settingsLoadSequence) {
      settingsLoading = false;
      setBusy(false);
    }
  }
  if (requestSequence !== settingsLoadSequence) return false;
  if (viewSequence !== undefined && viewSequence !== viewSwitchSequence) {
    return false;
  }
  if (!result?.ok || !result.settings) {
    if (result?.storage_error) {
      setSettingsContentVisible(false);
      showScreenLoadError(
        "settings",
        result.message || SETTINGS_LOAD_ERROR_MESSAGE,
        "error",
      );
      return false;
    }
    setSettingsLoadFailure({ manual, hasDisplay });
    return false;
  }

  fillSettings(result.settings, result.settings_context || result);
  restoreUiState(result.settings);
  setSettingsContentVisible(true);
  clearScreenLoadError("settings");
  clearLoadToasts("settings");
  setSettingsSetupNotice(!result.settings_complete);
  if (manual) {
    notify({ text: "設定を再読み込みしました。", type: "success" });
  }
  return true;
}

async function reloadSettings(options = {}) {
  return loadSettings({ ...options, manual: true, transition: false, confirm: true });
}

function clampNumber(value, min, max) {
  const numericValue = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, numericValue));
}

function setFieldError(errorId, message, inputIds = []) {
  const error = $(errorId);
  if (error) {
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }
  inputIds.forEach((inputId) => {
    const input = $(inputId);
    if (!input) return;
    if (message) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
  });
}

const settingsErrorTargets = {
};

function clearSettingsErrors() {
  Object.values(settingsErrorTargets).forEach(({ errorId, inputId }) => {
    setFieldError(errorId, "", [inputId]);
  });
}

function showSettingsErrors(fieldErrors) {
  const entries = Object.entries(fieldErrors || {}).filter(
    ([field, message]) => settingsErrorTargets[field] && message,
  );
  entries.forEach(([field, message]) => {
    const target = settingsErrorTargets[field];
    setFieldError(target.errorId, String(message), [target.inputId]);
  });
  if (entries.length) {
    $(settingsErrorTargets[entries[0][0]].inputId)?.focus();
  }
  return entries.length;
}

function validateSettingsInputs() {
  return {};
}

function getSettingsPayload() {
  const missingCommentStartInput = $("missingCommentStartDate");
  const missingCommentStartPicker = missingCommentStartInput?._flatpickr;
  const missingCommentStartDate = missingCommentStartPicker
    ? missingCommentStartPicker.selectedDates[0]
      ? missingCommentStartPicker.formatDate(
          missingCommentStartPicker.selectedDates[0],
          "Y-m-d",
        )
      : ""
    : missingCommentStartInput?.value || "";
  return {
    default_start_offset_days: -Number($("defaultStartOffsetDays").value),
    default_end_offset_days: Number($("defaultEndOffsetDays").value),
    missing_comment_start_date: missingCommentStartDate,
    include_today_in_missing_comments: $("includeTodayInMissingComments").checked,
    include_empty_report_days_in_missing_comments: $(
      "includeEmptyReportDaysInMissingComments",
    ).checked,
    comment_signature: $("commentSignature").value,
    // Theme selection lives in the title bar. Keep its value in the settings
    // payload so saving another setting never resets the persisted theme.
    ui_color_theme: state.colorTheme,
    ui_color_palette: state.colorPalette,
    ui_member_filter_levels: [
      ...document.querySelectorAll("[data-member-filter-level]:checked"),
    ]
      .map((input) => input.value)
      .filter((level) =>
        (state.memberFilterAllowedLevels || MEMBER_FILTER_LEVELS).includes(level),
      ),
  };
}

function getSettingsDraftSnapshot() {
  const payload = getSettingsPayload();
  delete payload.ui_color_theme;
  delete payload.ui_color_palette;
  return JSON.stringify(payload);
}

function markColorPalettePersisted(value) {
  if (!savedSettings) return;
  savedSettings.ui_color_palette = normalizeColorPalette(value);
}

function isSettingsDirty() {
  return Boolean(state.settingsSnapshot) &&
    state.settingsSnapshot !== getSettingsDraftSnapshot();
}

function markSettingsClean() {
  state.settingsSnapshot = getSettingsDraftSnapshot();
  syncChrome();
}

function clearSettingsFieldErrorForControl(control) {
  const target = Object.values(settingsErrorTargets).find(
    ({ inputId }) => inputId === control?.id,
  );
  if (target) setFieldError(target.errorId, "", [target.inputId]);
  setSettingsSaveError("");
}

function syncSettingsDirtyState(event) {
  clearSettingsFieldErrorForControl(event?.target);
  syncChrome();
}

async function saveSettings() {
  if (state.isBusy) {
    syncChrome();
    return false;
  }
  clearSettingsErrors();
  setSettingsSaveError("");
  const clientErrorCount = showSettingsErrors(validateSettingsInputs());
  if (clientErrorCount) {
    return false;
  }
  const payload = getSettingsPayload();
  const api = window.pywebview?.api;
  if (typeof api?.save_settings !== "function") {
    console.error("設定の保存APIが利用できません。");
    setSettingsSaveError(SETTINGS_SAVE_FAILURE_MESSAGE);
    return false;
  }

  setBusy(true, "settings");
  let result;
  try {
    result = await api.save_settings(payload);
  } catch (error) {
    console.error("設定の保存に失敗しました。", error);
    setSettingsSaveError(SETTINGS_SAVE_FAILURE_MESSAGE);
    return false;
  } finally {
    setBusy(false);
  }

  if (result?.ok !== true || !result.settings) {
    const serverErrorCount = showSettingsErrors(result?.field_errors);
    if (!serverErrorCount) setSettingsSaveError(SETTINGS_SAVE_FAILURE_MESSAGE);
    return false;
  }

  applyColorAppearance(
    result.settings.ui_color_theme,
    result.settings.ui_color_palette,
  );
  fillSettings(result.settings, result.settings_context || result);
  state.memberFilterPreference = result.settings.ui_member_filter_levels;
  state.memberFilterLevels = normalizeMemberFilterLevels(
    result.settings.ui_member_filter_levels,
  ).filter((level) =>
    (state.memberFilterAllowedLevels || MEMBER_FILTER_LEVELS).includes(level),
  );
  // 日報へ戻る際のloadDataで、保存済み設定に従ってフィルタを再生成する。
  setSettingsSetupNotice(false);
  setSettingsSaveError("");
  markSettingsClean();
  notify({ text: "設定を保存しました。", type: "success" });
  return true;
}

window.loadSettings = loadSettings;
window.saveSettings = saveSettings;
window.reloadSettings = reloadSettings;
window.discardSettingsChanges = discardSettingsChanges;
window.setSettingsSetupNotice = setSettingsSetupNotice;
window.markColorPalettePersisted = markColorPalettePersisted;

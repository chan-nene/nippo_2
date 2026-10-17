// 共通データを管理する作業台。組織所属とコメント担当設定を
// 3ファイルの一括トランザクションとして同時に編集・保存する。
// 外側のIIFEで管理画面の状態と処理を閉じ込め、ブラウザー環境でのみDOM/APIへ接続する。
(function () {
  // このファイルの配置順には意図がある。
  // 定義 → 純粋なドメイン補助 → 実行時状態 → 下書き管理・DOM境界 →
  // ライフサイクル・イベント配線 → API・永続化 → ナビゲーション・エディター →
  // カレンダー → 組織・並び順 → レンダリング → インスペクター → 共通DOMビルダー → 公開API。

  // ---------------------------------------------------------------------------
  // 定義・マスターのスキーマ
  // ---------------------------------------------------------------------------
  const MASTER_DEFINITIONS = [
    {
      key: "user_master",
      label: "ユーザー管理",
      navLabel: "ユーザー",
      title: "ユーザー管理",
      file: "user_master.csv",
      navFile: "user_master.csv",
      columns: [
        { key: "employee_id", label: "社員番号", type: "text", required: true },
        { key: "display_name", label: "氏名", type: "text", required: true },
        {
          key: "employment_type",
          label: "雇用区分",
          type: "employment_type",
          required: true,
          defaultValue: "regular",
        },
        {
          key: "is_admin",
          label: "権限",
          type: "admin_flag",
          required: false,
          defaultValue: "0",
        },
        {
          key: "affiliation_type",
          label: "所属区分",
          type: "affiliation_type",
          required: true,
          defaultValue: "unassigned",
        },
        {
          key: "organization_id",
          label: "所属組織",
          type: "organization",
          required: false,
        },
        {
          key: "can_input_own_report",
          label: "日報入力",
          type: "self_report_input",
          required: true,
          defaultValue: "1",
        },
        {
          key: "member_order",
          label: "表示順",
          type: "number",
          required: false,
          table: false,
        },
      ],
    },
    {
      key: "team_master",
      label: "チーム管理",
      navLabel: "チーム",
      title: "チーム階層",
      file: "team_master.csv",
      navFile: "team_master.csv",
      columns: [
        { key: "team_id", label: "組織ID", type: "number", required: true },
        { key: "team_name", label: "組織名", type: "text", required: true },
        {
          key: "team_type",
          label: "組織種別",
          type: "team_type",
          required: true,
          defaultValue: "section",
        },
        {
          key: "parent_team_id",
          label: "親係",
          type: "parent_department",
          required: false,
        },
        { key: "sort_order", label: "表示順", type: "number" },
      ],
    },
    {
      key: "comment_assignment",
      label: "コメント担当設定",
      file: "comment_assignment.csv",
      hidden: true,
      columns: [
        { key: "commenter_employee_id", label: "コメント担当者", type: "text", required: true },
        { key: "target_type", label: "コメント対象", type: "text", required: true, defaultValue: "none" },
        { key: "target_organization_ids", label: "対象組織", type: "text" },
        { key: "target_employee_ids", label: "対象ユーザー", type: "text" },
      ],
    },
    {
      key: "calendar",
      label: "カレンダー",
      navLabel: "カレンダー設定",
      title: "稼働日カレンダー",
      file: "calendar.csv",
      navFile: "calendar.csv",
      columns: [{ key: "date", label: "日付", type: "date", required: true }],
    },
  ];

  const EMBEDDED_EDIT_ICON_PATH =
    "M16.793 2.793a3.121 3.121 0 1 1 4.414 4.414l-8.5 8.5A1 1 0 0 1 12 16H9a1 1 0 0 1-1-1v-3a1 1 0 0 1 .293-.707l8.5-8.5Zm3 1.414a1.121 1.121 0 0 0-1.586 0L10 12.414V14h1.586l8.207-8.207a1.121 1.121 0 0 0 0-1.586ZM6 5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4a1 1 0 1 1 2 0v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h4a1 1 0 1 1 0 2H6Z";
  const EMBEDDED_DELETE_ICON_PATH =
    "M10.556 4a1 1 0 0 0-.97.751l-.292 1.14h5.421l-.293-1.14A1 1 0 0 0 13.453 4h-2.897Zm6.224 1.892-.421-1.639A3 3 0 0 0 13.453 2h-2.897A3 3 0 0 0 7.65 4.253l-.421 1.639H4a1 1 0 1 0 0 2h.1l1.215 11.425A3 3 0 0 0 8.3 22h7.4a3 3 0 0 0 2.984-2.683l1.214-11.425H20a1 1 0 1 0 0-2h-3.22Zm1.108 2H6.112l1.192 11.214A1 1 0 0 0 8.3 20h7.4a1 1 0 0 0 .995-.894l1.192-11.214ZM10 10a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1Z";

  // ---------------------------------------------------------------------------
  // 純粋なドメイン補助
  // ---------------------------------------------------------------------------
  // これらの補助関数はDOMに触れないため、Nodeから読み込み、
  // ブラウザーのカレンダーと同じ実装をテストできる。
  // カレンダーとID分解のDOM非依存処理をまとめ、CommonJSテストにも同じ実装を公開する。
  const adminPure = (() => {
    // 日付を4月始まりの年度へ変換する。1〜3月は前年として扱い、カレンダーの年度境界を統一する。
    function fiscalYearForDate(value) {
      const target = value instanceof Date ? value : new Date(value);
      return target.getMonth() >= 3
        ? target.getFullYear()
        : target.getFullYear() - 1;
    }

    // 年月日をUTC基準のYYYY-MM-DD文字列へ整形し、画面と保存データの日付表現を揃える。
    function calendarIsoDate(year, monthIndex, day) {
      return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    // ISO日付文字列を年月日の数値部品へ分解する。形式に合わない値は後続処理で扱えるようnullを返す。
    function calendarDateParts(dateText) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
      if (!match) return null;
      return {
        year: Number(match[1]),
        monthIndex: Number(match[2]) - 1,
        day: Number(match[3]),
      };
    }

    // ISO日付をタイムゾーンの影響を受けないUTCのDateへ変換する。不正な文字列はnullとして扱う。
    function calendarDate(dateText) {
      const parts = calendarDateParts(dateText);
      return parts
        ? new Date(Date.UTC(parts.year, parts.monthIndex, parts.day))
        : null;
    }

    // カレンダーの日付を曜日付きの日本語ラベルへ変換する。日付が不正な場合は未設定表示へフォールバックする。
    function calendarDateLabel(dateText, includeYear = true) {
      const target = calendarDate(dateText);
      if (!target) return dateText || "日付未設定";
      const weekday = ["日", "月", "火", "水", "木", "金", "土"][target.getUTCDay()];
      const prefix = includeYear ? `${target.getUTCFullYear()}年` : "";
      return `${prefix}${target.getUTCMonth() + 1}月${target.getUTCDate()}日（${weekday}）`;
    }

    // UTC日付を日単位で移動し、月跨ぎ・年跨ぎを正しく処理する。不正な日付は空文字を返す。
    function offsetCalendarDate(dateText, dayOffset) {
      const target = calendarDate(dateText);
      if (!target) return "";
      target.setUTCDate(target.getUTCDate() + dayOffset);
      return calendarIsoDate(
        target.getUTCFullYear(),
        target.getUTCMonth(),
        target.getUTCDate(),
      );
    }

    // 日付を月単位で移動し、移動先に同日がない場合は月末へ丸める。不正な日付は空文字を返す。
    function offsetCalendarMonth(dateText, monthOffset) {
      const parts = calendarDateParts(dateText);
      if (!parts) return "";
      const first = new Date(Date.UTC(parts.year, parts.monthIndex + monthOffset, 1));
      const lastDay = new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
      ).getUTCDate();
      return calendarIsoDate(
        first.getUTCFullYear(),
        first.getUTCMonth(),
        Math.min(parts.day, lastDay),
      );
    }

    // セミコロン区切りのIDをtrim・空要素除去・重複排除して配列化し、設定値の正規化に使う。
    function splitIds(value) {
      return [...new Set(String(value || "").split(";").map((item) => item.trim()).filter(Boolean))];
    }

    // 管理者権限は正社員だけに認める。CSVに不正な組み合わせがあっても、画面・保存値・実効権限を同じ値へ揃える。
    function effectiveAdministratorFlag(user) {
      const employmentType = String(user?.employment_type || "regular");
      const administratorFlag = String(user?.is_admin || "0");
      return employmentType === "regular" && administratorFlag === "1" ? "1" : "0";
    }

    return Object.freeze({
      fiscalYearForDate,
      calendarIsoDate,
      calendarDateParts,
      calendarDate,
      calendarDateLabel,
      offsetCalendarDate,
      offsetCalendarMonth,
      splitIds,
      effectiveAdministratorFlag,
    });
  })();

  // CommonJS分岐は意図的に条件付きとし、ブラウザーでは実装詳細を
  // このIIFEの内側に閉じ込める。
  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = adminPure;
  }
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const {
    fiscalYearForDate,
    calendarIsoDate,
    calendarDateParts,
    calendarDate,
    calendarDateLabel,
    offsetCalendarDate,
    offsetCalendarMonth,
    splitIds,
    effectiveAdministratorFlag,
  } = adminPure;

  // ---------------------------------------------------------------------------
  // 可変な実行時状態
  // ---------------------------------------------------------------------------
  let isLoaded = false;
  let isLoading = false;
  let isInitialized = false;
  let minimumFiscalYear = 0;
  let activeMaster = "user_master";
  let isCalendarReadOnly = false;
  let activeFiscalYear = Math.max(
    minimumFiscalYear,
    fiscalYearForDate(new Date()),
  );
  let calendarViewFiscalYear = activeFiscalYear;
  let calendarFocusDate = "";
  let isChangingFiscalYear = false;
  let searchText = "";
  let nextRowId = 1;
  let userTable = null;
  const drafts = new Map();
  const collapsedTeamIds = new Set();
  const expandedOrganizationIds = new Set();
  let selectedOrganizationSpecial = "";
  let userEditorModalState = null;
  let teamCreateValidationErrors = {};
  let currentEmployeeId = "";
  let teamEditorModalState = null;
  let organizationDragState = null;
  let organizationSortableInstances = [];
  let teamEditorMemberDragState = null;
  let teamEditorMemberSortableInstances = [];
  let selectedOrganizationDepartmentId = "";
  let loadSequence = 0;
  let adminNavigationPending = false;
  const ADMIN_LOAD_ERROR_MESSAGE =
    "管理データを読み込めませんでした。「再読み込み」を押してください。";
  const ADMIN_PARTIAL_LOAD_MESSAGE =
    "一部の管理データを読み込めませんでした。もう一度「最新データを再読み込み」を押してください。";
  const ADMIN_LOAD_FAILURE_TOAST =
    "最新データを読み込めませんでした。もう一度お試しください。";
  const ADMIN_EDITOR_SAVE_ERROR =
    "データを保存できませんでした。もう一度更新してください。";
  const ADMIN_CONFLICT_MESSAGE =
    "別ユーザーがデータ変更していたため、更新を破棄しました。「最新データを再読み込み」を押してください。";

  // 管理画面とナビゲーションのカレンダーは年度を別々に保持し、表示側に応じた年度を返す。
  function displayedFiscalYear() {
    return isCalendarReadOnly ? calendarViewFiscalYear : activeFiscalYear;
  }

  // ---------------------------------------------------------------------------
  // 下書き管理・DOM境界
  // ---------------------------------------------------------------------------
  // 管理画面のDOM要素をIDで取得する。要素参照を一箇所に寄せてDOM境界を明確にする。
  const byId = (id) => document.getElementById(id);
  // 指定したマスターのスキーマ定義を返す。引数省略時は現在選択中のマスターを対象にする。
  const getDefinition = (key = activeMaster) =>
    MASTER_DEFINITIONS.find((definition) => definition.key === key);
  // 指定したマスターの編集中下書きを取得する。引数省略時は現在のマスターを参照する。
  const getDraft = (key = activeMaster) => drafts.get(key);
  // 下書きの内部メタデータを除き、保存対象となる行の値だけを取り出す。
  const valuesOnly = (draft) => draft.entries.map((entry) => entry.values);
  // 行データをJSON化して比較用スナップショットを作る。編集前後の差分判定に使う。
  const snapshot = (rows) => JSON.stringify(rows);
  // 下書きの値差分を判定する。見た目の未保存バッジと保存可否の基準を一つにする。
  const isDraftDirty = (draft) =>
    Boolean(draft) &&
    (snapshot(valuesOnly(draft)) !== draft.originalSnapshot);
  // 下書きの行データだけを編集前スナップショットと比較する。
  const hasDraftRowChanges = (draft) =>
    Boolean(draft) && snapshot(valuesOnly(draft)) !== draft.originalSnapshot;
  // 選択中エディターに関係する下書きの行変更を判定する。組織編集ではユーザー・組織・コメント担当を一体として扱う。
  const hasEditorChanges = (key = activeMaster) => {
    if (key === "team_master") {
      return ["user_master", "team_master", "comment_assignment"].some(
        (draftKey) => hasDraftRowChanges(drafts.get(draftKey)),
      );
    }
    if (key === "user_master") {
      return ["user_master", "comment_assignment"].some((draftKey) =>
        hasDraftRowChanges(drafts.get(draftKey)),
      );
    }
    return hasDraftRowChanges(drafts.get(key));
  };
  // ユーザー管理に属するユーザーとコメント担当設定の未保存状態をまとめて判定する。
  const isUserAdministrationDirty = () =>
    isDraftDirty(drafts.get("user_master")) ||
    isDraftDirty(drafts.get("comment_assignment"));
  // 3マスターの管理データを一括保存すべき状態か判定する。所属変更と担当設定の差分も組織管理の一部として扱う。
  const isOrganizationAdministrationDirty = () =>
    isUserAdministrationDirty() ||
    isDraftDirty(drafts.get("team_master")) ||
    isDraftDirty(drafts.get("comment_assignment"));
  // マスターごとの未保存状態を返す。ユーザー管理だけは関連するコメント担当設定も同時に確認する。
  const isDefinitionDirty = (key) =>
    key === "user_master"
      ? isUserAdministrationDirty()
      : isDraftDirty(drafts.get(key));

  // スキーマの列定義と初期値から編集用の行を生成し、内部IDと文字列化済みの値を付与する。
  function createEntry(values, definition, isNew = false) {
    const entry = {
      id: `master-row-${nextRowId++}`,
      isNew,
      values: Object.fromEntries(
        definition.columns.map((column) => [
          column.key,
          String(values?.[column.key] ?? column.defaultValue ?? ""),
        ]),
      ),
    };
    return entry;
  }


  // 全ユーザーに対応するコメント担当行を補完し、存在しないユーザーの行を除去する。保存する3マスター間の対応関係を保つ。
  function ensureAssignmentRows() {
    const draft = drafts.get("comment_assignment");
    const definition = getDefinition("comment_assignment");
    const employeeIds = new Set(
      (drafts.get("user_master")?.entries || []).map((entry) =>
        valueFor(entry, "employee_id"),
      ),
    );
    draft.entries = draft.entries.filter((entry) =>
      employeeIds.has(valueFor(entry, "commenter_employee_id")),
    );
    const existing = new Set(
      draft.entries.map((entry) => valueFor(entry, "commenter_employee_id")),
    );
    employeeIds.forEach((employeeId) => {
      if (!employeeId || existing.has(employeeId)) return;
      draft.entries.push(
        createEntry(
          {
            commenter_employee_id: employeeId,
            target_type: "none",
            target_organization_ids: "",
            target_employee_ids: "",
          },
          definition,
          true,
        ),
      );
    });
  }

  // 所属先または部長グループごとにユーザー表示順を再採番する。保存前に同じ順序規則へ正規化する。
  function normalizeAllMemberOrders() {
    const groups = new Map();
    (drafts.get("user_master")?.entries || []).forEach((entry) => {
      const group =
        valueFor(entry, "affiliation_type") === "director"
          ? "director"
          : valueFor(entry, "organization_id");
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    });
    groups.forEach((entries) => {
      entries
        .sort(compareUserListEntries)
        .forEach((entry, index) => {
          entry.values.member_order = String((index + 1) * 10);
        });
    });
  }

  // 指定年度の4月から翌年3月までの土日を休日行として補完する。既存日付は上書きせず、最後に日付順へ並べる。
  function ensureFiscalYearEntries(fiscalYear = activeFiscalYear) {
    const definition = getDefinition("calendar");
    const draft = drafts.get("calendar");
    if (!definition || !draft) return;
    const existingByDate = new Map(
      draft.entries.map((entry) => [valueFor(entry, "date"), entry]),
    );
    const end = new Date(Date.UTC(fiscalYear + 1, 2, 31));
    for (
      let cursor = new Date(Date.UTC(fiscalYear, 3, 1));
      cursor <= end;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const dateText = calendarIsoDate(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
      );
      if (![0, 6].includes(cursor.getUTCDay())) continue;
      if (existingByDate.has(dateText)) continue;
      const entry = createEntry(
        { date: dateText },
        definition,
        true,
      );
      draft.entries.push(entry);
      existingByDate.set(dateText, entry);
    }
    draft.entries.sort((left, right) =>
      valueFor(left, "date").localeCompare(valueFor(right, "date")),
    );
  }

  // 指定年度のカレンダー行が存在するかを判定し、年度移動時の新規作成確認を抑制する。
  function hasCalendarEntriesForFiscalYear(fiscalYear) {
    const draft = drafts.get("calendar");
    return Boolean(
      draft?.entries.some((entry) => {
        const date = calendarDate(valueFor(entry, "date"));
        return date && fiscalYearForDate(date) === fiscalYear;
      }),
    );
  }

  // 既存の正の組織IDと衝突しない最小の新規IDを採番する。
  function createTeamId() {
    const usedIds = new Set(
      (drafts.get("team_master")?.entries || [])
        .map((entry) => Number.parseInt(valueFor(entry, "team_id"), 10))
        .filter((teamId) => Number.isSafeInteger(teamId) && teamId > 0),
    );
    let nextId = 1;
    while (usedIds.has(nextId)) nextId += 1;
    return String(nextId);
  }

  // ---------------------------------------------------------------------------
  // ライフサイクルとイベント配線
  // ---------------------------------------------------------------------------
  // 委譲された一覧ハンドラより先に、再読み込み・追加・検索・マスター切替を固定クロームへ登録する。
  function bindAdminChromeEvents() {
    byId("adminReloadButton").addEventListener("click", reload);
    byId("adminTeamSaveButton").addEventListener("click", async () => {
      if (isLoading || activeMaster !== "team_master" || !isOrganizationAdministrationDirty()) return;
      if (await save("team_master")) {
        notify({ text: "チーム管理の変更を保存しました。", type: "success" });
      }
    });
    byId("adminCalendarSaveButton").addEventListener("click", () => {
      void save("calendar");
    });
    byId("adminAddRowButton").addEventListener("click", () => void addRow());
    byId("adminSearchInput").addEventListener("input", (event) => {
      searchText = String(event.target.value || "").trim().toLocaleLowerCase("ja");
      renderTableHeading();
      renderTable();
    });
    byId("adminSearchClearButton").addEventListener("click", () => {
      const searchInput = byId("adminSearchInput");
      searchInput.value = "";
      searchText = "";
      renderTableHeading();
      renderTable();
      searchInput.focus();
    });
    byId("masterNav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-master]");
      if (button) void selectMaster(button.dataset.master);
    });
  }

  // 表・カレンダー・組織のクリック・入力・キーボード操作を一覧領域へ委譲する。
  function bindAdminTableEvents() {
    byId("adminTableWrap").addEventListener("click", (event) => {
      if (event.target.closest("[data-save-editor]")) {
        void save();
        return;
      }
      const fiscalYearButton = event.target.closest("[data-calendar-year-action]");
      if (fiscalYearButton) {
        changeFiscalYear(fiscalYearButton.dataset.calendarYearAction);
        return;
      }
      const calendarDay = event.target.closest("[data-calendar-date]");
      if (calendarDay) {
        if (isCalendarReadOnly) return;
        calendarFocusDate = calendarDay.dataset.calendarDate;
        toggleCalendarDay(calendarDay.dataset.calendarDate);
        return;
      }
      if (event.target.closest("[data-add-team-root]")) {
        void openTeamCreateDialog("department", "");
        return;
      }
      const addChildLevel = event.target.closest("[data-add-child-level]");
      if (addChildLevel) {
        void openTeamCreateDialog(
          addChildLevel.dataset.addChildLevel,
          addChildLevel.dataset.parentTeamId,
        );
        return;
      }
      const organizationToggle = event.target.closest("[data-organization-toggle]");
      if (organizationToggle) {
        toggleOrganizationSections(organizationToggle.dataset.organizationToggle);
        return;
      }
      const toggle = event.target.closest("[data-team-toggle]");
      if (toggle) {
        toggleTeam(toggle.dataset.teamToggle);
        return;
      }
      const expandAction = event.target.closest("[data-team-expand-action]");
      if (expandAction) {
        setAllTeamsCollapsed(expandAction.dataset.teamExpandAction === "collapse");
        return;
      }
      const organizationSelect = event.target.closest("[data-organization-select]");
      if (organizationSelect) {
        void selectOrganizationDepartment(organizationSelect.dataset.organizationSelect);
        return;
      }
      const userAction = event.target.closest("[data-user-row-action]");
      if (userAction) {
        if (
          userAction.disabled ||
          userAction.getAttribute("aria-disabled") === "true"
        ) {
          return;
        }
        if (userAction.dataset.userRowAction === "edit") {
          openUserEditor(userAction.dataset.userId);
        } else if (userAction.dataset.userRowAction === "delete") {
          void deleteSelectedRow(userAction.dataset.userId);
        }
        return;
      }
      const organizationEdit = event.target.closest("[data-organization-edit]");
      if (organizationEdit) {
        if (organizationEdit.dataset.organizationEdit === "director") {
          openDirectorEditor();
        } else {
          openTeamEditor(organizationEdit.dataset.organizationEdit);
        }
        return;
      }
      if (event.target.closest("[data-organization-drag-handle]")) return;
      const departmentCard = event.target.closest(
        ".organization-department-card[data-team-id]",
      );
      if (departmentCard) {
        void selectOrganizationDepartment(departmentCard.dataset.teamId);
        return;
      }
      const row = event.target.closest("[data-row-id]");
      if (row) {
        if (activeMaster !== "team_master" && activeMaster !== "user_master") {
          void selectRow(row.dataset.rowId);
        }
        return;
      }
      if (
        activeMaster === "team_master" &&
        selectedOrganizationDepartmentId &&
        event.target.closest(".organization-browser-v2")
      ) {
        void clearSelectedOrganizationDepartment();
      }
    });
    byId("adminTableWrap").addEventListener("input", (event) => {
      const search = event.target.closest("[data-team-search]");
      if (!search) return;
      searchText = String(search.value || "").trim().toLocaleLowerCase("ja");
      renderTeamTree(getDraft("team_master"));
      requestAnimationFrame(() => {
        const nextSearch = byId("adminTableWrap").querySelector("[data-team-search]");
        if (!nextSearch) return;
        nextSearch.focus();
        nextSearch.setSelectionRange(searchText.length, searchText.length);
      });
    });
    byId("adminTableWrap").addEventListener("keydown", (event) => {
      if (handleCalendarGridKeydown(event)) return;
      if (!["Enter", " "].includes(event.key)) return;
      if (
        event.target.closest(
          "[data-user-row-action], [data-organization-edit], [data-organization-toggle], [data-organization-drag-handle], [data-organization-select], [data-add-child-level]",
        )
      ) return;
      const row = event.target.closest("[data-row-id]");
      if (!row) return;
      event.preventDefault();
      if (activeMaster === "user_master") openUserEditor(row.dataset.rowId);
      else if (activeMaster === "team_master") return;
      else void selectRow(row.dataset.rowId);
    });
    byId("adminTableWrap").addEventListener("focusin", (event) => {
      const calendarDay = event.target.closest("[data-calendar-date]");
      if (!calendarDay) return;
      calendarFocusDate = calendarDay.dataset.calendarDate;
      syncCalendarRovingTabindex(calendarFocusDate);
    });
  }

  // ユーザー・チームの編集モーダルを共通ハンドラへ接続する。
  function bindAdminEditorEvents() {
    ["userEditorDialogForm", "teamEditorDialogForm"].forEach((formId) => {
      const form = byId(formId);
      if (!form) return;
      form.addEventListener("input", handleInspectorInput);
      form.addEventListener("change", handleInspectorChange);
      form.addEventListener("click", handleInspectorClick);
    });
  }

  // チーム作成の送信・取消・背景クリックと、編集ダイアログの取消保護を最後に登録する。
  function bindAdminDialogEvents() {
    byId("teamCreateForm").addEventListener("submit", submitTeamCreateDialog);
    byId("teamCreateName").addEventListener("input", updateTeamCreateDialogState);
    byId("cancelTeamCreateButton").addEventListener("click", closeTeamCreateDialog);
    byId("teamCreateDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeTeamCreateDialog();
    });
    byId("teamCreateDialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeTeamCreateDialog();
    });
    byId("userEditorDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
    });
    byId("teamEditorDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
    });
  }

  // 管理画面のイベント配線を一度だけ初期化する。二重登録による同一操作の重複実行を防ぐ。
  function initialize() {
    if (isInitialized) return;
    isInitialized = true;
    bindAdminChromeEvents();
    bindAdminTableEvents();
    bindAdminEditorEvents();
    bindAdminDialogEvents();
  }

  // インスペクターの入力イベントを選択行の更新処理へ渡す。
  function handleInspectorInput(event) {
    updateSelectedRow(event);
  }

  // 所属・コメント対象・割り当てなどの変更を振り分け、必要な下書き更新と再描画を行う。
  function handleInspectorChange(event) {
    const affiliation = event.target.closest("[data-user-affiliation]");
    if (affiliation) {
      clearEditorFieldError("affiliation_type");
      void changeUserAffiliation(affiliation.value);
      return;
    }
    const assignmentType = event.target.closest("[data-comment-target-type]");
    if (assignmentType) {
      updateCommentTargetType(assignmentType.value);
      return;
    }
    const assignmentOrganization = event.target.closest(
      "[data-comment-target-organization]",
    );
    if (assignmentOrganization) {
      const assignment = assignmentEntryForSelectedUser(true);
      assignment.values.target_organization_ids = assignmentOrganization.value;
      assignment.values.target_employee_ids = "";
      renderInspector();
      syncAdminChrome();
      return;
    }
    const assignmentTarget = event.target.closest("[data-comment-target-employee]");
    if (assignmentTarget) {
      toggleAssignmentListValue(
        "target_employee_ids",
        assignmentTarget.value,
        assignmentTarget.checked,
      );
      return;
    }
    const assignmentDepartment = event.target.closest("[data-comment-target-department]");
    if (assignmentDepartment) {
      toggleAssignmentListValue(
        "target_organization_ids",
        assignmentDepartment.value,
        assignmentDepartment.checked,
      );
      return;
    }
    const moveToGroup = event.target.closest("[data-move-user-affiliation]");
    if (moveToGroup && moveToGroup.value) {
      void moveUserToAffiliation(
        moveToGroup.dataset.employeeId,
        moveToGroup.value,
      );
      return;
    }
    const addMember = event.target.closest("[data-add-organization-member]");
    if (addMember && addMember.value) {
      void moveUserToAffiliation(addMember.value, addMember.dataset.destination);
      return;
    }
    updateSelectedRow(event);
  }

  // 保存・削除・モーダル取消・所属移動・並び替えなど、インスペクター内の操作をデータ属性で振り分ける。
  function handleInspectorClick(event) {
    const isUserEditorModal = event.currentTarget?.id === "userEditorDialogForm";
    const isTeamEditorModal = event.currentTarget?.id === "teamEditorDialogForm";
    if (event.target.closest("[data-user-editor-cancel]")) {
      closeUserEditorModal(true);
      return;
    }
    if (event.target.closest("[data-team-editor-cancel]")) {
      closeTeamEditorModal(true);
      return;
    }
    if (event.target.closest("[data-save-editor]")) {
      if (isUserEditorModal) void saveUserEditor();
      else if (isTeamEditorModal) void saveTeamEditor();
      else void save();
      return;
    }
    const deleteAction = event.target.closest("[data-delete-row]");
    if (deleteAction) {
      if (
        deleteAction.disabled ||
        deleteAction.getAttribute("aria-disabled") === "true"
      ) {
        return;
      }
      void deleteSelectedRow();
      return;
    }
    const organizationMemberMove = event.target.closest("[data-organization-member-move]");
    if (organizationMemberMove) {
      moveOrganizationMember(
        organizationMemberMove.dataset.employeeId,
        organizationMemberMove.dataset.organizationMemberMove,
      );
      return;
    }
    const addTeamButton = event.target.closest("[data-add-child-level]");
    if (addTeamButton) {
      void openTeamCreateDialog(
        addTeamButton.dataset.addChildLevel,
        addTeamButton.dataset.parentTeamId,
      );
      return;
    }
    const moveButton = event.target.closest("[data-move-team]");
    if (moveButton) moveSelectedTeam(moveButton.dataset.moveTeam);
  }

  // ---------------------------------------------------------------------------
  // pywebview APIアダプターと永続化ライフサイクル
  // ---------------------------------------------------------------------------
  // 管理データが未読込のときだけロードを開始する。ロード中の二重要求はフラグで抑止する。
  async function ensureLoaded() {
    if (isLoaded || isLoading) return;
    await load();
  }

  function showAdminLoadFailure({ manual, hasDisplay, message = ADMIN_LOAD_ERROR_MESSAGE }) {
    byId("adminLoading").classList.add("hidden");
    if (!hasDisplay) byId("adminWorkspace").classList.add("hidden");
    if (hasDisplay && manual) {
      notify({
        text: ADMIN_LOAD_FAILURE_TOAST,
        type: "error",
        source: "load",
      });
    } else if (!hasDisplay) {
      showScreenLoadError("admin", message, "error");
    }
  }

  // 現在の管理対象に応じて、移動時に一緒に破棄すべき関連下書きを返す。
  function managementDraftKeys(master = activeMaster) {
    return master === "calendar"
      ? ["calendar"]
      : ["user_master", "team_master", "comment_assignment"];
  }

  // 下書き行を保存済みスナップショットから再構築し、編集前のbaselineへ戻す。
  function restoreDraftToBaseline(key) {
    const draft = drafts.get(key);
    const definition = getDefinition(key);
    if (!draft || !definition) return;
    const rows = JSON.parse(draft.originalSnapshot || "[]");
    if (!Array.isArray(rows)) {
      throw new Error(`${key}の保存済みスナップショットが不正です。`);
    }
    const identityKey = definition.columns[0]?.key || "";
    const currentEntries = new Map(
      draft.entries.map((entry) => [valueFor(entry, identityKey), entry]),
    );
    draft.entries = rows.map((row) => {
      const existing = currentEntries.get(String(row?.[identityKey] || ""));
      if (!existing) return createEntry(row, definition, false);
      existing.values = Object.fromEntries(
        definition.columns.map((column) => [
          column.key,
          String(row?.[column.key] ?? column.defaultValue ?? ""),
        ]),
      );
      existing.isNew = false;
      return existing;
    });
    draft.selectedId = "";
  }

  // タブ/行移動前に、指定範囲の下書きとモーダルを保存済み状態へ戻す。
  function discardAdminDraftChanges(keys = managementDraftKeys()) {
    const keySet = new Set(keys);
    if (keySet.has("user_master") && userEditorModalState) {
      closeUserEditorModal(false);
    }
    if (keySet.has("team_master") && teamEditorModalState) {
      closeTeamEditorModal(false);
    }
    keys.forEach(restoreDraftToBaseline);
    if (keySet.has("user_master") || keySet.has("team_master")) {
      selectedOrganizationSpecial = "";
    }
    if (keySet.has("team_master")) {
      selectedOrganizationDepartmentId = "";
      searchText = "";
    }
    syncAdminChrome();
  }

  // 管理タブ/別行移動時の破棄確認を共通化し、キャンセル時は状態へ触れない。
  async function confirmAdminDraftDiscard(keys, action = "移動") {
    if (!keys.some((key) => isDraftDirty(drafts.get(key)))) {
      discardAdminDraftChanges(keys);
      return true;
    }
    if (adminNavigationPending) return false;
    adminNavigationPending = true;
    try {
      const confirmed = await requestConfirmationDialog({
        title: "未保存の変更があります",
        description: `${action}すると、保存していない変更は破棄されます。`,
        confirmLabel: `破棄して${action}`,
        cancelLabel: "このまま編集を続ける",
        confirmTone: "danger",
      });
      if (!confirmed) return false;
      discardAdminDraftChanges(keys);
      return true;
    } finally {
      adminNavigationPending = false;
    }
  }

  function discardUnsaved({ clearData = true } = {}) {
    if (userEditorModalState) closeUserEditorModal(false);
    if (teamEditorModalState) closeTeamEditorModal(false);
    drafts.clear();
    collapsedTeamIds.clear();
    expandedOrganizationIds.clear();
    selectedOrganizationDepartmentId = "";
    selectedOrganizationSpecial = "";
    searchText = "";
    if (clearData) {
      isLoaded = false;
      byId("adminWorkspace")?.classList.add("hidden");
    }
    syncAdminChrome();
  }

  // pywebview APIから共通マスターを読み込み、下書き・移行状態・初期カレンダーを構築して画面を表示する。失敗時もbusy表示を必ず解除する。
  async function load({
    manual = false,
    forceRefresh = false,
    transition = false,
    viewSequence,
  } = {}) {
    if (isLoading) return false;
    isCalendarReadOnly = false;
    const loadingCopy = byId("adminLoading")?.querySelector("p");
    if (loadingCopy) loadingCopy.textContent = "管理を読み込んでいます";
    const hadData = isLoaded;
    const hasDisplay = hadData && !transition;
    const api = window.pywebview?.api;
    if (typeof api?.load_common_masters !== "function") {
      showAdminLoadFailure({ manual, hasDisplay });
      return false;
    }
    if (transition || !hadData) {
      isLoaded = false;
      byId("adminLoading").classList.remove("hidden");
      byId("adminWorkspace").classList.add("hidden");
    }
    clearScreenLoadError("admin");
    isLoading = true;
    const requestSequence = ++loadSequence;
    setBusy(true, "admin-load");
    let result;
    try {
      result = await api.load_common_masters({
        force_refresh: Boolean(forceRefresh),
      });
    } catch (error) {
      if (requestSequence !== loadSequence) return false;
      console.error("管理データの読み込みに失敗しました。", error);
      showAdminLoadFailure({ manual, hasDisplay });
      return false;
    } finally {
      if (requestSequence === loadSequence) {
        isLoading = false;
        setBusy(false);
      }
    }
    if (requestSequence !== loadSequence) return false;
    if (viewSequence !== undefined && viewSequence !== viewSwitchSequence) {
      return false;
    }
    if (!result?.ok) {
      showAdminLoadFailure({
        manual,
        hasDisplay,
        message: result?.message || ADMIN_LOAD_ERROR_MESSAGE,
      });
      return false;
    }
    drafts.clear();
    collapsedTeamIds.clear();
    expandedOrganizationIds.clear();
    selectedOrganizationDepartmentId = "";
    const organizationRows = result.data || {};
    MASTER_DEFINITIONS.forEach((definition) => {
      const rows = Array.isArray(organizationRows?.[definition.key])
        ? organizationRows[definition.key]
        : [];
      const entries = rows.map((row) =>
        createEntry(row, definition, false),
      );
      const originalSnapshot = snapshot(entries.map((entry) => entry.values));
      if (definition.key === "user_master") {
        entries.forEach((entry) => {
          entry.values.is_admin = effectiveAdministratorFlag(entry.values);
        });
      }
      drafts.set(definition.key, {
        entries,
        originalSnapshot,
        revision: String(result.revisions?.[definition.key] || ""),
        selectedId: "",
      });
    });
    const calendarDraft = drafts.get("calendar");
    if (calendarDraft?.entries.length === 0) {
      activeFiscalYear = Math.max(
        minimumFiscalYear,
        fiscalYearForDate(new Date()),
      );
      ensureFiscalYearEntries(activeFiscalYear);
    }
    isLoaded = true;
    searchText = "";
    byId("adminLoading").classList.add("hidden");
    byId("adminWorkspace").classList.remove("hidden");
    clearScreenLoadError("admin");
    clearLoadToasts("admin");
    render();
    if (
      activeMaster === "user_master" &&
      typeof window.Tabulator !== "function"
    ) {
      return true;
    }
    const refreshFailed = Number(result.refresh_result?.failed || 0);
    const warningCount = Number(result.cache_warning_count || 0);
    if (refreshFailed > 0 || warningCount > 0) {
      showScreenLoadError("admin", ADMIN_PARTIAL_LOAD_MESSAGE, "warning");
    } else if (manual) {
      notify({ text: "最新データを読み込みました。", type: "success" });
    }
    return true;
  }

  async function loadCalendarView({
    manual = false,
    transition = false,
    viewSequence,
  } = {}) {
    if (isLoading) return false;
    const hadData = isLoaded && isCalendarReadOnly && drafts.has("calendar");
    const hasDisplay = hadData && !transition;
    const api = window.pywebview?.api;
    if (typeof api?.load_calendar !== "function") {
      showScreenLoadError(
        "calendar",
        "カレンダーを読み込めませんでした。「再読み込み」を押してください。",
        "error",
      );
      return false;
    }
    isCalendarReadOnly = true;
    activeMaster = "calendar";
    const loadingCopy = byId("adminLoading")?.querySelector("p");
    if (loadingCopy) loadingCopy.textContent = "カレンダーを読み込んでいます";
    if (transition || !hadData) {
      isLoaded = false;
      byId("adminLoading").classList.remove("hidden");
      byId("adminWorkspace").classList.add("hidden");
    }
    clearScreenLoadError("calendar");
    isLoading = true;
    const requestSequence = ++loadSequence;
    setBusy(true, "calendar-load");
    let result;
    try {
      result = await api.load_calendar();
    } catch (error) {
      if (requestSequence !== loadSequence) return false;
      console.error("カレンダーの読み込みに失敗しました。", error);
      byId("adminLoading").classList.add("hidden");
      if (!hasDisplay) byId("adminWorkspace").classList.add("hidden");
      showScreenLoadError(
        "calendar",
        "カレンダーを読み込めませんでした。「再読み込み」を押してください。",
        "error",
      );
      return false;
    } finally {
      if (requestSequence === loadSequence) {
        isLoading = false;
        setBusy(false);
      }
    }
    if (requestSequence !== loadSequence) return false;
    if (viewSequence !== undefined && viewSequence !== viewSwitchSequence) return false;
    if (!result?.ok) {
      byId("adminLoading").classList.add("hidden");
      if (!hasDisplay) byId("adminWorkspace").classList.add("hidden");
      showScreenLoadError(
        "calendar",
        result?.message || "カレンダーを読み込めませんでした。「再読み込み」を押してください。",
        "error",
      );
      return false;
    }
    const definition = getDefinition("calendar");
    const rows = Array.isArray(result.calendar) ? result.calendar : [];
    const entries = rows.map((row) => createEntry(row, definition, false));
    drafts.clear();
    drafts.set("calendar", {
      entries,
      originalSnapshot: snapshot(entries.map((entry) => entry.values)),
      revision: "",
      selectedId: "",
    });
    calendarViewFiscalYear = Math.max(calendarViewFiscalYear, minimumFiscalYear);
    calendarFocusDate = "";
    isLoaded = true;
    byId("adminLoading").classList.add("hidden");
    byId("adminWorkspace").classList.remove("hidden");
    clearScreenLoadError("calendar");
    clearLoadToasts("calendar");
    render();
    return true;
  }

  // 未保存変更がある場合は破棄確認を挟んで管理データを再読込する。キャンセル時は現在の編集状態を保持する。
  async function reload({ manual = true, confirm = true } = {}) {
    if (confirm && hasUnsaved()) {
      const confirmed = await requestConfirmationDialog({
        title: "未保存の変更があります",
        description:
          "管理を再読み込みすると、保存していない変更は失われます。",
        confirmLabel: "破棄して再読み込み",
        cancelLabel: "このまま編集を続ける",
        confirmTone: "danger",
      });
      if (!confirmed) return;
    }
    if (confirm) discardUnsaved({ clearData: false });
    return load({ manual, forceRefresh: true });
  }

  function reloadCalendar() {
    return loadCalendarView({ manual: true });
  }

  function activate(options = {}) {
    // 管理画面へ戻るたびに、前回の管理タブを引き継がずユーザー管理を初期表示する。
    activeMaster = "user_master";
    return load({
      manual: false,
      forceRefresh: true,
      transition: true,
      ...options,
    });
  }

  function activateCalendar(options = {}) {
    return loadCalendarView({
      manual: false,
      transition: true,
      ...options,
    });
  }

  // ユーザー・組織・コメント担当の3マスターを一括保存し、カレンダーは単独保存する。dirty判定・管理者保護・revision更新を通して保存後の基準を確定する。
  async function save(targetMaster = activeMaster, options = {}) {
    if (isCalendarReadOnly) return false;
    const saveAdministration = ["user_master", "team_master", "comment_assignment"].includes(targetMaster);
    const saveCalendar = targetMaster === "calendar";
    const targetIsDirty = saveAdministration
      ? isOrganizationAdministrationDirty()
      : saveCalendar && isDraftDirty(drafts.get("calendar"));
    if (!targetIsDirty) return true;
    if (saveAdministration && regularAdministratorCount() < 1) {
      notifyAdministratorGuard("保存");
      options.onFailure?.({ kind: "administrator-guard" });
      return false;
    }
    if (isLoading) return false;
    const api = window.pywebview?.api;
    setBusy(true, "admin-save");
    let conflictEnded = false;
    try {
      const userDraft = drafts.get("user_master");
      const teamDraft = drafts.get("team_master");
      const assignmentDraft = drafts.get("comment_assignment");
      const teamDirty = saveAdministration && isDraftDirty(teamDraft);
      const userDirty = saveAdministration && isDraftDirty(userDraft);
      const assignmentDirty = saveAdministration && isDraftDirty(assignmentDraft);
      if (teamDirty || userDirty || assignmentDirty) {
        if (typeof api?.save_user_administration !== "function") {
          throw new Error("ユーザー管理の保存機能を利用できません。");
        }
        if (options.normalizeAdministration !== false) {
          normalizeAllTeamOrders();
          normalizeAllMemberOrders();
          ensureAssignmentRows();
        }
        const payload = {
          users: valuesOnly(userDraft),
          teams: valuesOnly(teamDraft),
          comment_assignments: valuesOnly(assignmentDraft),
          revisions: {
            user_master: userDraft.revision,
            team_master: teamDraft.revision,
            comment_assignment: assignmentDraft.revision,
          },
        };
        const result = await api.save_user_administration(payload);
        if (!result?.ok) {
          const failure = {
            conflict: result?.conflict === true,
            result,
          };
          options.onFailure?.(failure);
          if (failure.conflict && options.handleConflict !== false) {
            discardAdminDraftsAfterConflict();
            conflictEnded = true;
          } else if (!options.suppressFailureToast) {
            notify({
              text: ADMIN_EDITOR_SAVE_ERROR,
              type: "error",
            });
          }
          return false;
        }
        if (userDirty || teamDirty || assignmentDirty) {
          userDraft.originalSnapshot = snapshot(valuesOnly(userDraft));
          userDraft.revision = String(
            result.revisions?.user_master || userDraft.revision,
          );
          userDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
        }
        if (userDirty || teamDirty || assignmentDirty) {
          teamDraft.originalSnapshot = snapshot(valuesOnly(teamDraft));
          teamDraft.revision = String(
            result.revisions?.team_master || teamDraft.revision,
          );
          teamDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
          assignmentDraft.originalSnapshot = snapshot(valuesOnly(assignmentDraft));
          assignmentDraft.revision = String(
            result.revisions?.comment_assignment || assignmentDraft.revision,
          );
          assignmentDraft.entries.forEach((entry) => {
            entry.isNew = false;
          });
        }
      }

      const calendarDraft = drafts.get("calendar");
      if (saveCalendar && isDraftDirty(calendarDraft)) {
        const result = await api.save_common_master({
          master: "calendar",
          rows: valuesOnly(calendarDraft),
          revision: calendarDraft.revision,
        });
        if (!result?.ok) {
          const failure = {
            conflict: result?.conflict === true,
            result,
          };
          options.onFailure?.(failure);
          if (failure.conflict && options.handleConflict !== false) {
            discardAdminDraftsAfterConflict();
            conflictEnded = true;
          } else if (!options.suppressFailureToast) {
            notify({
              text: "カレンダー設定を保存できませんでした。もう一度保存してください。",
              type: "error",
              anchorId: "adminCalendarSaveButton",
            });
          }
          return false;
        }
        calendarDraft.originalSnapshot = snapshot(valuesOnly(calendarDraft));
        calendarDraft.revision = String(
          result.revision || calendarDraft.revision,
        );
        calendarDraft.entries.forEach((entry) => {
          entry.isNew = false;
        });
      }

      window.markReportDataStale?.();
      if (saveCalendar && !options.suppressSuccessToast) {
        notify({
          text: "カレンダー設定を保存しました。",
          type: "success",
          anchorId: "adminCalendarSaveButton",
        });
      }
      return true;
    } catch (error) {
      console.error("管理の保存中にエラーが発生しました。", error);
      options.onFailure?.({ error, exception: true });
      if (!options.suppressFailureToast) {
          notify({
            text: saveCalendar
              ? "カレンダー設定を保存できませんでした。もう一度保存してください。"
              : ADMIN_EDITOR_SAVE_ERROR,
            type: "error",
            anchorId: saveCalendar ? "adminCalendarSaveButton" : "",
          });
      }
      return false;
    } finally {
      setBusy(false);
      if (conflictEnded) {
        destroyUserTable();
        destroyOrganizationSortables();
        byId("adminTableWrap").replaceChildren();
        byId("adminWorkspace").classList.add("hidden");
      } else {
        renderMasterNav();
        renderTable();
        renderInspector();
      }
      syncAdminChrome();
    }
  }

  // ---------------------------------------------------------------------------
  // ナビゲーションとエディターのライフサイクル
  // ---------------------------------------------------------------------------
  // 管理対象マスターを切り替える。未保存の編集がある場合は移動を止めて内容の消失を防ぐ。
  async function selectMaster(key) {
    if (!drafts.has(key) || key === activeMaster) return;
    if (!(await confirmAdminDraftDiscard(managementDraftKeys(activeMaster)))) return;
    activeMaster = key;
    searchText = "";
    render();
  }

  // 一覧で編集対象の行を選択し、関連するインスペクターを更新する。
  async function selectRow(rowId) {
    const draft = getDraft();
    if (!draft?.entries.some((entry) => entry.id === rowId)) return;
    if (draft.selectedId === rowId) return;
    if (!(await confirmAdminDraftDiscard(managementDraftKeys(activeMaster)))) return;
    const currentDraft = getDraft();
    if (!currentDraft?.entries.some((entry) => entry.id === rowId)) return;
    currentDraft.selectedId = rowId;
    selectedOrganizationSpecial = "";
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  // 組織ツリーで係を選択し、選択中の係を再クリックした場合は選択解除する。
  async function selectOrganizationDepartment(teamId) {
    if (activeMaster !== "team_master") return;
    const entry = teamEntryFor(teamId);
    if (!entry || valueFor(entry, "team_type") !== "department") return;
    const isSameSelection = selectedOrganizationDepartmentId === teamId;
    if (!(await confirmAdminDraftDiscard(managementDraftKeys("team_master")))) return;
    selectedOrganizationDepartmentId = isSameSelection ? "" : teamId;
    renderTable();
    syncAdminChrome();
  }

  // 組織一覧の外側を選択したとき、係の選択状態を解除する。
  async function clearSelectedOrganizationDepartment() {
    if (activeMaster !== "team_master" || !selectedOrganizationDepartmentId) return;
    if (!(await confirmAdminDraftDiscard(managementDraftKeys("team_master")))) return;
    selectedOrganizationDepartmentId = "";
    renderTable();
    syncAdminChrome();
  }

  // 正社員の管理者数を数え、最後の管理者を誤って削除・降格しないための基準を返す。
  function regularAdministratorCount() {
    return (drafts.get("user_master")?.entries || []).filter(
      (entry) => effectiveAdministratorFlag(entry.values) === "1",
    ).length;
  }

  // 現在の利用者または最後の管理者に該当する行かを判定し、保護対象を識別する。
  function isProtectedAdministratorEntry(entry) {
    if (!entry || effectiveAdministratorFlag(entry.values) !== "1") return false;
    return valueFor(entry, "employee_id") === currentEmployeeId || regularAdministratorCount() <= 1;
  }

  // 管理者を1人以上残す必要がある操作について、共通のエラー通知を表示する。
  function notifyAdministratorGuard(action = "変更") {
    notify({ text: `正社員の管理者を1人以上残す必要があるため、${action}できません。`, type: "error" });
  }

  // 下書き内の社員番号重複を確認する。新規行と既存行を同じ規則で扱い、現在行自身は除外する。
  function hasDuplicateEmployeeId(employeeId, excludedEntryId = "") {
    const normalizedId = String(employeeId || "").trim();
    if (!normalizedId) return false;
    return (drafts.get("user_master")?.entries || []).some(
      (entry) =>
        entry.id !== excludedEntryId &&
        valueFor(entry, "employee_id").trim() === normalizedId,
    );
  }

  // 係名は全体、チーム名は同じ親係内だけで重複を判定する。別の親係の同名チームは許可する。
  function hasDuplicateTeamName(
    teamType,
    teamName,
    parentTeamId = "",
    excludedEntryId = "",
  ) {
    const normalizedType = String(teamType || "").trim();
    const normalizedName = String(teamName || "")
      .trim()
      .toLocaleLowerCase("ja");
    const normalizedParentId = String(parentTeamId || "").trim();
    if (!normalizedType || !normalizedName) return false;
    return (drafts.get("team_master")?.entries || []).some((entry) => {
      if (entry.id === excludedEntryId) return false;
      if (valueFor(entry, "team_type").trim() !== normalizedType) return false;
      if (
        valueFor(entry, "team_name").trim().toLocaleLowerCase("ja") !==
        normalizedName
      ) return false;
      return normalizedType !== "section"
        ? true
        : valueFor(entry, "parent_team_id").trim() === normalizedParentId;
    });
  }

  // 必須入力の文言をモーダルの項目定義へ合わせ、重複エラーとは分けて返す。
  function requiredEditorMessage(key, label) {
    const selectionKeys = new Set([
      "employment_type",
      "affiliation_type",
      "can_input_own_report",
      "team_type",
    ]);
    return `${label}${selectionKeys.has(key) ? "を選択してください。" : "を入力してください。"}`;
  }

  // ユーザー作成・更新時の必須項目と社員番号重複を検証する。
  function validateUserEditorEntry(entry) {
    const errors = {};
    const requiredFields = [
      ["employee_id", "社員番号"],
      ["display_name", "氏名"],
      ["employment_type", "雇用区分"],
      ["affiliation_type", "所属区分"],
      ["can_input_own_report", "日報入力"],
    ];
    requiredFields.forEach(([key, label]) => {
      if (key === "employee_id" && !entry.isNew) return;
      if (!valueFor(entry, key).trim()) {
        errors[key] = requiredEditorMessage(key, label);
      }
    });
    const employeeId = valueFor(entry, "employee_id").trim();
    if (
      employeeId &&
      hasDuplicateEmployeeId(employeeId, entry.id)
    ) {
      errors.employee_id = "この社員番号は既に登録されています。";
    }
    return errors;
  }

  // 係・チームの作成・更新時の必須項目と階層規則に沿った名称重複を検証する。
  function validateTeamEditorEntry(entry) {
    const errors = {};
    const teamType = valueFor(entry, "team_type").trim();
    const teamName = valueFor(entry, "team_name").trim();
    if (!teamType) {
      errors.team_type = requiredEditorMessage("team_type", "組織種別");
    }
    if (!teamName) {
      errors.team_name = requiredEditorMessage(
        "team_name",
        teamType === "section" ? "チーム名" : "係名",
      );
    } else if (
      hasDuplicateTeamName(
        teamType,
        teamName,
        valueFor(entry, "parent_team_id"),
        entry.id,
      )
    ) {
      errors.team_name =
        teamType === "section"
          ? "この係には同じ名前のチームが既に登録されています。"
          : "同じ名前の係が既に登録されています。";
    }
    return errors;
  }

  // 検証結果を再描画した後、最初の不正な入力へフォーカスを移す。
  function focusFirstInvalidControl(form) {
    requestAnimationFrame(() => {
      const control = [...(form?.querySelectorAll("input, select, textarea") || [])].find(
        (candidate) =>
          candidate.getAttribute("aria-invalid") === "true" && !candidate.disabled,
      );
      control?.focus();
    });
  }

  // 競合時はモーダルだけでなく、管理画面の全下書き（カレンダーを含む）を破棄して再読込待ちにする。
  function discardAdminDraftsAfterConflict() {
    discardUnsaved({ clearData: true });
    notify({
      scope: "admin",
      text: ADMIN_CONFLICT_MESSAGE,
      type: "error",
      autoHide: false,
    });
  }

  // 編集された項目だけ検証エラーを消し、モーダル全体の保存エラーも次の編集で解除する。
  function clearEditorFieldError(key) {
    const state =
      activeMaster === "user_master"
        ? userEditorModalState
        : activeMaster === "team_master"
          ? teamEditorModalState
          : null;
    if (!state) return;
    if (state.validationErrors?.[key]) {
      delete state.validationErrors[key];
      const formId =
        activeMaster === "user_master"
          ? "userEditorDialogForm"
          : "teamEditorDialogForm";
      const form = byId(formId);
      const field = [...(form?.querySelectorAll(".inspector-field") || [])].find(
        (candidate) =>
          [...candidate.querySelectorAll("input, select, textarea")].some(
            (control) =>
              control.dataset.column === key ||
              (key === "affiliation_type" && control.dataset.userAffiliation === "true"),
          ),
      );
      field?.querySelector(".inspector-field-error")?.remove();
      const controls = [...(field?.querySelectorAll("input, select, textarea") || [])];
      // 必須タグで入力対象を案内するため、未入力だけでは赤強調を出さない。
      // 赤強調は保存後に返された検証エラーの表示に限定する。
      const isValidationInvalid = false;
      controls.forEach((control) => {
        control.classList.toggle("is-invalid", isValidationInvalid);
        control.setAttribute("aria-invalid", String(isValidationInvalid));
      });
      field?.querySelector(".inspector-radio-group")?.classList.toggle(
        "is-invalid",
        isValidationInvalid,
      );
      field
        ?.querySelector(".inspector-radio-group")
        ?.setAttribute("aria-invalid", String(isValidationInvalid));
    }
    if (state.saveError) {
      state.saveError = "";
      const formId =
        activeMaster === "user_master"
          ? "userEditorDialogForm"
          : "teamEditorDialogForm";
      byId(formId)?.querySelector(".editor-inline-error")?.remove();
    }
  }

  // ユーザー編集を取り消せるよう、関連3マスターの行・選択状態をスナップショット化する。
  function captureUserEditorSnapshot() {
    return ["user_master", "team_master", "comment_assignment"].map((key) => {
      const draft = drafts.get(key);
      return {
        key,
        selectedId: draft?.selectedId || "",
        entries: (draft?.entries || []).map((entry) => ({
          entry,
          values: { ...entry.values },
          isNew: entry.isNew,
        })),
      };
    });
  }

  // 保存せずに編集を閉じる場合、スナップショットから関連下書きを編集前へ戻す。
  function restoreUserEditorSnapshot(snapshotState) {
    snapshotState.forEach(({ key, selectedId, entries }) => {
      const draft = drafts.get(key);
      if (!draft) return;
      entries.forEach(({ entry, values, isNew }) => {
        entry.values = { ...values };
        entry.isNew = isNew;
      });
      draft.entries = entries.map(({ entry }) => entry);
      draft.selectedId = selectedId;
    });
  }

  // 指定ユーザーをモーダル編集対象に設定し、編集フォームへ初期フォーカスを移す。
  function openUserEditor(rowId, previousSnapshot = null) {
    if (userEditorModalState) return;
    const draft = drafts.get("user_master");
    const entry = draft?.entries.find((item) => item.id === rowId);
    if (!entry) return;
    userEditorModalState = {
      entryId: rowId,
      snapshot: previousSnapshot || captureUserEditorSnapshot(),
      validationErrors: {},
      saveError: "",
    };
    draft.selectedId = rowId;
    selectedOrganizationSpecial = "";
    render();
    const dialog = byId("userEditorDialog");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      byId("userEditorDialogForm")
        ?.querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  // ユーザー編集モーダルを閉じる。discard指定時は開く前の下書きへ戻す。
  function closeUserEditorModal(discard = true) {
    const state = userEditorModalState;
    if (!state) return;
    if (discard) restoreUserEditorSnapshot(state.snapshot);
    else {
      const draft = drafts.get("user_master");
      if (draft?.selectedId === state.entryId) draft.selectedId = "";
    }
    userEditorModalState = null;
    const dialog = byId("userEditorDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    byId("userEditorDialogForm")?.replaceChildren();
    render();
  }

  // ユーザー編集モーダルを検証して保存し、成功した場合だけモーダルを閉じる。
  async function saveUserEditor() {
    if (!userEditorModalState || isLoading) return;
    const state = userEditorModalState;
    const entry = drafts
      .get("user_master")
      ?.entries.find((item) => item.id === state.entryId);
    if (!entry) return;
    const validationErrors = validateUserEditorEntry(entry);
    state.validationErrors = validationErrors;
    state.saveError = "";
    if (Object.keys(validationErrors).length > 0) {
      renderUserEditorDialog();
      focusFirstInvalidControl(byId("userEditorDialogForm"));
      return;
    }

    const isNew = entry.isNew;
    let failure = null;
    const saved = await save("user_master", {
      suppressFailureToast: true,
      suppressSuccessToast: true,
      onFailure: (details) => {
        failure = details;
      },
    });
    if (saved) {
      closeUserEditorModal(false);
      notify({
        text: isNew ? "ユーザーを追加しました。" : "ユーザー情報を更新しました。",
        type: "success",
      });
      return;
    }
    if (failure?.conflict) {
      discardAdminDraftsAfterConflict();
      return;
    }
    if (failure?.kind === "administrator-guard") return;
    if (!userEditorModalState) return;
    userEditorModalState.validationErrors = {};
    userEditorModalState.saveError = ADMIN_EDITOR_SAVE_ERROR;
    renderUserEditorDialog();
  }

  // 指定した係・チームをチーム編集モーダルで開き、編集前スナップショットを保持する。
  function openTeamEditor(rowId) {
    if (teamEditorModalState || userEditorModalState) return;
    const draft = drafts.get("team_master");
    const entry = draft?.entries.find((item) => item.id === rowId);
    if (!entry) return;
    teamEditorModalState = {
      kind: "team",
      entryId: rowId,
      snapshot: captureUserEditorSnapshot(),
      validationErrors: {},
      saveError: "",
    };
    draft.selectedId = rowId;
    selectedOrganizationSpecial = "";
    render();
    const dialog = byId("teamEditorDialog");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      byId("teamEditorDialogForm")
        ?.querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  // 部長グループのメンバー編集モーダルを開き、通常のチーム編集と同じ取消復元を可能にする。
  function openDirectorEditor() {
    if (teamEditorModalState || userEditorModalState) return;
    if (!drafts.get("team_master")) return;
    teamEditorModalState = {
      kind: "director",
      entryId: "",
      snapshot: captureUserEditorSnapshot(),
    };
    const draft = drafts.get("team_master");
    if (draft) draft.selectedId = "";
    selectedOrganizationSpecial = "director";
    render();
    const dialog = byId("teamEditorDialog");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      byId("teamEditorDialogForm")
        ?.querySelector("input:not(:disabled), select")
        ?.focus();
    });
  }

  // チーム編集モーダルの種別に応じて、見出し・メンバー一覧・入力フォームを組み立てる。
  function renderTeamEditorDialog() {
    const state = teamEditorModalState;
    const form = byId("teamEditorDialogForm");
    if (!state || !form) return;
    destroyTeamEditorMemberSortables();
    const content = form.closest(".user-editor-dialog-content");
    content?.querySelector(".team-editor-dialog-header")?.remove();
    form.replaceChildren();
    if (state.kind === "director") {
      const header = document.createElement("header");
      header.className = "user-editor-dialog-header team-editor-dialog-header";
      const title = document.createElement("h2");
      title.id = "teamEditorDialogTitle";
      title.textContent = "部長を編集";
      header.append(title);
      content?.insertBefore(header, form);
      form.append(
        renderTeamEditorMembers("", "director"),
        createEditorActionBar({ modal: true, saveLabel: "更新" }),
      );
      return;
    }
    const entry = drafts
      .get("team_master")
      ?.entries.find((item) => item.id === state?.entryId);
    if (!entry || !form) return;
    renderTeamEditorModal(form, entry);
  }

  // チーム編集モーダルを閉じ、必要に応じて開く前の所属・担当設定へ戻す。
  function closeTeamEditorModal(discard = true) {
    const state = teamEditorModalState;
    if (!state) return;
    destroyTeamEditorMemberSortables();
    if (discard) restoreUserEditorSnapshot(state.snapshot);
    else {
      const draft = drafts.get("team_master");
      if (draft?.selectedId === state.entryId) draft.selectedId = "";
    }
    selectedOrganizationSpecial = "";
    teamEditorModalState = null;
    const dialog = byId("teamEditorDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    byId("teamEditorDialogForm")?.replaceChildren();
    render();
  }

  // チーム編集モーダルを検証して保存し、成功時にモーダルを閉じる。
  async function saveTeamEditor() {
    if (!teamEditorModalState || isLoading) return;
    const state = teamEditorModalState;
    if (state.kind !== "team") {
      let failure = null;
      const saved = await save("team_master", {
        suppressFailureToast: true,
        onFailure: (details) => {
          failure = details;
        },
      });
      if (saved) closeTeamEditorModal(false);
      else if (!failure?.conflict && failure?.kind !== "administrator-guard" && teamEditorModalState) {
        teamEditorModalState.saveError = ADMIN_EDITOR_SAVE_ERROR;
        renderTeamEditorDialog();
      }
      return;
    }
    const entry = drafts
      .get("team_master")
      ?.entries.find((item) => item.id === state.entryId);
    if (!entry) return;
    const validationErrors = validateTeamEditorEntry(entry);
    state.validationErrors = validationErrors;
    state.saveError = "";
    if (Object.keys(validationErrors).length > 0) {
      renderTeamEditorDialog();
      focusFirstInvalidControl(byId("teamEditorDialogForm"));
      return;
    }

    const isNew = entry.isNew;
    let failure = null;
    const saved = await save("team_master", {
      suppressFailureToast: true,
      suppressSuccessToast: true,
      onFailure: (details) => {
        failure = details;
      },
    });
    if (saved) {
      closeTeamEditorModal(false);
      notify({
        text:
          isNew
            ? valueFor(entry, "team_type") === "department"
              ? "係を追加しました。"
              : "チームを追加しました。"
            : valueFor(entry, "team_type") === "department"
              ? "係を更新しました。"
              : "チームを更新しました。",
        type: "success",
      });
      return;
    }
    if (failure?.conflict) {
      discardAdminDraftsAfterConflict();
      return;
    }
    if (failure?.kind === "administrator-guard") return;
    if (!teamEditorModalState) return;
    teamEditorModalState.validationErrors = {};
    teamEditorModalState.saveError = ADMIN_EDITOR_SAVE_ERROR;
    renderTeamEditorDialog();
  }

  // ---------------------------------------------------------------------------
  // カレンダー機能
  // ---------------------------------------------------------------------------
  // 前後の年度へ移動し、対象年度のカレンダーがなければ土日行の作成を確認してから補完する。
  async function changeFiscalYear(direction) {
    if (![-1, 1].includes(Number(direction))) return;
    if (isChangingFiscalYear) return;
    const currentFiscalYear = displayedFiscalYear();
    const targetFiscalYear = currentFiscalYear + Number(direction);
    if (targetFiscalYear < minimumFiscalYear) return;
    const draft = drafts.get("calendar");
    if (!draft) return;
    if (isCalendarReadOnly) {
      calendarViewFiscalYear = targetFiscalYear;
      calendarFocusDate = "";
      render();
      return;
    }
    if (!hasCalendarEntriesForFiscalYear(targetFiscalYear)) {
      isChangingFiscalYear = true;
      try {
        const confirmed = await requestConfirmationDialog({
          title: `${targetFiscalYear}年度のカレンダーを作りますか？`,
          description: `${targetFiscalYear}年度の土日を休日として作成します。`,
          confirmLabel: "作成する",
          cancelLabel: "キャンセル",
        });
        if (!confirmed) return;
        ensureFiscalYearEntries(targetFiscalYear);
      } finally {
        isChangingFiscalYear = false;
      }
    }
    activeFiscalYear = targetFiscalYear;
    calendarFocusDate = "";
    const selectedDate = valueFor(
      draft?.entries.find((entry) => entry.id === draft.selectedId),
      "date",
    );
    if (selectedDate && fiscalYearForDate(calendarDate(selectedDate)) !== activeFiscalYear) {
      draft.selectedId = "";
    }
    render();
  }

  // 指定日の休日行を追加・削除し、現在のカレンダー表示とフォーカスを保つ。
  function toggleCalendarDay(dateText) {
    if (isCalendarReadOnly) return;
    const draft = drafts.get("calendar");
    const definition = getDefinition("calendar");
    const date = calendarDate(dateText);
    if (
      !draft ||
      !definition ||
      !date ||
      fiscalYearForDate(date) < minimumFiscalYear
    ) return;
    const index = draft.entries.findIndex(
      (entry) => valueFor(entry, "date") === dateText,
    );
    if (index >= 0) {
      draft.entries.splice(index, 1);
    } else {
      draft.entries.push(createEntry({ date: dateText }, definition, true));
      draft.entries.sort((left, right) =>
        valueFor(left, "date").localeCompare(valueFor(right, "date")),
      );
    }
    draft.selectedId = "";
    renderMasterNav();
    renderTable();
    syncAdminChrome();
    requestAnimationFrame(() => focusCalendarDate(dateText));
  }

  // カレンダーの日付ボタンで矢印・Home/End・PageUp/PageDownのキーボード移動を処理する。
  function handleCalendarGridKeydown(event) {
    const current = event.target.closest(".fiscal-calendar-day[data-calendar-date]");
    if (!current || event.altKey || event.metaKey) return false;
    const currentDate = current.dataset.calendarDate;
    const parsed = calendarDate(currentDate);
    if (!parsed) return false;

    let targetDate = "";
    if (event.key === "ArrowLeft") targetDate = offsetCalendarDate(currentDate, -1);
    else if (event.key === "ArrowRight") targetDate = offsetCalendarDate(currentDate, 1);
    else if (event.key === "ArrowUp") targetDate = offsetCalendarDate(currentDate, -7);
    else if (event.key === "ArrowDown") targetDate = offsetCalendarDate(currentDate, 7);
    else if (event.key === "Home") {
      targetDate = offsetCalendarDate(currentDate, -parsed.getUTCDay());
    } else if (event.key === "End") {
      targetDate = offsetCalendarDate(currentDate, 6 - parsed.getUTCDay());
    } else if (event.key === "PageUp") {
      targetDate = offsetCalendarMonth(currentDate, -1);
    } else if (event.key === "PageDown") {
      targetDate = offsetCalendarMonth(currentDate, 1);
    } else {
      return false;
    }

    event.preventDefault();
    const target = findCalendarDayButton(targetDate);
    if (!target) return true;
    calendarFocusDate = targetDate;
    syncCalendarRovingTabindex(targetDate);
    target.focus({ preventScroll: false });
    return true;
  }

  // 指定日を持つカレンダーのボタン要素を検索し、見つからなければnullを返す。
  function findCalendarDayButton(dateText) {
    return [...document.querySelectorAll(".fiscal-calendar-day[data-calendar-date]")]
      .find((button) => button.dataset.calendarDate === dateText) || null;
  }

  // カレンダーの日付ボタンを roving tabindex にそろえ、キーボード操作の現在位置を示す。
  function syncCalendarRovingTabindex(dateText) {
    document
      .querySelectorAll(".fiscal-calendar-day[data-calendar-date]")
      .forEach((button) => {
        button.tabIndex = button.dataset.calendarDate === dateText ? 0 : -1;
      });
  }

  // 指定日へフォーカスを移し、同時にキーボード移動の現在位置を更新する。
  function focusCalendarDate(dateText) {
    const target = findCalendarDayButton(dateText);
    if (!target) return;
    syncCalendarRovingTabindex(dateText);
    target.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------
  // 組織機能と並び順
  // ---------------------------------------------------------------------------
  // チームの折りたたみ状態を切り替え、階層一覧を再描画する。
  function toggleTeam(teamId) {
    if (collapsedTeamIds.has(teamId)) collapsedTeamIds.delete(teamId);
    else collapsedTeamIds.add(teamId);
    renderTable();
  }

  // すべてのチームを一括して展開または折りたたみ、階層表示を更新する。
  function setAllTeamsCollapsed(collapsed) {
    collapsedTeamIds.clear();
    if (collapsed) {
      const parentIds = new Set(
        (drafts.get("team_master")?.entries || [])
          .map((entry) => valueFor(entry, "parent_team_id"))
          .filter(Boolean),
      );
      parentIds.forEach((teamId) => collapsedTeamIds.add(teamId));
    }
    renderTable();
  }

  // 係カード内のチーム一覧を展開・折りたたみし、組織表示を再描画する。
  function toggleOrganizationSections(teamId) {
    if (!teamId) return;
    if (expandedOrganizationIds.has(teamId)) expandedOrganizationIds.delete(teamId);
    else expandedOrganizationIds.add(teamId);
    renderTable();
  }

  // 現在のマスターに新しい行を追加し、ユーザーやチームなら専用エディターを開く。
  async function addRow() {
    if (!(await confirmAdminDraftDiscard(managementDraftKeys(activeMaster), "追加"))) return;
    if (activeMaster === "team_master") {
      await openTeamCreateDialog("department", "");
      return;
    }
    const definition = getDefinition();
    const draft = getDraft();
    const snapshotState =
      activeMaster === "user_master" ? captureUserEditorSnapshot() : null;
    const entry = createEntry({}, definition, true);
    draft.entries.push(entry);
    draft.selectedId = entry.id;
    searchText = "";
    if (activeMaster === "user_master") {
      openUserEditor(entry.id, snapshotState);
      return;
    }
    render();
  }

  // 係・チームを作成して保存する。失敗時は下書きを戻し、作成フォームで再試行する。
  async function addTeam(level, parentTeamId = "", teamName = "") {
    const definition = getDefinition("team_master");
    const draft = drafts.get("team_master");
    if (!definition || !draft || !["department", "section"].includes(level)) return;
    const parent = draft.entries.find(
      (entry) => valueFor(entry, "team_id") === parentTeamId,
    );
    const validParent =
      level === "department"
        ? !parentTeamId
        : Boolean(parentTeamId) &&
          level === "section" && valueFor(parent, "team_type") === "department";
    if (level === "department" && parentTeamId) return;
    if (!validParent) return;
    const snapshotState = captureUserEditorSnapshot();

    const entry = createEntry(
      {
        team_id: createTeamId(),
        team_name: String(teamName).trim(),
        team_type: level,
        parent_team_id: parentTeamId,
        sort_order: String(nextSiblingOrder(parentTeamId)),
      },
      definition,
      true,
    );
    draft.entries.push(entry);
    draft.selectedId = entry.id;
    selectedOrganizationDepartmentId =
      level === "department" ? valueFor(entry, "team_id") : parentTeamId;
    if (parentTeamId) expandedOrganizationIds.add(parentTeamId);
    searchText = "";
    let failure = null;
    const saved = await save("team_master", {
      suppressSuccessToast: true,
      onFailure: (details) => { failure = details; },
    });
    if (!saved) {
      if (!failure?.conflict) restoreUserEditorSnapshot(snapshotState);
      render();
      return false;
    }
    draft.selectedId = "";
    render();
    notify({ text: level === "department" ? "係を追加しました。" : "チームを追加しました。", type: "success" });
    return true;
  }

  // チーム新規作成ダイアログの各入力へ、検証エラーと不正属性を同期する。
  function applyTeamCreateValidationErrors() {
    [
      ["team_name", "teamCreateName", "teamCreateNameError"],
      ["parent_team_id", "teamCreateParent", "teamCreateParentError"],
    ].forEach(([key, inputId, errorId]) => {
      const input = byId(inputId);
      const field = input?.closest(".inspector-field");
      if (!input || !field) return;
      let error = byId(errorId);
      if (!error) {
        error = document.createElement("span");
        error.id = errorId;
        error.className = "inspector-field-error hidden";
        error.setAttribute("role", "alert");
        (field.querySelector(".inspector-field-label") || field).append(error);
      }
      const message = teamCreateValidationErrors[key] || "";
      error.textContent = message;
      error.classList.toggle("hidden", !message);
      input.classList.toggle("is-invalid", Boolean(message));
      input.setAttribute("aria-invalid", String(Boolean(message)));
      input.setAttribute("aria-describedby", errorId);
    });
  }

  // 係・チームの新規作成ダイアログを初期化し、必要な親係の選択肢を表示する。
  async function openTeamCreateDialog(level = "department", parentTeamId = "") {
    if (!(await confirmAdminDraftDiscard(managementDraftKeys("team_master"), "追加"))) return;
    if (teamEditorModalState) closeTeamEditorModal(false);
    const dialog = byId("teamCreateDialog");
    const levelInput = byId("teamCreateLevel");
    const nextLevel = ["department", "section"].includes(level) ? level : "department";
    levelInput.value = nextLevel;
    byId("teamCreateDialogTitle").textContent = nextLevel === "section" ? "チームを追加" : "係を追加";
    byId("teamCreateNameLabel").textContent = nextLevel === "section" ? "チーム名" : "係名";
    byId("teamCreateName").value = "";
    teamCreateValidationErrors = {};
    renderTeamCreateParentChoices(parentTeamId);
    applyTeamCreateValidationErrors();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => byId("teamCreateName").focus());
  }

  // チーム新規作成ダイアログを閉じ、入力エラー表示をクリアする。
  function closeTeamCreateDialog() {
    if (isLoading) return;
    const dialog = byId("teamCreateDialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    teamCreateValidationErrors = {};
    applyTeamCreateValidationErrors();
  }

  // チーム新規作成フォームを検証し、入力値をチーム追加処理へ渡す。
  async function submitTeamCreateDialog(event) {
    event.preventDefault();
    if (isLoading) return;
    const level = byId("teamCreateLevel").value;
    const parentTeamId = byId("teamCreateParent")?.dataset.teamId || "";
    const teamName = byId("teamCreateName").value.trim();
    const errors = {};
    if (!teamName) {
      errors.team_name = `${level === "section" ? "チーム名" : "係名"}を入力してください。`;
    }
    if (level !== "department" && !teamEntryFor(parentTeamId)) {
      errors.parent_team_id = "親係を選択してください。";
    }
    if (teamName && hasDuplicateTeamName(level, teamName, parentTeamId)) {
      errors.team_name =
        level === "section"
          ? "この係には同じ名前のチームが既に登録されています。"
          : "同じ名前の係が既に登録されています。";
    }
    teamCreateValidationErrors = errors;
    applyTeamCreateValidationErrors();
    if (Object.keys(errors).length > 0) {
      focusFirstInvalidControl(byId("teamCreateForm"));
      return;
    }
    if (await addTeam(level, parentTeamId, teamName)) closeTeamCreateDialog();
  }

  // 選択された階層に合わせて親係フィールドを生成・更新し、作成可否を反映する。
  function renderTeamCreateParentChoices(preferredParentId = null) {
    const level = byId("teamCreateLevel").value;
    const nameField = byId("teamCreateName").closest(".inspector-field");
    let parentField = byId("teamCreateParentField");
    if (level === "section" && !parentField) {
      parentField = document.createElement("label");
      parentField.id = "teamCreateParentField";
      parentField.className = "inspector-field";
      const label = document.createElement("span");
      label.className = "inspector-field-label";
      label.textContent = "親係";
      const input = document.createElement("input");
      input.id = "teamCreateParent";
      input.dataset.teamCreateParent = "true";
      input.type = "text";
      input.readOnly = true;
      input.setAttribute("aria-readonly", "true");
      input.autocomplete = "off";
      parentField.append(label, input);
      nameField?.before(parentField);
    } else if (level !== "section") {
      parentField?.remove();
      parentField = null;
    }
    const parentInput = byId("teamCreateParent");
    const currentParentId = preferredParentId ?? parentInput?.dataset.teamId ?? "";
    const parent = level === "section" ? teamEntryFor(currentParentId) : null;
    if (parentField && parentInput) {
      parentInput.dataset.teamId = parent ? currentParentId : "";
      parentInput.value = parent ? teamPathLabel(parent) : "";
      parentInput.required = level === "section";
    }
    applyTeamCreateValidationErrors();
    updateTeamCreateDialogState();
  }

  // チーム名と親係の入力状態から、新規作成ボタンの有効・無効を切り替える。
  function updateTeamCreateDialogState() {
    const level = byId("teamCreateLevel").value;
    const parentTeamId = byId("teamCreateParent")?.dataset.teamId || "";
    const teamName = byId("teamCreateName").value.trim();
    const parent = teamEntryFor(parentTeamId);
    if (teamCreateValidationErrors.team_name && teamName) {
      delete teamCreateValidationErrors.team_name;
    }
    applyTeamCreateValidationErrors();
    byId("confirmTeamCreateButton").disabled =
      !teamName || (level !== "department" && !parent);
  }

  // 同じ親を持つチームの最大表示順から、末尾に追加する順序番号を算出する。
  function nextSiblingOrder(parentTeamId, excludedEntryId = "") {
    const orders = (drafts.get("team_master")?.entries || [])
      .filter(
        (entry) =>
          entry.id !== excludedEntryId &&
          valueFor(entry, "parent_team_id") === parentTeamId,
      )
      .map((entry) => Number(valueFor(entry, "sort_order")))
      .filter(Number.isFinite);
    return (orders.length ? Math.max(...orders) : 0) + 10;
  }

  // 指定した親配下のチームを表示順に並べ直し、10刻みの順序番号を再採番する。
  function normalizeSiblingOrders(parentTeamId) {
    (drafts.get("team_master")?.entries || [])
      .filter((entry) => valueFor(entry, "parent_team_id") === parentTeamId)
      .sort(compareTeamEntries)
      .forEach((entry, index) => {
        entry.values.sort_order = String((index + 1) * 10);
      });
  }

  // すべての親階層について兄弟チームの表示順を正規化し、保存時の順序を統一する。
  function normalizeAllTeamOrders() {
    const parentIds = new Set(
      (drafts.get("team_master")?.entries || []).map((entry) =>
        valueFor(entry, "parent_team_id"),
      ),
    );
    parentIds.forEach(normalizeSiblingOrders);
  }

  // 指定した管理マスターの下書きを、値・行・選択状態ごと保存前に退避する。
  function captureAdminDraftSnapshots(keys = managementDraftKeys()) {
    return keys.map((key) => {
      const draft = drafts.get(key);
      return {
        key,
        selectedId: draft?.selectedId || "",
        entries: (draft?.entries || []).map((entry) => ({
          entry,
          values: { ...entry.values },
          isNew: entry.isNew,
        })),
      };
    });
  }

  // 退避した管理マスターを復元し、削除失敗時にも順序・所属・担当設定を完全に戻す。
  function restoreAdminDraftSnapshots(snapshots) {
    snapshots.forEach(({ key, selectedId, entries }) => {
      const draft = drafts.get(key);
      if (!draft) return;
      entries.forEach(({ entry, values, isNew }) => {
        entry.values = { ...values };
        entry.isNew = isNew;
      });
      draft.entries = entries.map(({ entry }) => entry);
      draft.selectedId = selectedId;
    });
  }

  // 係削除時に配下のチームIDを再帰的に集め、2階層以外の既存データも孤児にしない。
  function descendantTeamIdsForDelete(teamId) {
    const ids = new Set([teamId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      (drafts.get("team_master")?.entries || []).forEach((entry) => {
        if (ids.has(valueFor(entry, "parent_team_id"))) {
          const childId = valueFor(entry, "team_id");
          if (!ids.has(childId)) {
            ids.add(childId);
            expanded = true;
          }
        }
      });
    }
    return ids;
  }

  // 組織削除に伴うチーム・所属・コメント対象だけを下書きへ反映する。
  function applyTeamDelete(entry) {
    const teamId = valueFor(entry, "team_id");
    const deletedTeamIds =
      valueFor(entry, "team_type") === "department"
        ? descendantTeamIdsForDelete(teamId)
        : new Set([teamId]);
    const teamDraft = drafts.get("team_master");
    const userDraft = drafts.get("user_master");
    const assignmentDraft = drafts.get("comment_assignment");
    const affectedEmployeeIds = new Set(
      userDraft.entries
        .filter((user) =>
          deletedTeamIds.has(valueFor(user, "organization_id")),
        )
        .map((user) => valueFor(user, "employee_id"))
        .filter(Boolean),
    );
    teamDraft.entries = teamDraft.entries.filter(
      (candidate) => !deletedTeamIds.has(valueFor(candidate, "team_id")),
    );
    userDraft.entries.forEach((user) => {
      if (!deletedTeamIds.has(valueFor(user, "organization_id"))) return;
      user.values.affiliation_type = "unassigned";
      user.values.organization_id = "";
    });
    assignmentDraft.entries.forEach((assignment) => {
      if (
        affectedEmployeeIds.has(
          valueFor(assignment, "commenter_employee_id"),
        )
      ) {
        assignment.values.target_type = "none";
        assignment.values.target_organization_ids = "";
        assignment.values.target_employee_ids = "";
        return;
      }
      const targetOrganizationIds = splitIds(
        valueFor(assignment, "target_organization_ids"),
      ).filter((organizationId) => !deletedTeamIds.has(organizationId));
      assignment.values.target_organization_ids = targetOrganizationIds.join(";");
      const targetEmployeeIds = splitIds(
        valueFor(assignment, "target_employee_ids"),
      ).filter((employeeId) => !affectedEmployeeIds.has(employeeId));
      assignment.values.target_employee_ids = targetEmployeeIds.join(";");
      if (
        ["organization", "departments"].includes(valueFor(assignment, "target_type")) &&
        targetOrganizationIds.length === 0
      ) {
        assignment.values.target_type = "none";
      }
      if (
        valueFor(assignment, "target_type") === "custom" &&
        targetEmployeeIds.length === 0 && targetOrganizationIds.length === 0
      ) {
        assignment.values.target_type = "none";
      }
    });
    return deletedTeamIds;
  }

  // 選択行を確認付きで削除し、組織なら配下・所属・コメント対象を連動更新する。
  async function deleteSelectedRow(rowId = "") {
    const draft = getDraft();
    const targetId = rowId || draft.selectedId;
    const index = draft.entries.findIndex(
      (entry) => entry.id === targetId,
    );
    if (index < 0) return;
    const entry = draft.entries[index];
    if (activeMaster === "user_master" && isProtectedAdministratorEntry(entry)) {
      return;
    }
    const draftSnapshots = captureAdminDraftSnapshots([
      "user_master",
      "team_master",
      "comment_assignment",
    ]);
    const organizationViewSnapshot = {
      selectedDepartmentId: selectedOrganizationDepartmentId,
      expandedIds: new Set(expandedOrganizationIds),
    };
    const definition = getDefinition();
    const identifyingValue =
      activeMaster === "team_master"
        ? valueFor(entry, "team_name") || valueFor(entry, "team_id")
        : valueFor(entry, definition.columns[0]?.key);
    const teamType = valueFor(entry, "team_type");
    const confirmed = await requestConfirmationDialog({
      title: "削除の確認",
      description:
        activeMaster === "team_master"
          ? teamType === "department"
            ? "この係を削除すると、配下のチームも削除され、所属ユーザーは「所属登録なし」になります。関連するコメント対象設定も解除されます。"
            : "このチームを削除すると、所属ユーザーは「所属登録なし」になります。関連するコメント対象設定も解除されます。"
          : `「${identifyingValue || "この行"}」を削除します。`,
      confirmLabel: "削除",
      cancelLabel: "キャンセル",
      confirmTone: "danger",
      confirmationVariant: "delete",
    });
    if (!confirmed) return;
    if (activeMaster === "team_master") {
      const deletedTeamIds = applyTeamDelete(entry);
      deletedTeamIds.forEach((deletedTeamId) => {
        expandedOrganizationIds.delete(deletedTeamId);
      });
      if (deletedTeamIds.has(selectedOrganizationDepartmentId)) {
        selectedOrganizationDepartmentId = "";
      }
      draft.selectedId = "";
      if (teamEditorModalState?.kind === "team") {
        teamEditorModalState.saveError = "";
      }
    } else {
      const employeeId = valueFor(entry, "employee_id");
      const assignmentDraft = drafts.get("comment_assignment");
      assignmentDraft.entries = assignmentDraft.entries.filter(
        (assignment) => valueFor(assignment, "commenter_employee_id") !== employeeId,
      );
      assignmentDraft.entries.forEach((assignment) => {
        assignment.values.target_employee_ids = splitIds(
          valueFor(assignment, "target_employee_ids"),
        )
          .filter((targetId) => targetId !== employeeId)
          .join(";");
        if (
          valueFor(assignment, "target_type") === "custom" &&
          !assignment.values.target_employee_ids && !assignment.values.target_organization_ids
        ) {
          assignment.values.target_type = "none";
        }
      });
      draft.entries.splice(index, 1);
      draft.selectedId = "";
    }
    render();
    let failure = null;
    const saved = await save(activeMaster === "team_master" ? "team_master" : "user_master", {
      suppressFailureToast: true,
      suppressSuccessToast: true,
      onFailure: (details) => {
        failure = details;
      },
    });
    if (saved) {
      if (activeMaster === "team_master" && teamEditorModalState) {
        closeTeamEditorModal(false);
      }
      notify({
        scope: "admin",
        text:
          activeMaster === "user_master"
            ? "ユーザーを削除しました。"
            : teamType === "department"
              ? "係を削除しました。"
              : "チームを削除しました。",
        type: "success",
      });
      return;
    }
    if (failure?.conflict) return;

    restoreAdminDraftSnapshots(draftSnapshots);
    selectedOrganizationDepartmentId = organizationViewSnapshot.selectedDepartmentId;
    expandedOrganizationIds.clear();
    organizationViewSnapshot.expandedIds.forEach((teamId) => {
      expandedOrganizationIds.add(teamId);
    });
    if (activeMaster === "team_master" && teamEditorModalState?.kind === "team") {
      teamEditorModalState.validationErrors = {};
      teamEditorModalState.saveError =
        "削除できませんでした。もう一度削除してください。";
    }
    render();
    if (activeMaster === "user_master") {
      notify({
        scope: "admin",
        text: failure?.result?.message || "ユーザーを削除できませんでした。",
        type: "error",
      });
    }
  }

  // インスペクターの入力値を下書きへ反映し、関連設定の整合性を保ちながら表示を更新する。
  function updateSelectedRow(event) {
    const input = event.target.closest("[data-column]");
    if (!input) return;
    if (input.type === "radio" && !input.checked) return;
    const draft = getDraft();
    const entry = draft.entries.find((item) => item.id === draft.selectedId);
    if (!entry) return;
    const previousValue = entry.values[input.dataset.column];
    const nextValue =
      input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value;
    if (
      activeMaster === "user_master" && input.dataset.column === "is_admin" &&
      nextValue === "0" && valueFor(entry, "is_admin") === "1" &&
      regularAdministratorCount() <= 1
    ) {
      input.checked = true;
      notifyAdministratorGuard("権限を変更");
      return;
    }
    if (
      event.type === "change" &&
      input.tagName === "INPUT" &&
      previousValue === nextValue
    ) {
      return;
    }
    clearEditorFieldError(input.dataset.column);
    entry.values[input.dataset.column] = nextValue;
    if (
      activeMaster === "user_master" &&
      input.dataset.column === "employee_id" &&
      previousValue !== nextValue
    ) {
      const assignment = assignmentEntryForUser(previousValue);
      if (assignment) assignment.values.commenter_employee_id = nextValue;
    }
    if (input.dataset.column === "employment_type" && nextValue === "temporary") {
      entry.values.is_admin = "0";
      if (activeMaster === "user_master") {
        resetCommentAssignment(valueFor(entry, "employee_id"));
      }
    }
    if (input.dataset.column === "team_type") {
      entry.values.parent_team_id = nextValue === "department" ? "" : entry.values.parent_team_id;
    }
    if (
      activeMaster === "team_master" &&
      input.dataset.column === "parent_team_id" &&
      previousValue !== nextValue
    ) {
      entry.values.sort_order = String(nextSiblingOrder(nextValue, entry.id));
      normalizeSiblingOrders(previousValue);
      normalizeSiblingOrders(nextValue);
    }
    // 未入力の必須項目はタグで案内し、赤強調は保存後の検証エラーに限定する。
    const isInvalid = false;
    input.classList.toggle("is-invalid", isInvalid);
    input.setAttribute("aria-invalid", String(isInvalid));
    renderMasterNav();
    renderTable();
    if (
      (event.type === "change" ||
        (event.type === "input" && input.dataset.column === "employment_type")) &&
      ((input.dataset.column === "employee_id" && entry.isNew) ||
        input.dataset.column === "employment_type" ||
        input.dataset.column === "team_type" ||
        input.dataset.column === "parent_team_id")
    ) {
      renderInspector();
    }
    syncAdminChrome();
  }

  // 現在選択されているユーザー行を取得し、該当しなければundefinedを返す。
  function getSelectedUser() {
    const draft = drafts.get("user_master");
    return draft?.entries.find((entry) => entry.id === draft.selectedId);
  }

  // ---------------------------------------------------------------------------
  // レンダリング
  // ---------------------------------------------------------------------------
  // 選択中マスターに応じて画面全体を再構築し、ナビゲーション・一覧・インスペクターを同期する。
  // 各描画処理の後に管理画面クロームも更新し、未保存状態を表示へ反映する。
  function render() {
    byId("adminPanel").classList.toggle(
      "is-calendar-master",
      activeMaster === "calendar",
    );
    byId("adminWorkspace").classList.toggle(
      "is-user-master",
      activeMaster === "user_master",
    );
    byId("adminWorkspace").classList.toggle(
      "is-team-master",
      activeMaster === "team_master",
    );
    byId("adminWorkspace").classList.toggle(
      "is-calendar-master",
      activeMaster === "calendar",
    );
    renderMasterNav();
    renderTableHeading();
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  // 表示対象のマスタータブを生成し、選択中・未保存状態とARIA属性を同期する。
  function renderMasterNav() {
    const navigation = byId("masterNav");
    navigation.replaceChildren();
    if (isCalendarReadOnly) {
      byId("adminWorkspace").removeAttribute("aria-labelledby");
      byId("adminWorkspace").setAttribute("aria-label", "カレンダー");
      return;
    }
    byId("adminWorkspace").removeAttribute("aria-label");
    MASTER_DEFINITIONS.filter((definition) => !definition.hidden).forEach((definition) => {
      const draft = drafts.get(definition.key);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "master-nav-button";
      button.dataset.master = definition.key;
      button.id = `master-tab-${definition.key}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "adminWorkspace");
      const isActive = definition.key === activeMaster;
      button.classList.toggle("is-active", isActive);
      button.classList.toggle(
        "is-dirty",
        isDefinitionDirty(definition.key),
      );
      button.setAttribute("aria-selected", String(isActive));

      const copy = document.createElement("span");
      copy.className = "master-nav-copy";
      const title = document.createElement("strong");
      title.textContent = definition.navLabel || definition.label;
      copy.append(title);
      button.append(copy);
      navigation.append(button);
    });
    byId("adminWorkspace").setAttribute(
      "aria-labelledby",
      `master-tab-${activeMaster}`,
    );
  }

  // 現在のマスターに合わせて一覧見出し、追加ボタン、検索コントロールの文言と表示可否を切り替える。
  function renderTableHeading() {
    const definition = getDefinition();
    const addButton = byId("adminAddRowButton");
    const title = byId("adminTableTitle");
    const searchControl = byId("adminSearchControl");
    const searchInput = byId("adminSearchInput");
    const isTeam = definition.key === "team_master";
    addButton.setAttribute(
      "aria-expanded",
      "false",
    );
    addButton.lastChild.textContent =
      definition.key === "user_master"
        ? "ユーザーを追加"
        : definition.key === "team_master"
          ? "チームを追加"
          : "日付を追加";
    title.textContent =
      definition.key === "user_master"
        ? "ユーザー"
        : definition.key === "team_master"
          ? "チーム"
          : `${displayedFiscalYear()}年度カレンダー`;
    title.hidden = ["user_master", "calendar"].includes(definition.key);
    addButton.hidden = isTeam || definition.key === "calendar";
    searchControl.hidden = isTeam || definition.key === "calendar";
    searchInput.placeholder =
      definition.key === "team_master"
        ? "チームを検索"
        : definition.key === "user_master"
          ? "全列を検索"
          : "日付を検索";
    searchInput.setAttribute(
      "aria-label",
      definition.key === "user_master"
        ? "全列を検索"
        : definition.key === "team_master"
          ? "チームを検索"
          : "日付を検索",
    );
    searchInput.value = searchText;
    byId("adminSearchClearButton").hidden = !searchInput.value;
  }

  // 検索語を対象列へ適用し、一覧に表示する下書き行だけを返す。
  // 元の下書き配列は変更せず、並べ替えや表示制御は呼び出し側に委ねる。
  function filteredEntries() {
    const draft = getDraft();
    if (!searchText) return draft.entries;
    if (activeMaster === "user_master") {
      return draft.entries.filter((entry) =>
        Object.entries(createUserTableRow(entry)).some(
          ([key, value]) =>
            !["id", "entry"].includes(key) &&
            String(value ?? "").toLocaleLowerCase("ja").includes(searchText),
        ),
      );
    }
    return draft.entries.filter((entry) =>
      Object.keys(entry.values).some((key) =>
        String(entry.values[key] ?? "").toLocaleLowerCase("ja").includes(searchText),
      ),
    );
  }

  // ユーザー表の表示値を一か所で組み立て、描画と全列検索で同じ文言を使う。
  function createUserTableRow(entry) {
    return {
      id: entry.id,
      employee_id: valueFor(entry, "employee_id") || "—",
      display_name:
        valueFor(entry, "display_name") || valueFor(entry, "employee_id") || "—",
      employment_type: employmentTypeLabel(valueFor(entry, "employment_type")),
      administrator: effectiveAdministratorFlag(entry.values) === "1" ? "管理者" : "",
      own_report: valueFor(entry, "can_input_own_report") === "0" ? "" : "要",
      affiliation: affiliationLabel(entry),
      comment_target: commentAssignmentSummary(valueFor(entry, "employee_id")),
      entry,
    };
  }

  // 表示だけをタグ化し、Tabulatorの値・並び替え・検索用文字列はそのまま保持する。
  function userStatusTagFormatter(modifier, shouldTag = () => true) {
    return (cell) => {
      const value = String(cell.getValue() ?? "");
      if (!value || !shouldTag(value)) return value;
      const tag = document.createElement("span");
      tag.className = `user-status-tag ${modifier}`;
      tag.textContent = value;
      return tag;
    };
  }

  // 現在のマスターとモーダル状態に応じた一覧レンダラーを選び、必要なSortableを管理する。
  // モーダル編集中は一覧を再構築せず、入力中のDOMと選択状態を保つ。
  function renderTable() {
    if (activeMaster === "user_master" && userEditorModalState) return;
    if (activeMaster === "team_master" && teamEditorModalState) return;
    if (activeMaster !== "user_master") clearScreenLoadError("admin");
    if (activeMaster !== "user_master") destroyUserTable();
    if (activeMaster !== "team_master") destroyOrganizationSortables();
    const draft = getDraft();
    if (activeMaster === "team_master") {
      renderTeamTree(draft);
      return;
    }
    if (activeMaster === "calendar") {
      renderCalendarList(draft);
      return;
    }
    renderUserList(draft);
  }

  // Tabulatorが一覧コンテナへ付与したクラスと内部DOMを、他マスターへ移る前に戻す。
  function destroyUserTable() {
    if (!userTable) return;
    userTable.destroy();
    userTable = null;
  }


  // ユーザー下書きを検索・表示順で並べ、操作ボタン付きのアクセシブルな一覧テーブルを生成する。
  function renderUserList(draft) {
    const entries = filteredEntries().slice().sort(compareUserTableEntries);
    const wrap = byId("adminTableWrap");
    destroyUserTable();
    wrap.replaceChildren();
    if (typeof window.Tabulator !== "function") {
      showScreenLoadError(
        "admin",
        "ユーザー一覧の表示に必要なライブラリを読み込めませんでした。「再読み込み」を押してください。",
        "error",
      );
      return;
    }
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "admin-table-empty";
      empty.textContent = searchText
        ? "検索条件に一致するユーザーがいません。"
        : "ユーザーがいません。";
      wrap.append(empty);
      return;
    }
    const rows = entries.map(createUserTableRow);
    userTable = new window.Tabulator(wrap, {
      data: rows,
      index: "id",
      layout: "fitData",
      height: "auto",
      persistence: false,
      resizableColumnFit: false,
      columnDefaults: {
        resizable: "header",
      },
      selectableRows: 1,
      rowFormatter: (row) => {
        row.getElement().dataset.rowId = row.getData().id;
        row.getElement().tabIndex = 0;
      },
      placeholder: searchText
        ? "検索条件に一致するユーザーがいません。"
        : "ユーザーがいません。",
      columns: [
        {
          title: "",
          field: "actions",
          width: 100,
          frozen: true,
          hozAlign: "center",
          headerSort: false,
          resizable: false,
          formatter: (cell) => {
            const entry = cell.getRow().getData().entry;
            const label = valueFor(entry, "display_name") || valueFor(entry, "employee_id") || "ユーザー";
            const actions = document.createElement("div");
            actions.className = "api-key-actions";
            actions.setAttribute("role", "toolbar");
            actions.setAttribute("aria-label", `${label}の操作`);
            actions.append(
              createUserRowAction("edit", entry, label),
              createUserRowAction("delete", entry, label),
            );
            return actions.outerHTML;
          },
        },
        { title: "社員番号", field: "employee_id", width: 150, tooltip: true },
        { title: "氏名", field: "display_name", width: 150, tooltip: true },
        {
          title: "雇用区分",
          field: "employment_type",
          width: 150,
          tooltip: true,
          formatter: userStatusTagFormatter("is-employment"),
        },
        {
          title: "権限",
          field: "administrator",
          width: 150,
          tooltip: true,
          formatter: userStatusTagFormatter(
            "is-administrator",
            (value) => value === "管理者",
          ),
        },
        {
          title: "日報入力",
          field: "own_report",
          width: 150,
          tooltip: true,
          formatter: userStatusTagFormatter(
            "is-report-required",
            (value) => value === "要",
          ),
        },
        { title: "所属組織", field: "affiliation", width: 300, tooltip: true },
        { title: "コメント対象", field: "comment_target", width: 300, tooltip: true },
      ],
    });
  }

  // 対象年度の休日行を月別カレンダーへ描画し、年度移動・休日件数・編集操作を組み立てる。
  function renderCalendarList(draft) {
    const wrap = byId("adminTableWrap");
    wrap.replaceChildren();
    const fiscalEntries = draft.entries.filter((entry) => {
      const target = calendarDate(valueFor(entry, "date"));
      return target && fiscalYearForDate(target) === displayedFiscalYear();
    });
    const entriesByDate = new Map(
      fiscalEntries.map((entry) => [valueFor(entry, "date"), entry]),
    );
    const holidayCount = fiscalEntries.length;

    const toolbar = document.createElement("div");
    toolbar.className = "fiscal-calendar-toolbar";
    const yearNavigation = document.createElement("div");
    yearNavigation.className = "fiscal-year-navigation";
    const previous = createFiscalYearButton(-1, "前年度を表示");
    const year = document.createElement("strong");
    year.className = "fiscal-year-label";
    year.textContent = `${displayedFiscalYear()}年度`;
    year.setAttribute("aria-live", "polite");
    const next = createFiscalYearButton(1, "次年度を表示");
    yearNavigation.append(previous, year, next);

    const legend = document.createElement("div");
    legend.className = "fiscal-calendar-legend";
    const holidayLegend = document.createElement("span");
    holidayLegend.className = "calendar-legend-item";
    holidayLegend.innerHTML = `<i class="calendar-holiday-swatch" aria-hidden="true"></i><span>休日（計 ${holidayCount}日）</span>`;
    legend.append(holidayLegend);
    const toolbarActions = document.createElement("div");
    toolbarActions.className = "fiscal-calendar-toolbar-actions";
    toolbarActions.append(legend);
    toolbar.append(yearNavigation, toolbarActions);

    const calendar = document.createElement("div");
    calendar.className = "fiscal-calendar-grid";
    calendar.setAttribute("role", "grid");
    calendar.setAttribute("aria-label", `${displayedFiscalYear()}年度カレンダー`);
    calendarFocusDate = getCalendarFocusDate();
    for (let offset = 0; offset < 12; offset += 1) {
      const absoluteMonth = 3 + offset;
      const calendarYear = displayedFiscalYear() + Math.floor(absoluteMonth / 12);
      const monthIndex = absoluteMonth % 12;
      calendar.append(
        createCalendarMonth(calendarYear, monthIndex, entriesByDate),
      );
    }
    wrap.append(toolbar, calendar);
  }

  // 年度内で維持可能なカレンダーのフォーカス日を選び、今日または年度初日にフォールバックする。
  function getCalendarFocusDate() {
    const candidate = calendarDate(calendarFocusDate);
    if (candidate && fiscalYearForDate(candidate) === displayedFiscalYear()) {
      return calendarFocusDate;
    }
    const today = new Date();
    const todayText = calendarIsoDate(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const todayDate = calendarDate(todayText);
    if (todayDate && fiscalYearForDate(todayDate) === displayedFiscalYear()) {
      return todayText;
    }
    return calendarIsoDate(displayedFiscalYear(), 3, 1);
  }

  // 年度を前後へ移動するボタンを生成し、下限年度では戻る操作を無効化する。
  function createFiscalYearButton(direction, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fiscal-year-button";
    button.dataset.calendarYearAction = String(direction);
    button.setAttribute("aria-label", label);
    button.disabled = direction < 0 && displayedFiscalYear() <= minimumFiscalYear;
    button.append(
      createTeamSvgIcon(
        direction < 0 ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6",
      ),
    );
    return button;
  }

  // 指定年月の曜日見出しと日付セルを生成し、休日状態とキーボードフォーカスをARIAへ反映する。
  function createCalendarMonth(year, monthIndex, entriesByDate) {
    const month = document.createElement("section");
    month.className = "fiscal-calendar-month";
    month.setAttribute("role", "rowgroup");
    const heading = document.createElement("h4");
    heading.id = `fiscal-calendar-month-${year}-${monthIndex + 1}`;
    heading.textContent = `${monthIndex + 1}月`;
    month.setAttribute("aria-labelledby", heading.id);
    const weekdays = document.createElement("div");
    weekdays.className = "fiscal-calendar-weekdays";
    weekdays.setAttribute("role", "row");
    ["日", "月", "火", "水", "木", "金", "土"].forEach((label, index) => {
      const weekday = document.createElement("span");
      weekday.textContent = label;
      weekday.setAttribute("role", "columnheader");
      weekday.classList.toggle("is-sunday", index === 0);
      weekday.classList.toggle("is-saturday", index === 6);
      weekdays.append(weekday);
    });
    const days = document.createElement("div");
    days.className = "fiscal-calendar-days";
    days.setAttribute("role", "presentation");
    const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    let cellIndex = 0;
    let week = null;
    // 日付セルを7列の週行へ追加し、週の開始時に新しい行を作る。
    // cellIndexを連続的に進め、空白セルと実日付セルで同じ配置規則を保つ。
    const appendCell = (cell) => {
      if (cellIndex % 7 === 0) {
        week = document.createElement("div");
        week.className = "fiscal-calendar-week";
        week.setAttribute("role", "row");
        days.append(week);
      }
      week.append(cell);
      cellIndex += 1;
    };
    // 月初・月末の不足分を空白セルで埋め、カレンダーを必ず週単位に揃える。
    const appendEmptyCell = () => {
      const empty = document.createElement("span");
      empty.className = "fiscal-calendar-cell fiscal-calendar-day-empty";
      empty.setAttribute("role", "gridcell");
      empty.setAttribute("aria-hidden", "true");
      appendCell(empty);
    };
    for (let index = 0; index < firstWeekday; index += 1) appendEmptyCell();
    for (let day = 1; day <= lastDay; day += 1) {
      const dateText = calendarIsoDate(year, monthIndex, day);
      const entry = entriesByDate.get(dateText);
      const isHoliday = Boolean(entry);
      const cell = document.createElement("span");
      cell.className = "fiscal-calendar-cell";
      cell.setAttribute("role", "gridcell");
      const button = document.createElement(isCalendarReadOnly ? "span" : "button");
      if (!isCalendarReadOnly) button.type = "button";
      button.className = "fiscal-calendar-day";
      button.classList.toggle("is-holiday", isHoliday);
      if (isCalendarReadOnly) {
        cell.setAttribute(
          "aria-label",
          `${calendarDateLabel(dateText)}、${isHoliday ? "休日" : "稼働日"}`,
        );
      } else {
        button.dataset.calendarDate = dateText;
        button.tabIndex = dateText === calendarFocusDate ? 0 : -1;
        button.setAttribute("aria-pressed", String(isHoliday));
        button.setAttribute(
          "aria-label",
          `${calendarDateLabel(dateText)}、${isHoliday ? "休日" : "稼働日"}。押すと${isHoliday ? "稼働日" : "休日"}に変更`,
        );
      }
      const number = document.createElement("span");
      number.textContent = String(day);
      button.append(number);
      cell.append(button);
      appendCell(cell);
    }
    while (cellIndex % 7 !== 0) appendEmptyCell();
    month.append(heading, weekdays, days);
    return month;
  }

  // 係・チームを選択状態と並び順付きのカード2ペインへ描画し、描画後にSortableを初期化する。
  // 選択中の係だけチームを表示し、空状態でも追加導線を維持する。
  function renderOrganizationTree(draft) {
    const wrap = byId("adminTableWrap");
    destroyOrganizationSortables();
    wrap.replaceChildren();
    const browser = document.createElement("section");
    browser.className = "team-browser organization-browser-v2";
    browser.setAttribute("aria-label", "係とチームの管理");
    const columns = document.createElement("div");
    columns.className = "organization-browser-columns";

    const departmentPane = document.createElement("section");
    departmentPane.className = "organization-pane organization-department-pane";
    departmentPane.setAttribute("aria-labelledby", "organization-departments-heading");
    const departmentHeading = createOrganizationPaneHeading(
      "organization-departments-heading",
      "係",
    );
    const addDepartment = createOrganizationAddButton("係を追加");
    addDepartment.dataset.addTeamRoot = "true";
    addDepartment.classList.add("organization-department-add");
    departmentHeading.append(addDepartment);
    const departmentList = document.createElement("div");
    departmentList.className = "organization-card-list organization-department-list";
    departmentList.dataset.organizationSortList = "departments";
    departmentList.setAttribute("role", "list");
    departmentList.setAttribute("aria-label", "係一覧");

    const departments = draft.entries
      .filter((entry) => valueFor(entry, "team_type") === "department")
      .sort(compareTeamEntries);
    const selectedDepartment = departments.find(
      (entry) => valueFor(entry, "team_id") === selectedOrganizationDepartmentId,
    );
    if (selectedOrganizationDepartmentId && !selectedDepartment) {
      selectedOrganizationDepartmentId = "";
    }
    departments.forEach((department) => {
      const departmentId = valueFor(department, "team_id");
      departmentList.append(
        createOrganizationCard(department, {
          organizationId: departmentId,
          draggable: true,
          selectable: true,
          selected: departmentId === selectedOrganizationDepartmentId,
        }),
      );
    });
    if (!departments.length) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty team-browser-empty organization-pane-empty";
      empty.textContent = "係がありません。「係を追加」から作成してください。";
      departmentList.append(empty);
    }
    departmentPane.append(departmentHeading, departmentList);

    const sectionPane = document.createElement("section");
    sectionPane.className = "organization-pane organization-section-pane";
    sectionPane.setAttribute("aria-labelledby", "organization-sections-heading");
    const activeDepartment = departments.find(
      (entry) => valueFor(entry, "team_id") === selectedOrganizationDepartmentId,
    );
    const activeDepartmentId = valueFor(activeDepartment, "team_id");
    const activeDepartmentName = valueFor(activeDepartment, "team_name") || "選択した係";
    const sections = activeDepartmentId
      ? draft.entries
          .filter(
            (entry) =>
              valueFor(entry, "team_type") === "section" &&
              valueFor(entry, "parent_team_id") === activeDepartmentId,
          )
          .sort(compareTeamEntries)
      : [];
    const sectionHeading = createOrganizationPaneHeading(
      "organization-sections-heading",
      activeDepartmentId ? `${activeDepartmentName}のチーム` : "チーム",
    );
    sectionHeading.querySelector("h2")?.setAttribute("aria-live", "polite");
    const addSection = createOrganizationAddButton("チームを追加");
    addSection.classList.add("organization-section-add");
    addSection.dataset.addChildLevel = "section";
    addSection.dataset.parentTeamId = activeDepartmentId;
    addSection.disabled = !activeDepartmentId;
    addSection.hidden = !activeDepartmentId;
    sectionHeading.append(addSection);
    const sectionList = document.createElement("div");
    sectionList.className = "organization-card-list organization-section-list";
    sectionList.dataset.organizationSortList = "sections";
    sectionList.dataset.organizationParentTeamId = activeDepartmentId;
    sectionList.setAttribute("role", "list");
    sectionList.setAttribute("aria-label", activeDepartmentId ? `${activeDepartmentName}のチーム一覧` : "チーム一覧");
    sections.forEach((section) => {
      sectionList.append(
        createOrganizationCard(section, {
          organizationId: valueFor(section, "team_id"),
          draggable: true,
          selectable: false,
        }),
      );
    });
    if (!activeDepartmentId) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty team-browser-empty organization-pane-empty";
      empty.textContent = departments.length ? "係を選択してください。" : "係がありません。";
      sectionList.append(empty);
    } else if (!sections.length) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty team-browser-empty organization-pane-empty";
      empty.textContent = "この係にはチームがありません。";
      sectionList.append(empty);
    }
    sectionPane.append(sectionHeading, sectionList);
    columns.append(departmentPane, sectionPane);
    browser.append(columns);
    wrap.append(browser);
    initializeOrganizationSortables();
  }

  // 組織ペインの見出しを生成し、呼び出し側が追加ボタンを同じ領域へ配置できるようにする。
  function createOrganizationPaneHeading(id, titleText) {
    const heading = document.createElement("div");
    heading.className = "organization-pane-heading";
    const title = document.createElement("h2");
    title.id = id;
    title.textContent = titleText;
    heading.append(title);
    return heading;
  }

  // 組織追加用の共通ボタンを生成し、ラベルと装飾記号をアクセシブルなDOMへまとめる。
  function createOrganizationAddButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-add-button";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "＋";
    button.append(icon, label);
    return button;
  }

  // 固定の部長グループを組織カードとして生成し、担当者表示の起点を用意する。
  function createOrganizationDirectorCard() {
    const card = document.createElement("article");
    card.className = "organization-card organization-director-card";
    card.dataset.directorGroup = "true";
    card.setAttribute("role", "treeitem");
    card.append(
      createOrganizationCardHeader(
        "部長",
        "director",
      ),
    );
    return card;
  }

  // 係またはチームの下書き行を編集・選択・ドラッグ可能なカードへ変換する。
  // optionsで操作可否を切り替え、Sortableとイベント委譲が使う識別属性も付与する。
  function createOrganizationCard(entry, options = {}) {
    const teamId = valueFor(entry, "team_id");
    const type = valueFor(entry, "team_type");
    const card = document.createElement("article");
    card.className = `organization-card organization-${type}-card`;
    card.dataset.rowId = entry.id;
    card.dataset.teamId = teamId;
    card.dataset.organizationCard = "true";
    card.dataset.organizationLevel = type;
    card.setAttribute("role", "listitem");
    if (type === "department" && options.selectable) {
      card.classList.toggle("is-selected", Boolean(options.selected));
    }
    card.append(
      createOrganizationCardHeader(
        valueFor(entry, "team_name") || "名称未設定",
        entry.id,
        {
          organizationId: teamId,
          draggable: options.draggable !== false,
          selectable: Boolean(options.selectable),
          selected: Boolean(options.selected),
        },
      ),
    );
    return card;
  }

  // 組織カードの名前、選択状態、並び替えハンドル、編集操作を共通ヘッダーへ組み立てる。
  function createOrganizationCardHeader(nameText, editId, options = {}) {
    const header = document.createElement("div");
    header.className = "organization-card-header";
    if (options.draggable) {
      header.append(createOrganizationDragHandle(options.organizationId, nameText));
    }
    const name = document.createElement("strong");
    name.textContent = nameText;
    const copy = document.createElement("div");
    copy.className = "organization-card-copy";
    copy.append(name);
    if (options.selectable) {
      const select = document.createElement("button");
      select.type = "button";
      select.className = "organization-card-select";
      select.dataset.organizationSelect = options.organizationId;
      select.setAttribute(
        "aria-label",
        `${nameText}${options.selected ? "の選択を解除" : "を選択"}`,
      );
      select.setAttribute("aria-pressed", String(Boolean(options.selected)));
      select.setAttribute("aria-current", options.selected ? "true" : "false");
      select.append(copy);
      header.append(select);
    } else {
      header.append(copy);
    }
    const actions = document.createElement("div");
    actions.className = "organization-card-header-actions";
    actions.append(createOrganizationEditButton(editId, nameText));
    header.append(actions);
    return header;
  }

  // チーム一覧の開閉状態を示すトグルを生成し、件数とARIAラベルで操作内容を伝える。
  function createOrganizationToggleButton(teamId, sectionCount, expanded) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "organization-card-toggle";
    button.dataset.organizationToggle = teamId;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `チーム${sectionCount}件を${expanded ? "閉じる" : "開く"}`);
    button.title = expanded ? "チームを閉じる" : "チームを表示";
    button.append(
      createTeamSvgIcon(expanded ? "m5 15 7-7 7 7" : "m5 9 7 7 7-7"),
      document.createTextNode(`チーム ${sectionCount}件`),
    );
    return button;
  }

  // 組織カードを同一階層内で並び替えるためのドラッグハンドルを生成する。
  function createOrganizationDragHandle(teamId, nameText) {
    const handle = document.createElement("span");
    handle.className = "organization-drag-handle";
    handle.dataset.organizationDragHandle = teamId;
    handle.setAttribute("role", "img");
    handle.setAttribute("aria-label", `${nameText}の並び順をドラッグで変更`);
    handle.title = "ドラッグで並び替え";
    handle.append(
      createTeamSvgIcon(
        "M6 5h2v2H6V5Zm6 0h2v2h-2V5ZM6 11h2v2H6v-2Zm6 0h2v2h-2v-2ZM6 17h2v2H6v-2Zm6 0h2v2h-2v-2Z",
      ),
    );
    return handle;
  }

  // リスト直下から組織カードだけを抽出し、空状態メッセージなどを順序計算から除外する。
  function organizationCardsIn(list) {
    return [...(list?.children || [])].filter((child) =>
      child.matches("[data-organization-card]"),
    );
  }

  // 組織カードのDOM順をチームID配列として読み取り、Sortable後の順序比較に使う。
  function organizationOrderIn(list) {
    return organizationCardsIn(list).map((card) => card.dataset.teamId);
  }

  // DOM上のチーム順と既存sort_orderを保存し、保存失敗時に元へ戻せるスナップショットを作る。
  function organizationOrderSnapshot(list) {
    return organizationOrderIn(list).map((teamId) => ({
      teamId,
      sortOrder: valueFor(teamEntryFor(teamId), "sort_order"),
    }));
  }

  // 係・チームリストへ同階層限定のSortableを登録し、ドラッグ開始前の順序を記録する。
  // Sortableがない場合は通知して終了し、依存機能の不在で描画を壊さない。
  function initializeOrganizationSortables() {
    if (typeof window.Sortable !== "function") {
      showScreenLoadError(
        "admin",
        "管理画面の表示に必要なライブラリを読み込めませんでした。「再読み込み」を押してください。",
        "error",
      );
      return;
    }
    const wrap = byId("adminTableWrap");
    wrap.querySelectorAll("[data-organization-sort-list]").forEach((list) => {
      const sortable = new window.Sortable(list, {
        animation: 160,
        bubbleScroll: true,
        chosenClass: "organization-card-sortable-chosen",
        draggable: "[data-organization-card]",
        dragClass: "organization-card-sortable-drag",
        fallbackOnBody: false,
        fallbackTolerance: 3,
        forceFallback: true,
        group: {
          name: "organization-same-level",
          pull: false,
          put: false,
        },
        ghostClass: "organization-card-sortable-ghost",
        handle: "[data-organization-drag-handle]",
        invertSwap: false,
        scroll: true,
        scrollSensitivity: 60,
        scrollSpeed: 12,
        swapThreshold: 0.55,
        onMove: (event) =>
          event.from === list && event.to === list && event.related !== event.dragged,
        onStart: (event) => {
          if (activeMaster !== "team_master" || isLoading || organizationDragState) {
            event.preventDefault?.();
            return;
          }
          organizationDragState = {
            card: event.item,
            list,
            previousOrder: organizationOrderSnapshot(list),
          };
          event.item.classList.add("is-dragging");
        },
        onEnd: () => {
          commitOrganizationDrag();
        },
      });
      list.dataset.organizationSortable = "true";
      organizationSortableInstances.push(sortable);
    });
  }

  // 組織リストに紐づくSortableを破棄し、並び替え中の状態をリセットする。
  function destroyOrganizationSortables() {
    organizationSortableInstances.forEach((sortable) => sortable.destroy());
    organizationSortableInstances = [];
    organizationDragState = null;
  }

  // チーム編集ダイアログ直下からメンバーカードだけを抽出し、並び順操作の対象を限定する。
  function teamEditorMemberCardsIn(list) {
    return [...(list?.children || [])].filter((child) =>
      child.matches("[data-team-editor-member-card]"),
    );
  }

  // メンバーカードのDOM順を社員番号配列として取得し、ドラッグ前後の比較に使う。
  function teamEditorMemberOrderIn(list) {
    return teamEditorMemberCardsIn(list).map((card) => card.dataset.employeeId || "");
  }

  // チーム編集ダイアログのメンバー一覧へ同一リスト内限定のSortableを登録する。
  // 空リストや登録済みリストはスキップし、再描画時の二重初期化を防ぐ。
  function initializeTeamEditorMemberSortables() {
    if (typeof window.Sortable !== "function") return;
    const form = byId("teamEditorDialogForm");
    if (!form) return;
    form.querySelectorAll("[data-team-editor-member-list]").forEach((list) => {
      if (!teamEditorMemberCardsIn(list).length || list.dataset.teamEditorMemberSortable === "true") {
        return;
      }
      const sortable = new window.Sortable(list, {
        animation: 160,
        bubbleScroll: true,
        chosenClass: "team-editor-member-sortable-chosen",
        draggable: "[data-team-editor-member-card]",
        dragClass: "team-editor-member-sortable-drag",
        fallbackOnBody: false,
        fallbackTolerance: 3,
        forceFallback: true,
        ghostClass: "team-editor-member-sortable-ghost",
        handle: "[data-team-editor-member-drag-handle]",
        group: {
          name: "team-editor-members",
          pull: false,
          put: false,
        },
        scroll: true,
        scrollSensitivity: 60,
        scrollSpeed: 12,
        swapThreshold: 0.55,
        onMove: (event) => event.from === list && event.to === list,
        onStart: (event) => {
          if (activeMaster !== "team_master" || !teamEditorModalState || isLoading || teamEditorMemberDragState) {
            event.preventDefault?.();
            return;
          }
          teamEditorMemberDragState = {
            item: event.item,
            list,
            previousOrder: teamEditorMemberOrderIn(list),
          };
          event.item.classList.add("is-dragging");
        },
        onEnd: () => {
          commitTeamEditorMemberDrag();
        },
      });
      list.dataset.teamEditorMemberSortable = "true";
      teamEditorMemberSortableInstances.push(sortable);
    });
  }

  // メンバー用Sortableとドラッグ中の見た目・登録印をまとめて解除する。
  function destroyTeamEditorMemberSortables() {
    teamEditorMemberSortableInstances.forEach((sortable) => sortable.destroy());
    teamEditorMemberSortableInstances = [];
    if (teamEditorMemberDragState?.item) {
      teamEditorMemberDragState.item.classList.remove("is-dragging");
    }
    teamEditorMemberDragState = null;
    byId("teamEditorDialogForm")?.querySelectorAll(
      "[data-team-editor-member-list]",
    ).forEach((list) => {
      delete list.dataset.teamEditorMemberSortable;
    });
  }

  // ドラッグ後の社員順をmember_orderへ反映し、変更がない場合は副作用を起こさない。
  // 順序は10刻みで再採番し、下書きと画面の表示順を一致させる。
  function commitTeamEditorMemberDrag() {
    const state = teamEditorMemberDragState;
    if (!state) return;
    const nextOrder = teamEditorMemberOrderIn(state.list);
    const previousOrder = state.previousOrder;
    const changed = nextOrder.some((employeeId, index) => employeeId !== previousOrder[index]);
    state.item.classList.remove("is-dragging");
    teamEditorMemberDragState = null;
    if (!changed) return;
    const userEntries = drafts.get("user_master")?.entries || [];
    const usersByEmployeeId = new Map(
      userEntries.map((entry) => [valueFor(entry, "employee_id"), entry]),
    );
    // カードは画面上で降順表示するため、保存時は従来の日報・コメント順（昇順）へ戻す。
    nextOrder.slice().reverse().forEach((employeeId, index) => {
      const user = usersByEmployeeId.get(employeeId);
      if (user) user.values.member_order = String((index + 1) * 10);
    });
    syncAdminChrome();
  }

  // 係・チームの並び順を下書きに反映する。CSVへの保存は保存ボタンで行う。
  function commitOrganizationDrag() {
    const state = organizationDragState;
    if (!state) return;
    const nextOrder = organizationOrderIn(state.list);
    const previousOrder = state.previousOrder.map(({ teamId }) => teamId);
    const changed = nextOrder.some((teamId, index) => teamId !== previousOrder[index]);
    state.card.classList.remove("is-dragging");
    organizationDragState = null;
    if (!changed) {
      renderTable();
      return;
    }
    const parentTeamId = state.list.dataset.organizationParentTeamId || "";
    nextOrder.forEach((teamId, index) => {
      const entry = teamEntryFor(teamId);
      if (!entry) return;
      entry.values.parent_team_id = parentTeamId;
      entry.values.sort_order = String((index + 1) * 10);
    });
    renderTable();
    syncAdminChrome();

  }



  // 組織カードの編集操作ボタンを生成し、名前入りのARIAラベルと編集アイコンを付ける。
  function createOrganizationEditButton(editId, nameText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "organization-card-edit";
    button.dataset.organizationEdit = editId;
    button.setAttribute("aria-label", `${nameText}を編集`);
    button.title = "編集";
    const icon = createTeamSvgIcon(EMBEDDED_EDIT_ICON_PATH);
    const iconPath = icon.querySelector("path");
    iconPath.setAttribute("fill-rule", "evenodd");
    iconPath.setAttribute("clip-rule", "evenodd");
    iconPath.setAttribute("fill", "currentColor");
    button.append(icon);
    return button;
  }

  // チームマスターの一覧は組織ツリーへ委譲する。
  function renderTeamTree(draft) {
    return renderOrganizationTree(draft);
  }

  // チームをsort_order、名称、IDの順で安定的に比較し、同順でも表示順を決定できるようにする。
  function compareTeamEntries(left, right) {
    const leftOrder = Number(valueFor(left, "sort_order") || 999999);
    const rightOrder = Number(valueFor(right, "sort_order") || 999999);
    return leftOrder - rightOrder || valueFor(left, "team_name").localeCompare(
      valueFor(right, "team_name"),
      "ja",
    ) || valueFor(left, "team_id").localeCompare(valueFor(right, "team_id"), "ja");
  }

  // 指定パスのインラインSVGアイコンを生成し、装飾用として支援技術から隠す。
  function createTeamSvgIcon(pathData) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
    return svg;
  }

  // 下書き行の値を常に文字列で安全に取り出し、欠損値を空文字へ正規化する。
  function valueFor(entry, key) {
    return String(entry?.values?.[key] || "");
  }

  // 保存値の雇用区分を画面表示用の日本語ラベルへ変換する。
  function employmentTypeLabel(value) {
    return value === "temporary" ? "派遣社員" : "正社員";
  }

  // 組織レベルの内部値を係・チームなどの日本語表示へ変換し、未知値はそのまま返す。
  function teamLevelLabel(level) {
    return {
      department: "係",
      section: "チーム",
    }[level] || level || "—";
  }

  // チームIDに対応する現在の名称を取得し、見つからない場合はIDを表示用に返す。
  function teamNameFor(teamId) {
    if (!teamId) return "";
    const entry = drafts
      .get("team_master")
      ?.entries.find((item) => valueFor(item, "team_id") === teamId);
    return valueFor(entry, "team_name") || teamId;
  }


  // 指定チームから子孫をたどり、循環を避けながら配下チームIDの集合を作る。
  function descendantTeamIds(rootIds) {
    const entries = drafts.get("team_master")?.entries || [];
    const covered = new Set(rootIds);
    const pending = [...rootIds];
    while (pending.length) {
      const parentId = pending.pop();
      entries
        .filter((entry) => valueFor(entry, "parent_team_id") === parentId)
        .forEach((entry) => {
          const childId = valueFor(entry, "team_id");
          if (!covered.has(childId)) {
            covered.add(childId);
            pending.push(childId);
          }
        });
    }
    return covered;
  }


  // ---------------------------------------------------------------------------
  // インスペクターと割り当てのレンダリング
  // ---------------------------------------------------------------------------
  // 選択中のユーザーまたはチームに対応する編集モーダルを再構築する。
  function renderInspector() {
    if (activeMaster === "user_master") {
      if (userEditorModalState) renderUserEditorDialog();
      return;
    }
    if (activeMaster === "team_master") {
      if (teamEditorModalState) renderTeamEditorDialog();
    }
  }


  // 割り当て候補となるユーザー下書きの一覧を返す。未ロード時は空配列として描画側の分岐を安全にする。
  function userEntriesForAssignment() {
    return drafts.get("user_master")?.entries || [];
  }

  // ユーザーを表示順、氏名、社員番号の順で比較する。未設定の順序は末尾へ送り、画面と保存前の並びを安定させる。
  function compareUserEntries(left, right) {
    const leftOrder = Number(valueFor(left, "member_order") || 999999);
    const rightOrder = Number(valueFor(right, "member_order") || 999999);
    return leftOrder - rightOrder || displayNameFor(valueFor(left, "employee_id")).localeCompare(
      displayNameFor(valueFor(right, "employee_id")),
      "ja",
    ) || valueFor(left, "employee_id").localeCompare(
      valueFor(right, "employee_id"),
      "ja",
    );
  }

  // ユーザー管理表は正社員、派遣社員の順にし、同じ区分では社員番号を昇順にする。
  function compareUserTableEntries(left, right) {
    const employmentOrder = (entry) =>
      valueFor(entry, "employment_type") === "temporary" ? 1 : 0;
    return employmentOrder(left) - employmentOrder(right) ||
      valueFor(left, "employee_id").localeCompare(
        valueFor(right, "employee_id"), "ja", { numeric: true },
      );
  }

  // 組織管理では所属組織の表示順、その後ユーザー順で並べる。部長は最後に置く。
  function compareUserListEntries(left, right) {
    const organizationOrder = organizationDisplayOrder();
    // ユーザー一覧の所属順比較キーを求める。部長と未所属を末尾側へ置き、組織順序を一覧へ反映する。
    const key = (entry) =>
      valueFor(entry, "affiliation_type") === "director"
        ? Number.MAX_SAFE_INTEGER
        : organizationOrder.get(valueFor(entry, "organization_id")) ??
          Number.MAX_SAFE_INTEGER - 1;
    return key(left) - key(right) || compareUserEntries(left, right);
  }

  // 係とチームを組織階層の並び順に展開し、ユーザー一覧で使う組織IDから順序への対応表を作る。
  function organizationDisplayOrder() {
    const entries = drafts.get("team_master")?.entries || [];
    const order = new Map();
    let index = 0;
    entries
      .filter((entry) => valueFor(entry, "team_type") === "department")
      .sort(compareTeamEntries)
      .forEach((department) => {
        const departmentId = valueFor(department, "team_id");
        entries
          .filter(
            (entry) =>
              valueFor(entry, "team_type") === "section" &&
              valueFor(entry, "parent_team_id") === departmentId,
          )
          .sort(compareTeamEntries)
          .forEach((section) => order.set(valueFor(section, "team_id"), index++));
        order.set(departmentId, index++);
      });
    return order;
  }

  // 指定した組織から親をたどり、循環を検知しながら最上位からの組織パスを返す。
  function teamPathEntries(teamId) {
    const path = [];
    let current = teamEntryFor(teamId);
    const visited = new Set();
    while (current) {
      const currentId = valueFor(current, "team_id");
      if (!currentId || visited.has(currentId)) break;
      visited.add(currentId);
      path.unshift(current);
      current = teamEntryFor(valueFor(current, "parent_team_id"));
    }
    return path;
  }

  // 2つの組織パスを各階層の表示順で比較する。片方が欠落していても比較結果を安定させる。
  function compareTeamPaths(leftTeamId, rightTeamId) {
    const leftPath = teamPathEntries(leftTeamId);
    const rightPath = teamPathEntries(rightTeamId);
    for (let index = 0; index < Math.min(leftPath.length, rightPath.length); index += 1) {
      const difference = compareTeamEntries(leftPath[index], rightPath[index]);
      if (difference) return difference;
    }
    if (leftPath.length !== rightPath.length) {
      if (!leftPath.length) return 1;
      if (!rightPath.length) return -1;
      return leftPath.length - rightPath.length;
    }
    return 0;
  }

  // 所属組織の階層順を優先してユーザーを比較し、同じ組織内ではユーザー表示順へ委譲する。
  function compareTeamScopedUsers(left, right) {
    return compareTeamPaths(
      valueFor(left, "organization_id"),
      valueFor(right, "organization_id"),
    ) || compareUserEntries(left, right);
  }


  // 指定した階層と親を持つ子組織追加ボタンを生成する。
  function createChildTeamButton(level, parentTeamId, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "team-child-add-button";
    button.dataset.addChildLevel = level;
    button.dataset.parentTeamId = parentTeamId;
    button.append(createTeamSvgIcon("M12 5v14M5 12h14"), document.createTextNode(text));
    return button;
  }


  // 組織IDから対応するチーム下書き行を検索する。見つからない場合はundefinedを返す。
  function teamEntryFor(teamId) {
    return (drafts.get("team_master")?.entries || []).find(
      (entry) => valueFor(entry, "team_id") === teamId,
    );
  }


  // 組織行から親をたどり、循環を避けながらパンくず形式の名称を作る。
  function teamPathLabel(entry) {
    const entries = drafts.get("team_master")?.entries || [];
    const byTeamId = new Map(
      entries.map((candidate) => [valueFor(candidate, "team_id"), candidate]),
    );
    const names = [];
    let current = entry;
    const visited = new Set();
    while (current) {
      const id = valueFor(current, "team_id");
      if (visited.has(id)) break;
      visited.add(id);
      names.unshift(valueFor(current, "team_name") || "名称未設定");
      current = byTeamId.get(valueFor(current, "parent_team_id"));
    }
    return names.join(" ＞ ");
  }


  // 選択中チームを同じ親の兄弟間で上下移動し、sort_orderを再採番する。
  function moveSelectedTeam(direction) {
    const draft = drafts.get("team_master");
    const selected = draft?.entries.find((entry) => entry.id === draft.selectedId);
    if (!selected || !["up", "down"].includes(direction)) return;
    const parentId = valueFor(selected, "parent_team_id");
    const siblings = draft.entries
      .filter((entry) => valueFor(entry, "parent_team_id") === parentId)
      .sort(compareTeamEntries);
    const index = siblings.findIndex((entry) => entry.id === selected.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
    [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];
    siblings.forEach((entry, siblingIndex) => {
      entry.values.sort_order = String((siblingIndex + 1) * 10);
    });
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  // 同じ親を持つチームの並び位置から、上下移動の可否を返す。
  function teamMoveAvailability(entry) {
    const draft = drafts.get("team_master");
    const parentId = valueFor(entry, "parent_team_id");
    const siblings = (draft?.entries || [])
      .filter((candidate) => valueFor(candidate, "parent_team_id") === parentId)
      .sort(compareTeamEntries);
    const index = siblings.findIndex((candidate) => candidate.id === entry.id);
    return {
      up: index > 0,
      down: index >= 0 && index < siblings.length - 1,
    };
  }


  // チーム編集モーダルのツールバー・基本フィールド・所属ユーザー一覧を描画し、Sortableを初期化する。
  function renderTeamEditorModal(form, entry) {
    const definition = getDefinition("team_master");
    const validationErrors = teamEditorModalState?.validationErrors || {};
    const teamId = valueFor(entry, "team_id");
    const teamType = valueFor(entry, "team_type");
    const content = form.closest(".user-editor-dialog-content");
    const header = document.createElement("header");
    header.className = "user-editor-dialog-header team-editor-dialog-header";
    const title = document.createElement("h2");
    title.id = "teamEditorDialogTitle";
    title.textContent = teamType === "department" ? "係を編集" : "チームを編集";
    header.append(title);
    content?.insertBefore(header, form);

    const fields = document.createElement("div");
    fields.className = "inspector-fields team-editor-fields team-editor-modal-fields";
    ["team_type", "team_name"].forEach((key) => {
      const column = definition.columns.find((item) => item.key === key);
      if (!column) return;
      fields.append(
        createInspectorField(column, valueFor(entry, key), {
          required: true,
          disabled: key === "team_type",
          hideKey: true,
          errorMessage: validationErrors[key],
        }),
      );
    });

    form.append(fields, renderTeamEditorMembers(teamId));
    if (teamEditorModalState?.saveError) {
      form.append(createEditorInlineError(teamEditorModalState.saveError));
    }
    form.append(
      createEditorActionBar({
        modal: true,
        saveLabel: entry.isNew ? "作成" : "更新",
        deleteLabel: `${teamType === "department" ? "係" : "チーム"}を削除`,
      }),
    );
    initializeTeamEditorMemberSortables();
  }

  // 係・チームまたは部長に直接所属するユーザーをモーダル用カードとして描画する。通常の組織所属だけドラッグ並べ替え対象にする。
  function renderTeamEditorMembers(teamId, affiliationType = "organization") {
    const section = document.createElement("section");
    section.className = "organization-members-section team-editor-modal-members";
    const heading = document.createElement("h3");
    heading.textContent = "所属ユーザー";
    const list = document.createElement("div");
    list.className = "team-editor-modal-member-list";
    const sortableMembers = affiliationType === "organization";
    if (sortableMembers) {
      list.dataset.teamEditorMemberList = "true";
      list.dataset.teamEditorMemberTeamId = teamId;
      list.dataset.teamEditorMemberAffiliation = affiliationType;
    }
    list.setAttribute("role", "list");
    // チーム編集カードだけは、日報・コメント列の順序と逆向きに表示する。
    const members = directMembersFor(affiliationType, teamId).slice().reverse();
    members.forEach((member) => {
      const employeeId = valueFor(member, "employee_id");
      const card = document.createElement("div");
      card.className = "team-editor-modal-member-card";
      card.dataset.teamEditorMemberCard = "true";
      card.dataset.employeeId = employeeId;
      card.setAttribute("role", "listitem");
      const id = document.createElement("span");
      id.className = "team-editor-modal-member-id";
      id.textContent = employeeId;
      const name = document.createElement("strong");
      name.className = "team-editor-modal-member-name";
      name.textContent = valueFor(member, "display_name") || employeeId;
      if (sortableMembers) {
        const handle = document.createElement("span");
        handle.className = "team-editor-modal-member-drag-handle";
        handle.dataset.teamEditorMemberDragHandle = employeeId;
        handle.setAttribute("role", "img");
        handle.setAttribute("aria-label", `${valueFor(member, "display_name") || employeeId}の並び順をドラッグで変更`);
        handle.title = "ドラッグで並び替え";
        handle.append(
          createTeamSvgIcon(
            "M6 5h2v2H6V5Zm6 0h2v2h-2V5ZM6 11h2v2H6v-2Zm6 0h2v2h-2v-2ZM6 17h2v2H6v-2Zm6 0h2v2h-2v-2Z",
          ),
        );
        card.append(handle);
      }
      card.append(id, name);
      list.append(card);
    });
    if (!members.length) {
      const empty = document.createElement("p");
      empty.className = "team-editor-modal-member-empty";
      empty.textContent = "所属ユーザーはいません。";
      list.append(empty);
    }
    section.append(heading, list);
    return section;
  }

  // 組織/部長グループの直接所属ユーザー、順序操作、別所属への移動・追加UIを描画する。表示順を日報とコメント担当で共有する。
  function renderOrganizationMembersInspector(
    form,
    affiliationType,
    organizationId,
    teamEntry = null,
    includeHeader = true,
    options = {},
  ) {
    if (includeHeader) {
      form.append(createInspectorHeader("固定グループ", "部長"));
    }
    const section = document.createElement("section");
    section.className = "organization-editor-section organization-members-section";
    section.append(
      createSectionHeading(
        "直接所属ユーザー",
        "並び順は日報のユーザー行とコメント担当者列に共通で使われます。",
      ),
    );
    const members = directMembersFor(affiliationType, organizationId);
    const list = document.createElement("div");
    list.className = "organization-member-list";
    members.forEach((member, index) => {
      const employeeId = valueFor(member, "employee_id");
      const row = document.createElement("div");
      row.className = "organization-member-row";
      const copy = document.createElement("span");
      copy.className = "organization-member-copy";
      const name = document.createElement("strong");
      name.textContent = valueFor(member, "display_name") || employeeId;
      const meta = document.createElement("small");
      meta.textContent = `${employeeId} ・ 順序 ${valueFor(member, "member_order") || "未設定"}`;
      copy.append(name, meta);
      const controls = document.createElement("span");
      controls.className = "organization-member-controls";
      [["up", "上へ"], ["down", "下へ"]].forEach(([direction, label]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "team-member-order-button";
        button.dataset.organizationMemberMove = direction;
        button.dataset.employeeId = employeeId;
        button.textContent = label;
        button.disabled = direction === "up" ? index === 0 : index === members.length - 1;
        controls.append(button);
      });
      const destination = document.createElement("select");
      destination.dataset.moveUserAffiliation = "true";
      destination.dataset.employeeId = employeeId;
      destination.setAttribute("aria-label", `${name.textContent}の移動先`);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "別の所属へ移動…";
      destination.append(placeholder);
      organizationAffiliationChoices()
        .filter(([value]) => value !== affiliationValue(member))
        .forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          destination.append(option);
        });
      controls.append(destination);
      row.append(copy, controls);
      list.append(row);
    });
    if (!members.length) {
      const empty = document.createElement("p");
      empty.className = "admin-table-empty";
      empty.textContent = "直接所属ユーザーはいません。";
      list.append(empty);
    }

    const addField = document.createElement("label");
    addField.className = "inspector-field organization-add-member";
    const addLabel = document.createElement("span");
    addLabel.className = "inspector-field-label";
    addLabel.textContent = "別の所属からユーザーを移動";
    const addSelect = document.createElement("select");
    addSelect.dataset.addOrganizationMember = "true";
    addSelect.dataset.destination =
      affiliationType === "director" ? "director" : `organization:${organizationId}`;
    const addPlaceholder = document.createElement("option");
    addPlaceholder.value = "";
    addPlaceholder.textContent = "ユーザーを選択…";
    addSelect.append(addPlaceholder);
    (drafts.get("user_master")?.entries || [])
      .filter((entry) => !members.includes(entry))
      .sort(compareUserListEntries)
      .forEach((entry) => {
        const option = document.createElement("option");
        option.value = valueFor(entry, "employee_id");
        option.textContent = `${valueFor(entry, "display_name")}（現在: ${affiliationLabel(entry)}）`;
        addSelect.append(option);
      });
    addField.append(addLabel, addSelect);
    section.append(list, addField);
    form.append(section);
    if (includeHeader) form.append(createEditorActionBar({ modal: Boolean(options.modal) }));
  }

  // 同じ直接所属グループ内でユーザーを上下移動し、member_orderを再採番して一覧とインスペクターを同期する。
  function moveOrganizationMember(employeeId, direction) {
    const user = drafts
      .get("user_master")
      ?.entries.find((entry) => valueFor(entry, "employee_id") === employeeId);
    if (!user || !["up", "down"].includes(direction)) return;
    const siblings = directMembersFor(
      valueFor(user, "affiliation_type"),
      valueFor(user, "organization_id"),
    );
    const index = siblings.findIndex((entry) => entry.id === user.id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= siblings.length) return;
    [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];
    siblings.forEach((entry, siblingIndex) => {
      entry.values.member_order = String((siblingIndex + 1) * 10);
    });
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  // 社員番号に対応するコメント担当設定行を取得する。create指定時は初期値付きの新規行を下書きへ補完する。
  function assignmentEntryForUser(employeeId, create = false) {
    const draft = drafts.get("comment_assignment");
    let entry = draft?.entries.find(
      (item) => valueFor(item, "commenter_employee_id") === employeeId,
    );
    if (!entry && create && draft) {
      entry = createEntry(
        {
          commenter_employee_id: employeeId,
          target_type: "none",
          target_organization_ids: "",
          target_employee_ids: "",
        },
        getDefinition("comment_assignment"),
        true,
      );
      draft.entries.push(entry);
    }
    return entry || null;
  }

  // 現在選択中のユーザーのコメント担当設定行を取得し、必要なら作成する。
  function assignmentEntryForSelectedUser(create = false) {
    return assignmentEntryForUser(
      valueFor(getSelectedUser(), "employee_id"),
      create,
    );
  }

  // 指定ユーザーのコメント対象種別と対象IDをすべて解除し、所属変更などに伴う古い参照を残さない。
  function resetCommentAssignment(employeeId) {
    const assignment = assignmentEntryForUser(employeeId, true);
    if (!assignment) return;
    assignment.values.target_type = "none";
    assignment.values.target_organization_ids = "";
    assignment.values.target_employee_ids = "";
  }

  // ユーザーの所属を、所属登録なし・部長・organization:IDの選択値へ変換する。
  function affiliationValue(entry) {
    const affiliationType = valueFor(entry, "affiliation_type");
    const organizationId = valueFor(entry, "organization_id");
    if (affiliationType === "director") return "director";
    if (affiliationType !== "organization" || !organizationId) return "unassigned";
    return `organization:${organizationId}`;
  }

  // ユーザーの所属を部長・組織パス・所属登録なしの表示名へ変換する。
  function affiliationLabel(entry) {
    const affiliationType = valueFor(entry, "affiliation_type");
    if (affiliationType === "director") return "部長";
    if (affiliationType === "unassigned") return "所属登録なし";
    const organizationId = valueFor(entry, "organization_id");
    return teamPathLabel(teamEntryFor(organizationId)) || "所属登録なし";
  }

  // 同じ所属区分・組織IDのユーザーだけを抽出し、ユーザー一覧と同じ順序で並べる。
  function directMembersFor(affiliationType, organizationId) {
    return (drafts.get("user_master")?.entries || [])
      .filter((entry) =>
        valueFor(entry, "affiliation_type") === affiliationType &&
          valueFor(entry, "organization_id") === organizationId,
      )
      .sort(compareUserListEntries);
  }

  // コメント担当設定を一覧表示用の短い日本語へ要約する。なし・組織・複数係・個別設定を件数付きで区別する。
  function commentAssignmentSummary(employeeId) {
    const assignment = assignmentEntryForUser(employeeId);
    const type = valueFor(assignment, "target_type") || "none";
    if (type === "none") return "なし";
    if (type === "organization") {
      return (
        teamPathLabel(teamEntryFor(valueFor(assignment, "target_organization_ids"))) ||
        teamNameFor(valueFor(assignment, "target_organization_ids")) ||
        "組織"
      );
    }
    if (type === "departments") {
      const count = splitIds(valueFor(assignment, "target_organization_ids")).length;
      return `複数係（${count}係）`;
    }
    const count = splitIds(valueFor(assignment, "target_employee_ids")).length;
    const teamCount = splitIds(valueFor(assignment, "target_organization_ids")).length;
    if (teamCount) return `対象指定（${teamCount}チーム・${count}人）`;
    return "個別設定（" + count + "人）";
  }

  // 所属登録なし、部長、係、チームを階層順の所属選択肢へ展開する。ユーザーの移動先と編集フォームで同じ選択肢を使う。
  function organizationAffiliationChoices() {
    const teams = drafts.get("team_master")?.entries || [];
    const departments = teams
      .filter((entry) => valueFor(entry, "team_type") === "department")
      .sort(compareTeamEntries);
    const choices = [["unassigned", "所属登録なし"], ["director", "部長"]];
    departments.forEach((department) => {
      const departmentId = valueFor(department, "team_id");
      choices.push([`organization:${departmentId}`, teamPathLabel(department)]);
      teams
        .filter(
          (entry) =>
            valueFor(entry, "team_type") === "section" &&
            valueFor(entry, "parent_team_id") === departmentId,
        )
        .sort(compareTeamEntries)
        .forEach((section) => {
          choices.push([
            `organization:${valueFor(section, "team_id")}`,
            teamPathLabel(section),
          ]);
        });
    });
    return choices;
  }

  // 選択中ユーザーの所属変更を受け付け、確認を含む共通処理へ渡す。
  async function changeUserAffiliation(nextValue) {
    const user = getSelectedUser();
    if (!user) return;
    await applyUserAffiliationChange(user, nextValue);
  }

  // 指定社員番号のユーザーを探し、組織一覧からの所属移動を共通処理へ渡す。
  async function moveUserToAffiliation(employeeId, nextValue) {
    const user = drafts
      .get("user_master")
      ?.entries.find((entry) => valueFor(entry, "employee_id") === employeeId);
    if (!user) return;
    await applyUserAffiliationChange(user, nextValue);
  }

  // ユーザーの所属を変更し、担当設定がある場合は解除確認を行う。部長化時の入力制約と所属内表示順を更新して関連画面を再描画する。
  async function applyUserAffiliationChange(user, nextValue) {
    const previous = affiliationValue(user);
    if (!nextValue || previous === nextValue) {
      renderInspector();
      return;
    }
    const employeeId = valueFor(user, "employee_id");
    const assignment = assignmentEntryForUser(employeeId);
    if (assignment && valueFor(assignment, "target_type") !== "none") {
      const confirmed = await requestConfirmationDialog({
        title: "所属変更とコメント担当解除",
        description:
          "所属を変更すると、現在のコメント担当設定を解除します。保存後は過去分を含むコメント列の表示も変わります。",
        confirmLabel: "解除して所属を変更",
        cancelLabel: "変更しない",
        confirmTone: "danger",
      });
      if (!confirmed) {
        renderInspector();
        return;
      }
    }
    if (nextValue === "unassigned") {
      user.values.affiliation_type = "unassigned";
      user.values.organization_id = "";
    } else if (nextValue === "director") {
      user.values.affiliation_type = "director";
      user.values.organization_id = "";
      user.values.can_input_own_report = "0";
    } else {
      user.values.affiliation_type = "organization";
      user.values.organization_id = nextValue.replace(/^organization:/, "");
    }
    user.values.member_order = String(
      directMembersFor(
        user.values.affiliation_type,
        user.values.organization_id,
      ).length * 10,
    );
    resetCommentAssignment(employeeId);
    pruneInvalidCustomAssignments();
    renderMasterNav();
    renderTable();
    renderInspector();
    syncAdminChrome();
  }

  // 所属変更後にカスタムコメント対象から許可範囲外のIDを除去し、空になった設定をなしへ戻す。
  function pruneInvalidCustomAssignments() {
    (drafts.get("comment_assignment")?.entries || []).forEach((assignment) => {
      if (valueFor(assignment, "target_type") !== "custom") return;
      const commenter = drafts
        .get("user_master")
        ?.entries.find(
          (entry) =>
            valueFor(entry, "employee_id") ===
            valueFor(assignment, "commenter_employee_id"),
        );
      const allowed = new Set(
        allowedCustomTargets(commenter).map((entry) => valueFor(entry, "employee_id")),
      );
      assignment.values.target_employee_ids = splitIds(
        valueFor(assignment, "target_employee_ids"),
      )
        .filter((employeeId) => allowed.has(employeeId))
        .join(";");
      const allowedTeams = new Set(allowedCustomTeamTargets(commenter).map((entry) => valueFor(entry, "team_id")));
      assignment.values.target_organization_ids = splitIds(valueFor(assignment, "target_organization_ids"))
        .filter((id) => allowedTeams.has(id)).join(";");
      if (!assignment.values.target_employee_ids && !assignment.values.target_organization_ids) {
        assignment.values.target_type = "none";
      }
    });
  }

  // 選択ユーザーのコメント対象種別を正規化して保存する。組織指定はIDへ分離し、種別変更時に旧対象IDを消去する。
  function updateCommentTargetType(targetType) {
    const assignment = assignmentEntryForSelectedUser(true);
    if (!assignment) return;
    const normalizedTargetType = String(targetType || "");
    const organizationPrefix = "organization:";
    const organizationId = normalizedTargetType.startsWith(organizationPrefix)
      ? normalizedTargetType.slice(organizationPrefix.length)
      : "";
    assignment.values.target_type = organizationId ? "organization" : normalizedTargetType;
    assignment.values.target_organization_ids = organizationId;
    assignment.values.target_employee_ids = "";
    renderInspector();
    renderTable();
    syncAdminChrome();
  }

  // コメント対象のIDを選択/解除に応じて追加または除去し、重複のない区切り文字列として保存する。
  function toggleAssignmentListValue(column, id, selected) {
    const assignment = assignmentEntryForSelectedUser(true);
    if (!assignment) return;
    const values = splitIds(valueFor(assignment, column));
    const next = selected
      ? [...new Set([...values, id])]
      : values.filter((value) => value !== id);
    assignment.values[column] = next.join(";");
    // Keep the checklist DOM, focus and scroll position while editing the draft.
    syncAdminChrome();
  }

  // ユーザーの所属に応じてコメント対象にできる係・チームを返す。チーム所属では親係も含め、所属範囲外は候補に出さない。
  function allowedOrganizationTargets(user) {
    const organization = teamEntryFor(valueFor(user, "organization_id"));
    if (!organization) return [];
    const organizationId = valueFor(organization, "team_id");
    if (valueFor(organization, "team_type") === "section") {
      return [
        organization,
        teamEntryFor(valueFor(organization, "parent_team_id")),
      ].filter(Boolean).sort(compareTeamPathOrder);
    }
    return [
      organization,
      ...(drafts.get("team_master")?.entries || []).filter(
        (entry) =>
          valueFor(entry, "team_type") === "section" &&
          valueFor(entry, "parent_team_id") === organizationId,
      ),
    ].sort(compareTeamPathOrder);
  }

  // 係所属者が指定できる配下チームを返す。
  function allowedCustomTeamTargets(user) {
    const organization = teamEntryFor(valueFor(user, "organization_id"));
    if (valueFor(organization, "team_type") !== "department") return [];
    return allowedOrganizationTargets(user).filter((entry) => valueFor(entry, "team_type") === "section");
  }

  // 個人指定は同じ直接所属内の日報入力可能な他ユーザーに限定する。
  function allowedCustomTargets(user) {
    const organization = teamEntryFor(valueFor(user, "organization_id"));
    if (!organization) return [];
    const organizationIds = new Set([valueFor(organization, "team_id")]);
    return (drafts.get("user_master")?.entries || [])
      .filter(
        (entry) =>
          entry.id !== user.id &&
          valueFor(entry, "affiliation_type") === "organization" &&
          organizationIds.has(valueFor(entry, "organization_id")) &&
          valueFor(entry, "can_input_own_report") === "1",
      )
      .sort(compareUserListEntries);
  }

  // ユーザー編集モーダルを空にして、選択中ユーザーの組織所属・権限・コメント担当フォームを描画する。
  function renderUserEditorDialog() {
    const state = userEditorModalState;
    const entry = drafts
      .get("user_master")
      ?.entries.find((item) => item.id === state?.entryId);
    const form = byId("userEditorDialogForm");
    if (!entry || !form) return;
    const content = form.closest(".user-editor-dialog-content");
    content?.querySelector(".user-editor-dialog-header")?.remove();
    const header = document.createElement("header");
    header.className = "user-editor-dialog-header";
    const title = document.createElement("h2");
    title.id = "userEditorDialogTitle";
    title.textContent = entry.isNew ? "ユーザーを追加" : "ユーザーを編集";
    header.append(title);
    content?.insertBefore(header, form);
    form.replaceChildren();
    renderOrganizationUserInspector(form, entry);
  }

  // 組織所属ユーザーの基本情報、所属、雇用/管理者/日報入力、コメント対象を一つの編集フォームへ構成する。最後の管理者を変更できない制約もフィールドへ反映する。
  function renderOrganizationUserInspector(form, entry) {
    const definition = getDefinition("user_master");
    const validationErrors = userEditorModalState?.validationErrors || {};
    const fields = document.createElement("div");
    fields.className = "inspector-fields user-editor-fields";
    ["employee_id", "display_name"].forEach((key) => {
      const column = definition.columns.find((item) => item.key === key);
      const isRequired = key !== "employee_id" || entry.isNew;
      fields.append(
        createInspectorField(column, valueFor(entry, key), {
          required: isRequired,
          showRequiredTag: isRequired,
          disabled: key === "employee_id" && !entry.isNew,
          hideKey: true,
          errorMessage: validationErrors[key],
        }),
      );
    });

    const affiliationField = document.createElement("label");
    affiliationField.className = "inspector-field";
    const affiliationLabelElement = document.createElement("span");
    affiliationLabelElement.className = "inspector-field-label";
    affiliationLabelElement.textContent = "所属組織";
    const affiliationSelect = document.createElement("select");
    affiliationSelect.dataset.userAffiliation = "true";
    const currentAffiliation = affiliationValue(entry);
    organizationAffiliationChoices().forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      affiliationSelect.append(option);
    });
    affiliationSelect.value = currentAffiliation;
    affiliationSelect.required = false;
    affiliationSelect.classList.toggle(
      "is-invalid",
      Boolean(validationErrors.affiliation_type),
    );
    affiliationSelect.setAttribute(
      "aria-invalid",
      String(Boolean(validationErrors.affiliation_type)),
    );
    affiliationField.append(affiliationLabelElement, affiliationSelect);
    appendInspectorFieldError(
      affiliationField,
      validationErrors.affiliation_type,
    );

    ["employment_type", "is_admin", "can_input_own_report"].forEach((key) => {
      const column = definition.columns.find((item) => item.key === key);
      fields.append(
        createInspectorField(column, valueFor(entry, key), {
          required: Boolean(column.required),
          disabled:
            (key === "is_admin" && valueFor(entry, "employment_type") !== "regular") ||
            (key === "is_admin" && valueFor(entry, "is_admin") === "1" && regularAdministratorCount() <= 1) ||
            (key === "can_input_own_report" && valueFor(entry, "affiliation_type") === "director"),
          hideKey: true,
          errorMessage: validationErrors[key],
        }),
      );
    });
    fields.append(affiliationField);

    const assignmentSection = document.createElement("section");
    assignmentSection.className = "organization-editor-section user-comment-assignment-section";
    assignmentSection.append(renderCommentAssignmentEditor(entry));
    form.append(fields, assignmentSection);
    if (userEditorModalState?.saveError) {
      form.append(createEditorInlineError(userEditorModalState.saveError));
    }
    form.append(createUserEditorActions({ isNew: entry.isNew }));
  }

  // 雇用区分・所属に応じたコメント対象の選択肢と、複数係/個別対象のチェックリストを描画する。
  function renderCommentAssignmentEditor(user) {
    const assignment = assignmentEntryForUser(valueFor(user, "employee_id"), true);
    const wrap = document.createElement("div");
    wrap.className = "comment-assignment-editor";
    const typeField = document.createElement("label");
    typeField.className = "inspector-field";
    const label = document.createElement("span");
    label.className = "inspector-field-label";
    label.textContent = "コメント対象";
    const select = document.createElement("select");
    select.dataset.commentTargetType = "true";
    const isDirector = valueFor(user, "affiliation_type") === "director";
    const hasOrganization =
      valueFor(user, "affiliation_type") === "organization" &&
      Boolean(valueFor(user, "organization_id"));
    const isTemporary = valueFor(user, "employment_type") === "temporary";
    const isDepartment = valueFor(teamEntryFor(valueFor(user, "organization_id")), "team_type") === "department";
    const organizationChoices = allowedOrganizationTargets(user).filter((entry) =>
      !isDepartment || valueFor(entry, "team_id") === valueFor(user, "organization_id")
    ).map((entry) => {
      const organizationId = valueFor(entry, "team_id");
      return ["organization:" + organizationId, teamPathLabel(entry)];
    });
    const choices = isTemporary || (!isDirector && !hasOrganization)
      ? [["none", "なし"]]
      : isDirector
      ? [["none", "なし"], ["departments", "複数係"]]
      : [["none", "なし"], ...organizationChoices, ["custom", isDepartment ? "配下チーム・係直属の個人を指定" : "チーム内の個人を指定"]];
    choices.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    const assignmentType = valueFor(assignment, "target_type");
    // 旧形式の「係所属→単一チーム」は同じ対象のチーム指定として表示する。
    if (isDepartment && assignmentType === "organization" &&
        allowedCustomTeamTargets(user).some((entry) => valueFor(entry, "team_id") === valueFor(assignment, "target_organization_ids"))) {
      const legacyOption = document.createElement("option");
      legacyOption.value = "organization:" + valueFor(assignment, "target_organization_ids");
      legacyOption.textContent = "配下チーム指定（既存設定）";
      select.append(legacyOption);
      choices.push([legacyOption.value, legacyOption.textContent]);
    }
    const currentValue = assignmentType === "organization"
      ? "organization:" + valueFor(assignment, "target_organization_ids")
      : assignmentType;
    select.value = choices.some(([value]) => value === currentValue)
      ? currentValue
      : "none";
    typeField.append(label, select);
    wrap.append(typeField);

    if (select.value === "custom") {
      if (isDepartment) wrap.append(createAssignmentChecklist(
        "配下チーム", allowedCustomTeamTargets(user),
        splitIds(valueFor(assignment, "target_organization_ids")), "department",
      ));
      wrap.append(
        createAssignmentChecklist(
          isDepartment ? "係直属の担当者" : "チーム内の担当者",
          allowedCustomTargets(user),
          splitIds(valueFor(assignment, "target_employee_ids")),
          "employee",
        ),
      );
      if (isDepartment) {
        const allowedIds = new Set(allowedCustomTargets(user).map((entry) => valueFor(entry, "employee_id")));
        const legacyIds = splitIds(valueFor(assignment, "target_employee_ids")).filter((id) => !allowedIds.has(id));
        if (legacyIds.length) {
          wrap.append(createAssignmentChecklist(
            "旧個人指定：解除して配下チームを選び直してください",
            userEntriesForAssignment().filter((entry) => legacyIds.includes(valueFor(entry, "employee_id"))),
            legacyIds, "employee",
          ));
        }
      }
    } else if (select.value === "departments") {
      const departments = (drafts.get("team_master")?.entries || [])
        .filter((entry) => valueFor(entry, "team_type") === "department")
        .sort(compareTeamEntries);
      wrap.append(
        createAssignmentChecklist(
          "対象の係（複数選択）",
          departments,
          splitIds(valueFor(assignment, "target_organization_ids")),
          "department",
        ),
      );
    }
    return wrap;
  }

  // コメント対象IDのチェックリストを生成し、選択件数と空候補表示を付ける。
  function createAssignmentChecklist(titleText, entries, selectedIds, kind) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "assignment-checklist";
    const legend = document.createElement("legend");
    legend.textContent = `${titleText}（${selectedIds.length}件選択）`;
    fieldset.append(legend);
    entries.forEach((entry) => {
      const id =
        kind === "employee" ? valueFor(entry, "employee_id") : valueFor(entry, "team_id");
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = id;
      input.checked = selectedIds.includes(id);
      if (kind === "employee") input.dataset.commentTargetEmployee = "true";
      else input.dataset.commentTargetDepartment = "true";
      const text = document.createElement("span");
      text.textContent =
        kind === "employee"
          ? `${valueFor(entry, "display_name")}（${id}）`
          : teamPathLabel(entry);
      label.append(input, text);
      fieldset.append(label);
    });
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.textContent = "選択可能な対象がありません。";
      fieldset.append(empty);
    }
    return fieldset;
  }


  // ユーザー編集モーダルの取消・作成/更新操作を生成する。
  function createUserEditorActions({ isNew = false } = {}) {
    const actions = document.createElement("div");
    actions.className = "user-editor-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "inspector-cancel-button";
    cancelButton.dataset.userEditorCancel = "true";
    cancelButton.textContent = "キャンセル";
    actions.append(cancelButton);
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "inspector-save-button";
    saveButton.dataset.saveEditor = "true";
    saveButton.textContent = isNew ? "作成" : "更新";
    actions.append(saveButton);
    return actions;
  }

  // 社員番号から表示名を取得し、未登録なら社員番号を代替表示する。
  function displayNameFor(employeeId) {
    const entry = drafts
      .get("user_master")
      ?.entries.find((item) => valueFor(item, "employee_id") === employeeId);
    return valueFor(entry, "display_name") || employeeId;
  }

  // ---------------------------------------------------------------------------
  // 共通フォーム・操作DOMビルダー
  // ---------------------------------------------------------------------------
  // インスペクター上部の補助見出しとタイトルを生成する。
  function createInspectorHeader(eyebrowText, titleText) {
    const header = document.createElement("div");
    header.className = "inspector-form-header";
    const eyebrow = document.createElement("span");
    eyebrow.textContent = eyebrowText;
    const title = document.createElement("h3");
    title.textContent = titleText;
    header.append(eyebrow, title);
    return header;
  }

  // セクション見出しと説明文を生成する。説明が空なら段落を追加しない。
  function createSectionHeading(titleText, descriptionText) {
    const heading = document.createElement("div");
    heading.className = "inspector-section-heading";
    const copy = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = titleText;
    const description = document.createElement("p");
    description.textContent = descriptionText;
    copy.append(title);
    if (descriptionText) copy.append(description);
    heading.append(copy);
    return heading;
  }

  // ラベル行の右側に、検証時だけフィールドエラーを配置する。
  function appendInspectorFieldError(field, message) {
    if (!message) return;
    const error = document.createElement("span");
    error.className = "inspector-field-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    (field.querySelector(".inspector-field-label") || field).append(error);
  }

  // モーダル操作バーの直上に、保存失敗を表示する。
  function createEditorInlineError(message) {
    const error = document.createElement("p");
    error.className = "editor-inline-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    return error;
  }

  // 項目ラベルへ、保存に必要なことを示す視認用タグを追加する。入力自体のrequired属性とは分けて管理する。
  function appendRequiredTag(labelText) {
    const tag = document.createElement("span");
    tag.className = "inspector-required-tag";
    tag.textContent = "必須";
    tag.setAttribute("aria-hidden", "true");
    labelText.append(tag);
  }

  // 列定義に応じてラジオ、select、inputを生成し、必須・無効・不正表示と選択肢を共通化する。
  function createInspectorField(column, value, options = {}) {
    const isRadioField = [
      "employment_type",
      "admin_flag",
      "self_report_input",
    ].includes(column.type);
    const label = document.createElement(isRadioField ? "div" : "label");
    label.className = isRadioField
      ? "inspector-field inspector-radio-field"
      : "inspector-field";
    const labelText = document.createElement("span");
    labelText.className = "inspector-field-label";
    const visibleLabel = document.createElement("span");
    visibleLabel.textContent = column.label;
    const key = document.createElement("small");
    key.textContent = column.key;
    labelText.append(visibleLabel);
    if (options.showRequiredTag) appendRequiredTag(labelText);
    if (!options.hideKey) labelText.append(key);

    if (isRadioField) {
      const radioGroup = document.createElement("div");
      radioGroup.className = "inspector-radio-group";
      radioGroup.setAttribute("role", "radiogroup");
      radioGroup.setAttribute("aria-label", column.label);
      const choices =
        column.type === "employment_type"
          ? [["regular", "正社員"], ["temporary", "派遣社員"]]
          : column.type === "admin_flag"
            ? [["1", "管理者"], ["0", "一般"]]
            : [["1", "要"], ["0", "不要"]];
      // 必須項目の未入力はタグで案内し、保存後の検証エラーだけを赤く表示する。
      const isInvalid = Boolean(options.errorMessage);
      choices.forEach(([optionValue, text], index) => {
        const optionLabel = document.createElement("label");
        optionLabel.className = "inspector-radio-option";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "user-editor-" + column.key;
        radio.value = optionValue;
        radio.checked = String(value) === optionValue;
        radio.dataset.column = column.key;
        radio.required = Boolean(options.required) && index === 0;
        radio.disabled = Boolean(options.disabled);
        radio.autocomplete = "off";
        radio.classList.toggle("is-invalid", isInvalid);
        radio.setAttribute("aria-invalid", String(isInvalid));
        const optionText = document.createElement("span");
        optionText.textContent = text;
        optionLabel.append(radio, optionText);
        radioGroup.append(optionLabel);
      });
      radioGroup.classList.toggle("is-invalid", isInvalid);
      radioGroup.setAttribute("aria-invalid", String(isInvalid));
      label.append(labelText, radioGroup);
      appendInspectorFieldError(label, options.errorMessage);
      if (options.hint) {
        const hint = document.createElement("small");
        hint.className = "inspector-field-hint";
        hint.textContent = options.hint;
        label.append(hint);
      }
      return label;
    }

    let input;
    if (
      [
        "boolean",
        "active",
        "team_type",
        "organization",
        "affiliation_type",
        "parent_department",
      ].includes(column.type)
    ) {
      input = document.createElement("select");
      let choices = [];
      if (column.type === "boolean") {
        choices = [["0", "稼働日"], ["1", "休日"]];
      } else if (column.type === "active") {
        choices = [["1", "有効"], ["0", "廃止"]];
      } else if (column.type === "team_type") {
        choices = [["department", "係"], ["section", "チーム"]];
      } else if (column.type === "affiliation_type") {
        choices = [
          ["unassigned", "所属登録なし"],
          ["organization", "係・チーム"],
          ["director", "部長"],
        ];
      } else if (column.type === "organization") {
        choices = [["", "所属を選択"], ...teamAssignmentChoices()];
      } else if (column.type === "parent_department") {
        choices = [["", "親係を選択"], ...teamChoices("department")];
      }
      choices.forEach(([optionValue, text]) => {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = text;
        input.append(option);
      });
    } else {
      input = document.createElement("input");
      input.type = column.type;
      if (column.type === "number") {
        input.min = "0";
        input.max = "9999";
        input.step = "1";
        input.placeholder = "未設定";
      }
    }
    input.dataset.column = column.key;
    if (input.type !== "checkbox") input.value = value;
    input.required = Boolean(options.required);
    input.disabled = Boolean(options.disabled);
    input.autocomplete = "off";
    // 必須項目の未入力はタグで案内し、保存後の検証エラーだけを赤く表示する。
    const isInvalid = Boolean(options.errorMessage);
    input.classList.toggle("is-invalid", isInvalid);
    input.setAttribute("aria-invalid", String(isInvalid));
    label.append(labelText, input);
    appendInspectorFieldError(label, options.errorMessage);
    if (options.hint) {
      const hint = document.createElement("small");
      hint.className = "inspector-field-hint";
      hint.textContent = options.hint;
      label.append(hint);
    }
    return label;
  }

  // 指定階層の組織を表示順と名称順で並べ、IDとラベルの選択肢へ変換する。
  function teamChoices(level) {
    return (drafts.get("team_master")?.entries || [])
      .filter((entry) =>
        valueFor(entry, "team_type") === level,
      )
      .sort((left, right) => {
        const leftOrder = Number(valueFor(left, "sort_order") || 999999);
        const rightOrder = Number(valueFor(right, "sort_order") || 999999);
        return leftOrder - rightOrder || teamNameFor(valueFor(left, "team_id")).localeCompare(
          teamNameFor(valueFor(right, "team_id")),
          "ja",
        );
      })
      .map((entry) => [
        valueFor(entry, "team_id"),
        teamNameFor(valueFor(entry, "team_id")),
      ]);
  }

  // 所属先として選択可能な係・チームだけを組織パス順の選択肢へ変換する。
  function teamAssignmentChoices() {
    const entries = drafts.get("team_master")?.entries || [];
    return entries
      .filter((entry) => ["department", "section"].includes(valueFor(entry, "team_type")))
      .sort(compareTeamPathOrder)
      .map((entry) => [valueFor(entry, "team_id"), teamPathLabel(entry)]);
  }

  // 親階層から積み上げたsort_order配列を比較し、組織パスの表示順を安定させる。
  function compareTeamPathOrder(left, right) {
    const entries = drafts.get("team_master")?.entries || [];
    const byId = new Map(entries.map((entry) => [valueFor(entry, "team_id"), entry]));
    // 組織行から親をたどって各階層のsort_orderをキー化する。循環があっても処理を停止できる構造を保つ。
    const key = (entry) => {
      const orders = [];
      let current = entry;
      while (current) {
        orders.unshift(Number(valueFor(current, "sort_order") || 999999));
        current = byId.get(valueFor(current, "parent_team_id"));
      }
      return orders;
    };
    const leftKey = key(left);
    const rightKey = key(right);
    for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
      const delta = (leftKey[index] ?? -1) - (rightKey[index] ?? -1);
      if (delta) return delta;
    }
    return valueFor(left, "team_name").localeCompare(valueFor(right, "team_name"), "ja");
  }

  // 指定階層に該当する親候補を除外ID以外から集め、パス付き選択肢へ変換する。
  function teamParentChoices(levels, excludedTeamId) {
    return (drafts.get("team_master")?.entries || [])
      .filter((entry) =>
        levels.includes(valueFor(entry, "team_type")),
      )
      .filter((entry) => valueFor(entry, "team_id") !== excludedTeamId)
      .sort(compareTeamEntries)
      .map((entry) => [valueFor(entry, "team_id"), teamPathLabel(entry)]);
  }

  // ユーザー行の編集/削除アクションボタンを生成する。管理者保護対象の削除は非表示にする。
  function createUserRowAction(action, entry, displayLabel) {
    const button = document.createElement("button");
    const isEdit = action === "edit";
    const iconPath = isEdit
      ? EMBEDDED_EDIT_ICON_PATH
      : EMBEDDED_DELETE_ICON_PATH;
    button.type = "button";
    button.className = "api-key-action " + action;
    button.dataset.userRowAction = action;
    button.dataset.userId = entry.id;
    button.setAttribute(
      "aria-label",
      displayLabel + (isEdit ? "を編集" : "を削除"),
    );
    button.title = isEdit ? "編集" : "削除";
    if (!isEdit && isProtectedAdministratorEntry(entry)) {
      button.hidden = true;
      button.setAttribute("aria-hidden", "true");
    }
    const iconWrap = document.createElement("span");
    const icon = createTeamSvgIcon(iconPath);
    const iconPathElement = icon.querySelector("path");
    iconPathElement.setAttribute("fill-rule", "evenodd");
    iconPathElement.setAttribute("clip-rule", "evenodd");
    iconPathElement.setAttribute("fill", "currentColor");
    iconWrap.append(icon);
    button.append(iconWrap);
    return button;
  }

  // 編集フォームの保存ボタンと、モーダル時だけ削除・取消ボタンを持つ操作バーを生成する。
  function createEditorActionBar({ modal = false, deleteLabel = "", saveLabel = "保存" } = {}) {
    const actions = document.createElement("div");
    actions.className = modal
      ? "team-editor-modal-actions"
      : "inspector-record-actions";
    if (modal) {
      if (deleteLabel) {
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "inspector-delete-button";
        deleteButton.dataset.deleteRow = "true";
        deleteButton.textContent = "削除";
        deleteButton.setAttribute("aria-label", deleteLabel);
        actions.append(deleteButton);
      }
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "inspector-cancel-button";
      cancelButton.dataset.teamEditorCancel = "true";
      cancelButton.textContent = "キャンセル";
      actions.append(cancelButton);
    }
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "inspector-save-button";
    saveButton.dataset.saveEditor = "true";
    saveButton.textContent = saveLabel;
    actions.append(saveButton);
    return actions;
  }

  // ---------------------------------------------------------------------------
  // 公開APIとホスト側クロームの同期
  // ---------------------------------------------------------------------------
  // 4マスターそれぞれの未保存状態を数え、変更ファイル数バッジの基礎値を返す。
  function dirtyFileCount() {
    let count = 0;
    if (isDraftDirty(drafts.get("user_master"))) count += 1;
    if (isDraftDirty(drafts.get("team_master"))) count += 1;
    if (isDraftDirty(drafts.get("comment_assignment"))) count += 1;
    if (isDraftDirty(drafts.get("calendar"))) count += 1;
    return count;
  }

  // 未保存件数、保存ボタンの有効状態、台帳表示、ホスト側未保存状態を現在の下書きへ同期する。
  function syncAdminChrome() {
    const count = dirtyFileCount();
    const badge = byId("adminDirtyBadge");
    const ledger = byId("adminLedgerCount");
    const activeEditorDirty =
      activeMaster === "team_master"
        ? isOrganizationAdministrationDirty()
        : isDefinitionDirty(activeMaster);
    if (badge) {
      badge.classList.toggle("hidden", count === 0);
      badge.textContent = `${count}ファイル変更中`;
    }
    document.querySelectorAll("[data-save-editor]").forEach((button) => {
      button.disabled = !activeEditorDirty || isLoading;
    });
    const teamSaveButton = byId("adminTeamSaveButton");
    if (teamSaveButton) {
      const teamActive = activeMaster === "team_master" && !isCalendarReadOnly;
      const teamDirty = isOrganizationAdministrationDirty();
      teamSaveButton.classList.toggle("hidden", !teamActive);
      teamSaveButton.disabled = !teamActive || !teamDirty || isLoading;
      teamSaveButton.querySelector(".save-pending-indicator")?.classList.toggle("hidden", !teamDirty);
    }
    const calendarSaveButton = byId("adminCalendarSaveButton");
    const reloadButton = byId("adminReloadButton");
    if (reloadButton) reloadButton.hidden = isCalendarReadOnly;
    if (calendarSaveButton) {
      const calendarActive = activeMaster === "calendar";
      const calendarDirty = isDefinitionDirty("calendar");
      calendarSaveButton.classList.toggle("hidden", isCalendarReadOnly || !calendarActive);
      calendarSaveButton.disabled =
        !calendarActive || !calendarDirty || isLoading;
      const calendarIndicator = calendarSaveButton.querySelector?.(
        ".save-pending-indicator",
      );
      calendarIndicator?.classList.toggle(
        "hidden",
        !calendarActive || !calendarDirty,
      );
    }
    if (ledger) ledger.textContent = count === 0 ? "変更はありません" : `${count}ファイルを編集中`;
    if (typeof syncNativeUnsavedState === "function") {
      syncNativeUnsavedState(hasUnsavedChanges());
    }
  }

  // いずれかのマスターに未保存変更があるかを返す。
  function hasUnsaved() {
    return dirtyFileCount() > 0;
  }

  window.adminMasters = {
    initialize,
    ensureLoaded,
    activate,
    activateCalendar,
    reload,
    reloadCalendar,
    discardUnsaved,
    hasUnsaved,
    save,
    syncChrome: syncAdminChrome,
    // バックエンドの年度ポリシーを反映し、画面側に年度の固定値を重複させない。
    setMinimumFiscalYear(value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) return;
      minimumFiscalYear = parsed;
      activeFiscalYear = Math.max(activeFiscalYear, minimumFiscalYear);
      calendarViewFiscalYear = Math.max(calendarViewFiscalYear, minimumFiscalYear);
      if (isLoaded) render();
    },
    // ログイン中の社員番号を記録し、管理者保護の判定に使う。読込済みなら保護対象表示を直ちに再描画する。
    setCurrentEmployeeId(employeeId) {
      currentEmployeeId = String(employeeId || "");
      if (isLoaded) render();
    },
  };
})();

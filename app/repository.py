from __future__ import annotations

import hashlib
import io
from contextlib import contextmanager
import logging
import os
import shutil
import stat
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import polars as pl
from app.rich_text import RICH_FIELDS, EMPTY_RICH_TEXT, serialize as serialize_rich_text

from app.calendar_policy import DEFAULT_MISSING_COMMENT_START_DATE
from app.config import AppSettings, validate_storage_directories
from app.config import StorageConfigError
from app.security import (
    COMMON_MASTER_COLUMNS,
    USER_MASTER_DEFAULTS,
    safe_employee_csv_path,
    validate_employee_id,
)


logger = logging.getLogger(__name__)

JST = ZoneInfo("Asia/Tokyo")

USER_COLUMNS = [
    "record_type",
    "employee_id",
    "date",
    "business_name",
    "business_name_rich_text",
    "business_detail",
    "business_detail_rich_text",
    "reply_to_employee_id",
    "reply_text",
    "reply_rich_text",
    "updated_at",
]
USER_KEYS = ["record_type", "employee_id", "date", "reply_to_employee_id"]
COMMENT_COLUMNS = [
    "superior_employee_id",
    "subordinate_employee_id",
    "date",
    "comment",
    "comment_rich_text",
    "updated_at",
]
CSV_ENCODINGS = ("utf8", "cp932")
DEFAULT_BACKUP_LIMIT = 20
ORGANIZATION_MASTERS = ("user_master", "team_master", "comment_assignment")
ADMINISTRATION_COLUMNS = ["record_type", *dict.fromkeys(
    column for master in ORGANIZATION_MASTERS for column in COMMON_MASTER_COLUMNS[master]
)]


class CommonMasterConflictError(RuntimeError):
    """The common CSV changed after it was loaded in the admin screen."""


class ReportConflictError(RuntimeError):
    """読み込み後に社員CSVが変更されたため、上書きを拒否した。"""


class ReportFormatError(ValueError):
    """日報CSVが現在の行形式に一致しない。"""


class CsvFileLockedError(PermissionError):
    """A target CSV could not be replaced because another process owns it."""


class CsvReadonlyError(OSError):
    """The final read-only protection flag could not be applied."""


class DailyReportRepository:
    def __init__(self, settings: AppSettings, base_dir: Path) -> None:
        self.defer_partition_normalization = False
        self.settings = settings
        self.base_dir = base_dir
        self.load_warnings: list[dict[str, str]] = []
        self.backup_limit = DEFAULT_BACKUP_LIMIT
        self.loaded_common_revisions: dict[str, str] = {}
        self.loaded_report_revisions: dict[str, str] = {}
        self.loaded_report_fingerprints: dict[str, tuple[int, int]] = {}

    @staticmethod
    def now_jst() -> datetime:
        return datetime.now(JST).replace(tzinfo=None)

    @staticmethod
    def today_jst() -> date:
        return datetime.now(JST).date()

    def validate_paths(self) -> None:
        # Common data is needed to determine employment type and permission
        # scope.  Report directories are validated after that common data has
        # been read, so a temporary employee never probes the regular folder.
        errors = validate_storage_directories(
            self.settings, required_kinds={"common"}
        )
        if errors:
            target, message = next(iter(errors.items()))
            raise StorageConfigError(
                message,
                code="storage_directory_unavailable",
                target=target,
            )

    def validate_report_directory(self, employment_type: str) -> None:
        kind = (
            "temporary_reports"
            if str(employment_type).strip() == "temporary"
            else "regular_reports"
        )
        errors = validate_storage_directories(
            self.settings, required_kinds={kind}
        )
        if errors:
            target, message = next(iter(errors.items()))
            raise StorageConfigError(
                message,
                code="storage_directory_unavailable",
                target=target,
            )

    def storage_dir(self, kind: str) -> Path:
        return self.settings.storage_dir(kind)

    def load_common(self) -> dict[str, list[dict[str, Any]]]:
        common_dir = self.storage_dir("common")
        users, teams, assignments, schema_mode = self._load_organization_masters(
            common_dir
        )
        return {
            "user_master": users,
            "team_master": teams,
            "comment_assignment": assignments,
            "calendar": self._load_calendar(common_dir),
            "organization_schema": [{"mode": schema_mode}],
        }

    def load_common_masters(self) -> dict[str, list[dict[str, Any]]]:
        common_dir = self.storage_dir("common")
        users, teams, assignments, schema_mode = self._load_organization_masters(
            common_dir
        )
        return {
            "user_master": users,
            "team_master": teams,
            "comment_assignment": assignments,
            "calendar": self._load_calendar(common_dir),
            "organization_schema": [{"mode": schema_mode}],
        }

    def _load_organization_masters(self, common_dir: Path) -> tuple[
        list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], str
    ]:
        unified = common_dir / "administration.csv"
        if unified.exists():
            try:
                raw = unified.read_bytes()
                source = self._read_csv_bytes(raw)
                if source.columns != ADMINISTRATION_COLUMNS:
                    raise ValueError("管理CSVの列が現行形式と一致しません。")
                if not set(source["record_type"].to_list()) <= set(ORGANIZATION_MASTERS):
                    raise ValueError("管理CSVに不正なデータ種別があります。")
                revision = hashlib.sha256(raw).hexdigest()
                self.loaded_common_revisions.update(dict.fromkeys(ORGANIZATION_MASTERS, revision))
                frames = {
                    master: source.filter(pl.col("record_type") == master).select(
                        list(COMMON_MASTER_COLUMNS[master])
                    ) for master in ORGANIZATION_MASTERS
                }
                return (self._normalize_user_rows(frames["user_master"]),
                        frames["team_master"].to_dicts(),
                        frames["comment_assignment"].to_dicts(), "new")
            except Exception as exc:
                self._record_load_warning(unified, exc)
                return [], [], [], "new"
        frames: dict[str, pl.DataFrame] = {}
        for master in ("user_master", "team_master", "comment_assignment"):
            path = common_dir / f"{master}.csv"
            columns = list(COMMON_MASTER_COLUMNS[master])
            try:
                raw = path.read_bytes()
                source = self._read_csv_bytes(raw)
                self.loaded_common_revisions[master] = hashlib.sha256(raw).hexdigest()
                if set(source.columns) != set(columns):
                    raise ValueError(f"{master}のCSV列が現行形式と一致しません。")
                frames[master] = source
            except Exception as exc:
                self._record_load_warning(path, exc)
                frames[master] = self._empty_df(columns)
        return (
            self._normalize_user_rows(frames["user_master"]),
            frames["team_master"].to_dicts(),
            frames["comment_assignment"].to_dicts(),
            "new",
        )


    def _normalize_user_rows(self, source: pl.DataFrame) -> list[dict[str, Any]]:
        columns = list(COMMON_MASTER_COLUMNS["user_master"])
        rows = self._ensure_columns(source, columns).to_dicts()
        for row in rows:
            for column, default in USER_MASTER_DEFAULTS.items():
                if not str(row.get(column, "")).strip():
                    row[column] = default
            if (
                row.get("affiliation_type") == "organization"
                and not str(row.get("organization_id", "")).strip()
            ):
                row["affiliation_type"] = "unassigned"
            if row.get("employment_type") == "temporary":
                row["is_admin"] = "0"
        return rows


    def _load_calendar(self, common_dir: Path) -> list[dict[str, Any]]:
        path = common_dir / "calendar.csv"
        if not path.exists():
            self._record_load_warning(path, FileNotFoundError("ファイルがありません"))
            return []
        try:
            source = self._read_csv_frame(path)
        except Exception as exc:
            self._record_load_warning(path, exc)
            return []

        if source.columns != ["date"]:
            self._record_load_warning(path, ValueError("calendarのCSV列が現行形式と一致しません。"))
            return []
        dates: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in source.to_dicts():
            date_text = str(row.get("date", "")).strip()
            if not date_text or date_text in seen:
                continue
            seen.add(date_text)
            dates.append({"date": date_text})
        return dates

    def get_common_master_revisions(self) -> dict[str, str]:
        root = self.storage_dir("common")
        if (root / "administration.csv").exists():
            revision = self._common_master_revision(root / "administration.csv")
            return {**dict.fromkeys(ORGANIZATION_MASTERS, revision),
                    "calendar": self.get_common_master_revision("calendar")}
        return {master: self.get_common_master_revision(master) for master in COMMON_MASTER_COLUMNS}

    def get_loaded_common_revisions(self) -> dict[str, str]:
        """表示した内容の版を返し、読み込み失敗した管理データの保存を防ぐ。"""
        return {**{master: self.loaded_common_revisions.get(master, "")
                   for master in ORGANIZATION_MASTERS},
                "calendar": self.get_common_master_revision("calendar")}

    def get_common_master_revision(self, master: str) -> str:
        if master not in COMMON_MASTER_COLUMNS:
            raise ValueError("管理の種類が不正です。")
        root = self.storage_dir("common")
        path = root / f"{master}.csv"
        if master in ORGANIZATION_MASTERS and (root / "administration.csv").exists():
            path = root / "administration.csv"
        return self._common_master_revision(path)

    def save_common_master(
        self,
        master: str,
        rows: list[dict[str, str]],
        expected_revision: str = "",
    ) -> str:
        if master not in COMMON_MASTER_COLUMNS:
            raise ValueError("管理の種類が不正です。")
        if master in ORGANIZATION_MASTERS:
            raise ValueError("組織・ユーザー管理は一括保存してください。")
        columns = list(COMMON_MASTER_COLUMNS[master])
        normalized = [
            {column: str(row.get(column, "")) for column in columns}
            for row in rows
        ]
        df = (
            pl.DataFrame(normalized, schema=columns, orient="row")
            if normalized
            else self._empty_df(columns)
        )
        target_path = self.storage_dir("common") / f"{master}.csv"
        if (
            expected_revision
            and self._common_master_revision(target_path) != expected_revision
        ):
            raise CommonMasterConflictError(
                "管理が別の場所で更新されています。"
            )
        self._write_csv_atomically(df, target_path, "common")
        return self._common_master_revision(target_path)

    def save_user_administration(
        self,
        users: list[dict[str, str]],
        expected_revisions: dict[str, str],
    ) -> dict[str, str]:
        with self._administration_lock():
            common = self.load_common_masters()
            if self.load_warnings:
                raise ValueError("管理データを正常に読み込めないため保存できません。")
            return self._save_administration_locked(
                common["team_master"], users, common["comment_assignment"], expected_revisions
            )

    def save_administration(
        self,
        teams: list[dict[str, str]],
        users: list[dict[str, str]],
        comment_assignments: list[dict[str, str]],
        expected_revisions: dict[str, str],
    ) -> dict[str, str]:
        with self._administration_lock():
            return self._save_administration_locked(teams, users, comment_assignments, expected_revisions)

    @contextmanager
    def _administration_lock(self):
        """共有先の固定ファイルをOSでロックし、異常終了時にも解放できるようにする。"""
        path = self.storage_dir("common") / "administration.lock"
        with self._csv_save_lock(path, "別の管理者が保存中か、保存用ロックを取得できません。少し待って再度保存してください。"):
            yield

    @contextmanager
    def _csv_save_lock(self, path: Path, message: str):
        """CSVとは別の固定ファイルをロックし、読み取りから置換まで排他する。"""
        with path.open("a+b") as stream:
            # Windowsのバイト範囲ロックは空ファイルの先頭にも取得できる。
            stream.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise CsvFileLockedError(message) from exc
            try:
                yield
            finally:
                stream.seek(0)
                if os.name == "nt":
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def _save_administration_locked(
        self,
        teams: list[dict[str, str]],
        users: list[dict[str, str]],
        assignments: list[dict[str, str]],
        expected_revisions: dict[str, str],
    ) -> dict[str, str]:
        """ロック中に版を検証し、関連する管理データを一度の置換で保存する。"""
        from app.security import validate_administration_save_request
        current = self.get_common_master_revisions()
        for master in ORGANIZATION_MASTERS:
            if not expected_revisions.get(master) or expected_revisions[master] != current[master]:
                raise CommonMasterConflictError("管理が別の場所で更新されています。再読み込みしてください。")
        teams, users, assignments, _ = validate_administration_save_request({
            "teams": teams, "users": users, "comment_assignments": assignments,
            "revisions": {master: expected_revisions[master] for master in ORGANIZATION_MASTERS},
        })
        rows = []
        for master, values in zip(ORGANIZATION_MASTERS, (users, teams, assignments)):
            for row in self._common_master_frame(master, values).to_dicts():
                rows.append({column: master if column == "record_type" else row.get(column, "")
                             for column in ADMINISTRATION_COLUMNS})
        frame = pl.DataFrame(rows, schema=ADMINISTRATION_COLUMNS, orient="row") if rows else self._empty_df(ADMINISTRATION_COLUMNS)
        target = self.storage_dir("common") / "administration.csv"
        self._write_csv_atomically(frame, target, "common")
        revision = self._common_master_revision(target)
        return dict.fromkeys(ORGANIZATION_MASTERS, revision)

    def _common_master_frame(
        self, master: str, rows: list[dict[str, str]]
    ) -> pl.DataFrame:
        columns = list(COMMON_MASTER_COLUMNS[master])
        normalized = [
            {column: str(row.get(column, "")) for column in columns}
            for row in rows
        ]
        if master == "user_master":
            for row in normalized:
                for column, default in USER_MASTER_DEFAULTS.items():
                    if not row[column].strip():
                        row[column] = default
        return (
            pl.DataFrame(normalized, schema=columns, orient="row")
            if normalized
            else self._empty_df(columns)
        )


    @staticmethod
    def _common_master_revision(path: Path) -> str:
        if not path.exists():
            return "missing"
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _read_csv(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            self._record_load_warning(path, FileNotFoundError("ファイルがありません"))
            return []
        try:
            return self._read_csv_frame(path).to_dicts()
        except Exception as exc:
            self._record_load_warning(path, exc)
            return []

    def _read_csv_frame(self, path: Path) -> pl.DataFrame:
        return self._read_csv_bytes(path.read_bytes())

    def _read_csv_bytes(self, raw: bytes) -> pl.DataFrame:
        """同一の読み取り結果からCSVと競合確認用ハッシュを生成する。"""
        errors: list[str] = []
        for encoding in CSV_ENCODINGS:
            try:
                return pl.read_csv(
                    io.BytesIO(raw),
                    infer_schema_length=0,
                    encoding=encoding,
                ).fill_null("")
            except Exception as exc:
                errors.append(f"{encoding}: {exc}")
        raise RuntimeError(" / ".join(errors))

    def _record_load_warning(self, path: Path, error: Exception) -> None:
        warning = {"file": path.name, "error": str(error)}
        self.load_warnings.append(warning)
        try:
            log_dir = self.base_dir / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            timestamp = self.now_jst().isoformat(timespec="seconds")
            with (log_dir / "daily_report.log").open("a", encoding="utf-8") as log:
                log.write(f"{timestamp} CSV読み込み失敗: {path} - {error}\n")
        except Exception:
            # ログ出力失敗によって、読み込めたデータの表示まで止めない。
            pass

    def load_view_data(
        self,
        employee_id: str,
        start_date: str | None = None,
        end_date: str | None = None,
        period_preset: str | None = None,
    ) -> dict[str, Any]:
        common = self.load_common()
        global_order = self._global_user_order(common)
        assignments = self._resolved_comment_assignments(
            common, global_order=global_order
        )
        scope = self.resolve_view_scope(
            common,
            employee_id,
            global_order=global_order,
            assignments=assignments,
        )
        target_employee_ids = scope["target_employee_ids"]
        users_df = self._load_all_user_rows(target_employee_ids, common)
        comments_df = self._load_all_comment_rows(target_employee_ids)
        return self.build_view_data_from_cache(
            employee_id,
            common,
            users_df,
            comments_df,
            start_date=start_date,
            end_date=end_date,
            period_preset=period_preset,
            load_warning_count=len(self.load_warnings),
            global_order=global_order,
            assignments=assignments,
        )

    def resolve_view_scope(
        self,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        *, global_order: list[str] | None = None,
        assignments: tuple[dict[str, set[str]], dict[str, list[str]]] | None = None,
    ) -> dict[str, Any]:
        global_order = global_order if global_order is not None else self._global_user_order(common)
        assignments = assignments if assignments is not None else self._resolved_comment_assignments(common, global_order=global_order)
        user_master = {row.get("employee_id", ""): row for row in common["user_master"]}
        current_user = user_master.get(employee_id, {})
        is_temporary_user = self._is_temporary_user(current_user)
        assigned_subordinate_ids = (
            set()
            if is_temporary_user
            else set(assignments[0].get(employee_id, set()))
        )
        viewable_members = self._build_viewable_members(
            common, employee_id, assigned_subordinate_ids, global_order=global_order
        )
        return {
            "user_master": user_master,
            "current_user": current_user,
            "is_temporary_user": is_temporary_user,
            "assigned_subordinate_ids": assigned_subordinate_ids,
            "viewable_members": viewable_members,
            "target_employee_ids": [
                member["employee_id"] for member in viewable_members
            ],
        }

    def build_view_data_from_cache(
        self,
        employee_id: str,
        common: dict[str, list[dict[str, Any]]],
        users_df: pl.DataFrame,
        comments_df: pl.DataFrame,
        start_date: str | None = None,
        end_date: str | None = None,
        period_preset: str | None = None,
        load_warning_count: int = 0,
        failed_report_employee_ids: set[str] | None = None,
        failed_comment_superior_ids: set[str] | None = None,
        missing_comment_summary: dict[str, Any] | None = None,
        columnar_rows: bool = False,
        global_order: list[str] | None = None,
        assignments: tuple[dict[str, set[str]], dict[str, list[str]]] | None = None,
        report_revision: str | None = None,
    ) -> dict[str, Any]:
        if period_preset == "previousWorkday":
            previous_working_date = self._previous_working_date(common["calendar"])
            start_date = previous_working_date.isoformat()
            end_date = start_date
        holiday_dates = {
            calendar_date
            for row in common.get("calendar", [])
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        failed_report_ids = {
            str(item).strip()
            for item in (failed_report_employee_ids or set())
            if str(item).strip()
        }
        failed_comment_ids = {
            str(item).strip()
            for item in (failed_comment_superior_ids or set())
            if str(item).strip()
        }
        global_order = (
            global_order
            if global_order is not None
            else self._global_user_order(common)
        )
        assignments = (
            assignments
            if assignments is not None
            else self._resolved_comment_assignments(
                common, global_order=global_order
            )
        )
        scope = self.resolve_view_scope(
            common, employee_id, global_order=global_order, assignments=assignments
        )
        user_master = scope["user_master"]
        current_user = scope["current_user"]
        my_display = current_user.get("display_name") or employee_id
        can_input_own_report = (
            self._user_can_input_own_report(current_user)
            and employee_id not in failed_report_ids
        )
        is_temporary_user = scope["is_temporary_user"]
        assigned_subordinate_ids = scope["assigned_subordinate_ids"]
        viewable_members = [
            member
            for member in scope["viewable_members"]
            if str(member.get("employee_id", "")) not in failed_report_ids
        ]
        target_employee_ids = [
            str(member.get("employee_id", ""))
            for member in viewable_members
            if member.get("employee_id")
        ]
        missing_comment_summary = missing_comment_summary if missing_comment_summary is not None else self._build_missing_comment_summary(
            users_df,
            comments_df,
            common,
            employee_id,
            [
                target_id
                for target_id in assigned_subordinate_ids
                if target_id not in failed_report_ids
            ],
            failed_comment_superior_ids=failed_comment_ids,
        )
        rows, default_start, default_end = self._build_rows(
            users_df,
            comments_df,
            common,
            employee_id,
            assigned_subordinate_ids,
            target_employee_ids,
            start_date,
            end_date,
            missing_comment_summary,
            failed_comment_superior_ids=failed_comment_ids,
            return_frame=columnar_rows,
            global_order=global_order,
            target_commenters=assignments[1],
        )
        if failed_report_ids and len(rows):
            if columnar_rows:
                rows = rows.with_columns(
                    (pl.col("can_edit_report") & ~pl.col("employee_id").is_in(list(failed_report_ids))).alias("can_edit_report")
                )
            else:
                for row in rows:
                    if row["employee_id"] in failed_report_ids:
                        row["can_edit_report"] = False
        for member in viewable_members:
            member["pending_review_count"] = missing_comment_summary.get(
                "member_counts", {}
            ).get(member["employee_id"], 0)
        return {
            "employee_id": employee_id,
            "report_revision": (
                self.loaded_report_revisions.get(self._report_path_key(
                    safe_employee_csv_path(self._report_directory_for_employee(employee_id, common), employee_id)
                ), "missing") if report_revision is None else report_revision
            ),
            "display_name": my_display,
            "can_input_own_report": can_input_own_report,
            "is_superior": bool(assigned_subordinate_ids),
            "is_director": self._is_director(common, employee_id),
            "restrict_to_self": is_temporary_user,
            "current_team": self._team_path(
                common,
                str(
                    user_master.get(employee_id, {}).get("organization_id")
                ),
            ),
            "viewable_members": viewable_members,
            "rows": rows,
            "holiday_dates": sorted(day.isoformat() for day in holiday_dates),
            "missing_comment_summary": missing_comment_summary,
            "my_rank": global_order.index(employee_id) if employee_id in global_order else -1,
            "start_date": default_start.isoformat() if default_start else None,
            "end_date": default_end.isoformat() if default_end else None,
            "load_warning_count": load_warning_count,
        }

    def _build_viewable_members(
        self,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        assigned_subordinate_ids: set[str],
        *, global_order: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        current_user = users.get(employee_id, {})
        can_input_own_report = self._user_can_input_own_report(current_user)
        is_temporary = self._is_temporary_user(current_user)
        direct_organization_id = str(current_user.get("organization_id", "")).strip()
        same_organization_ids = {
            target_id
            for target_id, row in users.items()
            if row.get("affiliation_type") == "organization"
            and str(row.get("organization_id", "")).strip()
            == direct_organization_id
            and self._user_can_input_own_report(row)
        }
        if is_temporary:
            assigned_subordinate_ids = set()
            target_ids = {employee_id} if can_input_own_report else set()
            same_organization_ids = set()
        else:
            target_ids = {
                target_id
                for target_id in {*same_organization_ids, *assigned_subordinate_ids}
                if self._user_can_input_own_report(users.get(target_id, {}))
                and users.get(target_id, {}).get("affiliation_type") != "director"
            }
            if can_input_own_report:
                target_ids.add(employee_id)

        global_order = global_order if global_order is not None else self._global_user_order(common)
        # 編集カードと同じく、組織順を保って各所属内だけ逆順にする。
        # global_order自体は変更せず、コメント列の既存の優先順位を維持する。
        member_groups: dict[tuple[str, str], list[str]] = {}
        for target_id in global_order:
            user = users.get(target_id, {})
            group = (str(user.get("affiliation_type", "")), str(user.get("organization_id", "")))
            member_groups.setdefault(group, []).append(target_id)
        report_order = [
            target_id
            for group in member_groups.values()
            for target_id in reversed(group)
        ]
        order_index = {target_id: index for index, target_id in enumerate(report_order)}
        members: list[dict[str, Any]] = []
        team_paths = {}
        for target_id in sorted(
            target_ids, key=lambda item: (order_index.get(item, 999999), item)
        ):
            row = users.get(target_id, {})
            organization_id = str(row.get("organization_id", ""))
            relations: list[str] = []
            if target_id == employee_id:
                relations.append("self")
            if target_id in same_organization_ids:
                relations.append("same_organization")
            if target_id in assigned_subordinate_ids:
                relations.append("assigned_subordinate")
            if organization_id not in team_paths:
                team_paths[organization_id] = self._team_path(common, organization_id)
            path = team_paths[organization_id]
            relations.extend(
                f"organization:{item.get('team_id', '')}"
                for item in path
                if item.get("team_id")
            )
            members.append(
                {
                    "employee_id": target_id,
                    "display_name": str(row.get("display_name") or target_id),
                    "affiliation_type": str(row.get("affiliation_type", "")),
                    "organization_id": organization_id,
                    "team_path": path,
                    "relations": list(dict.fromkeys(relations)),
                    "can_view_report": True,
                    "can_comment": target_id in assigned_subordinate_ids,
                    "member_order": self._numeric_order(row.get("member_order")),
                }
            )
        return members

    @staticmethod
    def _team_path(
        common: dict[str, list[dict[str, Any]]], organization_id: str
    ) -> list[dict[str, str]]:
        if not organization_id:
            return []
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        path: list[dict[str, str]] = []
        team_id = organization_id
        visited: set[str] = set()
        while team_id and team_id not in visited:
            visited.add(team_id)
            row = teams.get(team_id)
            if row is None:
                break
            path.append(
                {
                    "team_id": team_id,
                    "team_name": str(row.get("team_name") or team_id),
                    "team_type": str(row.get("team_type", "")),
                }
            )
            team_id = str(row.get("parent_team_id", ""))
        path.reverse()
        return path

    def _previous_working_date(
        self,
        calendar_rows: list[dict[str, Any]],
        reference_date: date | None = None,
    ) -> date:
        holiday_dates = {
            calendar_date
            for row in calendar_rows
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        candidate = (reference_date or self.today_jst()) - timedelta(days=1)
        while candidate in holiday_dates:
            candidate -= timedelta(days=1)
        return candidate

    @classmethod
    def _working_date_offset(
        cls, reference_date: date, offset: int, holiday_dates: set[date]
    ) -> date:
        direction = -1 if offset < 0 else 1
        remaining = abs(offset)
        candidate = reference_date
        while remaining:
            candidate += timedelta(days=direction)
            if cls._is_workday(candidate, holiday_dates):
                remaining -= 1
        return candidate

    @staticmethod
    def _calendar_row_is_holiday(row: dict[str, Any]) -> bool:
        return bool(row.get("date"))


    @staticmethod
    def _numeric_order(value: Any) -> int:
        text = str(value or "").strip()
        return int(text) if text.isdigit() else 999999

    def _global_user_order(
        self, common: dict[str, list[dict[str, Any]]]
    ) -> list[str]:
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        departments = sorted(
            (
                row
                for row in teams.values()
                if str(row.get("team_type", "")) == "department"
            ),
            key=lambda row: (
                self._numeric_order(row.get("sort_order")),
                str(row.get("team_name", "")),
                str(row.get("team_id", "")),
            ),
        )

        def member_key(row: dict[str, Any]) -> tuple[int, str, str]:
            return (
                self._numeric_order(row.get("member_order")),
                str(row.get("display_name", "")),
                str(row.get("employee_id", "")),
            )

        ordered: list[str] = []
        covered_organizations: set[str] = set()
        for department in departments:
            department_id = str(department.get("team_id", ""))
            sections = sorted(
                (
                    row
                    for row in teams.values()
                    if str(row.get("team_type", "")) == "section"
                    and str(row.get("parent_team_id", "")) == department_id
                ),
                key=lambda row: (
                    self._numeric_order(row.get("sort_order")),
                    str(row.get("team_name", "")),
                    str(row.get("team_id", "")),
                ),
            )
            for section in sections:
                section_id = str(section.get("team_id", ""))
                covered_organizations.add(section_id)
                ordered.extend(
                    str(row.get("employee_id", ""))
                    for row in sorted(
                        (
                            user
                            for user in users.values()
                            if user.get("affiliation_type") == "organization"
                            and str(user.get("organization_id", "")) == section_id
                        ),
                        key=member_key,
                    )
                )
            covered_organizations.add(department_id)
            ordered.extend(
                str(row.get("employee_id", ""))
                for row in sorted(
                    (
                        user
                        for user in users.values()
                        if user.get("affiliation_type") == "organization"
                        and str(user.get("organization_id", "")) == department_id
                    ),
                    key=member_key,
                )
            )
        # Keep users with unresolved organization references in a stable order.
        ordered.extend(
            str(row.get("employee_id", ""))
            for row in sorted(
                (
                    user
                    for user in users.values()
                    if user.get("affiliation_type") == "organization"
                    and str(user.get("organization_id", ""))
                    not in covered_organizations
                ),
                key=member_key,
            )
        )
        ordered.extend(
            str(row.get("employee_id", ""))
            for row in sorted(
                (
                    user
                    for user in users.values()
                    if user.get("affiliation_type") == "director"
                ),
                key=member_key,
            )
        )
        return list(dict.fromkeys(employee_id for employee_id in ordered if employee_id))

    def _organization_member_ids(
        self,
        common: dict[str, list[dict[str, Any]]],
        organization_id: str,
    ) -> set[str]:
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        organization = teams.get(organization_id, {})
        organization_ids = {organization_id}
        if str(organization.get("team_type", "")) == "department":
            organization_ids.update(
                team_id
                for team_id, team in teams.items()
                if str(team.get("team_type", "")) == "section"
                and str(team.get("parent_team_id", "")) == organization_id
            )
        return {
            str(row.get("employee_id", ""))
            for row in common.get("user_master", [])
            if row.get("affiliation_type") == "organization"
            and str(row.get("organization_id", "")) in organization_ids
        }

    def _resolved_comment_assignments(
        self, common: dict[str, list[dict[str, Any]]],
        *, global_order: list[str] | None = None,
    ) -> tuple[dict[str, set[str]], dict[str, list[str]]]:
        users = {
            str(row.get("employee_id", "")): row
            for row in common.get("user_master", [])
            if row.get("employee_id")
        }
        teams = {
            str(row.get("team_id", "")): row
            for row in common.get("team_master", [])
            if row.get("team_id")
        }
        commenter_targets: dict[str, set[str]] = {}
        for assignment in common.get("comment_assignment", []):
            commenter_id = str(
                assignment.get("commenter_employee_id", "")
            ).strip()
            commenter = users.get(commenter_id)
            if (
                not commenter
                or self._is_temporary_user(commenter)
                or commenter.get("affiliation_type") == "unassigned"
            ):
                continue
            target_type = str(assignment.get("target_type", "none")).strip()
            organization_ids = [
                item.strip()
                for item in str(
                    assignment.get("target_organization_ids", "")
                ).split(";")
                if item.strip()
            ]
            employee_ids = [
                item.strip()
                for item in str(assignment.get("target_employee_ids", "")).split(";")
                if item.strip()
            ]
            target_ids: set[str] = set()
            if target_type == "organization" and len(organization_ids) == 1:
                target_ids = self._organization_member_ids(common, organization_ids[0])
            elif target_type == "departments" and commenter.get("affiliation_type") == "director":
                for organization_id in organization_ids:
                    if teams.get(organization_id, {}).get("team_type") == "department":
                        target_ids.update(
                            self._organization_member_ids(common, organization_id)
                        )
            elif target_type == "custom":
                target_ids.update(employee_ids)
                parent_id = commenter.get("organization_id", "")
                if teams.get(parent_id, {}).get("team_type") == "department":
                    for organization_id in organization_ids:
                        team = teams.get(organization_id, {})
                        if team.get("team_type") == "section" and team.get("parent_team_id") == parent_id:
                            target_ids.update(self._organization_member_ids(common, organization_id))
            target_ids = {
                target_id
                for target_id in target_ids
                if target_id != commenter_id
                and target_id in users
                and users[target_id].get("affiliation_type") != "director"
                and self._user_can_input_own_report(users[target_id])
            }
            commenter_targets[commenter_id] = target_ids

        global_order = self._commenter_order(common, global_order)
        order_index = {employee_id: index for index, employee_id in enumerate(global_order)}
        target_commenters: dict[str, list[str]] = {}
        for commenter_id, target_ids in commenter_targets.items():
            for target_id in target_ids:
                target_commenters.setdefault(target_id, []).append(commenter_id)
        for target_id, commenter_ids in target_commenters.items():
            target_commenters[target_id] = sorted(
                set(commenter_ids),
                key=lambda item: (order_index.get(item, 999999), item),
            )
        return commenter_targets, target_commenters

    def _is_director(
        self, common: dict[str, list[dict[str, Any]]], employee_id: str
    ) -> bool:
        return any(
            str(row.get("employee_id", "")) == employee_id
            and row.get("affiliation_type") == "director"
            for row in common.get("user_master", [])
        )

    @staticmethod
    def _is_workday(target_date: date, holiday_dates: set[date]) -> bool:
        return target_date.weekday() < 5 and target_date not in holiday_dates

    def _commenter_order(self, common, global_order=None):
        """コメント対象の種別を優先し、同区分では既存の組織・人員順を保つ。"""
        users = {row["employee_id"]: row for row in common.get("user_master", [])}
        teams = {row["team_id"]: row for row in common.get("team_master", [])}
        assignments = {row["commenter_employee_id"]: row for row in common.get("comment_assignment", [])}
        def category(employee_id):
            user = users.get(employee_id, {})
            if user.get("affiliation_type") == "director":
                return 5
            assignment = assignments.get(employee_id, {})
            custom = assignment.get("target_type") == "custom"
            organization = teams.get(user.get("organization_id"), {})
            if organization.get("team_type") == "section":
                if custom:
                    return 0
                target = teams.get(assignment.get("target_organization_ids"), {})
                return 2 if target.get("team_type") == "department" else 1
            target_id = assignment.get("target_organization_ids")
            return 4 if not custom and target_id == user.get("organization_id") else 3
        order = global_order if global_order is not None else self._global_user_order(common)
        return sorted(order, key=category)

    def _commenter_ids_for_targets(
        self,
        common: dict[str, list[dict[str, Any]]],
        target_employee_ids: list[str],
    ) -> list[str]:
        target_commenters = self._resolved_comment_assignments(common)[1]
        relevant = {
            commenter_id
            for target_id in target_employee_ids
            for commenter_id in target_commenters.get(target_id, [])
        }
        return [
            employee_id
            for employee_id in self._commenter_order(common)
            if employee_id in relevant
        ]

    @staticmethod
    def _user_can_input_own_report(row: dict[str, Any]) -> bool:
        return str(
            row.get(
                "can_input_own_report",
                USER_MASTER_DEFAULTS["can_input_own_report"],
            )
        ).strip() != "0"

    @staticmethod
    def _is_temporary_user(row: dict[str, Any]) -> bool:
        return str(row.get("employment_type", "")).strip() == "temporary"

    def _assigned_subordinate_ids(
        self, common: dict[str, list[dict[str, Any]]], employee_id: str
    ) -> set[str]:
        return set(
            self._resolved_comment_assignments(common)[0].get(employee_id, set())
        )

    def _build_missing_comment_summary(
        self,
        users_df: pl.DataFrame,
        comments_df: pl.DataFrame,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        target_employee_ids: list[str],
        *,
        failed_comment_superior_ids: set[str] | None = None,
    ) -> dict[str, Any]:
        today = self.today_jst()
        range_end = (
            today
            if self.settings.include_today_in_missing_comments
            else today - timedelta(days=1)
        )
        range_start = self._to_date(self.settings.missing_comment_start_date)
        if range_start is None:
            range_start = DEFAULT_MISSING_COMMENT_START_DATE
        range_start = max(range_start, today - timedelta(days=365))

        summary = {
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "dates": [],
            "member_counts": {},
        }
        if range_start > range_end or employee_id in (failed_comment_superior_ids or set()):
            return summary

        subordinate_ids = [
            target_id
            for target_id in dict.fromkeys(target_employee_ids)
            if target_id and target_id != employee_id
        ]
        if not subordinate_ids:
            return summary

        holiday_dates = {
            calendar_date
            for row in common["calendar"]
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        days = pl.DataFrame({"date": pl.date_range(range_start, range_end, eager=True)}).lazy().filter(
            ~pl.col("date").is_in(list(holiday_dates))
        ).with_columns(pl.col("date").dt.to_string("%Y-%m-%d"))
        candidates = pl.DataFrame({"employee_id": subordinate_ids}).lazy().join(
            days, how="cross"
        )
        if not self.settings.include_empty_report_days_in_missing_comments:
            report_days = users_df.lazy().cast(pl.String).filter(
                (pl.col("record_type") == "report")
                & pl.col("employee_id").is_in(subordinate_ids)
                & pl.col("date").is_between(
                    pl.lit(range_start.isoformat()), pl.lit(range_end.isoformat())
                )
                & (
                    (pl.col("business_name").fill_null("").str.strip_chars() != "")
                    | (pl.col("business_detail").fill_null("").str.strip_chars() != "")
                )
            ).select("employee_id", "date").unique()
            candidates = candidates.join(
                report_days, on=["employee_id", "date"], how="inner"
            )
        completed = comments_df.lazy().cast(pl.String).filter(
            (pl.col("superior_employee_id") == employee_id)
            & pl.col("date").is_between(pl.lit(range_start.isoformat()), pl.lit(range_end.isoformat()))
        ).unique(subset=["subordinate_employee_id", "date"], keep="last").filter(
            pl.col("comment").fill_null("").str.strip_chars() != ""
        ).select(pl.col("subordinate_employee_id").alias("employee_id"), "date")
        missing = candidates.join(
            completed, on=["employee_id", "date"], how="anti"
        ).collect()
        summary["dates"] = missing.get_column("date").unique().sort().to_list()
        counts = dict(missing.group_by("employee_id").len().iter_rows())
        summary["member_counts"] = {eid: counts.get(eid, 0) for eid in subordinate_ids}
        return summary

    @staticmethod
    def _row_has_report_data(row: dict[str, Any]) -> bool:
        return bool(
            str(row.get("business_name") or "").strip()
            or str(row.get("business_detail") or "").strip()
        )

    def save_updates(
        self,
        employee_id: str,
        user_updates: list[dict[str, Any]],
        comment_updates: list[dict[str, Any]],
        common: dict[str, list[dict[str, Any]]] | None = None,
        *,
        reply_updates: list[dict[str, Any]] | None = None,
        report_revision: str = "",
    ) -> dict[str, Any]:
        employee_id = validate_employee_id(employee_id)
        reply_updates = reply_updates or []
        self._authorize_updates(
            employee_id,
            user_updates,
            comment_updates,
            common=common,
            reply_updates=reply_updates,
        )
        update_targets = (
            ("user", user_updates, self._upsert_user_rows),
            ("comment", comment_updates, self._upsert_comment_rows),
        )
        result = {
            name: {"needed": bool(updates or (name == "user" and reply_updates)), "saved": False, "error": ""}
            for name, updates, _ in update_targets
        }
        for name, updates, writer in update_targets:
            if not result[name]["needed"]:
                continue
            try:
                if name == "user":
                    partition_path, partition_frame, revision, fingerprint = writer(
                        employee_id, updates, common=common,
                        reply_updates=reply_updates, expected_revision=report_revision,
                    )
                    result[name]["revision"] = revision
                    result[name]["_cache_fingerprint"] = fingerprint
                else:
                    partition_path, partition_frame = writer(employee_id, updates)
                result[name]["saved"] = True
                result[name]["_cache_path"] = str(partition_path)
                result[name]["_cache_frame"] = partition_frame
            except (ReportConflictError, ReportFormatError) as exc:
                result[name]["error"] = str(exc)
                result[name]["error_code"] = "report_conflict" if isinstance(exc, ReportConflictError) else "report_format"
            except CsvFileLockedError as exc:
                logger.exception("CSV is locked while saving %s updates", name)
                result[name]["error"] = str(exc)
                result[name]["error_code"] = "csv_locked"
            except CsvReadonlyError as exc:
                logger.exception(
                    "Failed to restore CSV read-only attribute after saving %s",
                    name,
                )
                result[name]["error"] = str(exc)
                result[name]["error_code"] = "csv_readonly"
            except Exception:
                logger.exception("Failed to save %s updates", name)
                result[name]["error"] = "保存先への書き込みに失敗しました。"

        return result

    def _authorize_updates(
        self,
        employee_id: str,
        user_updates: list[dict[str, Any]],
        comment_updates: list[dict[str, Any]],
        common: dict[str, list[dict[str, Any]]] | None = None,
        *,
        reply_updates: list[dict[str, Any]] | None = None,
    ) -> None:
        reply_updates = reply_updates or []
        if common is None and (user_updates or reply_updates or comment_updates):
            common = self.load_common()
        current_user = next(
            (
                row
                for row in (common or {}).get("user_master", [])
                if str(row.get("employee_id", "")) == employee_id
            ),
            {},
        )
        if (user_updates or reply_updates) and not self._user_can_input_own_report(
            current_user
        ):
            raise PermissionError("自分の日報入力が無効になっています。")

        if comment_updates:
            if self._is_temporary_user(current_user):
                raise PermissionError("派遣社員は他の利用者へのコメントを更新できません。")
            allowed_subordinates = self._assigned_subordinate_ids(common, employee_id)
            for update in comment_updates:
                subordinate_id = validate_employee_id(
                    update.get("subordinate_employee_id"), "コメント対象者ID"
                )
                if subordinate_id not in allowed_subordinates:
                    raise PermissionError("担当外の利用者へのコメント更新です。")

        # 返信の削除は本人に許可する。本文を保存する場合だけ現存するコメントを確認する。
        requested_replies = {
            (validate_employee_id(update.get("reply_to_employee_id"), "返信先の社員ID"),
             self._date_key(update.get("date")))
            for update in reply_updates if str(update.get("reply_text", "")).strip()
        }
        if requested_replies:
            # 表示キャッシュの古いコメントを根拠に許可せず、対象の上司CSVだけ再確認する。
            existing_comments = self.combine_comment_partitions([
                self.load_comment_partition(
                    safe_employee_csv_path(self.storage_dir("comments"), superior_id), {employee_id}
                ) for superior_id in sorted({sid for sid, _ in requested_replies})
            ])
            authorized_replies = {
                (superior_id, self._date_key(report_date))
                for superior_id, report_date in existing_comments.filter(
                    (pl.col("subordinate_employee_id") == employee_id)
                    & (pl.col("comment").fill_null("").str.strip_chars() != "")
                ).select("superior_employee_id", "date").iter_rows()
            }
            if not requested_replies.issubset(authorized_replies):
                raise PermissionError("存在しない上司コメントへの返信更新です。")

    def load_report_partition(
        self, path: Path, employee_id: str
    ) -> pl.DataFrame:
        key = self._report_path_key(path)
        try:
            # 置換直後の別ファイルのstatを古い読み取り結果に結び付けない。
            with path.open("rb") as stream:
                raw = stream.read()
                loaded = os.fstat(stream.fileno())
        except FileNotFoundError:
            self.loaded_report_revisions[key] = "missing"
            self.loaded_report_fingerprints.pop(key, None)
            return self._empty_df(USER_COLUMNS)
        try:
            frame = self._read_csv_bytes(raw)
            self._validate_report_frame(frame, employee_id)
        except Exception as exc:
            raise ReportFormatError(f"{path.name}: 日報CSVの形式が不正です。{exc}") from exc
        self.loaded_report_revisions[key] = hashlib.sha256(raw).hexdigest()
        self.loaded_report_fingerprints[key] = (loaded.st_size, loaded.st_mtime_ns)
        if self.defer_partition_normalization:
            return frame
        return self._dedupe_frame(frame, USER_COLUMNS, USER_KEYS)

    @staticmethod
    def _report_path_key(path: Path) -> str:
        """キャッシュと同じ基準で社員CSVのパスを識別する。"""
        return os.path.normcase(str(path.resolve(strict=False)))

    def _validate_report_frame(self, frame: pl.DataFrame, employee_id: str) -> None:
        """旧形式を補完せず、行の種別・列・参照先・一意性を検証する。"""
        if frame.columns != USER_COLUMNS:
            raise ReportFormatError("列は書式付き新形式のrecord_typeから始まる11列である必要があります。")
        if frame.is_empty():
            return
        if not set(frame["record_type"].to_list()) <= {"report", "reply"}:
            raise ReportFormatError("record_typeはreportまたはreplyが必要です。")
        if frame.filter(pl.col("employee_id") != employee_id).height:
            raise ReportFormatError("社員IDとファイル名が一致しません。")
        parsed_dates = pl.col("date").str.to_date("%Y-%m-%d", strict=False)
        if frame.filter(parsed_dates.is_null() | (parsed_dates.dt.to_string("%Y-%m-%d") != pl.col("date"))).height:
            raise ReportFormatError("日付はYYYY-MM-DD形式が必要です。")
        if frame.select(USER_KEYS).is_duplicated().any():
            raise ReportFormatError("同じ日報または同じ上司への返信が重複しています。")
        reports = frame.filter(pl.col("record_type") == "report")
        replies = frame.filter(pl.col("record_type") == "reply")
        if reports.filter((pl.col("reply_to_employee_id") != "") | (pl.col("reply_text") != "") | (pl.col("reply_rich_text") != "")).height:
            raise ReportFormatError("日報行の返信先と返信本文は空欄が必要です。")
        if replies.filter((pl.col("business_name") != "") | (pl.col("business_detail") != "") | (pl.col("business_name_rich_text") != "") | (pl.col("business_detail_rich_text") != "")
                          | (pl.col("reply_text").str.strip_chars() == "")).height:
            raise ReportFormatError("返信行は業務名・業務内容を空欄にし、返信本文を入力してください。")
        for target in replies["reply_to_employee_id"].unique():
            validate_employee_id(target, "返信先の社員ID")
        self._validate_rich_columns(reports, ("business_name", "business_detail"))
        self._validate_rich_columns(replies, ("reply_text",))

    @staticmethod
    def _validate_rich_columns(frame: pl.DataFrame, fields: tuple[str, ...]) -> None:
        for row in frame.select([column for field in fields for column in (field, RICH_FIELDS[field])]).iter_rows(named=True):
            for field in fields:
                try:
                    _, plain = serialize_rich_text(row[RICH_FIELDS[field]])
                except ValueError as exc:
                    raise ReportFormatError(f"{field}: {exc}") from exc
                if plain != row[field]:
                    raise ReportFormatError(f"{field}の文章と書式データが一致しません。")

    def load_comment_partition(
        self, path: Path, allowed_employee_ids: set[str] | None
    ) -> pl.DataFrame:
        if not path.exists():
            return self._empty_df(COMMENT_COLUMNS)
        frame = self._read_csv_frame(path)
        if frame.columns != COMMENT_COLUMNS:
            raise ReportFormatError("上司コメントCSVは書式列を含む6列が必要です。")
        self._validate_rich_columns(frame, ("comment",))
        if allowed_employee_ids is not None:
            frame = frame.filter(pl.col("subordinate_employee_id").is_in(list(allowed_employee_ids)))
        if self.defer_partition_normalization:
            return frame
        return self._dedupe_frame(
            frame,
            COMMENT_COLUMNS,
            ["superior_employee_id", "subordinate_employee_id", "date"],
        )

    def combine_report_partitions(
        self, partitions: list[pl.DataFrame]
    ) -> pl.DataFrame:
        return self._dedupe_normalized_frame(
            pl.concat(partitions) if partitions else self._empty_df(USER_COLUMNS),
            USER_KEYS
        )

    def normalize_partitions(
        self, partitions: dict[str, pl.DataFrame], columns: list[str], keys: list[str]
    ) -> dict[str, pl.DataFrame]:
        """Batch small CSV normalization while retaining per-file boundaries."""
        nonempty = [frame.with_columns(pl.lit(path).alias("_partition"))
                    for path, frame in partitions.items() if not frame.is_empty()]
        if not nonempty:
            return partitions
        normalized = self._dedupe_frame(
            pl.concat(nonempty), [*columns, "_partition"], [*keys, "_partition"]
        )
        grouped = normalized.partition_by("_partition", as_dict=True, include_key=False)
        return {path: grouped.get((path,), self._empty_df(columns)) for path in partitions}

    def combine_comment_partitions(
        self, partitions: list[pl.DataFrame]
    ) -> pl.DataFrame:
        return self._dedupe_normalized_frame(
            pl.concat(partitions) if partitions else self._empty_df(COMMENT_COLUMNS),
            ["superior_employee_id", "subordinate_employee_id", "date"],
        )

    def load_calendar_master(self) -> list[dict[str, Any]]:
        return self._load_calendar(self.storage_dir("common"))

    def _load_all_user_rows(
        self,
        allowed_employee_ids: list[str],
        common: dict[str, list[dict[str, Any]]] | None = None,
    ) -> pl.DataFrame:
        partitions: list[pl.DataFrame] = []
        common = common or self.load_common()
        user_master = {
            str(row.get("employee_id", "")).strip(): row
            for row in common.get("user_master", [])
        }
        files: list[tuple[str, Path]] = []
        for employee_id in dict.fromkeys(allowed_employee_ids):
            if not employee_id:
                continue
            user = user_master.get(str(employee_id), {})
            employment_type = str(user.get("employment_type", "regular")).strip()
            kind = (
                "temporary_reports"
                if employment_type == "temporary"
                else "regular_reports"
            )
            directory = self.storage_dir(kind)
            # Do not auto-create report folders.  A missing folder is a failed
            # target and is handled by the cache/API as a partial load.
            if not directory.exists():
                self._record_load_warning(
                    directory,
                    FileNotFoundError(f"{kind} directory is missing"),
                )
                continue
            if not directory.is_dir():
                self._record_load_warning(
                    directory,
                    NotADirectoryError(f"{kind} path is not a directory"),
                )
                continue
            if not os.access(directory, os.R_OK):
                self._record_load_warning(
                    directory,
                    PermissionError(f"{kind} directory is not readable"),
                )
                continue
            try:
                file = safe_employee_csv_path(directory, str(employee_id))
            except ValueError as exc:
                self._record_load_warning(Path(directory) / str(employee_id), exc)
                continue
            files.append((str(employee_id), file))
        for employee_id, file in files:
            if not file.exists():
                continue
            try:
                partitions.append(self.load_report_partition(file, employee_id))
            except Exception as exc:
                self._record_load_warning(file, exc)

        return self.combine_report_partitions(partitions)

    def _load_all_comment_rows(
        self, allowed_employee_ids: list[str] | None = None
    ) -> pl.DataFrame:
        partitions: list[pl.DataFrame] = []
        comments_dir = self.storage_dir("comments")
        if not comments_dir.exists():
            self._record_load_warning(
                comments_dir,
                FileNotFoundError("comments directory is missing"),
            )
            files: list[Path] = []
        elif not comments_dir.is_dir():
            self._record_load_warning(
                comments_dir,
                NotADirectoryError("comments path is not a directory"),
            )
            files = []
        elif not os.access(comments_dir, os.R_OK):
            self._record_load_warning(
                comments_dir,
                PermissionError("comments directory is not readable"),
            )
            files = []
        else:
            files = list(comments_dir.glob("*.csv"))
        allowed_ids = set(allowed_employee_ids or [])
        for file in files:
            try:
                partitions.append(self.load_comment_partition(file, allowed_ids if allowed_employee_ids is not None else None))
            except Exception as exc:
                self._record_load_warning(file, exc)

        return self.combine_comment_partitions(partitions)

    def _build_rows(
        self,
        users_df: pl.DataFrame,
        comments_df: pl.DataFrame,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        assigned_subordinate_ids: set[str],
        target_employee_ids: list[str],
        start_date: str | None = None,
        end_date: str | None = None,
        missing_comment_summary: dict[str, Any] | None = None,
        *,
        failed_comment_superior_ids: set[str] | None = None,
        return_frame: bool = False,
        global_order: list[str] | None = None,
        target_commenters: dict[str, list[str]] | None = None,
    ) -> tuple[list[dict[str, Any]] | pl.DataFrame, date | None, date | None]:
        failed_comment_ids = {
            str(item).strip()
            for item in (failed_comment_superior_ids or set())
            if str(item).strip()
        }
        user_master = {row.get("employee_id", ""): row for row in common["user_master"]}
        holiday_dates = {
            str(row.get("date", ""))
            for row in common["calendar"]
            if self._calendar_row_is_holiday(row) and row.get("date")
        }
        global_order = global_order if global_order is not None else self._global_user_order(common)
        if target_commenters is None:
            target_commenters = self._resolved_comment_assignments(common, global_order=global_order)[1]
        relevant = {sid for eid in target_employee_ids for sid in target_commenters.get(eid, [])}
        superior_ids = [sid for sid in self._commenter_order(common, global_order) if sid in relevant]

        today = self.today_jst()
        holiday_date_values = {
            calendar_date
            for row in common.get("calendar", [])
            if self._calendar_row_is_holiday(row)
            and (calendar_date := self._to_date(row.get("date"))) is not None
        }
        default_start = self._to_date(start_date)
        default_end = self._to_date(end_date)
        if not default_start:
            default_start = self._working_date_offset(
                today,
                self.settings.default_start_offset_days,
                holiday_date_values,
            )
        if not default_end:
            default_end = self._working_date_offset(
                today,
                self.settings.default_end_offset_days,
                holiday_date_values,
            )
        if default_start > default_end:
            default_start, default_end = default_end, default_start

        date_filter = pl.col("date").is_between(pl.lit(default_start.isoformat()), pl.lit(default_end.isoformat()))
        visible_source = users_df.lazy().cast(pl.String).filter(date_filter).collect()
        original_targets = list(dict.fromkeys(eid for eid in target_employee_ids if eid))
        # Retain last-known rows on a failed refresh, but do not synthesize
        # editable blanks for those unavailable employees.
        target_ids = list(dict.fromkeys([*original_targets, *visible_source.get_column("employee_id").to_list()]))
        if not target_ids:
            return (pl.DataFrame() if return_frame else []), default_start, default_end
        # Small role/calendar metadata is computed once, independently of report rows.
        members = pl.DataFrame({
            "employee_id": target_ids,
            "display_name": [user_master.get(eid, {}).get("display_name") or eid for eid in target_ids],
            "_member_order": list(range(len(target_ids))),
            "can_edit_report": [eid == employee_id and self._user_can_input_own_report(user_master.get(eid, {})) for eid in target_ids],
            "can_edit_my_comment": [eid in assigned_subordinate_ids for eid in target_ids],
        })
        dates = pl.date_range(default_start, default_end, eager=True)
        calendar = pl.DataFrame({"_day": dates}).lazy().with_columns(
            pl.col("_day").dt.to_string("%Y-%m-%d").alias("date"),
            pl.col("_day").is_in(list(holiday_date_values)).alias("is_holiday"),
            (pl.col("_day") == today).alias("is_today"),
        )
        reports = visible_source.lazy().filter(pl.col("record_type") == "report")
        replies = visible_source.lazy().filter(pl.col("record_type") == "reply").select(
            "employee_id", "date", pl.col("reply_to_employee_id").alias("superior_employee_id"), "reply_text", "reply_rich_text"
        )
        comments = comments_df.lazy().cast(pl.String).filter(date_filter & pl.col("subordinate_employee_id").is_in(target_ids))
        my_comments = comments.filter(pl.col("superior_employee_id") == employee_id).select(
            pl.col("subordinate_employee_id").alias("employee_id"), "date",
            pl.col("comment").alias("_my_comment"),
        )
        rows = members.lazy().join(calendar, how="cross").join(
            reports.select("employee_id", "date", "business_name", "business_detail", "business_name_rich_text", "business_detail_rich_text"),
            on=["employee_id", "date"], how="left",
        ).join(visible_source.lazy().select("employee_id", "date").unique().with_columns(pl.lit(True).alias("_present")),
               on=["employee_id", "date"], how="left"
        ).filter(pl.col("employee_id").is_in(original_targets) | pl.col("_present").fill_null(False)).join(my_comments, on=["employee_id", "date"], how="left").with_columns(
            pl.col("business_name", "business_detail").fill_null(""),
            pl.col("business_name_rich_text", "business_detail_rich_text").fill_null(EMPTY_RICH_TEXT),
            (pl.lit("") if employee_id in failed_comment_ids else pl.col("_my_comment").fill_null("")).alias("_my_comment"),
        )
        needs_review = (
            pl.col("can_edit_my_comment")
            & (pl.col("_day") <= today)
            & (pl.col("_my_comment").str.strip_chars() == "")
            & (~pl.col("is_holiday"))
            & pl.lit(employee_id not in failed_comment_ids)
            & ((pl.col("_day") < today) | pl.lit(self.settings.include_today_in_missing_comments))
        )
        rows = rows.with_columns(needs_review.alias("needs_review"), pl.lit("").alias("holiday_description")).collect()
        comment_columns = ["superior_employee_id", "superior_name", "superior_affiliation_type", "comment", "comment_rich_text", "reply_text", "reply_rich_text", "editable",
                           "applies", "available", "load_failed", "rank"]
        if superior_ids:
            superiors = pl.DataFrame({
                "superior_employee_id": superior_ids,
                "superior_name": [user_master.get(eid, {}).get("display_name") or eid for eid in superior_ids],
                "superior_affiliation_type": [user_master.get(eid, {}).get("affiliation_type", "") for eid in superior_ids],
                "rank": list(range(len(superior_ids))),
                "load_failed": [eid in failed_comment_ids for eid in superior_ids],
            })
            assignments = pl.DataFrame(
                [(eid, sid, True) for eid in target_ids for sid in target_commenters.get(eid, [])],
                schema={"employee_id": pl.String, "superior_employee_id": pl.String, "applies": pl.Boolean}, orient="row",
            )
            cell_keys = ["employee_id", "date", "superior_employee_id"]
            cells = rows.lazy().select("employee_id", "date", "can_edit_my_comment").join(
                superiors.lazy(), how="cross"
            ).join(assignments.lazy(), on=["employee_id", "superior_employee_id"], how="left").join(
                comments.select(pl.col("subordinate_employee_id").alias("employee_id"), "date", "superior_employee_id", "comment", "comment_rich_text"),
                on=cell_keys, how="left",
            ).join(replies, on=cell_keys, how="left").with_columns(
                pl.col("applies").fill_null(False),
                (~pl.col("load_failed")).alias("available"),
            ).with_columns(
                pl.when(pl.col("applies") & pl.col("available")).then(pl.col("comment").fill_null("")).otherwise(pl.lit("")).alias("comment"),
                pl.when(pl.col("applies") & pl.col("available")).then(pl.col("reply_text").fill_null("")).otherwise(pl.lit("")).alias("reply_text"),
                pl.when(pl.col("applies") & pl.col("available")).then(pl.col("comment_rich_text").fill_null(EMPTY_RICH_TEXT)).otherwise(pl.lit(EMPTY_RICH_TEXT)).alias("comment_rich_text"),
                pl.when(pl.col("applies") & pl.col("available")).then(pl.col("reply_rich_text").fill_null(EMPTY_RICH_TEXT)).otherwise(pl.lit(EMPTY_RICH_TEXT)).alias("reply_rich_text"),
                (pl.col("applies") & pl.col("available") & pl.col("can_edit_my_comment")
                 & (pl.col("superior_employee_id") == employee_id)).alias("editable"),
            ).group_by("employee_id", "date").agg(pl.struct(comment_columns).sort_by("rank").alias("comments"))
            rows = rows.lazy().join(cells, on=["employee_id", "date"], how="left").collect()
        output_columns = ["employee_id", "display_name", "date", "business_name", "business_detail", "business_name_rich_text", "business_detail_rich_text", "is_holiday",
                          "holiday_description", "is_today", "can_edit_report", "can_edit_my_comment", "needs_review"]
        if superior_ids:
            output_columns.append("comments")
        result = rows.sort("_member_order", "date").select(output_columns)
        if not superior_ids:
            result = result.with_columns(pl.lit([]).alias("comments"))
        return (result if return_frame else result.to_dicts()), default_start, default_end

    def _report_directory_for_employee(
        self,
        employee_id: str,
        common: dict[str, list[dict[str, Any]]] | None = None,
    ) -> Path:
        common = common or self.load_common()
        user = next(
            (
                row
                for row in common.get("user_master", [])
                if str(row.get("employee_id", "")).strip() == employee_id
            ),
            {},
        )
        kind = (
            "temporary_reports"
            if self._is_temporary_user(user)
            else "regular_reports"
        )
        return self.storage_dir(kind)

    def _upsert_user_rows(
        self,
        employee_id: str,
        updates: list[dict[str, Any]],
        *,
        common: dict[str, list[dict[str, Any]]] | None = None,
        reply_updates: list[dict[str, Any]] | None = None,
        expected_revision: str = "",
    ) -> tuple[Path, pl.DataFrame, str, tuple[int, int]]:
        """本人の日報と返信を、社員CSVの共有ロック内でまとめて保存する。"""
        user_path = safe_employee_csv_path(
            self._report_directory_for_employee(employee_id, common), employee_id
        )
        if not user_path.parent.is_dir():
            raise FileNotFoundError(f"日報フォルダが見つかりません: {user_path.parent}")
        with self._csv_save_lock(user_path.with_suffix(".lock"), "別の端末が日報を保存中です。少し待って再度保存してください。"):
            existing = self.load_report_partition(user_path, employee_id)
            if not expected_revision or expected_revision != self.loaded_report_revisions[self._report_path_key(user_path)]:
                raise ReportConflictError("日報が別の場所で更新されています。編集中の内容を控え、最新データを取得して確認してください。")
            frame = self._merge_report_updates(existing, employee_id, updates, reply_updates or [])
            self._validate_report_frame(frame, employee_id)
            revision = self._write_csv_atomically(frame, user_path, "reports")
            self.loaded_report_revisions[self._report_path_key(user_path)] = revision
            saved = user_path.stat()
            return user_path, frame, revision, (saved.st_size, saved.st_mtime_ns)

    def _merge_report_updates(
        self, existing: pl.DataFrame, employee_id: str,
        updates: list[dict[str, Any]], reply_updates: list[dict[str, Any]],
    ) -> pl.DataFrame:
        """日報・返信を別々のキーで更新し、空の返信は対象行だけ削除する。"""
        update_dates = [self._date_key(update.get("date")) for update in updates]
        rows_by_date = {
            row["date"]: row
            for row in existing.filter((pl.col("record_type") == "report") & pl.col("date").is_in(update_dates)).to_dicts()
        }
        now = self.now_jst().isoformat()
        for update in updates:
            report_date = self._to_date(update.get("date"))
            if report_date is None:
                raise ValueError("日報の日付が不正です。")
            date_text = report_date.isoformat()
            row = rows_by_date.get(
                date_text,
                {
                    "record_type": "report",
                    "employee_id": employee_id,
                    "date": date_text,
                    "business_name": "",
                    "business_name_rich_text": EMPTY_RICH_TEXT,
                    "business_detail": "",
                    "business_detail_rich_text": EMPTY_RICH_TEXT,
                    "reply_to_employee_id": "",
                    "reply_text": "",
                    "reply_rich_text": "",
                    "updated_at": now,
                },
            )
            row["employee_id"] = employee_id
            row["date"] = date_text
            if "business_name" in update:
                row["business_name"] = str(update.get("business_name", ""))
                row["business_name_rich_text"] = update["business_name_rich_text"]
            if "business_detail" in update:
                row["business_detail"] = str(update.get("business_detail", ""))
                row["business_detail_rich_text"] = update["business_detail_rich_text"]

            row["updated_at"] = now
            rows_by_date[date_text] = row

        changes = list(rows_by_date.values())
        deleted = []
        for update in reply_updates:
            day = self._date_key(update.get("date"))
            if not day:
                raise ValueError("返信対象の日付が不正です。")
            target = validate_employee_id(update.get("reply_to_employee_id"), "返信先の社員ID")
            message = str(update.get("reply_text", ""))
            row = dict.fromkeys(USER_COLUMNS, "")
            row.update(record_type="reply", employee_id=employee_id, date=day,
                       reply_to_employee_id=target, reply_text=message, reply_rich_text=update["reply_rich_text"], updated_at=now)
            if message.strip():
                changes.append(row)
            else:
                deleted.append({key: row[key] for key in USER_KEYS})
        if deleted:
            existing = existing.join(pl.DataFrame(deleted), on=USER_KEYS, how="anti", maintain_order="left")
        frame = pl.DataFrame(changes, schema=USER_COLUMNS, orient="row") if changes else self._empty_df(USER_COLUMNS)
        return self._merge_partition_updates(existing, frame, USER_KEYS)

    def _upsert_comment_rows(
        self, employee_id: str, updates: list[dict[str, Any]]
    ) -> tuple[Path, pl.DataFrame]:
        comments_dir = self.storage_dir("comments")
        if not comments_dir.is_dir():
            raise FileNotFoundError(f"上司コメントフォルダが見つかりません: {comments_dir}")
        comment_path = safe_employee_csv_path(comments_dir, employee_id)
        keys = ["superior_employee_id", "subordinate_employee_id", "date"]
        if comment_path.exists():
            existing = self._read_csv_frame(comment_path)
            if existing.columns != COMMENT_COLUMNS:
                raise ReportFormatError("上司コメントCSVは書式列を含む6列が必要です。")
            self._validate_rich_columns(existing, ("comment",))
            existing = self._dedupe_frame(existing, COMMENT_COLUMNS, keys)
        else:
            existing = self._empty_df(COMMENT_COLUMNS)
        rows_by_key = {}
        now = self.now_jst().isoformat()
        for update in updates:
            subordinate_id = str(update.get("subordinate_employee_id", "")).strip()
            report_date = self._to_date(update.get("date"))
            if not subordinate_id or report_date is None:
                raise ValueError("コメントの対象者または日付が不正です。")
            key = (employee_id, subordinate_id, report_date.isoformat())
            rows_by_key[key] = {
                "superior_employee_id": employee_id,
                "subordinate_employee_id": subordinate_id,
                "date": report_date.isoformat(),
                "comment": str(update.get("comment", "")),
                "comment_rich_text": update["comment_rich_text"],
                "updated_at": now,
            }
        changes = pl.DataFrame(list(rows_by_key.values()), schema=COMMENT_COLUMNS, orient="row")
        df = self._merge_partition_updates(existing, changes, keys)
        self._write_csv_atomically(df, comment_path, "comments")
        return comment_path, df

    @staticmethod
    def _merge_partition_updates(
        existing: pl.DataFrame, changes: pl.DataFrame, keys: list[str]
    ) -> pl.DataFrame:
        """変更行だけを置換し、既存キーの順序と未変更列を保持する。"""
        if changes.is_empty():
            return existing
        return existing.join(
            changes, on=keys, how="full", coalesce=True,
            suffix="_new", maintain_order="left_right",
        ).select([
            pl.col(column) if column in keys else
            pl.coalesce(pl.col(f"{column}_new"), pl.col(column)).alias(column)
            for column in existing.columns
        ])

    def _write_csv_atomically(
        self, df: pl.DataFrame, target_path: Path, backup_group: str
    ) -> str:
        """Write a CSV completely, then replace the destination in one operation."""
        return self._write_csv_frames_atomically([(df, target_path)], backup_group)[target_path]

    @staticmethod
    def _set_csv_readonly(path: Path, readonly: bool) -> None:
        """Toggle the Windows read-only attribute using the portable mode API."""
        mode = path.stat().st_mode
        write_bits = stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH
        if readonly:
            os.chmod(path, mode & ~write_bits)
        else:
            os.chmod(path, mode | stat.S_IWUSR)

    @staticmethod
    def _classify_csv_write_error(
        exc: Exception, target_path: Path, operation: str
    ) -> Exception:
        """Turn sharing violations into the explicit CSV-lock error.

        ACL denials remain ordinary PermissionError instances.  On Windows a
        sharing violation is reported as WinError 32/33; an unclassified
        PermissionError must not be presented as an Excel/file-lock error.
        """
        winerror = getattr(exc, "winerror", None)
        if isinstance(exc, PermissionError) and winerror in {32, 33}:
            return CsvFileLockedError(
                "CSVが使用中です。Excelなどで開いている場合は閉じてから、もう一度保存してください。"
            )
        return exc

    def _write_csv_frames_atomically(
        self,
        frames: list[tuple[pl.DataFrame, Path]],
        backup_group: str,
    ) -> dict[Path, str]:
        revisions: dict[Path, str] = {}
        staged: dict[Path, Path | None] = {}
        originals: dict[Path, Path | None] = {}
        replaced: list[Path] = []
        target_paths = list(dict.fromkeys(target_path for _, target_path in frames))
        write_error: Exception | None = None
        readonly_error: Exception | None = None
        try:
            for df, target_path in frames:
                # Fixed storage subfolders are deployment-managed.  Never
                # create them implicitly during a save.
                if not target_path.parent.is_dir():
                    raise FileNotFoundError(
                        f"CSV保存先フォルダが見つかりません: {target_path.parent}"
                    )
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    prefix=f".{target_path.stem}.",
                    suffix=".tmp",
                    dir=target_path.parent,
                    delete=False,
                ) as temporary:
                    staged[target_path] = Path(temporary.name)
                    # 同じバイト列を保存と版の計算に使い、ハッシュ用の再読み込みをしない。
                    payload = df.write_csv(include_bom=True).encode("utf-8")
                    temporary.write(payload)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                    revisions[target_path] = hashlib.sha256(payload).hexdigest()
                stage_path = staged[target_path]
                if stage_path is None:
                    raise RuntimeError("一時CSVを作成できませんでした。")

            for _, target_path in frames:
                originals[target_path] = None
                if target_path.exists():
                    try:
                        self._set_csv_readonly(target_path, False)
                    except Exception as exc:
                        raise self._classify_csv_write_error(
                            exc, target_path, "unlock"
                        ) from exc
                    with tempfile.NamedTemporaryFile(
                        mode="wb",
                        prefix=f".{target_path.stem}.",
                        suffix=".rollback",
                        dir=target_path.parent,
                        delete=False,
                    ) as original:
                        originals[target_path] = Path(original.name)
                    original_path = originals[target_path]
                    if original_path is not None:
                        shutil.copy2(target_path, original_path)
                    self._backup_csv(target_path, backup_group)

            for _, target_path in frames:
                stage_path = staged[target_path]
                if stage_path is None:
                    raise RuntimeError("保存対象の一時CSVがありません。")
                try:
                    os.replace(stage_path, target_path)
                except Exception as exc:
                    raise self._classify_csv_write_error(
                        exc, target_path, "replace"
                    ) from exc
                staged[target_path] = None
                replaced.append(target_path)
        except Exception as exc:
            write_error = exc
            for target_path in reversed(replaced):
                original_path = originals.get(target_path)
                try:
                    if original_path is None:
                        target_path.unlink(missing_ok=True)
                    else:
                        os.replace(original_path, target_path)
                        originals[target_path] = None
                except Exception:
                    logger.critical(
                        "Failed to roll back a CSV transaction: %s",
                        target_path,
                        exc_info=True,
                    )
            raise
        finally:
            # Read-only is a safety net, not an ACL.  Apply it after both a
            # successful replacement and a rollback, and never hide the
            # original write/lock failure.
            for target_path in target_paths:
                try:
                    if target_path.is_file():
                        self._set_csv_readonly(target_path, True)
                except Exception as exc:
                    logger.error(
                        "Failed to restore CSV read-only attribute: %s",
                        target_path,
                        exc_info=True,
                    )
                    if write_error is None and readonly_error is None:
                        readonly_error = exc
            for path in (*staged.values(), *originals.values()):
                if path is not None:
                    try:
                        path.unlink(missing_ok=True)
                    except Exception:
                        logger.warning(
                            "Failed to remove CSV transaction temporary file: %s",
                            path,
                            exc_info=True,
                        )
            if write_error is None and readonly_error is not None:
                raise CsvReadonlyError(
                    "CSVを読み取り専用に設定できませんでした。"
                ) from readonly_error
        return revisions

    def _backup_csv(self, target_path: Path, backup_group: str) -> None:
        backup_dir = self.base_dir / "cache" / "csv_backups" / backup_group
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = self.now_jst().strftime("%Y%m%d_%H%M%S_%f")
        backup_path = backup_dir / f"{target_path.stem}_{timestamp}.csv"
        shutil.copy2(target_path, backup_path)
        self._prune_backups(backup_dir, target_path.stem)

    def _prune_backups(self, backup_dir: Path, target_stem: str) -> None:
        backups = sorted(
            backup_dir.glob(f"{target_stem}_*.csv"),
            key=lambda path: path.name,
            reverse=True,
        )
        for stale_backup in backups[max(0, self.backup_limit) :]:
            try:
                stale_backup.unlink()
            except OSError:
                # バックアップ整理の失敗で、本体CSVの保存成功を失敗扱いにしない。
                continue

    def _read_csv_or_empty(self, path: Path, columns: list[str]) -> pl.DataFrame:
        if not path.exists():
            return self._empty_df(columns)
        return self._ensure_columns(self._read_csv_frame(path), columns)

    def _empty_df(self, columns: list[str]) -> pl.DataFrame:
        return pl.DataFrame(schema={column: pl.String for column in columns})

    def _ensure_columns(self, df: pl.DataFrame, columns: list[str]) -> pl.DataFrame:
        if df.columns == columns:
            return df
        for column in columns:
            if column not in df.columns:
                df = df.with_columns(
                    pl.lit("").alias(column)
                )
        return df.select(columns)

    def _dedupe_frame(
        self, frame: pl.DataFrame, columns: list[str], keys: list[str]
    ) -> pl.DataFrame:
        """Normalize CSV columns without materializing Python rows.

        Preserve wall-clock timestamps and last-input-row tie breaking used by
        the CSV writer. Strings at this boundary keep the on-disk/save contract;
        query dates are converted to Date inside the columnar query.
        """
        if frame.is_empty():
            return self._empty_df(columns)
        frame = self._ensure_columns(frame, columns)
        timestamp = pl.col("updated_at").cast(pl.String).str.replace(r"(?:Z|[+-]\d{2}:?\d{2})$", "")
        parsed = pl.coalesce(
            timestamp.str.to_datetime("%Y-%m-%dT%H:%M:%S%.f", strict=False),
            timestamp.str.to_datetime("%Y-%m-%d %H:%M:%S%.f", strict=False),
            timestamp.str.to_datetime("%Y-%m-%d", strict=False),
        )
        normalized = (
            frame.lazy().with_columns(
                pl.col("date").cast(pl.String).str.slice(0, 10)
                .str.to_date("%Y-%m-%d", strict=False).dt.to_string("%Y-%m-%d").fill_null(""),
                parsed.alias("_updated"),
            ).with_columns(
                pl.when(pl.col("_updated").dt.microsecond() == 0)
                .then(pl.col("_updated").dt.to_string("%Y-%m-%dT%H:%M:%S"))
                .otherwise(pl.col("_updated").dt.to_string("%Y-%m-%dT%H:%M:%S%.6f"))
                .alias("updated_at"),
            ).select(columns).collect()
        )
        # Preserve datetime.fromisoformat's legacy acceptance of uncommon ISO
        # forms. Only distinct nonstandard values enter Python, never CSV rows.
        if normalized.get_column("updated_at").null_count():
            values = frame.filter(normalized.get_column("updated_at").is_null()).get_column("updated_at").unique()
            fallback = self.now_jst()
            replacements = {value: (self._to_datetime(value) or fallback).isoformat() for value in values}
            repaired = frame.get_column("updated_at").replace_strict(replacements, default=None)
            normalized = normalized.with_columns(pl.col("updated_at").fill_null(repaired))
        invalid_dates = normalized.get_column("date") == ""
        if invalid_dates.any():
            values = frame.filter(invalid_dates).get_column("date").unique()
            replacements = {value: self._date_key(value) for value in values}
            repaired = frame.get_column("date").replace_strict(replacements, default=None)
            normalized = normalized.with_columns(
                pl.when(pl.col("date") == "").then(repaired).otherwise(pl.col("date")).alias("date")
            )
        return self._dedupe_normalized_frame(normalized, keys)

    @staticmethod
    def _dedupe_normalized_frame(frame: pl.DataFrame, keys: list[str]) -> pl.DataFrame:
        # Most CSVs already have unique keys; avoid sorts/window work for them.
        if frame.is_empty() or not frame.select(keys).is_duplicated().any():
            return frame
        return (
            frame.lazy().with_row_index("_input_order")
            .with_columns(pl.col("_input_order").min().over(keys).alias("_key_order"))
            .sort(["updated_at", "_input_order"])
            .unique(subset=keys, keep="last")
            .sort("_key_order").select(frame.columns).collect()
        )

    def _to_date(self, value: Any) -> date | None:
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        if isinstance(value, datetime):
            return value.date()
        if value is None or value == "":
            return None
        try:
            return datetime.fromisoformat(str(value)[:10]).date()
        except Exception:
            return None

    def _to_datetime(self, value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value.replace(tzinfo=None)
        if isinstance(value, date):
            return datetime.combine(value, datetime.min.time())
        if value is None or value == "":
            return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(
                tzinfo=None
            )
        except Exception:
            return None

    def _date_key(self, value: Any) -> str:
        d = self._to_date(value)
        return d.isoformat() if d else ""


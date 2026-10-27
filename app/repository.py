from __future__ import annotations

import hashlib
import json
from app import conversations as conversation
from contextlib import contextmanager
from dataclasses import dataclass
import logging
import os
import shutil
import stat
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.sqlite_table import Table, concat, read_csv, quote
from app.rich_text import RICH_FIELDS, EMPTY_RICH_TEXT, serialize as serialize_rich_text

from app.calendar_policy import DEFAULT_MISSING_COMMENT_START_DATE
from app.config import AppSettings, validate_storage_directories
from app.config import StorageConfigError
from app.security import (
    COMMON_MASTER_COLUMNS,
    USER_MASTER_DEFAULTS,
    RequestValidationError,
    safe_employee_csv_path,
    validate_employee_id,
)


logger = logging.getLogger(__name__)

JST = ZoneInfo("Asia/Tokyo")

USER_COLUMNS = conversation.USER_COLUMNS
USER_KEYS = conversation.USER_KEYS
COMMENT_COLUMNS = conversation.COMMENT_COLUMNS
COMMENT_KEYS = conversation.COMMENT_KEYS
CSV_ENCODINGS = ("utf8", "cp932")
DEFAULT_BACKUP_LIMIT = 20
ORGANIZATION_MASTERS = ("user_master", "team_master", "comment_assignment")
ADMINISTRATION_COLUMNS = ["record_type", *dict.fromkeys(
    column for master in ORGANIZATION_MASTERS for column in COMMON_MASTER_COLUMNS[master]
)]


class CommonMasterConflictError(RuntimeError):
    """The common CSV changed after it was loaded in the admin screen."""


class AdministrationAccessDeniedError(PermissionError):
    """The current management data does not grant administrator access."""


class ReportConflictError(RuntimeError):
    """読み込み後に社員CSVが変更されたため、上書きを拒否した。"""


class ReportFormatError(ValueError):
    """日報CSVが現在の行形式に一致しない。"""


class CsvFileLockedError(PermissionError):
    """A target CSV could not be replaced because another process owns it."""


class CsvReadonlyError(OSError):
    """The final read-only protection flag could not be applied."""


@dataclass(frozen=True)
class VerifiedPartition:
    """保存検証で読んだ内容と、その同じファイルハンドルから取得した更新情報。"""

    path: Path
    kind: str
    employee_id: str
    frame: Table
    fingerprint: tuple[int, int] | None
    revision: str = ""


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
        self.loaded_comment_fingerprints: dict[str, tuple[int, int]] = {}

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
        common = self.load_organization_masters()
        common["calendar"] = self._load_calendar(self.storage_dir("common"))
        return common

    def load_common_masters(self) -> dict[str, list[dict[str, Any]]]:
        return self.load_common()

    def load_organization_masters(self) -> dict[str, list[dict[str, Any]]]:
        """Read organization data without accessing the holiday calendar."""
        common_dir = self.storage_dir("common")
        users, teams, assignments, schema_mode = self._load_organization_masters(
            common_dir
        )
        return {
            "user_master": users,
            "team_master": teams,
            "comment_assignment": assignments,
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
                if not set(source.column_values("record_type")) <= set(ORGANIZATION_MASTERS):
                    raise ValueError("管理CSVに不正なデータ種別があります。")
                revision = hashlib.sha256(raw).hexdigest()
                self.loaded_common_revisions.update(dict.fromkeys(ORGANIZATION_MASTERS, revision))
                frames = {
                    master: source.where("record_type = ?", (master,)).select(
                        list(COMMON_MASTER_COLUMNS[master])
                    ) for master in ORGANIZATION_MASTERS
                }
                return (self._normalize_user_rows(frames["user_master"]),
                        frames["team_master"].to_dicts(),
                        frames["comment_assignment"].to_dicts(), "new")
            except Exception as exc:
                self._record_load_warning(unified, exc)
                return [], [], [], "new"
        frames: dict[str, Table] = {}
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


    def _normalize_user_rows(self, source: Table) -> list[dict[str, Any]]:
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
        self.loaded_common_revisions["calendar"] = ""
        if not path.exists():
            self.loaded_common_revisions["calendar"] = "missing"
            self._record_load_warning(path, FileNotFoundError("ファイルがありません"))
            return []
        try:
            raw = path.read_bytes()
            source = self._read_csv_bytes(raw)
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
        self.loaded_common_revisions["calendar"] = hashlib.sha256(raw).hexdigest()
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
        return {master: self.loaded_common_revisions.get(master, "")
                for master in COMMON_MASTER_COLUMNS}

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
            Table(normalized, columns=columns)
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
        return self._write_csv_atomically(df, target_path, "common")

    def save_user_administration(
        self,
        users: list[dict[str, str]],
        expected_revisions: dict[str, str],
        *,
        actor_employee_id: str | None = None,
    ) -> dict[str, str]:
        with self._administration_lock():
            return self._save_administration_locked(
                None, users, None, expected_revisions,
                actor_employee_id=actor_employee_id,
            )

    def save_administration(
        self,
        teams: list[dict[str, str]],
        users: list[dict[str, str]],
        comment_assignments: list[dict[str, str]],
        expected_revisions: dict[str, str],
        *,
        actor_employee_id: str | None = None,
    ) -> dict[str, str]:
        with self._administration_lock():
            return self._save_administration_locked(
                teams, users, comment_assignments, expected_revisions,
                actor_employee_id=actor_employee_id,
            )

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
        teams: list[dict[str, str]] | None,
        users: list[dict[str, str]],
        assignments: list[dict[str, str]] | None,
        expected_revisions: dict[str, str],
        *,
        actor_employee_id: str | None = None,
    ) -> dict[str, str]:
        """ロック中に版を検証し、関連する管理データを一度の置換で保存する。"""
        from app.security import validate_administration_save_request
        # 権限・本人削除・競合の確認は、ロック取得後に読んだ同じ内容で行う。
        # 組織情報の保存にはカレンダーを使用しない。
        warning_count = len(self.load_warnings)
        current_users, current_teams, current_assignments, _ = self._load_organization_masters(
            self.storage_dir("common")
        )
        if len(self.load_warnings) != warning_count:
            raise ValueError("管理データを正常に読み込めないため保存できません。")
        if actor_employee_id is not None:
            actor_id = str(actor_employee_id).strip()
            actor = next((row for row in current_users
                          if str(row.get("employee_id", "")).strip() == actor_id), {})
            if not actor_id or not (
                str(actor.get("employment_type", "")).strip() == "regular"
                and str(actor.get("is_admin", "")).strip() == "1"
            ):
                raise AdministrationAccessDeniedError("管理者権限がありません。")
            if not any(str(row.get("employee_id", "")).strip() == actor_id for row in users):
                raise RequestValidationError("ログイン中の管理者は削除できません。")
        current = self.loaded_common_revisions
        for master in ORGANIZATION_MASTERS:
            if not expected_revisions.get(master) or expected_revisions[master] != current[master]:
                raise CommonMasterConflictError("管理が別の場所で更新されています。再読み込みしてください。")
        if teams is None:
            teams = current_teams
        if assignments is None:
            assignments = current_assignments
        teams, users, assignments, _ = validate_administration_save_request({
            "teams": teams, "users": users, "comment_assignments": assignments,
            "revisions": {master: expected_revisions[master] for master in ORGANIZATION_MASTERS},
        })
        rows = []
        for master, values in zip(ORGANIZATION_MASTERS, (users, teams, assignments)):
            for row in self._common_master_frame(master, values).to_dicts():
                rows.append({column: master if column == "record_type" else row.get(column, "")
                             for column in ADMINISTRATION_COLUMNS})
        frame = Table(rows, columns=ADMINISTRATION_COLUMNS) if rows else self._empty_df(ADMINISTRATION_COLUMNS)
        target = self.storage_dir("common") / "administration.csv"
        revision = self._write_csv_atomically(frame, target, "common")
        return dict.fromkeys(ORGANIZATION_MASTERS, revision)

    def _common_master_frame(
        self, master: str, rows: list[dict[str, str]]
    ) -> Table:
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
            Table(normalized, columns=columns)
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

    def _read_csv_frame(self, path: Path) -> Table:
        return self._read_csv_bytes(path.read_bytes())

    def _read_csv_bytes(self, raw: bytes) -> Table:
        """同一の読み取り結果からCSVと競合確認用ハッシュを生成する。"""
        errors: list[str] = []
        for encoding in CSV_ENCODINGS:
            try:
                return read_csv(raw, encoding)
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
        users_df: Table,
        comments_df: Table,
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
                rows = rows.with_column("can_edit_report",
                    "can_edit_report AND employee_id NOT IN (SELECT value FROM json_each(?))",
                    (json.dumps(list(failed_report_ids)),))
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
        users_df: Table,
        comments_df: Table,
        common: dict[str, list[dict[str, Any]]],
        employee_id: str,
        target_employee_ids: list[str],
        *,
        failed_comment_superior_ids: set[str] | None = None,
    ) -> dict[str, Any]:
        users_df = conversation.project_users(users_df)
        comments_df = conversation.project_comments(comments_df)
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
        days = Table([{"date": (range_start + timedelta(days=n)).isoformat(),
                       "is_holiday": range_start + timedelta(days=n) in holiday_dates}
                      for n in range((range_end - range_start).days + 1)], ["date", "is_holiday"])
        members = Table([{"employee_id": eid} for eid in subordinate_ids], ["employee_id"])
        users_df.index("employee_id", "date")
        comments_df.index("subordinate_employee_id", "date", "superior_employee_id")
        missing = Table.query(f"""
            WITH completed AS (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY subordinate_employee_id, date ORDER BY rowid DESC) AS rank
                FROM {comments_df.sql_name} WHERE superior_employee_id = ? AND date BETWEEN ? AND ?
            )
            SELECT m.employee_id, d.date FROM {members.sql_name} m CROSS JOIN {days.sql_name} d
            WHERE (NOT d.is_holiday OR EXISTS (
                SELECT 1 FROM {users_df.sql_name} r
                WHERE r.employee_id = m.employee_id AND r.date = d.date AND r.record_type = 'report'
                  AND (strip_text(r.business_name) != '' OR strip_text(r.business_detail) != '')))
              AND (? OR EXISTS (
                SELECT 1 FROM {users_df.sql_name} r
                WHERE r.employee_id = m.employee_id AND r.date = d.date AND r.record_type = 'report'
                  AND (strip_text(r.business_name) != '' OR strip_text(r.business_detail) != '')))
              AND NOT EXISTS (SELECT 1 FROM completed c
                  WHERE c.subordinate_employee_id = m.employee_id AND c.date = d.date
                    AND c.rank = 1 AND strip_text(c.comment) != '')
            ORDER BY m.rowid, d.date
        """, (employee_id, range_start.isoformat(), range_end.isoformat(),
                self.settings.include_empty_report_days_in_missing_comments))
        summary["dates"] = Table.query(f'SELECT DISTINCT date FROM {missing.sql_name} ORDER BY date').column_values("date")
        counts = dict(Table.query(f'SELECT employee_id, COUNT(*) AS count FROM {missing.sql_name} GROUP BY employee_id').iter_rows())
        summary["member_counts"] = {eid: counts.get(eid, 0) for eid in subordinate_ids}
        return summary

    @staticmethod
    def _row_has_report_data(row: dict[str, Any]) -> bool:
        return bool(
            str(row.get("business_name") or "").strip()
            or str(row.get("business_detail") or "").strip()
        )

    def save_updates(self, employee_id, user_updates, comment_updates, common=None, *, reply_updates=None, report_revision="", conversation_updates=None):
        common = common or self.load_common()
        if comment_updates or reply_updates:
            raise ValueError("旧コメント・返信APIは使用できません。")
        self._authorize_updates(employee_id, user_updates, [], common=common)
        operations = conversation.validate_operations(conversation_updates or [])
        user = next(row for row in common['user_master'] if row['employee_id']==employee_id)
        assigned = self._assigned_subordinate_ids(common, employee_id)
        targets = self._resolved_comment_assignments(common)[1]
        grouped = {'user': [], 'comment': []}
        for op in operations:
            sub, sup = op['subordinate_employee_id'], op['superior_employee_id']
            if sub == sup or sup not in targets.get(sub, []):
                raise PermissionError('現在のコメント担当の会話だけ更新できます。')
            if employee_id == sub and self._user_can_input_own_report(user):
                side = 'user'
            elif employee_id == sup and sub in assigned and not self._is_temporary_user(user):
                side = 'comment'
            else:
                raise PermissionError('この会話を更新する権限がありません。')
            grouped[side].append(op)
        result = {}
        for side in ('user','comment'):
            reports = user_updates if side=='user' else []
            status = result[side] = {'needed':bool(reports or grouped[side]), 'saved':False, 'error':''}
            if not status['needed']: continue
            try:
                path, output, revision, fingerprint, peers = conversation.save_partition(
                    self, employee_id, side, reports, grouped[side], common, report_revision)
                status.update(saved=True, revision=revision, _cache_path=str(path), _cache_frame=output, _cache_fingerprint=fingerprint, _cache_peers=peers)
            except CsvFileLockedError as exc:
                status.update(error=str(exc),error_code='csv_locked')
            except CsvReadonlyError as exc:
                status.update(error=str(exc),error_code='csv_readonly')
            except ReportConflictError as exc:
                status.update(error=str(exc),error_code='report_conflict')
            except (ValueError, ReportFormatError) as exc:
                status.update(error=str(exc),error_code='report_format')
            except Exception:
                logger.exception('Failed to save %s conversation partition',side)
                status['error']='保存先への書き込みに失敗しました。'
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
                for superior_id, report_date in existing_comments.where(
                    "subordinate_employee_id = ? AND strip_text(comment) != ''", (employee_id,)
                ).select("superior_employee_id", "date").iter_rows()
            }
            if not requested_replies.issubset(authorized_replies):
                raise PermissionError("存在しない上司コメントへの返信更新です。")

    def load_report_partition(
        self, path: Path, employee_id: str
    ) -> Table:
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
        return frame

    @staticmethod
    def _report_path_key(path: Path) -> str:
        """キャッシュと同じ基準で社員CSVのパスを識別する。"""
        return os.path.normcase(str(path.resolve(strict=False)))

    def _validate_report_frame(self, frame, employee_id):
        try:
            conversation.validate_frame(frame, employee_id, 'user')
        except ValueError as exc:
            raise ReportFormatError(str(exc)) from exc

    @staticmethod
    def _validate_rich_columns(frame: Table, fields: tuple[str, ...]) -> None:
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
    ) -> Table:
        key = self._report_path_key(path)
        try:
            with path.open("rb") as stream:
                raw = stream.read()
                loaded = os.fstat(stream.fileno())
        except FileNotFoundError:
            self.loaded_comment_fingerprints.pop(key, None)
            return self._empty_df(COMMENT_COLUMNS)
        frame = self._read_csv_bytes(raw)
        try:
            conversation.validate_frame(frame, path.stem, 'comment')
        except ValueError as exc:
            raise ReportFormatError(str(exc)) from exc
        self.loaded_comment_fingerprints[key] = (loaded.st_size, loaded.st_mtime_ns)
        if allowed_employee_ids is not None:
            frame = frame.where_in("subordinate_employee_id", allowed_employee_ids)
        if self.defer_partition_normalization:
            return frame
        return frame

    def load_verified_peer_partition(
        self, path: Path, employee_id: str, kind: str
    ) -> VerifiedPartition:
        key = self._report_path_key(path)
        if kind == "comment":
            frame = self.load_comment_partition(path, None)
            return VerifiedPartition(path, kind, employee_id, frame,
                                     self.loaded_comment_fingerprints.get(key))
        if kind == "report":
            frame = self.load_report_partition(path, employee_id)
            return VerifiedPartition(path, kind, employee_id, frame,
                                     self.loaded_report_fingerprints.get(key),
                                     self.loaded_report_revisions[key])
        raise ValueError("保存検証のファイル種別が不正です。")

    def combine_report_partitions(
        self, partitions: list[Table]
    ) -> Table:
        return self._dedupe_normalized_frame(
            concat(partitions) if partitions else self._empty_df(USER_COLUMNS),
            USER_KEYS
        )

    def normalize_partitions(
        self, partitions: dict[str, Table], columns: list[str], keys: list[str]
    ) -> dict[str, Table]:
        """Validated conversation CSVs already contain canonical strings and unique keys."""
        if columns in (USER_COLUMNS, COMMENT_COLUMNS):
            return partitions
        return {path: self._dedupe_frame(frame, columns, keys) for path, frame in partitions.items()}

    def combine_comment_partitions(
        self, partitions: list[Table]
    ) -> Table:
        return self._dedupe_normalized_frame(
            concat(partitions) if partitions else self._empty_df(COMMENT_COLUMNS),
            COMMENT_KEYS,
        )

    def load_calendar_master(self) -> list[dict[str, Any]]:
        return self._load_calendar(self.storage_dir("common"))

    def _build_rows(
        self,
        users_df: Table,
        comments_df: Table,
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
    ) -> tuple[list[dict[str, Any]] | Table, date | None, date | None]:
        conversations = conversation.conversation_index(users_df, comments_df)
        users_df = conversation.project_users(users_df)
        comments_df = conversation.project_comments(comments_df)
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

        visible_source = users_df.where("date BETWEEN ? AND ?", (default_start.isoformat(), default_end.isoformat()))
        original_targets = list(dict.fromkeys(eid for eid in target_employee_ids if eid))
        # Failed partitions retain old rows but must not synthesize editable blanks.
        target_ids = list(dict.fromkeys([*original_targets, *visible_source.column_values("employee_id")]))
        if not target_ids:
            return (Table() if return_frame else []), default_start, default_end
        members = Table([{
            "employee_id": eid,
            "display_name": user_master.get(eid, {}).get("display_name") or eid,
            "member_order": rank,
            "original_target": eid in original_targets,
            "can_edit_report": eid == employee_id and self._user_can_input_own_report(user_master.get(eid, {})),
            "can_edit_my_comment": eid in assigned_subordinate_ids,
        } for rank, eid in enumerate(target_ids)])
        calendar = Table([{
            "date": (default_start + timedelta(days=n)).isoformat(),
            "is_holiday": default_start + timedelta(days=n) in holiday_date_values,
            "is_today": default_start + timedelta(days=n) == today,
        } for n in range((default_end - default_start).days + 1)])
        visible_source.index("employee_id", "date", "record_type")
        comments_df.index("subordinate_employee_id", "date", "superior_employee_id")
        bool_columns = ("is_holiday", "is_today", "can_edit_report", "can_edit_my_comment", "needs_review")
        rows = Table.query(f"""
            SELECT m.employee_id, m.display_name, d.date,
                COALESCE(r.business_name, '') AS business_name,
                COALESCE(r.business_detail, '') AS business_detail,
                COALESCE(r.business_name_rich_text, :empty) AS business_name_rich_text,
                COALESCE(r.business_detail_rich_text, :empty) AS business_detail_rich_text,
                d.is_holiday, '' AS holiday_description, d.is_today,
                m.can_edit_report, m.can_edit_my_comment,
                (m.can_edit_my_comment AND d.date <= :today
                    AND strip_text(c.comment) = '' AND :comment_available
                    AND (NOT d.is_holiday OR strip_text(r.business_name) != '' OR strip_text(r.business_detail) != '')
                    AND (d.date < :today OR :include_today)) AS needs_review
            FROM {members.sql_name} m CROSS JOIN {calendar.sql_name} d
            LEFT JOIN {visible_source.sql_name} r
                ON r.employee_id = m.employee_id AND r.date = d.date AND r.record_type = 'report'
            LEFT JOIN {comments_df.sql_name} c
                ON c.subordinate_employee_id = m.employee_id AND c.date = d.date AND c.superior_employee_id = :viewer
            WHERE m.original_target OR EXISTS (
                SELECT 1 FROM {visible_source.sql_name} p WHERE p.employee_id = m.employee_id AND p.date = d.date)
            ORDER BY m.member_order, d.date
        """, {"empty": EMPTY_RICH_TEXT, "today": today.isoformat(), "viewer": employee_id,
                "comment_available": employee_id not in failed_comment_ids,
                "include_today": self.settings.include_today_in_missing_comments}, bool_columns=bool_columns)
        cells_by_key = {}
        if superior_ids:
            superiors = Table([{
                "superior_employee_id": sid,
                "superior_name": user_master.get(sid, {}).get("display_name") or sid,
                "superior_affiliation_type": user_master.get(sid, {}).get("affiliation_type", ""),
                "rank": rank, "load_failed": sid in failed_comment_ids,
            } for rank, sid in enumerate(superior_ids)])
            assignments = Table([{"employee_id": eid, "superior_employee_id": sid}
                for eid in target_ids for sid in target_commenters.get(eid, [])],
                ["employee_id", "superior_employee_id"])
            assignments.index("employee_id", "superior_employee_id")
            cells = Table.query(f"""
                SELECT r.employee_id, r.date, s.superior_employee_id, s.superior_name,
                    s.superior_affiliation_type,
                    CASE WHEN a.employee_id IS NOT NULL AND NOT s.load_failed THEN COALESCE(c.comment, '') ELSE '' END AS comment,
                    CASE WHEN a.employee_id IS NOT NULL AND NOT s.load_failed THEN COALESCE(c.comment_rich_text, :empty) ELSE :empty END AS comment_rich_text,
                    CASE WHEN a.employee_id IS NOT NULL AND NOT s.load_failed THEN COALESCE(p.reply_text, '') ELSE '' END AS reply_text,
                    CASE WHEN a.employee_id IS NOT NULL AND NOT s.load_failed THEN COALESCE(p.reply_rich_text, :empty) ELSE :empty END AS reply_rich_text,
                    (a.employee_id IS NOT NULL AND NOT s.load_failed AND r.can_edit_my_comment AND s.superior_employee_id = :viewer) AS editable,
                    (a.employee_id IS NOT NULL) AS applies, NOT s.load_failed AS available, s.load_failed, s.rank
                FROM {rows.sql_name} r CROSS JOIN {superiors.sql_name} s
                LEFT JOIN {assignments.sql_name} a ON a.employee_id = r.employee_id AND a.superior_employee_id = s.superior_employee_id
                LEFT JOIN {comments_df.sql_name} c ON c.subordinate_employee_id = r.employee_id AND c.date = r.date AND c.superior_employee_id = s.superior_employee_id
                LEFT JOIN {visible_source.sql_name} p ON p.employee_id = r.employee_id AND p.date = r.date
                    AND p.reply_to_employee_id = s.superior_employee_id AND p.record_type = 'reply'
                ORDER BY r.rowid, s.rank
            """, {"empty": EMPTY_RICH_TEXT, "viewer": employee_id},
                bool_columns=("editable", "applies", "available", "load_failed"))
            for cell in cells.iter_rows(named=True):
                key = (cell.pop("employee_id"), cell.pop("date"))
                cells_by_key.setdefault(key, []).append(cell)
        # Nested UI payloads stay Python objects at the API boundary.
        result_rows = rows.to_dicts()
        for row in result_rows:
            row["comments"] = cells_by_key.get((row["employee_id"], row["date"]), [])
            row["conversation_data"] = json.dumps({cell["superior_employee_id"]: conversations.get(
                (row["employee_id"], row["date"], cell["superior_employee_id"]), [])
                for cell in row["comments"] if cell["applies"] and cell["available"]}, ensure_ascii=False)
        result = Table(result_rows, [*rows.columns, "comments", "conversation_data"]) if return_frame else result_rows
        return result, default_start, default_end

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

    @staticmethod
    def _merge_partition_updates(
        existing: Table, changes: Table, keys: list[str]
    ) -> Table:
        """変更行だけを置換し、既存キーの順序と未変更列を保持する。"""
        if changes.is_empty():
            return existing
        condition = " AND ".join(f'e.{quote(k)} IS c.{quote(k)}' for k in keys)
        selections = ', '.join(f'e.{quote(c)}' if c in keys else
                               f'COALESCE(c.{quote(c)}, e.{quote(c)}) AS {quote(c)}' for c in existing.columns)
        new_columns = ', '.join(f'c.{quote(c)}' for c in existing.columns)
        return Table.query(f"""SELECT {', '.join(map(quote, existing.columns))} FROM (
            SELECT {selections}, 0 AS _part, e.rowid AS _input
            FROM {existing.sql_name} e LEFT JOIN {changes.sql_name} c ON {condition}
            UNION ALL
            SELECT {new_columns}, 1 AS _part, c.rowid AS _input
            FROM {changes.sql_name} c WHERE NOT EXISTS (SELECT 1 FROM {existing.sql_name} e WHERE {condition})
        ) ORDER BY _part, _input""")

    def _write_csv_atomically(
        self, df: Table, target_path: Path, backup_group: str
    ) -> str:
        """Back up the old CSV locally and replace it with a complete staged file."""
        stage_path: Path | None = None
        write_error: Exception | None = None
        readonly_error: Exception | None = None
        try:
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
                stage_path = Path(temporary.name)
                # 保存するバイト列から版を計算し、保存後の再読込を避ける。
                payload = df.write_csv(include_bom=True).encode("utf-8")
                temporary.write(payload)
                temporary.flush()
                os.fsync(temporary.fileno())
                revision = hashlib.sha256(payload).hexdigest()

            if target_path.exists():
                try:
                    self._set_csv_readonly(target_path, False)
                except Exception as exc:
                    raise self._classify_csv_write_error(exc, target_path, "unlock") from exc
                # 保存前の内容はローカルだけに残す。共有先に.rollbackは作らない。
                self._backup_csv(target_path, backup_group)
            try:
                os.replace(stage_path, target_path)
            except Exception as exc:
                raise self._classify_csv_write_error(exc, target_path, "replace") from exc
            stage_path = None
        except Exception as exc:
            write_error = exc
            raise
        finally:
            try:
                if target_path.is_file():
                    self._set_csv_readonly(target_path, True)
            except Exception as exc:
                logger.error(
                    "Failed to restore CSV read-only attribute: %s",
                    target_path, exc_info=True,
                )
                if write_error is None:
                    readonly_error = exc
            if stage_path is not None:
                try:
                    stage_path.unlink(missing_ok=True)
                except Exception:
                    logger.warning("Failed to remove temporary CSV: %s", stage_path, exc_info=True)
            if readonly_error is not None:
                raise CsvReadonlyError("CSVを読み取り専用に設定できませんでした。") from readonly_error
        return revision

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

    def _read_csv_or_empty(self, path: Path, columns: list[str]) -> Table:
        if not path.exists():
            return self._empty_df(columns)
        return self._ensure_columns(self._read_csv_frame(path), columns)

    def _empty_df(self, columns: list[str]) -> Table:
        return Table(columns=columns)

    def _ensure_columns(self, df: Table, columns: list[str]) -> Table:
        return df if df.columns == columns else df.ensure_columns(columns)

    def _dedupe_frame(self, frame: Table, columns: list[str], keys: list[str]) -> Table:
        """従来の日付補正を行い、SQLで最新行と同時刻の後勝ちを選ぶ。"""
        fallback = self.now_jst()
        rows = self._ensure_columns(frame, columns).to_dicts()
        for row in rows:
            row["date"] = self._date_key(row["date"])
            row["updated_at"] = (self._to_datetime(row["updated_at"]) or fallback).isoformat()
        return self._dedupe_normalized_frame(Table(rows, columns), keys)

    @staticmethod
    def _dedupe_normalized_frame(frame: Table, keys: list[str]) -> Table:
        return frame.deduplicate(keys)

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


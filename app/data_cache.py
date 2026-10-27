from __future__ import annotations

import logging
import os
import stat
from copy import deepcopy
from collections import OrderedDict
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from threading import RLock
from time import perf_counter
from typing import Any

from app.sqlite_table import Table

from app.config import AppSettings
from app.repository import DailyReportRepository, VerifiedPartition, USER_COLUMNS, USER_KEYS, COMMENT_COLUMNS, COMMENT_KEYS
from app.security import safe_employee_csv_path


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FileFingerprint:
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class CacheSnapshot:
    settings_paths: tuple[str, ...]
    employee_id: str
    common: dict[str, list[dict[str, Any]]]
    common_revisions: dict[str, str]
    report_partitions: dict[str, Table]
    report_revisions: dict[str, str]
    comment_partitions: dict[str, Table]
    file_manifest: dict[str, FileFingerprint]
    target_employee_ids: tuple[str, ...]
    generation: int
    built_at: datetime
    warnings: tuple[dict[str, str], ...]
    report_load_failures: tuple[dict[str, str], ...] = ()
    comment_load_failures: tuple[dict[str, str], ...] = ()


@dataclass(frozen=True)
class RefreshResult:
    changed: int = 0
    added: int = 0
    deleted: int = 0
    failed: int = 0

    @property
    def applied(self) -> int:
        return self.changed + self.added + self.deleted

    def to_dict(self) -> dict[str, int]:
        return {
            "changed": self.changed,
            "added": self.added,
            "deleted": self.deleted,
            "failed": self.failed,
        }


@dataclass(frozen=True)
class CacheAccess:
    snapshot: CacheSnapshot
    status: str
    refresh_result: RefreshResult = RefreshResult()


class DailyReportDataCache:
    """In-process, permission-scoped cache for daily-report CSV data."""

    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir
        self._lock = RLock()
        self._snapshot: CacheSnapshot | None = None
        self._generation = 0
        self._invalid_paths: set[str] = set()
        self._combined: tuple[int, Table, Table] | None = None
        self._review_summary: tuple[tuple[Any, ...], dict[str, Any]] | None = None
        self._views: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        self._startup_common = None
        self._management_reload_pending = False

    def read_startup_common(self, settings: AppSettings, employee_id: str):
        """初期画面のマスターを、変更検知付きで初回日報読み込みへ引き継ぐ。"""
        with self._lock:
            repository = DailyReportRepository(settings, self._base_dir)
            repository.validate_paths()
            paths = self._common_paths(settings)
            before = self._common_fingerprints(paths)
            common = repository.load_common()
            after = self._common_fingerprints(paths)
            if before == after and not repository.load_warnings:
                self._startup_common = (self._settings_paths(settings), employee_id, after, common, dict(repository.loaded_common_revisions))
            else:
                self._startup_common = None
            return common

    @property
    def is_loaded(self) -> bool:
        with self._lock:
            return self._snapshot is not None

    def invalidate_all(self, reason: str) -> None:
        with self._lock:
            if self._snapshot is not None:
                logger.info(
                    "daily-report cache invalidated generation=%s reason=%s",
                    self._snapshot.generation,
                    reason,
                )
            self._snapshot = None
            self._combined = None
            self._review_summary = None
            self._views.clear()
            self._invalid_paths.clear()

    def defer_management_reload(self, revisions: dict[str, str] | None = None) -> None:
        """Record management changes without touching report/comment files."""
        with self._lock:
            if revisions is None or (
                self._snapshot is not None
                and dict(self._snapshot.common_revisions) != revisions
            ):
                self._management_reload_pending = True

    def invalidate_partition(self, path: Path | str, reason: str) -> None:
        key = self._path_key(path)
        with self._lock:
            self._invalid_paths.add(key)
            if self._snapshot is not None:
                manifest = dict(self._snapshot.file_manifest)
                manifest.pop(key, None)
                self._snapshot = self._replace_snapshot(
                    self._snapshot,
                    file_manifest=manifest,
                    warnings=self._merge_warning(
                        self._snapshot.warnings,
                        key,
                        f"キャッシュ同期失敗: {reason}",
                    ),
                )

    def ensure_loaded(
        self, settings: AppSettings, employee_id: str
    ) -> CacheAccess:
        with self._lock:
            expected_paths = self._settings_paths(settings)
            snapshot = self._snapshot
            if (
                snapshot is None
                or snapshot.settings_paths != expected_paths
                or snapshot.employee_id != employee_id
            ):
                previous = snapshot
                if previous is not None:
                    reason = (
                        "settings paths changed"
                        if previous.settings_paths != expected_paths
                        else "employee scope changed"
                    )
                    logger.info(
                        "daily-report cache fallback_rebuild_reason=%s generation=%s",
                        reason,
                        previous.generation,
                    )
                try:
                    built = self._build_snapshot(settings, employee_id)
                except Exception:
                    if previous is not None and previous.settings_paths != expected_paths:
                        self._snapshot = None
                        self._invalid_paths.clear()
                    raise
                self._snapshot = built
                self._invalid_paths.clear()
                return CacheAccess(
                    built,
                    "built" if previous is None else "rebuilt",
                )

            if self._invalid_paths:
                return self._refresh_changed_locked(settings, employee_id)
            return CacheAccess(snapshot, "hit")

    def refresh_changed(
        self, settings: AppSettings, employee_id: str
    ) -> CacheAccess:
        with self._lock:
            if self._snapshot is None:
                built = self._build_snapshot(settings, employee_id)
                self._snapshot = built
                self._invalid_paths.clear()
                return CacheAccess(built, "built")
            if (
                self._snapshot.settings_paths != self._settings_paths(settings)
                or self._snapshot.employee_id != employee_id
            ):
                reason = (
                    "settings paths changed"
                    if self._snapshot.settings_paths != self._settings_paths(settings)
                    else "employee scope changed"
                )
                logger.info(
                    "daily-report cache fallback_rebuild_reason=%s generation=%s",
                    reason,
                    self._snapshot.generation,
                )
                try:
                    built = self._build_snapshot(settings, employee_id)
                except Exception:
                    self._snapshot = None
                    self._invalid_paths.clear()
                    raise
                self._snapshot = built
                self._invalid_paths.clear()
                return CacheAccess(built, "rebuilt")
            return self._refresh_changed_locked(settings, employee_id)

    def load_view_data(
        self,
        settings: AppSettings,
        employee_id: str,
        start_date: str | None = None,
        end_date: str | None = None,
        period_preset: str | None = None,
        force_refresh: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any], CacheSnapshot]:
        operation_started = perf_counter()
        with self._lock:
            if self._management_reload_pending:
                self.invalidate_all("management changed; rebuild on report entry")
                self._startup_common = None
                access = self.ensure_loaded(settings, employee_id)
                # Keep the request pending after a partial read, so retry is possible.
                if not access.snapshot.warnings:
                    self._management_reload_pending = False
            else:
                access = (
                    self.refresh_changed(settings, employee_id)
                    if force_refresh
                    else self.ensure_loaded(settings, employee_id)
                )
        snapshot = access.snapshot
        repository = DailyReportRepository(settings, self._base_dir)
        view_started = perf_counter()
        users_df, comments_df = self._combined_frames(snapshot, repository)
        view_key = (snapshot.generation, repository.today_jst(), start_date, end_date,
                    period_preset, settings.default_start_offset_days, settings.default_end_offset_days,
                    settings.missing_comment_start_date,
                    settings.include_today_in_missing_comments,
                    settings.include_empty_report_days_in_missing_comments)
        with self._lock:
            cached_view = self._views.get(view_key)
            if cached_view is not None:
                self._views.move_to_end(view_key)
                data = cached_view
        if cached_view is None:
            global_order = repository._global_user_order(snapshot.common)
            assignments = repository._resolved_comment_assignments(
                snapshot.common, global_order=global_order
            )
            data = repository.build_view_data_from_cache(
                employee_id,
                snapshot.common,
                users_df,
                comments_df,
                start_date=start_date,
                end_date=end_date,
                period_preset=period_preset,
                columnar_rows=True,
                missing_comment_summary=self._missing_summary(
                    snapshot,
                    repository,
                    users_df,
                    comments_df,
                    assigned_subordinate_ids=set(
                        assignments[0].get(employee_id, set())
                    ),
                ),
                load_warning_count=len(snapshot.warnings),
                failed_report_employee_ids={
                    str(item.get("employee_id", ""))
                    for item in snapshot.report_load_failures
                    if item.get("employee_id")
                },
                failed_comment_superior_ids={
                    str(item.get("superior_employee_id", ""))
                    for item in snapshot.comment_load_failures
                    if item.get("superior_employee_id")
                },
                global_order=global_order,
                assignments=assignments,
                report_revision=snapshot.report_revisions.get(self._path_key(
                    safe_employee_csv_path(repository._report_directory_for_employee(employee_id, snapshot.common), employee_id)
                ), "missing"),
            )
            with self._lock:
                # Bound memory and drop older generations, including changed
                # permissions. Never hand mutable cached rows to API callers.
                for key in list(self._views):
                    if key[0] != snapshot.generation:
                        del self._views[key]
                if len(data["rows"]) <= 5000:
                    self._views[view_key] = data
                    while len(self._views) > 2:
                        self._views.popitem(last=False)
        data = {**deepcopy({key: value for key, value in data.items() if key != "rows"}),
                "rows": data["rows"].to_dicts()}
        data_load_diagnostics = self._classify_view_data_load(settings, snapshot)
        view_duration_ms = (perf_counter() - view_started) * 1000
        total_duration_ms = (perf_counter() - operation_started) * 1000
        logger.debug(
            "daily-report cache generation=%s status=%s view_build_ms=%.2f total_ms=%.2f",
            snapshot.generation,
            access.status,
            view_duration_ms,
            total_duration_ms,
        )
        diagnostics = {
            "cache_generation": snapshot.generation,
            "cache_status": access.status,
            "refresh_result": access.refresh_result.to_dict(),
            "cache_warning_count": len(snapshot.warnings),
            "report_load_failures": [
                dict(item) for item in snapshot.report_load_failures
            ],
            "comment_load_failures": [
                dict(item) for item in snapshot.comment_load_failures
            ],
            **data_load_diagnostics,
        }
        return data, diagnostics, snapshot

    def _combined_frames(
        self, snapshot: CacheSnapshot, repository: DailyReportRepository
    ) -> tuple[Table, Table]:
        # A bounded, generation-scoped cache. The lock prevents an old reader
        # from mixing frames with a concurrently published snapshot.
        with self._lock:
            if self._combined is None or self._combined[0] != snapshot.generation:
                self._combined = (
                    snapshot.generation,
                    repository.combine_report_partitions(list(snapshot.report_partitions.values())),
                    repository.combine_comment_partitions(list(snapshot.comment_partitions.values())),
                )
            return self._combined[1], self._combined[2]

    def _missing_summary(
        self, snapshot: CacheSnapshot, repository: DailyReportRepository,
        users: Table, comments: Table,
        *, assigned_subordinate_ids: set[str] | None = None,
    ) -> dict[str, Any]:
        key = (snapshot.generation, repository.today_jst(),
               repository.settings.missing_comment_start_date,
               repository.settings.include_today_in_missing_comments,
               repository.settings.include_empty_report_days_in_missing_comments)
        with self._lock:
            if self._review_summary is None or self._review_summary[0] != key:
                failed_reports = {item["employee_id"] for item in snapshot.report_load_failures}
                targets = (
                    assigned_subordinate_ids
                    if assigned_subordinate_ids is not None
                    else repository.resolve_view_scope(
                        snapshot.common, snapshot.employee_id
                    )["assigned_subordinate_ids"]
                )
                summary = repository._build_missing_comment_summary(
                    users, comments, snapshot.common, snapshot.employee_id,
                    sorted(set(targets) - failed_reports),
                    failed_comment_superior_ids={item["superior_employee_id"] for item in snapshot.comment_load_failures},
                )
                self._review_summary = (key, summary)
            return deepcopy(self._review_summary[1])

    def _classify_view_data_load(
        self, settings: AppSettings, snapshot: CacheSnapshot
    ) -> dict[str, int | bool | str]:
        """Report report/comment CSV failures without treating them as blanks."""
        report_failed = len(snapshot.report_load_failures)
        report_loaded = len(snapshot.report_partitions)
        report_total = report_loaded + report_failed
        comment_failed = len(snapshot.comment_load_failures)
        comment_loaded = len(snapshot.comment_partitions)
        comment_total = comment_loaded + comment_failed
        total = report_total + comment_total
        loaded = report_loaded + comment_loaded
        failed = report_failed + comment_failed
        if total > 0 and failed == total and loaded == 0:
            status = "all_failed"
        elif failed > 0:
            status = "partial"
        else:
            status = "ok"
        return {
            "data_load_status": status,
            "data_load_all_failed": status == "all_failed",
            "report_csv_total": report_total,
            "report_csv_loaded": report_loaded,
            "report_csv_failed": report_failed,
            "comment_csv_total": comment_total,
            "comment_csv_loaded": comment_loaded,
            "comment_csv_failed": comment_failed,
            "report_load_failures": [
                dict(item) for item in snapshot.report_load_failures
            ],
            "comment_load_failures": [
                dict(item) for item in snapshot.comment_load_failures
            ],
        }

    def get_save_context(
        self, settings: AppSettings, employee_id: str
    ) -> dict[str, list[dict[str, Any]]]:
        snapshot = self.ensure_loaded(settings, employee_id).snapshot
        return snapshot.common

    def saved_comment_view(
        self, settings: AppSettings, employee_id: str, target_ids: list[str],
        start_date: str | None, end_date: str | None,
    ) -> dict[str, Any]:
        """Return review flags for affected members, without a full view reload."""
        snapshot = self.ensure_loaded(settings, employee_id).snapshot
        repository = DailyReportRepository(settings, self._base_dir)
        users, comments = self._combined_frames(snapshot, repository)
        global_order = repository._global_user_order(snapshot.common)
        assignments = repository._resolved_comment_assignments(
            snapshot.common, global_order=global_order
        )
        summary = self._missing_summary(
            snapshot,
            repository,
            users,
            comments,
            assigned_subordinate_ids=set(assignments[0].get(employee_id, set())),
        )
        scope = repository.resolve_view_scope(
            snapshot.common,
            employee_id,
            global_order=global_order,
            assignments=assignments,
        )
        failed = {item["employee_id"] for item in snapshot.report_load_failures}
        targets = sorted(set(target_ids) & set(scope["target_employee_ids"]) - failed)
        rows, _, _ = repository._build_rows(
            users.where_in("employee_id", targets), comments,
            snapshot.common, employee_id, scope["assigned_subordinate_ids"], targets,
            start_date, end_date, summary,
            failed_comment_superior_ids={item["superior_employee_id"] for item in snapshot.comment_load_failures},
            global_order=global_order,
            target_commenters=assignments[1],
        )
        return {
            "cache_generation": snapshot.generation,
            "missing_comment_summary": summary,
            "rows": [{"employee_id": row["employee_id"], "date": row["date"],
                      "needs_review": row["needs_review"]} for row in rows],
        }

    def get_admin_common(
        self, settings: AppSettings, employee_id: str
    ) -> tuple[
        dict[str, list[dict[str, Any]]], dict[str, str]
    ]:
        snapshot = self.ensure_loaded(settings, employee_id).snapshot
        return (
            snapshot.common,
            dict(snapshot.common_revisions),
        )

    def get_common(
        self, settings: AppSettings, employee_id: str
    ) -> dict[str, list[dict[str, Any]]]:
        return self.ensure_loaded(settings, employee_id).snapshot.common

    def is_employee_registered(
        self, settings: AppSettings, employee_id: str
    ) -> bool:
        common = self.get_common(settings, employee_id)
        return any(
            str(row.get("employee_id", "")).strip() == employee_id
            for row in common.get("user_master", [])
        )

    def apply_saved_partitions(
        self,
        settings: AppSettings,
        employee_id: str,
        report_partition: tuple[Path | str, Table] | None = None,
        comment_partition: tuple[Path | str, Table] | None = None,
        report_revision: str | None = None,
        report_fingerprint: tuple[int, int] | None = None,
    ) -> bool:
        with self._lock:
            snapshot = self._snapshot
            if (
                snapshot is None
                or snapshot.settings_paths != self._settings_paths(settings)
                or snapshot.employee_id != employee_id
            ):
                return False

            reports = dict(snapshot.report_partitions)
            report_revisions = dict(snapshot.report_revisions)
            comments = dict(snapshot.comment_partitions)
            manifest = dict(snapshot.file_manifest)
            warnings = snapshot.warnings
            report_load_failures = list(snapshot.report_load_failures)
            comment_load_failures = list(snapshot.comment_load_failures)
            target_ids = set(snapshot.target_employee_ids)
            changed = False

            if report_partition is not None:
                path, frame = report_partition
                key = self._path_key(path)
                target_id = Path(path).stem
                if target_id in target_ids:
                    if not report_revision or report_fingerprint is None:
                        raise ValueError("保存した日報CSVの版と更新情報が必要です。")
                    reports[key] = frame.clone()
                    report_revisions[key] = report_revision
                    manifest[key] = FileFingerprint(*report_fingerprint)
                    warnings = self._remove_warning(warnings, key)
                    report_load_failures = [
                        item
                        for item in report_load_failures
                        if str(item.get("employee_id", "")) != target_id
                    ]
                    self._invalid_paths.discard(key)
                    changed = True

            if comment_partition is not None:
                path, frame = comment_partition
                key = self._path_key(path)
                filtered = self._filter_comment_frame(frame, target_ids)
                comments[key] = filtered
                fingerprint = self._fingerprint(Path(path))
                if fingerprint is not None:
                    manifest[key] = fingerprint
                warnings = self._remove_warning(warnings, key)
                comment_load_failures = [
                    item
                    for item in comment_load_failures
                    if str(item.get("superior_employee_id", "")) != Path(path).stem
                ]
                self._invalid_paths.discard(key)
                changed = True

            if changed:
                self._snapshot = self._replace_snapshot(
                    snapshot,
                    report_partitions=reports,
                    report_revisions=report_revisions,
                    comment_partitions=comments,
                    file_manifest=manifest,
                    warnings=warnings,
                    report_load_failures=tuple(report_load_failures),
                    comment_load_failures=tuple(comment_load_failures),
                )
            return changed

    def apply_verified_partitions(
        self, settings: AppSettings, employee_id: str,
        partitions: list[VerifiedPartition],
    ) -> bool:
        """再読込せず検証済み内容を反映する。以後の変更検出には読取時の更新情報を使う。"""
        with self._lock:
            snapshot = self._snapshot
            if (snapshot is None or snapshot.employee_id != employee_id
                    or snapshot.settings_paths != self._settings_paths(settings)):
                return False
            targets = set(snapshot.target_employee_ids)
            allowed = {
                "report": self._report_paths(settings, snapshot.target_employee_ids, snapshot.common),
                "comment": self._comment_paths(settings, snapshot.target_employee_ids, snapshot.common),
            }
            reports = dict(snapshot.report_partitions)
            comments = dict(snapshot.comment_partitions)
            revisions = dict(snapshot.report_revisions)
            manifest = dict(snapshot.file_manifest)
            warnings = snapshot.warnings
            report_failures = list(snapshot.report_load_failures)
            comment_failures = list(snapshot.comment_load_failures)
            for partition in partitions:
                path = allowed.get(partition.kind, {}).get(partition.employee_id)
                key = self._path_key(partition.path)
                if path is None or self._path_key(path) != key:
                    continue
                if partition.kind == "report":
                    reports[key] = partition.frame.clone()
                    revisions[key] = partition.revision
                    report_failures = [item for item in report_failures
                                       if item.get("employee_id") != partition.employee_id]
                else:
                    comments[key] = self._filter_comment_frame(partition.frame, targets)
                    comment_failures = [item for item in comment_failures
                                        if item.get("superior_employee_id") != partition.employee_id]
                if partition.fingerprint is None:
                    manifest.pop(key, None)
                else:
                    manifest[key] = FileFingerprint(*partition.fingerprint)
                warnings = self._remove_warning(warnings, key)
                self._invalid_paths.discard(key)
            self._snapshot = self._replace_snapshot(
                snapshot, report_partitions=reports, comment_partitions=comments,
                report_revisions=revisions, file_manifest=manifest, warnings=warnings,
                report_load_failures=tuple(report_failures),
                comment_load_failures=tuple(comment_failures),
            )
            return True

    def _build_snapshot(
        self, settings: AppSettings, employee_id: str
    ) -> CacheSnapshot:
        started = perf_counter()
        repository = DailyReportRepository(settings, self._base_dir)
        repository.defer_partition_normalization = True
        repository.validate_paths()
        csv_read_started = perf_counter()
        # 起動時に読んだマスターは、保存先・利用者・ファイルが同じ場合だけ再利用する。
        seed, self._startup_common = self._startup_common, None
        common_paths = self._common_paths(settings)
        fingerprints = self._common_fingerprints(common_paths)
        reused_common = seed is not None and seed[:3] == (self._settings_paths(settings), employee_id, fingerprints)
        if reused_common:
            common = seed[3]
            repository.loaded_common_revisions.update(seed[4])
        else:
            common = repository.load_common()
        common_revisions = repository.get_loaded_common_revisions()
        scope = repository.resolve_view_scope(common, employee_id)
        target_ids = tuple(scope["target_employee_ids"])
        target_set = set(target_ids)
        report_partitions: dict[str, Table] = {}
        comment_partitions: dict[str, Table] = {}
        report_load_failures: list[dict[str, str]] = []
        comment_load_failures: list[dict[str, str]] = []
        manifest: dict[str, FileFingerprint] = {}
        warnings: list[dict[str, str]] = [dict(item) for item in repository.load_warnings]
        warning_names = {str(item.get("file", "")) for item in warnings}
        csv_read_count = sum(
            1
            for path in set(common_paths.values())
            if not reused_common and path.exists() and path.name not in warning_names
        )

        for path in set(common_paths.values()):
            if path.name in warning_names:
                continue
            fingerprint = self._fingerprint(path)
            if fingerprint is not None:
                manifest[self._path_key(path)] = fingerprint

        report_paths = self._report_paths(settings, target_ids, common)
        directory_checks: dict[Path, Exception | None] = {}
        user_master = {
            str(row.get("employee_id", "")).strip(): row
            for row in common.get("user_master", [])
        }
        for target_id in target_ids:
            path: Path | None = None
            try:
                path = report_paths[target_id]
                directory_error = self._directory_error(path.parent, "日報", directory_checks)
                if directory_error is not None:
                    raise directory_error
                if not path.exists():
                    continue
                frame = repository.load_report_partition(path, target_id)
                key = self._path_key(path)
                report_partitions[key] = frame
                loaded_fingerprint = repository.loaded_report_fingerprints.get(key)
                if loaded_fingerprint is not None:
                    manifest[key] = FileFingerprint(*loaded_fingerprint)
                csv_read_count += 1
            except Exception as exc:
                warnings.append(self._warning(path or target_id, exc))
                logger.warning(
                    "Failed to load report CSV path=%s employee_id=%s",
                    path or target_id,
                    target_id,
                    exc_info=True,
                )
                directory_failure = (
                    path is None
                    or directory_checks.get(path.parent) is not None
                )
                report_load_failures.append(
                    self._report_failure(
                        target_id,
                        user_master.get(target_id, {}),
                        exc,
                        source="directory" if directory_failure else "csv",
                    )
                )

        required_comments = self._comment_paths(settings, target_ids, common)
        if required_comments:
            comments_dir = settings.storage_dir("comments")
            comments_error = self._directory_error(comments_dir, "上司コメント", directory_checks)
            comment_files = list(required_comments.values()) if comments_error is None else []
            if comments_error is not None:
                exc = comments_error
                warnings.append(self._warning(comments_dir, exc))
                logger.warning(
                    "Failed to access supervisor comment directory path=%s",
                    comments_dir,
                    exc_info=True,
                )
                superior_ids = repository._commenter_ids_for_targets(
                    common, list(target_ids)
                )
                for superior_id in superior_ids or [""]:
                    comment_load_failures.append(
                        self._comment_failure(
                            superior_id,
                            user_master.get(superior_id, {}),
                            exc,
                            source="directory",
                        )
                    )
                comment_files = []
            for path in comment_files:
                try:
                    if not path.exists():
                        continue
                    frame = repository.load_comment_partition(path, target_set)
                    key = self._path_key(path)
                    comment_partitions[key] = frame
                    fingerprint = repository.loaded_comment_fingerprints.get(key)
                    if fingerprint is not None:
                        manifest[key] = FileFingerprint(*fingerprint)
                    csv_read_count += 1
                except Exception as exc:
                    warnings.append(self._warning(path, exc))
                    logger.warning(
                        "Failed to load supervisor comment CSV path=%s superior_employee_id=%s",
                        path,
                        path.stem,
                        exc_info=True,
                    )
                    superior_id = path.stem
                    comment_load_failures.append(
                        self._comment_failure(
                            superior_id,
                            user_master.get(superior_id, {}),
                            exc,
                        )
                    )

        csv_read_duration_ms = (perf_counter() - csv_read_started) * 1000

        report_partitions = repository.normalize_partitions(
            report_partitions, USER_COLUMNS, USER_KEYS
        )
        comment_partitions = repository.normalize_partitions(
            comment_partitions, COMMENT_COLUMNS,
            COMMENT_KEYS,
        )
        snapshot = CacheSnapshot(
            settings_paths=self._settings_paths(settings),
            employee_id=employee_id,
            common=common,
            common_revisions=common_revisions,
            report_partitions=report_partitions,
            report_revisions=dict(repository.loaded_report_revisions),
            comment_partitions=comment_partitions,
            file_manifest=manifest,
            target_employee_ids=target_ids,
            generation=self._next_generation(),
            built_at=datetime.now(),
            warnings=tuple(warnings),
            report_load_failures=tuple(report_load_failures),
            comment_load_failures=tuple(comment_load_failures),
        )
        logger.info(
            "daily-report cache generation=%s status=built csv_reads=%s csv_read_ms=%.2f build_ms=%.2f warnings=%s",
            snapshot.generation,
            csv_read_count,
            csv_read_duration_ms,
            (perf_counter() - started) * 1000,
            len(warnings),
        )
        return snapshot

    def _refresh_changed_locked(
        self, settings: AppSettings, employee_id: str
    ) -> CacheAccess:
        snapshot = self._snapshot
        if snapshot is None:
            built = self._build_snapshot(settings, employee_id)
            self._snapshot = built
            return CacheAccess(built, "built")

        scan_started = perf_counter()
        directory_checks: dict[Path, Exception | None] = {}
        try:
            common_paths = self._common_paths(settings)
            current_manifest = self._scan_manifest(
                settings, snapshot.target_employee_ids, snapshot.common,
                directory_checks, common_paths,
            )
        except Exception as exc:
            logger.exception("Failed to scan daily-report cache manifest")
            result = RefreshResult(failed=1)
            warned = self._replace_snapshot(
                snapshot,
                warnings=self._merge_warning(
                    snapshot.warnings, "manifest", str(exc)
                ),
            )
            self._snapshot = warned
            return CacheAccess(warned, "refreshed", result)
        manifest_scan_duration_ms = (perf_counter() - scan_started) * 1000

        reports = dict(snapshot.report_partitions)
        report_revisions = dict(snapshot.report_revisions)
        comments = dict(snapshot.comment_partitions)
        manifest = dict(snapshot.file_manifest)
        common = snapshot.common
        common_revisions = dict(snapshot.common_revisions)
        target_ids = tuple(snapshot.target_employee_ids)
        warnings = self._remove_warning(snapshot.warnings, "manifest")
        report_load_failures = [dict(item) for item in snapshot.report_load_failures]
        comment_load_failures = [dict(item) for item in snapshot.comment_load_failures]
        changed_count = 0
        added_count = 0
        deleted_count = 0
        failed_count = 0
        csv_read_count = 0
        csv_read_duration_ms = 0.0
        changed_state = False

        common_keys = {self._path_key(path) for path in common_paths.values()}
        old_common_manifest = {
            key: value for key, value in manifest.items() if key in common_keys
        }
        new_common_manifest = {
            key: value for key, value in current_manifest.items() if key in common_keys
        }
        common_changed_keys = self._changed_keys(
            old_common_manifest, new_common_manifest
        )

        if common_changed_keys:
            repository = DailyReportRepository(settings, self._base_dir)
            common_read_started = perf_counter()
            previous_common = common
            previous_common_revisions = dict(common_revisions)
            previous_reports = dict(reports)
            previous_report_revisions = dict(report_revisions)
            previous_comments = dict(comments)
            previous_manifest = dict(manifest)
            previous_target_ids = target_ids
            previous_warnings = warnings
            previous_failed_count = failed_count
            previous_changed_state = changed_state
            previous_invalid_paths = set(self._invalid_paths)
            try:
                calendar_key = self._path_key(common_paths["calendar"])
                organization_changed = any(
                    key != calendar_key for key in common_changed_keys
                )
                if organization_changed:
                    candidate_common = repository.load_common()
                    csv_read_count += sum(
                        1 for path in set(common_paths.values()) if path.exists()
                    )
                    if repository.load_warnings:
                        raise RuntimeError(
                            " / ".join(
                                item.get("error", "")
                                for item in repository.load_warnings
                            )
                        )
                    candidate_scope = repository.resolve_view_scope(
                        candidate_common, employee_id
                    )
                    candidate_targets = tuple(
                        candidate_scope["target_employee_ids"]
                    )
                    common = candidate_common
                    if set(candidate_targets) != set(target_ids):
                        # CSV自体が未変更でも、抽出対象の部下が変われば再読込する。
                        # 失敗時に保持する前回値からも閲覧対象外の行を除く。
                        self._invalid_paths.update(comments)
                        comments = {
                            key: self._filter_comment_frame(frame, set(candidate_targets))
                            for key, frame in comments.items()
                        }
                    target_ids = candidate_targets
                    changed_state = True
                else:
                    calendar = repository.load_calendar_master()
                    csv_read_count += int(common_paths["calendar"].exists())
                    if repository.load_warnings:
                        raise RuntimeError(
                            " / ".join(
                                item.get("error", "")
                                for item in repository.load_warnings
                            )
                        )
                    common = {**common, "calendar": calendar}
                    changed_state = True

                for key in common_keys:
                    if key in new_common_manifest:
                        manifest[key] = new_common_manifest[key]
                        warnings = self._remove_warning(warnings, key)
                        self._invalid_paths.discard(key)
                    else:
                        manifest.pop(key, None)
                        self._invalid_paths.discard(key)
                for master, path in common_paths.items():
                    if self._path_key(path) in common_changed_keys:
                        common_revisions[master] = (
                            repository.loaded_common_revisions.get(master)
                            or repository.get_common_master_revision(master)
                        )
                for key in common_changed_keys:
                    if key in old_common_manifest and key in new_common_manifest:
                        changed_count += 1
                    elif key in new_common_manifest:
                        added_count += 1
                    else:
                        deleted_count += 1
            except Exception as exc:
                logger.warning(
                    "Failed to refresh common masters; keeping previous snapshot",
                    exc_info=True,
                )
                common = previous_common
                common_revisions = previous_common_revisions
                reports = previous_reports
                report_revisions = previous_report_revisions
                comments = previous_comments
                manifest = previous_manifest
                target_ids = previous_target_ids
                warnings = previous_warnings
                failed_count = previous_failed_count + len(common_changed_keys)
                changed_state = previous_changed_state
                self._invalid_paths = previous_invalid_paths
                for key in common_changed_keys:
                    self._invalid_paths.add(key)
                    warnings = self._merge_warning(warnings, key, str(exc))
            finally:
                csv_read_duration_ms += (
                    perf_counter() - common_read_started
                ) * 1000

        next_scan_started = perf_counter()
        repository = DailyReportRepository(settings, self._base_dir)
        report_paths = self._report_paths(settings, target_ids, common)
        report_directory_errors: dict[str, Exception] = {}
        for target_id, path in report_paths.items():
            error = self._directory_error(path.parent, "日報", directory_checks)
            if error is not None:
                report_directory_errors[target_id] = error

        comments_dir = settings.storage_dir("comments")
        required_comments = self._comment_paths(settings, target_ids, common)
        comment_directory_error = (
            self._directory_error(comments_dir, "上司コメント", directory_checks)
            if required_comments else None
        )

        if target_ids != snapshot.target_employee_ids or common is not snapshot.common:
            current_manifest = self._scan_manifest(
                settings, target_ids, common, directory_checks, common_paths
            )
        manifest_scan_duration_ms += (perf_counter() - next_scan_started) * 1000
        report_path_by_key = {
            self._path_key(path): (target_id, path)
            for target_id, path in report_paths.items()
        }
        comment_paths = {
            self._path_key(path): path
            for path in required_comments.values()
        }

        # 担当変更だけで閲覧対象の部下が同じ場合も、不要になった上司を除外する。
        previous_comment_paths = self._comment_paths(
            settings, snapshot.target_employee_ids, snapshot.common
        )
        previous_report_paths = self._report_paths(
            settings, snapshot.target_employee_ids, snapshot.common
        )
        for directory in {path.parent for path in previous_report_paths.values()} - {
            path.parent for path in report_paths.values()
        }:
            warnings = self._remove_warning(warnings, str(directory))
        obsolete_keys = (
            set(reports) | set(comments)
            | {self._path_key(path) for path in previous_comment_paths.values()}
            | {self._path_key(path) for path in previous_report_paths.values()}
        ) - set(report_path_by_key) - set(comment_paths)
        for key in obsolete_keys:
            reports.pop(key, None)
            report_revisions.pop(key, None)
            comments.pop(key, None)
            manifest.pop(key, None)
            self._invalid_paths.discard(key)
            warnings = self._remove_warning(warnings, key)
            changed_state = True
        report_load_failures = [
            item for item in report_load_failures
            if item.get("employee_id") in report_paths
        ]
        comment_load_failures = [
            item for item in comment_load_failures
            if item.get("superior_employee_id") in required_comments
        ]

        user_master = {
            str(row.get("employee_id", "")).strip(): row
            for row in common.get("user_master", [])
        }
        for target_id, error in report_directory_errors.items():
            report_load_failures = [
                item
                for item in report_load_failures
                if str(item.get("employee_id", "")) != target_id
            ]
            report_load_failures.append(
                self._report_failure(
                    target_id,
                    user_master.get(target_id, {}),
                    error,
                    source="directory",
                )
            )
            warnings = self._merge_warning(
                warnings,
                str(report_paths[target_id].parent),
                str(error),
            )
        valid_report_ids = set(report_paths) - set(report_directory_errors)
        for target_id in valid_report_ids:
            warnings = self._remove_warning(warnings, str(report_paths[target_id].parent))
        report_load_failures = [
            item
            for item in report_load_failures
            if not (
                str(item.get("employee_id", "")) in valid_report_ids
                and item.get("source") == "directory"
            )
        ]
        if comment_directory_error is not None:
            superior_ids = repository._commenter_ids_for_targets(
                common, list(target_ids)
            )
            comment_load_failures = [
                item for item in comment_load_failures if item.get("source") != "directory"
            ]
            for superior_id in superior_ids or [""]:
                comment_load_failures.append(
                    self._comment_failure(
                        superior_id,
                        user_master.get(superior_id, {}),
                        comment_directory_error,
                        source="directory",
                    )
                )
            warnings = self._merge_warning(
                warnings,
                str(comments_dir),
                str(comment_directory_error),
            )
        else:
            warnings = self._remove_warning(warnings, str(comments_dir))
            comment_load_failures = [
                item
                for item in comment_load_failures
                if item.get("source") != "directory"
            ]

        failed_count += len(report_directory_errors)
        if comment_directory_error is not None:
            failed_count += len(required_comments)
        failed_report_ids = {
            item.get("employee_id")
            for item in (*snapshot.report_load_failures, *report_load_failures)
        }
        failed_superior_ids = {
            item.get("superior_employee_id")
            for item in (*snapshot.comment_load_failures, *comment_load_failures)
        }
        data_keys = set(report_path_by_key) | set(comment_paths) | set(reports) | set(comments)
        for key in sorted(data_keys):
            if key in common_keys:
                continue
            report_target = report_path_by_key.get(key, ("", None))[0]
            if report_target in report_directory_errors or (
                key in comment_paths and comment_directory_error is not None
            ):
                # 一時的なアクセス障害をファイル削除と見なさず、次回に再試行する。
                self._invalid_paths.add(key)
                continue
            old_fingerprint = manifest.get(key)
            new_fingerprint = current_manifest.get(key)
            invalid = key in self._invalid_paths
            has_failure = (
                report_target in failed_report_ids if report_target
                else comment_paths[key].stem in failed_superior_ids
            )
            if old_fingerprint == new_fingerprint and not invalid and not has_failure:
                continue

            existed = old_fingerprint is not None
            if new_fingerprint is None:
                removed = False
                if key in reports:
                    reports.pop(key, None)
                    report_revisions.pop(key, None)
                    removed = True
                if key in comments:
                    comments.pop(key, None)
                    removed = True
                report_target = report_path_by_key.get(key, ("", None))[0]
                if report_target:
                    report_load_failures = [
                        item
                        for item in report_load_failures
                        if str(item.get("employee_id", "")) != report_target
                    ]
                comment_path = comment_paths.get(key)
                if comment_path is not None:
                    comment_load_failures = [
                        item
                        for item in comment_load_failures
                        if str(item.get("superior_employee_id", ""))
                        != comment_path.stem
                    ]
                manifest.pop(key, None)
                self._invalid_paths.discard(key)
                warnings = self._remove_warning(warnings, key)
                if removed or existed:
                    deleted_count += 1
                    changed_state = True
                continue

            repository = DailyReportRepository(settings, self._base_dir)
            read_started = perf_counter()
            try:
                if key in report_path_by_key:
                    target_id, path = report_path_by_key[key]
                    reports[key] = repository.load_report_partition(path, target_id)
                    report_revisions.update(repository.loaded_report_revisions)
                    report_load_failures = [
                        item
                        for item in report_load_failures
                        if str(item.get("employee_id", "")) != target_id
                    ]
                elif key in comment_paths:
                    path = comment_paths[key]
                    comments[key] = repository.load_comment_partition(
                        path, set(target_ids)
                    )
                    comment_load_failures = [
                        item
                        for item in comment_load_failures
                        if str(item.get("superior_employee_id", "")) != path.stem
                    ]
                else:
                    continue
                manifest[key] = (
                    FileFingerprint(*repository.loaded_report_fingerprints[key])
                    if key in repository.loaded_report_fingerprints else
                    FileFingerprint(*repository.loaded_comment_fingerprints[key])
                    if key in repository.loaded_comment_fingerprints else new_fingerprint
                )
                self._invalid_paths.discard(key)
                warnings = self._remove_warning(warnings, key)
                csv_read_count += 1
                if existed:
                    changed_count += 1
                else:
                    added_count += 1
                changed_state = True
            except Exception as exc:
                failed_count += 1
                warnings = self._merge_warning(warnings, key, str(exc))
                if key in report_path_by_key:
                    target_id, path = report_path_by_key[key]
                    report_load_failures = [
                        item
                        for item in report_load_failures
                        if str(item.get("employee_id", "")) != target_id
                    ]
                    report_load_failures.append(
                        self._report_failure(
                            target_id,
                            next(
                                (
                                    row
                                    for row in common.get("user_master", [])
                                    if str(row.get("employee_id", "")) == target_id
                                ),
                                {},
                            ),
                            exc,
                        )
                    )
                elif key in comment_paths:
                    path = comment_paths[key]
                    comment_load_failures = [
                        item
                        for item in comment_load_failures
                        if str(item.get("superior_employee_id", "")) != path.stem
                    ]
                    comment_load_failures.append(
                        self._comment_failure(
                            path.stem,
                            next(
                                (
                                    row
                                    for row in common.get("user_master", [])
                                    if str(row.get("employee_id", "")) == path.stem
                                ),
                                {},
                            ),
                            exc,
                        )
                    )
                logger.warning(
                    "Failed to refresh cached CSV path=%s", key, exc_info=True
                )
            finally:
                csv_read_duration_ms += (perf_counter() - read_started) * 1000

        result = RefreshResult(
            changed=changed_count,
            added=added_count,
            deleted=deleted_count,
            failed=failed_count,
        )
        if (
            changed_state or failed_count or warnings != snapshot.warnings
            or tuple(report_load_failures) != snapshot.report_load_failures
            or tuple(comment_load_failures) != snapshot.comment_load_failures
        ):
            refreshed = self._replace_snapshot(
                snapshot,
                common=common,
                common_revisions=common_revisions,
                report_partitions=reports,
                report_revisions=report_revisions,
                comment_partitions=comments,
                file_manifest=manifest,
                target_employee_ids=target_ids,
                warnings=warnings,
                report_load_failures=tuple(report_load_failures),
                comment_load_failures=tuple(comment_load_failures),
            )
            self._snapshot = refreshed
            status = "refreshed"
        else:
            refreshed = snapshot
            status = "unchanged"

        logger.info(
            "daily-report cache generation=%s status=%s manifest_scan_ms=%.2f csv_reads=%s csv_read_ms=%.2f changed=%s added=%s deleted=%s failed=%s",
            refreshed.generation,
            status,
            manifest_scan_duration_ms,
            csv_read_count,
            csv_read_duration_ms,
            result.changed,
            result.added,
            result.deleted,
            result.failed,
        )
        return CacheAccess(refreshed, status, result)

    def _scan_manifest(
        self,
        settings: AppSettings,
        target_employee_ids: tuple[str, ...],
        common: dict[str, list[dict[str, Any]]] | None = None,
        directory_checks: dict[Path, Exception | None] | None = None,
        common_paths: dict[str, Path] | None = None,
    ) -> dict[str, FileFingerprint]:
        manifest: dict[str, FileFingerprint] = {}
        checks = directory_checks if directory_checks is not None else {}
        paths = list((common_paths if common_paths is not None else self._common_paths(settings)).values())
        for label, scoped_paths in (
            ("日報", self._report_paths(settings, target_employee_ids, common)),
            ("上司コメント", self._comment_paths(settings, target_employee_ids, common)),
        ):
            for path in scoped_paths.values():
                if self._directory_error(path.parent, label, checks) is None:
                    paths.append(path)
        for path in dict.fromkeys(paths):
            fingerprint = self._fingerprint(path)
            if fingerprint is not None:
                manifest[self._path_key(path)] = fingerprint
        return manifest

    @staticmethod
    def _changed_keys(
        old: dict[str, FileFingerprint], new: dict[str, FileFingerprint]
    ) -> set[str]:
        return {
            key
            for key in set(old) | set(new)
            if old.get(key) != new.get(key)
        }

    @staticmethod
    def _filter_comment_frame(
        frame: Table, target_employee_ids: set[str]
    ) -> Table:
        if frame.is_empty() or not target_employee_ids:
            return frame.head(0)
        if "subordinate_employee_id" not in frame.columns:
            return frame.head(0)
        return frame.where_in("subordinate_employee_id", sorted(target_employee_ids))

    @staticmethod
    def _common_paths(settings: AppSettings) -> dict[str, Path]:
        root = settings.storage_dir("common")
        unified = root / "administration.csv"
        use_unified = unified.exists()
        return {
            **{master: unified if use_unified else root / f"{master}.csv"
               for master in ("user_master", "team_master", "comment_assignment")},
            "calendar": root / "calendar.csv",
        }


    @staticmethod
    def _report_paths(
        settings: AppSettings,
        target_employee_ids: tuple[str, ...],
        common: dict[str, list[dict[str, Any]]] | None = None,
    ) -> dict[str, Path]:
        paths: dict[str, Path] = {}
        user_master = {
            str(row.get("employee_id", "")).strip(): row
            for row in (common or {}).get("user_master", [])
        }
        for target_id in target_employee_ids:
            try:
                user = user_master.get(str(target_id), {})
                kind = (
                    "temporary_reports"
                    if str(user.get("employment_type", "")).strip() == "temporary"
                    else "regular_reports"
                )
                paths[target_id] = safe_employee_csv_path(
                    settings.storage_dir(kind), target_id
                )
            except ValueError:
                logger.warning(
                    "Ignoring invalid employee id from cached master: %r", target_id
                )
        return paths

    def _comment_paths(
        self,
        settings: AppSettings,
        target_employee_ids: tuple[str, ...],
        common: dict[str, list[dict[str, Any]]] | None,
    ) -> dict[str, Path]:
        repository = DailyReportRepository(settings, self._base_dir)
        paths: dict[str, Path] = {}
        for superior_id in repository._commenter_ids_for_targets(common or {}, list(target_employee_ids)):
            try:
                paths[superior_id] = safe_employee_csv_path(settings.storage_dir("comments"), superior_id)
            except ValueError:
                logger.warning("Ignoring invalid superior id from cached master: %r", superior_id)
        return paths

    def _common_fingerprints(self, paths: dict[str, Path]) -> dict[str, FileFingerprint | None]:
        fingerprints = {path: self._fingerprint(path) for path in set(paths.values())}
        return {master: fingerprints[path] for master, path in paths.items()}

    @staticmethod
    def _directory_error(
        directory: Path, label: str, checks: dict[Path, Exception | None]
    ) -> Exception | None:
        # 1回の読み込み操作内だけ共有し、次回の更新では必ず確認し直す。
        if directory not in checks:
            try:
                mode = directory.stat().st_mode
                if not stat.S_ISDIR(mode):
                    raise NotADirectoryError(f"{label}パスがフォルダではありません: {directory.name}")
                if not os.access(directory, os.R_OK):
                    raise PermissionError(f"{label}フォルダにアクセスできません: {directory.name}")
                checks[directory] = None
            except FileNotFoundError:
                checks[directory] = FileNotFoundError(f"{label}フォルダが見つかりません: {directory.name}")
            except OSError as exc:
                checks[directory] = exc
        return checks[directory]

    @staticmethod
    def _fingerprint(path: Path) -> FileFingerprint | None:
        try:
            file_stat = path.stat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(file_stat.st_mode):
            return None
        return FileFingerprint(size=file_stat.st_size, mtime_ns=file_stat.st_mtime_ns)

    @staticmethod
    def _path_key(path: Path | str) -> str:
        return os.path.normcase(str(Path(path).resolve(strict=False)))

    def _settings_paths(self, settings: AppSettings) -> tuple[str, ...]:
        return (self._path_key(settings.storage_root),)

    @staticmethod
    def _report_failure(
        employee_id: str,
        user: dict[str, Any],
        _error: Exception,
        *,
        source: str = "csv",
    ) -> dict[str, str]:
        return {
            "employee_id": str(employee_id),
            "display_name": str(user.get("display_name") or employee_id),
            "source": source,
        }

    @staticmethod
    def _comment_failure(
        superior_employee_id: str,
        user: dict[str, Any],
        _error: Exception,
        *,
        source: str = "csv",
    ) -> dict[str, str]:
        superior_id = str(superior_employee_id or "")
        return {
            "superior_employee_id": superior_id,
            "display_name": str(user.get("display_name") or superior_id),
            "source": source,
        }

    @staticmethod
    def _warning(path: Path | str, error: Exception) -> dict[str, str]:
        return {"file": str(path), "error": str(error)}

    @staticmethod
    def _warning_matches(item: dict[str, str], key: str) -> bool:
        file_value = str(item.get("file", ""))
        if file_value == key:
            return True
        return Path(key).name == Path(file_value).name

    def _remove_warning(
        self, warnings: tuple[dict[str, str], ...], key: str
    ) -> tuple[dict[str, str], ...]:
        return tuple(
            item for item in warnings if not self._warning_matches(item, key)
        )

    def _merge_warning(
        self,
        warnings: tuple[dict[str, str], ...],
        key: str,
        error: str,
    ) -> tuple[dict[str, str], ...]:
        return (
            *self._remove_warning(warnings, key),
            {"file": key, "error": error},
        )

    def _merge_warnings(
        self,
        existing: tuple[dict[str, str], ...],
        incoming: tuple[dict[str, str], ...],
    ) -> tuple[dict[str, str], ...]:
        merged = existing
        for warning in incoming:
            merged = self._merge_warning(
                merged,
                str(warning.get("file", "")),
                str(warning.get("error", "")),
            )
        return merged

    def _replace_snapshot(
        self, snapshot: CacheSnapshot, **changes: Any
    ) -> CacheSnapshot:
        return replace(
            snapshot,
            generation=self._next_generation(),
            built_at=datetime.now(),
            **changes,
        )

    def _next_generation(self) -> int:
        self._generation += 1
        return self._generation

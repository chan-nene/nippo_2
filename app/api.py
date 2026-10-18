from __future__ import annotations

import getpass
import json
import logging
import os
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

from app.calendar_policy import CALENDAR_MIN_FISCAL_YEAR
from app.config import (
    SettingsManager,
    StorageConfigError,
    StorageManager,
    normalize_color_appearance,
    normalize_member_filter_levels,
    to_bool,
    to_int,
)
from app.data_cache import DailyReportDataCache
from app.repository import (
    CommonMasterConflictError,
    CsvFileLockedError,
    CsvReadonlyError,
    DailyReportRepository,
)
from app.security import (
    PERIOD_PRESETS,
    RequestValidationError,
    validate_administration_save_request,
    validate_common_master_save_request,
    validate_load_request,
    validate_save_request,
    validate_settings_request,
    validate_ui_state_request,
    validate_user_administration_save_request,
    validate_user_team_references,
)

logger = logging.getLogger(__name__)
UNREGISTERED_EMPLOYEE_MESSAGE = "このアプリは使用できません。管理者に連絡してください。"
DEFAULT_ALLOWED_MEMBER_FILTER_LEVELS = ("department", "section", "member")


class DailyReportApi:
    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir
        self._settings_manager = SettingsManager(base_dir)
        self._settings = self._settings_manager.load()
        self._storage_manager = StorageManager(base_dir)
        self._storage_error: StorageConfigError | None = None
        try:
            self._settings.root_path = self._storage_manager.load()
        except StorageConfigError as exc:
            self._storage_error = exc
            logger.error(
                "Storage configuration is unavailable code=%s target=%s",
                exc.code,
                exc.target,
                exc_info=True,
            )
        self._employee_id = self._get_employee_id()
        self._has_unsaved_changes = False
        self._close_window_callback: Callable[[], None] | None = None
        self._data_cache = DailyReportDataCache(base_dir)

    @property
    def employee_id(self) -> str:
        return self._employee_id

    @property
    def has_unsaved_changes(self) -> bool:
        return self._has_unsaved_changes

    def set_unsaved_changes(self, value: Any) -> dict[str, bool]:
        self._has_unsaved_changes = to_bool(value, False)
        return {"ok": True}

    def _set_close_window_callback(self, callback: Callable[[], None]) -> None:
        self._close_window_callback = callback

    def close_window(self) -> dict[str, bool]:
        callback = getattr(self, "_close_window_callback", None)
        if callback is None:
            return {"ok": False}
        callback()
        return {"ok": True}

    def get_initial_state(self) -> dict[str, Any]:
        employee_registered: bool | None = None
        is_admin = False
        settings_context = self._default_settings_context()
        storage_runtime_error: StorageConfigError | None = None
        storage_error = getattr(self, "_storage_error", None)
        if self._settings.is_complete and storage_error is None:
            try:
                repository = DailyReportRepository(self._settings, self._base_dir)
                common = self._get_data_cache().read_startup_common(
                    self._settings, self._employee_id
                )
                current_user = next((row for row in common.get("user_master", [])
                                     if str(row.get("employee_id", "")).strip() == self._employee_id), None)
                employee_registered = current_user is not None
                is_admin = self._user_is_admin(current_user)
                settings_context = self._build_settings_context(repository=repository, common=common)
            except StorageConfigError as exc:
                storage_runtime_error = exc
                logger.error("Storage directory unavailable during bootstrap", exc_info=True)
            except Exception:
                logger.exception("Failed to check employee registration")
        if employee_registered is False:
            is_admin = False
        return {
            "employee_id": self._employee_id,
            "is_admin": is_admin,
            "calendar_min_fiscal_year": CALENDAR_MIN_FISCAL_YEAR,
            "settings": self._settings.to_dict(),
            "settings_complete": self._settings.is_complete,
            "storage_configured": (
                storage_error is None
                and storage_runtime_error is None
                and self._settings.is_complete
            ),
            "storage_error_code": (
                storage_error or storage_runtime_error
            ).code
            if (storage_error or storage_runtime_error)
            else "",
            "storage_error_message": (
                self._storage_error_message(storage_error or storage_runtime_error)
                if (storage_error or storage_runtime_error)
                else ""
            ),
            "employee_registered": employee_registered,
            "access_denied": employee_registered is False,
            "access_denied_message": (
                UNREGISTERED_EMPLOYEE_MESSAGE
                if employee_registered is False
                else ""
            ),
            "settings_context": settings_context,
            **settings_context,
        }

    def load_settings(self) -> dict[str, Any]:
        with self._settings_manager.lock:
            try:
                # storage.ini is deployment configuration and is read only at
                # application startup. Replacing it takes effect after restart.
                root_path = self._settings.root_path
                self._settings = self._settings_manager.load()
                self._settings.root_path = root_path
                settings_context = self._build_settings_context()
                return {
                    "ok": True,
                    "settings": self._settings.to_dict(),
                    "settings_complete": self._settings.is_complete,
                    "storage_configured": self._storage_ready,
                    "settings_context": settings_context,
                    **settings_context,
                }
            except Exception:
                logger.exception("Failed to load settings")
                return {
                    "ok": False,
                    "message": "設定を読み込めませんでした。",
                }

    def save_settings(self, payload: Any) -> dict[str, Any]:
        with self._settings_manager.lock:
            try:
                payload = validate_settings_request(payload)
                color_theme, color_palette = normalize_color_appearance(
                    payload.get("ui_color_theme"),
                    payload.get("ui_color_palette"),
                    theme_default=self._settings.ui_color_theme,
                    palette_default=self._settings.ui_color_palette,
                )
                candidate = replace(
                    self._settings,
                    default_start_offset_days=to_int(
                        payload.get("default_start_offset_days"), -2
                    ),
                    default_end_offset_days=to_int(
                        payload.get("default_end_offset_days"), 0
                    ),
                    missing_comment_start_date=str(
                        payload.get("missing_comment_start_date", "")
                    ).strip(),
                    include_today_in_missing_comments=to_bool(
                        payload.get("include_today_in_missing_comments"),
                        self._settings.include_today_in_missing_comments,
                    ),
                    include_empty_report_days_in_missing_comments=to_bool(
                        payload.get("include_empty_report_days_in_missing_comments"),
                        self._settings.include_empty_report_days_in_missing_comments,
                    ),
                    comment_signature=str(payload.get("comment_signature", "")).strip(),
                    ui_color_theme=color_theme,
                    ui_color_palette=color_palette,
                    ui_member_filter_levels=normalize_member_filter_levels(
                        payload.get("ui_member_filter_levels"),
                        self._settings.ui_member_filter_levels,
                    ),
                )
                self._settings_manager.save(candidate)
                self._settings = candidate
                settings_context = self._build_settings_context()
                return {
                    "ok": True,
                    "message": "設定を保存しました。",
                    "settings": self._settings.to_dict(),
                    "storage_configured": getattr(self, "_storage_error", None) is None
                    and self._settings.is_complete,
                    "settings_context": settings_context,
                    **settings_context,
                }
            except RequestValidationError as exc:
                return self._invalid_request(exc)
            except Exception:
                logger.exception("Failed to save settings")
                return {"ok": False, "message": "設定の保存に失敗しました。"}

    def save_ui_state(self, payload: Any) -> dict[str, Any]:
        with self._settings_manager.lock:
            try:
                payload = validate_ui_state_request(payload)
                color_theme, color_palette = normalize_color_appearance(
                    payload.get("ui_color_theme"),
                    payload.get("ui_color_palette"),
                    theme_default=self._settings.ui_color_theme,
                    palette_default=self._settings.ui_color_palette,
                )
                preset = str(payload.get("period_preset", "")).strip()
                if preset == "last7days":
                    preset = "default"
                if preset not in PERIOD_PRESETS:
                    preset = "default"
                candidate = replace(
                    self._settings,
                    ui_period_preset=preset,
                    ui_show_holidays=payload.get("ui_show_holidays", self._settings.ui_show_holidays),
                    ui_start_date=str(payload.get("start_date", "")).strip(),
                    ui_end_date=str(payload.get("end_date", "")).strip(),
                    ui_font_size=self._validated_font_size(payload.get("font_size")),
                    ui_color_theme=color_theme,
                    ui_color_palette=color_palette,
                    ui_column_widths=(
                        json.dumps(
                            payload["column_widths"],
                            ensure_ascii=False,
                            separators=(",", ":"),
                            sort_keys=True,
                        )
                        if "column_widths" in payload
                        else self._settings.ui_column_widths
                    ),
                )
                self._settings_manager.save(candidate)
                self._settings = candidate
                return {"ok": True}
            except RequestValidationError as exc:
                return self._invalid_request(exc)
            except Exception:
                logger.exception("Failed to save UI state")
                return {"ok": False, "message": "表示状態の保存に失敗しました。"}

    def load_data(self, payload: Any = None) -> dict[str, Any]:
        try:
            payload = validate_load_request(payload)
            if not self._storage_ready:
                return self._storage_unavailable_response()
            data_cache = self._get_data_cache()
            data, diagnostics = data_cache.load_view_data(
                self._settings,
                self._employee_id,
                start_date=payload.get("start_date"),
                end_date=payload.get("end_date"),
                period_preset=payload.get("period_preset"),
                force_refresh=bool(payload.get("force_refresh", False)),
            )
            if not data_cache.is_employee_registered(
                self._settings, self._employee_id
            ):
                return self._employee_access_denied()
            settings_context = self._build_settings_context()
            data["allowed_member_filter_levels"] = settings_context[
                "allowed_member_filter_levels"
            ]
            data["has_comment_targets"] = settings_context["has_comment_targets"]
            return {"ok": True, "data": data, **diagnostics}
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except StorageConfigError as exc:
            logger.error("Storage directory unavailable while loading reports", exc_info=True)
            return self._storage_operation_error(exc)
        except Exception:
            logger.exception("Failed to load daily report data")
            return {"ok": False, "message": "現在利用できません。"}

    def load_common_masters(self, payload: Any = None) -> dict[str, Any]:
        try:
            payload = validate_load_request(payload)
            if not self._is_admin():
                return self._admin_access_denied()
            access_denied = self._registered_employee_access_denied()
            if access_denied:
                return access_denied
            if not self._storage_ready:
                return self._storage_unavailable_response()
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            data_cache = self._get_data_cache()
            cache_access = None
            if payload["force_refresh"] or data_cache.is_loaded:
                cache_access = (
                    data_cache.refresh_changed(self._settings, self._employee_id)
                    if payload["force_refresh"]
                    else data_cache.ensure_loaded(self._settings, self._employee_id)
                )
                snapshot = cache_access.snapshot
                data = snapshot.common
                revisions = dict(snapshot.common_revisions)
            else:
                data = repo.load_common_masters()
                revisions = repo.get_loaded_common_revisions()
            return {
                "ok": True,
                "data": data,
                "revisions": revisions,
                **(
                    {
                        "cache_status": cache_access.status,
                        "refresh_result": cache_access.refresh_result.to_dict(),
                        "cache_warning_count": len(cache_access.snapshot.warnings),
                    }
                    if cache_access is not None
                    else {}
                ),
            }
        except StorageConfigError as exc:
            logger.error("Storage directory unavailable while loading common masters", exc_info=True)
            return self._storage_operation_error(exc)
        except Exception:
            logger.exception("Failed to load common masters")
            return {"ok": False, "message": "管理を読み込めませんでした。"}

    def load_calendar(self) -> dict[str, Any]:
        """Return only the shared holiday calendar to every registered user."""
        try:
            if not self._storage_ready:
                return self._storage_unavailable_response()
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            access_denied = self._registered_employee_access_denied(repo)
            if access_denied:
                return access_denied
            return {"ok": True, "calendar": repo.load_calendar_master()}
        except StorageConfigError as exc:
            logger.error("Storage directory unavailable while loading calendar", exc_info=True)
            return self._storage_operation_error(exc)
        except Exception:
            logger.exception("Failed to load calendar")
            return {"ok": False, "message": "カレンダーを読み込めませんでした。"}

    def save_common_master(self, payload: Any) -> dict[str, Any]:
        try:
            if not self._is_admin():
                return self._admin_access_denied()
            access_denied = self._registered_employee_access_denied()
            if access_denied:
                return access_denied
            master, rows, revision = validate_common_master_save_request(payload)
            if master != "calendar":
                raise RequestValidationError(
                    "ユーザー情報はユーザー管理画面から保存してください。"
                )
            if not self._storage_ready:
                return self._storage_unavailable_response()
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            new_revision = repo.save_common_master(
                master, rows, expected_revision=revision
            )
            self._refresh_data_cache_after_management_save("calendar saved")
            return {
                "ok": True,
                "message": "管理を保存しました。",
                "master": master,
                "revision": new_revision,
            }
        except CommonMasterConflictError:
            return {
                "ok": False,
                "conflict": True,
                "message": "別のユーザーが更新しています。再読み込みしてから修正してください。",
            }
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except CsvFileLockedError as exc:
            logger.exception("CSV is locked while saving common master")
            return {"ok": False, "csv_locked": True, "message": str(exc)}
        except CsvReadonlyError as exc:
            logger.exception("Failed to restore common master CSV read-only state")
            return {"ok": False, "csv_readonly": True, "message": str(exc)}
        except StorageConfigError as exc:
            logger.error("Storage directory unavailable while saving common master", exc_info=True)
            return self._storage_operation_error(exc)
        except Exception:
            logger.exception("Failed to save common master")
            return {"ok": False, "message": "管理の保存に失敗しました。"}

    def save_user_administration(self, payload: Any) -> dict[str, Any]:
        try:
            if not self._is_admin():
                return self._admin_access_denied()
            access_denied = self._registered_employee_access_denied()
            if access_denied:
                return access_denied
            if isinstance(payload, dict) and "teams" in payload:
                teams, users, comment_assignments, revisions = (
                    validate_administration_save_request(payload)
                )
            else:
                users, revisions = validate_user_administration_save_request(payload)
                teams = None
                comment_assignments = None
            if not self._storage_ready:
                return self._storage_unavailable_response()
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            self._validate_protected_administrator_changes(repo, users)
            if teams is None:
                validate_user_team_references(
                    users, repo.load_common_masters().get("team_master", [])
                )
            new_revisions = (
                repo.save_administration(
                    teams,
                    users,
                    comment_assignments,
                    revisions,
                )
                if teams is not None
                else repo.save_user_administration(users, revisions)
            )
            self._refresh_data_cache_after_management_save(
                "organization administration saved"
            )
            return {
                "ok": True,
                "message": "組織・ユーザー情報を保存しました。",
                "revisions": new_revisions,
            }
        except CommonMasterConflictError:
            return {
                "ok": False,
                "conflict": True,
                "message": "別のユーザーが更新しています。再読み込みしてから修正してください。",
            }
        except RequestValidationError as exc:
            return self._invalid_request(exc)
        except CsvFileLockedError as exc:
            logger.exception("CSV is locked while saving user administration")
            return {"ok": False, "csv_locked": True, "message": str(exc)}
        except CsvReadonlyError as exc:
            logger.exception("Failed to restore user administration CSV read-only state")
            return {"ok": False, "csv_readonly": True, "message": str(exc)}
        except StorageConfigError as exc:
            logger.error("Storage directory unavailable while saving user administration", exc_info=True)
            return self._storage_operation_error(exc)
        except Exception:
            logger.exception("Failed to save user administration")
            return {"ok": False, "message": "ユーザー管理データの保存に失敗しました。"}

    def save_updates(self, payload: Any) -> dict[str, Any]:
        try:
            user_updates, reply_updates, comment_updates, report_revision = validate_save_request(payload)
            from app.conversations import validate_operations
            conversation_updates = validate_operations(payload.get("conversation_updates", []))
            if not self._storage_ready:
                return self._storage_unavailable_response()
            data_cache = self._get_data_cache()
            common = data_cache.get_save_context(
                self._settings, self._employee_id
            )
            if not any(
                str(row.get("employee_id", "")).strip() == self._employee_id
                for row in common.get("user_master", [])
            ):
                return {**self._employee_access_denied(), "no_targets": False}
            repo = DailyReportRepository(self._settings, self._base_dir)
            repo.validate_paths()
            result = repo.save_updates(
                self._employee_id,
                user_updates,
                comment_updates,
                common=common,
                reply_updates=reply_updates,
                report_revision=report_revision,
                conversation_updates=conversation_updates,
            )
            report_cache = self._cache_partition_result(result.get("user"))
            comment_cache = self._cache_partition_result(result.get("comment"))
            cache_applied: dict[str, bool | None] = {
                "user": None,
                "comment": None,
            }
            cache_sync_failed = False
            for name, partition in (
                ("user", report_cache),
                ("comment", comment_cache),
            ):
                if result.get(name, {}).get("saved") is not True:
                    continue
                if partition is None:
                    cache_applied[name] = False
                    cache_sync_failed = True
                    continue
                try:
                    if name == "user":
                        applied = data_cache.apply_saved_partitions(
                            self._settings,
                            self._employee_id,
                            report_partition=partition,
                            report_revision=result["user"].get("revision"),
                            report_fingerprint=result["user"].get("_cache_fingerprint"),
                        )
                    else:
                        applied = data_cache.apply_saved_partitions(
                            self._settings,
                            self._employee_id,
                            comment_partition=partition,
                        )
                    cache_applied[name] = bool(applied)
                    if not applied:
                        cache_sync_failed = True
                except Exception:
                    cache_applied[name] = False
                    cache_sync_failed = True
                    logger.exception(
                        "Failed to synchronize saved %s CSV into cache", name
                    )
                    data_cache.invalidate_partition(
                        partition[0], "saved partition could not be applied"
                    )
            public_result = {
                name: {
                    key: value
                    for key, value in status.items()
                    if not key.startswith("_cache_")
                }
                for name, status in result.items()
            }
            for name, status in public_result.items():
                if name not in cache_applied:
                    continue
                status["disk_saved"] = result[name].get("saved") is True
                status["cache_applied"] = cache_applied[name]
            targets = [
                value for value in public_result.values() if value.get("needed")
            ]
            lock_failed = any(
                value.get("error_code") == "csv_locked" for value in public_result.values()
            )
            readonly_failed = any(
                value.get("error_code") == "csv_readonly"
                for value in public_result.values()
            )
            review_patch = None
            if (
                result.get("comment", {}).get("saved") is True
                and not conversation_updates
                and not cache_sync_failed
                and payload.get("view_request") is not None
            ):
                try:
                    view_request = validate_load_request(payload["view_request"])
                    review_patch = data_cache.saved_comment_view(
                        self._settings, self._employee_id,
                        [update["subordinate_employee_id"] for update in comment_updates],
                        view_request.get("start_date"), view_request.get("end_date"),
                    )
                except Exception:
                    # A display failure must never turn a completed disk save
                    # into a failed save; the client can reload as a fallback.
                    logger.exception("Failed to build saved comment review patch")
            return {
                "ok": bool(targets) and all(value.get("saved") for value in targets),
                "no_targets": not targets,
                "result": public_result,
                "cache_sync_failed": cache_sync_failed,
                "review_patch": review_patch,
                **{
                    code: True
                    for code in ("report_conflict", "report_format")
                    if any(value.get("error_code") == code for value in public_result.values())
                },
                **({"message": public_result["user"]["error"]}
                   if public_result.get("user", {}).get("error_code") in {"report_conflict", "report_format"} else {}),
                **(
                    {
                        "csv_locked": True,
                        "message": "CSVが使用中です。Excelなどで開いている場合は閉じてから、もう一度保存してください。",
                    }
                    if lock_failed
                    else {
                        "csv_readonly": True,
                        "message": "CSVを読み取り専用に設定できませんでした。",
                    }
                    if readonly_failed
                    else {}
                ),
            }
        except RequestValidationError as exc:
            return {
                **self._invalid_request(exc),
                "no_targets": False,
            }
        except StorageConfigError as exc:
            logger.error(
                "Storage directory unavailable while saving daily report updates",
                exc_info=True,
            )
            return {
                **self._storage_operation_error(exc),
                "no_targets": False,
            }
        except CsvFileLockedError as exc:
            logger.exception("CSV is locked while saving daily report updates")
            return {
                "ok": False,
                "no_targets": False,
                "csv_locked": True,
                "message": str(exc),
            }
        except CsvReadonlyError as exc:
            logger.exception("CSV storage failure while saving daily report updates")
            return {
                "ok": False,
                "no_targets": False,
                "csv_readonly": True,
                "message": str(exc) or "更新処理に失敗しました。",
            }
        except PermissionError:
            logger.warning("Rejected an unauthorized save request", exc_info=True)
            return {
                "ok": False,
                "no_targets": False,
                "message": "この更新を保存する権限がありません。",
            }
        except Exception:
            logger.exception("Failed to save daily report updates")
            return {
                "ok": False,
                "no_targets": False,
                "message": "更新処理に失敗しました。",
            }

    @property
    def _storage_ready(self) -> bool:
        return (
            getattr(self, "_storage_error", None) is None
            and bool(getattr(self._settings, "is_complete", False))
        )

    @staticmethod
    def _default_settings_context() -> dict[str, Any]:
        return {
            "has_comment_targets": False,
            "current_team": [],
            "affiliation_type": "",
            "allowed_member_filter_levels": list(
                DEFAULT_ALLOWED_MEMBER_FILTER_LEVELS
            ),
        }

    def _build_settings_context(
        self,
        *,
        repository: DailyReportRepository | None = None,
        common: dict[str, list[dict[str, Any]]] | None = None,
    ) -> dict[str, Any]:
        """Return the role-scoped controls needed by the settings screen.

        The comment-target check deliberately goes through the same
        ``resolve_view_scope`` path used by daily reports.  This keeps the
        settings screen from inferring permission from a stale or unrelated
        user list.
        """
        context = self._default_settings_context()
        if not self._storage_ready:
            return context

        employee_id = str(getattr(self, "_employee_id", "") or "").strip()
        if not employee_id:
            return context

        try:
            repo = repository or DailyReportRepository(
                self._settings,
                Path(
                    getattr(
                        self,
                        "_base_dir",
                        getattr(self._settings_manager, "base_dir", Path.cwd()),
                    )
                ),
            )
            if common is None:
                data_cache = getattr(self, "_data_cache", None)
                if data_cache is not None and data_cache.is_loaded:
                    common = data_cache.get_common(self._settings, employee_id)
                else:
                    repo.validate_paths()
                    common = repo.load_common_masters()

            scope = repo.resolve_view_scope(common, employee_id)
            current_user = scope.get("current_user") or {}
            user_master = scope.get("user_master") or {}
            assigned_ids = scope.get("assigned_subordinate_ids") or set()
            valid_targets = {
                str(target_id).strip()
                for target_id in assigned_ids
                if str(target_id).strip()
                and str(target_id).strip() != employee_id
                and str(target_id).strip() in user_master
                and user_master[str(target_id).strip()].get("affiliation_type")
                != "director"
                and repo._user_can_input_own_report(
                    user_master[str(target_id).strip()]
                )
            }

            organization_id = str(
                current_user.get("organization_id", "")
            ).strip()
            current_team = repo._team_path(common, organization_id)
            path_levels = [
                str(team.get("team_type", ""))
                for team in current_team
            ]
            affiliation_type = str(
                current_user.get("affiliation_type", "")
            ).strip()
            assignments = common.get("comment_assignment", [])
            teams = {
                str(team.get("team_id", "")): team
                for team in common.get("team_master", [])
            }
            targets_department = any(
                row.get("commenter_employee_id") == employee_id
                and row.get("target_type") == "organization"
                and teams.get(
                    str(row.get("target_organization_ids", "")), {}
                ).get("team_type") == "department"
                for row in assignments
            )
            if repo._is_temporary_user(current_user):
                allowed_levels = []
            elif affiliation_type == "director":
                allowed_levels = list(DEFAULT_ALLOWED_MEMBER_FILTER_LEVELS)
            elif affiliation_type != "organization" or not current_team:
                allowed_levels = []
            elif "section" in path_levels and not targets_department:
                allowed_levels = ["section", "member"]
            else:
                allowed_levels = list(DEFAULT_ALLOWED_MEMBER_FILTER_LEVELS)

            return {
                "has_comment_targets": bool(valid_targets),
                "current_team": current_team,
                "affiliation_type": affiliation_type,
                "allowed_member_filter_levels": allowed_levels,
            }
        except Exception:
            logger.exception("Failed to build settings screen context")
            return context

    @staticmethod
    def _storage_error_message(exc: StorageConfigError) -> str:
        messages = {
            "storage_config_missing": "storage.ini が見つかりません。アプリと同じフォルダに配置してから再起動してください。",
            "storage_config_malformed": "storage.ini の [storage] root_path を確認してください。",
            "storage_root_missing": "storage.ini の保存先ルートが見つかりません。設定を確認して再起動してください。",
            "storage_root_invalid": "storage.ini の root_path にはフォルダを指定してください。",
            "storage_root_inaccessible": "storage.ini の保存先ルートにアクセスできません。",
            "storage_directory_unavailable": "共有ルートの必要なフォルダにアクセスできません（対象: {target}）。",
        }
        template = messages.get(
            exc.code, "保存先を利用できません。storage.ini を確認してください。"
        )
        return template.format(target=exc.target) if "{target}" in template else template

    def _storage_unavailable_response(self) -> dict[str, Any]:
        error = self._storage_error
        if error is None:
            error = StorageConfigError(
                "storage.ini の保存先が未設定です。",
                code="storage_config_missing",
                target="root_path",
            )
        return {
            "ok": False,
            "storage_error": True,
            "storage_error_code": error.code,
            "storage_configured": False,
            "needs_storage_config": True,
            "message": self._storage_error_message(error),
        }

    def _storage_operation_error(self, error: StorageConfigError) -> dict[str, Any]:
        return {
            "ok": False,
            "storage_error": True,
            "storage_error_code": error.code,
            "storage_error_target": error.target,
            "message": self._storage_error_message(error),
        }

    @staticmethod
    def _invalid_request(exc: RequestValidationError) -> dict[str, Any]:
        return {
            "ok": False,
            "message": f"入力内容を確認してください。{exc}",
        }

    @staticmethod
    def _cache_partition_result(
        result: dict[str, Any] | None,
    ) -> tuple[Path, Any] | None:
        if not result or not result.get("saved"):
            return None
        path = result.get("_cache_path")
        frame = result.get("_cache_frame")
        if not path or frame is None:
            return None
        return Path(path), frame

    def _get_data_cache(self) -> DailyReportDataCache:
        cache = getattr(self, "_data_cache", None)
        if cache is None:
            base_dir = getattr(
                self,
                "_base_dir",
                getattr(self._settings_manager, "base_dir", Path.cwd()),
            )
            cache = DailyReportDataCache(Path(base_dir))
            self._data_cache = cache
        return cache

    def _refresh_data_cache_after_management_save(self, reason: str) -> None:
        data_cache = self._get_data_cache()
        if not data_cache.is_loaded:
            return
        try:
            access = data_cache.refresh_changed(
                self._settings, self._employee_id
            )
            if access.refresh_result.failed:
                logger.warning(
                    "Management data saved with deferred cache refresh reason=%s failed=%s",
                    reason,
                    access.refresh_result.failed,
                )
        except Exception:
            logger.exception(
                "Failed to refresh daily-report cache after management save reason=%s",
                reason,
            )
            data_cache.invalidate_all(f"management cache refresh failed: {reason}")

    @staticmethod
    def _admin_access_denied() -> dict[str, Any]:
        return {
            "ok": False,
            "forbidden": True,
            "message": "管理者機能を利用する権限がありません。",
        }

    @staticmethod
    def _employee_access_denied() -> dict[str, Any]:
        return {
            "ok": False,
            "access_denied": True,
            "employee_registered": False,
            "message": UNREGISTERED_EMPLOYEE_MESSAGE,
        }

    def _registered_employee_access_denied(
        self, repo: DailyReportRepository | None = None
    ) -> dict[str, Any] | None:
        if not self._storage_ready:
            return None
        if not self._is_employee_registered(repo):
            return self._employee_access_denied()
        return None

    def _is_employee_registered(
        self, repo: DailyReportRepository | None = None
    ) -> bool:
        return self._current_user_master_row(repo) is not None

    def _current_user_master_row(
        self, repo: DailyReportRepository | None = None
    ) -> dict[str, Any] | None:
        common: dict[str, list[dict[str, Any]]] | None = None
        if repo is None:
            data_cache = getattr(self, "_data_cache", None)
            if data_cache is not None and data_cache.is_loaded:
                common = data_cache.get_common(
                    self._settings, self._employee_id
                )
        repository = repo or DailyReportRepository(self._settings, self._base_dir)
        if repo is None and common is None:
            repository.validate_paths()
        employee_id = str(self._employee_id or "").strip()
        if not employee_id:
            return None
        if common is None:
            common = repository.load_common()
        return next(
            (
                row
                for row in common.get("user_master", [])
                if str(row.get("employee_id", "")).strip() == employee_id
            ),
            None,
        )

    def _is_admin(self) -> bool:
        if not self._storage_ready:
            return False
        try:
            user = self._current_user_master_row()
        except Exception:
            logger.exception("Failed to check administrator permission")
            return False
        return self._user_is_admin(user)

    def _validate_protected_administrator_changes(
        self, repo: DailyReportRepository, users: list[dict[str, Any]]
    ) -> None:
        current_user = self._current_user_master_row(repo)
        if not self._user_is_admin(current_user):
            return
        employee_id = str(self._employee_id or "").strip()
        if not any(
            str(row.get("employee_id", "")).strip() == employee_id for row in users
        ):
            raise RequestValidationError("ログイン中の管理者は削除できません。")

    @staticmethod
    def _user_is_admin(user: dict[str, Any] | None) -> bool:
        return bool(
            user
            and str(user.get("employment_type", "")).strip() == "regular"
            and str(user.get("is_admin", "")).strip() == "1"
        )

    def _validated_font_size(self, value: Any) -> str:
        font_size = str(value or "standard").strip()
        return (
            font_size
            if font_size in {"compact", "standard", "medium", "large", "xlarge"}
            else "standard"
        )

    def _get_employee_id(self) -> str:
        import sys

        # 開発中の場合、デバッグユーザーを選択させる
        if not getattr(sys, "frozen", False):
            try:
                import tkinter as tk
                from tkinter import simpledialog

                root = tk.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                debug_user = simpledialog.askstring(
                    "開発用ログイン",
                    "ユーザーIDを入力してください\n※キャンセル・空白でOSユーザー",
                    parent=root,
                )
                root.destroy()
                if debug_user and debug_user.strip():
                    return debug_user.strip()
            except Exception as e:
                print(f"Failed to show debug login: {e}")

        for getter in (getpass.getuser, lambda: os.environ.get("USERNAME", "")):
            try:
                value = getter()
                if value:
                    return str(value)
            except Exception:
                continue
        return "unknown"

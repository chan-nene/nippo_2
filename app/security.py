from __future__ import annotations

import os
import re
from collections.abc import Mapping
from datetime import date
from pathlib import Path, PureWindowsPath
from typing import Any

from app.calendar_policy import CALENDAR_MIN_DATE
from app.config import COLOR_PALETTES
from app.rich_text import RICH_FIELDS, serialize as serialize_rich_text

MAX_DATE_RANGE_DAYS = 366
MAX_UPDATES_PER_TYPE = 1_000
MAX_TEXT_LENGTH = 20_000
MAX_EMPLOYEE_ID_LENGTH = 128
MAX_PATH_LENGTH = 4_096
MAX_COMMON_MASTER_ROWS = 20_000
MAX_COMMON_FIELD_LENGTH = 20_000
MEMBER_FILTER_LEVELS = frozenset(
    {"department", "section", "member"}
)


COMMON_MASTER_COLUMNS = {
    "user_master": (
        "employee_id",
        "display_name",
        "can_input_own_report",
        "employment_type",
        "is_admin",
        "affiliation_type",
        "organization_id",
        "member_order",
    ),
    "team_master": (
        "team_id",
        "team_name",
        "team_type",
        "parent_team_id",
        "sort_order",
    ),
    "comment_assignment": (
        "commenter_employee_id",
        "target_type",
        "target_organization_ids",
        "target_employee_ids",
    ),
    "calendar": ("date",),
}

USER_MASTER_DEFAULTS = {
    "can_input_own_report": "1",
    "employment_type": "regular",
    "is_admin": "0",
}
USER_EMPLOYMENT_TYPES = frozenset({"regular", "temporary"})

TEAM_TYPES = frozenset({"department", "section"})
AFFILIATION_TYPES = frozenset({"director", "organization", "unassigned"})
COMMENT_TARGET_TYPES = frozenset({"none", "organization", "custom", "departments"})


PERIOD_PRESETS = frozenset(
    {
        "",
        "default",
        "month",
        "week",
        "day",
        "previousWorkday",
        "today",
        "previousWeek",
        "thisWeek",
        "previousMonth",
        "thisMonth",
        "missing",
    }
)

_ISO_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
_INVALID_WINDOWS_FILENAME_CHARS = frozenset('<>:"/\\|?*')


class RequestValidationError(ValueError):
    """An expected rejection of data received from the WebView boundary."""


def require_request_mapping(payload: Any, label: str = "リクエスト") -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        raise RequestValidationError(f"{label}の形式が不正です。")
    return payload


def validate_load_request(payload: Any | None) -> dict[str, Any]:
    if payload is None:
        source: Mapping[str, Any] = {}
    else:
        source = require_request_mapping(payload)
    _reject_unknown_keys(
        source, {"start_date", "end_date", "period_preset", "force_refresh"}
    )

    start_date = _optional_iso_date(source.get("start_date"), "開始日")
    end_date = _optional_iso_date(source.get("end_date"), "終了日")
    if bool(start_date) != bool(end_date):
        raise RequestValidationError("開始日と終了日は両方指定してください。")
    if start_date and end_date:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
        if start > end:
            raise RequestValidationError("開始日は終了日以前にしてください。")
        if (end - start).days + 1 > MAX_DATE_RANGE_DAYS:
            raise RequestValidationError(
                f"表示期間は{MAX_DATE_RANGE_DAYS}日以内にしてください。"
            )

    preset_value = source.get("period_preset")
    if preset_value is None:
        period_preset = None
    elif not isinstance(preset_value, str):
        raise RequestValidationError("表示期間の指定が不正です。")
    else:
        period_preset = preset_value.strip()
        if period_preset == "last7days":
            period_preset = "default"
        if period_preset not in PERIOD_PRESETS:
            raise RequestValidationError("表示期間の指定が不正です。")
        period_preset = period_preset or None

    force_refresh = source.get("force_refresh", False)
    if not isinstance(force_refresh, bool):
        raise RequestValidationError("更新指定が不正です。")

    return {
        "start_date": start_date,
        "end_date": end_date,
        "period_preset": period_preset,
        "force_refresh": force_refresh,
    }


def validate_save_request(
    payload: Any,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], str]:
    """日報・返信・上司コメントを独立した更新として検証する。"""
    source = require_request_mapping(payload)
    _reject_unknown_keys(source, {"user_updates", "reply_updates", "comment_updates", "report_revision", "view_request"})
    if "view_request" in source:
        validate_load_request(source["view_request"])
    user_updates = _validate_update_list(
        source.get("user_updates", []), "日報更新", _validate_user_update
    )
    comment_updates = _validate_update_list(
        source.get("comment_updates", []), "コメント更新", _validate_comment_update
    )
    reply_updates = _validate_update_list(
        source.get("reply_updates", []), "返信更新", _validate_reply_update
    )
    revision = _validate_revision(source.get("report_revision", ""))
    if (user_updates or reply_updates) and not revision:
        raise RequestValidationError("日報の版がありません。最新データを取得してください。")

    _reject_duplicate_values(
        [update["date"] for update in user_updates], "同じ日付の日報更新が重複しています。"
    )
    _reject_duplicate_values(
        [
            (update["subordinate_employee_id"], update["date"])
            for update in comment_updates
        ],
        "同じ対象者・日付のコメント更新が重複しています。",
    )
    _reject_duplicate_values(
        [(update["date"], update["reply_to_employee_id"]) for update in reply_updates],
        "同じ日付・返信先の返信更新が重複しています。",
    )
    return user_updates, reply_updates, comment_updates, revision


def validate_common_master_save_request(
    payload: Any,
) -> tuple[str, list[dict[str, str]], str]:
    source = require_request_mapping(payload, "管理")
    _reject_unknown_keys(source, {"master", "rows", "revision"})
    master = source.get("master")
    if not isinstance(master, str) or master not in COMMON_MASTER_COLUMNS:
        raise RequestValidationError("管理の種類が不正です。")

    row_values = source.get("rows")
    if not isinstance(row_values, list):
        raise RequestValidationError("管理の行データが不正です。")
    if len(row_values) > MAX_COMMON_MASTER_ROWS:
        raise RequestValidationError("管理の件数が多すぎます。")
    columns = COMMON_MASTER_COLUMNS[master]
    rows: list[dict[str, str]] = []
    for index, value in enumerate(row_values):
        row_source = require_request_mapping(value, f"{index + 1}行目")
        _reject_unknown_keys(row_source, set(columns))
        row = {
            column: _bounded_string(
                row_source.get(column, ""),
                f"{index + 1}行目の{column}",
                MAX_COMMON_FIELD_LENGTH,
            ).strip()
            for column in columns
        }
        _validate_common_master_row(master, row, index)
        rows.append(row)

    key_columns = {
        "user_master": ("employee_id",),
        "team_master": ("team_id",),
        "comment_assignment": ("commenter_employee_id",),
        "calendar": ("date",),
    }[master]
    _reject_duplicate_values(
        [tuple(row[column] for column in key_columns) for row in rows],
        "同じキーを持つ行が重複しています。",
    )
    if master == "team_master":
        _validate_team_hierarchy(rows)
    if master == "user_master":
        _require_regular_administrator(rows)
    revision = _bounded_string(source.get("revision", ""), "データの版", 128)
    if revision and revision != "missing" and not re.fullmatch(r"[0-9a-f]{64}", revision):
        raise RequestValidationError("データの版が不正です。")
    return master, rows, revision


def validate_administration_save_request(
    payload: Any,
) -> tuple[Any, ...]:
    source = require_request_mapping(payload, "組織・ユーザー管理")
    _reject_unknown_keys(source, {"teams", "users", "comment_assignments", "revisions"})
    revisions_source = require_request_mapping(
        source.get("revisions", {}), "データの版"
    )
    _reject_unknown_keys(
        revisions_source, {"team_master", "user_master", "comment_assignment"}
    )

    _, teams, team_revision = validate_common_master_save_request(
        {
            "master": "team_master",
            "rows": source.get("teams", []),
            "revision": revisions_source.get("team_master", ""),
        }
    )
    _, users, user_revision = validate_common_master_save_request(
        {
            "master": "user_master",
            "rows": source.get("users", []),
            "revision": revisions_source.get("user_master", ""),
        }
    )
    _require_regular_administrator(users)
    _, assignments, assignment_revision = validate_common_master_save_request(
        {
            "master": "comment_assignment",
            "rows": source.get("comment_assignments", []),
            "revision": revisions_source.get("comment_assignment", ""),
        }
    )

    validate_user_team_references(users, teams, assignments)
    teams = _normalize_team_sort_orders(teams)
    users = _normalize_user_member_orders(users, teams)
    assignments = _normalize_comment_assignments(assignments, users)

    return (
        teams,
        users,
        assignments,
        {
            "team_master": team_revision,
            "user_master": user_revision,
            "comment_assignment": assignment_revision,
        },
    )


def validate_user_team_references(
    users: list[dict[str, str]],
    teams: list[dict[str, str]],
    assignments: list[dict[str, str]] | None = None,
) -> None:
    _validate_new_administration_references(users, teams, assignments or [])


def _validate_new_administration_references(
    users: list[dict[str, str]],
    teams: list[dict[str, str]],
    assignments: list[dict[str, str]],
) -> None:
    teams_by_id = {str(row.get("team_id", "")): row for row in teams}
    users_by_id = {str(row.get("employee_id", "")): row for row in users}
    for index, user in enumerate(users):
        affiliation_type = user.get("affiliation_type", "")
        organization_id = user.get("organization_id", "")
        if affiliation_type == "director":
            if organization_id:
                raise RequestValidationError(
                    f"{index + 1}人目の部長には所属組織を指定できません。"
                )
            if user.get("can_input_own_report") != "0":
                raise RequestValidationError(
                    f"{index + 1}人目の部長は日報入力不可にしてください。"
                )
            continue
        if affiliation_type == "unassigned":
            if organization_id:
                raise RequestValidationError(
                    f"{index + 1}人目の所属登録なしユーザーには所属組織を指定できません。"
                )
            continue
        if affiliation_type != "organization":
            raise RequestValidationError(
                f"{index + 1}人目の所属区分が不正です。"
            )
        if not organization_id:
            raise RequestValidationError(
                f"{index + 1}人目の所属組織を指定してください。"
            )
        team = teams_by_id.get(organization_id)
        if team is None:
            raise RequestValidationError(
                f"{index + 1}人目の所属組織が組織マスターにありません。"
            )
        if team.get("team_type") not in TEAM_TYPES:
            raise RequestValidationError(f"{index + 1}人目の所属組織が不正です。")

    for index, assignment in enumerate(assignments):
        _validate_comment_assignment_references(
            assignment, index, users_by_id, teams_by_id
        )

def validate_user_administration_save_request(
    payload: Any,
) -> tuple[list[dict[str, str]], dict[str, str]]:
    source = require_request_mapping(payload, "ユーザー管理")
    _reject_unknown_keys(source, {"users", "revisions"})
    revisions_source = require_request_mapping(
        source.get("revisions", {}), "データの版"
    )
    _reject_unknown_keys(revisions_source, {"user_master"})

    _, users, user_revision = validate_common_master_save_request(
        {
            "master": "user_master",
            "rows": source.get("users"),
            "revision": revisions_source.get("user_master", ""),
        }
    )
    _require_regular_administrator(users)
    return (
        users,
        {"user_master": user_revision},
    )


def _require_regular_administrator(users: list[dict[str, str]]) -> None:
    if not any(
        row.get("employment_type") == "regular" and row.get("is_admin") == "1"
        for row in users
    ):
        raise RequestValidationError("少なくとも1人の正社員の管理者が必要です。")


def _validate_common_master_row(
    master: str, row: dict[str, str], index: int
) -> None:
    label = f"{index + 1}行目"
    employee_columns = {
        "user_master": ("employee_id",),
    }.get(master, ())
    for column in employee_columns:
        try:
            validate_employee_id(row[column], f"{label}の社員ID")
        except ValueError as exc:
            raise RequestValidationError(str(exc)) from exc

    if master == "user_master" and not row["display_name"]:
        raise RequestValidationError(f"{label}の表示名を入力してください。")
    if master == "user_master":
        for column, default in USER_MASTER_DEFAULTS.items():
            if not row[column]:
                row[column] = default
        if row["can_input_own_report"] not in {"0", "1"}:
            raise RequestValidationError(
                f"{label}の自分の日報入力フラグが不正です。"
            )
        if row["employment_type"] not in USER_EMPLOYMENT_TYPES:
            raise RequestValidationError(f"{label}の雇用区分が不正です。")
        if row["is_admin"] not in {"0", "1"}:
            raise RequestValidationError(f"{label}の管理者フラグが不正です。")
        if row["employment_type"] == "temporary" and row["is_admin"] == "1":
            raise RequestValidationError(f"{label}の派遣社員は管理者に設定できません。")
        if row["affiliation_type"] not in AFFILIATION_TYPES:
            raise RequestValidationError(f"{label}の所属区分が不正です。")
        if row["affiliation_type"] == "director":
            if row["organization_id"]:
                raise RequestValidationError(f"{label}の部長には所属組織を指定できません。")
            if row["can_input_own_report"] != "0":
                raise RequestValidationError(f"{label}の部長は日報入力不可にしてください。")
        elif row["affiliation_type"] == "unassigned":
            if row["organization_id"]:
                raise RequestValidationError(
                    f"{label}の所属登録なしユーザーには所属組織を指定できません。"
                )
        elif not row["organization_id"]:
            raise RequestValidationError(f"{label}の所属組織を指定してください。")
        _validate_optional_order(row["member_order"], f"{label}の表示順")
    if master == "team_master":
        if not row["team_id"] or not row["team_name"]:
            raise RequestValidationError(f"{label}の組織IDと名称を入力してください。")
        _validate_organization_id(row["team_id"], f"{label}の組織ID")
        if row["team_type"] not in TEAM_TYPES:
            raise RequestValidationError(f"{label}の組織種別が不正です。")
        _validate_optional_order(row["sort_order"], f"{label}の表示順")
    if master == "comment_assignment":
        try:
            validate_employee_id(row["commenter_employee_id"], f"{label}のコメント担当者ID")
        except ValueError as exc:
            raise RequestValidationError(str(exc)) from exc
        if row["target_type"] not in COMMENT_TARGET_TYPES:
            raise RequestValidationError(f"{label}のコメント対象方式が不正です。")
        _parse_id_list(row["target_organization_ids"], f"{label}の対象組織ID")
        _parse_id_list(row["target_employee_ids"], f"{label}の対象社員ID", employee_ids=True)
    if master == "calendar":
        calendar_date = date.fromisoformat(
            _required_iso_date(row["date"], f"{label}の日付")
        )
        if calendar_date < CALENDAR_MIN_DATE:
            raise RequestValidationError(
                f"{label}の日付は{CALENDAR_MIN_DATE.isoformat()}以降にしてください。"
            )


def _validate_identifier(value: str, label: str) -> str:
    if not value or value != value.strip() or ";" in value:
        raise RequestValidationError(f"{label}が不正です。")
    if any(ord(character) < 32 for character in value):
        raise RequestValidationError(f"{label}が不正です。")
    return value


def _validate_organization_id(value: str, label: str) -> str:
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise RequestValidationError(f"{label}は1以上の整数で指定してください。")
    return value


def _parse_id_list(value: str, label: str, *, employee_ids: bool = False) -> list[str]:
    if any(character in value for character in (",", "\n", "\r", "\t")):
        raise RequestValidationError(f"{label}の区切りが不正です。")
    values: list[str] = []
    for raw in value.split(";"):
        item = raw.strip()
        if not item:
            if raw or value.endswith(";") or value.startswith(";") or ";;" in value:
                raise RequestValidationError(f"{label}が不正です。")
            continue
        try:
            if employee_ids:
                item = validate_employee_id(item, label)
            else:
                item = _validate_identifier(item, label)
        except ValueError as exc:
            raise RequestValidationError(str(exc)) from exc
        if item not in values:
            values.append(item)
    return values


def _validate_optional_order(value: str, label: str) -> None:
    if value and (not value.isdigit() or not 0 <= int(value) <= 999999):
        raise RequestValidationError(f"{label}が不正です。")


def _validate_team_hierarchy(rows: list[dict[str, str]]) -> None:
    teams = {row["team_id"]: row for row in rows}
    sibling_names: set[tuple[str, str]] = set()
    for row in rows:
        team_id = row["team_id"]
        team_type = row["team_type"]
        parent_id = row["parent_team_id"]
        team_name = row["team_name"]
        _validate_organization_id(team_id, f"組織「{team_name}」の組織ID")
        if parent_id:
            _validate_organization_id(parent_id, f"組織「{team_name}」の親係ID")
        sibling_key = (parent_id, team_name.casefold())
        if sibling_key in sibling_names:
            location = "最上位" if not parent_id else f"「{teams.get(parent_id, {}).get('team_name', parent_id)}」の直下"
            raise RequestValidationError(
                f"{location}に同じチーム名「{team_name}」を複数登録できません。"
            )
        sibling_names.add(sibling_key)

        if not parent_id:
            if team_type != "department":
                raise RequestValidationError(
                    f"チーム「{team_name}」には親の係を指定してください。"
                )
            continue
        parent = teams.get(parent_id)
        if parent is None:
            raise RequestValidationError(
                f"チーム「{team_name}」の親チームが見つかりません。"
            )
        if team_type != "section" or parent["team_type"] != "department":
            raise RequestValidationError(
                f"チーム「{team_name}」の親組織には係を指定してください。"
            )


def _validate_comment_assignment_references(
    assignment: dict[str, str],
    index: int,
    users: dict[str, dict[str, str]],
    teams: dict[str, dict[str, str]],
) -> None:
    label = f"{index + 1}件目"
    commenter_id = assignment["commenter_employee_id"]
    commenter = users.get(commenter_id)
    if commenter is None:
        raise RequestValidationError(f"{label}のコメント担当者がユーザーマスターにありません。")
    target_type = assignment["target_type"]
    if commenter.get("employment_type") == "temporary" and target_type != "none":
        raise RequestValidationError(f"{label}のコメント担当者に派遣社員は設定できません。")

    if commenter.get("affiliation_type") == "unassigned" and target_type != "none":
        raise RequestValidationError(f"{label}の所属登録なしのユーザーはコメント担当者に設定できません。")

    organization_ids = _parse_id_list(
        assignment["target_organization_ids"], f"{label}の対象組織ID"
    )
    employee_ids = _parse_id_list(
        assignment["target_employee_ids"], f"{label}の対象社員ID", employee_ids=True
    )
    assignment["target_organization_ids"] = ";".join(organization_ids)
    assignment["target_employee_ids"] = ";".join(employee_ids)

    if target_type == "none":
        if organization_ids or employee_ids:
            raise RequestValidationError(f"{label}の対象なし設定に対象IDは保存できません。")
        return
    if target_type == "organization":
        if len(organization_ids) != 1 or employee_ids:
            raise RequestValidationError(f"{label}の係・チーム指定は1組織だけ指定してください。")
        if commenter.get("affiliation_type") != "organization":
            raise RequestValidationError(
                f"{label}の係・チーム指定は組織所属ユーザーだけが使用できます。"
            )
        allowed = _allowed_comment_organizations(commenter, teams)
        if organization_ids[0] not in allowed:
            raise RequestValidationError(f"{label}の対象組織が所属範囲外です。")
        return
    if target_type == "departments":
        if commenter.get("affiliation_type") != "director" or not organization_ids or employee_ids:
            raise RequestValidationError(f"{label}の複数係指定は部長だけが使用できます。")
        if any(teams.get(team_id, {}).get("team_type") != "department" for team_id in organization_ids):
            raise RequestValidationError(f"{label}の複数係指定には係だけを指定してください。")
        return
    if target_type != "custom" or not (organization_ids or employee_ids):
        raise RequestValidationError(f"{label}の個別指定が不正です。")
    if commenter.get("affiliation_type") != "organization":
        raise RequestValidationError(
            f"{label}の個別指定は組織所属ユーザーだけが使用できます。"
        )
    allowed_users = _allowed_custom_target_ids(commenter, users, teams)
    parent_id = commenter.get("organization_id", "")
    allowed_teams = {
        tid for tid, team in teams.items()
        if teams.get(parent_id, {}).get("team_type") == "department"
        and team.get("team_type") == "section"
        and team.get("parent_team_id") == parent_id
    }
    if any(tid not in allowed_teams for tid in organization_ids):
        raise RequestValidationError(f"{label}の対象チームが所属係の配下ではありません。")
    for target_id in employee_ids:
        target = users.get(target_id)
        if target is None:
            raise RequestValidationError(f"{label}の対象ユーザーがユーザーマスターにありません。")
        if target_id == commenter_id:
            raise RequestValidationError(f"{label}では自分自身を対象にできません。")
        if target_id not in allowed_users:
            raise RequestValidationError(f"{label}の対象ユーザーが所属範囲外です。")
        if target.get("affiliation_type") == "director" or target.get("can_input_own_report") != "1":
            raise RequestValidationError(f"{label}の日報入力不可ユーザーは対象にできません。")


def _allowed_comment_organizations(
    commenter: dict[str, str], teams: dict[str, dict[str, str]]
) -> set[str]:
    organization_id = commenter.get("organization_id", "")
    organization = teams.get(organization_id, {})
    if organization.get("team_type") == "section":
        return {organization_id, organization.get("parent_team_id", "")} - {""}
    if organization.get("team_type") == "department":
        return {
            organization_id,
            *(
                team_id
                for team_id, team in teams.items()
                if team.get("team_type") == "section"
                and team.get("parent_team_id") == organization_id
            ),
        }
    return set()


def _allowed_custom_target_ids(
    commenter: dict[str, str],
    users: dict[str, dict[str, str]],
    teams: dict[str, dict[str, str]],
) -> set[str]:
    organization_id = commenter.get("organization_id", "")
    organization = teams.get(organization_id, {})
    allowed_organizations = {organization_id}
    return {
        employee_id
        for employee_id, user in users.items()
        if employee_id != commenter.get("employee_id")
        and user.get("affiliation_type") == "organization"
        and user.get("organization_id") in allowed_organizations
        and user.get("can_input_own_report") == "1"
    }


def _order_value(value: str) -> int:
    return int(value) if str(value).isdigit() else 999999


def _normalize_team_sort_orders(
    teams: list[dict[str, str]],
) -> list[dict[str, str]]:
    normalized = [dict(row) for row in teams]
    for parent_id in {row.get("parent_team_id", "") for row in normalized}:
        siblings = sorted(
            (row for row in normalized if row.get("parent_team_id", "") == parent_id),
            key=lambda row: (
                _order_value(row.get("sort_order", "")),
                row.get("team_name", ""),
                row.get("team_id", ""),
            ),
        )
        for position, row in enumerate(siblings, 1):
            row["sort_order"] = str(position * 10)
    return normalized


def _normalize_user_member_orders(
    users: list[dict[str, str]], teams: list[dict[str, str]]
) -> list[dict[str, str]]:
    normalized = [dict(row) for row in users]
    group_keys = {
        "director" if row.get("affiliation_type") == "director" else row.get("organization_id", "")
        for row in normalized
    }
    for group_key in group_keys:
        siblings = sorted(
            (
                row
                for row in normalized
                if (
                    "director"
                    if row.get("affiliation_type") == "director"
                    else row.get("organization_id", "")
                )
                == group_key
            ),
            key=lambda row: (
                _order_value(row.get("member_order", "")),
                row.get("display_name", ""),
                row.get("employee_id", ""),
            ),
        )
        for position, row in enumerate(siblings, 1):
            row["member_order"] = str(position * 10)
    return normalized


def _normalize_comment_assignments(
    assignments: list[dict[str, str]], users: list[dict[str, str]]
) -> list[dict[str, str]]:
    by_commenter = {row["commenter_employee_id"]: dict(row) for row in assignments}
    return [
        by_commenter.get(
            user["employee_id"],
            {
                "commenter_employee_id": user["employee_id"],
                "target_type": "none",
                "target_organization_ids": "",
                "target_employee_ids": "",
            },
        )
        for user in users
    ]


def _validate_revision(value: Any) -> str:
    revision = _bounded_string(value, "データの版", 128)
    if revision and revision != "missing" and not re.fullmatch(r"[0-9a-f]{64}", revision):
        raise RequestValidationError("データの版が不正です。")
    return revision

def validate_employee_id(value: Any, label: str = "社員ID") -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label}が不正です。")
    employee_id = value.strip()
    if employee_id != value or not employee_id:
        raise ValueError(f"{label}が不正です。")
    if len(employee_id) > MAX_EMPLOYEE_ID_LENGTH:
        raise ValueError(f"{label}が長すぎます。")
    if employee_id in {".", ".."} or employee_id[-1] in {".", " "}:
        raise ValueError(f"{label}が不正です。")
    if any(
        ord(character) < 32 or character in _INVALID_WINDOWS_FILENAME_CHARS
        for character in employee_id
    ):
        raise ValueError(f"{label}が不正です。")
    filename = f"{employee_id}.csv"
    is_reserved = getattr(os.path, "isreserved", None)
    if (
        is_reserved(filename)
        if is_reserved is not None
        else PureWindowsPath(filename).is_reserved()
    ):
        raise ValueError(f"{label}が不正です。")
    return employee_id


def safe_employee_csv_path(directory: Path | str, employee_id: Any) -> Path:
    root = Path(directory).resolve()
    safe_id = validate_employee_id(employee_id)
    candidate = (root / f"{safe_id}.csv").resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("社員IDから安全な保存先を作成できません。") from exc
    return candidate


def validate_settings_request(payload: Any) -> Mapping[str, Any]:
    source = require_request_mapping(payload, "設定")
    _reject_unknown_keys(
        source,
        {
            "default_start_offset_days",
            "default_end_offset_days",
            "missing_comment_start_date",
            "include_today_in_missing_comments",
            "include_empty_report_days_in_missing_comments",
            "comment_signature",
            "ui_color_theme",
            "ui_color_palette",
            "ui_member_filter_levels",
        },
    )
    _bounded_string(source.get("comment_signature", ""), "サイン", 100)
    _optional_iso_date(
        source.get("missing_comment_start_date"), "未コメント確認の開始日"
    )
    _bounded_int(source.get("default_start_offset_days", -2), -14, 0, "開始日")
    _bounded_int(source.get("default_end_offset_days", 0), 0, 7, "終了日")
    include_today = source.get("include_today_in_missing_comments", False)
    if not isinstance(include_today, bool):
        raise RequestValidationError("当日を含める設定が不正です。")
    include_empty_report_days = source.get(
        "include_empty_report_days_in_missing_comments", True
    )
    if not isinstance(include_empty_report_days, bool):
        raise RequestValidationError("日報未記入日を含める設定が不正です。")
    color_theme = source.get("ui_color_theme", "light")
    if not isinstance(color_theme, str) or color_theme not in {"light", "dark"}:
        raise RequestValidationError("配色の指定が不正です。")
    color_palette = source.get("ui_color_palette", "blue")
    if not isinstance(color_palette, str) or color_palette not in COLOR_PALETTES:
        raise RequestValidationError("カラーパレットの指定が不正です。")
    member_filter_levels = source.get(
        "ui_member_filter_levels", []
    )
    if (
        not isinstance(member_filter_levels, list)
        or len(member_filter_levels) > len(MEMBER_FILTER_LEVELS)
        or any(
            not isinstance(level, str) or level not in MEMBER_FILTER_LEVELS
            for level in member_filter_levels
        )
        or len(set(member_filter_levels)) != len(member_filter_levels)
    ):
        raise RequestValidationError("フィルタボタンの表示設定が不正です。")
    return source


def validate_ui_state_request(payload: Any) -> Mapping[str, Any]:
    source = require_request_mapping(payload, "表示状態")
    _reject_unknown_keys(
        source,
        {
            "period_preset",
            "start_date",
            "end_date",
            "font_size",
            "column_widths",
            "ui_color_theme",
            "ui_color_palette",
        },
    )
    validate_load_request(
        {
            "period_preset": source.get("period_preset"),
            "start_date": source.get("start_date"),
            "end_date": source.get("end_date"),
        }
    )
    font_size = source.get("font_size", "standard")
    if not isinstance(font_size, str) or font_size not in {
        "compact",
        "standard",
        "medium",
        "large",
        "xlarge",
    }:
        raise RequestValidationError("文字サイズの指定が不正です。")
    color_theme = source.get("ui_color_theme", "light")
    if not isinstance(color_theme, str) or color_theme not in {"light", "dark"}:
        raise RequestValidationError("配色の指定が不正です。")
    color_palette = source.get("ui_color_palette", "blue")
    if not isinstance(color_palette, str) or color_palette not in COLOR_PALETTES:
        raise RequestValidationError("カラーパレットの指定が不正です。")
    column_widths = source.get("column_widths", {})
    if not isinstance(column_widths, Mapping) or len(column_widths) > 64:
        raise RequestValidationError("列幅の表示状態が不正です。")
    for column_id, width in column_widths.items():
        if (
            not isinstance(column_id, str)
            or not column_id
            or len(column_id) > 256
            or any(ord(character) < 32 for character in column_id)
        ):
            raise RequestValidationError("列幅の列指定が不正です。")
        if (
            isinstance(width, bool)
            or not isinstance(width, (int, float))
            or not 40 <= width <= 1000
        ):
            raise RequestValidationError("列幅の値が不正です。")
    return source


def _validate_update_list(value: Any, label: str, validator: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise RequestValidationError(f"{label}の形式が不正です。")
    if len(value) > MAX_UPDATES_PER_TYPE:
        raise RequestValidationError(f"{label}の件数が多すぎます。")
    return [validator(item, index) for index, item in enumerate(value)]


def _validate_user_update(value: Any, index: int) -> dict[str, Any]:
    source = require_request_mapping(value, f"日報更新{index + 1}件目")
    _reject_unknown_keys(source, {"date", "business_name", "business_detail", "business_name_rich_text", "business_detail_rich_text"})
    if "date" not in source:
        raise RequestValidationError("日報更新の日付がありません。")
    if not any(key in source for key in ("business_name_rich_text", "business_detail_rich_text")):
        raise RequestValidationError("日報更新の内容がありません。")

    update: dict[str, Any] = {"date": _required_iso_date(source["date"], "日報の日付")}
    for key, label in (
        ("business_name", "業務名"),
        ("business_detail", "業務内容"),
    ):
        if key in source or RICH_FIELDS[key] in source:
            update.update(_validate_rich_pair(source, key, label))

    return update


def _validate_reply_update(value: Any, index: int) -> dict[str, Any]:
    """本人の返信先・対象日・本文を検証し、空文字による削除も受け入れる。"""
    source = require_request_mapping(value, f"返信更新{index + 1}件目")
    required = {"date", "reply_to_employee_id", "reply_rich_text"}
    _reject_unknown_keys(source, required | {"reply_text"})
    if not required.issubset(source):
        raise RequestValidationError("返信の必須項目がありません。")
    try:
        target = validate_employee_id(source["reply_to_employee_id"], "返信先の社員ID")
    except ValueError as exc:
        raise RequestValidationError(str(exc)) from exc
    return {
        "date": _required_iso_date(source["date"], "返信対象の日付"),
        "reply_to_employee_id": target,
        **_validate_rich_pair(source, "reply_text", "返信本文"),
    }


def _validate_comment_update(value: Any, index: int) -> dict[str, Any]:
    source = require_request_mapping(value, f"コメント更新{index + 1}件目")
    _reject_unknown_keys(source, {"subordinate_employee_id", "date", "comment", "comment_rich_text"})
    if not all(key in source for key in ("subordinate_employee_id", "date", "comment_rich_text")):
        raise RequestValidationError("コメント更新の必須項目がありません。")
    try:
        subordinate_id = validate_employee_id(
            source["subordinate_employee_id"], "コメント対象者ID"
        )
    except ValueError as exc:
        raise RequestValidationError(str(exc)) from exc
    return {
        "subordinate_employee_id": subordinate_id,
        "date": _required_iso_date(source["date"], "コメントの日付"),
        **_validate_rich_pair(source, "comment", "コメント"),
    }


def _validate_rich_pair(source: Mapping[str, Any], field: str, label: str) -> dict[str, str]:
    try:
        rich, plain = serialize_rich_text(source.get(RICH_FIELDS[field]))
        if field in source and _bounded_string(source[field], label, MAX_TEXT_LENGTH) != plain:
            raise ValueError(f"{label}の文章と書式データが一致しません。")
        return {field: plain, RICH_FIELDS[field]: rich}
    except ValueError as exc:
        raise RequestValidationError(str(exc)) from exc


def _bounded_string(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise RequestValidationError(f"{label}は文字列で指定してください。")
    if len(value) > maximum:
        raise RequestValidationError(f"{label}が長すぎます。")
    return value


def _bounded_int(value: Any, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool):
        raise RequestValidationError(f"{label}の指定が不正です。")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise RequestValidationError(f"{label}の指定が不正です。") from exc
    if str(number) != str(value).strip() or not minimum <= number <= maximum:
        raise RequestValidationError(f"{label}の指定が範囲外です。")
    return number


def _strict_int(value: Any, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RequestValidationError(f"{label}が不正です。")
    if not minimum <= value <= maximum:
        raise RequestValidationError(f"{label}が範囲外です。")
    return value


def _optional_iso_date(value: Any, label: str) -> str | None:
    if value is None or value == "":
        return None
    return _required_iso_date(value, label)


def _required_iso_date(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ISO_DATE_PATTERN.fullmatch(value):
        raise RequestValidationError(f"{label}が不正です。")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise RequestValidationError(f"{label}が不正です。") from exc
    return parsed.isoformat()


def _reject_unknown_keys(source: Mapping[str, Any], allowed: set[str]) -> None:
    if any(not isinstance(key, str) or key not in allowed for key in source):
        raise RequestValidationError("未対応の入力項目が含まれています。")


def _reject_duplicate_values(values: list[Any], message: str) -> None:
    if len(values) != len(set(values)):
        raise RequestValidationError(message)

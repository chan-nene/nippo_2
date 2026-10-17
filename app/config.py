from __future__ import annotations

from collections.abc import Mapping
from configparser import ConfigParser, Error as ConfigParserError
from dataclasses import asdict, dataclass, fields
import os
import tempfile
from threading import RLock
from pathlib import Path
from typing import Any


COLOR_THEMES = frozenset({"light", "dark"})
COLOR_PALETTES = frozenset({"default", "blue", "blue_white"})
MEMBER_FILTER_LEVELS = ("department", "section", "member")
DEFAULT_MEMBER_FILTER_LEVELS = "auto"

# Paths used by the application are deliberately not configurable one by one.
# They are children of the single root in ``storage.ini``.  Keep these names in
# one module so the repository, cache, validation and API cannot drift apart.
STORAGE_DIRECTORY_NAMES = {
    "common": "common_data",
    "comments": "supervisor_comments",
    "regular_reports": "regular_employee_reports",
    "temporary_reports": "temporary_employee_reports",
}
STORAGE_INI_FILENAME = "storage.ini"
SETTINGS_INI_FILENAME = "settings.ini"


class StorageConfigError(RuntimeError):
    """A storage.ini or fixed storage directory is not usable.

    ``target`` is intentionally retained separately from the user-facing
    message: raw paths belong in the log, while API responses can identify the
    failed storage target without exposing the complete path.
    """

    def __init__(
        self, message: str, *, code: str = "invalid_storage", target: str = ""
    ) -> None:
        super().__init__(message)
        self.code = code
        self.target = target


def to_int(value: Any, default: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def to_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def normalize_color_theme(value: Any, default: str = "light") -> str:
    fallback = default if default in COLOR_THEMES else "light"
    color_theme = str(value or "").strip().lower()
    return color_theme if color_theme in COLOR_THEMES else fallback


def normalize_color_palette(value: Any, default: str = "blue") -> str:
    fallback = default if default in COLOR_PALETTES else "blue"
    color_palette = str(value or "").strip().lower()
    return color_palette if color_palette in COLOR_PALETTES else fallback


def normalize_color_appearance(
    theme: Any,
    palette: Any,
    *,
    theme_default: str = "light",
    palette_default: str = "blue",
) -> tuple[str, str]:
    """Normalize the persisted theme/palette pair."""
    normalized_theme = normalize_color_theme(theme, theme_default)
    normalized_palette = normalize_color_palette(palette, palette_default)
    return normalized_theme, normalized_palette


def normalize_member_filter_levels(
    value: Any, default: str = DEFAULT_MEMBER_FILTER_LEVELS
) -> str:
    # Missing settings use role defaults; an explicit empty value remains all-off.
    if value == "auto" or (value is None and default == "auto"):
        return "auto"

    def parse_levels(raw: Any) -> list[str]:
        if isinstance(raw, (list, tuple, set)):
            values = [str(item).strip() for item in raw]
        else:
            values = [item.strip() for item in str(raw or "").replace(";", ",").split(",")]
        return values

    fallback = [
        level for level in MEMBER_FILTER_LEVELS if level in parse_levels(default)
    ]
    if value is None:
        return ",".join(fallback)
    raw_levels = parse_levels(value)
    normalized = [
        level for level in MEMBER_FILTER_LEVELS if level in raw_levels
    ]
    if normalized or not any(raw_levels):
        return ",".join(normalized)
    return ",".join(fallback)


@dataclass
class AppSettings:
    # ``root_path`` is populated from storage.ini by the API.  It is kept on
    # AppSettings as a resolved runtime value so existing service code can
    # receive one settings object, but SettingsManager never persists it to
    # settings.ini.
    root_path: str = ""
    default_start_offset_days: int = -2
    default_end_offset_days: int = 0
    missing_comment_start_date: str = ""
    include_today_in_missing_comments: bool = False
    include_empty_report_days_in_missing_comments: bool = True
    comment_signature: str = ""
    ui_show_holidays: bool = True
    ui_period_preset: str = "default"
    ui_start_date: str = ""
    ui_end_date: str = ""
    ui_font_size: str = "standard"
    ui_column_widths: str = ""
    ui_color_theme: str = "light"
    ui_color_palette: str = "blue"
    ui_member_filter_levels: str = DEFAULT_MEMBER_FILTER_LEVELS

    @property
    def is_complete(self) -> bool:
        return bool(self.root_path)

    @property
    def storage_root(self) -> Path:
        """Return the configured storage root without creating it."""
        return Path(self.root_path)

    def storage_dir(self, kind: str) -> Path:
        """Resolve one of the fixed application storage directories."""
        if kind not in STORAGE_DIRECTORY_NAMES:
            raise KeyError(f"Unknown storage directory kind: {kind}")
        return self.storage_root / STORAGE_DIRECTORY_NAMES[kind]

    @property
    def fixed_storage_dirs(self) -> dict[str, Path]:
        return {
            kind: self.storage_dir(kind) for kind in STORAGE_DIRECTORY_NAMES
        }

    @classmethod
    def from_mapping(cls, source: Mapping[str, Any]) -> AppSettings:
        defaults = cls()
        values: dict[str, Any] = {}
        for field in fields(cls):
            if field.name == "root_path":
                # Path configuration belongs exclusively to storage.ini.  Do
                # not let a stale [database] section reintroduce it.
                continue
            default = getattr(defaults, field.name)
            raw_value = source.get(field.name, default)
            if field.name == "ui_color_theme":
                values[field.name] = normalize_color_theme(raw_value, default)
            elif field.name == "ui_color_palette":
                values[field.name] = normalize_color_palette(raw_value, default)
            elif field.name == "ui_member_filter_levels":
                values[field.name] = normalize_member_filter_levels(raw_value, default)
            elif isinstance(default, bool):
                values[field.name] = to_bool(raw_value, default)
            elif isinstance(default, int):
                values[field.name] = to_int(raw_value, default)
            else:
                values[field.name] = (
                    "" if raw_value is None else str(raw_value).strip()
                )
        values["ui_color_theme"], values["ui_color_palette"] = (
            normalize_color_appearance(
                values["ui_color_theme"],
                values["ui_color_palette"],
                theme_default=defaults.ui_color_theme,
                palette_default=defaults.ui_color_palette,
            )
        )
        return cls(**values)

    def to_dict(self) -> dict[str, Any]:
        values = asdict(self)
        values.pop("root_path", None)
        return values


STORAGE_DIRECTORY_LABELS = {
    "common": "共通情報フォルダ",
    "comments": "上司コメントフォルダ",
    "regular_reports": "正社員日報フォルダ",
    "temporary_reports": "派遣社員日報フォルダ",
}


def validate_storage_directories(
    settings: AppSettings,
    *,
    required_kinds: set[str] | frozenset[str] | None = None,
    require_write: bool = False,
) -> dict[str, str]:
    """Validate only the fixed directories needed by the current operation.

    The caller supplies ``required_kinds`` after common/user data has been
    loaded.  In particular, a temporary employee must not probe the regular
    report directory, so that directory is not part of the default set.
    """
    required = set(required_kinds or {"common", "comments"})
    errors: dict[str, str] = {}
    if not settings.root_path:
        errors["storage_root"] = "storage.ini の [storage] root_path が未設定です。"
        return errors
    root = settings.storage_root
    try:
        if not root.exists():
            errors["storage_root"] = "保存先のルートフォルダが見つかりません。"
        elif not root.is_dir():
            errors["storage_root"] = "保存先のルートパスにはフォルダを指定してください。"
        elif not os_access(root, write=require_write):
            errors["storage_root"] = "保存先のルートフォルダにアクセスできません。"
    except OSError:
        errors["storage_root"] = "保存先のルートフォルダにアクセスできません。"
    if errors.get("storage_root"):
        return errors
    for kind in required:
        if kind not in STORAGE_DIRECTORY_NAMES:
            raise KeyError(f"Unknown storage directory kind: {kind}")
        path = settings.storage_dir(kind)
        label = STORAGE_DIRECTORY_LABELS[kind]
        try:
            if not path.exists():
                errors[kind] = f"{label} ({STORAGE_DIRECTORY_NAMES[kind]}) が見つかりません。"
            elif not path.is_dir():
                errors[kind] = f"{label} ({STORAGE_DIRECTORY_NAMES[kind]}) にはフォルダを指定してください。"
            elif not os_access(path, write=require_write):
                errors[kind] = f"{label} ({STORAGE_DIRECTORY_NAMES[kind]}) にアクセスできません。"
        except OSError:
            errors[kind] = f"{label} ({STORAGE_DIRECTORY_NAMES[kind]}) にアクセスできません。"
    return errors


def os_access(path: Path, *, write: bool = False) -> bool:
    """Check directory access without creating or touching child paths."""
    mode = os.R_OK | (os.W_OK if write else 0)
    return bool(os.access(path, mode))


class SettingsManager:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.path = base_dir / SETTINGS_INI_FILENAME
        self.lock = RLock()

    def load(self) -> AppSettings:
        parser = ConfigParser(interpolation=None)
        if not self.path.exists():
            settings = AppSettings()
            self.save(settings)
            return settings
        parser.read(self.path, encoding="utf-8")
        # ``[database]`` was the old section name.  Retain it as a source for
        # personal settings only; path keys are discarded by from_mapping.
        section = (
            parser["settings"]
            if parser.has_section("settings")
            else parser["database"]
            if parser.has_section("database")
            else {}
        )
        return AppSettings.from_mapping(section)

    def save(self, settings: AppSettings) -> None:
        parser = ConfigParser(interpolation=None)
        parser["settings"] = {
            key: str(value) for key, value in settings.to_dict().items()
        }
        # The executable directory is expected to exist.  Do not create a
        # storage directory (or any other application data directory) as a
        # side-effect of saving personal settings.
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent,
                prefix=f".{self.path.name}.", suffix=".tmp", delete=False,
            ) as file:
                temporary_path = Path(file.name)
                parser.write(file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)


class StorageManager:
    """Read the sole storage location from ``<base_dir>/storage.ini``."""

    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir
        self.path = base_dir / STORAGE_INI_FILENAME

    def load(self) -> str:
        if not self.path.exists():
            raise StorageConfigError(
                "storage.ini が見つかりません。",
                code="storage_config_missing",
                target=STORAGE_INI_FILENAME,
            )
        parser = ConfigParser(interpolation=None)
        try:
            with self.path.open("r", encoding="utf-8") as file:
                parser.read_file(file)
        except (OSError, UnicodeError, ConfigParserError) as exc:
            raise StorageConfigError(
                "storage.ini を読み込めませんでした。",
                code="storage_config_malformed",
                target=STORAGE_INI_FILENAME,
            ) from exc
        if not parser.has_section("storage"):
            raise StorageConfigError(
                "storage.ini に [storage] セクションがありません。",
                code="storage_config_malformed",
                target=STORAGE_INI_FILENAME,
            )
        try:
            root_path = parser.get("storage", "root_path", fallback="").strip()
        except ConfigParserError as exc:
            raise StorageConfigError(
                "storage.ini の [storage] root_path を読み込めませんでした。",
                code="storage_config_malformed",
                target="root_path",
            ) from exc
        if not root_path:
            raise StorageConfigError(
                "storage.ini の [storage] root_path が未設定です。",
                code="storage_config_malformed",
                target="root_path",
            )
        try:
            root = Path(root_path)
        except (OSError, ValueError) as exc:
            raise StorageConfigError(
                "storage.ini の root_path が不正です。",
                code="storage_config_malformed",
                target="root_path",
            ) from exc
        try:
            if not root.exists():
                raise StorageConfigError(
                    "保存先のルートフォルダが見つかりません。",
                    code="storage_root_missing",
                    target="root_path",
                )
            if not root.is_dir():
                raise StorageConfigError(
                    "保存先のルートパスにはフォルダを指定してください。",
                    code="storage_root_invalid",
                    target="root_path",
                )
            if not os_access(root):
                raise StorageConfigError(
                    "保存先のルートフォルダにアクセスできません。",
                    code="storage_root_inaccessible",
                    target="root_path",
                )
        except OSError as exc:
            raise StorageConfigError(
                "保存先のルートフォルダにアクセスできません。",
                code="storage_root_inaccessible",
                target="root_path",
            ) from exc
        return str(root)


def load_storage_settings(base_dir: Path) -> AppSettings:
    """Load personal settings plus the external storage root.

    This helper is convenient for API/bootstrap callers.  It intentionally
    raises StorageConfigError so the initial screen can present a repair path
    instead of silently falling back to a local directory.
    """
    settings = SettingsManager(base_dir).load()
    settings.root_path = StorageManager(base_dir).load()
    return settings

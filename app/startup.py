"""画面表示まで重い依存ライブラリと共有フォルダーへのアクセスを遅延する。"""
from pathlib import Path
from threading import Event, Lock, Thread


def read_startup_appearance(base_dir: Path) -> tuple[str, str]:
    """共有フォルダーに触れず、描画前に個人設定の配色だけを読む。"""
    from configparser import ConfigParser, Error
    from app.config import AppSettings, SETTINGS_INI_FILENAME, normalize_color_appearance

    defaults = AppSettings()
    parser = ConfigParser(interpolation=None)
    try:
        parser.read(base_dir / SETTINGS_INI_FILENAME, encoding="utf-8")
        section = parser["settings"] if parser.has_section("settings") else (
            parser["database"] if parser.has_section("database") else {}
        )
        return normalize_color_appearance(
            section.get("ui_color_theme"), section.get("ui_color_palette"),
            theme_default=defaults.ui_color_theme,
            palette_default=defaults.ui_color_palette,
        )
    except (OSError, UnicodeError, Error):
        return defaults.ui_color_theme, defaults.ui_color_palette


def startup_background(theme: str, palette: str) -> str:
    """HTML描画前のWebView背景も保存済みの配色に合わせる。"""
    if theme == "dark":
        return "#000000" if palette == "blue_white" else "#212121"
    return "#ffffff" if palette == "blue_white" else "#f7f7f8"


class DeferredApi:
    def __init__(self, base_dir: Path):
        self._base_dir = base_dir
        self._shown = Event()
        self._lock = Lock()
        self._ready = Event()
        self._started = False
        self._api = None
        self._error = None
        self._closed = False
        self._close_callback = None

    def _mark_shown(self):
        self._shown.set()

    def _mark_closed(self):
        self._closed = True
        self._shown.set()
        self._ready.set()

    def _set_close_window_callback(self, callback):
        self._close_callback = callback

    @property
    def has_unsaved_changes(self):
        # 初期化待ちで終了操作を止めない。
        return self._api.has_unsaved_changes if self._api is not None else False

    def _get_api(self):
        # JSブリッジのワーカースレッドで待ち、GUIスレッドを塞がない。
        self._shown.wait()
        with self._lock:
            if self._closed:
                raise RuntimeError("アプリケーションは終了しました。")
            if not self._started:
                self._started = True
                Thread(target=self._initialize, name="nippo-startup", daemon=True).start()
        self._ready.wait()
        if self._closed:
            raise RuntimeError("アプリケーションは終了しました。")
        if self._error is not None:
            raise RuntimeError("初期化に失敗しました。アプリを再起動してください。") from self._error
        return self._api

    def _initialize(self):
        # ネットワークI/Oが長引いても、初期化スレッドでプロセス終了を妨げない。
        try:
            from app.api import DailyReportApi
            api = DailyReportApi(self._base_dir)
            api._set_close_window_callback(self._close_callback)
            if not self._closed:
                self._api = api
        except Exception as exc:
            self._error = exc
        finally:
            self._ready.set()

    def get_initial_state(self):
        return self._get_api().get_initial_state()

    def close_window(self):
        if self._close_callback is None:
            return {"ok": False}
        self._close_callback()
        return {"ok": True}

    def set_unsaved_changes(self, value):
        return self._get_api().set_unsaved_changes(value)

    def load_settings(self):
        return self._get_api().load_settings()

    def save_settings(self, payload):
        return self._get_api().save_settings(payload)

    def save_ui_state(self, payload):
        return self._get_api().save_ui_state(payload)

    def load_data(self, payload=None):
        return self._get_api().load_data(payload)

    def load_common_masters(self, payload=None):
        return self._get_api().load_common_masters(payload)

    def load_calendar(self):
        return self._get_api().load_calendar()

    def save_common_master(self, payload):
        return self._get_api().save_common_master(payload)

    def save_user_administration(self, payload):
        return self._get_api().save_user_administration(payload)

    def save_updates(self, payload):
        return self._get_api().save_updates(payload)

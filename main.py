from __future__ import annotations

import logging
import os
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import url2pathname

import webview

from app.startup import DeferredApi, read_startup_appearance, startup_background
from app.instance_lock import SingleInstanceLock

logger = logging.getLogger(__name__)

# アプリケーションのベースディレクトリを取得する
def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


# PyInstallerでexeにまとめたときに一時フォルダを使うための処理
def get_asset_dir(base_dir: Path) -> Path:
    bundled_dir = Path(getattr(sys, "_MEIPASS", base_dir))
    web_dir = bundled_dir / "web"
    if web_dir.exists():
        return web_dir
    return base_dir / "web"


def confirm_discard_unsaved() -> bool:
    message = "未保存の変更があります。\n\nはい：破棄して終了\nいいえ：終了しない"
    if os.name == "nt":
        import ctypes

        # MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2
        return ctypes.windll.user32.MessageBoxW(None, message, "日報", 0x134) == 6
    return False


def build_closing_handler(
    api: DeferredApi,
    confirm: Callable[[], bool] = confirm_discard_unsaved,
    request_confirmation: Callable[[], bool] | None = None,
) -> Callable[..., bool]:
    def on_closing(*_: object) -> bool:
        if not api.has_unsaved_changes:
            return True
        if request_confirmation is not None:
            return bool(request_confirmation())
        return confirm()

    return on_closing


def configure_webview_security(settings: Any) -> None:
    # A target="_blank" navigation must never be handed to the OS browser.
    # pywebview will redirect it into this WebView, where the native guard cancels it.
    settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False
    settings["ALLOW_DOWNLOADS"] = False


def is_allowed_app_navigation(candidate_url: Any, app_url: str) -> bool:
    candidate_path = _canonical_file_url_path(candidate_url)
    allowed_path = _canonical_file_url_path(app_url)
    return candidate_path is not None and candidate_path == allowed_path


def install_webview_navigation_guard(window: Any, app_url: str) -> bool:
    if getattr(window, "_nippo_navigation_guard_installed", False):
        return True
    native = getattr(window, "native", None)
    native_webview = getattr(native, "webview", None)
    core_webview = getattr(native_webview, "CoreWebView2", None)
    navigation_event = getattr(native_webview, "NavigationStarting", None)
    new_window_event = getattr(core_webview, "NewWindowRequested", None)
    if navigation_event is None or new_window_event is None:
        return False

    def on_navigation_starting(_: Any, args: Any) -> None:
        uri = getattr(args, "Uri", None)
        if uri is None and hasattr(args, "get_Uri"):
            uri = args.get_Uri()
        if is_allowed_app_navigation(uri, app_url):
            return
        try:
            args.Cancel = True
        except Exception:
            args.set_Cancel(True)

    def on_new_window_requested(_: Any, args: Any) -> None:
        try:
            args.set_Handled(True)
        except Exception:
            args.Handled = True

    native_webview.NavigationStarting += on_navigation_starting
    core_webview.NewWindowRequested += on_new_window_requested
    # Keep Python delegates alive for the lifetime of the native WebView.
    window._nippo_navigation_guard_handlers = (
        on_navigation_starting,
        on_new_window_requested,
    )
    window._nippo_navigation_guard_installed = True
    return True


def _canonical_file_url_path(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() != "file" or parsed.query:
            return None
        if parsed.netloc.lower() not in {"", "localhost"}:
            return None
        return os.path.normcase(str(Path(url2pathname(parsed.path)).resolve()))
    except (OSError, ValueError):
        return None


def handle_window_action(window, action, drag=None):
    """Use native move/resize loops so Windows handles monitor edges and sizing."""
    import ctypes
    from ctypes import wintypes

    allowed = {"minimize", "maximize", "state", "move", "left", "right", "top",
               "bottom", "top-left", "top-right", "bottom-left", "bottom-right"}
    if not isinstance(action, str) or action not in allowed:
        return {"ok": False}
    native = getattr(window, "native", None)
    if native is None:
        return {"ok": False}
    hwnd = native.Handle.ToInt64()
    user32 = ctypes.windll.user32
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    if action == "move":
        # WebView owns the mouse stream. Move explicitly using queued pointer
        # deltas instead of handing an in-progress gesture to a native modal loop.
        import math
        if not isinstance(drag, dict) or not isinstance(drag.get("id"), str):
            return {"ok": False}
        fields = ("dx", "dy", "fraction")
        if any(not isinstance(drag.get(key), (int, float)) or not math.isfinite(drag[key]) for key in fields):
            return {"ok": False}
        user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user32.GetDpiForWindow.argtypes = [wintypes.HWND]
        user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND,
                                       ctypes.c_int, ctypes.c_int,
                                       ctypes.c_int, ctypes.c_int, wintypes.UINT]
        saved = getattr(window, "_nippo_drag_state", None)
        if saved is None or saved[0] != drag["id"]:
            bounds = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(bounds))
            scale = user32.GetDpiForWindow(hwnd) / 96
            x, y = bounds.left, bounds.top
            if user32.IsZoomed(hwnd):
                fraction = min(1, max(0, drag["fraction"]))
                grabbed_x = bounds.left + (bounds.right - bounds.left) * fraction
                window.restore()
                user32.GetWindowRect(hwnd, ctypes.byref(bounds))
                x = round(grabbed_x - (bounds.right - bounds.left) * fraction)
            saved = (drag["id"], x, y, scale)
            window._nippo_drag_state = saved
        _, x, y, scale = saved
        user32.SetWindowPos(hwnd, None, round(x + drag["dx"] * scale),
                            round(y + drag["dy"] * scale), 0, 0, 0x0001 | 0x0004 | 0x0010)
    elif action == "minimize":
        window.minimize()
    elif action == "maximize":
        if user32.IsZoomed(hwnd):
            window.restore()
        else:
            from System import Action
            from System.Windows.Forms import Screen

            def set_maximized_bounds():
                native.MaximizedBounds = Screen.FromControl(native).WorkingArea

            native.Invoke(Action(set_maximized_bounds))
            window.maximize()
    elif action != "state":
        hits = {"move": 2, "left": 10, "right": 11, "top": 12, "top-left": 13,
                "top-right": 14, "bottom": 15, "bottom-left": 16, "bottom-right": 17}
        if not user32.IsZoomed(hwnd):
            point = wintypes.POINT()
            user32.GetCursorPos(ctypes.byref(point))
            position = (point.x & 0xFFFF) | ((point.y & 0xFFFF) << 16)
            from System import Action

            def begin_native_drag():
                # Capture belongs to the GUI thread. Releasing it on the JS
                # bridge worker leaves WebView holding the mouse input.
                user32.ReleaseCapture()
                command = 0xF000 | (hits[action] - 9)
                user32.SendMessageW(hwnd, 0x0112, command, position)

            native.Invoke(Action(begin_native_drag))
    return {"ok": True, "maximized": bool(user32.IsZoomed(hwnd))}


# アプリケーションのメイン処理
def main() -> None:
    base_dir = get_base_dir()
    instance_lock = SingleInstanceLock(base_dir / "cache" / "locks")
    if not instance_lock.acquire():
        return
    try:
        api = DeferredApi(base_dir)
        html_path = get_asset_dir(base_dir) / "index.html"
        theme, palette = read_startup_appearance(base_dir)
        app_url = f"{html_path.as_uri()}#theme={theme}&palette={palette}"
        configure_webview_security(webview.settings)
        window = webview.create_window(
            "NIPPO",
            app_url,
            js_api=api,
            width=1280,
            height=800,
            min_size=(960, 600),
            text_select=True,
            frameless=True,
            easy_drag=False,
            background_color=startup_background(theme, palette),
        )

        api._set_window_action_callback(lambda action, drag=None: handle_window_action(window, action, drag))

        close_approved = False

        def approve_close() -> None:
            nonlocal close_approved
            close_approved = True
            window.destroy()

        api._set_close_window_callback(approve_close)

        def request_close_confirmation() -> bool:
            if close_approved:
                return True

            def show_close_confirmation() -> None:
                try:
                    # pywebview waits for the JavaScript evaluation result even
                    # for run_js. Run it after this closing handler returns so
                    # the GUI event loop can process the request and button
                    # input normally.
                    window.run_js(
                        "if (typeof window.requestNativeCloseConfirmation === 'function') "
                        "window.requestNativeCloseConfirmation();"
                    )
                except Exception:
                    logger.exception("WebViewの終了確認ダイアログを表示できませんでした")

            threading.Thread(
                target=show_close_confirmation,
                name="nippo-close-confirmation",
                daemon=True,
            ).start()
            return False

        window.events.shown += api._mark_shown
        window.events.closed += api._mark_closed
        window.events.closing += build_closing_handler(
            api, request_confirmation=request_close_confirmation
        )

        def install_navigation_guard() -> None:
            if install_webview_navigation_guard(window, app_url):
                return
            logger.critical("WebView navigation guard could not be installed")
            window.destroy()

        # before_load runs after the trusted document is loaded but before the
        # JavaScript bridge (and therefore untrusted CSV content) is exposed.
        window.events.before_load += install_navigation_guard
        webview.start(debug=False)
    finally:
        instance_lock.release()


if __name__ == "__main__":
    main()

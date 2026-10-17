from __future__ import annotations

from datetime import date


# カレンダー運用を開始する年度。年度下限を変更する場合はこの値だけを変更する。
CALENDAR_MIN_FISCAL_YEAR = 2026
CALENDAR_MIN_DATE = date(CALENDAR_MIN_FISCAL_YEAR, 4, 1)
DEFAULT_MISSING_COMMENT_START_DATE = CALENDAR_MIN_DATE

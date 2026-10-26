"""最初期のCSV（replies JSON/5列コメント）を現行v4へ変換する。

元データとsettings/storage.iniは変更しない。--writeなしは事前検証のみ。
Python 3.10以降の標準ライブラリだけで実行できます（追加インストール不要）。
python convert_csv.py --source test_data --output converted_v4 --write
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import shutil
import os
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path, PureWindowsPath
from uuid import UUID, uuid4
from typing import Any

# Frozen v4 migration contract. Keep this file standalone: no app/tools imports.
# Compatibility is checked against the application by tests/test_csv_v1_to_v4.py.
MAX_EMPLOYEE_ID_LENGTH = 128
_INVALID_WINDOWS_FILENAME_CHARS = set('<>:"/\\|?*')

FIELDS = ['message_id','message_kind','message_text','message_rich_text','target_author_employee_id','target_message_id','reaction_type','created_at','updated_at','deleted_at']
USER_COLUMNS = ['record_type','employee_id','date','business_name','business_name_rich_text','business_detail','business_detail_rich_text','superior_employee_id',*FIELDS]
COMMENT_COLUMNS = ['record_type','superior_employee_id','subordinate_employee_id','date',*FIELDS]
USER_KEYS = ['record_type','employee_id','date','superior_employee_id','message_id','target_author_employee_id','target_message_id']
COMMENT_KEYS = ['record_type','superior_employee_id','subordinate_employee_id','date','message_id','target_author_employee_id','target_message_id']


MAX_TEXT_LENGTH = 20_000
MAX_JSON_BYTES = 2_000_000
MAX_NODES = 40_000


def from_plain(text: str) -> dict[str, Any]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        text = ""
    return {"version": 1, "doc": {"type": "doc", "content": [
        {"type": "paragraph", **({"content": [{"type": "text", "text": line}]} if line else {})}
        for line in text.split("\n")
    ]}}


def normalize(value: Any) -> tuple[dict[str, Any], str]:
    """Reject unsupported nodes/attributes/marks; return canonical JSON and derived text."""
    try:
        if isinstance(value, str):
            if len(value.encode("utf-8")) > MAX_JSON_BYTES:
                raise ValueError("書式データが大きすぎます。")
            value = json.loads(value)
        if not isinstance(value, dict) or set(value) != {"version", "doc"} or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("書式データの版または項目が不正です。")
        doc = value["doc"]
        if not isinstance(doc, dict) or set(doc) != {"type", "content"} or doc["type"] != "doc" or not isinstance(doc["content"], list) or not doc["content"]:
            raise ValueError("文章データが不正です。")
        paragraphs, texts, count = [], [], 0
        for paragraph in doc["content"]:
            if not isinstance(paragraph, dict) or not set(paragraph) <= {"type", "content"} or paragraph.get("type") != "paragraph" or not isinstance(paragraph.get("content", []), list):
                raise ValueError("段落データが不正です。")
            content, parts = [], []
            count += 1
            if count > MAX_NODES:
                raise ValueError("文章データの要素が多すぎます。")
            for node in paragraph.get("content", []):
                count += 1
                if count > MAX_NODES or not isinstance(node, dict):
                    raise ValueError("文章データの要素が多すぎるか不正です。")
                if node == {"type": "hardBreak"}:
                    content.append(node)
                    parts.append("\n")
                    continue
                if not set(node) <= {"type", "text", "marks"} or node.get("type") != "text" or not isinstance(node.get("text"), str) or not node["text"] or any(c in node["text"] for c in ("\n", "\r", "\x00")):
                    raise ValueError("文字データが不正です。")
                marks = node.get("marks", [])
                if not isinstance(marks, list) or any(not isinstance(m, dict) or set(m) != {"type"} or m["type"] not in {"bold", "underline"} for m in marks):
                    raise ValueError("使用できる書式は太字と下線です。")
                names = sorted({m["type"] for m in marks})
                if len(names) != len(marks):
                    raise ValueError("書式が重複しています。")
                normalized = {"type": "text", "text": node["text"]}
                if names:
                    normalized["marks"] = [{"type": name} for name in names]
                if content and content[-1].get("type") == "text" and content[-1].get("marks", []) == normalized.get("marks", []):
                    content[-1]["text"] += normalized["text"]
                else:
                    content.append(normalized)
                parts.append(node["text"])
            paragraphs.append({"type": "paragraph", **({"content": content} if content else {})})
            texts.append("".join(parts))
        plain = "\n".join(texts)
        if len(plain) > MAX_TEXT_LENGTH:
            raise ValueError("文章が長すぎます。")
        result = {"version": 1, "doc": {"type": "doc", "content": paragraphs}}
        if not plain.strip():
            result, plain = from_plain(""), ""
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_JSON_BYTES:
            raise ValueError("書式データが大きすぎます。")
        return result, plain
    except (TypeError, KeyError, RecursionError, json.JSONDecodeError) as exc:
        raise ValueError("書式データが不正です。") from exc


def serialize(value: Any) -> tuple[str, str]:
    document, plain = normalize(value)
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")), plain


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


LEGACY_COLUMNS = (
    "employee_id", "date", "business_name", "business_detail", "replies", "updated_at",
)
ROW_COLUMNS = (
    "record_type", "employee_id", "date", "business_name", "business_detail",
    "reply_to_employee_id", "reply_text", "updated_at",
)
REPORT_DIRECTORIES = ("regular_employee_reports", "temporary_employee_reports")


def read_legacy_csv(path: Path) -> list[dict[str, str]]:
    """現行と同じUTF-8/CP932を受け入れ、列や不完全な行はエラーにする。"""
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp932")
    reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
    if reader.fieldnames is None or len(reader.fieldnames) != len(LEGACY_COLUMNS):
        raise ValueError(f"{path}: 旧日報CSVの列数が一致しません。")
    if set(reader.fieldnames) != set(LEGACY_COLUMNS):
        raise ValueError(f"{path}: 旧日報CSVの列名が一致しません。")
    rows = list(reader)
    if any(None in row or any(value is None for value in row.values()) for row in rows):
        raise ValueError(f"{path}: 列数が不正な行があります。")
    return rows


def convert_report(path: Path) -> tuple[list[dict[str, str]], int, int]:
    """本文を保ち、上司ごとの空でない返信を1行ずつ展開する。"""
    converted: list[dict[str, str]] = []
    seen_reports: set[tuple[str, str]] = set()
    reply_count = 0
    skipped_empty_replies = 0
    for position, row in enumerate(read_legacy_csv(path), start=1):
        label = f"{path} データ{position}行目"
        employee_id = row["employee_id"]
        day = row["date"]
        if employee_id != path.stem:
            raise ValueError(f"{label}: 社員IDとファイル名が一致しません。")
        if date.fromisoformat(day).isoformat() != day:
            raise ValueError(f"{label}: 日付はYYYY-MM-DD形式が必要です。")
        key = (employee_id, day)
        if key in seen_reports:
            raise ValueError(f"{label}: 同じ社員・日付の日報が重複しています。")
        seen_reports.add(key)

        report = dict.fromkeys(ROW_COLUMNS, "")
        report.update({column: row[column] for column in LEGACY_COLUMNS if column != "replies"})
        report["record_type"] = "report"
        converted.append(report)

        replies = json.loads(row["replies"] or "[]")
        if not isinstance(replies, list):
            raise ValueError(f"{label}: repliesはJSON配列である必要があります。")
        seen_targets: set[str] = set()
        for item in replies:
            if not isinstance(item, dict) or set(item) != {"superior_employee_id", "reply"}:
                raise ValueError(f"{label}: 返信の項目が旧形式と一致しません。")
            target = item["superior_employee_id"]
            message = item["reply"]
            if not isinstance(target, str) or not target.strip() or not isinstance(message, str):
                raise ValueError(f"{label}: 返信先または返信本文が不正です。")
            if target in seen_targets:
                raise ValueError(f"{label}: 同じ上司への返信が重複しています。")
            seen_targets.add(target)
            if not message.strip():
                skipped_empty_replies += 1
                continue
            reply = dict.fromkeys(ROW_COLUMNS, "")
            reply.update(
                record_type="reply", employee_id=employee_id, date=day,
                reply_to_employee_id=target, reply_text=message, updated_at=row["updated_at"],
            )
            converted.append(reply)
            reply_count += 1
    return converted, reply_count, skipped_empty_replies


def uuid(value):
    if not isinstance(value,str) or str(UUID(value)) != value or UUID(value).version != 4:
        raise ValueError('メッセージIDはUUID v4が必要です。')
    return value

def day(value):
    if not isinstance(value,str) or date.fromisoformat(value).isoformat()!=value:
        raise ValueError('日付が不正です。')
    return value

def timestamp(value):
    if not isinstance(value,str) or not value or datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is None:
        raise ValueError('日時にはタイムゾーンが必要です。')
    return value

def thread(row, side):
    return (row['employee_id'] if side=='user' else row['subordinate_employee_id'],row['date'],row['superior_employee_id'])

def author(row,side):
    return row['employee_id'] if side=='user' else row['superior_employee_id']

def validate_rows(rows, owner, side):
    columns=USER_COLUMNS if side=='user' else COMMENT_COLUMNS
    keys=USER_KEYS if side=='user' else COMMENT_KEYS
    seen = set()
    for row in rows:
        if list(row) != columns: raise ValueError('会話形式のCSV列と一致しません。')
        key = tuple(row[k] for k in keys)
        if key in seen: raise ValueError('レコードが重複しています。')
        seen.add(key)
    ids=set(); initials=set()
    for r in rows:
        day(r['date'])
        if author(r,side)!=owner: raise ValueError('投稿者とファイル名が一致しません。')
        kind=r['record_type']
        if kind=='report' and side=='user':
            if any(r[k] for k in ['superior_employee_id',*FIELDS] if k!='updated_at'): raise ValueError('日報行に会話情報があります。')
            for field in ('business_name','business_detail'):
                if serialize(r[field+'_rich_text'])[1]!=r[field]: raise ValueError('日報本文と書式が一致しません。')
            continue
        if kind != 'message': raise ValueError('行種別が不正です。')
        subordinate,_,superior=thread(r,side)
        validate_employee_id(subordinate); validate_employee_id(superior)
        if subordinate==superior: raise ValueError('自分自身との会話は作成できません。')
        if side=='user' and any(r[k] for k in ('business_name','business_name_rich_text','business_detail','business_detail_rich_text')): raise ValueError('会話行に日報本文があります。')
        timestamp(r['created_at']);timestamp(r['updated_at'])
        if kind=='message':
            uuid(r['message_id'])
            if r['message_id'] in ids: raise ValueError('メッセージIDが重複しています。')
            ids.add(r['message_id'])
            if r['message_kind'] not in ('initial_comment','reply') or (side=='user' and r['message_kind']!='reply'): raise ValueError('メッセージ種別が不正です。')
            if r['message_kind']=='initial_comment' and not r['deleted_at']:
                t=thread(r,side)
                if t in initials: raise ValueError('先頭コメントが重複しています。')
                initials.add(t)
            if any(r[k] for k in ('target_author_employee_id','target_message_id','reaction_type')): raise ValueError('メッセージ行にリアクション情報があります。')
            if serialize(r['message_rich_text'])[1]!=r['message_text'] or not r['message_text'].strip(): raise ValueError('メッセージ本文または書式が不正です。')
            if r['deleted_at']: timestamp(r['deleted_at'])


LEGACY_COMMENTS = ['superior_employee_id', 'subordinate_employee_id', 'date', 'comment', 'updated_at']
JST = timezone(timedelta(hours=9))


def snapshot(source):
    result = {}
    for p in sorted(source.rglob('*.csv')):
        if not p.resolve().is_relative_to(source):
            raise ValueError(f'変換元の外を参照するCSVは使用できません: {p}')
        result[str(p.relative_to(source))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result


def read_comments(path):
    raw = path.read_bytes()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp932')
    reader = csv.DictReader(io.StringIO(text, newline=''), strict=True)
    if reader.fieldnames != LEGACY_COMMENTS:
        raise ValueError(f'{path}: 最初期の5列コメントCSVが必要です。')
    rows = list(reader)
    if any(None in r or None in r.values() for r in rows):
        raise ValueError(f'{path}: 列数が不正な行があります。')
    seen = set()
    for r in rows:
        validate_employee_id(r['subordinate_employee_id'])
        if r['superior_employee_id'] != path.stem:
            raise ValueError(f'{path}: 上司IDとファイル名が一致しません。')
        key = tuple(r[k] for k in LEGACY_COMMENTS[:3])
        if key in seen:
            raise ValueError(f'{path}: 同じ対象者・日付のコメントが重複しています。')
        seen.add(key)
    return rows


def convert(source: Path, output: Path, *, write=False):
    source, output = source.resolve(), output.resolve()
    if not source.is_dir() or not output.parent.is_dir():
        raise ValueError('変換元と出力先の親フォルダが存在する必要があります。')
    if output.exists() or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('出力先は変換元の外にある未作成の別フォルダを指定してください。')
    for folder in (*REPORT_DIRECTORIES, 'supervisor_comments', 'common_data'):
        if not (source / folder).is_dir():
            raise ValueError(f'{folder}フォルダがありません。')
    csv.field_size_limit(16 * 1024 * 1024)
    hashes = snapshot(source)
    prepared = {}
    counts = dict(report_files=0, comment_files=0, report_rows=0, reply_messages=0,
                  initial_messages=0, skipped_empty_replies=0, skipped_empty_comments=0,
                  missing_timestamps=0, copied_common_csv=0)
    initials, replies = set(), set()

    def stamp(value, day, label):
        # Old timestamps have no zone: interpret them as Japan local time.
        parsed_day = datetime.strptime(day, '%Y-%m-%d').date()
        if parsed_day.isoformat() != day:
            raise ValueError(f'{label}: 日付が不正です。')
        if not value:
            counts['missing_timestamps'] += 1
            value = day + 'T00:00:00'
        try:
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError as exc:
            raise ValueError(f'{label}: updated_atが不正です。') from exc
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=JST)
        return dt.astimezone(timezone.utc).isoformat(timespec='microseconds')

    def message(row, text, kind, timestamp):
        rich, plain = serialize(from_plain(text))
        row.update(record_type='message', message_id=str(uuid4()), message_kind=kind,
                   message_text=plain, message_rich_text=rich,
                   created_at=timestamp, updated_at=timestamp)

    for folder in REPORT_DIRECTORIES:
        for path in sorted((source / folder).glob('*.csv')):
            validate_employee_id(path.stem)
            old, reply_count, empty_count = convert_report(path)
            rows = []
            for r in old:
                n = dict.fromkeys(USER_COLUMNS, '')
                n.update(employee_id=r['employee_id'], date=r['date'])
                timestamp = stamp(r['updated_at'], r['date'], path)
                if r['record_type'] == 'report':
                    n.update(record_type='report', updated_at=timestamp)
                    for field in ('business_name', 'business_detail'):
                        n[field + '_rich_text'], n[field] = serialize(from_plain(r[field]))
                    counts['report_rows'] += 1
                else:
                    n['superior_employee_id'] = r['reply_to_employee_id']
                    message(n, r['reply_text'], 'reply', timestamp)
                    replies.add((n['employee_id'], n['date'], n['superior_employee_id']))
                rows.append(n)
            validate_rows(rows, path.stem, 'user')
            prepared[path.relative_to(source)] = (USER_COLUMNS, rows)
            counts['report_files'] += 1
            counts['reply_messages'] += reply_count
            counts['skipped_empty_replies'] += empty_count
    if not counts['report_files']:
        raise ValueError('変換対象の日報CSVがありません。')
    for path in sorted((source / 'supervisor_comments').glob('*.csv')):
        validate_employee_id(path.stem)
        rows = []
        for r in read_comments(path):
            timestamp = stamp(r['updated_at'], r['date'], path)
            if not r['comment'].strip():
                counts['skipped_empty_comments'] += 1
                continue
            n = dict.fromkeys(COMMENT_COLUMNS, '')
            n.update({k: r[k] for k in LEGACY_COMMENTS[:3]})
            message(n, r['comment'], 'initial_comment', timestamp)
            initials.add((n['subordinate_employee_id'], n['date'], n['superior_employee_id']))
            rows.append(n)
        validate_rows(rows, path.stem, 'comment')
        prepared[path.relative_to(source)] = (COMMENT_COLUMNS, rows)
        counts['comment_files'] += 1
        counts['initial_messages'] += len(rows)
    common = sorted((source / 'common_data').glob('*.csv'))
    counts['copied_common_csv'] = len(common)
    warnings = []
    if counts['missing_timestamps']:
        warnings.append('空のupdated_atは日報対象日の日本時間00:00で補完しました。')
    if replies - initials:
        warnings.append(f'初回上司コメントのない返信が{len(replies - initials)}会話あります。返信を保持し、初回コメントは生成しません。')
    result = dict(source_version=1, target_version=4, written=write, source=str(source),
                  output=str(output), counts=counts, warnings=warnings,
                  timestamp_policy='旧updated_atを作成・更新日時に使用。タイムゾーンなしは日本時間。元の投稿日時の復元ではありません。',
                  source_sha256=hashes)
    if snapshot(source) != hashes:
        raise ValueError('検証中に変換元CSVが変更されました。')
    if write:
        with tempfile.TemporaryDirectory(prefix='.csv-v1-v4-', dir=output.parent) as temporary:
            staged = Path(temporary) / 'data'
            for folder in (*REPORT_DIRECTORIES, 'supervisor_comments', 'common_data'):
                (staged / folder).mkdir(parents=True)
            for relative, (columns, rows) in prepared.items():
                with (staged / relative).open('w', encoding='utf-8-sig', newline='') as f:
                    writer = csv.DictWriter(f, fieldnames=columns, lineterminator='\n')
                    writer.writeheader()
                    writer.writerows(rows)
            for path in common:
                shutil.copyfile(path, staged / path.relative_to(source))
                if hashlib.sha256((staged / path.relative_to(source)).read_bytes()).hexdigest() != hashes[str(path.relative_to(source))]:
                    raise ValueError('コピー中に管理CSVが変更されました。')
            if snapshot(source) != hashes:
                raise ValueError('出力中に変換元CSVが変更されました。')
            (staged / 'migration-v1-to-v4.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            # Same-volume rename publishes only a fully prepared output. Never replace existing data.
            if output.exists():
                raise ValueError('出力先が既に存在します。')
            staged.rename(output)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--write', action='store_true', help='実際に出力する（省略時は検証のみ）')
    args = parser.parse_args()
    try:
        result = convert(args.source, args.output, write=args.write)
    except (OSError, ValueError, csv.Error) as exc:
        parser.exit(1, f'変換を中止しました: {exc}\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'source_sha256'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

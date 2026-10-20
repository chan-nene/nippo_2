"""最初期のCSV（replies JSON/5列コメント）を現行v4へ変換する。

元データとsettings/storage.iniは変更しない。--writeなしは事前検証のみ。
python tools/convert_csv_v1_to_v4.py --source test_data --output converted_v4 --write
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.conversations import USER_COLUMNS, COMMENT_COLUMNS, frame, validate_frame
from app.rich_text import from_plain, serialize
from app.security import validate_employee_id
from tools.convert_sample_report_rows import convert_report, REPORT_DIRECTORIES

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
            validate_frame(frame(rows, USER_COLUMNS), path.stem, 'user')
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
        validate_frame(frame(rows, COMMENT_COLUMNS), path.stem, 'comment')
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

"""Immutable, process-local SQLite tables for CSV partitions and cached views.

Tables share one in-memory database, not a database file. Each transformation
creates a new table, so an older cache snapshot remains readable during refresh.
The database lock covers every connection operation (including destruction).
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from itertools import count
from threading import RLock

# Rich-text JSON can exceed csv's 128 KiB default field limit.
csv.field_size_limit(max(csv.field_size_limit(), 2**31 - 1))


def quote(name: str) -> str:
    """SQL識別子を引用する。値には必ずプレースホルダーを使う。"""
    return '"' + name.replace('"', '""') + '"'


class _Database:
    def __init__(self):
        self.lock = RLock()
        self.connection = sqlite3.connect(':memory:', check_same_thread=False, isolation_level=None)
        self.connection.execute('PRAGMA temp_store = MEMORY')
        # SQLite trim() only strips ASCII spaces; preserve Python/Polars whitespace semantics.
        self.connection.create_function('strip_text', 1, lambda value: str(value or '').strip(), deterministic=True)
        self.names = count()


_database = None
_database_lock = RLock()


def _get_database():
    """最初の利用時だけDBを作成し、全スレッドで直列化して利用する。"""
    global _database
    with _database_lock:
        if _database is None:
            _database = _Database()
        return _database


class Table:
    """A cache-owned immutable table; dropping the last reference releases its SQL table."""

    def __init__(self, rows=(), columns=None):
        rows = list(rows)
        self._columns = list(columns if columns is not None else (rows[0].keys() if rows else []))
        self._bool_columns = set()
        self._json_columns = set()
        values = [tuple(row.get(c) for c in self._columns) if isinstance(row, dict) else tuple(row) for row in rows]
        for i, column in enumerate(self._columns):
            sample = next((r[i] for r in values if r[i] is not None), None)
            if isinstance(sample, bool):
                self._bool_columns.add(column)
            elif isinstance(sample, (list, dict)):
                self._json_columns.add(column)
        self._db = _get_database()
        with self._db.lock:
            self._name = 'table_' + str(next(self._db.names))
            fields = ', '.join(quote(c) for c in self._columns) or '"_empty"'
            self._db.connection.execute(f'CREATE TABLE {self.sql_name} ({fields})')
            if values:
                encoded = [tuple(json.dumps(v, ensure_ascii=False) if c in self._json_columns else v
                                 for c, v in zip(self._columns, row)) for row in values]
                self._db.connection.execute('BEGIN')
                try:
                    self._db.connection.executemany(
                        f'INSERT INTO {self.sql_name} VALUES ({",".join("?" for _ in self._columns)})', encoded)
                    self._db.connection.execute('COMMIT')
                except BaseException:
                    self._db.connection.execute('ROLLBACK')
                    raise

    def __del__(self):
        if hasattr(self, '_name'):
            with self._db.lock:
                self._db.connection.execute(f'DROP TABLE IF EXISTS {self.sql_name}')

    @property
    def sql_name(self):
        return quote(self._name)

    @property
    def columns(self):
        return list(self._columns)

    @classmethod
    def query(cls, sql, parameters=(), *, bool_columns=(), json_columns=()):
        """SELECTを独立した表に確定し、呼び出し元のスナップショットを変更しない。"""
        result = cls.__new__(cls)
        result._db = _get_database()
        with result._db.lock:
            result._name = 'table_' + str(next(result._db.names))
            result._db.connection.execute(f'CREATE TABLE {result.sql_name} AS {sql}', parameters)
            result._columns = [r[1] for r in result._db.connection.execute(f'PRAGMA table_info({result.sql_name})')]
        result._bool_columns = set(bool_columns) & set(result._columns)
        result._json_columns = set(json_columns) & set(result._columns)
        return result

    def _query(self, sql, parameters=()):
        return self.query(sql, parameters, bool_columns=self._bool_columns, json_columns=self._json_columns)

    def __len__(self):
        with self._db.lock:
            return self._db.connection.execute(f'SELECT COUNT(*) FROM {self.sql_name}').fetchone()[0]

    def is_empty(self):
        return len(self) == 0

    def clone(self):
        # Safe to share: this interface exposes no mutation of rows.
        return self

    def iter_rows(self, named=False):
        with self._db.lock:
            rows = self._db.connection.execute(f'SELECT * FROM {self.sql_name} ORDER BY rowid').fetchall()
        for row in rows:
            values = tuple(json.loads(v) if c in self._json_columns and v is not None
                           else bool(v) if c in self._bool_columns and v is not None else v
                           for c, v in zip(self._columns, row))
            yield dict(zip(self._columns, values)) if named else values

    def to_dicts(self):
        return list(self.iter_rows(named=True))

    def column_values(self, column):
        return [row[0] for row in self.select(column).iter_rows()]

    def select(self, *columns):
        if len(columns) == 1 and isinstance(columns[0], (list, tuple)):
            columns = columns[0]
        if not set(columns) <= set(self._columns):
            raise ValueError('Unknown column')
        return self._query(f'SELECT {", ".join(map(quote, columns))} FROM {self.sql_name} ORDER BY rowid')

    def where(self, condition, parameters=()):
        return self._query(f'SELECT * FROM {self.sql_name} WHERE {condition} ORDER BY rowid', parameters)

    def where_in(self, column, values):
        return self.where(f'{quote(column)} IN (SELECT value FROM json_each(?))', (json.dumps(list(values)),))

    def head(self, n):
        return self._query(f'SELECT * FROM {self.sql_name} ORDER BY rowid LIMIT ?', (n,))

    def with_column(self, column, expression, parameters=()):
        columns = self._columns if column in self._columns else [*self._columns, column]
        selections = [f'{expression} AS {quote(c)}' if c == column else quote(c) for c in columns]
        return self._query(f'SELECT {", ".join(selections)} FROM {self.sql_name} ORDER BY rowid', parameters)

    def ensure_columns(self, columns):
        selections = [quote(c) if c in self._columns else f"'' AS {quote(c)}" for c in columns]
        return self._query(f'SELECT {", ".join(selections)} FROM {self.sql_name} ORDER BY rowid')

    def has_duplicates(self, keys):
        with self._db.lock:
            return self._db.connection.execute(
                f'SELECT 1 FROM {self.sql_name} GROUP BY {", ".join(map(quote, keys))} HAVING COUNT(*) > 1 LIMIT 1'
            ).fetchone() is not None

    def deduplicate(self, keys):
        if not self.has_duplicates(keys):
            return self
        partition = ', '.join(map(quote, keys))
        columns = ', '.join(map(quote, self._columns))
        return self._query(f'''SELECT {columns} FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY {partition} ORDER BY updated_at DESC, rowid DESC) AS _rank,
                      MIN(rowid) OVER (PARTITION BY {partition}) AS _key_order
            FROM {self.sql_name}) WHERE _rank = 1 ORDER BY _key_order''')

    def index(self, *columns):
        """結合キーの索引を付ける。行データやスナップショットには影響しない。"""
        name = self._name + '_idx_' + '_'.join(columns)
        with self._db.lock:
            self._db.connection.execute(f'CREATE INDEX IF NOT EXISTS {quote(name)} ON {self.sql_name} ({", ".join(map(quote, columns))})')

    def write_csv(self, include_bom=False):
        stream = io.StringIO(newline='')
        if include_bom:
            stream.write('\ufeff')
        writer = csv.writer(stream, lineterminator='\r\n', quoting=csv.QUOTE_MINIMAL)
        writer.writerow(self._columns)
        writer.writerows(self.iter_rows())
        return stream.getvalue()


def concat(tables):
    """パーティションの順序と各CSVの入力順を保って連結する。"""
    tables = list(tables)
    if not tables:
        return Table()
    if any(t.columns != tables[0].columns for t in tables):
        raise ValueError('Incompatible table columns')
    result = tables[0].head(0)
    # INSERT per partition avoids SQLite's compound-SELECT limit (500 by default).
    with result._db.lock:
        result._db.connection.execute('BEGIN')
        try:
            for table in tables:
                result._db.connection.execute(
                    f'INSERT INTO {result.sql_name} SELECT * FROM {table.sql_name} ORDER BY rowid')
            result._db.connection.execute('COMMIT')
        except BaseException:
            result._db.connection.execute('ROLLBACK')
            raise
    return result


def read_csv(raw: bytes, encoding: str):
    """標準csvで読み込み、全列を文字列のままSQLiteに渡す。"""
    text = raw.decode('utf-8-sig' if encoding == 'utf8' else encoding)
    reader = csv.reader(io.StringIO(text, newline=''), strict=True)
    columns = next(reader, None)
    if not columns or len(columns) != len(set(columns)):
        raise ValueError('CSV header is missing or duplicated')
    rows = []
    for row in reader:
        if not row:
            continue
        if len(row) > len(columns):
            raise ValueError('CSV row has too many fields')
        rows.append(row + [''] * (len(columns) - len(row)))
    return Table(rows, columns)

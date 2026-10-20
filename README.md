# NIPPO

CSVをデータストアとして利用する、pywebview製の日報デスクトップアプリです。

## 必要環境

- Windows
- Python 3.13
- Microsoft Edge WebView2 Runtime

## セットアップ

ルートフォルダを`storage.ini` に記載してからアプリを起動してください

## ルートフォルダ配下のフォルダ/ファイル構成

- `common_data`: `administration.csv`、`administration.lock`、`calendar.csv`
- `supervisor_comments`: employee_idごとのコメントCSV
- `regular_employee_reports`: employee_idごとの日報CSV
- `temporary_employee_reports`: employee_idの日報CSV

## CSVファイルのスキーマ

アプリからのCSV保存は、Excelで日本語を開けるようUTF-8 BOM付きで行います。既存のBOMなしUTF-8・CP932のCSVも読み込み可能で、次回保存時にUTF-8 BOM付きになります。

CSVの読み書きにはPython標準の`csv`、結合・抽出・重複整理には標準の`sqlite3`を使用します。DBはプロセス内のメモリだけに置き、終了時に破棄します。保存先は従来どおりCSVで、永続DBファイルは作りません。ファイル単位・世代単位のキャッシュを維持し、更新時はSQLiteの新しい表へ差し替えるため、処理中の古いスナップショットに更新後の行が混ざりません。SQLite接続へのアクセスはスレッド間で直列化しています。

- `administration.csv`: `record_type,employee_id,display_name,can_input_own_report,employment_type,is_admin,affiliation_type,organization_id,member_order,team_id,team_name,team_type,parent_team_id,sort_order,commenter_employee_id,target_type,target_organization_ids,target_employee_ids`
- `record_type` は `user_master`（ユーザー）、`team_master`（組織）、`comment_assignment`（コメント担当設定）のいずれかです。該当しない列は空欄です。
- `calendar.csv`: `date`（管理CSVとは別に保存）
- 社員別日報CSV: 日報・本人メッセージ・本人のリアクションを `record_type` で区別する18列。
- 上司別コメントCSV: 上司メッセージ・上司のリアクションを `record_type` で区別する14列。

現行のCSV列定義は `app/conversations.py`、本文の書式JSONの処理は `app/rich_text.py` にあります。

本人と担当上司は、最初の上司コメントの後に何件でも返信できます。同じ人の連続投稿も可能です。保存ボタンで確定し、自分の既存メッセージを空にして保存すると削除表示になります。削除済み本文はCSVに保持します。投稿者本人のファイルだけを書き換えるため、相手のCSVへ書き込むことはありません。

日報データ、端末設定（`storage.ini`・`settings.ini`）、管理用の鍵、仕様書、テスト、変換などの開発用ツールは公開対象に含めていません。旧形式CSVを実行時に自動変換する機能はありません。

### 旧形式CSVの変換（convert_csv.py）

`convert_csv.py` は、最初期のCSVを現行のv4形式へ変換するツールです。対象は、`replies` 列を持つ旧日報CSVと、次の5列構成の上司コメントCSVです。

```text
superior_employee_id,subordinate_employee_id,date,comment,updated_at
```

変換元には、次の4フォルダが必要です。

```text
test_data/
├─ regular_employee_reports/
├─ temporary_employee_reports/
├─ supervisor_comments/
└─ common_data/
```

プロジェクトのルートフォルダでPowerShellを開き、まず検証だけ実行します。以下は、セットアップ済みの `.venv` を使用する例です。

```powershell
.\.venv\Scripts\python.exe .\convert_csv.py --source .\test_data --output .\converted_v4
```

エラーがないことを確認したら、`--write` を付けて実際に出力します。

```powershell
.\.venv\Scripts\python.exe .\convert_csv.py --source .\test_data --output .\converted_v4 --write
```

| 引数 | 意味 |
| --- | --- |
| `--source` | 変換元のデータフォルダ |
| `--output` | 新しく作成する出力フォルダ |
| `--write` | 実際に出力する。省略時は検証のみで、ファイルを作成しない |

- 出力先は、変換元の外側にある未作成のフォルダを指定してください。出力先の親フォルダは存在する必要があります。
- 元データ、`settings.ini`、`storage.ini` は変更しません。アプリの参照先も自動では切り替わりません。
- `common_data` 直下のCSVはそのままコピーし、変換記録を出力先の `migration-v1-to-v4.json` に保存します。
- 空の返信・上司コメントはスキップします。変換件数と警告は実行結果のJSONで確認できます。
- 旧 `updated_at` にタイムゾーンがない場合は日本時間として扱い、空の場合は対象日の日本時間00:00で補完します。

### 書式編集のビルド

`frontend/` で `npm ci`、`npm run build` を実行すると、固定した依存バージョンから `web/rich-text.js` とライセンス情報を生成します。通常の起動にはNode.jsや外部CDNへの接続は不要です。

### 管理データの移行と競合防止

`administration.csv` がない場合は、従来の `user_master.csv`・`team_master.csv`・`comment_assignment.csv` を読みます。最初の正常な管理保存で統合CSVを作成し、それ以降は統合CSVだけを読み書きします。旧3ファイルは削除・更新しません。統合CSVが壊れていても旧データへの自動切り戻しは行いません。

移行時は全管理者のアプリを更新してください。旧版は統合CSVとロックに対応していないため、混在運用はできません。

保存時だけ、共有フォルダの `administration.lock` にOSの排他ロックを取得します。取得できなければ保存を止め、再試行を案内します。取得後に読み込み時のSHA-256と現在の内容を比較し、不一致なら上書きを拒否します。一致した場合だけ全管理データを検証し、同じフォルダの一時CSVへ書き込み・同期してから、一度の置き換えで確定します。

ロックファイルは常設で、存在自体はロック中を意味しません。アプリ異常終了時はOSがロックを解放します。ロックファイルを運用中に削除しないでください。競合時の画面動作は従来どおり、下書きを破棄して再読み込みを案内します。保存中によるロック取得失敗では、編集中の状態を維持して再試行できます。

バックアップは各端末の `cache/csv_backups/common/administration_*.csv` に保存します。初回移行前の状態は残された旧3ファイルで保持します。共有先の権限は、ロックファイルの作成・読み書きとCSVの置き換えを許可してください。実際の共有サーバーでの複数端末同時保存・通信断の検証が必要です。Excelなどによる直接編集は専用ロックに従わないため、管理画面から編集してください。

## 使用するJavaScriptライブラリ

WebView内では、次のライブラリを `web/vendor/` に同梱して使用します。ライブラリ本体、日本語ロケール、各ライセンスファイルをリポジトリに含めています。

- [Flatpickr](https://flatpickr.js.org/) `4.6.13` — 日付入力カレンダー。MIT License
- [Tabulator](https://tabulator.info/) `6.5.2` — 管理画面の一覧表示・並び替え・検索。MIT License
- [SortableJS](https://sortablejs.github.io/Sortable/) `1.15.7` — 組織・所属ユーザーのドラッグ＆ドロップによる並び替え。MIT License

Flatpickrの日本語表示には、Flatpickr `4.6.13` に対応する日本語ロケール `l10n/ja.js` を使用します。再配布時は `web/vendor/` のライセンス本文を保持してください。書式編集で使用するTiptap・ProseMirror等の通知は `web/rich-text.LICENSES.txt`、IBM Plex Sans JPフォントのライセンスは `web/fonts/ibm-plex-sans-jp/` に同梱しています。

## ライセンス

自作部分のライセンスは現在未指定です。同梱する第三者ライブラリ・フォントには、それぞれのライセンスが適用されます。

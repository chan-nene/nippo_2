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

- `administration.csv`: `record_type,employee_id,display_name,can_input_own_report,employment_type,is_admin,affiliation_type,organization_id,member_order,team_id,team_name,team_type,parent_team_id,sort_order,commenter_employee_id,target_type,target_organization_ids,target_employee_ids`
- `record_type` は `user_master`（ユーザー）、`team_master`（組織）、`comment_assignment`（コメント担当設定）のいずれかです。該当しない列は空欄です。
- `calendar.csv`: `date`（管理CSVとは別に保存）
- 社員別日報CSV: `record_type,employee_id,date,business_name,business_name_rich_text,business_detail,business_detail_rich_text,reply_to_employee_id,reply_text,reply_rich_text,updated_at`
- `supervisor_comments/{上司ID}.csv`: `superior_employee_id,subordinate_employee_id,date,comment,comment_rich_text,updated_at`

### 日報と返信の行形式

社員別CSVでは、先頭の `record_type` が `report` なら日報、`reply` なら本人から上司への返信です。`employee_id` は書いた本人、`date` は対象の日報の日付です。返信先は `reply_to_employee_id`、返信本文は `reply_text` に保存します。使わない列は空欄です。

書式付きJSONと完全なCSVエスケープ例は [限定リッチテキスト仕様](docs/limited-rich-text.md) に記載しています。日報行では業務名・業務内容のJSON列、返信行では返信JSON列を使用します。

日報は社員・日付につき1行、返信は社員・日付・返信先につき1行で編集します。空にした返信はその行だけ削除し、日報本文や他の返信は残します。日報本文が未入力の日にも返信行を保存できます。`updated_at` は各行を更新した日時です。

読み込みでは社員CSVを一度読み、日報と返信をメモリ上で分けます。上司コメントとの結合には日報の社員ID・日付・上司IDを使い、画面では従来どおり上司コメント欄内に返信を表示します。旧 `replies` JSON列を持つCSVの読み書きや自動変換には対応しません。列・種別・キーの重複などが不正なCSVは読み込み失敗として扱い、保存で修復・上書きしません。

保存時には、社員CSVと同じフォルダの `{社員ID}.lock` をOSでロックします。ロック内で現在のCSVを読み、画面に読み込んだ時のSHA-256と照合し、日報・返信をまとめて一度の置換で保存します。競合時は下書きを維持して上書きを止めます。ロックファイルは常設で、存在だけでは保存中を意味しません。上司コメントCSVとは別の保存単位です。Excelなどの直接編集はこの専用ロックに従わないため避けてください。

APIの `save_updates` は `user_updates`（日付と日報の変更項目）、`reply_updates`（`date,reply_to_employee_id,reply_rich_text`）、`comment_updates`（対象者・日付・`comment_rich_text`）を受け取ります。変更する項目のJSON列を必須とし、Pythonで通常テキストを生成します。通常テキストも送信した場合はJSONとの一致を検証します。日報・返信の保存には `load_data` の `data.report_revision` を `report_revision` として渡します。日報と返信は同じCSVに保存するため、保存結果は共通の `result.user` で返し、成功時の `revision` を次の保存に使います。

### 旧サンプルデータの変換

一時ツール `tools/convert_sample_report_rows.py` は、元CSVを変更せず別フォルダへ変換します。`--source` と `--output` を指定し、`--write` がなければ事前確認だけを行います。出力先が既に存在する場合は上書きしません。管理CSV・上司コメントCSVはそのままコピーし、空の返信は除外します。

旧データには返信単独の日時がないため、変換した返信の `updated_at` は元の日報行から引き継ぎます。実際の返信日時を復元した値ではありません。新旧アプリを同じデータに接続しないでください。行形式の中間サンプルは `test_data_v2` に残しています。

今回の書式付き形式は、一時ツール `python tools/convert_sample_rich_text.py --source test_data_v2 --output test_data_v3 --write` で別フォルダへ変換しています。`--write` がなければ検証だけ行い、出力先が既にあれば拒否します。元CSVのSHA-256を記録し、変換中に変化していないことを確認します。書式付きサンプルは日報636行・返信3行・上司コメント1909行です。`storage.ini` は `test_data_v3` を参照しています。旧8列/5列形式をアプリが自動補完することはありません。

### 書式編集のビルド

`frontend/` で `npm ci`、`npm run build` を実行すると、固定した依存バージョンから `web/rich-text.js` とライセンス情報を生成します。通常の起動にはNode.jsや外部CDNへの接続は不要です。ソース・編集操作・JSON契約は [限定リッチテキスト仕様](docs/limited-rich-text.md) を参照してください。

回帰テストは `python -m unittest discover -s tests -p test_report_rows.py -v`、画面側の保存処理のテストは `node --test tests/report_rows_frontend.test.cjs` で実行できます。実際の共有フォルダでの同時保存・通信断、および配布EXEでの確認は別途必要です。

### 管理データの移行と競合防止

`administration.csv` がない場合は、従来の `user_master.csv`・`team_master.csv`・`comment_assignment.csv` を読みます。最初の正常な管理保存で統合CSVを作成し、それ以降は統合CSVだけを読み書きします。旧3ファイルは削除・更新しません。統合CSVが壊れていても旧データへの自動切り戻しは行いません。

移行時は全管理者のアプリを更新してください。旧版は統合CSVとロックに対応していないため、混在運用はできません。

保存時だけ、共有フォルダの `administration.lock` にOSの排他ロックを取得します。取得できなければ保存を止め、再試行を案内します。取得後に読み込み時のSHA-256と現在の内容を比較し、不一致なら上書きを拒否します。一致した場合だけ全管理データを検証し、同じフォルダの一時CSVへ書き込み・同期してから、一度の置き換えで確定します。

ロックファイルは常設で、存在自体はロック中を意味しません。アプリ異常終了時はOSがロックを解放します。ロックファイルを運用中に削除しないでください。競合時の画面動作は従来どおり、下書きを破棄して再読み込みを案内します。保存中によるロック取得失敗では、編集中の状態を維持して再試行できます。

バックアップは各端末の `cache/csv_backups/common/administration_*.csv` に保存します。初回移行前の状態は残された旧3ファイルで保持します。共有先の権限は、ロックファイルの作成・読み書きとCSVの置き換えを許可してください。実際の共有サーバーでの複数端末同時保存・通信断の検証が必要です。Excelなどによる直接編集は専用ロックに従わないため、管理画面から編集してください。

## 使用するJavaScriptライブラリ

WebView内では、次のライブラリを `web/vendor/` に配置して使用します。ライブラリ本体、ロケール、ライセンスファイルはGit管理せず、利用者が各自で公式配布元からダウンロードしてください。

- [Flatpickr](https://flatpickr.js.org/) `4.6.13` — 日付入力カレンダー。MIT License
- [Tabulator](https://tabulator.info/) `6.5.2` — 管理画面の一覧表示・並び替え・検索。MIT License
- [SortableJS](https://sortablejs.github.io/Sortable/) `1.15.7` — 組織・所属ユーザーのドラッグ＆ドロップによる並び替え。MIT License

Flatpickrの日本語表示には、Flatpickr `4.6.13` に対応する日本語ロケール `l10n/ja.js` を使用します。各ライブラリのライセンス本文も、ダウンロード元の同じバージョンから取得して `web/vendor/` に配置してください。

## ライセンス

現在、ライセンスは未指定です

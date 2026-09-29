# 審査取扱い検索（支払基金・国保中央会／医科）

スマホ向け Web アプリ（PWA）です。次の 2 つを切り替えて（または両方まとめて）、検査名・薬剤名・手術名・処置名・注射名・病名・区分番号・項番などで全文検索できます。非公式ツールのため、最終判断は必ず公式ページ・公式PDFで確認してください。

- 支払基金「支払基金における審査の一般的な取扱い（医科）」
- 国民健康保険中央会「審査情報提供事例（医科）」

公開URL: https://k-uchida0717.github.io/shinsa-atukai-search/

## 仕組み

| ファイル | 役割 |
|---|---|
| `scripts/update_data.py` | [公式ページ](https://www.ssk.or.jp/shinryohoshu/sinsa_jirei/kikin_shinsa_atukai/shinsa_atukai_i/index.html)から一覧Excel（本体＋国保中央会合意分）のリンクをたどって取得し、`data/atukai.json` を生成 |
| `scripts/update_kokuho.py` | [国保中央会の医科ページ](https://www.kokuho.or.jp/inspect/jirei/ika/index.html)の一覧表（項番・タイトル・取扱い・掲載日）と一括PDF（根拠・留意事項）を突き合わせて `data/kokuho.json` を生成。一覧ページに変化がなければ何もしない |
| `.github/workflows/update-data.yml` | 毎日 06:00 JST に上記を実行し、変更があれば自動コミット → GitHub Pages に反映 |
| `index.html` / `app.js` / `style.css` | 検索画面 |
| `sw.js` / `manifest.webmanifest` | ホーム画面追加・オフライン閲覧 |

### 欠落防止のチェック（毎回自動）

**国保中央会**：一覧の全項番について PDF 本文が見つからない／取扱いが空の場合は中止。一覧の「事例内容」が PDF の取扱いと食い違う事例（例: G-55）は PDF 側を採用して警告を出します。一括PDFより新しい個別PDFがある事例は個別PDFを取得します。

**支払基金**：
`update_data.py` は次のどれかに当てはまると **更新を中止して失敗** します（Actions が失敗すると GitHub からメール通知が届きます）。

- 公式ページに記載された総事例数（「診療項目順（871事例）」など）と Excel の件数が一致しない
- 各回（第1回〜）に記載された事例数と Excel の件数が一致しない
- № が 1 からの連番になっていない / 「取扱い」が空の事例がある

## 公開手順（GitHub Pages）

1. GitHub で新しいリポジトリを作成し、このフォルダの中身を push
2. リポジトリの **Settings → Pages** で「Deploy from a branch」→ `main` / `/ (root)` を選択
3. **Settings → Actions → General → Workflow permissions** を「Read and write permissions」に設定
4. **Actions** タブで「支払基金データ自動更新」を一度手動実行（Run workflow）して動作確認
5. 表示された `https://<ユーザー名>.github.io/<リポジトリ名>/` をスマホで開き、「ホーム画面に追加」

## ローカルで試す

```bash
node scripts/serve.js
```

```bash
python scripts/update_data.py
```

# 審査の一般的な取扱い（医科）検索

社会保険診療報酬支払基金「支払基金における審査の一般的な取扱い（医科）」を、検査名・薬剤名・手術名・処置名・注射名・病名・区分番号などで全文検索できるスマホ向け Web アプリ（PWA）です。非公式ツールのため、最終判断は必ず公式ページで確認してください。

## 仕組み

| ファイル | 役割 |
|---|---|
| `scripts/update_data.py` | [公式ページ](https://www.ssk.or.jp/shinryohoshu/sinsa_jirei/kikin_shinsa_atukai/shinsa_atukai_i/index.html)から一覧Excel（本体＋国保中央会合意分）のリンクをたどって取得し、`data/atukai.json` を生成 |
| `.github/workflows/update-data.yml` | 毎日 06:00 JST に上記を実行し、変更があれば自動コミット → GitHub Pages に反映 |
| `index.html` / `app.js` / `style.css` | 検索画面 |
| `sw.js` / `manifest.webmanifest` | ホーム画面追加・オフライン閲覧 |

### 欠落防止のチェック（毎回自動）
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

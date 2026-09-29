"""国民健康保険中央会「審査情報提供事例（医科）」を取得し data/kokuho.json を生成する。

- 一覧（正）: https://www.kokuho.or.jp/inspect/jirei/ika/index.html の表
  （項番・タイトル・事例内容＝取扱い・掲載日）
- 根拠等: 同ページの「一括ダウンロード」PDF から各事例の本文を切り出す。
  一括PDFより新しい個別PDFがある事例、一括PDFに見つからない事例は個別PDFを取得する。
- 一覧ページに変化がなければ何もしない（毎日の負荷は HTML 1 回分のみ）。
"""
from __future__ import annotations

import datetime as dt
import hashlib
import html as H
import json
import os
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

import pymupdf

PAGE_URL = "https://www.kokuho.or.jp/inspect/jirei/ika/index.html"
OUT = Path(os.environ.get("KOKUHO_OUT") or Path(__file__).resolve().parent.parent / "data" / "kokuho.json")
UA = {"User-Agent": "Mozilla/5.0 (shinsa-atukai-search)"}
NO_RE = r"[A-Z]{1,2}-\d+"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


DASHES = "‐‑‒–—―−⁻₋﹣－"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).translate({ord(c): "-" for c in DASHES})
    return re.sub(r"\s+", "", s)


def wareki(s: str) -> list[str]:
    out = []
    for era, y, m, d in re.findall(r"(令和|平成)\s*(\d+|元)\s*年\s*(\d+)\s*月\s*(\d+)", s):
        y = 1 if y == "元" else int(y)
        out.append(dt.date((2018 if era == "令和" else 1988) + y, int(m), int(d)).isoformat())
    return out


def to_wareki(iso: str) -> str:
    y, m, d = map(int, iso.split("-"))
    era, n = ("令和", y - 2018) if y >= 2019 else ("平成", y - 1988)
    return f"{era}{'元' if n == 1 else n}年{m}月{d}日"


def cell_text(s: str) -> str:
    s = re.sub(r"(?s)</p>\s*<p[^>]*>", "\n", s)
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = H.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ")
    lines = [ln.strip() for ln in s.replace("\r", "").split("\n")]
    return "\n".join(ln for ln in lines if ln)


# ---------------------------------------------------------------- 一覧ページ
def parse_list(page: str) -> tuple[list[dict], list[str]]:
    rows, deleted, cat = [], [], ""
    for m in re.finditer(r"(?s)<h2[^>]*>(.*?)</h2>|<tr>(.*?)</tr>", page):
        if m.group(1) is not None:
            cat = cell_text(m.group(1)).strip()
            continue
        tds = re.findall(r"(?s)<td[^>]*>(.*?)</td>", m.group(2))
        if len(tds) != 4:
            continue
        no = cell_text(tds[0])
        if not re.fullmatch(NO_RE, no):
            raise ValueError(f"項番の形式が想定外です: {no!r}")
        title = cell_text(tds[1])
        if title == "削除":
            deleted.append(no)
            continue
        pdf = re.search(r'href="([^"]+\.pdf)"', tds[1], re.I)
        dates = wareki(cell_text(tds[3]))
        updated = "更新" in tds[3]
        rows.append({
            "id": f"k-{no}",
            "src": "国保中央会",
            "no": no,
            "kubunNo": "",
            "kubun": cat,
            "title": title.replace("\n", ""),
            "rule": cell_text(tds[2]),
            "basis": "",
            "date": dates[0] if dates else "",
            "kai": "",
            "status": "更新" if updated and len(dates) > 1 else "",
            "statusDate": to_wareki(dates[-1]) if updated and len(dates) > 1 else "",
            "pdf": urljoin(PAGE_URL, pdf.group(1)) if pdf else "",
        })
    return rows, deleted


# ---------------------------------------------------------------- PDF 本文
def pdf_text(data: bytes) -> str:
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return "\n".join(p.get_text() for p in doc)


HEAD_RE = re.compile(r"【+[^】\n]{1,10}】[ \t　]*\n\s*(" + NO_RE + r")[ 　]+")


def split_cases(text: str, rows_by_no: dict[str, dict]) -> dict[str, str]:
    """PDF 全文を事例ごとに切り分ける。本文中で他事例を引用している箇所と区別するため、
    見出し直後のタイトルが一覧のタイトルと一致するものだけを採用する。"""
    heads = []
    for m in HEAD_RE.finditer(text):
        no = m.group(1)
        row = rows_by_no.get(no)
        if not row:
            heads.append((m.start(), m.end(), None))  # 削除済み等の事例：区切りとしてのみ使う
            continue
        following = norm(text[m.end():m.end() + 200])
        if following.startswith(norm(row["title"])[:12]):
            heads.append((m.start(), m.end(), no))
    out = {}
    for i, (s, e, no) in enumerate(heads):
        if no and no not in out:
            out[no] = text[e:heads[i + 1][0] if i + 1 < len(heads) else len(text)]
    return out


def reflow(block: str) -> str:
    """PDF の折り返し改行を段落単位に戻す（行頭が空白・記号の行を段落の始まりとみなす）。"""
    paras: list[str] = []
    for raw in block.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            if paras and paras[-1] != "":
                paras.append("")
            continue
        new_para = (not paras or paras[-1] == "" or raw[:1] in " 　\t"
                    or re.match(r"[○●◎※・⑴-⒇①-⑳（(]|\d+[ 　]|[ア-ン][ 　]|【", line.strip()))
        if new_para:
            paras.append(line.strip())
        else:
            paras[-1] += line.strip()
    return "\n".join(p for p in paras).strip().replace("\n\n\n", "\n\n")


SECTION_NAMES = (r"取扱いの根拠|留意事項|その他参考資料等|標榜薬効.*|成分名|主な製品名|承認されている.*"
                 r"|薬理作用|使用例.*|備考|参考")
HEADING_RE = re.compile(r"(?m)^\s*○[ 　]*(" + SECTION_NAMES + r")\s*$")


def split_body(body: str, list_title: str) -> tuple[str, str]:
    """事例本文を（取扱い, 取扱い以外＝根拠・留意事項等）に分ける。
    本文冒頭の表題が一覧のタイトルと異なる場合は「PDFでの表題」として根拠欄の先頭に残す。"""
    m = re.search(r"(?m)^\s*○\s*取扱い\s*$", body)
    n = re.search(r"(?m)^\s*○\s*取扱いの根拠", body)
    if not m or not n or n.start() < m.end():
        return "", reflow(re.sub(r"《[^》]*》", "", body))
    head = body[:m.start()]
    first_sec = HEADING_RE.search(head)
    pdf_title = re.sub(r"\s+", " ", re.sub(r"《[^》]*》", "", head[:first_sec.start()] if first_sec else head)).strip()
    pre = head[first_sec.start():] if first_sec else ""
    rule = body[m.end():n.start()]
    rest = body[n.start():]
    mark = lambda x: f"\n【{x.group(1)}】"
    parts = []
    if pdf_title and norm(pdf_title) != norm(list_title):
        parts.append(f"（PDFでの表題：{pdf_title}）")
    if pre.strip():
        parts.append(reflow(HEADING_RE.sub(mark, pre)))
    parts.append(reflow(HEADING_RE.sub(mark, rest)))
    return reflow(rule), "\n\n".join(parts).strip()


def coverage(a: str, b: str) -> float:
    """a の 15 文字断片が b にどれだけ含まれるか（取扱い文言の一致確認用）。"""
    a, b = norm(a), norm(b)
    frags = [a[i:i + 15] for i in range(0, max(len(a) - 15, 1), 15)]
    return sum(f in b for f in frags) / len(frags) if frags else 1.0


def pdf_date(url: str) -> str:
    m = re.search(r"/(\d{6})_", url)
    return m.group(1) if m else ""


# ---------------------------------------------------------------- main
def main() -> int:
    raw = fetch(PAGE_URL)
    page = raw.decode("cp932", errors="replace")
    page_hash = hashlib.sha256(raw).hexdigest()

    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if old.get("pageHash") == page_hash and not os.environ.get("FORCE"):
        print(f"変更なし（{old.get('count')}件）")
        return 0

    rows, deleted = parse_list(page)
    if len(rows) < 500:
        print(f"件数が少なすぎます({len(rows)})。形式変更の可能性があるため中止", file=sys.stderr)
        return 1
    nos = [r["no"] for r in rows]
    if len(set(nos)) != len(nos):
        print("項番が重複しています", file=sys.stderr)
        return 1
    by_no = {r["no"]: r for r in rows}

    zentai = re.search(r'href="([^"]*ika_zentai[^"]*\.pdf)"', page)
    if not zentai:
        print("一括ダウンロードPDFのリンクが見つかりません", file=sys.stderr)
        return 1
    zentai_url = urljoin(PAGE_URL, zentai.group(1))
    bodies = split_cases(pdf_text(fetch(zentai_url)), by_no)
    zdate = pdf_date(zentai_url)

    # 以前に取得済みの本文（PDF の URL が同じなら再利用）
    old_basis = {(i["no"], i.get("pdf")): (i.get("basis"), i.get("_pdfRule", "")) for i in old.get("items", [])}

    problems, individual = [], 0
    for r in rows:
        body = bodies.get(r["no"])
        newer = r["pdf"] and pdf_date(r["pdf"]) > zdate
        if body is None or newer:
            cached = old_basis.get((r["no"], r["pdf"]))
            if cached and cached[0]:
                r["basis"], r["_pdfRule"] = cached
                continue
            if not r["pdf"]:
                problems.append(f"{r['no']}: 本文PDFが見つかりません")
                continue
            one = split_cases(pdf_text(fetch(r["pdf"])), {r["no"]: r})
            body = one.get(r["no"])
            individual += 1
            if body is None:
                problems.append(f"{r['no']}: 個別PDFから本文を取り出せません")
                continue
        rule, basis = split_body(body, r["title"])
        r["basis"], r["_pdfRule"] = basis, rule

    warnings = []
    for r in rows:
        # 公式一覧の「事例内容」欄に取扱い以外の文章が載っている場合は PDF の取扱いを採用する
        if r.get("_pdfRule") and coverage(r["rule"], r["_pdfRule"]) < 0.6:
            warnings.append(f"{r['no']}: 一覧の事例内容がPDFの取扱いと異なるため、PDFの取扱いを採用")
            r["rule"] = r["_pdfRule"]
        if not r["rule"]:
            problems.append(f"{r['no']}: 事例内容（取扱い）が空です")
    if problems:
        print("整合性チェックに失敗したため更新を中止:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1

    items = [{k: v for k, v in r.items() if k != "_pdfRule"} | {"_pdfRule": r.get("_pdfRule", "")} for r in rows]
    latest = max(r["date"] for r in rows if r["date"])
    upd = [wareki(r["statusDate"])[0] for r in rows if r["statusDate"]]
    payload = {
        "source": PAGE_URL,
        "sourceName": "国民健康保険中央会",
        "asOf": f"{to_wareki(max([latest] + upd))} 掲載分まで",
        "latestKai": "",
        "latestDate": latest,
        "count": len(items),
        "deleted": deleted,
        "pageHash": page_hash,
        "zentaiPdf": zentai_url,
        "updatedAt": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes"),
        "items": items,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for w in warnings:
        print("注意:", w)
    print(f"更新しました: {len(items)}件（削除 {len(deleted)}件, 個別PDF取得 {individual}件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

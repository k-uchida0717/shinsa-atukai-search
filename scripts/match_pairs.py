"""支払基金と国保中央会で同じ事例を突き合わせ、data/pairs.json を生成する。

判定（1 対 1 に限る）:
  - 取扱いの文言が表記ゆれを除いて一致 → 同一事例
  - タイトルが類似（0.6 以上）かつ 取扱いが類似（0.9 以上）
  - タイトルがほぼ一致（0.8 以上）かつ 取扱いがある程度類似（0.5 以上）
    （支払基金側が「変更前／変更後」を併記している事例などを拾うため）
文言が完全一致しない組は rule="diff" とし、アプリでは両方の文言を並べて表示する。
"""
from __future__ import annotations

import difflib
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(os.environ.get("DATA_DIR") or Path(__file__).resolve().parent.parent / "data")
DASHES = "‐‑‒–—―−⁻₋﹣－"


def norm(s: str) -> str:
    # 国保側の「※D-108と同様の趣旨」のような参照注記は内容ではないので比較から外す
    s = re.sub(r"※\s*[A-ZＡ-Ｚ]{1,2}\s*[-－]\s*\d+\s*と同様の趣旨", "", s)
    s = unicodedata.normalize("NFKC", s).translate({ord(c): "-" for c in DASHES + "ー一"}).lower()
    return re.sub(r"[\s「」『』、。，．・:：]", "", s)


def norm_title(s: str) -> str:
    return norm(re.sub(r"【[^】]*統一事例】", "", s))


def norm_basis(s: str) -> str:
    s = re.sub(r"【(取扱いの根拠|留意事項)】|（PDFでの表題：[^）]*）", "", s)
    return norm(s)


def ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def grams(t: str) -> set[str]:
    return {t[i:i + 3] for i in range(len(t) - 2)}


def main() -> int:
    ssk = json.loads((ROOT / "atukai.json").read_text(encoding="utf-8"))["items"]
    kk = json.loads((ROOT / "kokuho.json").read_text(encoding="utf-8"))["items"]
    ssk = [i for i in ssk if i.get("status") != "削除"]
    S = [(i, norm(i["rule"]), norm_title(i["title"])) for i in ssk]
    SG = [grams(r) | grams(t) for _, r, t in S]

    cands = []
    for k in kk:
        kr, kt = norm(k["rule"]), norm_title(k["title"])
        kg = grams(kr) | grams(kt)
        scored = sorted(((len(kg & g) / (len(kg | g) or 1), j) for j, g in enumerate(SG)), reverse=True)[:5]
        for jac, j in scored:
            if jac < 0.15:
                continue
            s, sr, st = S[j]
            rr = 1.0 if kr == sr else ratio(kr, sr)
            tr = ratio(kt, st)
            ok = rr == 1.0 or (tr >= 0.6 and rr >= 0.9) or (tr >= 0.8 and rr >= 0.5)
            if ok:
                cands.append((rr == 1.0, tr + rr, k, s, rr, tr))

    cands.sort(key=lambda x: (x[0], x[1]), reverse=True)
    used_k, used_s, pairs = set(), set(), []
    for same, _, k, s, rr, tr in cands:
        if k["id"] in used_k or s["id"] in used_s:
            continue
        used_k.add(k["id"])
        used_s.add(s["id"])
        pairs.append({
            "ssk": s["id"], "kk": k["id"], "sskNo": s["no"], "kkNo": k["no"],
            "rule": "same" if same else "diff",
            "basis": "same" if norm_basis(s["basis"]) == norm_basis(k["basis"]) else "diff",
            "ruleRatio": round(rr, 3), "titleRatio": round(tr, 3),
        })

    pairs.sort(key=lambda p: p["kk"])
    out = ROOT / "pairs.json"
    payload = {"count": len(pairs), "pairs": pairs}
    if out.exists() and json.loads(out.read_text(encoding="utf-8")) == payload:
        print(f"変更なし（{len(pairs)}組）")
        return 0
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    same = sum(p["rule"] == "same" for p in pairs)
    print(f"更新しました: {len(pairs)}組（取扱い同一 {same}組, 文言差あり {len(pairs) - same}組）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

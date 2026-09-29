"use strict";

const CAT_ORDER = ["初・再診料", "入院料等", "医学管理等", "在宅医療", "検査", "画像診断", "投薬", "注射",
  "リハビリテーション", "精神科専門療法", "処置", "手術", "麻酔", "放射線療法", "病理診断", "その他", "食事"];
const FIELDS = ["title", "rule", "basis"];
const PAGE = 40;
const $ = (id) => document.getElementById(id);

let DATA = null;
let results = [];
let shown = 0;
const state = { q: "", field: "all", sort: "rel", cat: "", hideDeleted: true, kokuho: true, updatedOnly: false };

/* ---------- 正規化：全角半角・大文字小文字・かなカナ・空白・かぎ括弧の違いを吸収 ---------- */
const DROP = /[\s「」『』]/;
function normChar(c) {
  let s = c.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of s) {
    if (DROP.test(ch)) continue;
    const code = ch.charCodeAt(0);
    // カタカナ → ひらがな
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
  }
  return out;
}
function normalize(str) {
  let n = "";
  for (const c of str) n += normChar(c);
  return n;
}
/** 正規化文字列と、正規化後の各位置 → 元文字列の位置 の対応表を作る */
function indexText(str) {
  let n = "";
  const map = [];
  let i = 0;
  for (const c of str) {
    const nc = normChar(c);
    for (let k = 0; k < nc.length; k++) map.push(i);
    n += nc;
    i += c.length;
  }
  map.push(i);
  return { n, map };
}

/* ---------- クエリ解析：空白=AND、-語=除外、A|B=OR ---------- */
function parseQuery(q) {
  const inc = [], exc = [];
  for (const raw of q.split(/[\s　]+/).filter(Boolean)) {
    if ((raw[0] === "-" || raw[0] === "－") && raw.length > 1) {
      const t = normalize(raw.slice(1));
      if (t) exc.push(t);
    } else {
      const alts = raw.split(/[|｜]/).map(normalize).filter(Boolean);
      if (alts.length) inc.push(alts);
    }
  }
  return { inc, exc };
}

/* ---------- 検索 ---------- */
function search() {
  const { inc, exc } = parseQuery(state.q);
  const fields = state.field === "all" ? FIELDS : [state.field];
  const weight = { title: 12, rule: 4, basis: 1 };
  const base = [];
  for (const it of DATA.items) {
    if (state.hideDeleted && it.status === "削除") continue;
    if (!state.kokuho && it.src !== "支払基金") continue;
    if (state.updatedOnly && !it.status) continue;
    let score = 0, ok = true;
    for (const alts of inc) {
      let hit = 0;
      for (const f of fields) {
        const n = it._ix[f].n;
        for (const a of alts) {
          let p = n.indexOf(a), c = 0;
          while (p !== -1 && c < 5) { c++; p = n.indexOf(a, p + a.length); }
          if (c) hit += weight[f] * (1 + Math.log2(c)) + (f === "title" && it._ix.title.n.startsWith(a) ? 6 : 0);
        }
      }
      if (!hit) { ok = false; break; }
      score += hit;
    }
    if (!ok) continue;
    if (exc.some((t) => fields.some((f) => it._ix[f].n.includes(t)))) continue;
    base.push({ it, score });
  }
  // 区分ごとの件数（区分で絞る前）
  const counts = {};
  for (const r of base) counts[r.it.kubun] = (counts[r.it.kubun] || 0) + 1;
  renderCats(counts, base.length);

  results = state.cat ? base.filter((r) => r.it.kubun === state.cat) : base;
  const sort = state.sort === "rel" && !inc.length ? "new" : state.sort;
  const byNew = (a, b) => (b.it.date || "").localeCompare(a.it.date || "") || a.it._order - b.it._order;
  results.sort({
    rel: (a, b) => b.score - a.score || byNew(a, b),
    new: byNew,
    old: (a, b) => (a.it.date || "").localeCompare(b.it.date || "") || a.it._order - b.it._order,
    no: (a, b) => a.it._order - b.it._order,
  }[sort]);
  results.terms = inc.flat();
  const opt = (id) => $(id).selectedOptions[0].textContent.replace(/（.*）/, "");
  $("optsSum").textContent = "検索条件：" + [opt("field"), opt("sort"),
    state.hideDeleted ? "削除済み除く" : "削除済み含む", !state.kokuho && "国保分除く", state.updatedOnly && "更新・削除のみ"]
    .filter(Boolean).join("・");
  shown = 0;
  $("list").innerHTML = "";
  renderMore();
  const q = state.q.trim();
  $("count").textContent = results.length
    ? `${results.length}件${q ? `（「${q}」）` : ""}${!inc.length && state.sort === "rel" ? " ・公表日が新しい順" : ""}`
    : "";
  if (!results.length) $("list").innerHTML = `<li class="empty">該当する事例がありません。<br>別の表記（一般名・商品名・区分番号など）でもお試しください。</li>`;
  $("help").hidden = !!q;
}

/* ---------- 描画 ---------- */
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function ranges(ix, terms) {
  const r = [];
  for (const t of terms) {
    let p = ix.n.indexOf(t);
    while (p !== -1) {
      r.push([ix.map[p], ix.map[p + t.length - 1] + 1]);
      p = ix.n.indexOf(t, p + t.length);
    }
  }
  r.sort((a, b) => a[0] - b[0]);
  const m = [];
  for (const x of r) {
    if (m.length && x[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], x[1]);
    else m.push(x);
  }
  return m;
}
function highlight(str, ix, terms, from = 0, to = str.length) {
  let out = "", pos = from;
  for (const [a, b] of ranges(ix, terms)) {
    if (b <= from || a >= to) continue;
    const s = Math.max(a, from), e = Math.min(b, to);
    out += esc(str.slice(pos, s)) + "<mark>" + esc(str.slice(s, e)) + "</mark>";
    pos = e;
  }
  return out + esc(str.slice(pos, to));
}
function snippet(it, terms) {
  for (const f of ["rule", "basis"]) {
    const ix = it._ix[f];
    const rg = terms.length ? ranges(ix, terms) : [];
    if (rg.length || (!terms.length && f === "rule")) {
      const text = it[f].replace(/\n/g, " ");
      const at = rg.length ? rg[0][0] : 0;
      const from = Math.max(0, at - 30), to = Math.min(text.length, at + 90);
      const ixFlat = { n: ix.n, map: ix.map }; // 改行→空白は同じ長さなので対応表をそのまま使える
      return (from ? "…" : "") + highlight(text, ixFlat, terms, from, to) + (to < text.length ? "…" : "");
    }
  }
  return "";
}
function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || "");
  if (!m) return d || "";
  const y = +m[1], era = y >= 2019 ? ["令和", y - 2018] : ["平成", y - 1988];
  return `${era[0]}${era[1] === 1 ? "元" : era[1]}年${+m[2]}月${+m[3]}日`;
}
function card(it, terms) {
  const li = $("tpl").content.firstElementChild.cloneNode(true);
  if (it.status === "削除") li.classList.add("deleted");
  const tags = [`<span class="tag">${esc(it.kubun)}</span>`];
  if (it.src !== "支払基金") tags.push(`<span class="tag kk">国保中央会合意</span>`);
  if (it.status) tags.push(`<span class="tag ${it.status === "削除" ? "del" : "upd"}">${it.status} ${esc(it.statusDate)}</span>`);
  tags.push(`<span class="tag plain">${esc([it.kai, fmtDate(it.date)].filter(Boolean).join("・"))}</span>`);
  li.querySelector(".tags").innerHTML = tags.join("");
  li.querySelector(".title").innerHTML = highlight(it.title, it._ix.title, terms);
  li.querySelector(".snippet").innerHTML = snippet(it, terms);
  const head = li.querySelector(".head"), body = li.querySelector(".body");
  head.addEventListener("click", () => {
    const open = body.hidden;
    if (open && !body.dataset.filled) {
      li.querySelector(".rule").innerHTML = highlight(it.rule, it._ix.rule, terms);
      if (it.basis) li.querySelector(".basis").innerHTML = highlight(it.basis, it._ix.basis, terms);
      else { li.querySelector(".basisH").remove(); li.querySelector(".basis").remove(); }
      const src = it.src === "支払基金" ? DATA.source : "https://www.kokuho.or.jp/inspect/jirei/";
      li.querySelector(".foot").innerHTML =
        `${esc(it.src)} №${esc(it.no)}${it.kubunNo ? `（区分No.${esc(it.kubunNo)}）` : ""}・公表 ${esc(fmtDate(it.date))}${it.kai ? `（${esc(it.kai)}）` : ""}<br><a href="${src}" target="_blank" rel="noopener">公式ページで確認 ↗</a>`;
      body.dataset.filled = "1";
    }
    body.hidden = !open;
    li.querySelector(".snippet").hidden = open;
    head.setAttribute("aria-expanded", String(open));
  });
  return li;
}
function renderMore() {
  const frag = document.createDocumentFragment();
  for (const r of results.slice(shown, shown + PAGE)) frag.appendChild(card(r.it, results.terms));
  $("list").appendChild(frag);
  shown = Math.min(results.length, shown + PAGE);
  $("more").hidden = shown >= results.length;
  $("more").textContent = `さらに表示（残り ${results.length - shown} 件）`;
}
function renderCats(counts, total) {
  const cats = Object.keys(counts).sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (state.cat && !counts[state.cat]) cats.push(state.cat);
  $("cats").innerHTML = [["", "すべて", total], ...cats.map((c) => [c, c, counts[c] || 0])]
    .map(([v, label, n]) => `<button class="chip" type="button" data-cat="${esc(v)}" aria-pressed="${state.cat === v}">${esc(label)}<small>${n}</small></button>`)
    .join("");
}

/* ---------- URL との同期（共有・戻る操作用） ---------- */
function toHash() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.cat) p.set("cat", state.cat);
  if (state.field !== "all") p.set("f", state.field);
  history.replaceState(null, "", p.toString() ? "#" + p : location.pathname + location.search);
}
function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get("q") || "";
  state.cat = p.get("cat") || "";
  state.field = p.get("f") || "all";
  $("q").value = state.q;
  $("field").value = state.field;
  $("clear").hidden = !state.q;
}

let timer;
function update() { toHash(); search(); }

async function init() {
  fromHash();
  try {
    const res = await fetch("data/atukai.json", { cache: "no-cache" });
    DATA = await res.json();
  } catch (e) {
    $("meta").textContent = "データを読み込めませんでした。通信状態を確認してください。";
    return;
  }
  DATA.items.forEach((it, i) => {
    it._order = i;
    it._ix = Object.fromEntries(FIELDS.map((f) => [f, indexText(it[f] || "")]));
  });
  $("meta").textContent = `${DATA.asOf || ""}・全${DATA.count}件・最新 ${DATA.latestKai}（${fmtDate(DATA.latestDate)}公表）`;

  $("q").addEventListener("input", () => {
    state.q = $("q").value;
    $("clear").hidden = !state.q;
    clearTimeout(timer);
    timer = setTimeout(update, 150);
  });
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.target.blur(); } });
  $("clear").addEventListener("click", () => { $("q").value = state.q = ""; $("clear").hidden = true; update(); $("q").focus(); });
  $("field").addEventListener("change", (e) => { state.field = e.target.value; update(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; update(); });
  for (const k of ["hideDeleted", "kokuho", "updatedOnly"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked; update(); });
  $("cats").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (b) { state.cat = b.dataset.cat; update(); }
  });
  $("more").addEventListener("click", renderMore);
  window.addEventListener("hashchange", () => { fromHash(); search(); });
  search();
}

init();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");

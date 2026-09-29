"use strict";

const SOURCES = {
  ssk: { file: "data/atukai.json", label: "支払基金", name: "支払基金における審査の一般的な取扱い（医科）",
    page: "https://www.ssk.or.jp/shinryohoshu/sinsa_jirei/kikin_shinsa_atukai/shinsa_atukai_i/index.html" },
  kokuho: { file: "data/kokuho.json", label: "国保中央会", name: "国民健康保険中央会 審査情報提供事例（医科）",
    page: "https://www.kokuho.or.jp/inspect/jirei/ika/index.html" },
};
const CAT_ORDER = ["初・再診料", "入院料等", "医学管理等", "在宅医療", "検査", "画像診断", "投薬", "注射",
  "リハビリテーション", "精神科専門療法", "処置", "手術", "麻酔", "放射線療法", "放射線治療", "病理診断", "その他", "食事"];
const FIELDS = ["title", "rule", "basis"];
const PAGE = 40;
const $ = (id) => document.getElementById(id);

const DATA = {};          // src -> 読み込んだ JSON
let results = [];
let shown = 0;
const state = { src: "ssk", q: "", field: "all", sort: "rel", cat: "", hideDeleted: true, kokuho: true, updatedOnly: false };

/* ---------- 正規化：全角半角・大文字小文字・かなカナ・ハイフン類・空白・かぎ括弧の違いを吸収 ---------- */
const DROP = /[\s「」『』]/;
const DASH = /[‐-―−⁻₋﹣－]/;
function normChar(c) {
  const s = c.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of s) {
    if (DROP.test(ch)) continue;
    if (DASH.test(ch)) { out += "-"; continue; }
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

/* ---------- データ読み込み ---------- */
const activeSources = () => (state.src === "both" ? ["ssk", "kokuho"] : [state.src]);

async function load(src) {
  if (DATA[src]) return DATA[src];
  const res = await fetch(SOURCES[src].file, { cache: "no-cache" });
  if (!res.ok) throw new Error(res.status);
  const d = await res.json();
  d.items.forEach((it, i) => {
    it._src = src;
    it._order = (src === "ssk" ? 0 : 100000) + i;
    it._no = normalize(it.no || "");
    it._ix = Object.fromEntries(FIELDS.map((f) => [f, indexText(it[f] || "")]));
  });
  return (DATA[src] = d);
}

/* 支払基金と国保中央会で同じ事例の対応表（scripts/match_pairs.py が生成） */
let PAIRS = null;
async function loadPairs() {
  if (PAIRS) return;
  try {
    const res = await fetch("data/pairs.json", { cache: "no-cache" });
    PAIRS = res.ok ? await res.json() : { pairs: [] };
  } catch (e) {
    PAIRS = { pairs: [] }; // 対応表が無くても検索自体はできるようにする
  }
}
/** 読み込み済みのデータに対応表を結び付ける（_pair: 対応情報, _partner: 相手の事例） */
function linkPairs() {
  if (!PAIRS) return;
  const byId = {};
  for (const s of Object.keys(DATA)) for (const it of DATA[s].items) byId[it.id] = it;
  for (const p of PAIRS.pairs) {
    const a = byId[p.ssk], b = byId[p.kk];
    if (a) { a._pair = p; a._partner = b || null; }
    if (b) { b._pair = p; b._partner = a || null; }
  }
}

/* ---------- 検索 ---------- */
function scoreItem(it, inc, exc, fields) {
  const weight = { title: 12, rule: 4, basis: 1 };
  let score = 0;
  for (const alts of inc) {
    let hit = 0;
    for (const a of alts) {
      if (it._src === "kokuho" && state.field !== "rule" && state.field !== "basis" && it._no === a) hit += 100; // 項番（D-390 等）
      for (const f of fields) {
        const n = it._ix[f].n;
        let p = n.indexOf(a), c = 0;
        while (p !== -1 && c < 5) { c++; p = n.indexOf(a, p + a.length); }
        if (c) hit += weight[f] * (1 + Math.log2(c)) + (f === "title" && it._ix.title.n.startsWith(a) ? 6 : 0);
      }
    }
    if (!hit) return -1;
    score += hit;
  }
  if (exc.some((t) => fields.some((f) => it._ix[f].n.includes(t)))) return -1;
  return score;
}

function search() {
  const srcs = activeSources().filter((s) => DATA[s]);
  const merge = state.src === "both";
  const { inc, exc } = parseQuery(state.q);
  const fields = state.field === "all" ? FIELDS : [state.field];
  const base = [];
  for (const src of srcs) for (const it of DATA[src].items) {
    // 「両方」では、対応する事例を支払基金側の 1 件にまとめる
    const partner = merge && it._partner ? it._partner : null;
    if (partner && src === "kokuho") continue;
    if (state.hideDeleted && it.status === "削除") continue;
    if (!partner && !state.kokuho && src === "ssk" && it.src !== "支払基金") continue;
    if (state.updatedOnly && !it.status && !(partner && partner.status)) continue;
    const score = Math.max(scoreItem(it, inc, exc, fields), partner ? scoreItem(partner, inc, exc, fields) : -1);
    if (score < 0) continue;
    const date = partner && (partner.date || "") > (it.date || "") ? partner.date : it.date;
    base.push({ it, partner, score, date: date || "" });
  }
  // 区分ごとの件数（区分で絞る前）
  const counts = {};
  for (const r of base) counts[r.it.kubun] = (counts[r.it.kubun] || 0) + 1;
  renderCats(counts, base.length);

  results = state.cat ? base.filter((r) => r.it.kubun === state.cat || (r.partner && r.partner.kubun === state.cat)) : base;
  const sort = state.sort === "rel" && !inc.length ? "new" : state.sort;
  const byNew = (a, b) => b.date.localeCompare(a.date) || a.it._order - b.it._order;
  results.sort({
    rel: (a, b) => b.score - a.score || byNew(a, b),
    new: byNew,
    old: (a, b) => a.date.localeCompare(b.date) || a.it._order - b.it._order,
    no: (a, b) => a.it._order - b.it._order,
  }[sort]);
  results.merged = results.filter((r) => r.partner).length;
  results.terms = inc.flat();
  shown = 0;
  $("list").innerHTML = "";
  renderMore();
  const q = state.q.trim();
  $("count").textContent = results.length
    ? `${results.length}件${q ? `（「${q}」）` : ""}${results.merged ? `・うち支払基金と国保の共通事例 ${results.merged}件をまとめて表示` : ""}${!inc.length && state.sort === "rel" ? "・公表日が新しい順" : ""}`
    : "";
  if (!results.length) $("list").innerHTML = `<li class="empty">該当する事例がありません。<br>別の表記（一般名・商品名・区分番号など）でもお試しください。</li>`;
  $("help").hidden = !!q;

  const opt = (id) => $(id).selectedOptions[0].textContent.replace(/（.*）/, "");
  $("optsSum").textContent = "検索条件：" + [opt("field"), opt("sort"),
    state.hideDeleted ? "削除済み除く" : "削除済み含む", !state.kokuho && state.src !== "kokuho" && "国保合意分除く", state.updatedOnly && "更新・削除のみ"]
    .filter(Boolean).join("・");
}

/* ---------- 描画 ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
/** 検索語を <mark>、diffs（文言差の範囲）を <span class="df"> で囲んで HTML にする */
function highlight(str, ix, terms, from = 0, to = str.length, diffs = []) {
  const flag = new Uint8Array(to - from);
  const paint = (rs, bit) => {
    for (const [a, b] of rs) for (let i = Math.max(a, from); i < Math.min(b, to); i++) flag[i - from] |= bit;
  };
  paint(ranges(ix, terms), 1);
  paint(diffs, 2);
  let out = "";
  for (let i = 0; i < flag.length;) {
    let j = i;
    while (j < flag.length && flag[j] === flag[i]) j++;
    let seg = esc(str.slice(from + i, from + j));
    if (flag[i] & 1) seg = `<mark>${seg}</mark>`;
    if (flag[i] & 2) seg = `<span class="df">${seg}</span>`;
    out += seg;
    i = j;
  }
  return out;
}

/** 2 つの文章の違う部分（空白・全角半角・ハイフン類の違いは無視）を、それぞれの元の位置で返す */
function diffRanges(a, b) {
  const pick = (s) => {
    const cs = [], pos = [];
    for (let i = 0; i < s.length; i++) {
      const c = normChar(s[i]).replace(/[ー一]/g, "-");
      if (c) { cs.push(c); pos.push(i); }
    }
    return { cs, pos };
  };
  const A = pick(a), B = pick(b), n = A.cs.length, m = B.cs.length;
  if (n * m > 6e6) return [[], []];
  const w = m + 1, L = new Uint16Array((n + 1) * w); // 最長共通部分列
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i * w + j] = A.cs[i] === B.cs[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const ka = new Uint8Array(n), kb = new Uint8Array(m);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (A.cs[i] === B.cs[j]) { ka[i++] = 1; kb[j++] = 1; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) i++;
    else j++;
  }
  const toRanges = (keep, P) => {
    const r = [];
    for (let i = 0; i < keep.length; i++) if (!keep[i]) {
      const s = P.pos[i];
      if (r.length && r[r.length - 1][1] >= s) r[r.length - 1][1] = s + 1; else r.push([s, s + 1]);
    }
    return r;
  };
  return [toRanges(ka, A), toRanges(kb, B)];
}
function snippet(it, terms) {
  const hitIn = (f) => terms.length && ranges(it._ix[f], terms).length;
  const fallback = !hitIn("rule") && !hitIn("basis"); // 題名・項番だけに一致したときは取扱いの冒頭を表示
  for (const f of ["rule", "basis"]) {
    const ix = it._ix[f];
    const rg = terms.length ? ranges(ix, terms) : [];
    if (rg.length || (fallback && f === "rule")) {
      const text = it[f].replace(/\n/g, " "); // 改行→空白は同じ長さなので対応表をそのまま使える
      const at = rg.length ? rg[0][0] : 0;
      const from = Math.max(0, at - 30), to = Math.min(text.length, at + 90);
      return (from ? "…" : "") + highlight(text, ix, terms, from, to) + (to < text.length ? "…" : "");
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
  const kk = it._src === "kokuho";
  const tags = [];
  if (state.src === "both") tags.push(`<span class="tag ${kk ? "src-kk" : "src-ssk"}">${kk ? "国保中央会" : "支払基金"}</span>`);
  tags.push(`<span class="tag">${esc(it.kubun)}</span>`);
  if (kk) tags.push(`<span class="tag no">${esc(it.no)}</span>`);
  if (!kk && it.src !== "支払基金") tags.push(`<span class="tag kk">国保中央会合意</span>`);
  if (it.status) tags.push(`<span class="tag ${it.status === "削除" ? "del" : "upd"}">${it.status} ${esc(it.statusDate)}</span>`);
  if (it._pair) { // 片方だけ表示しているときも、もう一方に同じ事例があることを示す
    const other = kk ? `支払基金 №${it._pair.sskNo}` : `国保 ${it._pair.kkNo}`;
    tags.push(`<span class="tag also">${esc(other)}${it._pair.rule === "same" ? "と同一" : "と共通（文言差あり）"}</span>`);
  }
  tags.push(`<span class="tag plain">${esc([it.kai, fmtDate(it.date)].filter(Boolean).join("・"))}</span>`);
  li.querySelector(".tags").innerHTML = tags.join("");
  li.querySelector(".title").innerHTML = highlight(it.title, it._ix.title, terms);
  li.querySelector(".snippet").innerHTML = snippet(it, terms);
  const head = li.querySelector(".head"), body = li.querySelector(".body");
  head.addEventListener("click", () => {
    const open = body.hidden;
    if (open && !body.dataset.filled) {
      li.querySelector(".rule").innerHTML = highlight(it.rule, it._ix.rule, terms);
      if (it.basis) {
        li.querySelector(".basisH").textContent = kk ? "取扱いの根拠・留意事項等" : "取扱いを作成した根拠等";
        li.querySelector(".basis").innerHTML = highlight(it.basis, it._ix.basis, terms);
      } else { li.querySelector(".basisH").remove(); li.querySelector(".basis").remove(); }
      let foot, link;
      if (kk) {
        foot = `国保中央会 審査情報提供事例 ${esc(it.no)}・掲載 ${esc(fmtDate(it.date))}`;
        link = it.pdf ? `<a href="${esc(it.pdf)}" target="_blank" rel="noopener">公式PDFで確認 ↗</a>` : "";
      } else {
        foot = `${esc(it.src)} №${esc(it.no)}${it.kubunNo ? `（区分No.${esc(it.kubunNo)}）` : ""}・公表 ${esc(fmtDate(it.date))}${it.kai ? `（${esc(it.kai)}）` : ""}`;
        link = `<a href="${it.src === "支払基金" ? SOURCES.ssk.page : "https://www.kokuho.or.jp/inspect/jirei/"}" target="_blank" rel="noopener">公式ページで確認 ↗</a>`;
      }
      li.querySelector(".foot").innerHTML = `${foot}<br>${link}`;
      body.dataset.filled = "1";
    }
    body.hidden = !open;
    li.querySelector(".snippet").hidden = open;
    head.setAttribute("aria-expanded", String(open));
  });
  return li;
}
/** 支払基金と国保中央会の共通事例を 1 枚にまとめたカード（a: 支払基金, b: 国保中央会） */
function pairCard(a, b, terms) {
  const p = a._pair;
  const li = $("tpl").content.firstElementChild.cloneNode(true);
  li.classList.add("pair");
  const tags = [`<span class="tag src-both">支払基金・国保 共通</span>`, `<span class="tag">${esc(a.kubun)}</span>`,
    `<span class="tag no">№${esc(a.no)}</span>`, `<span class="tag no">${esc(b.no)}</span>`,
    p.rule === "same" ? `<span class="tag same">取扱い同一</span>` : `<span class="tag diff">文言差あり</span>`];
  for (const [label, it] of [["支払基金", a], ["国保", b]])
    if (it.status) tags.push(`<span class="tag upd">${label} ${it.status} ${esc(it.statusDate)}</span>`);
  li.querySelector(".tags").innerHTML = tags.join("");
  li.querySelector(".title").innerHTML = highlight(a.title, a._ix.title, terms);
  const hit = (it) => terms.length && (ranges(it._ix.rule, terms).length || ranges(it._ix.basis, terms).length);
  li.querySelector(".snippet").innerHTML = snippet(hit(a) || !hit(b) ? a : b, terms);

  const head = li.querySelector(".head"), body = li.querySelector(".body");
  head.addEventListener("click", () => {
    const open = body.hidden;
    if (open && !body.dataset.filled) {
      const sec = (h, html) => `<h3>${h}</h3><div class="txt">${html}</div>`;
      let html = "";
      if (normalize(a.title) !== normalize(b.title))
        html += `<p class="alt">国保中央会での題名：${highlight(b.title, b._ix.title, terms)}</p>`;
      if (p.rule === "same") {
        html += sec("取扱い（支払基金・国保 共通）", highlight(a.rule, a._ix.rule, terms));
      } else {
        const [da, db] = diffRanges(a.rule, b.rule);
        html += `<p class="dfnote"><span class="df">色付き</span>の部分が両者で異なる箇所です。</p>`;
        html += sec("取扱い（支払基金）", highlight(a.rule, a._ix.rule, terms, 0, a.rule.length, da));
        html += sec("取扱い（国保中央会）", highlight(b.rule, b._ix.rule, terms, 0, b.rule.length, db));
      }
      if (p.basis === "same" && a.basis) {
        html += sec("根拠等（支払基金・国保 共通）", highlight(a.basis, a._ix.basis, terms));
      } else {
        if (a.basis) html += sec("取扱いを作成した根拠等（支払基金）", highlight(a.basis, a._ix.basis, terms));
        if (b.basis) html += sec("取扱いの根拠・留意事項等（国保中央会）", highlight(b.basis, b._ix.basis, terms));
      }
      const sskLink = a.src === "支払基金" ? SOURCES.ssk.page : "https://www.kokuho.or.jp/inspect/jirei/";
      html += `<p class="foot">支払基金 №${esc(a.no)}・公表 ${esc(fmtDate(a.date))}${a.kai ? `（${esc(a.kai)}）` : ""}　<a href="${sskLink}" target="_blank" rel="noopener">公式ページ ↗</a><br>` +
        `国保中央会 ${esc(b.no)}・掲載 ${esc(fmtDate(b.date))}　${b.pdf ? `<a href="${esc(b.pdf)}" target="_blank" rel="noopener">公式PDF ↗</a>` : ""}</p>`;
      body.innerHTML = html;
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
  for (const r of results.slice(shown, shown + PAGE)) frag.appendChild(r.partner ? pairCard(r.it, r.partner, results.terms) : card(r.it, results.terms));
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
function renderMeta() {
  const lines = activeSources().filter((s) => DATA[s]).map((s) => {
    const d = DATA[s];
    const latest = s === "ssk" ? `最新 ${d.latestKai}（${fmtDate(d.latestDate)}公表）` : "";
    return `${state.src === "both" ? SOURCES[s].label + "：" : ""}${d.asOf || ""}・全${d.count}件${latest ? "・" + latest : ""}`;
  });
  $("meta").textContent = lines.join(" ／ ");
  for (const b of document.querySelectorAll("#srcSwitch button")) b.setAttribute("aria-pressed", String(b.dataset.src === state.src));
  $("kokuhoToggle").hidden = state.src === "kokuho";
  $("srcNote").innerHTML = activeSources()
    .map((s) => `<a href="${SOURCES[s].page}" target="_blank" rel="noopener">${esc(SOURCES[s].name)}</a>`).join("、");
  document.title = `審査取扱い検索（${state.src === "both" ? "支払基金＋国保" : SOURCES[state.src].label}）`;
}

/* ---------- URL との同期（共有・戻る操作用） ---------- */
function toHash() {
  const p = new URLSearchParams();
  if (state.src !== "ssk") p.set("s", state.src);
  if (state.q) p.set("q", state.q);
  if (state.cat) p.set("cat", state.cat);
  if (state.field !== "all") p.set("f", state.field);
  history.replaceState(null, "", p.toString() ? "#" + p : location.pathname + location.search);
}
function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let saved = null;
  try { saved = localStorage.getItem("src"); } catch (e) { /* 保存不可の環境 */ }
  const s = p.get("s") || saved || "ssk";
  state.src = s in SOURCES || s === "both" ? s : "ssk";
  state.q = p.get("q") || "";
  state.cat = p.get("cat") || "";
  state.field = p.get("f") || "all";
  $("q").value = state.q;
  $("field").value = state.field;
  $("clear").hidden = !state.q;
}

async function refresh() {
  toHash();
  const need = activeSources().filter((s) => !DATA[s]);
  if (need.length || !PAIRS) {
    $("meta").textContent = "読み込み中…";
    try {
      await Promise.all([...need.map(load), loadPairs()]);
    } catch (e) {
      $("meta").textContent = "データを読み込めませんでした。通信状態を確認してください。";
      return;
    }
    linkPairs();
  }
  renderMeta();
  search();
}

let timer;
function init() {
  fromHash();
  $("q").addEventListener("input", () => {
    state.q = $("q").value;
    $("clear").hidden = !state.q;
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("clear").addEventListener("click", () => { $("q").value = state.q = ""; $("clear").hidden = true; refresh(); $("q").focus(); });
  $("field").addEventListener("change", (e) => { state.field = e.target.value; refresh(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; refresh(); });
  for (const k of ["hideDeleted", "kokuho", "updatedOnly"]) $(k).addEventListener("change", (e) => { state[k] = e.target.checked; refresh(); });
  $("srcSwitch").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.src === state.src) return;
    state.src = b.dataset.src;
    state.cat = "";
    try { localStorage.setItem("src", state.src); } catch (err) { /* 保存不可の環境 */ }
    refresh();
  });
  $("cats").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (b) { state.cat = b.dataset.cat; refresh(); }
  });
  $("more").addEventListener("click", renderMore);
  window.addEventListener("hashchange", () => { fromHash(); refresh(); });
  refresh();
}

init();

/* ---------- アプリ本体の自動更新：新しい版が公開されたら自動で切り替える ---------- */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  const hadController = !!navigator.serviceWorker.controller; // 初回インストール時は再読み込みしない
  navigator.serviceWorker.register("sw.js").then((reg) => {
    setInterval(() => reg.update(), 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update(); });
  });
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    location.reload();
  });
}

/* ---------- データの自動更新：開きっぱなしでも、画面に戻ったとき 1 時間以上経っていれば再取得 ---------- */
let loadedAt = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || Date.now() - loadedAt < 60 * 60 * 1000) return;
  loadedAt = Date.now();
  for (const k of Object.keys(DATA)) delete DATA[k];
  PAIRS = null;
  refresh();
});

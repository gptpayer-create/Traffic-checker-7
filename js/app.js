/* ==========================================================
   app.js – GPTPayer Traffic Checker (index.html)
   ========================================================== */
(function () {
"use strict";

var $ = function (id) { return document.getElementById(id); };

/* ---------- helpers ---------- */
function clean(v) {
  v = v.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[\/?#]/)[0]
    .replace(/\.$/, "");                       // allow trailing dot: "example.com."
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : "";
}
function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  var k = Math.round(n / 1e3);
  if (n >= 1e6 || k >= 1000) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return k + "K";
  return Math.round(n) + "";
}
function esc(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function getJSON(u, ms) {
  var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms || 15000);
  return fetch(u, { signal: c.signal }).then(function (r) {
    clearTimeout(t);
    if (!r.ok) throw new Error("bad");
    return r.json();
  }, function (e) { clearTimeout(t); throw e; });
}
function empty(id, m) { $(id).innerHTML = '<p class="empty">' + m + "</p>"; }
function fdate(t, y) {
  return t.toLocaleDateString("en-GB", y ? { month: "short", year: "numeric" } : { day: "numeric", month: "short" });
}
function ago(iso) {
  var ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return "";
  var m = Math.floor(ms / 2629800000), y = Math.floor(m / 12);
  return y > 0 ? y + " yr " + (m % 12) + " mo" : m + " mo";
}
function spark(vals) {
  var w = 220, h = 40, mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), sp = (mx - mn) || 1;
  var pts = vals.map(function (v, i) {
    return (i * (w / Math.max(vals.length - 1, 1))).toFixed(1) + "," + (4 + (v - mn) / sp * (h - 8)).toFixed(1);
  }).join(" ");
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h +
    '" role="img" aria-label="Rank trend, higher line means better rank"><polyline fill="none" stroke="#ff5a1f" stroke-width="2.5" stroke-linejoin="round" points="' + pts + '"/></svg>';
}

/* ---------- state ---------- */
var runId = 0;                 // increments on every check; lets us ignore stale answers
var rankP;                     // promise: Tranco rank history for the current domain
var provP;                     // promise: optional external traffic-history provider
var H = [], cur = 0;
var DAY = 864e5;
var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var W = 640, HT = 270, PL = 48, PR = 10, PT = 10, PB = 28;
var RG = [["1D", 1], ["5D", 5], ["1M", 30], ["1Y", 365], ["5Y", 1825], ["Max", 1e9]], RGV = RG;

/* Optional: URL returning {history:[{date,visits}]} for ?domain – leave "" to use the rank-based estimate */
var CONFIG = { dataUrl: "" };

/* ---------- metrics ---------- */
var metrics = [
  { l: "Popularity rank", run: function (d) {
    rankP = getJSON("https://tranco-list.eu/api/ranks/domain/" + encodeURIComponent(d)).then(function (j) {
      return (j.ranks || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    });
    return rankP.then(function (r) {
      if (!r.length) return { v: "Not in top 1M", c: "mid", n: "Small or new sites usually have too little traffic to be ranked." };
      var last = r[r.length - 1].rank;
      return {
        v: "#" + last.toLocaleString("en-US"),
        c: last < 100000 ? "good" : "mid",
        n: "Among the world's most visited sites (1 is the busiest)." + (r.length > 1 ? " Last " + r.length + " days:" : ""),
        html: r.length > 1 ? spark(r.map(function (x) { return x.rank; })) : ""
      };
    });
  } },
  { l: "Server status", run: function (d) {
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, 9000), s = Date.now();
    return fetch("https://" + d, { mode: "no-cors", signal: c.signal, cache: "no-store" }).then(function () {
      clearTimeout(t);
      return { v: "Online", c: "good", n: "Answered in about " + (Date.now() - s) + " ms from your connection." };
    }, function () {
      clearTimeout(t);
      return { v: "No reply", c: "mid", n: "Your browser got no reply over HTTPS within 9 seconds. The site may block browser checks, so this does not always mean it is down." };
    });
  } },
  { l: "First seen on the web", run: function (d) {
    return getJSON("https://archive.org/wayback/available?timestamp=19960101&url=" + encodeURIComponent(d)).then(function (j) {
      var c = j.archived_snapshots && j.archived_snapshots.closest;
      if (!c) return { v: "Never archived", c: "mid", n: "The Internet Archive has no saved copy of this site." };
      var t = c.timestamp;
      return { v: t.slice(0, 4), c: "", n: "Earliest saved copy: " + t.slice(0, 4) + "-" + t.slice(4, 6) + "-" + t.slice(6, 8) + "." };
    });
  } }
];

/* ---------- chart ---------- */
function loadChart(my, pp, rp) {
  empty("chart", "Loading…"); $("chead").innerHTML = ""; $("cstats").innerHTML = ""; $("tabs").innerHTML = "";
  pp.then(function (j) {
    if (!j.history || j.history.length < 2) throw 0;
    return j.history.map(function (x) { return { t: new Date(x.date), v: +x.visits }; });
  }).catch(function () {
    return rp.then(function (r) {
      return r.map(function (x) { return { t: new Date(x.date), v: 8e10 / Math.pow(x.rank, .95) / 30 }; });
    });
  }).then(function (a) {
    if (my !== runId) return;
    H = a.sort(function (x, y) { return x.t - y.t; });
    if (H.length < 2) { empty("chart", "No traffic history for this domain. Sites outside the top 1 million are not ranked."); return; }
    var have = Math.round((H[H.length - 1].t - H[0].t) / DAY) + 1, top = 0;
    RGV = RG.filter(function (r) { if (r[1] < 1e9 && r[1] <= have) { top = r[1]; return true; } return false; });
    if (have > top) RGV.push(RG[RG.length - 1]);
    cur = RGV.length - 1;
    RGV.forEach(function (r, k) { if (r[0] === "1M") cur = k; });
    draw();
  }, function () {
    if (my === runId) empty("chart", "Traffic history could not be loaded right now.");
  });
}

function bucket(a, mode) {
  /* mode "w" = weekly, "m" = monthly: average of per-day values, so the chart stays per-day */
  var o = [], m = {}, key;
  a.forEach(function (p) {
    var d = new Date(p.t);
    if (mode === "m") key = d.getFullYear() + "-" + d.getMonth();
    else { var w = new Date(d); w.setDate(d.getDate() - ((d.getDay() + 6) % 7)); key = w.toISOString().slice(0, 10); }
    if (!m[key]) { m[key] = { t: p.t, s: 0, c: 0 }; o.push(m[key]); }
    m[key].s += p.v; m[key].c++;
  });
  return o.map(function (x) { return { t: x.t, v: x.s / x.c, mode: mode }; });
}

function draw() {
  var g = RGV[cur], end = H[H.length - 1].t;
  var cut = end - (g[1] > 1 && g[1] < 1e9 ? g[1] - 1 : g[1]) * DAY;
  var a = H.filter(function (p) { return p.t >= cut; });
  if (a.length < 2) a = H.slice(-2);
  var raw = a, mode = "";
  if (a.length > 500) { a = bucket(a, "m"); mode = "m"; }
  else if (a.length > 150) { a = bucket(a, "w"); mode = "w"; }
  var n = a.length, i, mn = Infinity, mx = -Infinity;
  if (n < 2) { a = raw; n = a.length; mode = ""; }
  a.forEach(function (p) { mn = Math.min(mn, p.v); mx = Math.max(mx, p.v); });
  var sp = (mx - mn) || mx * .1 || 1, lo = Math.max(0, mn - sp * .15), hi = mx + sp * .15, iw = W - PL - PR, ih = HT - PT - PB;
  function X(k) { return PL + k * iw / (n - 1); }
  function Y(v) { return PT + (hi - v) / (hi - lo) * ih; }
  var first = a[0].v, last = a[n - 1].v, ch = first ? (last - first) / first * 100 : 0, up = ch >= 0;
  var big = (a[n - 1].t - a[0].t) > 200 * DAY;
  var sum = 0; raw.forEach(function (p) { sum += p.v; });
  var total = g[1] === 1 ? last : sum;
  var label = g[0] === "Max" ? "all data" : g[0];

  $("chead").innerHTML = "<strong>" + fmt(total) + '</strong><span class="chg ' + (up ? "good" : "bad") + '">' +
    (up ? "▲ " : "▼ ") + Math.abs(ch).toFixed(1) + "%</span><small>total est. visits · " + label + "</small>";
  $("cstats").innerHTML = "<div><span>Est. ad revenue · " + label + "</span><b>~$" + fmt(total / 1000 * 2) + " – $" + fmt(total / 1000 * 10) + "</b></div>";
  $("tabs").innerHTML = RGV.map(function (r, k) {
    return '<button type="button" class="tab' + (k === cur ? " on" : "") + '" data-i="' + k + '">' + r[0] + "</button>";
  }).join("");

  var pts = a.map(function (p, k) { return X(k).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" ");
  var s = '<svg viewBox="0 0 ' + W + " " + HT + '" role="img" aria-label="Estimated visits per day">';
  for (i = 0; i < 4; i++) {
    var v = hi - (hi - lo) * i / 3, y = Y(v);
    s += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y + '" y2="' + y + '" stroke="#c5d8ce"/><text x="' + (PL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="12" fill="#4f6a60">' + fmt(v) + "</text>";
  }
  for (i = 0; i < 4; i++) {
    var k = Math.round(i * (n - 1) / 3);
    s += '<text x="' + X(k) + '" y="' + (HT - 8) + '" text-anchor="' + (i === 0 ? "start" : i === 3 ? "end" : "middle") + '" font-size="12" fill="#4f6a60">' + fdate(a[k].t, big) + "</text>";
  }
  s += '<polygon points="' + X(0) + "," + Y(lo) + " " + pts + " " + X(n - 1) + "," + Y(lo) + '" fill="#ff5a1f" fill-opacity=".12"/>' +
    '<polyline fill="none" stroke="#ff5a1f" stroke-width="2.5" stroke-linejoin="round" points="' + pts + '"/>' +
    '<line id="cl1" y1="' + PT + '" y2="' + (HT - PB) + '" stroke="#10261f" stroke-opacity=".4" visibility="hidden"/>' +
    '<text id="tl" font-size="13" font-weight="700" fill="#10261f" stroke="#fff" stroke-width="4" paint-order="stroke" visibility="hidden"></text>' +
    '<circle id="cd" r="5" cx="' + X(n - 1) + '" cy="' + Y(last) + '" fill="#ff5a1f"/></svg>';
  $("chart").innerHTML = s;

  var sv = $("chart").firstChild, ln = $("cl1"), cd = $("cd"), tl = $("tl");
  function mark(k) {
    cd.setAttribute("cx", X(k)); cd.setAttribute("cy", Y(a[k].v));
    ln.setAttribute("x1", X(k)); ln.setAttribute("x2", X(k)); ln.setAttribute("visibility", "visible");
    var left = k < n / 2;
    tl.textContent = fmt(a[k].v) + (a[k].mode ? "/day avg" : "") + " · " +
      (a[k].mode === "m" ? MON[a[k].t.getMonth()] + " " + a[k].t.getFullYear() : fdate(a[k].t, false));
    tl.setAttribute("x", X(k) + (left ? 8 : -8)); tl.setAttribute("y", PT + 14);
    tl.setAttribute("text-anchor", left ? "start" : "end"); tl.setAttribute("visibility", "visible");
  }
  sv.addEventListener("pointermove", function (e) {
    var r = sv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W, k = Math.round((x - PL) / iw * (n - 1));
    mark(Math.max(0, Math.min(n - 1, k)));
  });
}

/* ---------- WHOIS ---------- */
function kv(k, v) { return '<div class="kv"><span>' + k + "</span><div>" + v + "</div></div>"; }

function loadWhois(my, d) {
  empty("wl", "Loading…");
  getJSON("https://rdap.org/domain/" + encodeURIComponent(d)).then(function (j) {
    if (my !== runId) return;
    var ev = j.events || [];
    function E(a) {
      var x = ev.filter(function (e) { return e.eventAction === a; })[0];
      return x ? { d: new Date(x.eventDate), i: x.eventDate } : null;
    }
    function F(o) {
      return o && !isNaN(o.d) ? o.d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "–";
    }
    var c = E("registration"), u = E("last changed"), x = E("expiration"), reg = "–";
    (j.entities || []).forEach(function (en) {
      if ((en.roles || []).indexOf("registrar") > -1 && en.vcardArray) {
        en.vcardArray[1].forEach(function (f) { if (f[0] === "fn") reg = f[3]; });
      }
    });
    var ns = (j.nameservers || []).map(function (n) { return esc(String(n.ldhName).toLowerCase()); }).join("<br>") || "–";
    var st = (j.status || []).map(esc).join("<br>") || "–";
    $("wl").innerHTML = kv("Created", F(c) + (c ? " (" + ago(c.i) + " old)" : "")) + kv("Updated", F(u)) + kv("Expires", F(x)) +
      kv("Registrar", esc(reg)) + kv("Nameservers", ns) + kv("EPP status codes", st);
  }, function () {
    if (my === runId) empty("wl", "WHOIS details could not be loaded right now. Try again in a moment.");
  });
}

/* ---------- DNS ---------- */
function loadDns(my, d) {
  empty("dl", "Loading…");
  var T = [["A", 1], ["AAAA", 28], ["MX", 15], ["NS", 2]], failed = 0;
  Promise.all(T.map(function (t) {
    return getJSON("https://dns.google/resolve?name=" + encodeURIComponent(d) + "&type=" + t[0]).then(function (j) {
      return (j.Answer || []).filter(function (x) { return x.type === t[1]; }).map(function (x) { return { t: t[0], c: x.data }; });
    }, function () { failed++; return []; });
  })).then(function (r) {
    if (my !== runId) return;
    var rows = [].concat.apply([], r).slice(0, 10);
    if (rows.length) {
      $("dl").innerHTML = '<div class="dns"><b>Type</b><b>Name</b><b>Content</b></div>' + rows.map(function (x) {
        return '<div class="dns"><span>' + x.t + "</span><span>" + esc(d) + "</span><span>" + esc(x.c) + "</span></div>";
      }).join("");
    } else {
      empty("dl", failed === T.length ? "DNS records could not be loaded right now." : "No DNS records found.");
    }
  });
}

/* ---------- run a check ---------- */
function run() {
  var d = clean($("d").value);
  if (!d) { $("msg").textContent = "Enter a valid domain, like example.com"; return; }
  var my = ++runId;
  $("msg").textContent = "";
  $("res").hidden = false;
  $("rt").textContent = "Results for " + d;
  $("ml").innerHTML = metrics.map(function (m, i) {
    return '<div class="m"><div><b>' + m.l + '</b></div><strong id="v' + i + '" class="wait">Checking…</strong></div>';
  }).join("");
  $("res").scrollIntoView({ behavior: "smooth", block: "start" });

  rankP = Promise.reject(); rankP.catch(function () {});
  provP = CONFIG.dataUrl ? getJSON(CONFIG.dataUrl + encodeURIComponent(d), 30000) : Promise.reject();
  provP.catch(function () {});

  metrics.forEach(function (m, i) {
    var p; try { p = m.run(d); } catch (e) { p = Promise.reject(e); }
    p.then(function (o) {
      if (my !== runId) return;
      var v = $("v" + i), box = v.parentNode.firstChild;
      v.className = o.c || ""; v.textContent = o.v;
      if (o.n) box.insertAdjacentHTML("beforeend", "<p>" + esc(o.n) + "</p>");
      if (o.html) box.insertAdjacentHTML("beforeend", o.html);
    }, function () {
      if (my !== runId) return;
      var v = $("v" + i); v.className = "wait"; v.textContent = "Unavailable";
    });
  });

  /* metrics[0].run() has just replaced rankP with the real request */
  loadChart(my, provP, rankP);
  loadWhois(my, d);
  loadDns(my, d);
}

/* ---------- events ---------- */
$("tabs").addEventListener("click", function (e) {
  var k = e.target.getAttribute("data-i");
  if (k !== null) { cur = +k; draw(); }
});
$("go").addEventListener("click", run);
$("d").addEventListener("keydown", function (e) {
  if (e.key === "Enter") { e.preventDefault(); run(); }
});
})();

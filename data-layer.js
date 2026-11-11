/* js/data-layer.js
   เชื่อม Supabase กับแอป Gantt เดิม: แอปยังอ่าน/เขียน localStorage เหมือนเดิม (เป็นแคช)
   - หลังล็อกอิน: ดึงข้อมูลจาก Supabase ลงแคช
   - เมื่อแอปบันทึก: ส่งเฉพาะส่วนที่เปลี่ยน (เทียบกับ snapshot) ขึ้น Supabase */
(function () {
"use strict";
var CFG = window.APP_CONFIG || {};
var KEYS = { yearly: "lot10_yearly_project_v1", extra: "lot10_project_extra_v1", board: "lot10_board_v1" };
var DATE_RE = /^\d{1,2}-[A-Za-z]{3}-(\d{2}|\d{4})( to \d{1,2}-[A-Za-z]{3}-(\d{2}|\d{4}))?$/;
var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
var rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
var DL = { role: null, username: null, canEdit: false };
var sb = null, snap = null, timer = null, running = false, again = false, pulling = false;

function readKey(k, def) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : def; } catch (e) { return def; } }
function put(k, v) { pulling = true; try { rawSet.call(localStorage, k, JSON.stringify(v)); } finally { pulling = false; } }
function setStatus(t) { var el = document.getElementById("saveStatus"); if (el) el.textContent = t; }
function isYear(y) { return /^\d{4}$/.test(y); }
function sig(t) { return JSON.stringify([t.phase, t.no, t.task, t.date_text, t.color]); }
function tkey(p, t) { return p + "|" + t.phase + "|" + t.task + "|" + t.date_text; }
function friendly(e) {
  if (e && e.code === "23505") return "ข้อมูลซ้ำ (กิจกรรม/วันหยุดที่เหมือนกัน)";
  if (e && e.code === "42501") return "ไม่มีสิทธิ์แก้ไข";
  return (e && e.message) || "ไม่ทราบสาเหตุ";
}
async function ok(q) { var r = await q; if (r.error) throw r.error; return r.data; }
async function fetchAll(table, cols, orders) {
  var out = [], from = 0;
  for (;;) {
    var q = sb.from(table).select(cols);
    orders.forEach(function (o) { q = q.order(o); });
    var rows = await ok(q.range(from, from + 999));
    out = out.concat(rows);
    if (rows.length < 1000) return out;
    from += 1000;
  }
}

/* ---------- Auth ---------- */
DL.init = async function () {
  if (!window.supabase || !CFG.SUPABASE_URL || !CFG.SUPABASE_KEY || /YOUR_/.test(CFG.SUPABASE_URL + CFG.SUPABASE_KEY))
    throw new Error("ยังไม่ได้ตั้งค่า js/config.js");
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
  var r = await sb.auth.getSession();
  return !!(r.data && r.data.session);
};
DL.signIn = async function (email, pw) {
  var r = await sb.auth.signInWithPassword({ email: email, password: pw }); if (r.error) throw r.error;
};
DL.signUp = async function (email, pw, username) {
  var r = await sb.auth.signUp({ email: email, password: pw, options: { data: { username: username } } }); if (r.error) throw r.error;
};
DL.loadProfile = async function () {
  var u = (await sb.auth.getUser()).data.user;
  if (!u) throw new Error("ไม่พบผู้ใช้");
  var p = await ok(sb.from("profiles").select("username,role").eq("id", u.id).single());
  DL.username = p.username; DL.role = p.role; DL.canEdit = p.role === "admin" || p.role === "editor";
  return p.role;
};
DL.signOut = async function () {
  try { await DL.flush(); } catch (e) {}
  snap = null; DL.canEdit = false;
  Object.keys(KEYS).forEach(function (k) { rawRemove.call(localStorage, KEYS[k]); });
  if (sb) await sb.auth.signOut();
};

/* ---------- Pull: Supabase -> แคช localStorage ---------- */
DL.pull = async function () {
  var projects = await fetchAll("projects", "id,year,name", ["year"]);
  var tasks = await fetchAll("tasks", "id,project_id,phase,no,task,date_text,color", ["project_id", "phase", "no", "id"]);
  var hols = await fetchAll("holidays", "id,project_id,date,name", ["project_id", "date", "id"]);
  var boards = await fetchAll("boards", "project_id,data", ["project_id"]);
  var yearOf = {}, yearly = {}, names = {}, holidays = {}, boardOut = {};
  snap = { projects: {}, tasks: {}, hol: {}, boards: {} };
  projects.forEach(function (p) {
    var y = String(p.year); yearOf[p.id] = y; yearly[y] = []; holidays[y] = []; names[y] = p.name || "";
    snap.projects[y] = { id: p.id, name: p.name || "" };
  });
  tasks.forEach(function (t) {
    var y = yearOf[t.project_id]; if (!y) return;
    yearly[y].push({ _id: t.id, phase: t.phase, no: t.no, task: t.task, date: t.date_text, color: t.color });
    snap.tasks[t.id] = { project: t.project_id, key: tkey(t.project_id, t), sig: sig(t) };
  });
  hols.forEach(function (h) {
    var y = yearOf[h.project_id]; if (!y) return;
    holidays[y].push({ id: h.id, name: h.name, date: h.date });
    snap.hol[h.project_id + "|" + h.date + "|" + h.name] = h.id;
  });
  boards.forEach(function (b) {
    var y = yearOf[b.project_id]; if (!y) return;
    boardOut[y] = b.data; snap.boards[y] = JSON.stringify(b.data);
  });
  put(KEYS.yearly, yearly); put(KEYS.extra, { names: names, holidays: holidays }); put(KEYS.board, boardOut);
};

/* ---------- Push: แคช -> Supabase (เฉพาะที่เปลี่ยน) ---------- */
async function push() {
  if (!snap || !DL.canEdit) return;
  if (running) { again = true; return; }
  running = true;
  try {
    setStatus("Saving…");
    var yearly = readKey(KEYS.yearly, {}), extra = readKey(KEYS.extra, {}), boards = readKey(KEYS.board, {});
    var names = extra.names || {}, hols = extra.holidays || {};
    var years = Object.keys(yearly).filter(isYear);

    for (var yi = 0; yi < years.length; yi++) {               // ปีใหม่
      var y = years[yi];
      if (!snap.projects[y]) {
        var rows = await ok(sb.from("projects").upsert({ year: Number(y) }, { onConflict: "year" }).select("id,name"));
        snap.projects[y] = { id: rows[0].id, name: rows[0].name || "" };
      }
    }
    for (yi = 0; yi < years.length; yi++) {
      y = years[yi];
      var pid = snap.projects[y].id;

      if (typeof names[y] === "string" && names[y] !== snap.projects[y].name) {   // ชื่อโปรเจกต์
        await ok(sb.from("projects").update({ name: names[y].slice(0, 200) }).eq("id", pid).select("id"));
        snap.projects[y].name = names[y];
      }

      var byKey = {};                                            // กิจกรรม
      Object.keys(snap.tasks).forEach(function (id) { if (snap.tasks[id].project === pid) byKey[snap.tasks[id].key] = id; });
      var claimed = {}, ins = [], upd = [];
      (yearly[y] || []).forEach(function (t) {
        var row = { phase: t.phase, no: Number(t.no), task: String(t.task || "").trim(), date_text: String(t.date || "").trim(), color: t.color };
        var id = t._id && snap.tasks[t._id] ? t._id : byKey[tkey(pid, row)];
        if (id) claimed[id] = true;
        if (!row.task || !DATE_RE.test(row.date_text) || !(row.no >= 1)) return;   // ยังกรอกไม่ครบ ข้ามไปก่อน
        if (id) { if (snap.tasks[id].sig !== sig(row)) upd.push({ id: id, row: row }); }
        else { row.project_id = pid; ins.push(row); }
      });
      var del = Object.keys(snap.tasks).filter(function (id) { return snap.tasks[id].project === pid && !claimed[id]; });
      if (del.length) { await ok(sb.from("tasks").delete().in("id", del).select("id")); del.forEach(function (id) { delete snap.tasks[id]; }); }
      for (var ui = 0; ui < upd.length; ui++) {
        await ok(sb.from("tasks").update(upd[ui].row).eq("id", upd[ui].id).select("id"));
        snap.tasks[upd[ui].id] = { project: pid, key: tkey(pid, upd[ui].row), sig: sig(upd[ui].row) };
      }
      if (ins.length) {
        var created = await ok(sb.from("tasks").insert(ins).select("id,project_id,phase,no,task,date_text,color"));
        created.forEach(function (c) { snap.tasks[c.id] = { project: pid, key: tkey(pid, c), sig: sig(c) }; });
      }

      var want = {}, hIns = [];                                  // วันหยุด
      (hols[y] || []).forEach(function (h) {
        var name = String(h.name || "Holiday").trim().slice(0, 100) || "Holiday";
        if (!ISO_RE.test(h.date || "")) return;
        var k = pid + "|" + h.date + "|" + name; want[k] = true;
        if (!snap.hol[k]) { hIns.push({ project_id: pid, date: h.date, name: name }); snap.hol[k] = "pending"; }
      });
      var hDel = Object.keys(snap.hol).filter(function (k) { return k.indexOf(pid + "|") === 0 && !want[k]; });
      var hDelIds = hDel.filter(function (k) { return snap.hol[k] !== "pending"; }).map(function (k) { return snap.hol[k]; });
      if (hDelIds.length) await ok(sb.from("holidays").delete().in("id", hDelIds).select("id"));
      hDel.forEach(function (k) { delete snap.hol[k]; });
      if (hIns.length) {
        try {
          var hc = await ok(sb.from("holidays").insert(hIns).select("id,project_id,date,name"));
          hc.forEach(function (h) { snap.hol[h.project_id + "|" + h.date + "|" + h.name] = h.id; });
        } catch (e) { hIns.forEach(function (h) { delete snap.hol[h.project_id + "|" + h.date + "|" + h.name]; }); throw e; }
      }

      var b = boards[y];                                         // Board
      if (b) {
        var s = JSON.stringify(b), empty = !(b.strokes && b.strokes.length) && !(b.items && b.items.length);
        if (s !== snap.boards[y] && !(empty && snap.boards[y] === undefined)) {
          await ok(sb.from("boards").upsert({ project_id: pid, data: b }, { onConflict: "project_id" }).select("project_id"));
          snap.boards[y] = s;
        }
      }
    }
    var d = new Date();
    setStatus("✓ Synced " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"));
  } catch (e) {
    setStatus("⚠ บันทึกขึ้นระบบไม่สำเร็จ: " + friendly(e));
    console.error("sync error", e);
  } finally {
    running = false;
    if (again) { again = false; schedule(); }
  }
}
function schedule() { clearTimeout(timer); timer = setTimeout(function () { timer = null; push(); }, 1500); }
DL.flush = async function () { if (timer) { clearTimeout(timer); timer = null; await push(); } };

DL.startSync = function () {
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (this === localStorage && !pulling && snap && DL.canEdit && /^lot10_/.test(k)) schedule();
  };
  window.addEventListener("beforeunload", function (e) { if (timer || running) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") DL.flush(); });
};

window.DL = DL;
})();

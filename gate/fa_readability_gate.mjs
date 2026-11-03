#!/usr/bin/env node
/**
 * گیت خوانایی فارسی همنشین — Hamneshin Persian Readability Gate (v1)
 *
 * روش: به‌جای حدس‌زدن زمان‌ها از روی کد (رگکس روی متن GSAP)، تایم‌لاین واقعی
 * کامپوزیشن در مرورگر headless اجرا و نمونه‌برداری (seek + sample) می‌شود.
 * پس هر الگوی کدنویسی — tl.add، تایم‌لاین تو‌در‌تو، لیبل، from/fromTo/to —
 * دقیقاً همان‌طور سنجیده می‌شود که رندر می‌شود.
 *
 * قوانین:
 *  R1 مکث خوانایی: هر متن فارسی باید پس از ساکن‌شدن (opacity کامل + توقف حرکت
 *     و اسکیل) دست‌کم max(floor, words × secPerWord) ثانیه روی قاب بماند.
 *  R2 letter-spacing روی متن فارسی ممنوع (پیوستگی حروف را می‌شکند).
 *  R3 فونت متن فارسی باید وزیرمتن باشد (قابل‌تغییر با ‎--font).
 *  R4 جهت بلوک متن فارسی باید rtl باشد.
 *  R5 نیم‌فاصله: الگوهای «می شود / نمی کند …» (فاصله به‌جای ZWNJ) خطاست.
 *  R6 پروفایل همنشین: مرکز متن باید در یک‌سوم بالایی قاب باشد (برگهٔ قفل).
 *  R8 حاشیهٔ امن افقی: پهنای واقعیِ رندرشدهٔ متن (Range rect) نباید از
 *     ۹۶٪ پهنای قاب بگذرد (scrollWidth برای متن وسط‌چین RTL قابل‌اعتماد نیست).
 *  R7 (کمکی، استاتیک) ease خطی ("none"/"linear") در اسکریپت ممنوع است،
 *     مگر خطی که ‎gate-allow-linear داشته باشد.
 *
 * استفاده:
 *   node fa_readability_gate.mjs <index.html|project-dir> [--json out.json]
 *        [--spw 0.50] [--floor 1.0] [--dt 0.05] [--font vazirmatn] [--no-hamneshin]
 * خروج: 0 = پاس، 1 = فیل، 2 = خطای زیرساخت
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- args ----------
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes("--" + name);
if (!positional.length) {
  console.error("usage: fa_readability_gate.mjs <index.html|project-dir> [--json out.json]");
  process.exit(2);
}
let htmlPath = path.resolve(positional[0]);
if (fs.statSync(htmlPath).isDirectory()) htmlPath = path.join(htmlPath, "index.html");
if (!fs.existsSync(htmlPath)) { console.error("index.html پیدا نشد:", htmlPath); process.exit(2); }

const SPW = parseFloat(opt("spw", "0.50"));     // ثانیه به‌ازای هر کلمه (کالیبره‌شده ۲۰۲۶-۱۱-۰۳ روی ۳ کلیپ واقعی همنشین؛ CALIBRATION-fa.md)
const FLOOR = parseFloat(opt("floor", "1.0"));  // حداقل مکث هر متن (ثانیه)
const DT = parseFloat(opt("dt", "0.05"));       // گام نمونه‌برداری (ثانیه)
const FONT = opt("font", "vazirmatn").toLowerCase();
const HAMNESHIN = !flag("no-hamneshin");
const JSON_OUT = opt("json", null);

// ---------- find chrome ----------
function findChrome() {
  const env = process.env.HYPERFRAMES_BROWSER_PATH || process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const base = path.join(os.homedir(), ".cache/hyperframes/chrome/chrome-headless-shell");
  if (fs.existsSync(base)) {
    for (const v of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, v, "chrome-headless-shell-linux64/chrome-headless-shell");
      if (fs.existsSync(p)) return p;
    }
  }
  for (const c of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"])
    if (fs.existsSync(c)) return c;
  return null;
}
const chrome = findChrome();
if (!chrome) { console.error("مرورگر headless پیدا نشد (HyperFrames chrome cache خالی است)."); process.exit(2); }

// ---------- minimal CDP client ----------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
    }); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- in-page sampler (runs inside the composition page) ----------
function samplerInPage(dt) {
  const tl = Object.values(window.__timelines || {})[0];
  if (!tl) return Promise.resolve({ error: "window.__timelines خالی است" });
  const duration = tl.duration();
  const root = document.querySelector("[data-composition-id]") || document.body;
  const hasFa = (s) => /[\u0600-\u06FF]/.test(s || "");
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3)
    .map((n) => n.textContent).join(" ").trim().replace(/\s+/g, " ");
  const nodes = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const own = ownText(el);
    if (!own || !hasFa(own)) continue;
    const descHas = Array.from(el.querySelectorAll("*")).some((d) => hasFa(ownText(d)));
    if (descHas) continue; // فقط برگ‌ها (متنِ خودِ عنصر، نه کانتینرها)
    nodes.push(el);
  }
  const meta = nodes.map((el, i) => {
    const cs = getComputedStyle(el);
    return { i, id: el.id || null, tag: el.tagName.toLowerCase(),
      text: el.textContent.trim().replace(/\s+/g, " "),
      fontFamily: cs.fontFamily, letterSpacing: cs.letterSpacing,
      direction: cs.direction, fontSize: parseFloat(cs.fontSize),
      scrollW: el.scrollWidth, clientW: el.clientWidth };
  });
  const effOpacity = (el) => {
    let o = 1, n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= parseFloat(cs.opacity || "1"); n = n.parentElement;
    }
    return o;
  };
  const ranges = nodes.map((el) => { const rg = document.createRange(); rg.selectNodeContents(el); return rg; });
  const frame = () => nodes.map((el, i) => {
    const r = el.getBoundingClientRect();
    const tr = ranges[i].getBoundingClientRect();
    return { o: +effOpacity(el).toFixed(3),
      cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1),
      w: +r.width.toFixed(1), top: +r.top.toFixed(1), tw: +tr.width.toFixed(1) };
  });
  return (async () => {
    const samples = [];
    const steps = Math.max(1, Math.round(duration / dt));
    for (let k = 0; k <= steps; k++) {
      const t = Math.min(duration, +(k * dt).toFixed(3));
      tl.pause(t);
      await Promise.race([
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise((r) => setTimeout(r, 60)),
      ]);
      samples.push({ t, frame: frame() });
    }
    tl.pause(0);
    return { duration, width: root.offsetWidth, height: root.offsetHeight, meta, samples };
  })();
}

// ---------- run browser ----------
async function collect() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fa-gate-"));
  const proc = spawn(chrome, ["--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-sandbox", "--disable-gpu", "--window-size=1100,1950", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = "";
    proc.stderr.on("data", (d) => { buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    setTimeout(() => rej(new Error("DevTools ws بالا نیامد")), 15000);
  });
  try {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: "file://" + htmlPath }, sessionId);
    // صبر برای تایم‌لاین و فونت‌ها
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      const r = await cdp.send("Runtime.evaluate",
        { expression: "!!(window.__timelines && Object.keys(window.__timelines).length)", returnByValue: true }, sessionId);
      ready = !!r.result.value; if (!ready) await sleep(100);
    }
    if (!ready) throw new Error("تایم‌لاین کامپوزیشن لود نشد");
    await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready.then(()=>1)", awaitPromise: true, returnByValue: true }, sessionId);
    const r = await cdp.send("Runtime.evaluate",
      { expression: `(${samplerInPage})(${DT})`, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error("خطای sampler: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    ws.close();
    return r.result.value;
  } finally { proc.kill("SIGKILL"); fs.rmSync(profile, { recursive: true, force: true }); }
}

// ---------- analysis ----------
function analyze(data, sourceText) {
  const violations = [], warnings = [], rows = [];
  const { meta, samples, duration, height } = data;
  for (const m of meta) {
    const words = m.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    const required = Math.max(FLOOR, +(words * SPW).toFixed(2));
    // «ساکن» یعنی: opacity کامل + سرعت مرکز کم + نرخ تغییر اسکیل ناچیز.
    // نرخ تغییر (نه فاصله از پهنای نهایی) ملاک است تا دریفت آرام دوربینِ
    // امضای همنشین (scale ۱٫۰۰→۱٫۰۳ در کل کلیپ) متن ساکن را رد نکند،
    // ولی ورود و اوورشوت (تغییر اسکیل تند) هنوز ساکن حساب نشوند.
    const settled = samples.map((s, k) => {
      const f = s.frame[m.i];
      if (f.o < 0.98 || k === 0) return false;
      const p = samples[k - 1].frame[m.i];
      if (p.o < 0.98) return false; // اولین نمونهٔ بعد از ورود هنوز تأیید نشده
      const dist = Math.hypot(f.cx - p.cx, f.cy - p.cy);
      if (dist / DT > 40) return false; // هنوز در حال حرکت (>۴۰px/s)
      if (p.w && Math.abs(f.w - p.w) / p.w > 0.008) return false; // اسکیل در حال تغییر
      return true;
    });
    // طولانی‌ترین بازهٔ پیوستهٔ ساکن
    let best = { len: 0, from: null, to: null }, cur = null;
    settled.forEach((v, k) => {
      if (v) { cur = cur || { from: samples[k].t, to: samples[k].t, len: 0 };
        cur.to = samples[k].t; cur.len++;
        if (cur.len > best.len) best = { ...cur }; }
      else cur = null;
    });
    const hold = best.from === null ? 0 : +(best.to - best.from).toFixed(2);
    const row = { id: m.id ? "#" + m.id : m.tag, text: m.text, words,
      settle: best.from, exit: best.to, hold, required, pass: hold >= required - DT };
    rows.push(row);
    if (!row.pass) violations.push(`R1 ${row.id} «${m.text}»: مکث ساکن ${hold}s است، لازم ${required}s (${words} کلمه × ${SPW} + کف ${FLOOR}s)`);
    // R2
    if (m.letterSpacing !== "normal") {
      const px = parseFloat(m.letterSpacing);
      if (!isNaN(px) && px !== 0) violations.push(`R2 ${row.id}: letter-spacing=${m.letterSpacing} روی متن فارسی — پیوستگی حروف را می‌شکند`);
    }
    // R3
    if (!m.fontFamily.toLowerCase().includes(FONT))
      violations.push(`R3 ${row.id}: فونت «${m.fontFamily}» وزیرمتن نیست`);
    // R4
    if (m.direction !== "rtl") violations.push(`R4 ${row.id}: جهت بلوک ${m.direction} است، باید rtl باشد`);
    // R5
    if (/(می|نمی|بی)\s+(شود|شوی|کنم|کنی|کند|کنیم|کنید|کنند|روم|روی|رود|دهم|دهی|دهد|دهیم|دهید|دهند|خواهم|خواهی|خواهد|رسد|رسیم)/u.test(m.text))
      violations.push(`R5 ${row.id} «${m.text}»: «می/نمی + فاصله» دیده شد — نیم‌فاصله (ZWNJ) لازم است`);
    // R8 سرریز افقی: پهنای واقعیِ رندرشدهٔ متن (Range rect، با احتساب اسکیل‌ها)
    // در نمونه‌های ساکن نباید از پهنای قاب بگذرد. scrollWidth برای متنِ
    // وسط‌چینِ RTL سرریزِ سمت چپ را حساب نمی‌کند، برای همین Range لازم است.
    const settledFrames = samples.filter((s, k) => settled[k]);
    const maxTw = settledFrames.length ? Math.max(...settledFrames.map((s) => s.frame[m.i].tw || 0)) : 0;
    if (maxTw > data.width * 0.96)
      violations.push(`R8 ${row.id} «${m.text}»: پهنای رندرشدهٔ متن ${Math.round(maxTw)}px است — از حاشیهٔ امن ۹۶٪ قاب (${Math.round(data.width * 0.96)}px از ${data.width}px) گذشته؛ فونت یا متن باید کوچک/کوتاه شود`);
    // R6
    if (HAMNESHIN && best.from !== null) {
      const s = samples.find((x) => x.t === best.from);
      const cy = s.frame[m.i].cy;
      if (cy > height / 3) warnings.push(`R6 ${row.id}: مرکز متن در y=${Math.round(cy)} است — بیرون یک‌سوم بالایی قاب (${Math.round(height / 3)})`);
    }
  }
  // R7 استاتیک کمکی
  const easeHits = sourceText.split("\n").filter((l) => /ease\s*:\s*["'](none|linear)["']/.test(l) && !l.includes("gate-allow-linear"));
  for (const l of easeHits) violations.push(`R7 ease خطی ممنوع: ${l.trim().slice(0, 90)}`);
  return { duration, rows, violations, warnings, pass: violations.length === 0 };
}

// ---------- main ----------
const data = await collect().catch((e) => { console.error("خطای زیرساخت:", e.message); process.exit(2); });
if (data.error) { console.error("خطای کامپوزیشن:", data.error); process.exit(2); }
const sourceText = fs.readFileSync(htmlPath, "utf8");
const out = analyze(data, sourceText);

console.log("════════════════════════════════════════════════════════");
console.log(" گیت خوانایی فارسی همنشین — نمونه‌برداری از تایم‌لاین واقعی");
console.log(` فایل: ${htmlPath}`);
console.log(` مدت کامپوزیشن: ${out.duration}s — گام نمونه‌برداری: ${DT}s — آستانه: max(${FLOOR}s, کلمه×${SPW}s)`);
console.log("────────────────────────────────────────────────────────");
for (const r of out.rows)
  console.log(` ${r.pass ? "✓" : "✗"} ${r.id} «${r.text}» — ${r.words} کلمه، ساکن از ${r.settle}s تا ${r.exit}s، مکث ${r.hold}s / لازم ${r.required}s`);
for (const w of out.warnings) console.log(" ⚠ " + w);
if (out.violations.length) { console.log("────────────────────────────────────────────────────────");
  for (const v of out.violations) console.log(" ✗ " + v); }
console.log("════════════════════════════════════════════════════════");
console.log(out.pass ? " نتیجه: PASS — همهٔ متن‌ها خوانا می‌مانند." : ` نتیجه: FAIL — ${out.violations.length} تخلف.`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ file: htmlPath, config: { spw: SPW, floor: FLOOR, dt: DT, font: FONT, hamneshin: HAMNESHIN }, ...out }, null, 2));
process.exit(out.pass ? 0 : 1);

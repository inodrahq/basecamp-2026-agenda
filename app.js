(() => {
  const A = window.AGENDA;
  const SESSIONS = A.sessions.map((s) => ({ ...s, t0: Date.parse(s.start), t1: Date.parse(s.end) }));
  const BY_ID = new Map(SESSIONS.map((s) => [s.id, s]));
  const TOPIC_LABEL = Object.fromEntries(A.topics.map((t) => [t.key, t.label]));
  const FORMATS = [...new Set(SESSIONS.map((s) => s.format).filter(Boolean))];
  const STAGES = [...new Set(SESSIONS.filter((s) => !s.always).map((s) => s.stage))];
  const STORE_KEY = "basecamp-sg-2026";
  const FREE_GAP = 30 * 60e3;
  const REMIND_BEFORE = 10 * 60e3;
  // Kept apart from the program so share links and "Make it mine" never toggle a viewer's reminders.
  const NOTIFY_KEY = "basecamp-sg-2026-notify";

  const STAGE_VAR = {
    "Summit Stage": "--st-summit",
    "X Stage": "--st-x",
    "AI Builder Lab": "--st-ai",
    "The SUIG Arena": "--st-arena",
    "Community Avenue": "--st-community",
  };

  // Short, stable codes keep share links small; ids are long slugs.
  const code = (id) => {
    let h = 2166136261;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return (h >>> 0).toString(36).slice(0, 5);
  };
  const BY_CODE = new Map(SESSIONS.map((s) => [code(s.id), s.id]));

  const blank = () => ({ interests: [], formats: [], starred: [], hidden: [] });
  let state = blank();
  let ui = { tab: "program", day: 1, q: "", stage: "", shared: null };

  // ---------- persistence ----------
  const load = () => {
    try { return { ...blank(), ...JSON.parse(localStorage.getItem(STORE_KEY)) }; } catch { return blank(); }
  };
  const save = () => {
    if (ui.shared) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  };

  const encodeShare = (st) => {
    const p = new URLSearchParams();
    if (st.interests.length) p.set("i", st.interests.join("."));
    if (st.formats.length) p.set("f", st.formats.map((f) => FORMATS.indexOf(f)).join("."));
    if (st.starred.length) p.set("s", st.starred.map(code).join("."));
    if (st.hidden.length) p.set("h", st.hidden.map(code).join("."));
    return p.toString();
  };
  const decodeShare = (hash) => {
    const p = new URLSearchParams(hash.replace(/^#/, ""));
    if (![...p.keys()].length) return null;
    const list = (k) => (p.get(k) || "").split(".").filter(Boolean);
    return {
      interests: list("i").filter((k) => TOPIC_LABEL[k]),
      formats: list("f").map((n) => FORMATS[+n]).filter(Boolean),
      starred: list("s").map((c) => BY_CODE.get(c)).filter(Boolean),
      hidden: list("h").map((c) => BY_CODE.get(c)).filter(Boolean),
    };
  };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hhmm = (iso) => iso.slice(11, 16);
  const dur = (s) => Math.round((s.t1 - s.t0) / 60e3);
  const has = (arr, v) => arr.includes(v);
  const toggle = (arr, v) => (has(arr, v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const overlaps = (a, b) => a.t0 < b.t1 && b.t0 < a.t1;
  const stageStyle = (stage) => `--stage: var(${STAGE_VAR[stage] || "--st-venue"})`;
  const who = (s) => {
    const names = s.speakers.map((p) => (p.org ? `${p.name} (${p.org})` : p.name)).join(", ");
    return names + (s.moderator ? `${names ? " · " : ""}moderated by ${s.moderator}` : "");
  };

  const matches = (s) => {
    if (s.always || has(state.hidden, s.id)) return false;
    if (has(state.starred, s.id)) return true;
    if (!state.interests.length) return false;
    if (state.formats.length && s.format && !has(state.formats, s.format)) return false;
    return s.topics.some((t) => has(state.interests, t));
  };

  // Each block is the earliest remaining pick plus everything that starts before it ends.
  // Grouping transitively would chain a whole afternoon into one giant clash.
  const buildDay = (day) => {
    const daySessions = SESSIONS.filter((s) => s.day === day);
    for (const s of daySessions) s.alsoOverlaps = null;
    const picks = daySessions.filter(matches).sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
    const blocks = [];
    let rest = picks;
    while (rest.length) {
      const anchor = rest[0];
      const items = rest.filter((s) => s.t0 < anchor.t1);
      rest = rest.filter((s) => !items.includes(s));
      blocks.push({ items, t0: anchor.t0, t1: Math.max(...items.map((s) => s.t1)) });
    }
    for (const b of blocks) {
      for (const s of b.items) s.alsoOverlaps = picks.filter((o) => !b.items.includes(o) && overlaps(o, s));
    }

    const rows = [];
    const pickIds = new Set(picks.map((s) => s.id));
    let cursor = null;
    for (const b of blocks) {
      if (cursor !== null && b.t0 - cursor >= FREE_GAP) rows.push(freeRow(daySessions, pickIds, cursor, b.t0));
      rows.push({ kind: b.items.length > 1 ? "clash" : "one", ...b });
      cursor = cursor === null ? b.t1 : Math.max(cursor, b.t1);
    }
    for (const s of daySessions.filter((x) => x.always)) rows.push({ kind: "info", items: [s], t0: s.t0, t1: s.t1 });
    rows.sort((a, b) => a.t0 - b.t0 || (a.kind === "info" ? -1 : 1));

    return {
      rows,
      picks,
      clashes: blocks.filter((b) => b.items.length > 1).length,
      skipped: daySessions.filter((s) => has(state.hidden, s.id)),
    };
  };

  const freeRow = (daySessions, pickIds, t0, t1) => ({
    kind: "free",
    t0,
    t1,
    alts: daySessions.filter((s) => !s.always && !pickIds.has(s.id) && !has(state.hidden, s.id) && s.t0 < t1 && s.t1 > t0),
  });

  const fmtTime = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);

  // ---------- rendering ----------
  const $main = document.getElementById("main");

  const sessionCard = (s, { now, compact = false, inClash = false } = {}) => {
    const starred = has(state.starred, s.id);
    const live = now >= s.t0 && now < s.t1;
    const past = now >= s.t1;
    return `
      <article class="${inClash ? "option" : "card session"}${live ? " live" : ""}${past && !inClash ? " past" : ""}">
        ${inClash ? `<div class="when">${hhmm(s.start)}-${hhmm(s.end)} · ${dur(s)} min</div>` : ""}
        <div class="where">
          <span class="stage" style="${stageStyle(s.stage)}">${esc(s.stage)}</span>
          ${s.format ? `<span class="fmt">${esc(s.format)}</span>` : ""}
          ${live ? `<span class="live-tag">NOW</span>` : ""}
        </div>
        <h3>${esc(s.title)}</h3>
        ${who(s) ? `<div class="who">${esc(who(s))}</div>` : ""}
        ${s.summary && !compact ? `<div class="summary">${esc(s.summary)}</div>` : ""}
        ${s.alsoOverlaps?.length && matches(s) ? `<div class="overlap">Also overlaps ${s.alsoOverlaps.map((o) => `${esc(o.title)} (${hhmm(o.start)})`).join(", ")}</div>` : ""}
        <button class="star" data-act="star" data-id="${s.id}" aria-pressed="${starred}" title="${starred ? "Unstar" : "Star: always keep in program"}">${starred ? "★" : "☆"}</button>
        <div class="tools">
          ${inClash ? `<button class="btn small primary" data-act="pick" data-id="${s.id}">Go to this one</button>` : ""}
          <button class="btn small ghost" data-act="skip" data-id="${s.id}">Skip</button>
        </div>
      </article>`;
  };

  const timeCol = (t0, t1, label = "") => `<div class="time">${label ? `<span>${label}</span>` : ""}<b>${fmtTime(t0)}</b><span>${fmtTime(t1)}</span></div>`;

  const dayTabs = () => `
    <div class="days">
      ${A.days.map((d) => {
        const [title, date] = d.label.split(" - ");
        return `<button data-act="day" data-day="${d.day}" aria-pressed="${ui.day === d.day}">${esc(title)}<small>${esc(date || d.date)}</small></button>`;
      }).join("")}
    </div>`;

  const sgtDate = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

  const nowBanner = (d, now) => {
    if (sgtDate(now) !== d.date) return "";
    const live = d.picks.filter((s) => now >= s.t0 && now < s.t1);
    const next = d.picks.find((s) => s.t0 > now);
    if (!live.length && !next) return "";
    const line = (s) => `<div class="what">${esc(s.title)} <span class="muted">· ${esc(s.stage)}${s.t0 > now ? ` · ${fmtTime(s.t0)}` : ""}</span></div>`;
    return `<div class="card now">
      ${live.length ? `<div class="label">Now</div>${live.map(line).join("")}` : ""}
      ${next ? `<div class="label" style="margin-top:${live.length ? 8 : 0}px">Next · in ${Math.round((next.t0 - now) / 60e3)} min</div>${line(next)}` : ""}
    </div>`;
  };

  const renderProgram = () => {
    const now = Date.now();
    const d = buildDay(ui.day);
    const total = SESSIONS.filter(matches).length;

    if (!total) {
      return `${dayTabs()}<div class="card empty" style="margin-top:14px">
        <h2>No program yet</h2>
        <p>Pick a few interests, or star sessions under All Sessions. Your two-day program builds itself.</p>
        <button class="btn primary" data-act="tab" data-tab="interests">Pick interests</button>
      </div>`;
    }

    const banner = nowBanner({ ...d, date: A.days.find((x) => x.day === ui.day)?.date }, now);
    const rows = d.rows.map((r) => {
      if (r.kind === "free") {
        return `<div class="slot">${timeCol(r.t0, r.t1)}<details class="card free">
          <summary><b>Free time</b> · ${Math.round((r.t1 - r.t0) / 60e3)} min${r.alts.length ? ` · ${r.alts.length} other session${r.alts.length > 1 ? "s" : ""} on` : ""}</summary>
          ${r.alts.map((s) => `<div class="alt"><div><div class="t">${hhmm(s.start)}-${hhmm(s.end)} · <span class="stage" style="${stageStyle(s.stage)}">${esc(s.stage)}</span></div>${esc(s.title)}</div><button class="btn small" data-act="star" data-id="${s.id}">+ Add</button></div>`).join("")}
        </details></div>`;
      }
      if (r.kind === "info") {
        const s = r.items[0];
        return `<div class="slot">${timeCol(s.t0, s.t1)}<div class="card session info">
          <div class="where"><span class="stage" style="${stageStyle(s.stage)}">${esc(s.stage)}</span></div>
          <h3>${esc(s.title)}</h3>${s.summary ? `<div class="who">${esc(s.summary)}</div>` : ""}</div></div>`;
      }
      if (r.kind === "clash") {
        return `<div class="slot">${timeCol(r.t0, r.t1)}<div class="card clash">
          <div class="clash-head">Clash: ${r.items.length} options <span>Pick one, or leave both and decide on the day</span></div>
          <div class="options n${Math.min(r.items.length, 3)}">${r.items.map((s) => sessionCard(s, { now, inClash: true })).join("")}</div>
        </div></div>`;
      }
      const s = r.items[0];
      return `<div class="slot">${timeCol(s.t0, s.t1)}${sessionCard(s, { now })}</div>`;
    }).join("");

    return `
      ${dayTabs()}
      ${banner}
      <div class="toolbar">
        <div class="stats">${d.picks.length} sessions${d.clashes ? ` · <b style="color:var(--warn)">${d.clashes} clash${d.clashes > 1 ? "es" : ""}</b>` : ""}</div>
        <div class="row-actions">
          <button class="btn small" data-act="share">Share link</button>
          ${canNotify() ? `<button class="btn small" data-act="notify" aria-pressed="${notifyOn()}">${notifyOn() ? "🔔 Reminders on" : "🔕 Remind me"}</button>` : ""}
          <button class="btn small" data-act="ics">Add to calendar</button>
        </div>
      </div>
      <div class="timeline">${rows}</div>
      ${d.skipped.length ? `<details class="skipped"><summary>Skipped on this day (${d.skipped.length})</summary>
        ${d.skipped.map((s) => `<div class="alt"><div><div class="t">${hhmm(s.start)} · ${esc(s.stage)}</div>${esc(s.title)}</div><button class="btn small" data-act="unskip" data-id="${s.id}">Restore</button></div>`).join("")}
      </details>` : ""}`;
  };

  const renderInterests = () => {
    const countTopic = (k) => SESSIONS.filter((s) => s.topics.includes(k)).length;
    const countFmt = (f) => SESSIONS.filter((s) => s.format === f).length;
    const n = SESSIONS.filter(matches).length;
    return `
      <div class="card intro">
        <h2>What are you here for?</h2>
        <p>Pick your topics. We build a program for both days that tells you where to be. When two good sessions overlap, you see both side by side so you can choose.</p>
      </div>
      <div class="section-title">Topics</div>
      <div class="chips">${A.topics.map((t) => `<button class="chip" data-act="interest" data-key="${t.key}" aria-pressed="${has(state.interests, t.key)}">${esc(t.label)} <span class="n">${countTopic(t.key)}</span></button>`).join("")}</div>
      <div class="section-title">Formats <span style="text-transform:none;letter-spacing:0;font-weight:400">(optional; none selected = all)</span></div>
      <div class="chips">${FORMATS.map((f) => `<button class="chip" data-act="format" data-key="${esc(f)}" aria-pressed="${has(state.formats, f)}">${esc(f)} <span class="n">${countFmt(f)}</span></button>`).join("")}</div>
      <div class="section-title">Starred</div>
      <p class="muted" style="margin:0">${state.starred.length ? `${state.starred.length} starred session(s). They are always in your program.` : "Star sessions under All Sessions to always keep them, whatever your topics."}</p>
      <div class="cta-bar">
        <button class="btn primary" data-act="tab" data-tab="program">See my program (${n} sessions)</button>
        <button class="btn" data-act="reset">Reset</button>
      </div>`;
  };

  const renderBrowse = () => {
    const now = Date.now();
    buildDay(ui.day);
    const q = ui.q.trim().toLowerCase();
    const list = SESSIONS.filter((s) => q || s.day === ui.day)
      .filter((s) => !ui.stage || s.stage === ui.stage)
      .filter((s) => !q || [s.title, s.summary, s.stage, s.format, who(s)].join(" ").toLowerCase().includes(q))
      .sort((a, b) => a.t0 - b.t0);
    return `
      ${q ? "" : dayTabs()}
      <input class="search" type="search" placeholder="Search both days: titles, speakers, companies" value="${esc(ui.q)}" data-act="search">
      <div class="filters"><div class="chips">
        <button class="chip" data-act="stage" data-key="" aria-pressed="${!ui.stage}">All stages</button>
        ${STAGES.map((st) => `<button class="chip" data-act="stage" data-key="${esc(st)}" aria-pressed="${ui.stage === st}"><span class="stage" style="${stageStyle(st)}"></span>${esc(st)}</button>`).join("")}
      </div></div>
      <div class="timeline">
        ${list.map((s) => {
          const inProg = matches(s);
          return `<div class="slot">${timeCol(s.t0, s.t1, q ? `Day ${s.day}` : "")}<div>
            ${s.always ? `<div class="card session info"><div class="where"><span class="stage" style="${stageStyle(s.stage)}">${esc(s.stage)}</span></div><h3>${esc(s.title)}</h3></div>`
              : sessionCard(s, { now }).replace('<div class="where">', `<div class="where">${inProg ? '<span class="inprog">✓ In program</span>' : ""}`)}
          </div></div>`;
        }).join("") || `<p class="muted">No sessions match.</p>`}
      </div>`;
  };

  const render = () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === ui.tab));
    $main.innerHTML = ui.tab === "interests" ? renderInterests() : ui.tab === "browse" ? renderBrowse() : renderProgram();
    renderSharedBanner();
  };

  const renderSharedBanner = () => {
    const el = document.getElementById("shared-banner");
    el.hidden = !ui.shared;
    if (ui.shared) {
      el.innerHTML = `<div class="card"><span>You are viewing a shared program.</span>
        <span class="row-actions"><button class="btn small primary" data-act="adopt">Make it mine</button><button class="btn small" data-act="discard">Back to mine</button></span></div>`;
    }
  };

  // ---------- actions ----------
  const toast = (msg) => {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), Math.max(2200, msg.length * 50));
  };

  const shareUrl = () => `${location.origin === "null" ? location.href.split("#")[0] : location.origin + location.pathname}#${encodeShare(state)}`;

  const exportIcs = () => {
    const picks = [buildDay(1), buildDay(2)].flatMap((d) => d.rows.filter((r) => r.kind === "one" || r.kind === "clash").flatMap((r) => r.items.map((s) => ({ s, clash: r.kind === "clash" }))));
    const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const icsEsc = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
    const stamp = utc(Date.now());
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//basecamp-planner//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Sui Basecamp 2026"];
    for (const { s, clash } of picks) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:${s.id}@basecamp-planner`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${utc(s.t0)}`,
        `DTEND:${utc(s.t1)}`,
        `SUMMARY:${icsEsc((clash ? "[Clash] " : "") + s.title)}`,
        `LOCATION:${icsEsc(s.stage + ", Sui Basecamp Singapore")}`,
        `DESCRIPTION:${icsEsc([s.format, s.summary, who(s)].filter(Boolean).join("\n"))}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT10M",
        `DESCRIPTION:${icsEsc(`Head to ${s.stage}: ${s.title}`)}`,
        "END:VALARM",
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    // RFC 5545 wants 75-octet folding; calendars accept long lines in practice, but fold anyway.
    const folded = lines.map((l) => l.match(/.{1,73}/g).join("\r\n ")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([folded], { type: "text/calendar" }));
    a.download = "sui-basecamp-2026.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${picks.length} sessions`);
  };

  const update = (fn) => {
    fn();
    save();
    render();
  };

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act], .tabs button");
    if (!el) return;
    const { act, id, key } = el.dataset;
    if (!act) { ui.tab = el.dataset.tab; render(); scrollTo(0, 0); return; }

    switch (act) {
      case "tab": ui.tab = el.dataset.tab; render(); scrollTo(0, 0); break;
      case "day": ui.day = +el.dataset.day; render(); break;
      case "interest": update(() => (state.interests = toggle(state.interests, key))); break;
      case "format": update(() => (state.formats = toggle(state.formats, key))); break;
      case "stage": ui.stage = key; render(); break;
      case "star": update(() => {
        state.starred = toggle(state.starred, id);
        state.hidden = state.hidden.filter((x) => x !== id);
      }); break;
      case "skip": update(() => {
        state.hidden = [...state.hidden, id];
        state.starred = state.starred.filter((x) => x !== id);
      }); toast("Skipped. Restore it at the bottom of the day."); break;
      case "unskip": update(() => (state.hidden = state.hidden.filter((x) => x !== id))); break;
      case "pick": update(() => {
        // Only drop options that overlap the chosen one; back-to-back options in the same clash survive.
        const chosen = BY_ID.get(id);
        const losers = SESSIONS.filter((s) => s.id !== id && matches(s) && overlaps(s, chosen)).map((s) => s.id);
        state.starred = [...new Set([...state.starred.filter((x) => !losers.includes(x)), id])];
        state.hidden = [...new Set([...state.hidden, ...losers])];
      }); break;
      case "reset":
        if (state.interests.length + state.formats.length + state.starred.length + state.hidden.length) {
          update(() => (state = blank()));
          toast("Cleared");
        }
        break;
      case "share": {
        const url = shareUrl();
        (navigator.clipboard?.writeText(url) || Promise.reject()).then(
          () => toast("Link copied"),
          () => prompt("Copy this link", url),
        );
        break;
      }
      case "ics": exportIcs(); break;
      case "notify": toggleNotify(); break;
      case "adopt": ui.shared = null; save(); history.replaceState(null, "", location.pathname); render(); toast("Saved as your program"); break;
      case "discard": ui.shared = null; state = load(); history.replaceState(null, "", location.pathname); render(); break;
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.dataset.act !== "search") return;
    ui.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const box = $main.querySelector(".search");
    box.focus();
    box.setSelectionRange(pos, pos);
  });

  // ---------- reminders ----------
  // No backend, so these only fire while the page is open. Calendar alarms are the reliable path.
  const canNotify = () => "Notification" in window;
  const loadNotify = () => {
    try { return { on: false, sent: [], ...JSON.parse(localStorage.getItem(NOTIFY_KEY)) }; } catch { return { on: false, sent: [] }; }
  };
  let notify = loadNotify();
  const saveNotify = () => { try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(notify)); } catch {} };
  const notifyOn = () => notify.on && Notification.permission === "granted";

  const swReady = location.protocol.startsWith("http") && "serviceWorker" in navigator
    ? navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);

  // Android Chrome rejects `new Notification()`; it only allows notifications via a service worker.
  const show = async (title, body, tag) => {
    const opts = { body, tag };
    const reg = await swReady;
    if (reg) return reg.showNotification(title, opts);
    try { new Notification(title, opts); } catch {}
  };

  const checkReminders = () => {
    if (!canNotify() || !notifyOn() || ui.shared) return;
    const now = Date.now();
    for (const day of [1, 2]) {
      for (const r of buildDay(day).rows) {
        if (r.kind !== "one" && r.kind !== "clash") continue;
        const key = r.items.map((s) => s.id).join("+");
        const lead = r.t0 - now;
        if (lead <= 0 || lead > REMIND_BEFORE || notify.sent.includes(key)) continue;
        const mins = Math.max(1, Math.round(lead / 60e3));
        if (r.kind === "one") {
          const s = r.items[0];
          show(`Head to ${s.stage}`, `${s.title} starts in ${mins} min (${hhmm(s.start)})`, key);
        } else {
          show(`Clash in ${mins} min: pick one`, r.items.map((s) => `${hhmm(s.start)} ${s.stage}: ${s.title}`).join("\n"), key);
        }
        notify.sent.push(key);
        saveNotify();
      }
    }
  };

  const toggleNotify = async () => {
    if (notifyOn()) {
      notify.on = false;
      saveNotify();
      render();
      toast("Reminders off");
      return;
    }
    const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (perm !== "granted") {
      toast("Notifications are blocked. Allow them in your browser settings, or use Add to calendar.");
      return;
    }
    notify.on = true;
    saveNotify();
    render();
    toast("You get a reminder 10 min before each session while this page is open. For locked phones, use Add to calendar too.");
    checkReminders();
  };

  // ---------- boot ----------
  document.getElementById("scraped").textContent = new Date(A.scrapedAt).toLocaleString();
  state = load();
  const shared = decodeShare(location.hash);
  if (shared) {
    const empty = !state.interests.length && !state.starred.length;
    state = shared;
    if (empty) { save(); history.replaceState(null, "", location.pathname); } else ui.shared = true;
  }
  ui.day = A.days.find((d) => d.date === sgtDate(Date.now()))?.day || 1;
  if (!state.interests.length && !state.starred.length) ui.tab = "interests";
  render();
  setInterval(() => { if (ui.tab === "program" && !document.querySelector("details[open]")) render(); }, 60e3);
  setInterval(checkReminders, 30e3);
  document.addEventListener("visibilitychange", checkReminders);
  checkReminders();
})();

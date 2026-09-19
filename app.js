(() => {
  "use strict";

  const SESSIONS = [
    { start: "08:00", end: "09:25" },
    { start: "09:35", end: "11:00" },
    { start: "11:25", end: "12:50" },
    { start: "13:00", end: "14:25" },
    { start: "14:40", end: "16:05" }
  ];
  const TZ = "Europe/Moscow";
  const config = window.FIREBASE_CONFIG || {};
  const firebaseReady = Boolean(config.apiKey && config.databaseURL && window.firebase);

  const els = {
    banner: document.querySelector("#mode-banner"),
    title: document.querySelector("#session-title"),
    status: document.querySelector("#session-status"),
    openTime: document.querySelector("#open-time"),
    count: document.querySelector("#queue-count"),
    clock: document.querySelector("#clock"),
    form: document.querySelector("#booking-form"),
    name: document.querySelector("#full-name"),
    book: document.querySelector("#book-button"),
    personal: document.querySelector("#personal-status"),
    list: document.querySelector("#queue-list"),
    next: document.querySelector("#next-session"),
    toast: document.querySelector("#toast")
  };

  let db = null;
  let auth = null;
  let uid = null;
  let currentUser = null;
  let currentLogin = localStorage.getItem("queue_login") || "";
  let isAdmin = false;
  let authResolved = false;
  let activeSession = null;
  let entries = [];
  let selectedSlot = null;
  let unsubscribeQueue = null;
  let unsubscribeAdmin = null;
  let busy = false;

  const pad = n => String(n).padStart(2, "0");
  const normalizeName = value => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  const safe = value => String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);

  function plural(n) {
    const x = Math.abs(n) % 100;
    const y = x % 10;
    if (x > 10 && x < 20) return "человек";
    if (y > 1 && y < 5) return "человека";
    return "человек";
  }

  function moscowParts(date = new Date()) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
    return { year: +values.year, month: +values.month, day: +values.day, hour: +values.hour, minute: +values.minute, second: +values.second };
  }

  const dayKey = p => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const toMinutes = value => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
  const currentMinute = p => p.hour * 60 + p.minute + p.second / 60;
  const sessionId = (day, index) => `${day}_${SESSIONS[index].start.replace(":", "-")}`;

  function nextDayKey(p) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 12) + 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function displayDate(day) {
    const [y, m, d] = day.split("-");
    return `${d}.${m}.${y}`;
  }

  function getScheduleState() {
    const p = moscowParts();
    const now = currentMinute(p);
    const day = dayKey(p);
    const opened = SESSIONS.findIndex(s => now >= toMinutes(s.start) - 10 && now < toMinutes(s.end));
    if (opened >= 0) return { phase: "open", index: opened, day, p, session: SESSIONS[opened] };
    const upcoming = SESSIONS.findIndex(s => now < toMinutes(s.start) - 10);
    if (upcoming >= 0) return { phase: "waiting", index: upcoming, day, p, session: SESSIONS[upcoming] };
    return { phase: "closed", index: 0, day: nextDayKey(p), p, session: SESSIONS[0] };
  }

  function injectInterface() {
    const panel = document.querySelector(".booking-panel");
    if (panel && !document.querySelector("#auth-block")) {
      const authBlock = document.createElement("div");
      authBlock.id = "auth-block";
      authBlock.style.cssText = "margin-bottom:20px;padding:14px;border:1px solid var(--line,#e6e5e3);border-radius:10px;background:var(--canvas,#f9f8f7)";
      authBlock.innerHTML = `
        <div id="logged-out-block">
          <p style="margin:0 0 12px;color:var(--muted,#7d7a75);font-size:13px">Войдите, чтобы управлять записью с любого устройства.</p>
          <label for="auth-login">Логин</label>
          <input id="auth-login" type="text" autocomplete="username" placeholder="Минимум 3 символа" maxlength="50" style="margin-bottom:10px" />
          <label for="auth-password">Пароль</label>
          <input id="auth-password" type="password" autocomplete="current-password" placeholder="Минимум 6 символов" minlength="6" maxlength="100" style="margin-bottom:12px" />
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button id="password-login-button" class="button button-primary" type="button"><span>Войти</span><span>→</span></button>
            <button id="register-button" type="button" style="min-height:48px;border:1px solid var(--line,#e6e5e3);border-radius:10px;background:white;font-weight:700">Регистрация</button>
          </div>
          <p style="margin:10px 0 0;color:var(--muted,#7d7a75);font-size:12px">При первом входе нажмите «Регистрация».</p>
        </div>
        <div id="logged-in-block" class="is-hidden" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="min-width:0"><strong style="display:block;font-size:14px">Вы вошли</strong><span id="user-login" style="color:var(--muted,#7d7a75);font-size:12px"></span></div>
          <button id="logout-button" type="button" style="min-height:40px;padding:0 12px;border:1px solid var(--line,#e6e5e3);border-radius:8px;background:white;font-weight:700">Выйти</button>
        </div>`;
      panel.insertBefore(authBlock, els.form);

      const slotBlock = document.createElement("div");
      slotBlock.id = "slot-picker";
      slotBlock.style.cssText = "margin:14px 0 18px";
      els.form.insertBefore(slotBlock, els.book);

      document.querySelector("#password-login-button").addEventListener("click", signInWithPassword);
      document.querySelector("#register-button").addEventListener("click", registerWithPassword);
      document.querySelector("#auth-password").addEventListener("keydown", e => { if (e.key === "Enter") signInWithPassword(); });
      document.querySelector("#logout-button").addEventListener("click", signOut);
    }

    const grid = document.querySelector(".content-grid");
    if (grid && !document.querySelector("#admin-panel")) {
      const admin = document.createElement("section");
      admin.id = "admin-panel";
      admin.className = "panel is-hidden";
      admin.style.cssText = "margin-top:20px;min-height:0";
      admin.innerHTML = `
        <div class="panel-heading"><div><p class="eyebrow">Администратор</p><h2>Управление очередью</h2></div><button id="admin-reset" type="button" style="min-height:40px;padding:0 12px;border:1px solid #e56458;border-radius:8px;background:#fce9e7;color:#a14c43;font-weight:700">Очистить очередь</button></div>
        <div id="admin-list"></div>`;
      grid.insertAdjacentElement("afterend", admin);
      document.querySelector("#admin-reset").addEventListener("click", adminResetQueue);
      admin.addEventListener("click", e => {
        const button = e.target.closest("button[data-key]");
        if (button) adminSetStatus(button.dataset.key, button.dataset.status);
      });
    }
  }

  function updateAuthInterface() {
    const out = document.querySelector("#logged-out-block");
    const inside = document.querySelector("#logged-in-block");
    const label = document.querySelector("#user-login");
    const input = document.querySelector("#auth-login");
    if (!out || !inside || !label) return;
    if (input && !input.value && currentLogin) input.value = currentLogin;
    if (!firebaseReady) { out.classList.add("is-hidden"); inside.classList.add("is-hidden"); return; }
    if (currentUser) {
      out.classList.add("is-hidden"); inside.classList.remove("is-hidden");
      label.textContent = `${currentLogin || "Пользователь"}${isAdmin ? " · администратор" : ""}`;
    } else {
      out.classList.remove("is-hidden"); inside.classList.add("is-hidden"); label.textContent = "";
    }
  }

  function readCredentials() {
    const login = (document.querySelector("#auth-login")?.value || "").trim().toLocaleLowerCase("ru-RU");
    const password = document.querySelector("#auth-password")?.value || "";
    if (login.length < 3) throw new Error("Логин должен содержать минимум 3 символа.");
    if (password.length < 6) throw new Error("Пароль должен содержать минимум 6 символов.");
    return { login, password };
  }

  async function loginToEmail(login) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(login));
    const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
    return `q${hash}@queue.local`;
  }

  function friendlyAuthError(error) {
    return ({
      "auth/email-already-in-use": "Такой логин уже зарегистрирован.",
      "auth/invalid-credential": "Неверный логин или пароль.",
      "auth/user-not-found": "Неверный логин или пароль.",
      "auth/wrong-password": "Неверный логин или пароль.",
      "auth/weak-password": "Пароль должен содержать минимум 6 символов.",
      "auth/too-many-requests": "Слишком много попыток. Попробуйте позже.",
      "auth/operation-not-allowed": "Включите Email/Password в Firebase Authentication."
    })[error.code] || error.message;
  }

  async function authAction(mode) {
    if (!auth || busy) return;
    busy = true; render();
    try {
      const { login, password } = readCredentials();
      const email = await loginToEmail(login);
      if (mode === "register") await auth.createUserWithEmailAndPassword(email, password);
      else await auth.signInWithEmailAndPassword(email, password);
      currentLogin = login;
      localStorage.setItem("queue_login", login);
      document.querySelector("#auth-password").value = "";
      showToast(mode === "register" ? "Аккаунт создан." : "Вход выполнен.");
    } catch (error) { showToast(friendlyAuthError(error), true); }
    finally { busy = false; render(); }
  }

  const signInWithPassword = () => authAction("login");
  const registerWithPassword = () => authAction("register");
  async function signOut() { if (auth) await auth.signOut(); }

  async function initFirebase() {
    injectInterface();
    if (!firebaseReady) {
      uid = localStorage.getItem("queue_demo_uid") || crypto.randomUUID();
      localStorage.setItem("queue_demo_uid", uid);
      authResolved = true;
      els.banner.textContent = "Демо-режим: данные хранятся только в этом браузере.";
      els.banner.classList.remove("is-hidden");
      return;
    }
    firebase.initializeApp(config);
    db = firebase.database();
    auth = firebase.auth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    await new Promise(resolve => {
      let first = true;
      auth.onAuthStateChanged(user => {
        currentUser = user; uid = user?.uid || null; authResolved = true; isAdmin = false;
        if (unsubscribeAdmin) { unsubscribeAdmin(); unsubscribeAdmin = null; }
        if (uid) {
          const ref = db.ref(`admins/${uid}`);
          const handler = snap => { isAdmin = snap.val() === true; updateAuthInterface(); render(); };
          ref.on("value", handler);
          unsubscribeAdmin = () => ref.off("value", handler);
        }
        updateAuthInterface(); render();
        if (first) { first = false; resolve(); }
      });
    });
  }

  function updateScheduleUI() {
    const state = getScheduleState();
    const s = state.session;
    const opening = toMinutes(s.start) - 10;
    const openingText = `${pad(Math.floor(opening / 60))}:${pad(opening % 60)}`;
    els.clock.textContent = `${pad(state.p.hour)}:${pad(state.p.minute)}:${pad(state.p.second)}`;
    els.openTime.textContent = `${openingText} · ${displayDate(state.day)}`;
    els.title.textContent = `${s.start}–${s.end}`;
    els.status.className = "status-badge";
    if (state.phase === "open") { els.status.textContent = "Запись открыта"; els.status.classList.add("open"); els.next.textContent = `Текущий цикл до ${s.end}`; }
    else if (state.phase === "waiting") { els.status.textContent = `Откроется в ${openingText}`; els.status.classList.add("waiting"); els.next.textContent = `Следующий цикл: ${s.start}–${s.end}`; }
    else { els.status.textContent = "На сегодня закрыто"; els.status.classList.add("closed"); els.next.textContent = `Следующий цикл: завтра, ${s.start}–${s.end}`; }
    const nextId = state.phase === "open" ? sessionId(state.day, state.index) : null;
    if (nextId !== activeSession) { activeSession = nextId; subscribeToSession(nextId); }
    render();
  }

  function subscribeToSession(id) {
    if (unsubscribeQueue) { unsubscribeQueue(); unsubscribeQueue = null; }
    entries = [];
    if (!id) { render(); return; }
    if (db) {
      const ref = db.ref(`sessions/${id}/entries`);
      const handler = snap => {
        entries = Object.entries(snap.val() || {}).map(([key, item]) => ({ key, ...item }));
        render();
      };
      ref.on("value", handler, error => showToast(error.message, true));
      unsubscribeQueue = () => ref.off("value", handler);
    } else {
      entries = JSON.parse(localStorage.getItem(`queue_${id}`) || "[]"); render();
    }
  }

  const activeEntries = () => entries.filter(e => e.status === "active").sort((a, b) => a.slotNumber - b.slotNumber || a.createdAt - b.createdAt);
  const myActiveEntry = () => uid ? activeEntries().find(e => e.uid === uid) || null : null;

  function nearestFreeSlots() {
    const occupied = new Set(activeEntries().map(e => Number(e.slotNumber)));
    const result = [];
    for (let number = 1; result.length < 3; number += 1) if (!occupied.has(number)) result.push(number);
    return result;
  }

  function renderSlotPicker() {
    const picker = document.querySelector("#slot-picker");
    if (!picker) return;
    const free = nearestFreeSlots();
    if (!free.includes(selectedSlot)) selectedSlot = free[0];
    picker.innerHTML = `<span style="display:block;margin-bottom:8px;font-size:14px;font-weight:700">Выберите место</span><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${free.map(slot => `
      <button type="button" data-slot="${slot}" style="min-height:48px;border:1px solid ${selectedSlot === slot ? "#2783de" : "#e6e5e3"};border-radius:10px;background:${selectedSlot === slot ? "#e5f2fc" : "white"};color:${selectedSlot === slot ? "#246cae" : "#2c2c2b"};font-weight:800">Место ${slot}</button>`).join("")}</div>`;
    picker.querySelectorAll("button[data-slot]").forEach(button => button.addEventListener("click", () => { selectedSlot = Number(button.dataset.slot); renderSlotPicker(); }));
  }

  function renderAdmin(active) {
    const panel = document.querySelector("#admin-panel");
    const list = document.querySelector("#admin-list");
    if (!panel || !list) return;
    panel.classList.toggle("is-hidden", !isAdmin);
    if (!isAdmin) return;
    list.innerHTML = active.length ? active.map(e => `
      <div style="display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid #e6e5e3">
        <strong>#${e.slotNumber}</strong><span>${safe(e.fullName)}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button data-key="${e.key}" data-status="completed" type="button">Сдал</button>
          <button data-key="${e.key}" data-status="skipped" type="button">Пропустил</button>
          <button data-key="${e.key}" data-status="cancelled" type="button">Удалить</button>
        </div>
      </div>`).join("") : '<div class="empty-state">Очередь пустая.</div>';
  }

  function render() {
    updateAuthInterface();
    const active = activeEntries();
    const mine = myActiveEntry();
    const loginRequired = firebaseReady && (!authResolved || !uid);
    els.count.textContent = `${active.length} ${plural(active.length)}`;
    els.book.disabled = busy || !activeSession || loginRequired || Boolean(mine);
    els.name.disabled = busy || loginRequired || Boolean(mine);
    renderSlotPicker();

    if (!activeSession) els.list.innerHTML = '<div class="empty-state">Очередь откроется за 10 минут до следующей пары.</div>';
    else if (!active.length) els.list.innerHTML = '<div class="empty-state">Очередь пока пустая.<br>Можно занять первое место.</div>';
    else els.list.innerHTML = active.map((item, index) => {
      const time = new Date(item.createdAt).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
      const mineRow = item.uid === uid;
      return `<div class="queue-row ${index === 0 ? "current" : ""}"><span class="queue-position">${item.slotNumber}</span><span class="queue-name">${safe(item.fullName)}${mineRow ? '<small class="queue-you">Это вы</small>' : ""}</span><span class="queue-time">${time}</span></div>`;
    }).join("");

    if (mine) {
      const order = active.findIndex(e => e.key === mine.key);
      const canFinish = order <= 1;
      const hint = order === 0 ? "Вы первый в очереди." : order === 1 ? "Вы второй. При сдаче первый будет отмечен как пропустивший." : "Кнопка сдачи станет доступна, когда вы будете первым или вторым.";
      els.personal.className = "personal-status";
      els.personal.innerHTML = `<strong>Ваше место: ${mine.slotNumber}</strong><span>${safe(mine.fullName)}</span><p style="margin:8px 0 0;font-size:12px">${hint}</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px"><button id="done-button" class="button button-success" type="button" ${canFinish ? "" : "disabled"}>Сдал лабу <span>✓</span></button><button id="cancel-button" type="button" style="min-height:48px;border:1px solid #e56458;border-radius:10px;background:#fce9e7;color:#a14c43;font-weight:700">Отменить</button></div>`;
      els.personal.classList.remove("is-hidden");
      els.personal.querySelector("#done-button").addEventListener("click", completeMine);
      els.personal.querySelector("#cancel-button").addEventListener("click", cancelMine);
    } else { els.personal.classList.add("is-hidden"); els.personal.innerHTML = ""; }
    renderAdmin(active);
  }

  async function book(event) {
    event.preventDefault();
    if (firebaseReady && !uid) return showToast("Сначала войдите.", true);
    const fullName = els.name.value.trim().replace(/\s+/g, " ");
    if (!activeSession) return showToast("Запись закрыта.", true);
    if (fullName.length < 5 || fullName.split(" ").length < 2) return showToast("Введите фамилию и имя.", true);
    if (!nearestFreeSlots().includes(selectedSlot)) return showToast("Место уже занято. Выберите другое.", true);
    busy = true; render();
    const item = { uid, fullName, normalizedName: normalizeName(fullName), slotNumber: selectedSlot, status: "active", createdAt: Date.now() };
    try {
      if (db) {
        const ref = db.ref(`sessions/${activeSession}/entries`);
        const key = ref.push().key;
        let reason = "";
        const result = await ref.transaction(current => {
          current = current || {};
          const values = Object.values(current);
          if (values.some(e => e.status === "active" && e.uid === uid)) { reason = "У вас уже есть запись."; return; }
          if (values.some(e => e.status === "active" && Number(e.slotNumber) === selectedSlot)) { reason = "Это место уже занято."; return; }
          if (values.some(e => e.status === "active" && e.normalizedName === item.normalizedName)) { reason = "Это ФИО уже есть в очереди."; return; }
          current[key] = item; return current;
        });
        if (!result.committed) throw new Error(reason || "Не удалось записаться.");
      } else { entries.push({ key: crypto.randomUUID(), ...item }); saveDemo(); }
      localStorage.setItem("queue_full_name", fullName); showToast(`Вы заняли место ${selectedSlot}.`);
    } catch (error) { showToast(error.message, true); }
    finally { busy = false; render(); }
  }

  function saveDemo() { localStorage.setItem(`queue_${activeSession}`, JSON.stringify(entries)); }

  async function completeMine() {
    const mine = myActiveEntry();
    const active = activeEntries();
    const order = active.findIndex(e => e.key === mine?.key);
    if (!mine || order < 0 || order > 1) return showToast("Сейчас завершить запись нельзя.", true);
    if (order === 1 && !confirm(`Первый в очереди — ${active[0].fullName}. Отметить его как пропустившего и завершить вашу сдачу?`)) return;
    busy = true; render();
    try {
      if (db) {
        const ref = db.ref(`sessions/${activeSession}/entries`);
        const result = await ref.transaction(current => {
          if (!current?.[mine.key] || current[mine.key].uid !== uid || current[mine.key].status !== "active") return;
          const sorted = Object.entries(current).filter(([, e]) => e.status === "active").sort((a, b) => a[1].slotNumber - b[1].slotNumber || a[1].createdAt - b[1].createdAt);
          const index = sorted.findIndex(([key]) => key === mine.key);
          if (index < 0 || index > 1) return;
          const now = Date.now();
          if (index === 1) { current[sorted[0][0]].status = "skipped"; current[sorted[0][0]].finishedAt = now; }
          current[mine.key].status = "completed"; current[mine.key].finishedAt = now; return current;
        });
        if (!result.committed) throw new Error("Очередь уже изменилась. Обновите страницу.");
      } else {
        if (order === 1) entries = entries.map(e => e.key === active[0].key ? { ...e, status: "skipped", finishedAt: Date.now() } : e);
        entries = entries.map(e => e.key === mine.key ? { ...e, status: "completed", finishedAt: Date.now() } : e); saveDemo();
      }
      showToast("Сдача отмечена.");
    } catch (error) { showToast(error.message, true); }
    finally { busy = false; render(); }
  }

  async function cancelMine() {
    const mine = myActiveEntry();
    if (!mine || !confirm(`Отменить запись на место ${mine.slotNumber}?`)) return;
    await setOwnStatus(mine, "cancelled", "Запись отменена.");
  }

  async function setOwnStatus(mine, status, message) {
    busy = true; render();
    try {
      if (db) {
        const ref = db.ref(`sessions/${activeSession}/entries/${mine.key}`);
        const result = await ref.transaction(current => {
          if (!current || current.uid !== uid || current.status !== "active") return;
          current.status = status; current.finishedAt = Date.now(); return current;
        });
        if (!result.committed) throw new Error("Запись уже изменилась.");
      } else { entries = entries.map(e => e.key === mine.key ? { ...e, status, finishedAt: Date.now() } : e); saveDemo(); }
      showToast(message);
    } catch (error) { showToast(error.message, true); }
    finally { busy = false; render(); }
  }

  async function adminSetStatus(key, status) {
    if (!isAdmin || !activeSession) return;
    const entry = entries.find(e => e.key === key);
    if (!entry || !confirm(`${status === "completed" ? "Отметить сдачу" : status === "skipped" ? "Отметить пропуск" : "Удалить запись"}: ${entry.fullName}?`)) return;
    await db.ref(`sessions/${activeSession}/entries/${key}`).update({ status, finishedAt: Date.now() });
  }

  async function adminResetQueue() {
    if (!isAdmin || !activeSession || !confirm("Очистить всю активную очередь?")) return;
    const ref = db.ref(`sessions/${activeSession}/entries`);
    await ref.transaction(current => {
      if (!current) return current;
      Object.values(current).forEach(e => { if (e.status === "active") { e.status = "cancelled"; e.finishedAt = Date.now(); } });
      return current;
    });
  }

  let toastTimer;
  function showToast(message, error = false) {
    clearTimeout(toastTimer); els.toast.textContent = message; els.toast.className = `toast show${error ? " error" : ""}`;
    toastTimer = setTimeout(() => { els.toast.className = "toast"; }, 3500);
  }

  els.form.addEventListener("submit", book);
  window.addEventListener("storage", e => { if (!db && activeSession && e.key === `queue_${activeSession}`) subscribeToSession(activeSession); });

  (async () => {
    els.name.value = localStorage.getItem("queue_full_name") || "";
    await initFirebase(); updateScheduleUI(); setInterval(updateScheduleUI, 1000);
  })();
})();

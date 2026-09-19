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
  let uid = localStorage.getItem("queue_demo_uid") || crypto.randomUUID();
  let activeSession = null;
  let entries = [];
  let unsubscribe = null;
  let busy = false;
  localStorage.setItem("queue_demo_uid", uid);

  const pad = n => String(n).padStart(2, "0");
  const normalizeName = value => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  const safe = value => String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  const plural = n => {
    const x = Math.abs(n) % 100;
    const y = x % 10;
    if (x > 10 && x < 20) return "человек";
    if (y > 1 && y < 5) return "человека";
    return "человек";
  };

  function moscowParts(date = new Date()) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
    return { year: +values.year, month: +values.month, day: +values.day, hour: +values.hour, minute: +values.minute, second: +values.second };
  }

  function dayKey(p) { return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
  function minutes(value) { const [h, m] = value.split(":").map(Number); return h * 60 + m; }
  function currentMinute(p) { return p.hour * 60 + p.minute + p.second / 60; }
  function sessionId(day, index) { return `${day}_${SESSIONS[index].start.replace(":", "-")}`; }

  function getScheduleState() {
    const p = moscowParts();
    const now = currentMinute(p);
    const day = dayKey(p);
    const opened = SESSIONS.findIndex(s => now >= minutes(s.start) - 10 && now < minutes(s.end));
    if (opened >= 0) return { phase: "open", index: opened, day, now, p, session: SESSIONS[opened] };
    const upcoming = SESSIONS.findIndex(s => now < minutes(s.start) - 10);
    if (upcoming >= 0) return { phase: "waiting", index: upcoming, day, now, p, session: SESSIONS[upcoming] };
    return { phase: "closed", index: 0, day: nextDayKey(p), now, p, session: SESSIONS[0] };
  }

  function nextDayKey(p) {
    const noonUtc = Date.UTC(p.year, p.month - 1, p.day, 12);
    const d = new Date(noonUtc + 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function displayDate(day) {
    const [y, m, d] = day.split("-");
    return `${d}.${m}.${y}`;
  }

  function updateScheduleUI() {
    const state = getScheduleState();
    const session = state.session;
    const opening = minutes(session.start) - 10;
    const openingText = `${pad(Math.floor(opening / 60))}:${pad(opening % 60)}`;
    els.clock.textContent = `${pad(state.p.hour)}:${pad(state.p.minute)}:${pad(state.p.second)}`;
    els.openTime.textContent = `${openingText} · ${displayDate(state.day)}`;
    els.title.textContent = `${session.start}–${session.end}`;
    els.status.className = "status-badge";

    if (state.phase === "open") {
      els.status.textContent = "Запись открыта";
      els.status.classList.add("open");
      els.next.textContent = `Текущий цикл до ${session.end}`;
    } else if (state.phase === "waiting") {
      els.status.textContent = `Откроется в ${openingText}`;
      els.status.classList.add("waiting");
      els.next.textContent = `Следующий цикл: ${session.start}–${session.end}`;
    } else {
      els.status.textContent = "На сегодня закрыто";
      els.status.classList.add("closed");
      els.next.textContent = `Следующий цикл: завтра, ${session.start}–${session.end}`;
    }

    const newSession = state.phase === "open" ? sessionId(state.day, state.index) : null;
    if (newSession !== activeSession) {
      activeSession = newSession;
      subscribeToSession(activeSession);
    }
    render();
  }

  async function initFirebase() {
    if (!firebaseReady) {
      els.banner.textContent = "Демо-режим: очередь хранится только в этом браузере. Подключи Firebase перед публикацией.";
      els.banner.classList.remove("is-hidden");
      return;
    }
    firebase.initializeApp(config);
    db = firebase.database();
    try {
      const credential = await firebase.auth().signInAnonymously();
      uid = credential.user.uid;
    } catch (error) {
      showToast("Не удалось войти в Firebase. Проверь Anonymous Auth.", true);
      console.error(error);
    }
  }

  function subscribeToSession(id) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    entries = [];
    if (!id) { render(); return; }

    if (db) {
      const ref = db.ref(`sessions/${id}/entries`);
      const handler = snap => {
        const value = snap.val() || {};
        entries = Object.entries(value).map(([key, item]) => ({ key, ...item })).sort((a, b) => a.createdAt - b.createdAt);
        render();
      };
      ref.on("value", handler, error => showToast(`Ошибка базы: ${error.message}`, true));
      unsubscribe = () => ref.off("value", handler);
    } else {
      entries = JSON.parse(localStorage.getItem(`queue_${id}`) || "[]");
      render();
    }
  }

  function saveDemo() {
    localStorage.setItem(`queue_${activeSession}`, JSON.stringify(entries));
    window.dispatchEvent(new StorageEvent("storage", { key: `queue_${activeSession}` }));
  }

  function myActiveEntry() {
    return entries.find(e => e.uid === uid && e.status === "active");
  }

  function render() {
    const active = entries.filter(e => e.status === "active").sort((a, b) => a.createdAt - b.createdAt);
    const mine = myActiveEntry();
    els.count.textContent = `${active.length} ${plural(active.length)}`;
    els.book.disabled = busy || !activeSession || Boolean(mine);
    els.name.disabled = busy || Boolean(mine);

    if (!activeSession) {
      els.list.innerHTML = '<div class="empty-state">Очередь откроется за 10 минут до следующей пары.</div>';
    } else if (!active.length) {
      els.list.innerHTML = '<div class="empty-state">Очередь пока пустая.<br>Можно занять первое место.</div>';
    } else {
      els.list.innerHTML = active.map((item, index) => {
        const time = new Date(item.createdAt).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
        const isMine = item.uid === uid;
        return `<div class="queue-row ${index === 0 ? "current" : ""}">
          <span class="queue-position">${index + 1}</span>
          <span class="queue-name">${safe(item.fullName)}${isMine ? '<small class="queue-you">Это вы</small>' : ""}</span>
          <span class="queue-time">${time}</span>
        </div>`;
      }).join("");
    }

    if (mine) {
      const position = active.findIndex(e => e.key === mine.key) + 1;
      els.personal.className = "personal-status";
      els.personal.innerHTML = `<strong>Вы в очереди · место ${position}</strong><span>${safe(mine.fullName)}</span><button id="done-button" class="button button-success" type="button" style="margin-top:12px">Сдал лабу <span aria-hidden="true">✓</span></button>`;
      els.personal.querySelector("#done-button").addEventListener("click", completeMine);
      els.personal.classList.remove("is-hidden");
    } else {
      els.personal.classList.add("is-hidden");
      els.personal.innerHTML = "";
    }
  }

  async function book(event) {
    event.preventDefault();
    const fullName = els.name.value.trim().replace(/\s+/g, " ");
    if (!activeSession) return showToast("Запись сейчас закрыта.", true);
    if (fullName.length < 5 || fullName.split(" ").length < 2) return showToast("Введи фамилию и имя.", true);
    busy = true; render();
    const item = { uid, fullName, normalizedName: normalizeName(fullName), status: "active", createdAt: Date.now() };

    try {
      if (db) {
        const ref = db.ref(`sessions/${activeSession}/entries`);
        let duplicate = false;
        const result = await ref.transaction(current => {
          current = current || {};
          duplicate = Object.values(current).some(e => e.status === "active" && (e.uid === uid || e.normalizedName === item.normalizedName));
          if (duplicate) return;
          current[ref.push().key] = item;
          return current;
        });
        if (!result.committed) throw new Error(duplicate ? "Это ФИО уже есть в очереди." : "Не удалось записаться.");
      } else {
        if (entries.some(e => e.status === "active" && (e.uid === uid || e.normalizedName === item.normalizedName))) throw new Error("Это ФИО уже есть в очереди.");
        entries.push({ key: crypto.randomUUID(), ...item });
        saveDemo();
      }
      localStorage.setItem("queue_full_name", fullName);
      showToast("Место в очереди занято.");
      render();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      busy = false; render();
    }
  }

  async function completeMine() {
    const mine = myActiveEntry();
    if (!mine || !activeSession || busy) return;
    busy = true; render();
    try {
      if (db) {
        const ref = db.ref(`sessions/${activeSession}/entries`);
        await ref.transaction(current => {
          if (!current || !current[mine.key] || current[mine.key].status !== "active") return;
          const myTime = current[mine.key].createdAt;
          Object.keys(current).forEach(key => {
            const entry = current[key];
            if (entry.status === "active" && entry.createdAt < myTime) {
              entry.status = "skipped";
              entry.finishedAt = firebase.database.ServerValue.TIMESTAMP;
            }
          });
          current[mine.key].status = "completed";
          current[mine.key].finishedAt = firebase.database.ServerValue.TIMESTAMP;
          return current;
        });
      } else {
        entries = entries.map(e => {
          if (e.status === "active" && e.createdAt < mine.createdAt) return { ...e, status: "skipped", finishedAt: Date.now() };
          if (e.key === mine.key) return { ...e, status: "completed", finishedAt: Date.now() };
          return e;
        });
        saveDemo();
      }
      els.name.value = localStorage.getItem("queue_full_name") || "";
      showToast("Сдача отмечена. Можно записаться снова.");
      render();
    } catch (error) {
      showToast(`Не удалось обновить очередь: ${error.message}`, true);
    } finally {
      busy = false; render();
    }
  }

  let toastTimer;
  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast show${error ? " error" : ""}`;
    toastTimer = setTimeout(() => { els.toast.className = "toast"; }, 3000);
  }

  els.form.addEventListener("submit", book);
  window.addEventListener("storage", e => {
    if (!db && activeSession && e.key === `queue_${activeSession}`) subscribeToSession(activeSession);
  });

  (async () => {
    els.name.value = localStorage.getItem("queue_full_name") || "";
    await initFirebase();
    updateScheduleUI();
    setInterval(updateScheduleUI, 1000);
  })();
})();

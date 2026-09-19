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
  const firebaseReady = Boolean(
    config.apiKey &&
    config.databaseURL &&
    window.firebase
  );

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
  let authResolved = false;
  let activeSession = null;
  let entries = [];
  let unsubscribe = null;
  let busy = false;

  const pad = n => String(n).padStart(2, "0");
  const normalizeName = value => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  const safe = value => String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[char]);

  function plural(number) {
    const lastTwo = Math.abs(number) % 100;
    const last = lastTwo % 10;
    if (lastTwo > 10 && lastTwo < 20) return "человек";
    if (last > 1 && last < 5) return "человека";
    return "человек";
  }

  function moscowParts(date = new Date()) {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat("ru-RU", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      })
        .formatToParts(date)
        .filter(item => item.type !== "literal")
        .map(item => [item.type, item.value])
    );

    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second)
    };
  }

  function dayKey(parts) {
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }

  function nextDayKey(parts) {
    const noonUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
    const date = new Date(noonUtc + 86400000);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function toMinutes(value) {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function currentMinute(parts) {
    return parts.hour * 60 + parts.minute + parts.second / 60;
  }

  function sessionId(day, index) {
    return `${day}_${SESSIONS[index].start.replace(":", "-")}`;
  }

  function displayDate(day) {
    const [year, month, date] = day.split("-");
    return `${date}.${month}.${year}`;
  }

  function getScheduleState() {
    const parts = moscowParts();
    const now = currentMinute(parts);
    const today = dayKey(parts);

    const openedIndex = SESSIONS.findIndex(session => (
      now >= toMinutes(session.start) - 10 &&
      now < toMinutes(session.end)
    ));

    if (openedIndex >= 0) {
      return {
        phase: "open",
        index: openedIndex,
        day: today,
        parts,
        session: SESSIONS[openedIndex]
      };
    }

    const upcomingIndex = SESSIONS.findIndex(session => now < toMinutes(session.start) - 10);

    if (upcomingIndex >= 0) {
      return {
        phase: "waiting",
        index: upcomingIndex,
        day: today,
        parts,
        session: SESSIONS[upcomingIndex]
      };
    }

    return {
      phase: "closed",
      index: 0,
      day: nextDayKey(parts),
      parts,
      session: SESSIONS[0]
    };
  }

  function createAuthInterface() {
    const bookingPanel = document.querySelector(".booking-panel");
    if (!bookingPanel || document.querySelector("#auth-block")) return;

    const block = document.createElement("div");
    block.id = "auth-block";
    block.style.cssText = "margin-bottom:20px;padding:14px;border:1px solid var(--line,#e6e5e3);border-radius:10px;background:var(--canvas,#f9f8f7)";
    block.innerHTML = `
      <div id="logged-out-block">
        <p style="margin:0 0 10px;color:var(--muted,#7d7a75);font-size:13px">
          Войдите, чтобы управлять своей записью с любого устройства.
        </p>
        <button id="login-button" class="button button-primary" type="button">
          <span>Войти через Google</span><span aria-hidden="true">→</span>
        </button>
      </div>
      <div id="logged-in-block" class="is-hidden" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div style="min-width:0">
          <strong style="display:block;font-size:14px">Вы вошли</strong>
          <span id="user-email" style="display:block;overflow:hidden;text-overflow:ellipsis;color:var(--muted,#7d7a75);font-size:12px;white-space:nowrap"></span>
        </div>
        <button id="logout-button" type="button" style="min-height:40px;padding:0 12px;border:1px solid var(--line,#e6e5e3);border-radius:8px;background:white;color:var(--ink,#2c2c2b);font-weight:700;cursor:pointer">
          Выйти
        </button>
      </div>
    `;

    bookingPanel.insertBefore(block, els.form);

    document.querySelector("#login-button").addEventListener("click", signInWithGoogle);
    document.querySelector("#logout-button").addEventListener("click", signOut);
  }

  function updateAuthInterface() {
    const loggedOut = document.querySelector("#logged-out-block");
    const loggedIn = document.querySelector("#logged-in-block");
    const email = document.querySelector("#user-email");
    if (!loggedOut || !loggedIn || !email) return;

    if (!firebaseReady) {
      loggedOut.classList.add("is-hidden");
      loggedIn.classList.add("is-hidden");
      return;
    }

    if (currentUser) {
      loggedOut.classList.add("is-hidden");
      loggedIn.classList.remove("is-hidden");
      email.textContent = currentUser.email || currentUser.displayName || "Google-аккаунт";
    } else {
      loggedOut.classList.remove("is-hidden");
      loggedIn.classList.add("is-hidden");
      email.textContent = "";
    }
  }

  async function signInWithGoogle() {
    if (!auth || busy) return;
    busy = true;
    render();

    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await auth.signInWithPopup(provider);
      showToast("Вход выполнен.");
    } catch (error) {
      if (error.code !== "auth/popup-closed-by-user") {
        showToast(`Не удалось войти: ${error.message}`, true);
      }
    } finally {
      busy = false;
      render();
    }
  }

  async function signOut() {
    if (!auth || busy) return;
    busy = true;
    render();

    try {
      await auth.signOut();
      showToast("Вы вышли из аккаунта.");
    } catch (error) {
      showToast(`Не удалось выйти: ${error.message}`, true);
    } finally {
      busy = false;
      render();
    }
  }

  async function initFirebase() {
    createAuthInterface();

    if (!firebaseReady) {
      uid = localStorage.getItem("queue_demo_uid") || crypto.randomUUID();
      localStorage.setItem("queue_demo_uid", uid);
      authResolved = true;
      els.banner.textContent = "Демо-режим: очередь хранится только в этом браузере. Подключите Firebase перед публикацией.";
      els.banner.classList.remove("is-hidden");
      updateAuthInterface();
      return;
    }

    firebase.initializeApp(config);
    db = firebase.database();
    auth = firebase.auth();

    try {
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    } catch (error) {
      console.error("Не удалось включить сохранение входа:", error);
    }

    await new Promise(resolve => {
      let firstState = true;

      auth.onAuthStateChanged(user => {
        currentUser = user;
        uid = user ? user.uid : null;
        authResolved = true;
        updateAuthInterface();
        render();

        if (firstState) {
          firstState = false;
          resolve();
        }
      }, error => {
        authResolved = true;
        showToast(`Ошибка авторизации: ${error.message}`, true);
        resolve();
      });
    });
  }

  function updateScheduleUI() {
    const state = getScheduleState();
    const session = state.session;
    const openingMinutes = toMinutes(session.start) - 10;
    const openingText = `${pad(Math.floor(openingMinutes / 60))}:${pad(openingMinutes % 60)}`;

    els.clock.textContent = `${pad(state.parts.hour)}:${pad(state.parts.minute)}:${pad(state.parts.second)}`;
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

    const newSession = state.phase === "open"
      ? sessionId(state.day, state.index)
      : null;

    if (newSession !== activeSession) {
      activeSession = newSession;
      subscribeToSession(activeSession);
    }

    render();
  }

  function subscribeToSession(id) {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }

    entries = [];

    if (!id) {
      render();
      return;
    }

    if (db) {
      const reference = db.ref(`sessions/${id}/entries`);
      const handler = snapshot => {
        const value = snapshot.val() || {};
        entries = Object.entries(value)
          .map(([key, item]) => ({ key, ...item }))
          .sort((first, second) => first.createdAt - second.createdAt);
        render();
      };

      reference.on(
        "value",
        handler,
        error => showToast(`Ошибка базы: ${error.message}`, true)
      );

      unsubscribe = () => reference.off("value", handler);
    } else {
      entries = JSON.parse(localStorage.getItem(`queue_${id}`) || "[]");
      render();
    }
  }

  function saveDemo() {
    localStorage.setItem(`queue_${activeSession}`, JSON.stringify(entries));
  }

  function myActiveEntry() {
    if (!uid) return null;
    return entries.find(entry => entry.uid === uid && entry.status === "active") || null;
  }

  function render() {
    updateAuthInterface();

    const activeEntries = entries
      .filter(entry => entry.status === "active")
      .sort((first, second) => first.createdAt - second.createdAt);

    const mine = myActiveEntry();
    const loginRequired = firebaseReady && (!authResolved || !uid);

    els.count.textContent = `${activeEntries.length} ${plural(activeEntries.length)}`;
    els.book.disabled = busy || !activeSession || loginRequired || Boolean(mine);
    els.name.disabled = busy || loginRequired || Boolean(mine);

    if (!activeSession) {
      els.list.innerHTML = '<div class="empty-state">Очередь откроется за 10 минут до следующей пары.</div>';
    } else if (!activeEntries.length) {
      els.list.innerHTML = '<div class="empty-state">Очередь пока пустая.<br>Можно занять первое место.</div>';
    } else {
      els.list.innerHTML = activeEntries.map((item, index) => {
        const time = new Date(item.createdAt).toLocaleTimeString("ru-RU", {
          timeZone: TZ,
          hour: "2-digit",
          minute: "2-digit"
        });
        const isMine = Boolean(uid && item.uid === uid);

        return `
          <div class="queue-row ${index === 0 ? "current" : ""}">
            <span class="queue-position">${index + 1}</span>
            <span class="queue-name">
              ${safe(item.fullName)}
              ${isMine ? '<small class="queue-you">Это вы</small>' : ""}
            </span>
            <span class="queue-time">${time}</span>
          </div>
        `;
      }).join("");
    }

    if (mine) {
      const position = activeEntries.findIndex(entry => entry.key === mine.key) + 1;
      els.personal.className = "personal-status";
      els.personal.innerHTML = `
        <strong>Вы в очереди · место ${position}</strong>
        <span>${safe(mine.fullName)}</span>
        <button id="done-button" class="button button-success" type="button" style="margin-top:12px">
          Сдал лабу <span aria-hidden="true">✓</span>
        </button>
      `;
      els.personal.querySelector("#done-button").addEventListener("click", completeMine);
      els.personal.classList.remove("is-hidden");
    } else {
      els.personal.classList.add("is-hidden");
      els.personal.innerHTML = "";
    }
  }

  async function book(event) {
    event.preventDefault();

    if (firebaseReady && !uid) {
      showToast("Сначала войдите через Google.", true);
      return;
    }

    const fullName = els.name.value.trim().replace(/\s+/g, " ");

    if (!activeSession) {
      showToast("Запись сейчас закрыта.", true);
      return;
    }

    if (fullName.length < 5 || fullName.split(" ").length < 2) {
      showToast("Введите фамилию и имя.", true);
      return;
    }

    busy = true;
    render();

    const item = {
      uid,
      fullName,
      normalizedName: normalizeName(fullName),
      status: "active",
      createdAt: Date.now()
    };

    try {
      if (db) {
        const reference = db.ref(`sessions/${activeSession}/entries`);
        const newKey = reference.push().key;
        let duplicate = false;

        const result = await reference.transaction(current => {
          current = current || {};
          duplicate = Object.values(current).some(entry => (
            entry.status === "active" &&
            (entry.uid === uid || entry.normalizedName === item.normalizedName)
          ));

          if (duplicate) return;
          current[newKey] = item;
          return current;
        });

        if (!result.committed) {
          throw new Error(duplicate
            ? "Это ФИО уже есть в очереди. Если это ваша старая запись, удалите её в Firebase и запишитесь заново после входа."
            : "Не удалось записаться.");
        }
      } else {
        const duplicate = entries.some(entry => (
          entry.status === "active" &&
          (entry.uid === uid || entry.normalizedName === item.normalizedName)
        ));

        if (duplicate) throw new Error("Это ФИО уже есть в очереди.");

        entries.push({ key: crypto.randomUUID(), ...item });
        saveDemo();
      }

      localStorage.setItem("queue_full_name", fullName);
      showToast("Место в очереди занято.");
      render();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  async function completeMine() {
    const mine = myActiveEntry();
    if (!mine || !activeSession || busy) return;

    busy = true;
    render();

    try {
      if (db) {
        const reference = db.ref(`sessions/${activeSession}/entries`);

        const result = await reference.transaction(current => {
          if (!current || !current[mine.key]) return;
          if (current[mine.key].status !== "active") return;
          if (current[mine.key].uid !== uid) return;

          const myTime = current[mine.key].createdAt;
          const finishedAt = Date.now();

          Object.keys(current).forEach(key => {
            const entry = current[key];
            if (entry.status === "active" && entry.createdAt < myTime) {
              entry.status = "skipped";
              entry.finishedAt = finishedAt;
            }
          });

          current[mine.key].status = "completed";
          current[mine.key].finishedAt = finishedAt;
          return current;
        });

        if (!result.committed) {
          throw new Error("Запись уже изменена или принадлежит другому аккаунту.");
        }
      } else {
        entries = entries.map(entry => {
          if (entry.status === "active" && entry.createdAt < mine.createdAt) {
            return { ...entry, status: "skipped", finishedAt: Date.now() };
          }
          if (entry.key === mine.key) {
            return { ...entry, status: "completed", finishedAt: Date.now() };
          }
          return entry;
        });
        saveDemo();
      }

      els.name.value = localStorage.getItem("queue_full_name") || "";
      showToast("Сдача отмечена. Можно записаться снова.");
      render();
    } catch (error) {
      showToast(`Не удалось обновить очередь: ${error.message}`, true);
    } finally {
      busy = false;
      render();
    }
  }

  let toastTimer;

  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast show${error ? " error" : ""}`;
    toastTimer = setTimeout(() => {
      els.toast.className = "toast";
    }, 3500);
  }

  els.form.addEventListener("submit", book);

  window.addEventListener("storage", event => {
    if (!db && activeSession && event.key === `queue_${activeSession}`) {
      subscribeToSession(activeSession);
    }
  });

  (async () => {
    els.name.value = localStorage.getItem("queue_full_name") || "";
    await initFirebase();
    updateScheduleUI();
    setInterval(updateScheduleUI, 1000);
  })();
})();

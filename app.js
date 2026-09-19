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

  const pad = number => String(number).padStart(2, "0");
  const normalizeName = value => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  const safe = value => String(value).replace(/[&<>'"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);

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
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12) + 86400000);
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

    const upcomingIndex = SESSIONS.findIndex(
      session => now < toMinutes(session.start) - 10
    );

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

  function injectInterface() {
    const bookingPanel = document.querySelector(".booking-panel");

    if (bookingPanel && !document.querySelector("#auth-block")) {
      const authBlock = document.createElement("div");
      authBlock.id = "auth-block";
      authBlock.style.cssText = "margin-bottom:20px;padding:14px;border:1px solid var(--line,#e6e5e3);border-radius:10px;background:var(--canvas,#f9f8f7)";
      authBlock.innerHTML = `
        <div id="logged-out-block">
          <p style="margin:0 0 12px;color:var(--muted,#7d7a75);font-size:13px">
            Войдите, чтобы управлять записью с любого устройства.
          </p>
          <label for="auth-login">Логин</label>
          <input id="auth-login" type="text" autocomplete="username" placeholder="Минимум 3 символа" maxlength="50" style="margin-bottom:10px" />
          <label for="auth-password">Пароль</label>
          <input id="auth-password" type="password" autocomplete="current-password" placeholder="Минимум 6 символов" minlength="6" maxlength="100" style="margin-bottom:12px" />
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button id="password-login-button" class="button button-primary" type="button">
              <span>Войти</span><span aria-hidden="true">→</span>
            </button>
            <button id="register-button" type="button" style="min-height:48px;border:1px solid var(--line,#e6e5e3);border-radius:10px;background:white;font-weight:700;cursor:pointer">
              Регистрация
            </button>
          </div>
          <p style="margin:10px 0 0;color:var(--muted,#7d7a75);font-size:12px">
            При первом входе нажмите «Регистрация».
          </p>
        </div>
        <div id="logged-in-block" class="is-hidden" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="min-width:0">
            <strong style="display:block;font-size:14px">Вы вошли</strong>
            <span id="user-login" style="color:var(--muted,#7d7a75);font-size:12px"></span>
          </div>
          <button id="logout-button" type="button" style="min-height:40px;padding:0 12px;border:1px solid var(--line,#e6e5e3);border-radius:8px;background:white;font-weight:700;cursor:pointer">
            Выйти
          </button>
        </div>
      `;

      bookingPanel.insertBefore(authBlock, els.form);

      const slotPicker = document.createElement("div");
      slotPicker.id = "slot-picker";
      slotPicker.style.cssText = "margin:14px 0 18px";
      els.form.insertBefore(slotPicker, els.book);

      document.querySelector("#password-login-button").addEventListener("click", signInWithPassword);
      document.querySelector("#register-button").addEventListener("click", registerWithPassword);
      document.querySelector("#auth-password").addEventListener("keydown", event => {
        if (event.key === "Enter") signInWithPassword();
      });
      document.querySelector("#logout-button").addEventListener("click", signOut);
    }

    const contentGrid = document.querySelector(".content-grid");

    if (contentGrid && !document.querySelector("#admin-panel")) {
      const adminPanel = document.createElement("section");
      adminPanel.id = "admin-panel";
      adminPanel.className = "panel is-hidden";
      adminPanel.style.cssText = "margin-top:20px;min-height:0";
      adminPanel.innerHTML = `
        <div class="panel-heading">
          <div>
            <p class="eyebrow">Администратор</p>
            <h2>Управление очередью</h2>
          </div>
          <button id="admin-reset" type="button" style="min-height:40px;padding:0 12px;border:1px solid #e56458;border-radius:8px;background:#fce9e7;color:#a14c43;font-weight:700;cursor:pointer">
            Очистить очередь
          </button>
        </div>
        <div id="admin-list"></div>
      `;

      contentGrid.insertAdjacentElement("afterend", adminPanel);
      document.querySelector("#admin-reset").addEventListener("click", adminResetQueue);

      adminPanel.addEventListener("click", event => {
        const button = event.target.closest("button[data-key]");
        if (button) adminSetStatus(button.dataset.key, button.dataset.status);
      });
    }
  }

  function updateAuthInterface() {
    const loggedOut = document.querySelector("#logged-out-block");
    const loggedIn = document.querySelector("#logged-in-block");
    const loginLabel = document.querySelector("#user-login");
    const loginInput = document.querySelector("#auth-login");

    if (!loggedOut || !loggedIn || !loginLabel) return;
    if (loginInput && !loginInput.value && currentLogin) loginInput.value = currentLogin;

    if (!firebaseReady) {
      loggedOut.classList.add("is-hidden");
      loggedIn.classList.add("is-hidden");
      return;
    }

    if (currentUser) {
      loggedOut.classList.add("is-hidden");
      loggedIn.classList.remove("is-hidden");
      loginLabel.textContent = `${currentLogin || "Пользователь"}${isAdmin ? " · администратор" : ""}`;
    } else {
      loggedOut.classList.remove("is-hidden");
      loggedIn.classList.add("is-hidden");
      loginLabel.textContent = "";
    }
  }

  function readCredentials() {
    const login = (document.querySelector("#auth-login")?.value || "")
      .trim()
      .toLocaleLowerCase("ru-RU");
    const password = document.querySelector("#auth-password")?.value || "";

    if (login.length < 3) throw new Error("Логин должен содержать минимум 3 символа.");
    if (password.length < 6) throw new Error("Пароль должен содержать минимум 6 символов.");

    return { login, password };
  }

  async function loginToEmail(login) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(login));
    const hash = Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
    return `q${hash}@queue.local`;
  }

  function friendlyAuthError(error) {
    const messages = {
      "auth/email-already-in-use": "Такой логин уже зарегистрирован.",
      "auth/invalid-credential": "Неверный логин или пароль.",
      "auth/invalid-login-credentials": "Неверный логин или пароль.",
      "auth/user-not-found": "Неверный логин или пароль.",
      "auth/wrong-password": "Неверный логин или пароль.",
      "auth/weak-password": "Пароль должен содержать минимум 6 символов.",
      "auth/too-many-requests": "Слишком много попыток. Попробуйте позже.",
      "auth/operation-not-allowed": "Включите Email/Password в Firebase Authentication."
    };

    return messages[error.code] || error.message || "Ошибка авторизации.";
  }

  async function authAction(mode) {
    if (!auth || busy) return;

    busy = true;
    render();

    try {
      const { login, password } = readCredentials();
      const email = await loginToEmail(login);

      if (mode === "register") {
        await auth.createUserWithEmailAndPassword(email, password);
      } else {
        await auth.signInWithEmailAndPassword(email, password);
      }

      currentLogin = login;
      localStorage.setItem("queue_login", login);
      document.querySelector("#auth-password").value = "";
      showToast(mode === "register" ? "Аккаунт создан." : "Вход выполнен.");
    } catch (error) {
      showToast(friendlyAuthError(error), true);
    } finally {
      busy = false;
      render();
    }
  }

  const signInWithPassword = () => authAction("login");
  const registerWithPassword = () => authAction("register");

  async function signOut() {
    if (auth) await auth.signOut();
  }

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
      let firstState = true;

      auth.onAuthStateChanged(user => {
        currentUser = user;
        uid = user?.uid || null;
        authResolved = true;
        isAdmin = false;

        if (unsubscribeAdmin) {
          unsubscribeAdmin();
          unsubscribeAdmin = null;
        }

        if (uid) {
          const adminReference = db.ref(`admins/${uid}`);
          const adminHandler = snapshot => {
            isAdmin = snapshot.val() === true;
            updateAuthInterface();
            render();
          };

          adminReference.on("value", adminHandler);
          unsubscribeAdmin = () => adminReference.off("value", adminHandler);
        }

        if (activeSession) {
          subscribeToSession(activeSession);
        }

        updateAuthInterface();
        render();

        if (firstState) {
          firstState = false;
          resolve();
        }
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
    if (unsubscribeQueue) {
      unsubscribeQueue();
      unsubscribeQueue = null;
    }

    entries = [];

    if (!id) {
      render();
      return;
    }

    if (db && !uid) {
      render();
      return;
    }

    if (db) {
      const reference = db.ref(`sessions/${id}/entries`);
      const handler = snapshot => {
        entries = Object.entries(snapshot.val() || {})
          .map(([key, item]) => ({ key, ...item }));
        render();
      };

      reference.on(
        "value",
        handler,
        error => showToast(error.message, true)
      );

      unsubscribeQueue = () => reference.off("value", handler);
    } else {
      entries = JSON.parse(localStorage.getItem(`queue_${id}`) || "[]");
      render();
    }
  }

  function activeEntries() {
    return entries
      .filter(entry => entry.status === "active")
      .sort((first, second) => (
        first.slotNumber - second.slotNumber ||
        first.createdAt - second.createdAt
      ));
  }

  function myActiveEntry() {
    if (!uid) return null;
    return activeEntries().find(entry => entry.uid === uid) || null;
  }

  function nearestFreeSlots() {
    const occupied = new Set(activeEntries().map(entry => Number(entry.slotNumber)));
    const result = [];

    for (let number = 1; result.length < 3; number += 1) {
      if (!occupied.has(number)) result.push(number);
    }

    return result;
  }

  function renderSlotPicker() {
    const picker = document.querySelector("#slot-picker");
    if (!picker) return;

    const freeSlots = nearestFreeSlots();
    if (!freeSlots.includes(selectedSlot)) selectedSlot = freeSlots[0];

    picker.innerHTML = `
      <span style="display:block;margin-bottom:8px;font-size:14px;font-weight:700">
        Выберите место
      </span>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
        ${freeSlots.map(slot => `
          <button
            type="button"
            data-slot="${slot}"
            style="min-height:48px;border:1px solid ${selectedSlot === slot ? "#2783de" : "#e6e5e3"};border-radius:10px;background:${selectedSlot === slot ? "#e5f2fc" : "white"};color:${selectedSlot === slot ? "#246cae" : "#2c2c2b"};font-weight:800;cursor:pointer"
          >Место ${slot}</button>
        `).join("")}
      </div>
    `;

    picker.querySelectorAll("button[data-slot]").forEach(button => {
      button.addEventListener("click", () => {
        selectedSlot = Number(button.dataset.slot);
        renderSlotPicker();
      });
    });
  }

  function renderAdmin(active) {
    const panel = document.querySelector("#admin-panel");
    const list = document.querySelector("#admin-list");
    if (!panel || !list) return;

    panel.classList.toggle("is-hidden", !isAdmin);
    if (!isAdmin) return;

    list.innerHTML = active.length
      ? active.map(entry => `
          <div style="display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid #e6e5e3">
            <strong>#${entry.slotNumber}</strong>
            <span>${safe(entry.fullName)}</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
              <button data-key="${entry.key}" data-status="completed" type="button">Сдал</button>
              <button data-key="${entry.key}" data-status="skipped" type="button">Пропустил</button>
              <button data-key="${entry.key}" data-status="cancelled" type="button">Удалить</button>
            </div>
          </div>
        `).join("")
      : '<div class="empty-state">Очередь пустая.</div>';
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

    if (!activeSession) {
      els.list.innerHTML = '<div class="empty-state">Очередь откроется за 10 минут до следующей пары.</div>';
    } else if (!active.length) {
      els.list.innerHTML = '<div class="empty-state">Очередь пока пустая.<br>Можно занять первое место.</div>';
    } else {
      els.list.innerHTML = active.map((item, index) => {
        const time = new Date(item.createdAt).toLocaleTimeString("ru-RU", {
          timeZone: TZ,
          hour: "2-digit",
          minute: "2-digit"
        });
        const isMine = item.uid === uid;

        return `
          <div class="queue-row ${index === 0 ? "current" : ""}">
            <span class="queue-position">${item.slotNumber}</span>
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
      const order = active.findIndex(entry => entry.key === mine.key);
      const canFinish = order === 0;
      const hint = order === 0
        ? "Вы первый в очереди и можете отметить сдачу."
        : "Кнопка станет доступна, когда вы будете первым.";

      els.personal.className = "personal-status";
      els.personal.innerHTML = `
        <strong>Ваше место: ${mine.slotNumber}</strong>
        <span>${safe(mine.fullName)}</span>
        <p style="margin:8px 0 0;font-size:12px">${hint}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
          <button id="done-button" class="button button-success" type="button" ${canFinish ? "" : "disabled"}>
            Сдал лабу <span aria-hidden="true">✓</span>
          </button>
          <button id="cancel-button" type="button" style="min-height:48px;border:1px solid #e56458;border-radius:10px;background:#fce9e7;color:#a14c43;font-weight:700;cursor:pointer">
            Отменить
          </button>
        </div>
      `;

      els.personal.classList.remove("is-hidden");
      els.personal.querySelector("#done-button").addEventListener("click", completeMine);
      els.personal.querySelector("#cancel-button").addEventListener("click", cancelMine);
    } else {
      els.personal.classList.add("is-hidden");
      els.personal.innerHTML = "";
    }

    renderAdmin(active);
  }

  async function book(event) {
    event.preventDefault();

    if (firebaseReady && !uid) {
      showToast("Сначала войдите.", true);
      return;
    }

    const fullName = els.name.value.trim().replace(/\s+/g, " ");

    if (!activeSession) {
      showToast("Запись закрыта.", true);
      return;
    }

    if (fullName.length < 5 || fullName.split(" ").length < 2) {
      showToast("Введите фамилию и имя.", true);
      return;
    }

    if (!nearestFreeSlots().includes(selectedSlot)) {
      showToast("Место уже занято. Выберите другое.", true);
      return;
    }

    busy = true;
    render();

    const item = {
      uid,
      fullName,
      normalizedName: normalizeName(fullName),
      slotNumber: selectedSlot,
      status: "active",
      createdAt: Date.now()
    };

    try {
      if (db) {
        const reference = db.ref(`sessions/${activeSession}/entries`);
        const key = reference.push().key;
        let reason = "";

        const result = await reference.transaction(current => {
          current = current || {};
          const values = Object.values(current);

          if (values.some(entry => entry.status === "active" && entry.uid === uid)) {
            reason = "У вас уже есть запись.";
            return;
          }

          if (values.some(entry => entry.status === "active" && Number(entry.slotNumber) === selectedSlot)) {
            reason = "Это место уже занято.";
            return;
          }

          if (values.some(entry => entry.status === "active" && entry.normalizedName === item.normalizedName)) {
            reason = "Это ФИО уже есть в очереди.";
            return;
          }

          current[key] = item;
          return current;
        });

        if (!result.committed) throw new Error(reason || "Не удалось записаться.");
      } else {
        entries.push({ key: crypto.randomUUID(), ...item });
        saveDemo();
      }

      localStorage.setItem("queue_full_name", fullName);
      showToast(`Вы заняли место ${selectedSlot}.`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  function saveDemo() {
    localStorage.setItem(`queue_${activeSession}`, JSON.stringify(entries));
  }

  async function completeMine() {
    const mine = myActiveEntry();
    const active = activeEntries();
    const order = active.findIndex(entry => entry.key === mine?.key);

    if (!mine || order !== 0) {
      showToast("Сдать лабораторную может только первый в очереди.", true);
      return;
    }

    if (!confirm("Подтвердить сдачу лабораторной?")) return;

    busy = true;
    render();

    try {
      if (db) {
        const reference = db.ref(`sessions/${activeSession}/entries`);

        const result = await reference.transaction(current => {
          if (
            !current?.[mine.key] ||
            current[mine.key].uid !== uid ||
            current[mine.key].status !== "active"
          ) {
            return;
          }

          const sorted = Object.entries(current)
            .filter(([, entry]) => entry.status === "active")
            .sort((first, second) => (
              first[1].slotNumber - second[1].slotNumber ||
              first[1].createdAt - second[1].createdAt
            ));

          if (!sorted.length || sorted[0][0] !== mine.key) return;

          current[mine.key].status = "completed";
          current[mine.key].finishedAt = Date.now();
          return current;
        });

        if (!result.committed) {
          throw new Error("Очередь уже изменилась. Сдача доступна только первому.");
        }
      } else {
        entries = entries.map(entry => (
          entry.key === mine.key
            ? { ...entry, status: "completed", finishedAt: Date.now() }
            : entry
        ));
        saveDemo();
      }

      showToast("Сдача отмечена.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  async function cancelMine() {
    const mine = myActiveEntry();
    if (!mine || !confirm(`Отменить запись на место ${mine.slotNumber}?`)) return;
    await setOwnStatus(mine, "cancelled", "Запись отменена.");
  }

  async function setOwnStatus(mine, status, message) {
    busy = true;
    render();

    try {
      if (db) {
        const reference = db.ref(`sessions/${activeSession}/entries/${mine.key}`);
        const result = await reference.transaction(current => {
          if (!current || current.uid !== uid || current.status !== "active") return;
          current.status = status;
          current.finishedAt = Date.now();
          return current;
        });

        if (!result.committed) throw new Error("Запись уже изменилась.");
      } else {
        entries = entries.map(entry => (
          entry.key === mine.key
            ? { ...entry, status, finishedAt: Date.now() }
            : entry
        ));
        saveDemo();
      }

      showToast(message);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      busy = false;
      render();
    }
  }

  async function adminSetStatus(key, status) {
    if (!isAdmin || !activeSession) return;

    const entry = entries.find(item => item.key === key);
    if (!entry) return;

    const action = status === "completed"
      ? "Отметить сдачу"
      : status === "skipped"
        ? "Отметить пропуск"
        : "Удалить запись";

    if (!confirm(`${action}: ${entry.fullName}?`)) return;

    try {
      await db.ref(`sessions/${activeSession}/entries/${key}`).update({
        status,
        finishedAt: Date.now()
      });
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function adminResetQueue() {
    if (!isAdmin || !activeSession || !confirm("Очистить всю активную очередь?")) return;

    try {
      const reference = db.ref(`sessions/${activeSession}/entries`);
      await reference.transaction(current => {
        if (!current) return current;
        const now = Date.now();

        Object.values(current).forEach(entry => {
          if (entry.status === "active") {
            entry.status = "cancelled";
            entry.finishedAt = now;
          }
        });

        return current;
      });
    } catch (error) {
      showToast(error.message, true);
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

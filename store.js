/* =====================================================================
   gute dinge des tages – Speicher
   Liest und schreibt die Datei moments.json in einem privaten
   GitHub-Repository über die GitHub-API.

   Offline: Jede Änderung kommt zuerst in eine Warteschlange auf dem
   Gerät und wird verschickt, sobald Verbindung da ist. Der letzte
   bekannte Stand wird ebenfalls auf dem Gerät gemerkt, damit die App
   auch ohne Netz alles anzeigt.

   Solange "owner" leer ist, läuft die App im Demo-Modus mit
   Beispieldaten, die nirgends gespeichert werden.
   ===================================================================== */

const CONFIG = {
  owner: "ZoraScheel",         // dein GitHub-Benutzername
  repo: "momente-daten",       // Name des PRIVATEN Repositorys mit den Daten
  branch: "main",
  path: "moments.json",
  people: ["Anne", "Hannah"],  // eure Namen – links und rechts in der Tabelle
};

const Store = (() => {
  const API = "https://api.github.com";
  const KEY_TOKEN = "momente.token";
  const KEY_ME = "momente.me";
  const KEY_CACHE = "momente.cache";
  const KEY_QUEUE = "momente.queue";
  const isDemo = !CONFIG.owner;

  /* ---------- kleine Helfer ---------- */
  const local = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    json(k, fallback) { try { return JSON.parse(local.get(k)) || fallback; } catch (e) { return fallback; } },
  };
  function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }
  const retryable = (e) => e && (e.code === "offline" || e.code === "network");

  // Base64 mit Umlauten & Emojis (btoa allein kann nur ASCII)
  function encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function decode(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function now() { return new Date().toISOString(); }
  function ymd(x) { const p = (n) => String(n).padStart(2, "0"); return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate()); }
  function clone(a) { return a.map((m) => ({ ...m })); }

  /* ---------- Zustand ---------- */
  let sha = null;                                            // Version der Datei auf GitHub
  let data = { version: 1, moments: [] };                    // letzter Stand vom Server
  let queue = isDemo ? [] : local.json(KEY_QUEUE, []);       // noch nicht verschickte Änderungen
  let flushing = null;

  if (!isDemo) data.moments = local.json(KEY_CACHE, []);

  function saveQueue() { local.set(KEY_QUEUE, JSON.stringify(queue)); }
  function saveCache() { local.set(KEY_CACHE, JSON.stringify(data.moments)); }

  /* ---------- Änderungen ---------- */
  // Eine Änderung ist ein kleines Objekt, das sich jederzeit (auch später) anwenden lässt.
  function applyOp(all, op) {
    const mine = all.filter((x) => x.date === op.date && x.author === op.author);
    const drop = (list) => list.forEach((x) => all.splice(all.indexOf(x), 1));
    if (op.type === "add") {
      if (mine.length) {
        mine[0].text = mine.map((x) => x.text).concat(op.text).join(", ");
        mine[0].editedAt = op.at;
        drop(mine.slice(1));
      } else {
        all.push({ id: op.id, date: op.date, author: op.author, text: op.text, createdAt: op.at });
      }
    } else if (op.type === "setDay") {
      drop(mine.slice(1));
      if (!op.text) { if (mine[0]) drop([mine[0]]); return; }
      if (mine[0]) { mine[0].text = op.text; mine[0].editedAt = op.at; }
      else all.push({ id: op.id, date: op.date, author: op.author, text: op.text, createdAt: op.at });
    }
  }
  function message(op) {
    if (op.type === "add") return "moment: " + op.date + " " + op.author;
    return (op.text ? "geändert: " : "gelöscht: ") + op.date + " " + op.author;
  }

  // Was angezeigt wird: Serverstand + noch wartende Änderungen
  function view() {
    const all = clone(data.moments);
    queue.forEach((op) => applyOp(all, op));
    return all;
  }

  // Ein Moment pro Zeile: bleibt lesbar, ist aber viel kleiner als eingerückt
  function serialize(moments) {
    const sorted = moments.slice().sort((a, b) => (a.date + a.author).localeCompare(b.date + b.author));
    return '{"version":1,"moments":[\n' + sorted.map((m) => JSON.stringify(m)).join(",\n") + "\n]}\n";
  }

  /* ---------- GitHub ---------- */
  async function request(method, body, accept) {
    const url = API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + CONFIG.path +
      (method === "GET" ? "?ref=" + encodeURIComponent(CONFIG.branch) : "");
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw fail("offline", "keine verbindung");
    let res;
    try {
      res = await fetch(url, {
        method,
        cache: "no-store",
        headers: {
          Authorization: "Bearer " + local.get(KEY_TOKEN),
          Accept: accept || "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw fail("offline", "keine verbindung");
    }
    if (res.status === 401) throw fail("auth", "zugangsschlüssel ungültig oder abgelaufen");
    if (res.status === 403) throw fail("auth", "kein zugriff auf das repository");
    if (res.status >= 500) throw fail("network", "github antwortet gerade nicht");
    return res;
  }

  async function pull() {
    const res = await request("GET");
    if (res.status === 404) { sha = null; data = { version: 1, moments: [] }; saveCache(); return; }
    if (!res.ok) throw fail("network", "laden fehlgeschlagen");
    const json = await res.json();
    sha = json.sha;
    let text = json.content ? decode(json.content) : "";
    // Ab 1 MB liefert GitHub den Inhalt nicht mehr mit – dann als Rohtext nachladen (bis 100 MB)
    if (!text && json.size > 0) {
      const raw = await request("GET", null, "application/vnd.github.raw+json");
      if (!raw.ok) throw fail("network", "laden fehlgeschlagen");
      text = await raw.text();
    }
    const parsed = text ? JSON.parse(text) : {};
    data = { version: 1, moments: Array.isArray(parsed.moments) ? parsed.moments : [] };
    saveCache();
  }

  async function push(msg) {
    const res = await request("PUT", {
      message: msg,
      content: encode(serialize(data.moments)),
      branch: CONFIG.branch,
      ...(sha ? { sha } : {}),
    });
    if (res.status === 409 || res.status === 422) throw fail("conflict");
    if (!res.ok) throw fail("network", "speichern fehlgeschlagen");
    const json = await res.json();
    sha = json.content.sha;
    saveCache();
  }

  // Neuesten Stand holen, Änderung anwenden, zurückschreiben.
  // Hat die andere Person gleichzeitig gespeichert, wird es neu versucht.
  async function mutate(op) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await pull();
      applyOp(data.moments, op);
      try { await push(message(op)); return; }
      catch (e) { if (e.code !== "conflict" || attempt === 3) throw e; }
    }
  }

  // Warteschlange der Reihe nach abarbeiten
  function flush() {
    if (isDemo || !queue.length) return Promise.resolve();
    if (flushing) return flushing;
    flushing = (async () => {
      while (queue.length) {
        await mutate(queue[0]);
        queue.shift();
        saveQueue();
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // Neue Änderung: sofort merken & anzeigen, dann versuchen zu senden
  async function enqueue(op) {
    if (isDemo) { applyOp(data.moments, op); return view(); }
    queue.push(op);
    saveQueue();
    try { await flush(); }
    catch (e) { if (!retryable(e)) throw e; }   // offline: bleibt in der Warteschlange
    return view();
  }

  /* ---------- Demo-Modus ---------- */
  function demoData() {
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return ymd(x); };
    const yearAgo = (() => { const x = new Date(); x.setFullYear(x.getFullYear() - 1); return ymd(x); })();
    const [a, b] = CONFIG.people;
    let t = 0;
    const m = (date, author, text) => ({ id: "demo" + t, date, author, text, createdAt: new Date(Date.now() - 1e6 + t++ * 1000).toISOString() });
    return [
      m(d(0), b, "der erste kaffee auf dem balkon"),
      m(d(1), a, "lange mit papa telefoniert"),
      m(d(1), b, "regen auf dem dachfenster, endlich das buch fertig"),
      m(d(2), a, "frisches brot vom markt"),
      m(d(4), a, "sonnenuntergang auf dem heimweg"),
      m(d(4), b, "die präsentation lief gut"),
      m(d(40), b, "erster schnee"),
      m(yearAgo, a, "picknick am see"),
      m(yearAgo, b, "zum ersten mal surfen, viel gelacht"),
    ];
  }
  if (isDemo) data.moments = demoData();

  /* ---------- öffentliche Schnittstelle ---------- */
  return {
    isDemo,
    people: CONFIG.people,

    me() { return isDemo ? CONFIG.people[0] : local.get(KEY_ME); },
    ready() { return isDemo || (!!local.get(KEY_TOKEN) && CONFIG.people.includes(local.get(KEY_ME))); },
    pending() { return queue.length; },        // wie viele Änderungen noch warten
    snapshot() { return view(); },             // sofort anzeigbar, auch offline

    // Einmalige Einrichtung auf jedem Handy
    async setup({ token, me }) {
      local.set(KEY_TOKEN, token.trim());
      local.set(KEY_ME, me);
      try { await pull(); }
      catch (e) { local.del(KEY_TOKEN); throw e; }
      await flush().catch(() => {});
    },
    logout() { local.del(KEY_TOKEN); local.del(KEY_ME); },

    // Wartendes senden, dann neuesten Stand holen. Offline: letzter bekannter Stand.
    async load() {
      if (isDemo) return view();
      try { await flush(); await pull(); return view(); }
      catch (e) { if (!retryable(e)) throw e; e.rows = view(); throw e; }
    },

    // Wartendes senden (z. B. wenn das Netz zurück ist)
    async sync() { await flush(); return view(); },

    // Neuer Moment: wird an den bestehenden Eintrag des Tages mit ", " angehängt
    add({ date, text }) {
      return enqueue({ type: "add", id: newId(), date, author: this.me(), text, at: now() });
    },

    // Ganzen Tag einer Person ersetzen (leerer Text = Tag löschen)
    setDay(date, text) {
      return enqueue({ type: "setDay", id: newId(), date, author: this.me(), text, at: now() });
    },
  };
})();

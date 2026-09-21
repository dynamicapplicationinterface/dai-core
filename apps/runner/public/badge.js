/*
 * The home-screen badge: how many games wait on this person (backlog D34).
 *
 * One file, loaded by the service worker (importScripts) and by the opener's
 * page (a plain script tag), so the count is decided in exactly one place.
 *
 * Where the number comes from. The application knows whose turn it is; the
 * opener does not, and the worker cannot read the rows at all. So while a
 * document is open, the application reports which of its games wait on this
 * person (`window.dai.reportWaiting(sessions)`), and that report is kept here,
 * per document. When a push lands for a game, the worker adds that game to the
 * games that moved since. The badge is the number of distinct games in either
 * set: a game already waiting does not raise it, and a game that moves twice
 * counts once.
 *
 * **A document that has never reported is not counted at all** (D34). The
 * number means "games waiting on you", and only the application knows that; for
 * a document that never says, a count would be the worker guessing on its
 * behalf — one that nothing it does can ever correct, because the correction is
 * the report. So the badge stays silent for it rather than saying a number
 * nobody can trust. `reportWaiting` is what a document opts in with.
 *
 * What the number is, plainly. The application is not running when a push
 * lands, so between opens the badge is a remembered report plus a guess. A game
 * moves for things that are not a turn (a rename, a close, a resend), and each
 * of those raises it too. It is a hint to open the document, never a fact to
 * build on. Opening the document clears it, and the application's next report
 * resets the remembered part to the truth.
 *
 * Every badge call is feature-detected. Where the API is absent nothing throws,
 * and on Android, whose launchers mostly show a dot, the count is best effort.
 */
(function (scope) {
  "use strict";

  var DB_NAME = "dai_badge";
  var STORE = "documents";

  /**
   * The number of distinct games waiting or moved, for one document's entry.
   *
   * Zero for a document that has never reported: see the note at the top. The
   * flag is what the report sets, not the presence of a `waiting` list — an
   * application whose every game is answered reports an empty list, and that is
   * a document saying "none", which is different from one that never says.
   */
  function count(entry) {
    if (!entry || !entry.reports) return 0;
    var seen = {};
    var n = 0;
    var ids = [].concat(entry.waiting || [], entry.moved || []);
    for (var i = 0; i < ids.length; i += 1) {
      if (typeof ids[i] === "string" && ids[i] && !seen[ids[i]]) {
        seen[ids[i]] = true;
        n += 1;
      }
    }
    return n;
  }

  /** A document's entry after the application reported which games wait on this person. The report is the truth: what moved before it is folded in. */
  function afterReport(entry, uuid, sessions) {
    var waiting = [];
    for (var i = 0; i < (sessions || []).length; i += 1) {
      var s = sessions[i];
      if (typeof s === "string" && /^[0-9a-f]{32}$/.test(s) && waiting.indexOf(s) < 0) waiting.push(s);
    }
    return { uuid: uuid, waiting: waiting, moved: [], shown: 0, reports: true };
  }

  /** A document's entry after a push for one of its games. */
  function afterPush(entry, uuid, game) {
    var next = {
      uuid: uuid,
      waiting: (entry && entry.waiting) || [],
      moved: ((entry && entry.moved) || []).slice(),
      reports: Boolean(entry && entry.reports),
    };
    if (typeof game === "string" && game && next.moved.indexOf(game) < 0) next.moved.push(game);
    // What the icon is given, kept beside the reason for it, so a trace can read both.
    next.shown = count(next);
    return next;
  }

  /** A document's entry once the person has it open: nothing is news any more. */
  function afterOpen(entry, uuid) {
    return {
      uuid: uuid,
      waiting: (entry && entry.waiting) || [],
      moved: [],
      shown: 0,
      reports: Boolean(entry && entry.reports),
    };
  }

  function open() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "uuid" });
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  /** Reads one document's entry, changes it, writes it back, in one transaction. Resolves to the new entry. */
  function update(uuid, change) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        var store = tx.objectStore(STORE);
        var next = null;
        var read = store.get(uuid);
        read.onsuccess = function () {
          next = change(read.result || null);
          store.put(next);
        };
        tx.oncomplete = function () {
          db.close();
          resolve(next);
        };
        tx.onerror = tx.onabort = function () {
          db.close();
          reject(tx.error);
        };
      });
    });
  }

  /** Shows `n` on the icon, or clears it at zero. Never throws; resolves to what was asked of the API, or "unsupported". */
  function show(n) {
    var nav = scope.navigator;
    try {
      if (n > 0) {
        if (nav && typeof nav.setAppBadge === "function") return nav.setAppBadge(n).then(function () { return n; }, function () { return n; });
      } else if (nav && typeof nav.clearAppBadge === "function") {
        return nav.clearAppBadge().then(function () { return 0; }, function () { return 0; });
      }
    } catch (error) {
      /* An API that exists and throws is treated as one that does not. */
    }
    return Promise.resolve("unsupported");
  }

  scope.daiBadge = {
    count: count,
    afterReport: afterReport,
    afterPush: afterPush,
    afterOpen: afterOpen,
    show: show,
    /** The worker, on a push for `game` of document `uuid`. Resolves to the count shown. */
    pushed: function (uuid, game) {
      return update(uuid, function (entry) {
        return afterPush(entry, uuid, game);
      }).then(function (entry) {
        var n = count(entry);
        return show(n).then(function () {
          return n;
        });
      });
    },
    /** The page, when the application reports its waiting games. The badge is cleared: the person is looking at the document. */
    reported: function (uuid, sessions) {
      return update(uuid, function (entry) {
        return afterReport(entry, uuid, sessions);
      }).then(function () {
        return show(0);
      });
    },
    /** The page, when a document mounts. */
    opened: function (uuid) {
      return update(uuid, function (entry) {
        return afterOpen(entry, uuid);
      }).then(function () {
        return show(0);
      });
    },
  };
})(typeof self !== "undefined" ? self : globalThis);

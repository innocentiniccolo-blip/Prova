'use strict';
const session = require('express-session');
const db = require('./db');

const ONE_DAY = 24 * 60 * 60 * 1000;

/** Store delle sessioni su SQLite: le sessioni sopravvivono al riavvio del container. */
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.qGet = db.prepare('SELECT dati FROM sessioni WHERE sid = ? AND scade > ?');
    this.qSet = db.prepare('INSERT INTO sessioni (sid, dati, scade) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET dati = excluded.dati, scade = excluded.scade');
    this.qDel = db.prepare('DELETE FROM sessioni WHERE sid = ?');
    this.qTouch = db.prepare('UPDATE sessioni SET scade = ? WHERE sid = ?');
    this.qPurge = db.prepare('DELETE FROM sessioni WHERE scade <= ?');
    setInterval(() => this.qPurge.run(Date.now()), 60 * 60 * 1000).unref();
  }
  scadenza(sess) {
    return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + ONE_DAY;
  }
  get(sid, cb) {
    try {
      const row = this.qGet.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.dati) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.qSet.run(sid, JSON.stringify(sess), this.scadenza(sess)); cb?.(null); } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) {
    try { this.qDel.run(sid); cb?.(null); } catch (e) { cb?.(e); }
  }
  touch(sid, sess, cb) {
    try { this.qTouch.run(this.scadenza(sess), sid); cb?.(null); } catch (e) { cb?.(e); }
  }
}

module.exports = SqliteStore;

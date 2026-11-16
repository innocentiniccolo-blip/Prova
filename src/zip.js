'use strict';
/** Archivio ZIP minimo (deflate), senza dipendenze: per il "fascicolo" scaricabile. */
const fs = require('node:fs');
const zlib = require('node:zlib');

function dataDos(d) {
  const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
  const g = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { t, g };
}

/** voci: [{ nome, percorso }] → Buffer dello ZIP (nomi in UTF-8). */
function creaZip(voci) {
  const parti = [];
  const centrale = [];
  let offset = 0;
  for (const v of voci) {
    const dati = fs.readFileSync(v.percorso);
    const st = fs.statSync(v.percorso);
    const compresso = zlib.deflateRawSync(dati, { level: 6 });
    const crc = zlib.crc32(dati) >>> 0;
    const nome = Buffer.from(v.nome.replace(/\\/g, '/'), 'utf8');
    const { t, g } = dataDos(st.mtime);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt16LE(t, 10); loc.writeUInt16LE(g, 12); loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(compresso.length, 18); loc.writeUInt32LE(dati.length, 22); loc.writeUInt16LE(nome.length, 26); loc.writeUInt16LE(0, 28);
    parti.push(loc, nome, compresso);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(t, 12); cen.writeUInt16LE(g, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(compresso.length, 20);
    cen.writeUInt32LE(dati.length, 24); cen.writeUInt16LE(nome.length, 28); cen.writeUInt32LE(offset, 42);
    centrale.push(cen, nome);
    offset += loc.length + nome.length + compresso.length;
  }
  const dimCentrale = centrale.reduce((n, b) => n + b.length, 0);
  const fine = Buffer.alloc(22);
  fine.writeUInt32LE(0x06054b50, 0); fine.writeUInt16LE(voci.length, 8); fine.writeUInt16LE(voci.length, 10);
  fine.writeUInt32LE(dimCentrale, 12); fine.writeUInt32LE(offset, 16);
  return Buffer.concat([...parti, ...centrale, fine]);
}

module.exports = { creaZip };

'use strict';
/**
 * Crea (o aggiorna) l'account dello studio.
 * Uso: npm run crea-admin -- email@studio.it "Nome Cognome"
 * La password viene chiesta in modo interattivo.
 */
const readline = require('node:readline');
const { Utenti } = require('../src/modelli');
const auth = require('../src/auth');

async function chiediPassword(domanda) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(domanda)) rl.output.write(s); };
  return new Promise((ok) => rl.question(domanda, (r) => { rl.close(); process.stdout.write('\n'); ok(r); }));
}

(async () => {
  const [email, nome = 'Studio'] = process.argv.slice(2);
  if (!email) {
    console.error('Uso: npm run crea-admin -- email@studio.it "Nome Cognome"');
    process.exit(1);
  }
  const pw = process.env.ADMIN_PASSWORD || (await chiediPassword('Password (min. 12 caratteri): '));
  if (pw.length < 12) {
    console.error('Password troppo corta.');
    process.exit(1);
  }
  const hash = await auth.hashPassword(pw);
  const esistente = Utenti.perEmail.get(email);
  if (esistente) {
    Utenti.impostaPassword.run(hash, esistente.id);
    console.log(`Password aggiornata per ${email}.`);
  } else {
    Utenti.inserisci.run(email.toLowerCase(), hash, nome, null, 'admin');
    console.log(`Account studio creato: ${email}`);
  }
})();

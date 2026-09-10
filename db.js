// Простое JSON-хранилище на файловой системе.
// Без нативных зависимостей — работает на любом VPS с Node.js без сборки.
// Для небольшого потока регистраций (десятки-сотни в день) этого достаточно.
// Если поток вырастет — замените на настоящую БД (Postgres/SQLite), интерфейс ниже несложно перенести.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'participants.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ participants: [] }, null, 2), 'utf8');
  }
}

function readAll() {
  ensureStore();
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // повреждённый файл — не теряем данные молча, поднимаем ошибку
    throw new Error('Файл базы данных повреждён: ' + DB_FILE);
  }
}

function writeAll(data) {
  ensureStore();
  // атомарная запись: сначала во временный файл, потом переименование
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

// простая блокировка на процесс, чтобы параллельные запросы не затирали друг друга
let writeChain = Promise.resolve();
function withLock(fn) {
  const result = writeChain.then(() => fn());
  writeChain = result.catch(() => {}); // не рвём цепочку при ошибке одного запроса
  return result;
}

const MAX_ATTEMPTS = 5;

// участники, заведённые до появления истории попыток, хранили только
// последний результат — при первом обращении превращаем его в attempts[0]
function ensureAttempts(p) {
  if (!Array.isArray(p.attempts)) {
    p.attempts = p.profile
      ? [{ answers: p.answers, profile: p.profile, scores: p.scores, at: p.resultAt }]
      : [];
  }
}

function createParticipant({ name, role, phone, email }) {
  return withLock(() => {
    const data = readAll();
    const participant = {
      id: require('crypto').randomUUID(),
      name,
      role: role || null,
      phone,
      email,
      consent: true,
      consentAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      attempts: [],
      answers: null,
      profile: null,
      resultAt: null,
      booked: false,
      bookedAt: null
    };
    data.participants.push(participant);
    writeAll(data);
    return participant;
  });
}

function findParticipant(id) {
  const data = readAll();
  const p = data.participants.find(p => p.id === id) || null;
  if (p) ensureAttempts(p);
  return p;
}

function saveResult(id, answers, profile, scores) {
  return withLock(() => {
    const data = readAll();
    const p = data.participants.find(x => x.id === id);
    if (!p) return { ok: false, reason: 'not_found' };
    ensureAttempts(p);
    if (p.attempts.length >= MAX_ATTEMPTS) {
      return { ok: false, reason: 'limit' };
    }
    const at = new Date().toISOString();
    p.attempts.push({ answers, profile, scores, at });
    p.answers = answers;
    p.profile = profile;
    p.scores = scores;
    p.resultAt = at;
    writeAll(data);
    return { ok: true, participant: p, attemptNumber: p.attempts.length };
  });
}

function markBooked(id) {
  return withLock(() => {
    const data = readAll();
    const p = data.participants.find(x => x.id === id);
    if (!p) return null;
    p.booked = true;
    p.bookedAt = new Date().toISOString();
    writeAll(data);
    return p;
  });
}

function listParticipants() {
  const list = readAll().participants;
  list.forEach(ensureAttempts);
  return list;
}

module.exports = {
  createParticipant,
  findParticipant,
  saveResult,
  markBooked,
  listParticipants,
  MAX_ATTEMPTS
};

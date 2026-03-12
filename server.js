const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT = process.env.PORT || 3000;

// Sin caché para HTML y JS propios (los cambios se ven siempre de inmediato)
app.use((req, res, next) => {
  if ((req.path.endsWith('.html') || req.path.endsWith('.js')) && !req.path.includes('socket.io')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname)));

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────

const QUESTIONS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT7IiShLIDNSMcbHOcvvOg4jfGAXUoNfp9n_lXjBG6aVNKfpBY1mKh9hwlXq1Pk5DgGXL9MyvrBQEFf/pub?gid=0&single=true&output=csv';

const RESPAWN_DELAY_BREAK_MS    = 5000;   // segons per respawn caixa verda trencada
const RESPAWN_DELAY_QUESTION_MS = 2000;   // segons per respawn caixa de pregunta
const NUM_BREAKABLE             = 45;     // caixes verdes
const NUM_QUESTIONS             = 23;     // caixes de preguntes
const PTS_BY_DIFF      = { 1: 5, 2: 10, 3: 15, 4: 20, 5: 25 };
const PTS_WRONG        = -5;

// Directorio de logs (en el mismo directorio del servidor)
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

// Límites del nivel (del navmesh)
const BOUNDS = { minX: 3, maxX: 43, minZ: -7, maxZ: 37 };

// Colores para jugadores
const PLAYER_COLORS = [
  '#ff4444','#44aaff','#44ff88','#ffcc00','#ff44cc','#44ffee',
  '#ff8844','#8844ff','#aaffaa','#ff4488','#00ccff','#ffaa44',
  '#cc44ff','#44ffaa','#ff6600','#0088ff','#ff0088','#88ff00',
  '#0044ff','#ff4400',
];

// Preguntas de respaldo (si no hay CSV configurado o falla la carga)
const FALLBACK_QUESTIONS = [
  { question:'¿Cuánto es 7 × 8?',                         answers:['42','56','63','48'],           correct:1 },
  { question:'¿Capital de Francia?',                       answers:['Berlín','Madrid','París','Roma'], correct:2 },
  { question:'¿Planetas del sistema solar?',               answers:['7','8','9','10'],              correct:1 },
  { question:'¿Año final de la 2ª Guerra Mundial?',        answers:['1918','1939','1945','1950'],   correct:2 },
  { question:'¿Cuánto es 12 × 12?',                        answers:['132','144','156','124'],       correct:1 },
  { question:'¿Capital de España?',                        answers:['Barcelona','Sevilla','Valencia','Madrid'], correct:3 },
  { question:'¿Raíz cuadrada de 144?',                     answers:['10','11','12','13'],           correct:2 },
  { question:'¿Año del primer viaje a la Luna?',           answers:['1967','1968','1969','1970'],   correct:2 },
  { question:'¿Cuánto es 9 × 9?',                          answers:['72','81','90','63'],           correct:1 },
  { question:'¿Lados de un hexágono?',                     answers:['4','5','6','7'],               correct:2 },
  { question:'¿Cuánto es 15 + 27?',                        answers:['40','41','42','43'],           correct:2 },
  { question:'¿En qué continente está Brasil?',            answers:['Europa','Asia','África','América'], correct:3 },
];

// ─── PARSEO CSV ──────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const cols = []; let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSV(csv) {
  const questions = [];
  for (const line of csv.replace(/\r/g,'').split('\n')) {
    if (!line.trim()) continue;
    const c = parseCSVLine(line);
    if (c.length < 6) continue;
    const idx = parseInt(c[5], 10) - 1;   // 0-based
    if (isNaN(idx) || idx < 0 || idx > 3) continue;
    if (!c[0] || !c[1]) continue;
    const rawDiff = parseInt(c[6], 10);
    const difficulty = (!isNaN(rawDiff) && rawDiff >= 1 && rawDiff <= 5) ? rawDiff : 1;
    const pts = PTS_BY_DIFF[difficulty] ?? 10;
    questions.push({ question: c[0], answers: [c[1], c[2], c[3], c[4]], correct: idx, difficulty, pts });
  }
  return questions;
}

async function loadQuestions() {
  if (!QUESTIONS_CSV_URL) {
    console.log('  Sin URL de CSV → usando preguntas de ejemplo');
    return FALLBACK_QUESTIONS;
  }
  try {
    console.log('  Cargando preguntas desde Google Sheets...');
    const res  = await fetch(QUESTIONS_CSV_URL + '&_t=' + Date.now());
    const text = await res.text();
    const qs   = parseCSV(text);
    if (!qs.length) throw new Error('CSV vacío o sin preguntas válidas');
    console.log(`  ${qs.length} preguntas cargadas del CSV`);
    return qs;
  } catch (e) {
    console.warn(`  Error al cargar CSV (${e.message}) → usando preguntas de ejemplo`);
    return FALLBACK_QUESTIONS;
  }
}

// ─── GENERACIÓN DE CAJAS ─────────────────────────────────────────────────────

function randPos(existing, minDist) {
  for (let i = 0; i < 80; i++) {
    const x = BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX);
    const z = BOUNDS.minZ + Math.random() * (BOUNDS.maxZ - BOUNDS.minZ);
    if (existing.every(b => Math.hypot(b.x - x, b.z - z) >= minDist)) return { x, z };
  }
  return {
    x: BOUNDS.minX + Math.random() * (BOUNDS.maxX - BOUNDS.minX),
    z: BOUNDS.minZ + Math.random() * (BOUNDS.maxZ - BOUNDS.minZ),
  };
}

function pickQuestion(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function generateBoxes(questionPool) {
  const boxes = [];
  let id = 0;

  // Cajas rompibles
  for (let i = 0; i < NUM_BREAKABLE; i++) {
    const pos = randPos(boxes, 3);
    boxes.push({ id: id++, type: 'breakable', x: pos.x, z: pos.z, broken: false });
  }

  // Cajas de preguntas (una por cada pregunta del pool, máx NUM_QUESTIONS)
  const numQ = Math.min(questionPool.length, NUM_QUESTIONS);
  for (let i = 0; i < numQ; i++) {
    const pos = randPos(boxes, 5);
    const q   = questionPool[i % questionPool.length];
    boxes.push({
      id: id++, type: 'question',
      x: pos.x, z: pos.z,
      question: q.question, answers: q.answers, correct: q.correct,
      pts: q.pts ?? 10, difficulty: q.difficulty ?? 1,
      answered: false, answeredBy: null,
    });
  }
  return boxes;
}

// Devuelve los datos de una caja SIN el campo "correct" (no se envía al cliente)
function boxForClient(b) {
  const { correct, ...safe } = b;
  return safe;
}

// ─── SCORES PERSISTENTS ──────────────────────────────────────────────────────

const SCORES_FILE = path.join(__dirname, 'savedScores.json');
let savedScores = {};  // { nomJugador: { score, correctAnswers, wrongAnswers, bombCharges, hasBomb } }

function loadSavedScores() {
  try {
    if (fs.existsSync(SCORES_FILE)) {
      savedScores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
      console.log(`  [SCORES] ${Object.keys(savedScores).length} puntuacions recuperades de disc`);
    }
  } catch(e) { savedScores = {}; }
}

function persistScores() {
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(savedScores), 'utf8'); }
  catch(e) { console.error('[SCORES] Error guardant:', e.message); }
}

function savePlayerScore(p) {
  if (!p.name) return;
  savedScores[p.name] = {
    score: p.score, correctAnswers: p.correctAnswers,
    wrongAnswers: p.wrongAnswers, bombCharges: p.bombCharges, hasBomb: p.hasBomb,
  };
  persistScores();
}

function clearSavedScores() {
  savedScores = {};
  try { if (fs.existsSync(SCORES_FILE)) fs.unlinkSync(SCORES_FILE); } catch(e) {}
}

// ─── ESTADO ──────────────────────────────────────────────────────────────────

let questionPool = FALLBACK_QUESTIONS;
let gameBoxes    = [];
const players    = new Map();
let colorIdx     = 0;
const focusedQuestionByPlayer = new Map();

// ─── SESIÓN / LOGS ───────────────────────────────────────────────────────────

let sessionActive    = false;
let sessionStartTime = null;
let sessionLogLines  = [];   // líneas del log de partida

function fmtDate(d) {
  return d.toLocaleString('ca-ES', { timeZone: 'Europe/Madrid',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function sessionTimestamp() {
  return new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
}

function logAnswer(playerName, question, answerGiven, correct) {
  if (!sessionActive) return;
  const ts   = fmtDate(new Date());
  const ok   = correct ? 'OK' : 'KO';
  const line = `[${ts}] ${playerName} | ${ok} | P: "${question}" | R: "${answerGiven}"`;
  sessionLogLines.push(line);
  console.log('  [LOG]', line);
}

function writeSessionLog() {
  const ts   = sessionTimestamp();
  const file = path.join(LOGS_DIR, `partida_${ts}.log`);
  const content = sessionLogLines.join('\n') + '\n';
  try { fs.writeFileSync(file, content, 'utf8'); console.log(`  [LOG] partida escrita → ${file}`); }
  catch (e) { console.error('  [LOG] Error escribiendo partida:', e.message); }
}

function writeResultsLog(winnerName, winnerScore) {
  const ts   = sessionTimestamp();
  const file = path.join(LOGS_DIR, `resultats_${ts}.csv`);
  const now  = fmtDate(new Date());

  const sorted = Array.from(players.values())
    .sort((a, b) => b.score - a.score);

  let content = `Data/Hora,Guanyador,Punts\n`;
  content    += `${now},${winnerName},${winnerScore}\n`;
  content    += `\n`;
  content    += `Jugador,Punts,OK,KO\n`;
  for (const p of sorted) {
    const name = (p.name || p.id.slice(0,6)).replace(/,/g, ' ');
    content += `${name},${p.score},${p.correctAnswers||0},${p.wrongAnswers||0}\n`;
  }

  try { fs.writeFileSync(file, content, 'utf8'); console.log(`  [LOG] resultats escrits → ${file}`); }
  catch (e) { console.error('  [LOG] Error escribiendo resultats:', e.message); }
}

// ─── SCOREBOARD ──────────────────────────────────────────────────────────────

function scoreBoard() {
  return Array.from(players.values()).map(p => ({
    id:      p.id,
    color:   p.color,
    name:    p.name,
    score:   p.score,
    correct: p.correctAnswers,
    wrong:   p.wrongAnswers,
  }));
}

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  const color = PLAYER_COLORS[colorIdx % PLAYER_COLORS.length];
  colorIdx++;

  const player = {
    id: socket.id, color, name: '', position: { x: 23, y: 1.48, z: 15 },
    rotation: 0, score: 0, correctAnswers: 0, wrongAnswers: 0,
    bombCharges: 0, hasBomb: false,
  };
  players.set(socket.id, player);
  console.log(`[+] Conectado ${socket.id.slice(0,6)}  (${players.size} jugadores)`);

  // Enviar estado inicial
  socket.emit('init', {
    playerId: socket.id,
    color,
    players: Array.from(players.values()).filter(p => p.id !== socket.id),
    boxes:   gameBoxes.map(boxForClient),
    scores:  scoreBoard(),
  });

  // Notificar al resto
  socket.broadcast.emit('player:add', { id: socket.id, color, position: player.position, rotation: 0, name: '' });

  // ── Nombre ────────────────────────────────────────────────────────────────
  socket.on('player:name', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.name = (data.name || '').slice(0, 20).trim() || `J${socket.id.slice(0,4)}`;
    // Restaurar puntuació guardada si existeix
    if (savedScores[p.name]) {
      const s = savedScores[p.name];
      p.score = s.score; p.correctAnswers = s.correctAnswers;
      p.wrongAnswers = s.wrongAnswers; p.bombCharges = s.bombCharges;
      p.hasBomb = s.hasBomb;
      console.log(`  [SCORES] Restaurat ${p.name}: ${p.score} pts`);
      socket.emit('score:restore', { score: p.score, correct: p.correctAnswers, wrong: p.wrongAnswers, bombCharges: p.bombCharges, hasBomb: p.hasBomb });
    }
    socket.broadcast.emit('player:name', { id: socket.id, name: p.name });
    io.emit('score:update', { scores: scoreBoard() });
  });

  // ── Emote ──────────────────────────────────────────────────────────────────
  socket.on('player:emote', (data) => {
    socket.broadcast.emit('player:emote', { id: socket.id, anim: data.anim, holdMs: data.holdMs ?? 0 });
  });

  // ── Movimiento ────────────────────────────────────────────────────────────
  socket.on('player:move', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.position = data.position;
    p.rotation = data.rotation;
    socket.broadcast.emit('player:move', { id: socket.id, position: data.position, rotation: data.rotation });
  });

  // ── Focus de pregunta (glow temporal) ───────────────────────────────────
  socket.on('box:focus', (data) => {
    const boxId = Number(data?.boxId);
    const open  = !!data?.open;
    if (!Number.isInteger(boxId)) return;
    const box = gameBoxes.find(b => b.id === boxId);
    if (!box || box.type !== 'question' || box.answered) return;

    if (open) {
      // Comprovar si un altre jugador ja té aquest cofre obert
      const occupant = [...focusedQuestionByPlayer.entries()].find(([pid, bid]) => bid === boxId && pid !== socket.id);
      if (occupant) {
        socket.emit('box:locked', { boxId });  // rebutjar
        return;
      }
      focusedQuestionByPlayer.set(socket.id, boxId);
    } else if (focusedQuestionByPlayer.get(socket.id) === boxId) {
      focusedQuestionByPlayer.delete(socket.id);
    }

    socket.broadcast.emit('box:focus', { boxId, open });
  });

  // ── Romper caja ───────────────────────────────────────────────────────────
  socket.on('box:break', (data) => {
    const box = gameBoxes.find(b => b.id === data.boxId);
    if (!box || box.broken) return;
    box.broken = true;
    io.emit('box:break', { boxId: data.boxId });
    console.log(`  [rota] #${data.boxId} por ${socket.id.slice(0,6)}`);

    // Respawn caixa verda tras 5 s
    setTimeout(() => {
      const pos = randPos(gameBoxes.filter(b => b.id !== data.boxId), 3);
      box.x      = pos.x;
      box.z      = pos.z;
      box.broken = false;
      io.emit('box:respawn', { boxId: data.boxId, x: pos.x, z: pos.z });
      console.log(`  [respawn] #${data.boxId} → (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`);
    }, RESPAWN_DELAY_BREAK_MS);

    // Si queden < 25 caixes verdes actives, respawn extra d'una altra caixa trencada
    const activeBreakable = gameBoxes.filter(b => b.type === 'breakable' && !b.broken).length;
    if (activeBreakable < 25) {
      const extraBroken = gameBoxes.find(b => b.type === 'breakable' && b.broken && b.id !== data.boxId);
      if (extraBroken) {
        setTimeout(() => {
          const pos2 = randPos(gameBoxes.filter(b => b.id !== extraBroken.id), 3);
          extraBroken.x      = pos2.x;
          extraBroken.z      = pos2.z;
          extraBroken.broken = false;
          io.emit('box:respawn', { boxId: extraBroken.id, x: pos2.x, z: pos2.z });
          console.log(`  [respawn-extra] #${extraBroken.id} → (${pos2.x.toFixed(1)}, ${pos2.z.toFixed(1)}) (actives<25)`);
        }, RESPAWN_DELAY_BREAK_MS + 1500);
      }
    }
  });

  // ── Responder pregunta ────────────────────────────────────────────────────
  socket.on('box:answer', (data) => {
    const box = gameBoxes.find(b => b.id === data.boxId);
    if (!box || box.type !== 'question' || box.answered) return;
    const p = players.get(socket.id);
    if (!p) return;
    // Només pot respondre qui té el cofre obert
    if (focusedQuestionByPlayer.get(socket.id) !== data.boxId) return;

    const correct     = data.answerIndex === box.correct;
    const answerGiven = box.answers[data.answerIndex] ?? '?';

    if (correct) {
      focusedQuestionByPlayer.delete(socket.id);
      box.answered   = true;
      box.answeredBy = socket.id;
      const pts = box.pts ?? PTS_BY_DIFF[box.difficulty ?? 1] ?? 10;
      p.score          += pts;
      p.correctAnswers += 1;
      logAnswer(p.name || p.id.slice(0,6), box.question, answerGiven, true);
      console.log(`  [OK] #${data.boxId} dif${box.difficulty} por ${socket.id.slice(0,6)} (+${pts}pts)`);

      // Bomba: acumular càrregues per preguntes de dificultat 4 o 5
      if ((box.difficulty ?? 1) >= 4 && !p.hasBomb) {
        p.bombCharges = Math.min(3, (p.bombCharges || 0) + 1);
        if (p.bombCharges >= 3) {
          p.hasBomb = true;
          socket.emit('bomb:ready', { charges: 3 });
        } else {
          socket.emit('bomb:charge', { charges: p.bombCharges });
        }
      }

      savePlayerScore(p);
      io.emit('box:answered', { boxId: data.boxId, playerId: socket.id, correct: true, scores: scoreBoard() });

      // Respawn caixa pregunta en nova posició tras 2 s
      setTimeout(() => {
        const pos  = randPos(gameBoxes.filter(b => b.id !== data.boxId), 5);
        const newQ = pickQuestion(questionPool);
        box.x          = pos.x;
        box.z          = pos.z;
        box.question   = newQ.question;
        box.answers    = newQ.answers;
        box.correct    = newQ.correct;
        box.pts        = newQ.pts ?? 10;
        box.difficulty = newQ.difficulty ?? 1;
        box.answered   = false;
        box.answeredBy = null;
        io.emit('box:questionrespawn', {
          boxId:      data.boxId,
          x:          pos.x,
          z:          pos.z,
          question:   newQ.question,
          answers:    newQ.answers,
          pts:        newQ.pts ?? 10,
          difficulty: newQ.difficulty ?? 1,
        });
        console.log(`  [q-respawn] #${data.boxId} → (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`);
      }, RESPAWN_DELAY_QUESTION_MS);
    } else {
      p.score        += PTS_WRONG;
      p.wrongAnswers += 1;
      savePlayerScore(p);
      logAnswer(p.name || p.id.slice(0,6), box.question, answerGiven, false);
      console.log(`  [FAIL] #${data.boxId} por ${socket.id.slice(0,6)} (${PTS_WRONG}pts)`);
      // Guardar la respuesta correcta antes de sobreescribir el box
      const correctAnswer = box.answers[box.correct];
      // Asignar nueva pregunta al box
      const newQ = pickQuestion(questionPool);
      box.question   = newQ.question;
      box.answers    = newQ.answers;
      box.correct    = newQ.correct;
      box.pts        = newQ.pts ?? 10;
      box.difficulty = newQ.difficulty ?? 1;
      // Notificar a TODOS (la caja tiene nueva pregunta, sin revelar cuál es correcta)
      io.emit('box:newquestion', { boxId: data.boxId, question: newQ.question, answers: newQ.answers, difficulty: newQ.difficulty ?? 1 });
      // Decir al jugador que falló + actualizar su puntuación
      socket.emit('box:answered', { boxId: data.boxId, playerId: socket.id, correct: false, correctAnswer, scores: scoreBoard() });
    }
  });

  // ── Comandos admin ────────────────────────────────────────────────────────

  // Ctrl+Alt+Shift+P → Pre-avís
  socket.on('admin:prestart', () => {
    console.log(`  [ADMIN] prestart per ${socket.id.slice(0,6)}`);
    io.emit('admin:message', { text: 'El joc començarà en breus moments...', color: '#ffdd44' });
  });

  // Ctrl+Alt+Shift+O → Inici partida
  socket.on('admin:start', () => {
    console.log(`  [ADMIN] start per ${socket.id.slice(0,6)}`);
    sessionActive    = true;
    sessionStartTime = new Date();
    sessionLogLines  = [];
    players.forEach(p => { p.score = 0; p.correctAnswers = 0; p.wrongAnswers = 0; p.bombCharges = 0; p.hasBomb = false; });
    clearSavedScores();
    io.emit('admin:gamestart', { scores: scoreBoard() });
    const ts = fmtDate(sessionStartTime);
    sessionLogLines.push(`=== INICI DE PARTIDA: ${ts} ===`);
    sessionLogLines.push(`Jugadors: ${Array.from(players.values()).map(p=>p.name||p.id.slice(0,6)).join(', ')}`);
    sessionLogLines.push('');
  });

  // Ctrl+Alt+Shift+I → Fi partida
  socket.on('admin:end', () => {
    console.log(`  [ADMIN] end per ${socket.id.slice(0,6)}`);
    sessionActive = false;
    // Trobar guanyador
    let winner = null;
    players.forEach(p => { if (!winner || p.score > winner.score) winner = p; });
    const winnerName  = winner ? (winner.name || winner.id.slice(0,6)) : '?';
    const winnerScore = winner ? winner.score : 0;
    io.emit('admin:gameend', {
      message: `El joc ha acabat! El guanyador ha estat ${winnerName} amb ${winnerScore} punts`,
      winner:  winnerName,
      score:   winnerScore,
      scores:  scoreBoard(),
    });
    sessionLogLines.push('');
    sessionLogLines.push(`=== FI DE PARTIDA: ${fmtDate(new Date())} ===`);
    sessionLogLines.push(`Guanyador: ${winnerName} (${winnerScore} punts)`);
    writeSessionLog();
    writeResultsLog(winnerName, winnerScore);
  });

  // Ctrl+Alt+Shift+U → Missatge personalitzat
  socket.on('admin:broadcast', (data) => {
    const msg = (data?.text || '').slice(0, 200).trim();
    if (!msg) return;
    console.log(`  [ADMIN] broadcast: "${msg}"`);
    io.emit('admin:message', { text: msg, color: '#44ddff' });
  });

  // Ctrl+Alt+Shift+, → Hard reset: tots els clients recarreguen i es reinicia l'estat
  socket.on('admin:hardreset', async () => {
    console.log(`  [ADMIN] HARD RESET per ${socket.id.slice(0,6)}`);
    io.emit('admin:hardreset'); // força recàrrega a tots els clients
    await resetGame();
    setTimeout(() => {
      io.disconnectSockets(true); // desconnecta tots els sockets actuals
    }, 800);
  });

  // ── Bomba ─────────────────────────────────────────────────────────────────
  socket.on('bomb:use', (data) => {
    const p = players.get(socket.id);
    if (!p || !p.hasBomb) return;

    const boxId = data.boxId;
    const box   = gameBoxes.find(b => b.id === boxId && b.type === 'question');
    if (!box) return;

    // Trobar qui té obert aquest cofre
    let targetId = null;
    focusedQuestionByPlayer.forEach((bid, pid) => { if (bid === boxId) targetId = pid; });
    if (!targetId) return;

    // Posició original de l'explosió (per splash al bomber als 3s)
    const blastX = box.x;
    const blastZ = box.z;
    const BLAST_R = 2.5;

    // Usar bomba
    p.hasBomb = false; p.bombCharges = 0;
    socket.emit('bomb:charge', { charges: 0 });

    // Penalitzar target (death 10s com si hagués fallat)
    const target = players.get(targetId);
    if (target) { target.score += PTS_WRONG; target.wrongAnswers += 1; savePlayerScore(target); }
    focusedQuestionByPlayer.delete(targetId);
    io.to(targetId).emit('bomb:hit', { scores: scoreBoard() });

    // Respawn cofre a nova posició
    const pos  = randPos(gameBoxes.filter(b => b.id !== box.id), 5);
    const newQ = pickQuestion(questionPool);
    box.x = pos.x; box.z = pos.z;
    box.question = newQ.question; box.answers = newQ.answers;
    box.correct  = newQ.correct;  box.pts = newQ.pts ?? 10;
    box.difficulty = newQ.difficulty ?? 1;
    box.answered = false; box.answeredBy = null;

    io.emit('box:questionrespawn', {
      boxId: box.id, x: pos.x, z: pos.z,
      question: newQ.question, answers: newQ.answers,
      pts: newQ.pts ?? 10, difficulty: newQ.difficulty ?? 1,
    });
    io.emit('bomb:effect', {
      bomberId: socket.id, targetId,
      targetName: target?.name || '?', scores: scoreBoard(),
    });
    console.log(`  [BOMBA] ${socket.id.slice(0,6)} → ${targetId.slice(0,6)}`);

    // Splash als 3 s: si el bomber segueix al radi → death i -5 pts
    setTimeout(() => {
      const bomber = players.get(socket.id);
      if (!bomber) return;
      const bp = bomber.position;
      const dist = Math.sqrt((bp.x - blastX) ** 2 + (bp.z - blastZ) ** 2);
      if (dist <= BLAST_R) {
        bomber.score += PTS_WRONG; bomber.wrongAnswers += 1;
        savePlayerScore(bomber);
        socket.emit('bomb:splash', { scores: scoreBoard() });
        io.emit('score:update', { scores: scoreBoard() });
        console.log(`  [SPLASH] ${socket.id.slice(0,6)} no ha fugit a temps`);
      }
    }, 3000);
  });

  // ── Desconexión ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const focusedBoxId = focusedQuestionByPlayer.get(socket.id);
    if (Number.isInteger(focusedBoxId)) {
      socket.broadcast.emit('box:focus', { boxId: focusedBoxId, open: false });
      focusedQuestionByPlayer.delete(socket.id);
    }
    players.delete(socket.id);
    io.emit('player:remove', { id: socket.id });
    io.emit('score:update', { scores: scoreBoard() });
    console.log(`[-] Desconectado ${socket.id.slice(0,6)}  (${players.size} jugadores)`);
  });
});

// ─── RESET ───────────────────────────────────────────────────────────────────

async function resetGame() {
  questionPool = await loadQuestions();
  gameBoxes    = generateBoxes(questionPool);
  players.forEach(p => { p.score = 0; p.correctAnswers = 0; p.wrongAnswers = 0; p.bombCharges = 0; p.hasBomb = false; });
  focusedQuestionByPlayer.clear();
  clearSavedScores();
  sessionActive   = false;
  sessionLogLines = [];
  io.emit('game:reset', { boxes: gameBoxes.map(boxForClient), scores: scoreBoard() });
  console.log('\n  [RESET] Juego reiniciado — cajas y puntuaciones reseteadas\n');
}

app.get('/admin/reset', async (req, res) => {
  await resetGame();
  res.json({ ok: true, boxes: gameBoxes.length });
});

// ─── ENDPOINTS LOGS ──────────────────────────────────────────────────────────

// Llista tots els fitxers de log
app.get('/admin/logs', (req, res) => {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => (f.endsWith('.log') || f.endsWith('.csv')) && f !== '.gitkeep')
      .sort().reverse();
    const csvFiles = files.filter(f => f.endsWith('.csv'));
    const logFiles = files.filter(f => f.endsWith('.log'));
    let html = '<html><head><meta charset="utf-8"><title>Logs</title>';
    html += '<style>body{font-family:monospace;background:#111;color:#eee;padding:20px}';
    html += 'a{color:#44ddff}h2{color:#ffdd44}h3{color:#88ff88;margin-top:24px}</style></head><body>';
    html += '<h2>Fitxers de log</h2>';
    if (!files.length) { html += '<p>Cap fitxer encara.</p>'; }
    else {
      if (csvFiles.length) {
        html += '<h3>📊 Resultats (CSV)</h3>';
        csvFiles.forEach(f => {
          html += `<p><a href="/admin/logs/${encodeURIComponent(f)}">${f}</a></p>`;
        });
      }
      if (logFiles.length) {
        html += '<h3>📋 Partides (LOG)</h3>';
        logFiles.forEach(f => {
          html += `<p><a href="/admin/logs/${encodeURIComponent(f)}">${f}</a></p>`;
        });
      }
    }
    html += '</body></html>';
    res.send(html);
  } catch (e) {
    res.status(500).send('Error llegint logs: ' + e.message);
  }
});

// Descarrega / mostra un fitxer de log concret
app.get('/admin/logs/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);   // evita path traversal
  const filepath = path.join(LOGS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Fitxer no trobat');
  if (filename.endsWith('.csv')) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  } else {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  res.sendFile(filepath);
});

// ─── ARRANQUE ────────────────────────────────────────────────────────────────

(async () => {
  loadSavedScores();
  questionPool = await loadQuestions();
  gameBoxes    = generateBoxes(questionPool);

  server.listen(PORT, () => {
    const ip = getLocalIP();
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║   SERVIDOR DE CLASSE ARRANCAT            ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Local:    http://localhost:${PORT}          ║`);
    console.log(`║  Alumnes:  http://${ip}:${PORT}    ║`);
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(`  ${gameBoxes.filter(b=>b.type==='breakable').length} caixes rompibles`);
    console.log(`  ${gameBoxes.filter(b=>b.type==='question').length} caixes de preguntes`);
    console.log(`  ${questionPool.length} preguntes al pool\n`);
    console.log('  Comandos admin (des del navegador):');
    console.log('    Ctrl+Alt+Shift+P → Pre-avís inici');
    console.log('    Ctrl+Alt+Shift+O → Inici partida');
    console.log('    Ctrl+Alt+Shift+I → Fi partida');
    console.log('    Ctrl+Alt+Shift+U → Missatge personalitzat\n');
  });
})();

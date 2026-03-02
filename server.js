const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const os       = require('os');

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

// URL del Google Sheet publicado como CSV.
// En Google Sheets: Archivo → Compartir → Publicar en la web → Hoja1 → CSV → Publicar
// Pega aquí la URL que aparece:
const QUESTIONS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT7IiShLIDNSMcbHOcvvOg4jfGAXUoNfp9n_lXjBG6aVNKfpBY1mKh9hwlXq1Pk5DgGXL9MyvrBQEFf/pub?gid=0&single=true&output=csv';

const RESPAWN_DELAY_MS = 15000;   // 15 segundos para que reaparezca una caja rota
const NUM_BREAKABLE    = 18;

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
    if (isNaN(idx) || idx < 0 || idx > 3) continue;  // salta cabecera y filas inválidas
    if (!c[0] || !c[1]) continue;
    questions.push({ question: c[0], answers: [c[1], c[2], c[3], c[4]], correct: idx, pts: 10 });
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
    const res  = await fetch(QUESTIONS_CSV_URL);
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

  // Cajas de preguntas (una por cada pregunta del pool, máx 12)
  const numQ = Math.min(questionPool.length, 12);
  for (let i = 0; i < numQ; i++) {
    const pos = randPos(boxes, 5);
    const q   = questionPool[i % questionPool.length];
    boxes.push({
      id: id++, type: 'question',
      x: pos.x, z: pos.z,
      question: q.question, answers: q.answers, correct: q.correct, pts: q.pts ?? 10,
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

// ─── ESTADO ──────────────────────────────────────────────────────────────────

let questionPool = FALLBACK_QUESTIONS;
let gameBoxes    = [];
const players    = new Map();
let colorIdx     = 0;
const focusedQuestionByPlayer = new Map();

function scoreBoard() {
  return Array.from(players.values()).map(p => ({ id: p.id, color: p.color, name: p.name, score: p.score }));
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

  const player = { id: socket.id, color, name: '', position: { x: 2.14, y: 1.48, z: -1.36 }, rotation: 0, score: 0 };
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

    if (open) focusedQuestionByPlayer.set(socket.id, boxId);
    else if (focusedQuestionByPlayer.get(socket.id) === boxId) focusedQuestionByPlayer.delete(socket.id);

    socket.broadcast.emit('box:focus', { boxId, open });
  });

  // ── Romper caja ───────────────────────────────────────────────────────────
  socket.on('box:break', (data) => {
    const box = gameBoxes.find(b => b.id === data.boxId);
    if (!box || box.broken) return;
    box.broken = true;
    io.emit('box:break', { boxId: data.boxId });
    console.log(`  [rota] #${data.boxId} por ${socket.id.slice(0,6)}`);

    // Respawn tras 15 s
    setTimeout(() => {
      const pos = randPos(gameBoxes.filter(b => b.id !== data.boxId), 3);
      box.x      = pos.x;
      box.z      = pos.z;
      box.broken = false;
      io.emit('box:respawn', { boxId: data.boxId, x: pos.x, z: pos.z });
      console.log(`  [respawn] #${data.boxId} → (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`);
    }, RESPAWN_DELAY_MS);
  });

  // ── Responder pregunta ────────────────────────────────────────────────────
  socket.on('box:answer', (data) => {
    const box = gameBoxes.find(b => b.id === data.boxId);
    if (!box || box.type !== 'question' || box.answered) return;
    const p = players.get(socket.id);
    if (!p) return;

    const correct = data.answerIndex === box.correct;

    if (correct) {
      focusedQuestionByPlayer.delete(socket.id);
      box.answered   = true;
      box.answeredBy = socket.id;
      p.score += box.pts ?? 10;
      console.log(`  [OK] #${data.boxId} por ${socket.id.slice(0,6)} (+${box.pts}pts)`);
      io.emit('box:answered', { boxId: data.boxId, playerId: socket.id, correct: true, scores: scoreBoard() });

      // Respawn de la caja de pregunta en nueva posición con nueva pregunta
      setTimeout(() => {
        const pos  = randPos(gameBoxes.filter(b => b.id !== data.boxId), 5);
        const newQ = pickQuestion(questionPool);
        box.x          = pos.x;
        box.z          = pos.z;
        box.question   = newQ.question;
        box.answers    = newQ.answers;
        box.correct    = newQ.correct;
        box.pts        = newQ.pts ?? 10;
        box.answered   = false;
        box.answeredBy = null;
        io.emit('box:questionrespawn', {
          boxId:    data.boxId,
          x:        pos.x,
          z:        pos.z,
          question: newQ.question,
          answers:  newQ.answers,
          pts:      newQ.pts ?? 10,
        });
        console.log(`  [q-respawn] #${data.boxId} → (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`);
      }, RESPAWN_DELAY_MS);
    } else {
      console.log(`  [FAIL] #${data.boxId} por ${socket.id.slice(0,6)}`);
      // Guardar la respuesta correcta antes de sobreescribir el box
      const correctAnswer = box.answers[box.correct];
      // Asignar nueva pregunta al box
      const newQ = pickQuestion(questionPool);
      box.question = newQ.question;
      box.answers  = newQ.answers;
      box.correct  = newQ.correct;
      box.pts      = newQ.pts ?? 10;
      // Notificar a TODOS (la caja tiene nueva pregunta, sin revelar cuál es correcta)
      io.emit('box:newquestion', { boxId: data.boxId, question: newQ.question, answers: newQ.answers });
      // Decir al jugador que falló (con la respuesta correcta para mostrarla)
      socket.emit('box:answered', { boxId: data.boxId, playerId: socket.id, correct: false, correctAnswer });
    }
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
  players.forEach(p => { p.score = 0; });
  focusedQuestionByPlayer.clear();
  io.emit('game:reset', { boxes: gameBoxes.map(boxForClient), scores: scoreBoard() });
  console.log('\n  [RESET] Juego reiniciado — cajas y puntuaciones reseteadas\n');
}

app.get('/admin/reset', async (req, res) => {
  await resetGame();
  res.json({ ok: true, boxes: gameBoxes.length });
});

// ─── ARRANQUE ────────────────────────────────────────────────────────────────

(async () => {
  questionPool = await loadQuestions();
  gameBoxes    = generateBoxes(questionPool);

  server.listen(PORT, () => {
    const ip = getLocalIP();
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║   SERVIDOR DE CLASE ARRANCADO            ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Local:    http://localhost:${PORT}          ║`);
    console.log(`║  Alumnos:  http://${ip}:${PORT}    ║`);
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(`  ${gameBoxes.filter(b=>b.type==='breakable').length} cajas rompibles`);
    console.log(`  ${gameBoxes.filter(b=>b.type==='question').length} cajas de preguntas`);
    console.log(`  ${questionPool.length} preguntas en el pool\n`);
  });
})();

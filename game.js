// ─────────────────────────────────────────────────────────────────────────────
//  QUIZ CONTAINERS  —  Multijugador  (Three.js r127 + Socket.io)
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'https://unpkg.com/three@0.127.0/build/three.module.js';
import { GLTFLoader }          from 'https://unpkg.com/three@0.127.0/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'https://unpkg.com/three@0.127.0/examples/jsm/controls/PointerLockControls.js';
import { Octree }              from 'https://unpkg.com/three@0.127.0/examples/jsm/math/Octree.js';
import { Capsule }             from 'https://unpkg.com/three@0.127.0/examples/jsm/math/Capsule.js';

const socket = window.io();

// ─── DOM ─────────────────────────────────────────────────────────────────────

const loadOverlay      = document.getElementById('loadOverlay');
const playerNameInput  = document.getElementById('playerNameInput');
const enterGameBtn     = document.getElementById('enterGameBtn');
const loadStatus       = document.getElementById('loadStatus');

const overlay          = document.getElementById('overlay');
const overlayTitle     = document.getElementById('overlayTitle');
const startBtn         = document.getElementById('startBtn');
const crosshair        = document.getElementById('crosshair');
const hud              = document.getElementById('hud');
const scoreboardEl     = document.getElementById('scoreboard');
const myScoreEl        = document.getElementById('myScore');
const sbListEl         = document.getElementById('sbList');
const forcaHud         = document.getElementById('forcaHud');
const forcaDots        = [document.getElementById('dot0'), document.getElementById('dot1'), document.getElementById('dot2')];
const forcaLabel       = document.getElementById('forcaLabel');
const bombaHud         = document.getElementById('bombaHud');
const bombaDots        = [document.getElementById('bdot0'), document.getElementById('bdot1'), document.getElementById('bdot2')];
const msgEl            = document.getElementById('msg');
const hintEl           = document.getElementById('hint');
const errorBox         = document.getElementById('error');

const bigFeedback      = document.getElementById('bigFeedback');
const bigFeedbackTitle = document.getElementById('bigFeedbackTitle');
const bigFeedbackSub   = document.getElementById('bigFeedbackSub');

const dialogOverlay    = document.getElementById('dialogOverlay');
const dialogQuestion   = document.getElementById('dialogQuestion');
const dialogAnswers    = document.querySelectorAll('.ans-btn');
const dialogFeedback   = document.getElementById('dialogFeedback');
const btnCancelar      = document.getElementById('btnCancelar');

// ─── TEXTURAS DE CAIXA ───────────────────────────────────────────────────────

function makeCrateTexture(baseColor, plankColor, grainColor) {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = baseColor; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = grainColor; ctx.lineWidth = 1.2;
  for (let i = 0; i < 14; i++) {
    const y = (i / 14) * S + (Math.random() - 0.5) * 10;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(S*.33, y+(Math.random()-.5)*7, S*.66, y+(Math.random()-.5)*7, S, y);
    ctx.stroke();
  }
  ctx.strokeStyle = plankColor; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(0, S/2);  ctx.lineTo(S, S/2);  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(S/2, 0);  ctx.lineTo(S/2, S);  ctx.stroke();
  ctx.lineWidth = 7; ctx.strokeRect(3, 3, S-6, S-6);
  ctx.fillStyle = plankColor;
  [[14,14],[S-14,14],[14,S-14],[S-14,S-14],[S/2,14],[S/2,S-14],[14,S/2],[S-14,S/2]]
    .forEach(([nx,ny]) => { ctx.beginPath(); ctx.arc(nx,ny,4,0,Math.PI*2); ctx.fill(); });
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

const TEX_BREAKABLE = makeCrateTexture('#5a2408', '#2b1004', '#3a1806');
const TEX_QUESTION  = makeCrateTexture('#b87820', '#7a4e08', '#9a640e');

// ─── MATERIALS ───────────────────────────────────────────────────────────────

const MAT_BREAKABLE = new THREE.MeshStandardMaterial({ map: TEX_BREAKABLE, roughness: 0.85, metalness: 0.0 });
const MAT_QUESTION  = new THREE.MeshStandardMaterial({ map: TEX_QUESTION,  roughness: 0.70, metalness: 0.05 });
const MAT_ANSWERED  = new THREE.MeshStandardMaterial({ color: 0x2a7a2a, roughness: 0.6, emissive: new THREE.Color(0x0a3a0a) });

// ─── THREE.JS ────────────────────────────────────────────────────────────────

const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x10131a);

const camera   = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.01, 2000);
camera.position.set(0, 1.65, 5);
scene.add(camera);   // necesario para renderizar hijos de cámara (brazos en camera-space)

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFShadowMap;       // PCFSoft→PCF: menys cost GPU
renderer.toneMapping       = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = 1;
renderer.outputEncoding    = THREE.sRGBEncoding;
renderer.domElement.tabIndex = 0;
renderer.domElement.style.display = 'none';
document.body.appendChild(renderer.domElement);

const controls = new PointerLockControls(camera, renderer.domElement);

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MOVE_SPEED    = 22;
const AIR_CONTROL   = 6;
const GRAVITY       = 30;
const CAM_HEIGHT    = 0.82;
const INTERACT_DIST = 3.5;
const BREAK_DIST    = 2.2;
const PUNCH_COOLDOWN_MS = 600;
const BREAK_HIT_DELAY_MS = 200;
const QUESTION_OPEN_DELAY_MS = 800;
const DEATH_LOCK_MS = 10000;
const VALID_FLOOR_Y = 1.2;
const FALLBACK_SPAWN = new THREE.Vector3(2.14, 1.48, -1.36);

// ─── ESTAT DEL JUGADOR ───────────────────────────────────────────────────────

const clock        = new THREE.Clock();
const playerVel    = new THREE.Vector3();
const fwdVec       = new THREE.Vector3();
const rightVec     = new THREE.Vector3();
const tmpVec       = new THREE.Vector3();
const worldOctree  = new Octree();
const raycaster    = new THREE.Raycaster();
const collidableMeshes = [];

let playerOnFloor = false;
let levelReady    = false;
let gameStarted   = false;

const playerCollider = new Capsule(
  new THREE.Vector3(0, 0.35, 0),
  new THREE.Vector3(0, CAM_HEIGHT, 0),
  0.35
);
const moveState = { forward:false, backward:false, left:false, right:false };


// ─── FORÇA ────────────────────────────────────────────────────────────────────

let forca = 0;

function setForca(v) {
  const prev = forca;
  forca = Math.max(0, Math.min(3, v));
  forcaDots.forEach((d, i) => {
    d.classList.remove('on', 'max');
    if (forca === 3) { if (i < forca) d.classList.add('max'); }
    else if (i < forca) d.classList.add('on');
  });
  if (forca === 3) {
    forcaLabel.textContent = 'Busca una pregunta!';
    forcaLabel.style.color = '#ffdd44';
  } else {
    forcaLabel.textContent = `Força ${forca}/3`;
    forcaLabel.style.color = 'rgba(255,255,255,0.7)';
  }
}

// ─── BOMBA ────────────────────────────────────────────────────────────────────

let myBombCharges = 0;
let myHasBomb     = false;

function setBombaCharges(charges) {
  myBombCharges = Math.max(0, Math.min(3, charges));
  myHasBomb     = myBombCharges >= 3;
  bombaDots.forEach((d, i) => {
    d.classList.remove('on', 'max');
    if (myHasBomb) { if (i < 3) d.classList.add('max'); }
    else if (i < myBombCharges) d.classList.add('on');
  });
  const lbl = document.getElementById('bombaLabel');
  if (lbl) {
    lbl.textContent = myHasBomb ? 'BOMBA LLESTA! [E]' : `Bomba ${myBombCharges}/3`;
    lbl.style.color = myHasBomb ? '#c04060' : 'rgba(255,255,255,0.7)';
  }
}

// ─── MULTIJUGADOR ─────────────────────────────────────────────────────────────

let myId    = null;
let myColor = '#ffffff';
let myScore = 0;
let myName  = '';
const otherPlayers = new Map();

// ─── CAIXES ──────────────────────────────────────────────────────────────────

const boxMeshes    = new Map();
const boxData      = new Map();
const boxColliders = new Map();
const particles    = [];

let activeQuestion = null;
let dialogOpen     = false;
let pendingBoxes   = null;
let lastPunchMs    = -Infinity;
let questionOpenPending = false;
let frozenUntilMs = 0;
let deathRecoverTimer = null;
let localDeathUntilMs = 0;
let deathLockedYaw = null;

// ─── IL·LUMINACIÓ ────────────────────────────────────────────────────────────

let lightDir  = null;
let lightHemi = null;
let lightAmb  = null;

function setupLighting() {
  lightHemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  lightHemi.color.setHSL(0.6, 1, 0.6);
  lightHemi.groundColor.setHSL(0.095, 1, 0.75);
  scene.add(lightHemi);
  lightDir = new THREE.DirectionalLight(0xffffff, 3.5);
  lightDir.position.set(12, 20, 8);
  lightDir.castShadow = true;
  lightDir.shadow.mapSize.set(1024, 1024);
  lightDir.shadow.camera.left = lightDir.shadow.camera.bottom = -35;
  lightDir.shadow.camera.right = lightDir.shadow.camera.top = 35;
  lightDir.shadow.bias = -0.0001;
  scene.add(lightDir);
  lightAmb = new THREE.AmbientLight(0xffffff, 0);
  scene.add(lightAmb);
}

// ─── CEL ─────────────────────────────────────────────────────────────────────

function setupSky() {
  new THREE.TextureLoader().load('/src/assets/sky.jpg', (tex) => {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 25, 25),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, toneMapped: false })
    );
    sky.rotateY(THREE.MathUtils.degToRad(-60));
    scene.add(sky);
  });
}

// ─── NIVELL ───────────────────────────────────────────────────────────────────

function hideLikelyDome(node, center, floorY) {
  if (!node.geometry) return false;
  const b = new THREE.Box3().setFromObject(node);
  if (b.isEmpty()) return false;
  const size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  const max = Math.max(size.x,size.y,size.z), min = Math.min(size.x,size.y,size.z);
  if ((min>0?max/min:Infinity)<1.45 && max>7 && c.y>floorY+1.5 && Math.hypot(c.x-center.x,c.z-center.z)<220) {
    node.visible = false; return true;
  }
  return false;
}

function setPlayerPosition(pos) {
  playerCollider.start.set(pos.x, pos.y-(CAM_HEIGHT-0.35), pos.z);
  playerCollider.end.set(pos.x, pos.y, pos.z);
  camera.position.copy(playerCollider.end);
}

function placePlayerAtCenter(lvl) {
  const bounds = new THREE.Box3().setFromObject(lvl);
  const center = bounds.getCenter(new THREE.Vector3());
  const topY   = bounds.max.y + 25;
  const checks = [
    new THREE.Vector2(center.x, center.z),
    new THREE.Vector2(FALLBACK_SPAWN.x, FALLBACK_SPAWN.z),
    new THREE.Vector2(center.x+3, center.z), new THREE.Vector2(center.x-3, center.z),
    new THREE.Vector2(center.x, center.z+3), new THREE.Vector2(center.x, center.z-3),
  ];
  let spawn = null;
  for (const c of checks) {
    raycaster.set(new THREE.Vector3(c.x, topY, c.y), new THREE.Vector3(0,-1,0));
    const hits = raycaster.intersectObjects(collidableMeshes, true);
    if (hits.length) { spawn = new THREE.Vector3(hits[0].point.x, hits[0].point.y+CAM_HEIGHT+0.08, hits[0].point.z); break; }
  }
  if (!spawn) spawn = FALLBACK_SPAWN.clone();
  setPlayerPosition(spawn);
  for (let i=0;i<3;i++) { const r=worldOctree.capsuleIntersect(playerCollider); if(!r) break; playerCollider.translate(r.normal.multiplyScalar(r.depth+0.01)); }
  playerVel.set(0,0,0);
  camera.position.copy(playerCollider.end);
}

function onLevelReady() {
  levelReady = true;
  loadStatus.textContent = 'Llest! Escriu el teu nom';
  loadStatus.classList.add('ready');
  playerNameInput.disabled = false;
  // El botó resta desactivat fins que s'escrigui un nom
  enterGameBtn.disabled    = true;
  enterGameBtn.textContent = 'Entrar al joc';
  playerNameInput.focus();
  placePendingBoxes();
}

function loadLevel() {
  new GLTFLoader().load('/src/assets/level.glb', (gltf) => {
    const lvl    = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(lvl);
    const center = bounds.getCenter(new THREE.Vector3());
    const floorY = bounds.min.y;
    lvl.traverse((node) => {
      if (node.isMesh) {
        if (hideLikelyDome(node, center, floorY)) return;
        node.castShadow = node.receiveShadow = true;
        collidableMeshes.push(node);
      }
      if (node.isLight) {
        node.intensity = 3;
        if (node.isDirectionalLight) {
          node.castShadow = false;
        } else {
          node.castShadow = true;
          if (node.shadow) {
            node.shadow.mapSize.set(1024, 1024);
            node.shadow.bias = -0.00007;
          }
        }
      }
    });
    scene.add(lvl);
    worldOctree.fromGraphNode(lvl);
    placePlayerAtCenter(lvl);
    onLevelReady();
  }, undefined, () => showError('No s\'ha pogut carregar /src/assets/level.glb'));
}

// ─── PANTALLA DE CÀRREGA ─────────────────────────────────────────────────────

function startGame() {
  myName = playerNameInput.value.trim() || 'Jugador';
  socket.emit('player:name', { name: myName });

  loadOverlay.style.display = 'none';
  renderer.domElement.style.display = 'block';
  crosshair.style.display = 'block';
  hud.style.display = 'none';   // Puntuació pròpia oculta (es veu al marcador dret)
  scoreboardEl.style.display = 'block';
  forcaHud.style.display = 'flex';
  bombaHud.style.display = 'flex';
  setBombaCharges(0);
  overlay.classList.add('visible');
  overlayTitle.textContent = `BENVINGUT, ${myName}!`;
  gameStarted = true;
  setForca(0);
  createLocalAvatar();
}

enterGameBtn.addEventListener('click', () => {
  if (!levelReady || !playerNameInput.value.trim()) return;
  startGame();
});
playerNameInput.addEventListener('input', () => {
  enterGameBtn.disabled = !playerNameInput.value.trim() || !levelReady;
});
playerNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && levelReady && playerNameInput.value.trim()) startGame();
});

// ─── MODEL PERSONATGE (RobotExpressive) ──────────────────────────────────────

let fbxBaseModel = null;   // RobotExpressive.glb (escena base)
let fbxIdleClip  = null;   // clip 'Idle'
let fbxJogClip   = null;   // clip 'Walking'
let fbxAllClips  = [];     // tots els clips per emotes (Jump, Punch, etc.)

let chestBaseModel = null;
let chestSpecialModel = null;
const QUESTION_LID_OPEN_RAD = THREE.MathUtils.degToRad(75);

// ─── AVATARS ─────────────────────────────────────────────────────────────────

function makeNameTexture(name, color) {
  const W = 256, H = 52;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.fill();
  ctx.font = '500 24px Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(name.slice(0, 16), W / 2, H / 2);
  return new THREE.CanvasTexture(cv);
}

function createNameSprite(name, color) {
  const tex      = makeNameTexture(name, color);
  const mat      = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite   = new THREE.Sprite(mat);
  sprite.scale.set(1.4, 0.28, 1);
  sprite.position.set(0, 2.13, 0);
  return sprite;
}

function cloneSkinnedFBX(source) {
  const root = source.clone(true);
  const boneMap = {};
  root.traverse(n => { if (n.isBone) boneMap[n.name] = n; });
  const srcSMs = [], dstSMs = [];
  source.traverse(n => { if (n.isSkinnedMesh) srcSMs.push(n); });
  root.traverse(n => { if (n.isSkinnedMesh) dstSMs.push(n); });
  srcSMs.forEach((src, i) => {
    const dst = dstSMs[i]; if (!dst) return;
    const bones    = src.skeleton.bones.map(b => boneMap[b.name] || b);
    const inverses = src.skeleton.boneInverses.map(m => m.clone());
    dst.skeleton = new THREE.Skeleton(bones, inverses);
    dst.bind(dst.skeleton, dst.matrixWorld);
  });
  return root;
}

function createAvatar(color, name) {
  const group = new THREE.Group();

  if (fbxBaseModel) {
    const clone = cloneSkinnedFBX(fbxBaseModel);
    clone.scale.setScalar(0.2);       // 20% de la mida original
    clone.rotation.y = Math.PI;       // girar 180° per alinear amb la direcció de moviment
    applyPlayerColor(clone, color);
    group.add(clone);
    group.userData.fbxClone = clone;
  } else {
    // Fallback procedural (cilindre + esfera)
    const mat  = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.28,1.1,10), mat);
    body.position.y = 0.55; body.castShadow = true; group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22,10,8), mat);
    head.position.y = 1.35; head.castShadow = true; group.add(head);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.08,0.08,0.18), new THREE.MeshStandardMaterial({color:0xffffff}));
    nose.position.set(0,1.35,-0.3); group.add(nose);
  }

  const label = createNameSprite(name || '...', color);
  if (fbxBaseModel) label.position.y = 1.13;  // más alto para no tapar la cabeza
  group.add(label);
  group.userData.label = label;
  group.userData.labelColor = color;
  return group;
}

function buildMixerActions(mixer) {
  const EMOTES = ['Jump','Yes','No','Wave','Punch','ThumbsUp','Running','Dance','Death'];
  const acts = {};
  fbxAllClips.forEach(clip => {
    const act = mixer.clipAction(clip);
    if (EMOTES.includes(clip.name)) { act.clampWhenFinished = true; act.loop = THREE.LoopOnce; }
    acts[clip.name] = act;
  });
  return acts;
}

function playEmoteOn(p, animName, holdMs = 0) {
  if (!p.mixer || !p.actions?.[animName]) return;
  const emote = p.actions[animName];
  const base  = p.isMoving ? p.jogAction : p.idleAction;
  if (base) base.fadeOut(0.2);
  emote.reset().fadeIn(0.2).play();

  if (holdMs > 0) {
    p.animLockedUntilMs = performance.now() + holdMs;
    if (p.emoteHoldTimer) clearTimeout(p.emoteHoldTimer);
    p.emoteHoldTimer = setTimeout(() => {
      p.animLockedUntilMs = 0;
      emote.fadeOut(0.2);
      const back = p.isMoving ? p.jogAction : p.idleAction;
      if (back) back.reset().fadeIn(0.2).play();
      p.emoteHoldTimer = null;
    }, holdMs);
    return;
  }

  p.mixer.addEventListener('finished', function onDone(e) {
    if (e.action !== emote) return;
    p.mixer.removeEventListener('finished', onDone);
    emote.fadeOut(0.2);
    const back = p.isMoving ? p.jogAction : p.idleAction;
    if (back) back.reset().fadeIn(0.2).play();
  });
}

function upgradeAvatarsToFBX() {
  otherPlayers.forEach((p) => {
    if (p.group.userData.fbxClone) return;   // ja té FBX
    const pos  = p.group.position.clone();
    const rotY = p.group.rotation.y;
    scene.remove(p.group);
    if (p.mixer) p.mixer.stopAllAction();
    const group = createAvatar(p.color, p.name || '...');
    group.position.copy(pos);
    group.rotation.y = rotY;
    scene.add(group);
    let mixer = null, idleAction = null, jogAction = null;
    const actions = {};
    if (group.userData.fbxClone && fbxAllClips.length) {
      mixer = new THREE.AnimationMixer(group.userData.fbxClone);
      Object.assign(actions, buildMixerActions(mixer));
      idleAction = actions['Idle'] ?? null;
      jogAction  = actions['Walking'] ?? null;
      if (idleAction) idleAction.play();
    }
    p.group = group; p.mixer = mixer; p.actions = actions;
    p.idleAction = idleAction; p.jogAction = jogAction;
  });
}

// Colors granate per dificultat (1=clar → 5=molt fosc)
const DIFF_GARNET = ['#c04060', '#9a2a48', '#7a1830', '#5c0f20', '#3a0510'];
const DIFF_SCALE  = [0.50, 0.75, 1.00, 1.40, 1.90];

// Tenyir NOMÉS les parts vermelloses d'un cofre de preguntes
function applyDifficultyColor(root, difficulty) {
  const col = new THREE.Color(DIFF_GARNET[(difficulty ?? 1) - 1] || DIFF_GARNET[0]);
  root.traverse(child => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat, i) => {
      const m = mat.clone();
      m.color.set(col);
      if (Array.isArray(child.material)) child.material[i] = m;
      else child.material = m;
    });
  });
}

// Tenyir NOMÉS les parts taronja/groc del robot (cos, cap, braços)
// Les parts grises (juntes, mans, peus) i les fosques (ulls) es conserven
function applyPlayerColor(root, hexColor) {
  const col = new THREE.Color(hexColor);
  root.traverse(child => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat, i) => {
      // Detectar taronja/groc: R alt, diferència R-B gran (elimina grisos i negres)
      if (mat.color.r < 0.4 || (mat.color.r - mat.color.b) < 0.2) return;
      const m = mat.clone();
      m.color.set(col);
      m.vertexColors = false;
      if (Array.isArray(child.material)) child.material[i] = m;
      else child.material = m;
    });
  });
}

function preloadFBXModels() {
  new GLTFLoader().load('/src/assets/RobotExpressive.glb', (gltf) => {
    const root = gltf.scene;
    root.traverse(child => { if (child.isMesh) child.castShadow = true; });
    fbxBaseModel = root;
    fbxAllClips  = gltf.animations;
    fbxIdleClip  = gltf.animations.find(a => a.name === 'Idle')    ?? gltf.animations[0] ?? null;
    fbxJogClip   = gltf.animations.find(a => a.name === 'Walking') ?? gltf.animations[1] ?? null;
    console.log('[Robot] clips:', gltf.animations.map(a => a.name).join(', '));
    upgradeAvatarsToFBX();
    if (gameStarted) createLocalAvatar();
  }, undefined, e => console.warn('[Robot GLTF]', e));
}

function preloadChestModels() {
  const loader = new GLTFLoader();
  loader.load('/src/assets/Chest.gltf',
    (gltf) => {
      chestBaseModel = gltf.scene;
      chestBaseModel.traverse((n) => {
        if (!n.isMesh) return;
        n.castShadow = true;
        n.receiveShadow = true;
      });
      placePendingBoxes();
    },
    undefined,
    (e) => console.warn('[Chest GLTF]', e)
  );

  loader.load('/src/assets/chest_preguntes.glb',
    (gltf) => {
      chestSpecialModel = gltf.scene;
      chestSpecialModel.traverse((n) => {
        if (!n.isMesh) return;
        n.castShadow = true;
        n.receiveShadow = true;
      });
      placePendingBoxes();
    },
    undefined,
    (e) => console.warn('[Chest Preguntes GLB]', e)
  );
}

function updatePlayerLabel(id, name) {
  const p = otherPlayers.get(id);
  if (!p) return;
  const label = p.group.userData.label;
  if (!label) return;
  const tex = makeNameTexture(name, p.group.userData.labelColor);
  label.material.map.dispose();
  label.material.map = tex;
  label.material.needsUpdate = true;
}

function addOtherPlayer(id, color, position, rotation, name) {
  if (otherPlayers.has(id)) return;
  const group = createAvatar(color, name || '...');
  const y = position.y - CAM_HEIGHT;
  group.position.set(position.x, y, position.z);
  group.rotation.y = rotation||0;
  scene.add(group);

  // AnimationMixer si el model ja ha carregat
  let mixer = null, idleAction = null, jogAction = null;
  const actions = {};
  if (group.userData.fbxClone && fbxAllClips.length) {
    mixer = new THREE.AnimationMixer(group.userData.fbxClone);
    const EMOTES = ['Jump','Yes','No','Wave','Punch','ThumbsUp','Running','Dance','Death'];
    fbxAllClips.forEach(clip => {
      const act = mixer.clipAction(clip);
      if (EMOTES.includes(clip.name)) { act.clampWhenFinished = true; act.loop = THREE.LoopOnce; }
      actions[clip.name] = act;
    });
    idleAction = actions['Idle'] ?? null;
    jogAction  = actions['Walking'] ?? null;
    if (idleAction) idleAction.play();
  }

  otherPlayers.set(id, {
    group,
    targetPos: new THREE.Vector3(position.x, y, position.z),
    targetRot: rotation||0,
    name: name||'',
    color: color,
    mixer, actions, idleAction, jogAction, isMoving: false, movingForward: true,
    animLockedUntilMs: 0,
  });
}

function removeOtherPlayer(id) {
  const p = otherPlayers.get(id);
  if (p) {
    scene.remove(p.group);
    if (p.mixer) p.mixer.stopAllAction();
    otherPlayers.delete(id);
  }
}

function updateAvatarPositions(dt) {
  otherPlayers.forEach((p) => {
    p.group.position.lerp(p.targetPos, 0.2);
    let dr = p.targetRot - p.group.rotation.y;
    while (dr >  Math.PI) dr -= Math.PI * 2;
    while (dr < -Math.PI) dr += Math.PI * 2;
    p.group.rotation.y += dr * 0.2;
    if (p.mixer) p.mixer.update(dt);
  });
}

// ─── CAIXES — COL·LOCACIÓ ────────────────────────────────────────────────────

function findFloorY(x, z) {
  raycaster.set(new THREE.Vector3(x, 200, z), new THREE.Vector3(0,-1,0));
  const hits = raycaster.intersectObjects(collidableMeshes, true);
  if (!hits.length) return null;
  return hits[0].point.y <= VALID_FLOOR_Y ? hits[0].point.y : null;
}

function placePendingBoxes() {
  if (!pendingBoxes || !levelReady) return;
  if (!chestBaseModel || !chestSpecialModel) return;
  pendingBoxes.forEach(createBoxMesh);
  pendingBoxes = null;
}

function cloneChestTemplate(source) {
  if (!source) return null;
  const root = source.clone(true);
  root.traverse((n) => {
    if (!n.isMesh) return;
    n.castShadow = true;
    n.receiveShadow = true;
    if (Array.isArray(n.material)) n.material = n.material.map((m) => m.clone());
    else if (n.material) n.material = n.material.clone();
  });
  return root;
}

function placeObjectOnFloor(obj, floorY) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  obj.position.y += (floorY - box.min.y);
  obj.updateMatrixWorld(true);
}

function computeColliderFromObject(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return null;
  return {
    cx: (box.min.x + box.max.x) * 0.5,
    cz: (box.min.z + box.max.z) * 0.5,
    halfXZ: Math.max((box.max.x - box.min.x), (box.max.z - box.min.z)) * 0.5,
    minY: box.min.y,
    maxY: box.max.y,
  };
}

function tagBoxObject(root, boxId, type) {
  root.userData.boxId = boxId;
  root.userData.type = type;
  root.traverse((n) => {
    if (!n.isMesh) return;
    n.userData.boxId = boxId;
    n.userData.type = type;
  });
}

function getBoxIdFromObject(obj) {
  let n = obj;
  while (n) {
    if (n.userData && Number.isInteger(n.userData.boxId)) return n.userData.boxId;
    n = n.parent;
  }
  return null;
}

function markQuestionChestAnswered(entry) {
  if (!entry?.mesh) return;
  if (entry.lidNode) entry.lidNode.rotation.x = entry.lidClosedX ?? entry.lidNode.rotation.x;
  if (entry.questionGlowLight) {
    scene.remove(entry.questionGlowLight);
    entry.questionGlowLight = null;
  }
  if (entry.questionGlowHalo) {
    entry.group?.remove(entry.questionGlowHalo);
    entry.questionGlowHalo = null;
  }
}

function setQuestionChestLid(boxId, opened) {
  const entry = boxData.get(boxId);
  if (!entry || entry.type !== 'question' || !entry.lidNode) return;
  const openX = entry.lidOpenX ?? entry.lidNode.rotation.x;
  const closedX = entry.lidClosedX ?? (openX + QUESTION_LID_OPEN_RAD);
  entry.lidNode.rotation.x = opened ? openX : closedX;
}

function setQuestionChestGlow(boxId, enabled) {
  const entry = boxData.get(boxId);
  if (!entry || entry.type !== 'question') return;
  if (!entry.mesh) return;

  setQuestionChestLid(boxId, enabled);

  if (!enabled) {
    if (entry.questionGlowLight) {
      scene.remove(entry.questionGlowLight);
      entry.questionGlowLight = null;
    }
    if (entry.questionGlowHalo) {
      entry.group?.remove(entry.questionGlowHalo);
      entry.questionGlowHalo = null;
    }
    return;
  }

  if (entry.questionGlowLight && entry.questionGlowHalo) return;
  const pos = new THREE.Vector3();
  entry.mesh.getWorldPosition(pos);
  const glow = new THREE.PointLight(0xff2d2d, 4.2, 8.5, 1.5);
  glow.position.set(pos.x, pos.y + 1.1, pos.z);
  scene.add(glow);
  entry.questionGlowLight = glow;

  if (!entry.questionGlowHalo) {
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xff3333,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.95, 22, 16), haloMat);
    halo.position.set(0, 1.1, 0);
    halo.renderOrder = 20;
    entry.group?.add(halo);
    entry.questionGlowHalo = halo;
  }
}

function removeBoxFromScene(boxId) {
  const d = boxData.get(boxId);
  if (!d) return;
  if (d.mesh)  scene.remove(d.mesh);
  if (d.group) scene.remove(d.group);
  if (d.light) scene.remove(d.light);
  if (d.questionGlowLight) scene.remove(d.questionGlowLight);
  if (d.questionGlowHalo) d.group?.remove(d.questionGlowHalo);
  boxMeshes.delete(boxId);
  boxData.delete(boxId);
  boxColliders.delete(boxId);
}

// ─── CAIXES — CREACIÓ ────────────────────────────────────────────────────────

function createBoxMesh(data) {
  const floorY = findFloorY(data.x, data.z);
  if (floorY === null) return;
  if (data.type === 'breakable') createBreakableBox(data, data.x, floorY, data.z);
  else if (data.type === 'question') createQuestionBox(data, data.x, floorY, data.z);
}

function createBreakableBox(data, x, floorY, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  let visual = cloneChestTemplate(chestBaseModel);
  if (!visual) {
    visual = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), MAT_BREAKABLE.clone());
    visual.position.set(0, floorY + 1, 0);
  } else {
    visual.scale.setScalar(1.7);
    group.add(visual);
    placeObjectOnFloor(group, floorY);
  }

  if (!visual.parent) group.add(visual);

  tagBoxObject(group, data.id, 'breakable');
  scene.add(group);

  const collider = computeColliderFromObject(group);
  boxMeshes.set(data.id, group);
  boxData.set(data.id, { ...data, floorY, mesh: group, group });
  if (collider) boxColliders.set(data.id, collider);

  if (data.broken) {
    group.visible = false;
    boxColliders.delete(data.id);
  }
}

function createQuestionBox(data, x, floorY, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const diff      = data.difficulty ?? 1;
  const diffIdx   = Math.max(0, Math.min(4, diff - 1));
  const baseScale = 1.8 * DIFF_SCALE[diffIdx];

  let visual = cloneChestTemplate(chestSpecialModel);
  if (!visual) {
    visual = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), MAT_QUESTION.clone());
    visual.position.set(0, floorY + 1.1, 0);
  } else {
    visual.scale.setScalar(baseScale);
    applyDifficultyColor(visual, diff);
    group.add(visual);
    placeObjectOnFloor(group, floorY);
  }

  if (!visual.parent) group.add(visual);

  tagBoxObject(group, data.id, 'question');
  scene.add(group);

  const collider = computeColliderFromObject(group);
  boxMeshes.set(data.id, group);
  let lidNode = null;
  group.traverse((n) => {
    if (!n?.name) return;
    if (n.name.toLowerCase().includes('lid')) lidNode = n;
  });

  if (lidNode) console.log('[LID] rotation.x al cargar:', lidNode.rotation.x, '(', THREE.MathUtils.radToDeg(lidNode.rotation.x).toFixed(1), '°)');

  const entry = {
    ...data,
    floorY,
    mesh: group,
    group,
    questionGlowLight: null,
    questionGlowHalo: null,
    lidNode,
    lidOpenX: lidNode ? lidNode.rotation.x : null,
    lidClosedX: lidNode ? (lidNode.rotation.x - QUESTION_LID_OPEN_RAD / 2) : null,
  };
  boxData.set(data.id, entry);
  if (lidNode) lidNode.rotation.x = entry.lidClosedX;
  if (collider) boxColliders.set(data.id, collider);

  if (data.answered) markQuestionChestAnswered(entry);
}

// ─── CAIXES — ANIMACIÓ ───────────────────────────────────────────────────────

function animateBoxes(t) {
  return;
}

// ─── CAIXES — TRENCAMENT ─────────────────────────────────────────────────────

function spawnWoodParticles(pos) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4A8A37,
    roughness: 0.8,
    emissive: 0x4A8A37,
    emissiveIntensity: 0.35,
  });
  for (let i=0;i<10;i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.14,0.14,0.14), mat);
    p.position.copy(pos).add(new THREE.Vector3(0,0.5,0));
    scene.add(p);
    particles.push({ mesh:p, vx:(Math.random()-.5)*9, vy:Math.random()*6+2, vz:(Math.random()-.5)*9 });
  }
}

function breakBoxVisual(boxId) {
  const d = boxData.get(boxId);
  if (!d || d.type !== 'breakable') return;
  const mesh = d.mesh;
  if (!mesh || !mesh.visible) return;

  const hitPos = new THREE.Vector3();
  mesh.getWorldPosition(hitPos);
  spawnWoodParticles(hitPos);
  boxColliders.delete(boxId);
  let scale = 1;
  const iv = setInterval(() => {
    scale -= 0.14;
    if (scale <= 0) { clearInterval(iv); mesh.visible=false; scene.remove(mesh); boxMeshes.delete(boxId); return; }
    mesh.scale.setScalar(scale);
    mesh.position.y += 0.04;
  }, 16);
}

// ─── RESPAWN DE CAIXA ────────────────────────────────────────────────────────

function respawnBreakableBox(boxId, x, z) {
  removeBoxFromScene(boxId);
  createBreakableBox({ id: boxId, type: 'breakable', x, z, broken: false }, x, findFloorY(x, z) ?? 0, z);
}

// ─── COL·LISIONS AABB AMB CAIXES ─────────────────────────────────────────────

function resolveBoxCollisions() {
  const px=playerCollider.start.x, pz=playerCollider.start.z;
  const pMinY=playerCollider.start.y, pMaxY=playerCollider.end.y, R=0.35;
  boxColliders.forEach((box) => {
    if (pMaxY<box.minY || pMinY>box.maxY) return;
    const dx=Math.abs(px-box.cx), dz=Math.abs(pz-box.cz);
    const ox=(R+box.halfXZ)-dx, oz=(R+box.halfXZ)-dz;
    if (ox<=0||oz<=0) return;
    if (ox<oz) { const s=px<box.cx?-1:1; playerCollider.start.x+=s*ox; playerCollider.end.x+=s*ox; }
    else       { const s=pz<box.cz?-1:1; playerCollider.start.z+=s*oz; playerCollider.end.z+=s*oz; }
  });
}

// ─── INTERACCIÓ ──────────────────────────────────────────────────────────────

function tryBreakBox() {
  if (!levelReady || dialogOpen || !gameStarted) return;
  if (forca >= 3) { showMsg('Ja tens força! Busca una pregunta', '#ffdd44'); return; }

  const breakables = [];
  boxMeshes.forEach((mesh, id) => {
    const d = boxData.get(id);
    if (d && d.type==='breakable' && mesh.visible) breakables.push(mesh);
  });

  raycaster.setFromCamera(new THREE.Vector2(0,0), camera);
  const hits = raycaster.intersectObjects(breakables, true);
  if (!hits.length) return;

  const mesh = hits[0].object;
  mesh.getWorldPosition(tmpVec);
  if (camera.position.distanceTo(tmpVec) > BREAK_DIST) return;

  const boxId = getBoxIdFromObject(mesh);
  if (boxId === null) return;
  setTimeout(() => {
    socket.emit('box:break', { boxId });
    breakBoxVisual(boxId);
    setForca(forca + 1);
    if (forca === 3) showMsg('Força màxima! Busca una pregunta', '#ffdd44');
  }, BREAK_HIT_DELAY_MS);
}

function tryOpenQuestion() {
  if (!levelReady || dialogOpen || !gameStarted) return;
  if (forca < 3) { showMsg(`Necessites 3 de força (tens ${forca})`, '#ff8844'); return; }

  const camPos = camera.position;
  let nearest = null, nearestDist = Infinity;
  boxData.forEach((d, id) => {
    if (d.type!=='question' || d.answered) return;
    const mesh = boxMeshes.get(id);
    if (!mesh) return;
    mesh.getWorldPosition(tmpVec);
    const dist = camPos.distanceTo(tmpVec);
    if (dist < INTERACT_DIST && dist < nearestDist) { nearest=id; nearestDist=dist; }
  });
  if (nearest !== null) openDialog(nearest);
}

function triggerQuestionGestureAndOpen() {
  if (!controls.isLocked || dialogOpen || !gameStarted) return;
  if (performance.now() < frozenUntilMs || questionOpenPending) return;

  socket.emit('player:emote', { anim: 'ThumbsUp' });
  playLocalEmote('ThumbsUp');
  questionOpenPending = true;

  setTimeout(() => {
    questionOpenPending = false;
    tryOpenQuestion();
  }, QUESTION_OPEN_DELAY_MS);
}

// Clic esquerre: swing + trencar caixa O obrir pregunta segons força
function onLeftClick() {
  if (!controls.isLocked || dialogOpen || !gameStarted) return;
  if (performance.now() < frozenUntilMs) return;
  const now = performance.now();
  if (now - lastPunchMs < PUNCH_COOLDOWN_MS) return;
  lastPunchMs = now;

  socket.emit('player:emote', { anim: 'Punch' });
  playLocalEmote('Punch');

  if (forca < 3) tryBreakBox();
}

function onRightClick() {
  return;
}

let lastProximityCheck = 0;
function checkProximityHint() {
  if (!gameStarted || dialogOpen) { hideHint(); return; }
  // Throttle: només comprova cada 100 ms
  const now = performance.now();
  if (now - lastProximityCheck < 100) return;
  lastProximityCheck = now;

  const camPos = camera.position;
  let found = false;
  boxData.forEach((d) => {
    if (d.type!=='question'||d.answered) return;
    const mesh = boxMeshes.get(d.id);
    if (!mesh) return;
    mesh.getWorldPosition(tmpVec);
    if (camPos.distanceTo(tmpVec) < INTERACT_DIST) found = true;
  });

  if (found) {
    if (forca >= 3) showHint('Prem Q per obrir la pregunta');
    else showHint(`Necessites ${3 - forca} força més per obrir preguntes`);
  } else {
    hideHint();
  }
}

// ─── DIÀLEG ──────────────────────────────────────────────────────────────────

function openDialog(boxId) {
  const d = boxData.get(boxId);
  if (!d) return;
  if (activeQuestion !== null && activeQuestion !== boxId) setQuestionChestGlow(activeQuestion, false);
  setQuestionChestGlow(boxId, true);
  socket.emit('box:focus', { boxId, open: true });
  activeQuestion = boxId;
  dialogQuestion.textContent = d.question;
  dialogFeedback.textContent = '';
  dialogAnswers.forEach((btn, i) => {
    btn.textContent = `${['A','B','C','D'][i]}) ${d.answers?.[i] ?? ''}`;
    btn.classList.remove('correct','wrong');
    btn.disabled = false;
  });
  dialogOverlay.classList.add('open');
  dialogOpen = true;
  document.exitPointerLock();
}

function closeDialog() {
  if (activeQuestion !== null) {
    setQuestionChestGlow(activeQuestion, false);
    socket.emit('box:focus', { boxId: activeQuestion, open: false });
  }
  dialogOverlay.classList.remove('open');
  dialogOpen = false;
  activeQuestion = null;
}

function submitAnswer(answerIndex) {
  if (activeQuestion === null) return;
  dialogAnswers.forEach(b => b.disabled = true);
  socket.emit('box:answer', { boxId: activeQuestion, answerIndex });
}

dialogAnswers.forEach((btn) => {
  btn.addEventListener('click', () => submitAnswer(parseInt(btn.dataset.idx)));
});
btnCancelar.addEventListener('click', closeDialog);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dialogOpen) closeDialog();
});

// ─── HUD ─────────────────────────────────────────────────────────────────────

let msgTimer = null;
function showMsg(text, color='#ffffff') {
  msgEl.textContent = text; msgEl.style.color = color; msgEl.classList.add('visible');
  clearTimeout(msgTimer); msgTimer = setTimeout(() => msgEl.classList.remove('visible'), 2500);
}
function showHint(text) { hintEl.textContent = text; hintEl.classList.add('visible'); }
function hideHint()     { hintEl.classList.remove('visible'); }
function showError(msg) { errorBox.style.display='block'; errorBox.textContent=msg; }

let bigFeedbackTimer = null;
function showBigFeedback(title, sub, color) {
  bigFeedbackTitle.textContent = title;
  bigFeedbackTitle.style.color = color;
  bigFeedbackSub.textContent   = sub;
  bigFeedback.classList.add('visible');
  clearTimeout(bigFeedbackTimer);
  bigFeedbackTimer = setTimeout(() => bigFeedback.classList.remove('visible'), 3500);
}

function updateScoreboard(scores) {
  if (!scores) return;
  sbListEl.innerHTML = '';
  scores.sort((a,b)=>b.score-a.score).forEach((s) => {
    const row = document.createElement('div');
    row.className = 'sb-row';
    const dot   = `<span class="sb-color" style="background:${s.color}"></span>`;
    const label = s.id===myId ? `<b>${myName||'Tu'}</b>` : (s.name||s.id.slice(0,5));
    row.innerHTML = `<span>${dot}${label}</span><span class="sb-pts">${s.score}</span>`;
    sbListEl.appendChild(row);
  });
}

// ─── SOCKET.IO — EVENTS ──────────────────────────────────────────────────────

socket.on('init', (data) => {
  myId    = data.playerId;
  myColor = data.color;
  data.players.forEach((p) => addOtherPlayer(p.id, p.color, p.position, p.rotation, p.name));
  if (levelReady) data.boxes.forEach(createBoxMesh);
  else pendingBoxes = data.boxes;
  updateScoreboard(data.scores);
});

socket.on('player:add',    (d) => addOtherPlayer(d.id, d.color, d.position, d.rotation, d.name));
socket.on('player:remove', (d) => removeOtherPlayer(d.id));
socket.on('player:emote',  (d) => { const p = otherPlayers.get(d.id); if (p) playEmoteOn(p, d.anim, d.holdMs || 0); });
socket.on('player:name',   (d) => {
  const p = otherPlayers.get(d.id);
  if (!p) return;
  p.name = d.name;
  updatePlayerLabel(d.id, d.name);
});

socket.on('score:update', (d) => updateScoreboard(d.scores));

socket.on('score:restore', (d) => {
  myScore = d.score ?? 0;
  setBombaCharges(d.bombCharges ?? 0);
  if (d.hasBomb) setBombaCharges(3);
  showBigFeedback('Puntuació restaurada', `${myScore} pts recuperats`, '#44ddff');
});

socket.on('box:focus', (d) => {
  if (!Number.isInteger(d?.boxId)) return;
  setQuestionChestGlow(d.boxId, !!d.open);
});

socket.on('player:move', (d) => {
  const p = otherPlayers.get(d.id);
  if (!p) return;
  const newPos = new THREE.Vector3(d.position.x, d.position.y - CAM_HEIGHT, d.position.z);
  const dist   = newPos.distanceTo(p.targetPos);
  const moving = dist > 0.02;

  // Detectar si es mou endavant o enrere respecte on mira
  let forward = true;
  if (moving) {
    const dx = newPos.x - p.targetPos.x;
    const dz = newPos.z - p.targetPos.z;
    const fx  = -Math.sin(d.rotation);
    const fz  = -Math.cos(d.rotation);
    forward   = (dx * fx + dz * fz) >= 0;
  }

  p.targetPos.copy(newPos);

  const animLocked = performance.now() < (p.animLockedUntilMs || 0);
  if (!animLocked) p.targetRot = d.rotation;

  if (!animLocked && p.idleAction && p.jogAction) {
    if (!moving && p.isMoving) {
      // Para → idle
      p.jogAction.fadeOut(0.25);
      p.idleAction.reset().fadeIn(0.25).play();
    } else if (moving && !p.isMoving) {
      // Comença a moure's
      p.idleAction.fadeOut(0.25);
      p.jogAction.timeScale = forward ? 1 : -1;
      p.jogAction.reset();
      if (!forward) p.jogAction.time = p.jogAction.getClip().duration;
      p.jogAction.fadeIn(0.25).play();
    } else if (moving && forward !== p.movingForward) {
      // Canvia direcció sense parar
      p.jogAction.timeScale = forward ? 1 : -1;
    }
  }

  p.isMoving     = moving;
  p.movingForward = forward;
});

socket.on('box:break', (d) => {
  const entry = boxData.get(d.boxId);
  if (entry) entry.broken = true;
  breakBoxVisual(d.boxId);
});

socket.on('box:respawn', (d) => {
  if (levelReady) respawnBreakableBox(d.boxId, d.x, d.z);
});

socket.on('box:newquestion', (d) => {
  const entry = boxData.get(d.boxId);
  if (entry) {
    entry.question = d.question;
    entry.answers  = d.answers;
  }
  if (dialogOpen && activeQuestion === d.boxId) closeDialog();
});

socket.on('box:answered', (d) => {
  dialogAnswers.forEach(b => b.disabled = false);

  if (d.correct) {
    const entry = boxData.get(d.boxId);
    if (entry) {
      entry.answered = true;
      markQuestionChestAnswered(entry);
    }

    if (d.playerId === myId) {
      myScore = d.scores?.find(s => s.id === myId)?.score ?? myScore;
      const pts = entry?.pts ?? 10;
      closeDialog();
      showBigFeedback('Correcte!', `Has aconseguit +${pts} punts`, '#44ff88');

      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          socket.emit('player:emote', { anim: 'Jump' });
          playLocalEmote('Jump');
        }, i * 360);
      }
    }

    if (dialogOpen && activeQuestion === d.boxId && d.playerId !== myId) {
      showMsg('Un altre jugador ha respost la pregunta', '#aaaaff');
      closeDialog();
    }

    if (d.scores) updateScoreboard(d.scores);

  } else {
    if (d.playerId === myId) {
      dialogAnswers.forEach(b => b.classList.add('wrong'));
      const correctAnswer = d.correctAnswer || '';
      setTimeout(() => {
        closeDialog();
        applyDeathEffect('Error!', `La resposta correcta era: "${correctAnswer}"`);
      }, 400);

      if (d.scores) {
        myScore = d.scores?.find(s => s.id === myId)?.score ?? myScore;
        updateScoreboard(d.scores);
      }
    }
  }

  if (d.playerId === myId) setForca(0);
});

socket.on('game:reset', (d) => {
  // Eliminar todas las cajas actuales
  boxData.forEach((_, id) => removeBoxFromScene(id));
  activeQuestion = null;
  dialogOpen = false;
  dialogOverlay.classList.remove('open');
  setForca(0);
  // Recrear todas las cajas
  if (levelReady) d.boxes.forEach(createBoxMesh);
  else pendingBoxes = d.boxes;
  if (d.scores) updateScoreboard(d.scores);
  myScore = d.scores?.find(s => s.id === myId)?.score ?? 0;
  showMsg('El joc s\'ha reiniciat!', '#ffdd44');
});

socket.on('box:questionrespawn', (d) => {
  removeBoxFromScene(d.boxId);
  if (levelReady) {
    const floorY = findFloorY(d.x, d.z) ?? 0;
    createQuestionBox(
      { id: d.boxId, type: 'question', x: d.x, z: d.z,
        question: d.question, answers: d.answers, pts: d.pts,
        difficulty: d.difficulty ?? 1, answered: false },
      d.x, floorY, d.z
    );
  }
  showMsg('Nova pregunta disponible!', '#ffdd44');
});

// ─── FÍSICA ───────────────────────────────────────────────────────────────────

function getForward() { camera.getWorldDirection(fwdVec); fwdVec.y=0; fwdVec.normalize(); return fwdVec; }
function getRight()   { camera.getWorldDirection(rightVec); rightVec.y=0; rightVec.normalize(); rightVec.cross(camera.up); return rightVec; }

function playerCollisions() {
  const r = worldOctree.capsuleIntersect(playerCollider);
  playerOnFloor = false;
  if (!r) return;
  playerOnFloor = r.normal.y > 0;
  if (!playerOnFloor) playerVel.addScaledVector(r.normal, -r.normal.dot(playerVel));
  playerCollider.translate(r.normal.multiplyScalar(r.depth));
}

function updateMovement(dt) {
  if (!levelReady || !gameStarted) return;
  if (performance.now() < frozenUntilMs) {
    playerVel.x = 0;
    playerVel.z = 0;
  }

  if (controls.isLocked) {
    const speed = dt*(playerOnFloor ? MOVE_SPEED : AIR_CONTROL);
    if (performance.now() >= frozenUntilMs) {
      if (moveState.forward)  playerVel.add(getForward().multiplyScalar(speed));
      if (moveState.backward) playerVel.add(getForward().multiplyScalar(-speed));
      if (moveState.left)     playerVel.add(getRight().multiplyScalar(-speed));
      if (moveState.right)    playerVel.add(getRight().multiplyScalar(speed));
    }
  }
  let damp = Math.exp(-4*dt)-1;
  if (!playerOnFloor) { playerVel.y-=GRAVITY*dt; damp*=0.1; }
  playerVel.addScaledVector(playerVel, damp);
  playerCollider.translate(playerVel.clone().multiplyScalar(dt));
  playerCollisions();
  resolveBoxCollisions();
  if (playerCollider.end.y < -40) { setPlayerPosition(FALLBACK_SPAWN.clone()); playerVel.set(0,0,0); }
  camera.position.copy(playerCollider.end);
}

// ─── SINCRONITZACIÓ ──────────────────────────────────────────────────────────

let lastSendMs = 0;
const _syncDir = new THREE.Vector3();
function syncPosition() {
  if (!gameStarted) return;
  const now = performance.now();
  if (now-lastSendMs < 50) return;
  lastSendMs = now;
  // Durante Death se mantiene la orientación del avatar, aunque la cámara pueda mirar
  let yaw = deathLockedYaw;
  if (yaw === null) {
    controls.getDirection(_syncDir);
    yaw = Math.atan2(-_syncDir.x, -_syncDir.z);
  }
  socket.emit('player:move', {
    // Enviar posició física real, no la de càmera amb offset
    position: { x:playerCollider.end.x, y:playerCollider.end.y, z:playerCollider.end.z },
    rotation: yaw,
  });
}

// ─── PARTÍCULES ──────────────────────────────────────────────────────────────

function updateParticles(dt) {
  for (let i=particles.length-1;i>=0;i--) {
    const p=particles[i];
    p.vy-=25*dt;
    p.mesh.position.x+=p.vx*dt; p.mesh.position.y+=p.vy*dt; p.mesh.position.z+=p.vz*dt;
    p.mesh.rotation.x+=3*dt; p.mesh.rotation.z+=2*dt;
    if (p.mesh.position.y<-5) { scene.remove(p.mesh); particles.splice(i,1); }
  }
}

// ─── LOOP PRINCIPAL ──────────────────────────────────────────────────────────

function animate() {
  const dt = clock.getDelta();
  const t  = clock.elapsedTime;
  updateMovement(dt);
  updateParticles(dt);
  updateAvatarPositions(dt);
  updateLocalAvatar(dt);
  animateBoxes(t);
  checkProximityHint();
  syncPosition();
  camCoordsEl.textContent = `X:${camOffset.x.toFixed(2)}  Y:${camOffset.y.toFixed(2)}  Z:${camOffset.z.toFixed(2)}`;
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ─── EVENTS DE TECLAT I RATOLÍ ───────────────────────────────────────────────

function setKey(e, val) {
  if (dialogOpen || performance.now() < frozenUntilMs) return;
  switch (e.code) {
    case 'KeyW': moveState.forward  = val; break;
    case 'KeyS': moveState.backward = val; break;
    case 'KeyA': moveState.left     = val; break;
    case 'KeyD': moveState.right    = val; break;
  }
}
window.addEventListener('keydown', (e) => {
  setKey(e, true);
  if (e.code==='Space') {
    e.preventDefault();
  }
  if (e.code==='KeyQ') {
    e.preventDefault();
  }

  if (e.code==='Space' && controls.isLocked && gameStarted && performance.now() >= frozenUntilMs) {
    if (playerOnFloor) playerVel.y = 6;
    socket.emit('player:emote', { anim: 'Jump' });
    playLocalEmote('Jump');
  }
  if (e.code==='KeyQ' && controls.isLocked && gameStarted) {
    triggerQuestionGestureAndOpen();
  }
  if (e.code==='KeyG' && controls.isLocked && gameStarted) {
    if (performance.now() < frozenUntilMs) return;
    socket.emit('player:emote', { anim: 'Wave' });
    playLocalEmote('Wave');
  }
  if (e.code==='KeyT' && controls.isLocked && gameStarted) {
    if (performance.now() < frozenUntilMs) return;
    socket.emit('player:emote', { anim: 'ThumbsUp' });
    playLocalEmote('ThumbsUp');
  }
  if (e.code==='KeyE' && controls.isLocked && gameStarted && !dialogOpen) {
    if (!myHasBomb) { showMsg('No tens bomba (respon 3 preguntes dificultat 5)', '#888'); return; }
    // Buscar un cofre de pregunta obert (amb glow halo) i comprovar si hi som dins
    const myPos    = playerCollider.start.clone();
    const BLAST_R  = 2.5;
    let targetBoxId = null;
    boxData.forEach((entry, boxId) => {
      if (entry.type !== 'question' || !entry.questionGlowHalo || !entry.group) return;
      const chestPos = new THREE.Vector3();
      entry.group.getWorldPosition(chestPos);
      chestPos.y += 1.1; // centre de l'esfera halo
      if (myPos.distanceTo(chestPos) <= BLAST_R) targetBoxId = boxId;
    });
    if (targetBoxId !== null) {
      socket.emit('bomb:use', { boxId: targetBoxId });
      showMsg('💣 Bomba col·locada! Fuig en 3 segons!', '#c04060');
    } else {
      showMsg('Has d\'estar dins l\'esfera del cofre obert', '#ff8844');
    }
  }
  if (!dialogOpen) {
    const ck = e.key.toLowerCase();
    if (ck === 'i') { camOffset.x = Math.min( 3, camOffset.x + CAM_STEP); updateCamPanel(); }
    if (ck === 'k') { camOffset.x = Math.max(-3, camOffset.x - CAM_STEP); updateCamPanel(); }
    if (ck === 'o') { camOffset.y = Math.min( 3, camOffset.y + CAM_STEP); updateCamPanel(); }
    if (ck === 'l') { camOffset.y = Math.max(-2, camOffset.y - CAM_STEP); updateCamPanel(); }
    if (ck === 'p') { camOffset.z = Math.min( 3, camOffset.z + CAM_STEP); updateCamPanel(); }
    if (ck === 'ñ') { camOffset.z = Math.max(-3, camOffset.z - CAM_STEP); updateCamPanel(); }
  }
});
window.addEventListener('keyup', (e) => setKey(e, false));

renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

renderer.domElement.addEventListener('mousedown', (e) => {
  if (!controls.isLocked) { renderer.domElement.focus(); controls.lock(); return; }
  if (e.button === 0) onLeftClick();
  if (e.button === 2) onRightClick();
});

startBtn.addEventListener('click', () => { renderer.domElement.focus(); controls.lock(); });

controls.addEventListener('lock',   () => { overlay.classList.remove('visible'); });
controls.addEventListener('unlock', () => { if (!dialogOpen && gameStarted) overlay.classList.add('visible'); });

window.addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ─── COMANDOS ADMIN (Ctrl+Alt+Shift+P/O/I/U) ─────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.altKey || !e.shiftKey) return;
  if (!gameStarted) return;

  if (e.code === 'KeyP') {
    e.preventDefault();
    socket.emit('admin:prestart');
  } else if (e.code === 'KeyO') {
    e.preventDefault();
    socket.emit('admin:start');
  } else if (e.code === 'KeyI') {
    e.preventDefault();
    socket.emit('admin:end');
  } else if (e.code === 'KeyU') {
    e.preventDefault();
    controls.unlock();
    const msg = window.prompt('Quin missatge vols enviar?', '');
    if (msg && msg.trim()) socket.emit('admin:broadcast', { text: msg.trim() });
  }
});

// ─── DEATH EFFECT (reutilitzable per fallo i bomba) ───────────────────────────

function applyDeathEffect(title, subtitle) {
  frozenUntilMs = performance.now() + DEATH_LOCK_MS;
  localDeathUntilMs = frozenUntilMs;
  controls.getDirection(tmpVec);
  deathLockedYaw = Math.atan2(-tmpVec.x, -tmpVec.z);
  moveState.forward = moveState.backward = moveState.left = moveState.right = false;
  playerVel.set(0, 0, 0);
  localIsMoving = false;

  socket.emit('player:emote', { anim: 'Death', holdMs: DEATH_LOCK_MS });

  if (localActions['Death']) {
    const death = localActions['Death'];
    if (localMixer) localMixer.stopAllAction();
    const base = localIsMoving ? localJogAction : localIdleAction;
    if (base) base.fadeOut(0.2);
    death.reset();
    death.setLoop(THREE.LoopRepeat, Infinity);
    death.clampWhenFinished = false;
    death.fadeIn(0.15).play();

    if (deathRecoverTimer) clearTimeout(deathRecoverTimer);
    deathRecoverTimer = setTimeout(() => {
      death.fadeOut(0.2);
      death.stop();
      death.setLoop(THREE.LoopOnce, 1);
      death.clampWhenFinished = true;
      localDeathUntilMs = 0;
      deathLockedYaw = null;
      const back = localIsMoving ? localJogAction : localIdleAction;
      if (back) back.reset().fadeIn(0.2).play();
    }, DEATH_LOCK_MS);
  }

  showBigFeedback(title, subtitle, '#ff4444');
}

// ─── EVENTS BOMBA ─────────────────────────────────────────────────────────────

socket.on('bomb:charge', (d) => {
  setBombaCharges(d.charges ?? 0);
});

socket.on('bomb:ready', (d) => {
  setBombaCharges(3);
  showBigFeedback('💣 BOMBA LLESTA!', 'Ves a un jugador que respon i prem [E]', '#c04060');
});

socket.on('bomb:hit', (d) => {
  // Tanca el diàleg immediatament
  if (dialogOpen) closeDialog();
  if (d.scores) {
    myScore = d.scores?.find(s => s.id === myId)?.score ?? myScore;
    updateScoreboard(d.scores);
  }
  // Aplicar death complet igual que fallo de pregunta
  applyDeathEffect('💥 T\'han llançat una BOMBA!', '-5 punts i has perdut la pregunta');
});

socket.on('bomb:splash', (d) => {
  if (d.scores) {
    myScore = d.scores?.find(s => s.id === myId)?.score ?? myScore;
    updateScoreboard(d.scores);
  }
  applyDeathEffect('💥 T\'has quedat a l\'ona expansiva!', '-5 punts — fuig quan llancis la bomba!');
});

socket.on('bomb:effect', (d) => {
  // Notificació global de bomba (per a espectadors i el bomber)
  if (d.bomberId === myId) {
    showBigFeedback('💣 BOMBA LLANÇADA!', `Has interromput a ${d.targetName}`, '#c04060');
    setBombaCharges(0);
  }
  if (d.scores) updateScoreboard(d.scores);
});

// ─── EVENTS ADMIN (rebuts del servidor) ──────────────────────────────────────

socket.on('admin:message', (d) => {
  showBigFeedback(d.text, '', d.color || '#ffdd44');
});

socket.on('admin:gamestart', (d) => {
  myScore = 0;
  if (d.scores) updateScoreboard(d.scores);
  showBigFeedback('Comença el joc!', '', '#44ff88');
});

socket.on('admin:gameend', (d) => {
  if (d.scores) updateScoreboard(d.scores);
  showBigFeedback(d.message || 'El joc ha acabat!', '', '#ffdd44');
});

// ─── DEBUG SLIDERS ───────────────────────────────────────────────────────────

const SHADOW_HEMI_MIN = 0.6;
const SHADOW_HEMI_MAX = 1.6;
const SHADOW_AMB_MIN  = 0.0;
const SHADOW_AMB_MAX  = 0.9;

const shadowDarknessSlider = document.getElementById('shadowDarkness');
const shadowDarknessValEl  = document.getElementById('shadowDarknessVal');
const hemiSliderEl = document.getElementById('hemiIntensity');
const ambSliderEl  = document.getElementById('ambIntensity');

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function updateShadowDarknessFromFill() {
  const hemi = lightHemi ? lightHemi.intensity : parseFloat(hemiSliderEl.value);
  const amb  = lightAmb ? lightAmb.intensity : parseFloat(ambSliderEl.value);
  const vH = clamp01((SHADOW_HEMI_MAX - hemi) / (SHADOW_HEMI_MAX - SHADOW_HEMI_MIN));
  const vA = clamp01((SHADOW_AMB_MAX - amb) / (SHADOW_AMB_MAX - SHADOW_AMB_MIN));
  const v = (vH + vA) * 0.5;
  shadowDarknessSlider.value = v.toFixed(2);
  shadowDarknessValEl.textContent = v.toFixed(2);
}

function applyShadowDarkness(v) {
  const darkness = clamp01(v);
  const hemi = SHADOW_HEMI_MAX - darkness * (SHADOW_HEMI_MAX - SHADOW_HEMI_MIN);
  const amb  = SHADOW_AMB_MAX  - darkness * (SHADOW_AMB_MAX  - SHADOW_AMB_MIN);

  if (lightHemi) lightHemi.intensity = hemi;
  if (lightAmb)  lightAmb.intensity  = amb;

  hemiSliderEl.value = hemi.toFixed(2);
  ambSliderEl.value  = amb.toFixed(2);
  document.getElementById('hemiVal').textContent = hemi.toFixed(2);
  document.getElementById('ambVal').textContent = amb.toFixed(2);
  shadowDarknessValEl.textContent = darkness.toFixed(2);
}

document.getElementById('dirIntensity').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (lightDir)  lightDir.intensity  = v;
  document.getElementById('dirVal').textContent = v.toFixed(2);
});
document.getElementById('hemiIntensity').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (lightHemi) lightHemi.intensity = v;
  document.getElementById('hemiVal').textContent = v.toFixed(2);
  updateShadowDarknessFromFill();
});
document.getElementById('ambIntensity').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (lightAmb)  lightAmb.intensity  = v;
  document.getElementById('ambVal').textContent = v.toFixed(2);
  updateShadowDarknessFromFill();
});

shadowDarknessSlider.addEventListener('input', e => {
  applyShadowDarkness(parseFloat(e.target.value));
});

applyShadowDarkness(parseFloat(shadowDarknessSlider.value));

// ─── CÀMERA OFFSET (debug) ───────────────────────────────────────────────────

const camCoordsEl = document.getElementById('camCoords');
const camXSlider  = document.getElementById('camXSlider');
const camYSlider  = document.getElementById('camYSlider');
const camZSlider  = document.getElementById('camZSlider');
const camXValEl   = document.getElementById('camXVal');
const camYValEl   = document.getElementById('camYVal');
const camZValEl   = document.getElementById('camZVal');

const camOffset = { x: 0, y: -0.55, z: 0 };  // posición de brazos relativa a cámara
const CAM_STEP  = 0.05;

function updateCamPanel() {
  camXSlider.value = camOffset.x;
  camYSlider.value = camOffset.y;
  camZSlider.value = camOffset.z;
  camXValEl.textContent = camOffset.x.toFixed(2);
  camYValEl.textContent = camOffset.y.toFixed(2);
  camZValEl.textContent = camOffset.z.toFixed(2);
}

camXSlider.addEventListener('input', e => { camOffset.x = parseFloat(e.target.value); camXValEl.textContent = camOffset.x.toFixed(2); });
camYSlider.addEventListener('input', e => { camOffset.y = parseFloat(e.target.value); camYValEl.textContent = camOffset.y.toFixed(2); });
camZSlider.addEventListener('input', e => { camOffset.z = parseFloat(e.target.value); camZValEl.textContent = camOffset.z.toFixed(2); });
updateCamPanel();   // sincronizar sliders con valores iniciales

// ─── AVATAR PROPI JUGADOR ────────────────────────────────────────────────────

let localAvatar     = null;
let localMixer      = null;
let localActions    = {};
let localIdleAction = null;
let localJogAction  = null;
let localIsMoving   = false;

function createLocalAvatar() {
  if (!fbxBaseModel || !gameStarted) return;
  if (localAvatar) { camera.remove(localAvatar); }
  localAvatar = createAvatar(myColor, myName || '');
  if (localAvatar.userData.label) localAvatar.userData.label.visible = false;

  // Robot mira en -Z (igual que la cámara) → vemos su espalda y brazos correctamente
  if (localAvatar.userData.fbxClone) localAvatar.userData.fbxClone.rotation.y = Math.PI;

  // Mostrar solo brazos y manos; desactivar frustum culling para evitar recortes
  const ARM_PARENTS = new Set(['UpperArmL', 'UpperArmR', 'HandL', 'HandR']);
  localAvatar.traverse(child => {
    if (!child.isMesh) return;
    child.visible = ARM_PARENTS.has(child.parent?.name);
    if (child.visible) child.frustumCulled = false;
  });

  // Posición inicial según los sliders (relativa a cámara)
  localAvatar.position.set(camOffset.x, camOffset.y, camOffset.z);
  camera.add(localAvatar);   // hijo de cámara → sigue rotación y posición de forma perfecta
  localMixer = null; localActions = {}; localIdleAction = null; localJogAction = null;
  if (localAvatar.userData.fbxClone && fbxAllClips.length) {
    localMixer = new THREE.AnimationMixer(localAvatar.userData.fbxClone);
    const EMOTES = ['Jump','Yes','No','Wave','Punch','ThumbsUp','Running','Dance','Death'];
    fbxAllClips.forEach(clip => {
      const act = localMixer.clipAction(clip);
      if (EMOTES.includes(clip.name)) { act.clampWhenFinished = true; act.loop = THREE.LoopOnce; }
      localActions[clip.name] = act;
    });
    localIdleAction = localActions['Idle'] ?? null;
    localJogAction  = localActions['Walking'] ?? null;
    if (localIdleAction) localIdleAction.play();
  }
}

function playLocalEmote(animName) {
  if (!localMixer || !localActions[animName]) return;
  if (performance.now() < localDeathUntilMs) return;
  const emote = localActions[animName];
  const base  = localIsMoving ? localJogAction : localIdleAction;
  if (base) base.fadeOut(0.2);
  emote.reset().fadeIn(0.2).play();
  localMixer.addEventListener('finished', function onDone(e) {
    if (e.action !== emote) return;
    localMixer.removeEventListener('finished', onDone);
    if (performance.now() < localDeathUntilMs) return;
    emote.fadeOut(0.2);
    const back = localIsMoving ? localJogAction : localIdleAction;
    if (back) back.reset().fadeIn(0.2).play();
  });
}

function updateLocalAvatar(dt) {
  if (!localAvatar || !gameStarted) return;
  // Avatar es hijo de cámara: solo actualizamos su posición relativa (slider de ajuste)
  localAvatar.position.set(camOffset.x, camOffset.y, camOffset.z);
  if (performance.now() < localDeathUntilMs) {
    localIsMoving = false;
    if (localMixer) localMixer.update(dt);
    return;
  }
  const moving = moveState.forward || moveState.backward || moveState.left || moveState.right;
  if (localIdleAction && localJogAction) {
    if (moving && !localIsMoving) {
      localIdleAction.fadeOut(0.2);
      localJogAction.timeScale = moveState.backward ? -1 : 1;
      localJogAction.reset().fadeIn(0.2).play();
    } else if (!moving && localIsMoving) {
      localJogAction.fadeOut(0.2);
      localIdleAction.reset().fadeIn(0.2).play();
    }
    localIsMoving = moving;
  }
  if (localMixer) localMixer.update(dt);
}

// ─── ARRENCADA ────────────────────────────────────────────────────────────────

setupLighting();
setupSky();
loadLevel();
preloadFBXModels();
preloadChestModels();
animate();

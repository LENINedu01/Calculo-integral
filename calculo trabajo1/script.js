// ══════════════════════════════════════════════════════════
//  MotoSIM — Kawasaki Ninja H2
//  · Aceleración polinómica + eventos de ruta
//  · Bache (gaussiana), Ciudad (rampa), Semáforo, Curva (seno), Turbo
//  · Riemann Izq/Der/Medio + Trapezoidal
//  · Consumo curva-U
// ══════════════════════════════════════════════════════════

const canvas = document.getElementById("escena");
const ctx    = canvas.getContext("2d");

const motoImg = new Image();
motoImg.src   = "moto.png";

// Estado de animación
let animID, pausado = false, ultimoTS = 0;
let tiempo = 0, motoX = 80, scrollOff = 0;
let hT = [], hV = [], hX = [], hGas = [], hA = [];

// Parámetros globales
let _v0, _a0, _a1, _a2, _T;

// Notificaciones de eventos activos
let notifTimer = null;

// Mundo
let estrellas = [], edificios = [];

// Zoom estado para gráfica integral
let zoomLevel = 1.0;
let zoomOffsetT = 0; // offset en unidades de tiempo
let grafIntegralTipo = 'v'; // 'v' | 'a' | 'x'

// ── Setters ──
function setGrafIntegral(tipo, btn) {
  grafIntegralTipo = tipo;
  document.querySelectorAll('.graf-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const labels = {
    v: { y: 'Eje Y — Velocidad (m/s)', curva: 'Curva real v(t)', desc: 'Área = distancia recorrida ∫v(t)dt' },
    a: { y: 'Eje Y — Aceleración (m/s²)', curva: 'Curva real a(t)', desc: 'Área = cambio de velocidad ∫a(t)dt' },
    x: { y: 'Eje Y — Distancia (m)', curva: 'Curva real x(t)', desc: 'Área = posición acumulada ∫x(t)dt' }
  };
  const l = labels[tipo];
  const yEl = document.getElementById('yAxisLabel');
  const cEl = document.getElementById('leg-curva');
  const dEl = document.getElementById('integral-graf-desc');
  if (yEl) yEl.textContent = l.y;
  if (cEl) cEl.textContent = l.curva;
  if (dEl) dEl.textContent = l.desc;

  dibujarIntegral();
}

function zoomIntegral(factor) {
  zoomLevel = Math.max(0.25, Math.min(8, zoomLevel * factor));
  document.getElementById('zoomLabel').textContent = Math.round(zoomLevel * 100) + '%';
  dibujarIntegral();
}

function resetZoomIntegral() {
  zoomLevel = 1.0;
  zoomOffsetT = 0;
  document.getElementById('zoomLabel').textContent = '100%';
  dibujarIntegral();
}

function leerEventos() {
  const evs = [];
  const defs = [
    { id:'bache',    tipo:'gaussiana' },
    { id:'ciudad',   tipo:'rampa'     },
    { id:'semaforo', tipo:'rampa'     },
    { id:'curva',    tipo:'seno'      },
    { id:'turbo',    tipo:'boost'     },
  ];
  defs.forEach(({id, tipo}) => {
    const chk = document.getElementById('chk-' + id);
    if (!chk || !chk.checked) return;
    const t0  = parseFloat(document.getElementById('t-'   + id)?.value) || 0;
    const d   = parseFloat(document.getElementById('d-'   + id)?.value) || 0;
    const dur = parseFloat(document.getElementById('dur-' + id)?.value) || 1;
    evs.push({ id, tipo, t0, d, dur });
  });
  return evs;
}

// ══════════════════════════════════════════════════════════
//  PERTURBACIÓN DE CADA EVENTO EN t
//  Bache   → gaussiana: d · exp(-(t-t0)²/(2σ²))
//  Ciudad  → rampa descendente suave
//  Semáforo→ rampa bajada + subida (vuelta)
//  Curva   → medio seno (entrada y salida)
//  Turbo   → rampa de subida + bajada (pulso positivo)
// ══════════════════════════════════════════════════════════
function eventoEn(ev, t) {
  const { tipo, t0, d, dur } = ev;
  const t1 = t0 + dur;

  if (tipo === 'gaussiana') {
    // Solo actúa en el intervalo [t0-dur, t0+dur]
    const sigma = dur / 2.5;
    return d * Math.exp(-Math.pow(t - t0, 2) / (2 * sigma * sigma));
  }

  if (tipo === 'rampa') {
    // Rampa de entrada suave → meseta → rampa de salida
    if (t < t0 || t > t1) return 0;
    const p = (t - t0) / dur; // 0..1
    // Seno de media onda para suavizar bordes
    return d * Math.sin(p * Math.PI);
  }

  if (tipo === 'seno') {
    // Seno completo dentro del intervalo
    if (t < t0 || t > t1) return 0;
    const p = (t - t0) / dur;
    return d * Math.pow(Math.sin(p * Math.PI), 2);
  }

  if (tipo === 'boost') {
    if (t < t0 || t > t1) return 0;
    const p = (t - t0) / dur;
    return d * Math.sin(p * Math.PI); // pulso positivo
  }

  return 0;
}

// ══════════════════════════════════════════════════════════
//  FUNCIÓN TOTAL DE ACELERACIÓN
// ══════════════════════════════════════════════════════════
let _eventos = [];

function aTotal(t) {
  const base = _a0 + _a1 * t + _a2 * t * t;
  let suma = 0;
  _eventos.forEach(ev => { suma += eventoEn(ev, t); });
  return base + suma;
}

// ══════════════════════════════════════════════════════════
//  CONSUMO CURVA-U
// ══════════════════════════════════════════════════════════
const V_OPT = 60 / 3.6;  // ~16.7 m/s
const ALFA  = 2.5;

function consumoInst(v, cBase) {
  const fv = cBase * (1 + ALFA * Math.pow((Math.abs(v) - V_OPT) / V_OPT, 2));
  return Math.max(fv * Math.abs(v) / 100000, 0);
}

// ══════════════════════════════════════════════════════════
//  PREVIEW FÓRMULA
// ══════════════════════════════════════════════════════════
function actualizarPreview() {
  const v0v = parseFloat(document.getElementById('v0').value) || 0;
  const av  = parseFloat(document.getElementById('a0').value) || 0;
  const Tv  = parseFloat(document.getElementById('t').value)  || 15;

  // MRUV: v(t) = v0 + a·t,   x(t) = v0·t + ½·a·t²
  const s = av >= 0 ? '+' : '−';
  const aAbs = Math.abs(av);
  const vFinal = (v0v + av * Tv).toFixed(2);
  const xFinal = (v0v * Tv + 0.5 * av * Tv * Tv).toFixed(2);

  document.getElementById('formulaPreview').innerHTML =
    `a = ${av} m/s² &nbsp;|&nbsp; v(t) = ${v0v} ${s} ${aAbs}t<br>` +
    `x(t) = ${v0v}t ${s} ½·${aAbs}t² &nbsp;→&nbsp; v(${Tv}s) = ${vFinal} m/s, x = ${xFinal} m`;
}

// ══════════════════════════════════════════════════════════
//  INICIO / CONTROLES
// ══════════════════════════════════════════════════════════
function iniciar() {
  document.getElementById('inicio').style.display = 'none';
  document.getElementById('simulador').classList.add('visible');
  ajustarCanvas();
  generarMundo();
  dibujarEscena();
  actualizarPreview();

  // Zoom con rueda del mouse en la gráfica integral
  const grafCanvas = document.getElementById('grafIntegral');
  grafCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    zoomIntegral(factor);
  }, { passive: false });
}

function ajustarCanvas() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; }
window.addEventListener('resize', () => { ajustarCanvas(); generarMundo(); });

function simular() {
  cancelAnimationFrame(animID);
  pausado = false;
  document.getElementById('btnPausa').textContent = '⏸ PAUSA';

  _v0 = parseFloat(document.getElementById('v0').value) || 0;
  _a0 = parseFloat(document.getElementById('a0').value) || 0;
  _a1 = 0;
  _a2 = 0;
  _T  = parseFloat(document.getElementById('t').value)  || 15;
  _eventos = leerEventos();

  tiempo = 0; motoX = 80; scrollOff = 0; ultimoTS = 0;
  hT = []; hV = []; hX = []; hGas = []; hA = [];

  document.getElementById('hud').style.display = 'flex';
  document.getElementById('resultado').innerHTML = '';
  animID = requestAnimationFrame(animar);
}

function pausar() {
  pausado = !pausado;
  document.getElementById('btnPausa').textContent = pausado ? '▶ REANUDAR' : '⏸ PAUSA';
}

function resetear() {
  cancelAnimationFrame(animID);
  tiempo = 0; motoX = 80; scrollOff = 0;
  hT = []; hV = []; hX = []; hGas = []; hA = [];
  document.getElementById('hud').style.display = 'none';
  document.getElementById('resultado').innerHTML = '';
  document.getElementById('btnPausa').textContent = '⏸ PAUSA';
  ocultarNotif();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  dibujarEscena();
  actualizarGraficas();
}

// ══════════════════════════════════════════════════════════
//  NOTIFICACIONES DE EVENTOS
// ══════════════════════════════════════════════════════════
const NOTIF_LABELS = {
  bache:    { texto: '💥 BACHE — golpe en la suspensión',   color: '#ff2d55' },
  ciudad:   { texto: '🏙️ ZONA URBANA — reduciendo velocidad', color: '#ffc400' },
  semaforo: { texto: '🚦 SEMÁFORO EN ROJO — frenando',       color: '#39ff14' },
  curva:    { texto: '🔄 CURVA PRONUNCIADA — tomando curva', color: '#c800ff' },
  turbo:    { texto: '🚀 RECTA LIBRE — ¡turbo H2!',         color: '#ff7a00' },
};

function mostrarNotif(id) {
  const n = NOTIF_LABELS[id];
  if (!n) return;
  const el = document.getElementById('eventoNotif');
  el.textContent = n.texto;
  el.style.color = n.color;
  el.style.borderColor = n.color;
  el.classList.add('visible');
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

function ocultarNotif() {
  document.getElementById('eventoNotif').classList.remove('visible');
}

// ══════════════════════════════════════════════════════════
//  LOOP DE ANIMACIÓN
// ══════════════════════════════════════════════════════════
let _eventosNotificados = new Set();

function animar(ts) {
  if (pausado) { animID = requestAnimationFrame(animar); return; }
  if (!ultimoTS) ultimoTS = ts;
  const delta = Math.min((ts - ultimoTS) / 1000, 0.05);
  ultimoTS = ts;
  tiempo += delta;
  if (tiempo >= _T) { tiempo = _T; registrarFrame(delta); actualizarGraficas(); return; }
  registrarFrame(delta);
  actualizarGraficas();
  animID = requestAnimationFrame(animar);
}

function registrarFrame(delta) {
  const acel = aTotal(tiempo);
  const velPrev = hV.length ? hV[hV.length-1] : _v0;
  const vel  = Math.max(velPrev + acel * delta, 0);
  const dist = (hX.length ? hX[hX.length-1] : 0) + vel * delta;

  const cBase   = parseFloat(document.getElementById('consumo').value) || 4.5;
  const gasAcum = (hGas.length ? hGas[hGas.length-1] : 0) + consumoInst(vel, cBase) * delta;

  hT.push(tiempo); hV.push(vel); hX.push(dist); hGas.push(gasAcum); hA.push(acel);

  // Notificaciones de eventos
  _eventos.forEach(ev => {
    const key = ev.id;
    const activo = tiempo >= ev.t0 && tiempo <= ev.t0 + ev.dur;
    if (activo && !_eventosNotificados.has(key)) {
      _eventosNotificados.add(key);
      mostrarNotif(key);
    }
    if (!activo && tiempo > ev.t0 + ev.dur) {
      _eventosNotificados.delete(key);
    }
  });

  // Scroll y moto
  scrollOff += vel * delta * 12;
  if (motoX < canvas.width * 0.36) motoX += vel * delta * 12;

  // Dibujo
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  dibujarEscena(vel);
  dibujarMoto(vel, acel);

  // HUD
  document.getElementById('hudVel').textContent    = vel.toFixed(2)  + ' m/s';
  document.getElementById('hudDist').textContent   = dist.toFixed(2) + ' m';
  document.getElementById('hudTiempo').textContent = tiempo.toFixed(2)+ ' s';
  document.getElementById('hudAcel').textContent   = acel.toFixed(2) + ' m/s²';

  const precio = parseFloat(document.getElementById('precio').value) || 1.5;
  document.getElementById('resultado').innerHTML =
    `<span style="color:var(--text-dim)">t:</span>        <span class="val">${tiempo.toFixed(2)} s</span><br>
     <span style="color:var(--text-dim)">v(t):</span>     <span class="val">${vel.toFixed(2)} m/s</span><br>
     <span style="color:var(--text-dim)">a(t):</span>     <span class="val">${acel.toFixed(2)} m/s²</span><br>
     <span style="color:var(--text-dim)">x(t):</span>     <span class="val">${dist.toFixed(2)} m</span><br>
     <span style="color:var(--text-dim)">Gas:</span>      <span class="val-o">${gasAcum.toFixed(4)} L</span><br>
     <span style="color:var(--text-dim)">Costo:</span>    <span class="val-y">S/.${(gasAcum*precio).toFixed(3)}</span>`;
}

// ══════════════════════════════════════════════════════════
//  MUNDO
// ══════════════════════════════════════════════════════════
function generarMundo() {
  const W = canvas.width, H = canvas.height;
  estrellas = Array.from({length:90}, () => ({ x:Math.random()*W, y:Math.random()*H*0.5, r:Math.random()*1.4+0.2, b:Math.random() }));
  edificios = [];
  let ex = 0;
  while (ex < W * 2.8) {
    const w = 25+Math.random()*60, h = 50+Math.random()*160;
    edificios.push({ x:ex, w, h, vent:Math.floor(Math.random()*7)+2, lit:Math.random()>0.25 });
    ex += w + Math.random()*6;
  }
}

// Detectar qué evento está activo para pintar el cielo y la calle
function eventoActivoAhora() {
  for (const ev of _eventos) {
    if (tiempo >= ev.t0 && tiempo <= ev.t0 + ev.dur) return ev.id;
  }
  return null;
}

function dibujarEscena(vel = 0) {
  const W = canvas.width, H = canvas.height;
  const hor = H * 0.54;
  const evActivo = eventoActivoAhora();

  // Cielo — tono cambia con evento
  let skyTop = '#010610', skyBot = '#031530';
  if (evActivo === 'ciudad' || evActivo === 'semaforo') { skyTop = '#100a02'; skyBot = '#1a0e04'; }
  if (evActivo === 'turbo')  { skyTop = '#010a16'; skyBot = '#011a2a'; }

  const sky = ctx.createLinearGradient(0,0,0,hor);
  sky.addColorStop(0, skyTop); sky.addColorStop(1, skyBot);
  ctx.fillStyle = sky; ctx.fillRect(0,0,W,hor);

  // Estrellas
  const now = Date.now();
  estrellas.forEach(s => {
    const f = 0.5 + 0.5*Math.sin(now*0.0008*s.b + s.x*0.01);
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
    ctx.fillStyle = `rgba(200,230,255,${f*0.8})`; ctx.fill();
  });

  // Edificios
  const base = hor - 3;
  edificios.forEach(b => {
    const bx = ((b.x - scrollOff*0.1) % (W*2.8+300) + W*2.8+300) % (W*2.8+300) - 200;
    if (bx > W+200 || bx+b.w < -200) return;
    ctx.fillStyle = 'rgba(3,8,25,0.93)';
    ctx.fillRect(bx, base-b.h, b.w, b.h);
    ctx.strokeStyle = 'rgba(0,60,150,0.3)'; ctx.lineWidth=0.5;
    ctx.strokeRect(bx, base-b.h, b.w, b.h);
    for (let r=0;r<b.vent;r++) for (let c=0;c<3;c++) {
      const on = b.lit && Math.random()>0.35;
      ctx.fillStyle = on ? 'rgba(255,235,90,0.6)' : 'rgba(0,15,50,0.5)';
      ctx.fillRect(bx+4+c*((b.w-8)/3)+1, base-b.h+7+r*18, 5, 8);
    }
  });

  // Carretera
  let roadColor1 = '#051030', roadColor2 = '#020a1e';
  if (evActivo === 'bache') { roadColor1 = '#120805'; roadColor2 = '#0a0503'; }
  const road = ctx.createLinearGradient(0,hor,0,H);
  road.addColorStop(0, roadColor1); road.addColorStop(1, roadColor2);
  ctx.fillStyle = road; ctx.fillRect(0,hor,W,H-hor);

  // Marcas de carretera
  let dashColor = 'rgba(0,234,255,0.4)';
  if (evActivo === 'ciudad' || evActivo === 'semaforo') dashColor = 'rgba(255,196,0,0.35)';
  ctx.strokeStyle = dashColor; ctx.lineWidth = 2;
  ctx.setLineDash([46,30]); ctx.lineDashOffset = -(scrollOff % 76);
  ctx.beginPath(); ctx.moveTo(0, hor+(H-hor)*0.32); ctx.lineTo(W, hor+(H-hor)*0.32); ctx.stroke();
  ctx.setLineDash([]); ctx.lineDashOffset = 0;

  // Línea horizonte
  ctx.strokeStyle = 'rgba(0,234,255,0.1)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0,hor); ctx.lineTo(W,hor); ctx.stroke();

  // Baches: dibujar marcas en la carretera
  _eventos.filter(e=>e.id==='bache').forEach(ev => {
    const bacheT = ev.t0;
    const bacheX = P2X_carretera(bacheT);
    if (bacheX > 0 && bacheX < W) {
      ctx.fillStyle = 'rgba(80,40,10,0.7)';
      ctx.beginPath(); ctx.ellipse(bacheX, hor+(H-hor)*0.32-4, 18, 7, 0, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle='rgba(60,30,5,0.9)'; ctx.lineWidth=1.5; ctx.stroke();
    }
  });

  // Semáforo: dibujar un poste
  _eventos.filter(e=>e.id==='semaforo').forEach(ev => {
    const sx = P2X_carretera(ev.t0);
    if (sx > 20 && sx < W - 20) {
      // Poste
      ctx.fillStyle = '#333'; ctx.fillRect(sx-3, hor-60, 6, 60);
      // Caja
      ctx.fillStyle = '#222'; ctx.fillRect(sx-10, hor-90, 20, 35);
      // Luz (verde, amarillo, rojo según si estamos en el evento)
      const encendido = tiempo >= ev.t0 && tiempo <= ev.t0 + ev.dur;
      ctx.beginPath(); ctx.arc(sx, hor-80, 5, 0, Math.PI*2);
      ctx.fillStyle = encendido ? '#ff2d55' : '#550010'; ctx.fill();
      if (encendido) { ctx.shadowColor='#ff2d55'; ctx.shadowBlur=12; ctx.fill(); ctx.shadowBlur=0; }
      ctx.beginPath(); ctx.arc(sx, hor-68, 5, 0, Math.PI*2);
      ctx.fillStyle = !encendido ? '#39ff14' : '#0a3303'; ctx.fill();
    }
  });

  // Farolas
  const postGap=200, pOff=scrollOff%postGap;
  for (let i=-1; i<Math.ceil(W/postGap)+2; i++) {
    const px = i*postGap - pOff;
    ctx.strokeStyle='rgba(40,80,160,0.5)'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(px,H); ctx.lineTo(px,hor+10); ctx.stroke();
    ctx.beginPath(); ctx.arc(px,hor+10,3,0,Math.PI*2);
    const lColor = (evActivo==='ciudad'||evActivo==='semaforo') ? '#ffb800' : '#ffe88a';
    ctx.fillStyle=lColor; ctx.shadowColor=lColor; ctx.shadowBlur=12; ctx.fill(); ctx.shadowBlur=0;
  }
}

// Convierte tiempo de evento a posición X en canvas (aproximado por scroll)
function P2X_carretera(tEvento) {
  const distEvento = _v0 * tEvento + 0.5 * _a0 * tEvento * tEvento;
  const distActual = hX.length ? hX[hX.length-1] : 0;
  const delta = distEvento - distActual;
  return motoX + delta * 12;
}

// ══════════════════════════════════════════════════════════
//  DIBUJAR MOTO (Kawasaki H2 — orientada a la derecha)
// ══════════════════════════════════════════════════════════
function dibujarMoto(vel = 0, acel = 0) {
  const H = canvas.height;
  const hor = H * 0.54;
  const mW = 110, mH = 72;
  const mY = hor + 4;

  // Oscilación leve si hay bache activo
  const evA = eventoActivoAhora();
  let osc = 0;
  if (evA === 'bache') osc = (Math.random()-0.5) * 4;
  else if (vel > 0.5)  osc = Math.sin(Date.now()*0.015) * 0.8;

  // Inclinación según aceleración
  const inclinacion = Math.max(-0.06, Math.min(0.06, -acel * 0.009));

  ctx.save();
  ctx.translate(motoX + mW/2, mY + mH/2);
  ctx.rotate(inclinacion);
  ctx.translate(-mW/2, -mH/2 + osc);

  if (motoImg.complete && motoImg.naturalWidth > 0) {
    ctx.drawImage(motoImg, 0, 0, mW, mH);
  }

  ctx.restore();

  // Faro
  const fX = motoX + mW - 3, fY = mY + mH * 0.35 + osc;
  const intFaro = Math.min(0.28, 0.08 + vel / 70);
  const haz = ctx.createRadialGradient(fX, fY, 0, fX + 80, fY, 160);
  haz.addColorStop(0, `rgba(255,255,200,${intFaro})`);
  haz.addColorStop(0.5, `rgba(255,255,150,${intFaro*0.3})`);
  haz.addColorStop(1, 'transparent');
  ctx.fillStyle = haz;
  ctx.beginPath(); ctx.moveTo(fX, fY-12); ctx.lineTo(fX+170, fY-42); ctx.lineTo(fX+170, fY+42); ctx.lineTo(fX, fY+12); ctx.closePath(); ctx.fill();

  ctx.beginPath(); ctx.arc(fX, fY, 3, 0, Math.PI*2);
  ctx.fillStyle = '#fefce0'; ctx.shadowColor = '#fefce0'; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;

  // Estela de velocidad
  if (vel > 4) {
    const streaks = Math.min(Math.floor(vel/4), 6);
    for (let i = 1; i <= streaks; i++) {
      const alpha = (1 - i/streaks) * Math.min(vel/25, 0.45);
      const ly = mY + mH * (0.55 + (i%3)*0.07);
      ctx.beginPath();
      ctx.moveTo(motoX - i*12, ly);
      ctx.lineTo(motoX - i*12 - 16, ly);
      ctx.strokeStyle = `rgba(57,255,20,${alpha})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // Partículas turbo
  if (evA === 'turbo') {
    for (let i = 0; i < 5; i++) {
      const px = motoX - 8 - Math.random()*30;
      const py = mY + mH*0.6 + (Math.random()-0.5)*10;
      ctx.beginPath(); ctx.arc(px, py, Math.random()*1.5+0.5, 0, Math.PI*2);
      ctx.fillStyle = `rgba(57,255,20,${Math.random()*0.5+0.2})`; ctx.fill();
    }
  }
}

// ══════════════════════════════════════════════════════════
//  TABS
// ══════════════════════════════════════════════════════════
let tabActivo = 'velocidad';

function cambiarTab(nombre, btn) {
  tabActivo = nombre;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + nombre).classList.add('active');
  actualizarGraficas();
}

function actualizarGraficas() {
  if (tabActivo==='velocidad')   dibujarLinea('grafVelocidad',   hT, hV, 'v(t) — Velocidad (m/s)',  '#00eaff', 'rgba(0,234,255,0.1)');
  if (tabActivo==='aceleracion') dibujarAceleracion();
  if (tabActivo==='distancia')   dibujarLinea('grafDistancia',   hT, hX, 'x(t) — Distancia (m)',    '#ff7a00', 'rgba(255,122,0,0.1)');
  if (tabActivo==='integral')    dibujarIntegral();
  if (tabActivo==='gasolina')    dibujarGasolina();
}

// ══════════════════════════════════════════════════════════
//  GRÁFICA LINEA GENÉRICA
// ══════════════════════════════════════════════════════════
function dibujarLinea(id, xs, ys, titulo, color, fill) {
  const c = document.getElementById(id), cx = c.getContext('2d');
  c.width = c.clientWidth; c.height = c.clientHeight;
  const W=c.width, H=c.height, P={t:34,r:20,b:38,l:62};
  const pW=W-P.l-P.r, pH=H-P.t-P.b;

  cx.fillStyle='rgba(2,8,20,0.95)'; cx.fillRect(0,0,W,H);
  cx.fillStyle='rgba(140,210,240,0.9)'; cx.font="bold 11px 'Orbitron',monospace";
  cx.fillText(titulo, P.l, 22);

  if (xs.length < 2) { emptyMsg(cx, P.l+pW/2-80, P.t+pH/2); return; }

  const tMax  = _T;
  const minY  = Math.min(...ys), maxY = Math.max(...ys);
  const rng   = maxY - minY || 1, pad = rng * 0.14;

  const tx = t => P.l+(t/tMax)*pW;
  const ty = v => P.t+pH - ((v-(minY-pad))/(rng+2*pad))*pH;

  drawGrid(cx,P,pW,pH,tMax,minY-pad,maxY+pad);

  // Bandas de eventos
  dibujarBandasEventos(cx, P, pW, pH, tx, minY-pad, maxY+pad);

  // Línea de v=0
  if (minY-pad < 0 && maxY+pad > 0) {
    cx.strokeStyle='rgba(255,255,255,0.12)'; cx.lineWidth=1; cx.setLineDash([4,4]);
    cx.beginPath(); cx.moveTo(P.l, ty(0)); cx.lineTo(P.l+pW, ty(0)); cx.stroke(); cx.setLineDash([]);
  }

  // Relleno
  cx.beginPath(); cx.moveTo(tx(xs[0]), ty(Math.max(minY-pad,0)));
  xs.forEach((t,i) => cx.lineTo(tx(t), ty(ys[i])));
  cx.lineTo(tx(xs[xs.length-1]), ty(Math.max(minY-pad,0)));
  cx.closePath(); cx.fillStyle = fill; cx.fill();

  // Línea
  cx.beginPath(); xs.forEach((t,i) => i ? cx.lineTo(tx(t),ty(ys[i])) : cx.moveTo(tx(t),ty(ys[i])));
  cx.strokeStyle=color; cx.lineWidth=2.5; cx.shadowColor=color; cx.shadowBlur=12; cx.stroke(); cx.shadowBlur=0;

  // Punto actual
  if (xs.length) {
    const lx=tx(xs[xs.length-1]), ly=ty(ys[ys.length-1]);
    cx.beginPath(); cx.arc(lx,ly,5,0,Math.PI*2);
    cx.fillStyle=color; cx.shadowColor=color; cx.shadowBlur=16; cx.fill(); cx.shadowBlur=0;
  }

  ejes(cx,P,pW,pH);
}

// ══════════════════════════════════════════════════════════
//  GRÁFICA ACELERACIÓN
// ══════════════════════════════════════════════════════════
function dibujarAceleracion() {
  const c=document.getElementById('grafAceleracion'), cx=c.getContext('2d');
  c.width=c.clientWidth; c.height=c.clientHeight;
  const W=c.width, H=c.height, P={t:34,r:20,b:38,l:62};
  const pW=W-P.l-P.r, pH=H-P.t-P.b;

  cx.fillStyle='rgba(2,8,20,0.95)'; cx.fillRect(0,0,W,H);
  cx.fillStyle='rgba(200,0,255,0.85)'; cx.font="bold 11px 'Orbitron',monospace";
  cx.fillText('a(t) — Aceleración MRUV + eventos (m/s²)', P.l, 22);

  const n=400, tArr=[], aArr=[];
  for (let i=0;i<=n;i++) { const t=_T*i/n; tArr.push(t); aArr.push(aTotal(t)); }

  const minA=Math.min(...aArr), maxA=Math.max(...aArr);
  const rng=maxA-minA||1, pad=rng*0.15;

  const tx=t=>P.l+(t/_T)*pW;
  const ty=a=>P.t+pH-((a-(minA-pad))/(rng+2*pad))*pH;

  drawGrid(cx,P,pW,pH,_T,minA-pad,maxA+pad);
  dibujarBandasEventos(cx, P, pW, pH, tx, minA-pad, maxA+pad);

  // Línea cero
  if (minA-pad<0 && maxA+pad>0) {
    cx.strokeStyle='rgba(255,255,255,0.15)'; cx.lineWidth=1; cx.setLineDash([4,4]);
    cx.beginPath(); cx.moveTo(P.l,ty(0)); cx.lineTo(P.l+pW,ty(0)); cx.stroke(); cx.setLineDash([]);
  }

  // Relleno por encima/debajo de cero
  tArr.forEach((t,i) => {
    if (!i) return;
    const x1=tx(tArr[i-1]), x2=tx(t), a1=aArr[i-1], a2=aArr[i];
    const avg=(a1+a2)/2;
    cx.fillStyle = avg>0 ? 'rgba(0,234,255,0.1)' : 'rgba(255,45,85,0.12)';
    const yTop=Math.min(ty(a1),ty(a2)), yZero=ty(0);
    if (avg>0) cx.fillRect(x1, yTop, x2-x1, yZero-yTop);
    else cx.fillRect(x1, yZero, x2-x1, Math.max(ty(a1),ty(a2))-yZero);
  });

  // Curva a(t) total
  cx.beginPath();
  tArr.forEach((t,i)=>i?cx.lineTo(tx(t),ty(aArr[i])):cx.moveTo(tx(t),ty(aArr[i])));
  cx.strokeStyle='rgba(200,0,255,0.95)'; cx.lineWidth=2.5; cx.shadowColor='#c800ff'; cx.shadowBlur=12; cx.stroke(); cx.shadowBlur=0;

  // Punto en t actual
  if (hT.length) {
    const ct=hT[hT.length-1], ca=hA[hA.length-1];
    cx.beginPath(); cx.arc(tx(ct),ty(ca),5,0,Math.PI*2);
    cx.fillStyle='#c800ff'; cx.shadowColor='#c800ff'; cx.shadowBlur=14; cx.fill(); cx.shadowBlur=0;
  }

  ejes(cx,P,pW,pH);
}

// ══════════════════════════════════════════════════════════
//  BANDAS DE EVENTOS EN GRÁFICAS
// ══════════════════════════════════════════════════════════
const EV_COLORS = {
  bache:    'rgba(255,45,85,0.12)',
  ciudad:   'rgba(255,196,0,0.1)',
  semaforo: 'rgba(57,255,20,0.1)',
  curva:    'rgba(200,0,255,0.1)',
  turbo:    'rgba(255,122,0,0.12)',
};

function dibujarBandasEventos(cx, P, pW, pH, tx, minY, maxY) {
  _eventos.forEach(ev => {
    const x0 = tx(ev.t0);
    const x1 = tx(Math.min(ev.t0 + ev.dur, _T));
    cx.fillStyle = EV_COLORS[ev.id] || 'rgba(255,255,255,0.05)';
    cx.fillRect(x0, P.t, x1-x0, pH);
    // Etiqueta del evento
    cx.fillStyle = 'rgba(200,200,255,0.35)';
    cx.font = "7px 'Orbitron',monospace";
    cx.save(); cx.translate(x0+4, P.t+pH-4); cx.rotate(-Math.PI/2);
    cx.fillText(ev.id.toUpperCase(), 0, 0); cx.restore();
  });
}

// ══════════════════════════════════════════════════════════
//  GRÁFICA INTEGRAL — COMPARACIÓN (con selector + zoom)
// ══════════════════════════════════════════════════════════
function dibujarIntegral() {
  const c = document.getElementById('grafIntegral'), cx = c.getContext('2d');
  c.width  = c.clientWidth;
  c.height = c.clientHeight;
  const W = c.width, H = c.height;
  const P = { t: 44, r: 30, b: 48, l: 70 };
  const pW = W - P.l - P.r, pH = H - P.t - P.b;

  cx.fillStyle = 'rgba(2,8,20,0.97)'; cx.fillRect(0,0,W,H);

  if (!_T || _T <= 0) { emptyMsg(cx, W/2, H/2); return; }

  // ── Generar datos completos ──
  const steps = 600, dtSim = _T / steps;
  const tArr = [], vArr = [], aArr = [], xArr = [];
  let vSim = _v0, xSim = 0;
  for (let i = 0; i <= steps; i++) {
    const t = _T * i / steps;
    const a = aTotal(t);
    tArr.push(t); aArr.push(a); vArr.push(Math.max(vSim, 0)); xArr.push(Math.max(xSim, 0));
    if (i < steps) { vSim = Math.max(vSim + a * dtSim, 0); xSim = Math.max(xSim + vSim * dtSim, 0); }
  }

  // ── Seleccionar dataset según tipo ──
  let yData, lineColor, fillColor, unitLabel, integralLabel, curvaLabel;
  switch (grafIntegralTipo) {
    case 'a':
      yData = aArr; lineColor = '#c800ff'; fillColor = 'rgba(200,0,255,0.1)';
      unitLabel = 'm/s²'; integralLabel = '∫a(t)dt = Δv'; curvaLabel = 'a(t)';
      break;
    case 'x':
      yData = xArr; lineColor = '#ff7a00'; fillColor = 'rgba(255,122,0,0.1)';
      unitLabel = 'm'; integralLabel = '∫x(t)dt'; curvaLabel = 'x(t)';
      break;
    default: // 'v'
      yData = vArr; lineColor = '#00eaff'; fillColor = 'rgba(0,234,255,0.1)';
      unitLabel = 'm/s'; integralLabel = '∫v(t)dt = distancia'; curvaLabel = 'v(t)';
  }

  // ── Rango de datos con zoom ──
  const rawMin = Math.min(...yData), rawMax = Math.max(...yData);
  const rng = rawMax - rawMin || 1;
  const pad = rng * 0.12;
  const fullMinY = rawMin - pad, fullMaxY = rawMax + pad;
  const fullT = _T;

  // Aplicar zoom: centrado en el medio del eje T
  const visibleT = fullT / zoomLevel;
  const centerT  = fullT / 2;
  let tMin = centerT - visibleT / 2;
  let tMax = centerT + visibleT / 2;
  tMin = Math.max(0, tMin); tMax = Math.min(fullT, tMax);
  if (tMax - tMin < 0.1) { tMin = 0; tMax = fullT; }

  const visRng = fullMaxY - fullMinY;
  const visMinY = fullMinY, visMaxY = fullMaxY;

  // ── Funciones de proyección ──
  const tx = t => P.l + ((t - tMin) / (tMax - tMin)) * pW;
  const ty = v => P.t + pH - ((v - visMinY) / (visMaxY - visMinY)) * pH;

  // ── TÍTULO ──
  cx.fillStyle = lineColor; cx.font = "bold 11px 'Orbitron',monospace";
  cx.fillText(`∫ Método sobre ${curvaLabel} — ${integralLabel}`, P.l, 22);

  // ── ETIQUETAS DE EJES (prominentes) ──
  // Eje X label
  cx.fillStyle = 'rgba(255,122,0,0.9)'; cx.font = "bold 10px 'Share Tech Mono',monospace";
  cx.textAlign = 'center';
  cx.fillText('◄── Eje X: Tiempo (s) ──►', P.l + pW / 2, H - 6);

  // Eje Y label (rotado)
  cx.save();
  cx.translate(14, P.t + pH / 2);
  cx.rotate(-Math.PI / 2);
  cx.fillStyle = 'rgba(0,234,255,0.9)'; cx.font = "bold 10px 'Share Tech Mono',monospace";
  cx.textAlign = 'center';
  cx.fillText(`◄── Eje Y: ${unitLabel} ──►`, 0, 0);
  cx.restore();
  cx.textAlign = 'left';

  // ── GRID ──
  cx.strokeStyle = 'rgba(0,234,255,0.07)'; cx.lineWidth = 1;
  const nGridY = 6, nGridX = 6;
  for (let i = 0; i <= nGridY; i++) {
    const y = P.t + pH - (i / nGridY) * pH;
    cx.beginPath(); cx.moveTo(P.l, y); cx.lineTo(P.l + pW, y); cx.stroke();
    const val = (visMinY + (i / nGridY) * (visMaxY - visMinY)).toFixed(2);
    cx.fillStyle = 'rgba(180,220,255,0.9)'; cx.font = "bold 10px 'Share Tech Mono',monospace";
    cx.textAlign = 'right';
    cx.fillText(val, P.l - 6, y + 4);
  }
  for (let i = 0; i <= nGridX; i++) {
    const t = tMin + (i / nGridX) * (tMax - tMin);
    const x = tx(t);
    cx.beginPath(); cx.moveTo(x, P.t); cx.lineTo(x, P.t + pH); cx.stroke();
    cx.fillStyle = 'rgba(180,220,255,0.9)'; cx.font = "bold 10px 'Share Tech Mono',monospace";
    cx.textAlign = 'center';
    cx.fillText(t.toFixed(1) + 's', x, P.t + pH + 18);
  }
  cx.textAlign = 'left';

  // ── Línea de cero si el rango la incluye ──
  if (visMinY < 0 && visMaxY > 0) {
    cx.strokeStyle = 'rgba(255,255,255,0.25)'; cx.lineWidth = 1.5; cx.setLineDash([6, 4]);
    cx.beginPath(); cx.moveTo(P.l, ty(0)); cx.lineTo(P.l + pW, ty(0)); cx.stroke();
    cx.setLineDash([]);
    cx.fillStyle = 'rgba(255,255,255,0.4)'; cx.font = "9px 'Share Tech Mono'";
    cx.textAlign = 'right';
    cx.fillText('0', P.l - 4, ty(0) + 4);
    cx.textAlign = 'left';
  }

  // ── Bandas de eventos ──
  dibujarBandasEventos(cx, P, pW, pH, tx, visMinY, visMaxY);

  const n = parseInt(document.getElementById('nRect').value) || 14;
  const metodo = document.querySelector('input[name="metodo"]:checked').value;
  const dt = _T / n;

  // ── Rectángulos Riemann ──
  let sumaRiem = 0;
  for (let i = 0; i < n; i++) {
    const t0 = i * dt, t1 = (i + 1) * dt;
    let tEval = metodo === 'left' ? t0 : metodo === 'right' ? t1 : (t0 + t1) / 2;
    if (metodo !== 'trap') {
      const v = interp(tArr, yData, tEval);
      sumaRiem += v * dt;
      if (t1 >= tMin && t0 <= tMax) { // solo dibujar si está en el rango visible
        const rx = tx(t0), rw = tx(t1) - tx(t0);
        const ry = ty(v), ry0 = ty(Math.max(visMinY, 0));
        cx.fillStyle = 'rgba(255,122,0,0.18)'; cx.fillRect(rx, Math.min(ry, ry0), rw, Math.abs(ry - ry0));
        cx.strokeStyle = 'rgba(255,122,0,0.75)'; cx.lineWidth = 1.2; cx.strokeRect(rx, Math.min(ry, ry0), rw, Math.abs(ry - ry0));
        // Valor dentro del rectángulo si hay espacio
        if (rw > 22 && Math.abs(ry - ry0) > 14) {
          cx.fillStyle = 'rgba(255,180,80,0.9)'; cx.font = "bold 8px 'Share Tech Mono'";
          cx.textAlign = 'center';
          cx.fillText(v.toFixed(1), rx + rw / 2, Math.min(ry, ry0) + 11);
          cx.textAlign = 'left';
        }
      }
    }
  }

  // ── Trapecio ──
  let sumaTrap = 0;
  for (let i = 0; i < n; i++) {
    const t0 = i * dt, t1 = (i + 1) * dt;
    const v0t = interp(tArr, yData, t0), v1t = interp(tArr, yData, t1);
    sumaTrap += (v0t + v1t) / 2 * dt;
    if (t1 >= tMin && t0 <= tMax) {
      cx.fillStyle = 'rgba(180,0,255,0.1)';
      cx.beginPath();
      cx.moveTo(tx(t0), ty(0 > visMinY ? 0 : visMinY));
      cx.lineTo(tx(t0), ty(v0t));
      cx.lineTo(tx(t1), ty(v1t));
      cx.lineTo(tx(t1), ty(0 > visMinY ? 0 : visMinY));
      cx.closePath(); cx.fill();
      cx.strokeStyle = 'rgba(180,0,255,0.45)'; cx.lineWidth = 1; cx.stroke();
    }
  }
  if (metodo === 'trap') sumaRiem = sumaTrap;

  // ── Curva principal ──
  cx.save();
  cx.beginPath(); cx.rect(P.l, P.t, pW, pH); cx.clip(); // clip al área de gráfica
  cx.beginPath();
  let first = true;
  tArr.forEach((t, i) => {
    if (t < tMin - 0.01 || t > tMax + 0.01) return;
    if (first) { cx.moveTo(tx(t), ty(yData[i])); first = false; }
    else cx.lineTo(tx(t), ty(yData[i]));
  });
  cx.strokeStyle = lineColor; cx.lineWidth = 2.8;
  cx.shadowColor = lineColor; cx.shadowBlur = 14; cx.stroke(); cx.shadowBlur = 0;
  cx.restore();

  // ── EJES (encima de todo) ──
  cx.strokeStyle = 'rgba(0,234,255,0.5)'; cx.lineWidth = 2;
  cx.beginPath();
  cx.moveTo(P.l, P.t); cx.lineTo(P.l, P.t + pH);    // eje Y
  cx.moveTo(P.l, P.t + pH); cx.lineTo(P.l + pW, P.t + pH); // eje X
  cx.stroke();

  // Flechas en los ejes
  // Flecha Y
  cx.fillStyle = 'rgba(0,234,255,0.6)';
  cx.beginPath(); cx.moveTo(P.l, P.t - 2); cx.lineTo(P.l - 5, P.t + 10); cx.lineTo(P.l + 5, P.t + 10); cx.closePath(); cx.fill();
  // Flecha X
  cx.beginPath(); cx.moveTo(P.l + pW + 2, P.t + pH); cx.lineTo(P.l + pW - 10, P.t + pH - 5); cx.lineTo(P.l + pW - 10, P.t + pH + 5); cx.closePath(); cx.fill();

  // ── CÁLCULO EXACTO ──
  let exacto = 0;
  const stE = 2000, dtE = _T / stE;
  let vE = _v0, xE = 0;
  for (let i = 0; i < stE; i++) {
    const t = i * dtE, a = aTotal(t);
    if (grafIntegralTipo === 'v') exacto += Math.max(vE, 0) * dtE;
    else if (grafIntegralTipo === 'a') exacto += a * dtE;
    else exacto += Math.max(xE, 0) * dtE;
    vE = Math.max(vE + a * dtE, 0);
    xE = Math.max(xE + vE * dtE, 0);
  }

  const errR = Math.abs(exacto - sumaRiem), errT = Math.abs(exacto - sumaTrap);
  const u = grafIntegralTipo === 'v' ? 'm' : grafIntegralTipo === 'a' ? 'm/s' : 'm²';

  document.getElementById('integral-tabla').innerHTML =
    `<div class="tabla-row tabla-exact"><span>Exacto</span><span>${exacto.toFixed(3)} ${u}</span></div>
     <div class="tabla-row tabla-riem"><span>Riemann (n=${n})</span><span>${sumaRiem.toFixed(3)} ${u}</span></div>
     <div class="tabla-row tabla-trap"><span>Trapecio (n=${n})</span><span>${sumaTrap.toFixed(3)} ${u}</span></div>
     <div class="tabla-row tabla-err"><span>Error Riemann</span><span>${errR.toFixed(4)} ${u}</span></div>
     <div class="tabla-row tabla-err"><span>Error Trapecio</span><span>${errT.toFixed(4)} ${u}</span></div>`;
}


// ══════════════════════════════════════════════════════════
//  GRÁFICA GASOLINA
// ══════════════════════════════════════════════════════════
function dibujarGasolina() {
  const cU=document.getElementById('grafCurvaU'), cUx=cU.getContext('2d');
  cU.width=cU.clientWidth; cU.height=cU.clientHeight;
  dibujarCurvaU(cUx, cU.width, cU.height);

  const c=document.getElementById('grafGasolina'), cx=c.getContext('2d');
  c.width=c.clientWidth; c.height=c.clientHeight;
  const W=c.width,H=c.height,P={t:34,r:20,b:38,l:72};
  const pW=W-P.l-P.r, pH=H-P.t-P.b;

  cx.fillStyle='rgba(2,8,20,0.95)'; cx.fillRect(0,0,W,H);
  cx.fillStyle='rgba(255,196,0,0.9)'; cx.font="bold 11px 'Orbitron',monospace";
  cx.fillText('⛽ Consumo acumulado de gasolina (L)', P.l, 22);

  if (hT.length<2) { emptyMsg(cx,P.l+20,P.t+pH/2); return; }

  const maxG=Math.max(...hGas)*1.2||0.001;
  const tx=t=>P.l+(t/_T)*pW;
  const ty=g=>P.t+pH-(g/maxG)*pH;

  drawGrid(cx,P,pW,pH,_T,0,maxG);
  dibujarBandasEventos(cx, P, pW, pH, tx, 0, maxG);

  cx.beginPath(); cx.moveTo(tx(hT[0]),ty(0));
  hT.forEach((t,i)=>cx.lineTo(tx(t),ty(hGas[i])));
  cx.lineTo(tx(hT[hT.length-1]),ty(0)); cx.closePath();
  cx.fillStyle='rgba(255,196,0,0.1)'; cx.fill();

  cx.beginPath(); hT.forEach((t,i)=>i?cx.lineTo(tx(t),ty(hGas[i])):cx.moveTo(tx(t),ty(hGas[i])));
  cx.strokeStyle='rgba(255,196,0,0.95)'; cx.lineWidth=2.5; cx.shadowColor='#ffc400'; cx.shadowBlur=12; cx.stroke(); cx.shadowBlur=0;

  ejes(cx,P,pW,pH);

  const precio=parseFloat(document.getElementById('precio').value)||1.5;
  const totL=hGas.length?hGas[hGas.length-1]:0;
  document.getElementById('gasolina-resultado').innerHTML=
    `<div class="gas-row" style="background:rgba(255,196,0,0.1);color:#ffc400">Total: ${totL.toFixed(5)} L</div>
     <div class="gas-row" style="background:rgba(255,122,0,0.1);color:#ff7a00">Costo: S/.${(totL*precio).toFixed(4)}</div>
     <div class="gas-row" style="background:rgba(0,234,255,0.07);color:var(--text-dim)">v_opt: ${(V_OPT*3.6).toFixed(0)} km/h</div>`;
}

function dibujarCurvaU(cx, W, H) {
  const cBase=parseFloat(document.getElementById('consumo').value)||4.5;
  cx.fillStyle='rgba(2,8,20,0.9)'; cx.fillRect(0,0,W,H);
  cx.fillStyle='rgba(255,196,0,0.5)'; cx.font="7px 'Orbitron',monospace";
  cx.fillText('Consumo L/100km vs velocidad', 6,10);

  const vMax=50, pts=120;
  const vals=Array.from({length:pts+1},(_,i)=>{const v=vMax*i/pts; return cBase*(1+ALFA*Math.pow((v-V_OPT)/V_OPT,2));});
  const mx=Math.max(...vals);
  const px=v=>(v/vMax)*W, py=f=>H-6-(f/mx)*(H-14);

  // Relleno
  cx.beginPath(); cx.moveTo(px(0),H-6);
  for(let i=0;i<=pts;i++){const v=vMax*i/pts;i?cx.lineTo(px(v),py(vals[i])):cx.moveTo(px(v),py(vals[i]));}
  cx.lineTo(px(vMax),H-6); cx.closePath();
  cx.fillStyle='rgba(255,196,0,0.07)'; cx.fill();

  cx.beginPath();
  for(let i=0;i<=pts;i++){const v=vMax*i/pts;i?cx.lineTo(px(v),py(vals[i])):cx.moveTo(px(v),py(vals[i]));}
  cx.strokeStyle='rgba(255,196,0,0.8)'; cx.lineWidth=1.5; cx.shadowColor='#ffc400'; cx.shadowBlur=5; cx.stroke(); cx.shadowBlur=0;

  if(V_OPT<=vMax){
    cx.strokeStyle='rgba(0,234,255,0.4)'; cx.lineWidth=1; cx.setLineDash([3,3]);
    cx.beginPath(); cx.moveTo(px(V_OPT),H); cx.lineTo(px(V_OPT),0); cx.stroke(); cx.setLineDash([]);
    cx.fillStyle='rgba(0,234,255,0.6)'; cx.font="7px 'Share Tech Mono',monospace";
    cx.fillText(`${(V_OPT*3.6).toFixed(0)}km/h`,px(V_OPT)+2,18);
  }
}

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════
function drawGrid(cx,P,pW,pH,tMax,minV,maxV) {
  cx.strokeStyle='rgba(0,234,255,0.08)'; cx.lineWidth=1;
  for(let i=0;i<=5;i++){
    const y=P.t+pH-(i/5)*pH;
    cx.beginPath(); cx.moveTo(P.l,y); cx.lineTo(P.l+pW,y); cx.stroke();
    const val = (minV+(i/5)*(maxV-minV)).toFixed(1);
    cx.fillStyle='rgba(160,210,240,0.85)'; cx.font="bold 10px 'Share Tech Mono',monospace";
    cx.textAlign='right';
    cx.fillText(val, P.l-6, y+4);
    cx.textAlign='left';
  }
  for(let i=0;i<=5;i++){
    const x=P.l+(i/5)*pW;
    cx.beginPath(); cx.moveTo(x,P.t); cx.lineTo(x,P.t+pH); cx.stroke();
    cx.fillStyle='rgba(160,210,240,0.85)'; cx.font="bold 10px 'Share Tech Mono',monospace";
    cx.textAlign='center';
    cx.fillText(((i/5)*tMax).toFixed(1)+'s', x, P.t+pH+16);
    cx.textAlign='left';
  }
}

function ejes(cx,P,pW,pH){
  cx.strokeStyle='rgba(0,234,255,0.4)'; cx.lineWidth=1.5;
  cx.beginPath(); cx.moveTo(P.l,P.t); cx.lineTo(P.l,P.t+pH); cx.lineTo(P.l+pW,P.t+pH); cx.stroke();
}

function emptyMsg(cx,x,y){
  cx.fillStyle='rgba(140,190,230,0.5)'; cx.font="12px Rajdhani,sans-serif";
  cx.textAlign='center';
  cx.fillText('Presiona SIMULAR para ver la gráfica', x, y);
  cx.textAlign='left';
}

function interp(xs,ys,t){
  if(!xs.length) return _v0;
  if(t<=xs[0]) return ys[0];
  if(t>=xs[xs.length-1]) return ys[ys.length-1];
  let lo=0,hi=xs.length-1;
  while(hi-lo>1){const m=(lo+hi)>>1; xs[m]<=t?lo=m:hi=m;}
  const a=(t-xs[lo])/(xs[hi]-xs[lo]);
  return ys[lo]*(1-a)+ys[hi]*a;
}

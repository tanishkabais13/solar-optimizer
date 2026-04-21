/* ═══════════════════════════════════════════════════════════
   Solar Utilization Optimizer — dashboard.js
   Vishwakarma Institute of Technology

   TWO MODES:
   1. DEMO MODE  — Simulated data, works without hardware
   2. LIVE MODE  — Web Serial API (Chrome / Edge only)
                   Arduino sends: "V:6.23,B:3.85,I:0.112,R:1"
                   every 2 seconds via USB Serial at 9600 baud

   Arduino UNO Pin Mapping:
   ┌──────────┬──────────────────────────────────────┐
   │ A0       │ Voltage sensor module (battery volts) │
   │ A1       │ ACS712 current sensor (optional)      │
   │ A4 (SDA) │ LCD I2C data                          │
   │ A5 (SCL) │ LCD I2C clock                         │
   │ D8       │ Relay IN control signal               │
   └──────────┴──────────────────────────────────────┘
═══════════════════════════════════════════════════════════ */

'use strict';

/* ── Constants ──────────────────────────────────────── */
const MAX_PTS  = 45;     // max chart data points
const RATE_KWH = 0.008;  // ₹8 per kWh = 0.008 per Wh

/* ── State variables ────────────────────────────────── */
let demoMode   = true;
let simV       = 3.6;
let simDir     = 1;
let rdCnt      = 0;
let rPrev      = 0;
let eWh        = 0;   // energy produced (Wh)
let cWh        = 0;   // energy consumed (Wh)
let lastT      = Date.now();
const evts     = [];  // relay event log

/* Web Serial API state */
let serialPort   = null;
let serialReader = null;
let serialActive = false;

/* Chart data arrays */
const lblArr  = [];
const prodArr = [];
const consArr = [];
const batArr  = [];

/* ── Chart.js defaults ──────────────────────────────── */
Chart.defaults.color       = '#8ba0c8';
Chart.defaults.borderColor = '#1e2d4a';
Chart.defaults.font.size   = 9;
Chart.defaults.font.family = "'Inter', sans-serif";

/* ── Create energy balance chart ────────────────────── */
const energyChart = new Chart(document.getElementById('eCh'), {
  type: 'line',
  data: {
    labels: lblArr,
    datasets: [
      {
        label: 'Produced',
        data: prodArr,
        borderColor: '#00e676',
        backgroundColor: '#00e67610',
        borderWidth: 1.8,
        pointRadius: 0,
        fill: true,
        tension: 0.45
      },
      {
        label: 'Consumed',
        data: consArr,
        borderColor: '#ffab40',
        backgroundColor: '#ffab4010',
        borderWidth: 1.8,
        pointRadius: 0,
        fill: true,
        tension: 0.45
      },
      {
        label: 'Battery %',
        data: batArr,
        borderColor: '#40c4ff',
        backgroundColor: 'transparent',
        borderWidth: 1.2,
        pointRadius: 0,
        fill: false,
        tension: 0.45,
        yAxisID: 'y2'
      }
    ]
  },
  options: {
    animation: false,
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0d1424',
        borderColor: '#1e2d4a',
        borderWidth: 1,
        titleColor: '#e8f0ff',
        bodyColor: '#8ba0c8',
        padding: 8,
        cornerRadius: 7
      }
    },
    scales: {
      x:  { display: false },
      y:  {
        min: 0,
        grid: { color: '#0d1a2e' },
        ticks: { font: { size: 8 } }
      },
      y2: {
        position: 'right',
        min: 0,
        max: 100,
        grid: { display: false },
        ticks: { font: { size: 8 } }
      }
    }
  }
});

/* ── Draw ESG semicircle gauge ──────────────────────── */
function drawESG(score) {
  const canvas = document.getElementById('esgC');
  const ctx    = canvas.getContext('2d');
  const cx = 110, cy = 76, r = 60;

  ctx.clearRect(0, 0, 220, 80);

  /* Background track */
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.strokeStyle = '#1e2d4a';
  ctx.lineWidth   = 13;
  ctx.lineCap     = 'round';
  ctx.stroke();

  /* Coloured score arc */
  const angle = Math.PI + (score / 100) * Math.PI;
  const grad  = ctx.createLinearGradient(20, 76, 200, 76);
  grad.addColorStop(0,   '#ff5252');
  grad.addColorStop(0.5, '#ffd740');
  grad.addColorStop(1,   '#00e676');

  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, angle);
  ctx.strokeStyle = grad;
  ctx.lineWidth   = 13;
  ctx.stroke();

  /* Needle */
  const na = Math.PI + (score / 100) * Math.PI;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(na) * 44, cy + Math.sin(na) * 44);
  ctx.strokeStyle = '#e8f0ff';
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  /* Centre dot */
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#e8f0ff';
  ctx.fill();
}

drawESG(0);

/* ── Build solar panel cell grid ────────────────────── */
const sArt = document.getElementById('sArt');
for (let i = 0; i < 24; i++) {
  const cell = document.createElement('div');
  cell.className = 's-cell';
  sArt.appendChild(cell);
}

/* ── Build battery cell strip ───────────────────────── */
const bCellsEl = document.getElementById('batCells');
for (let i = 0; i < 18; i++) {
  const cell = document.createElement('div');
  cell.className   = 'bat-cell';
  cell.style.background = '#091420';
  bCellsEl.appendChild(cell);
}

/* ── Build mini solar panel in flow diagram ─────────── */
const mPanel = document.getElementById('mpanel');
for (let i = 0; i < 4; i++) {
  const d = document.createElement('div');
  mPanel.appendChild(d);
}

/* ── Set date labels ─────────────────────────────────── */
function setDates() {
  const d    = new Date();
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const prev = new Date(d);
  prev.setDate(d.getDate() - 1);
  const next = new Date(d);
  next.setDate(d.getDate() + 1);

  document.getElementById('wd1').textContent = DAYS[prev.getDay()] + ' ' + prev.getDate();
  document.getElementById('wd2').textContent = 'Today ' + d.getDate();
  document.getElementById('wd3').textContent = DAYS[next.getDay()] + ' ' + next.getDate();
}

setDates();

/* ── Clock ───────────────────────────────────────────── */
setInterval(() => {
  document.getElementById('clockDisp').textContent =
    new Date().toLocaleTimeString('en', { hour12: false });
}, 1000);

/* ════════════════════════════════════════════════════
   MAIN UPDATE FUNCTION
   Called every 2 seconds with new sensor readings
════════════════════════════════════════════════════ */
function update(solarV, batV, relay, current) {
  relay   = parseInt(relay)   || 0;
  current = parseFloat(current) || 0;

  const p   = parseFloat((batV * current).toFixed(5));
  const bp  = Math.max(0, Math.min(100,
                Math.round(((batV - 3.0) / (4.2 - 3.0)) * 100)));
  const ts  = new Date().toLocaleTimeString('en', { hour12: false });
  const now = Date.now();
  const dt  = (now - lastT) / 3.6e6;
  lastT     = now;
  eWh      += p * dt;
  if (relay) cWh += (p * 0.88) * dt;
  rdCnt++;

  /* ── Solar Panel ────────────────────────────────── */
  document.getElementById('solarV').textContent = solarV.toFixed(2);
  document.getElementById('sVBar').style.width  =
    Math.min(100, (solarV / 7) * 100).toFixed(1) + '%';

  const litCount = Math.round((solarV / 7) * 24);
  document.querySelectorAll('.s-cell').forEach((cell, idx) => {
    cell.className = 's-cell' + (idx < litCount ? ' lit' : '');
  });

  /* ── Battery Voltage ────────────────────────────── */
  const bCol = bp > 60 ? '#00e676' : bp > 30 ? '#ffd740' : '#ff5252';

  document.getElementById('batV').textContent        = batV.toFixed(3);
  document.getElementById('batV').style.color        = bCol;
  document.getElementById('batFill').style.width     = bp + '%';
  document.getElementById('batFill').style.background = bCol;
  document.getElementById('batPct').textContent      = bp + '%';
  document.getElementById('batPct').style.color      = bCol;
  document.getElementById('bVBar').style.width       =
    Math.min(100, (batV / 4.2) * 100).toFixed(1) + '%';
  document.getElementById('bVBar').style.background  = bCol;

  document.querySelectorAll('.bat-cell').forEach((cell, idx) => {
    cell.style.background = idx < Math.round(bp / 100 * 18) ? bCol : '#091420';
  });

  /* ── Secondary Load / Relay ─────────────────────── */
  const loadBanner = document.getElementById('loadBanner');
  const loadState  = document.getElementById('loadState');
  const loadDot    = document.getElementById('loadDot');
  const loadNote   = document.getElementById('loadNote');
  const loadArr    = document.getElementById('loadArr');
  const ledLbl     = document.getElementById('ledLbl');

  if (relay) {
    loadBanner.className = 'load-banner load-on';
    loadState.textContent = 'ON';
    loadState.style.color = '#00e676';
    loadDot.className     = 'load-dot dot-on';
    loadNote.textContent  = 'LED strip active — surplus energy used';
    loadArr.style.opacity = '1';
    ledLbl.textContent    = 'LED ON';
    ledLbl.style.color    = '#00e676';
  } else {
    loadBanner.className = 'load-banner load-off';
    loadState.textContent = 'OFF';
    loadState.style.color = '#ff5252';
    loadDot.className     = 'load-dot dot-off';
    loadNote.textContent  = 'Battery charging — load disconnected';
    loadArr.style.opacity = '.15';
    ledLbl.textContent    = 'LED OFF';
    ledLbl.style.color    = '#8ba0c8';
  }

  document.getElementById('loadPwr').textContent =
    relay ? (p * 0.88).toFixed(3) + ' W' : '0.000 W';
  document.getElementById('effV').textContent = relay ? '88%' : '—%';

  /* ── Boost Voltage ──────────────────────────────── */
  const bstV = batV >= 3.5 ? (4.97 + Math.random() * 0.05).toFixed(2) : '0.00';
  document.getElementById('boostV').textContent     = bstV;
  document.getElementById('boostVBar').style.width  =
    Math.min(100, (parseFloat(bstV) / 5.5) * 100).toFixed(1) + '%';
  document.getElementById('boostIn').textContent    = batV.toFixed(2) + ' V';

  /* ── Hysteresis Bar ─────────────────────────────── */
  const hp = ((batV - 3.0) / (4.2 - 3.0)) * 100;
  const hf = document.getElementById('hFill');
  hf.style.width = Math.max(0, Math.min(100, hp)).toFixed(1) + '%';
  hf.style.background = batV >= 4.10 ? '#00e676' : batV <= 3.80 ? '#ff5252' : '#ffd740';

  document.getElementById('hTxt').textContent =
    batV >= 4.10 ? 'Above ON threshold — relay active, LED strip ON' :
    batV <= 3.80 ? 'Below OFF threshold — relay off, battery charging' :
    'Inside hysteresis band — holding current relay state';

  /* ── ESG Score ──────────────────────────────────── */
  const esg = Math.min(100, Math.round(bp * 0.55 + (relay ? 45 : 0)));
  drawESG(esg);
  document.getElementById('esgScr').textContent = esg;

  const esgGrd  = document.getElementById('esgGrd');
  const esgScr  = document.getElementById('esgScr');
  const esgGrade = esg >= 80 ? 'Excellent' : esg >= 60 ? 'Good' : esg >= 40 ? 'Fair' : 'Low';
  const esgColor = esg >= 80 ? '#00e676' : esg >= 60 ? '#ffd740' : esg >= 40 ? '#ffab40' : '#ff5252';

  esgGrd.textContent   = esgGrade;
  esgGrd.style.color   = esgColor;
  esgScr.style.color   = esgColor;

  /* ── Relay Events Log ───────────────────────────── */
  if (relay && !rPrev) {
    evts.unshift({
      t: ts,
      m: `Relay ON — battery full (${batV.toFixed(3)}V)`,
      type: 'on'
    });
    document.getElementById('relCnt').textContent =
      evts.filter(e => e.type === 'on').length;
  }
  if (!relay && rPrev) {
    evts.unshift({
      t: ts,
      m: `Relay OFF — recharging (${batV.toFixed(3)}V)`,
      type: 'off'
    });
  }
  rPrev = relay;
  if (evts.length > 25) evts.pop();

  const evList = document.getElementById('evList');
  evList.innerHTML = evts.length
    ? evts.slice(0, 6).map(e =>
        `<div class="ev-item">
           <span class="ev-time">${e.t}</span>
           <span class="${e.type === 'on' ? 'ev-on' : 'ev-off'}">${e.m}</span>
         </div>`
      ).join('')
    : '<div class="ev-empty">No events recorded yet</div>';

  /* ── Session Statistics ─────────────────────────── */
  document.getElementById('st1').textContent = eWh.toFixed(4) + ' Wh';
  document.getElementById('st2').textContent = cWh.toFixed(4) + ' Wh';
  document.getElementById('st3').textContent = '₹' + (eWh * RATE_KWH).toFixed(5);
  document.getElementById('st4').textContent = rdCnt;

  /* ── Energy Chart Push ──────────────────────────── */
  lblArr.push(ts);
  prodArr.push(parseFloat(p.toFixed(4)));
  consArr.push(relay ? parseFloat((p * 0.88).toFixed(4)) : 0);
  batArr.push(bp);

  if (lblArr.length > MAX_PTS) {
    lblArr.shift();
    prodArr.shift();
    consArr.shift();
    batArr.shift();
  }

  energyChart.update('none');
}

/* ════════════════════════════════════════════════════
   DEMO SIMULATOR
   Runs when demoMode = true
   Simulates solar charging cycle automatically
════════════════════════════════════════════════════ */
function runSim() {
  if (!demoMode) return;

  /* Simulate battery voltage rising and falling */
  simV += simDir * (0.018 + Math.random() * 0.022);
  if (simV >= 4.16) simDir = -1;
  if (simV <= 3.55) simDir =  1;
  simV = Math.max(3.5, Math.min(4.2, simV));

  const ci     = simDir > 0
    ? 0.08 + Math.random() * 0.05   /* charging */
    : 0.01 + Math.random() * 0.02;  /* discharging */

  const relay  = simV >= 4.10 ? 1 : 0;
  const solarV = parseFloat((simV + 0.5).toFixed(3));

  update(solarV, parseFloat(simV.toFixed(3)), relay, parseFloat(ci.toFixed(3)));
}

/* ════════════════════════════════════════════════════
   MODE TOGGLE (Demo ↔ Live)
════════════════════════════════════════════════════ */
function toggleMode() {
  demoMode = !demoMode;

  const modeBtn = document.getElementById('modeBtn');
  const modeDot = document.getElementById('modeDot');
  const modeLbl = document.getElementById('modeLbl');

  if (demoMode) {
    modeBtn.className  = 'mode-toggle mode-demo';
    modeDot.className  = 'pulse pg';
    modeLbl.textContent = 'Demo mode';
  } else {
    modeBtn.className  = 'mode-toggle mode-live';
    modeDot.className  = 'pulse pb';
    modeLbl.textContent = 'Live mode';
  }
}

/* ════════════════════════════════════════════════════
   TOAST NOTIFICATION HELPER
════════════════════════════════════════════════════ */
function showToast(msg, borderColor) {
  const toast        = document.getElementById('toast');
  toast.textContent  = msg;
  toast.style.borderColor = borderColor || '#1e2d4a';
  toast.classList.remove('hide');
  setTimeout(() => toast.classList.add('hide'), 3500);
}

/* ════════════════════════════════════════════════════
   WEB SERIAL API — Connect to Arduino
   Works only in Chrome or Edge browser
   
   How to use:
   1. Plug Arduino USB cable into laptop
   2. Click "Connect Arduino" button in topbar
   3. Select your COM port from the popup list
   4. Dashboard switches to Live mode automatically

   Arduino must send this format every 2 seconds:
   Serial.print("V:"); Serial.print(solarV, 2);
   Serial.print(",B:"); Serial.print(batV, 3);
   Serial.print(",I:"); Serial.print(current, 3);
   Serial.print(",R:"); Serial.println(relayState);

   Example: "V:5.80,B:3.92,I:0.108,R:0"
════════════════════════════════════════════════════ */
async function connectHardware() {
  /* Check if Web Serial is available */
  if (!('serial' in navigator)) {
    showToast(
      'Web Serial not supported. Please use Chrome or Edge browser.',
      '#ff5252'
    );
    return;
  }

  /* If already connected, disconnect */
  if (serialActive) {
    try {
      if (serialReader) {
        await serialReader.cancel();
        serialReader = null;
      }
      if (serialPort) {
        await serialPort.close();
        serialPort = null;
      }
    } catch (e) {
      console.warn('Disconnect error:', e);
    }

    serialActive = false;
    demoMode     = true;

    document.getElementById('hwBtn').className    = 'hw-btn';
    document.getElementById('hwDot').className    = 'pulse pr';
    document.getElementById('hwLbl').textContent  = 'Connect Arduino';
    document.getElementById('connPill').textContent = 'No hardware';
    document.getElementById('connPill').style.color = '#8ba0c8';

    toggleMode(); /* switch back to demo */
    showToast('Arduino disconnected. Switched to demo mode.', '#ffab40');
    return;
  }

  /* Request serial port from user */
  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 9600 });
    serialActive = true;
    demoMode     = false;

    /* Update UI to connected state */
    const hwBtn   = document.getElementById('hwBtn');
    hwBtn.className    = 'hw-btn connected';
    document.getElementById('hwDot').className    = 'pulse pg';
    document.getElementById('hwLbl').textContent  = 'Disconnect';
    document.getElementById('connPill').textContent = 'Arduino connected';
    document.getElementById('connPill').style.color = '#00e676';

    /* Switch mode toggle to live */
    document.getElementById('modeBtn').className   = 'mode-toggle mode-live';
    document.getElementById('modeDot').className   = 'pulse pb';
    document.getElementById('modeLbl').textContent = 'Live mode';

    showToast('Arduino connected! Receiving live data.', '#00e676');

    /* Start reading serial data */
    const decoder  = new TextDecoderStream();
    serialPort.readable.pipeTo(decoder.writable);
    serialReader   = decoder.readable.getReader();

    let buffer = '';

    while (serialActive) {
      const { value, done } = await serialReader.read();
      if (done) break;
      buffer += value;

      /* Process complete lines */
      const lines = buffer.split('\n');
      buffer = lines.pop(); /* keep incomplete last piece */

      for (const line of lines) {
        parseLine(line.trim());
      }
    }

  } catch (err) {
    serialActive = false;
    demoMode     = true;

    document.getElementById('hwBtn').className    = 'hw-btn';
    document.getElementById('hwDot').className    = 'pulse pr';
    document.getElementById('hwLbl').textContent  = 'Connect Arduino';
    document.getElementById('connPill').textContent = 'Connection failed';
    document.getElementById('connPill').style.color = '#ff5252';

    showToast('Could not connect: ' + err.message, '#ff5252');
    console.error('Serial connection error:', err);
  }
}

/* ── Parse one line from Arduino ────────────────────── */
/*
   Expected format: "V:5.80,B:3.92,I:0.108,R:0"
   V = solar panel voltage  (from voltage sensor)
   B = battery voltage      (from voltage sensor)
   I = charging current     (from ACS712, optional)
   R = relay state          (0 or 1)

   If you only have one voltage sensor measuring battery:
   Just send V and B as the same value,
   the dashboard will add 0.5V offset for solar estimate.
*/
function parseLine(line) {
  if (!line || line.length < 3) return;

  try {
    const parts = {};
    line.split(',').forEach(seg => {
      const kv = seg.split(':');
      if (kv.length === 2) {
        parts[kv[0].trim()] = parseFloat(kv[1].trim());
      }
    });

    const V = parts['V'];
    const B = parts['B'] !== undefined ? parts['B'] : (V ? V * 0.62 : undefined);
    const I = parts['I'] || 0;
    const R = parts['R'] || 0;

    if (V !== undefined && !isNaN(V)) {
      update(V, B, R, I);
    }
  } catch (err) {
    console.warn('Parse error for line:', line, err);
  }
}

/* ── Attach button event listeners ─────────────────── */
document.getElementById('hwBtn').addEventListener('click', connectHardware);
document.getElementById('modeBtn').addEventListener('click', toggleMode);

/* ── Start demo simulation ──────────────────────────── */
runSim();
setInterval(runSim, 2000);
/**
 * LEDL Industrial Monitoring Dashboard
 * app.js – Clock, Charts, WebSocket (MQTT + Blynk via bridge), Image Modals
 *
 * The bridge (bridge.js) handles:
 *   - MQTT subscription + SQLite storage
 *   - Blynk polling every 5s + SQLite storage
 *   - HTTP API for historical data
 *   - WebSocket broadcast for real-time updates
 */

const hostname = window.location.hostname;
const BRIDGE_URL = `http://${hostname}:8080`;
const WS_URL = `ws://${hostname}:8080`;

document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initCharts();
  initModals();
  initAlarmModals();
  initFilterButtons();
  initMotorSelector();
  loadHistoricalData();
  fetchRunHours('motor1');
  setInterval(() => fetchRunHours(document.getElementById('motorSelect').value), 60000);
  initWebSocket();
});

function initMotorSelector() {
  document.getElementById('motorSelect').addEventListener('change', (e) => {
    const motorId = e.target.value;
    if (motorId === 'motor2') {
      clearCharts();
    } else {
      loadHistoricalData();
      fetchRunHours(motorId);
    }
  });
}

function clearCharts() {
  vibChartInstance.data.labels = [];
  vibChartInstance.data.datasets.forEach(ds => { if (ds.label !== 'Alarm Max') ds.data = []; });
  vibChartInstance.update();

  tempChartInstance.data.labels = [];
  tempChartInstance.data.datasets.forEach(ds => { if (ds.label !== 'Alarm Max') ds.data = []; });
  tempChartInstance.update();

  updateRunHoursUI({ todayHrs: 0, monthHrs: 0, ytdHrs: 0, totalHrs: 0, avgDay: 0, avgMonth: 0, avgYTD: 0 });
  ['kpiEnergy', 'kpiPF', 'kpiVoltage', 'kpiCurrent'].forEach(id => {
    document.getElementById(id).textContent = '--';
  });
}

// ==================== 1. CLOCK ====================
function initClock() {
  const el = document.getElementById('dateTime');
  function tick() {
    const now = new Date();
    const opts = {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    };
    el.textContent = now.toLocaleDateString('en-IN', opts);
  }
  tick();
  setInterval(tick, 1000);
}

// ==================== 2. CHARTS ====================
let vibChartInstance, tempChartInstance, donutToday, donutMonth, donutYTD;

function initCharts() {
  vibChartInstance = new Chart(document.getElementById('vibChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'X', borderColor: '#007bff', backgroundColor: 'rgba(0,123,255,0.08)', data: [], borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.4 },
        { label: 'Y', borderColor: '#00c853', backgroundColor: 'rgba(0,200,83,0.08)', data: [], borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.4 },
        { label: 'Z', borderColor: '#ff9100', backgroundColor: 'rgba(255,145,0,0.08)', data: [], borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.4 },
        { label: 'Alarm Max', borderColor: '#ef4444', backgroundColor: 'transparent', data: [], borderWidth: 2, borderDash: [5, 5], pointRadius: 0, tension: 0, hidden: true }
      ]
    },
    options: chartOpts('mm/sec')
  });

  tempChartInstance = new Chart(document.getElementById('tempChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Body', borderColor: '#ff1744', backgroundColor: 'rgba(255,23,68,0.08)', data: [], borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.4 },
        { label: 'Winding', borderColor: '#d500f9', backgroundColor: 'rgba(213,0,249,0.08)', data: [], borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.4 },
        { label: 'Alarm Max', borderColor: '#ef4444', backgroundColor: 'transparent', data: [], borderWidth: 2, borderDash: [5, 5], pointRadius: 0, tension: 0, hidden: true }
      ]
    },
    options: chartOpts('°C')
  });

  const donutOpts = {
    responsive: true, maintainAspectRatio: false,
    cutout: '75%',
    plugins: { legend: { display: false }, tooltip: { enabled: false } }
  };
  
  donutToday = new Chart(document.getElementById('donutToday').getContext('2d'), {
    type: 'doughnut',
    data: { datasets: [{ data: [0, 24], backgroundColor: ['#1d4ed8', '#ffffff'], borderWidth: 0 }] },
    options: donutOpts
  });
  donutMonth = new Chart(document.getElementById('donutMonth').getContext('2d'), {
    type: 'doughnut',
    data: { datasets: [{ data: [0, 720], backgroundColor: ['#047857', '#ffffff'], borderWidth: 0 }] },
    options: donutOpts
  });
  donutYTD = new Chart(document.getElementById('donutYTD').getContext('2d'), {
    type: 'doughnut',
    data: { datasets: [{ data: [0, 8760], backgroundColor: ['#b45309', '#ffffff'], borderWidth: 0 }] },
    options: donutOpts
  });
  
  applyAlarmBands();
}

function chartOpts(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 10, usePointStyle: true, font: { size: 11 } } },
      tooltip: {
        backgroundColor: '#fff', titleColor: '#1e293b', bodyColor: '#1e293b',
        borderColor: '#e2e8f0', borderWidth: 1, padding: 10
      }
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 15 } },
      y: { grid: { color: '#f1f5f9' }, title: { display: true, text: yLabel, font: { size: 11 } } }
    }
  };
}

// ==================== 3. LOAD HISTORICAL DATA ====================
async function loadHistoricalData() {
  try {
    fetchFilteredChartData('vib', activeFilters.vib);
    fetchFilteredChartData('temp', activeFilters.temp);

    // Load MQTT history (for Power KPIs — show latest, and for run hours)
    const mqttRes = await fetch(`${BRIDGE_URL}/api/mqtt?limit=1`);
    if (mqttRes.ok) {
      const mqttData = await mqttRes.json();
      if (mqttData.length > 0) {
        processElectricalData(mqttData[mqttData.length - 1]);
      }
    }
  } catch (e) {
    console.warn('[History] Could not load historical data:', e.message);
  }
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) {
    // Handle "YYYY-MM-DD HH:MM:SS" format from SQLite
    return ts.split(' ')[1] || ts;
  }
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ==================== 4. WEBSOCKET (Real-time) ====================
function initWebSocket() {
  const statusEl = document.getElementById('mqttStatus');
  const statusText = document.getElementById('mqttStatusText');
  let ws;

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      statusEl.classList.remove('error');
      statusEl.classList.add('connected');
      statusText.textContent = 'Connected (Live)';
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'mqtt') {
          processElectricalData(msg.data);
        }
        else if (msg.type === 'blynk') {
          const label = msg.data.label || new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          if (activeFilters.vib === 'day') pushChartData(vibChartInstance, label, [msg.data.ax, msg.data.ay, msg.data.az]);
          if (activeFilters.temp === 'day') pushChartData(tempChartInstance, label, [msg.data.temp]);
          checkAlarms(msg.data);
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    ws.onerror = () => {};

    ws.onclose = () => {
      statusEl.classList.remove('connected');
      statusEl.classList.add('error');
      statusText.textContent = 'Reconnecting...';
      setTimeout(connect, 5000);
    };
  }

  connect();
}

// ==================== 5. PROCESS DATA ====================
function processElectricalData(d) {
  if (d.kwh_imp !== undefined) {
    document.getElementById('kpiEnergy').textContent = d.kwh_imp.toFixed(2);
  }
  if (d.pf_avg !== undefined) {
    document.getElementById('kpiPF').textContent = d.pf_avg.toFixed(2);
  }
  if (d.vll_avg !== undefined) {
    document.getElementById('kpiVoltage').textContent = d.vll_avg.toFixed(1);
  }
  if (d.i_avg !== undefined) {
    document.getElementById('kpiCurrent').textContent = d.i_avg.toFixed(2);
  }

  const dot = document.getElementById('mqttStatus');
  dot.style.opacity = '0.5';
  setTimeout(() => { dot.style.opacity = '1'; }, 300);
}

function pushChartData(chart, label, values) {
  const MAX_POINTS = 100;
  if (chart.data.labels.length > MAX_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(ds => ds.data.shift());
  }
  chart.data.labels.push(label);
  
  // The last dataset is the Alarm band
  const isVib = chart === vibChartInstance;
  const alarmVal = localStorage.getItem(isVib ? 'ledl_vib_alarm' : 'ledl_temp_alarm');
  
  values.forEach((v, i) => {
    if (chart.data.datasets[i]) chart.data.datasets[i].data.push(v);
  });
  
  // Push alarm line value
  const alarmDs = chart.data.datasets[chart.data.datasets.length - 1];
  alarmDs.data.push(alarmVal ? parseFloat(alarmVal) : null);
  
  chart.update();
}

// ==================== 6. RUN HOURS TRACKER ====================
async function fetchRunHours(motorId) {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/run-hours?motor=${motorId}`);
    if (res.ok) {
      const data = await res.json();
      updateRunHoursUI(data);
    }
  } catch (e) {
    console.warn('[RunHours] Could not fetch run hours:', e.message);
  }
}

function updateRunHoursUI(data) {
  const { todayHrs, monthHrs, ytdHrs, totalHrs, avgDay, avgMonth, avgYTD } = data;
  
  // Update text values
  document.getElementById('rhToday').textContent    = todayHrs.toFixed(1);
  document.getElementById('rhAvgDay').textContent   = avgDay.toFixed(1);
  document.getElementById('rhMonth').textContent    = monthHrs.toFixed(1);
  document.getElementById('rhAvgMonth').textContent = avgMonth.toFixed(1);
  document.getElementById('rhYTD').textContent      = ytdHrs.toFixed(1);
  document.getElementById('rhAvgYTD').textContent   = avgYTD.toFixed(1);
  document.getElementById('rhTotal').textContent    = totalHrs.toFixed(1);

  // Update Pie Charts
  if (donutToday) {
    donutToday.data.datasets[0].data = [todayHrs, Math.max(0, 24 - todayHrs)];
    donutToday.update();
  }
  if (donutMonth) {
    donutMonth.data.datasets[0].data = [monthHrs, Math.max(0, 720 - monthHrs)];
    donutMonth.update();
  }
  if (donutYTD) {
    donutYTD.data.datasets[0].data = [ytdHrs, Math.max(0, 8760 - ytdHrs)];
    donutYTD.update();
  }
}

// ==================== 7. IMAGE MODALS ====================
function initModals() {
  const overlay = document.getElementById('imageModal');
  const img = document.getElementById('modalImage');
  const title = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');

  document.getElementById('rowNameplate').addEventListener('click', () => {
    title.textContent = 'Motor Name Plate';
    img.src = 'name_plate.jpg';
    img.alt = 'Motor Name Plate';
    overlay.classList.add('open');
  });

  document.getElementById('rowHistory').addEventListener('click', () => {
    title.textContent = 'Preventive Maintenance History Card';
    img.src = 'history.jpg';
    img.alt = 'Preventive Maintenance History';
    overlay.classList.add('open');
  });

  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
}

// ==================== 8. ALARM MODALS ====================
function initAlarmModals() {
  const overlay = document.getElementById('alarmModal');
  const closeBtn = document.getElementById('alarmModalClose');
  const title = document.getElementById('alarmModalTitle');
  const input = document.getElementById('alarmThresholdInput');
  const unit = document.getElementById('alarmInputUnit');
  const btnSave = document.getElementById('btnSaveAlarm');
  const btnClear = document.getElementById('btnClearAlarm');
  
  let currentMode = null; // 'vib' or 'temp'

  document.getElementById('btnVibAlarm').addEventListener('click', () => {
    currentMode = 'vib';
    title.textContent = 'Set Vibration Alarm Threshold';
    unit.textContent = 'mm/sec';
    input.value = localStorage.getItem('ledl_vib_alarm') || '';
    overlay.classList.add('open');
  });

  document.getElementById('btnTempAlarm').addEventListener('click', () => {
    currentMode = 'temp';
    title.textContent = 'Set Temperature Alarm Threshold';
    unit.textContent = '°C';
    input.value = localStorage.getItem('ledl_temp_alarm') || '';
    overlay.classList.add('open');
  });

  btnSave.addEventListener('click', () => {
    if (!input.value) return;
    const key = currentMode === 'vib' ? 'ledl_vib_alarm' : 'ledl_temp_alarm';
    localStorage.setItem(key, parseFloat(input.value));
    overlay.classList.remove('open');
    applyAlarmBands();
  });

  btnClear.addEventListener('click', () => {
    const key = currentMode === 'vib' ? 'ledl_vib_alarm' : 'ledl_temp_alarm';
    localStorage.removeItem(key);
    overlay.classList.remove('open');
    applyAlarmBands();
  });

  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
}

function applyAlarmBands() {
  const vibThresh = localStorage.getItem('ledl_vib_alarm');
  const tempThresh = localStorage.getItem('ledl_temp_alarm');

  const btnVib = document.getElementById('btnVibAlarm');
  const btnTemp = document.getElementById('btnTempAlarm');
  
  // Update footer UI
  if (vibThresh) {
    btnVib.classList.add('active');
    document.getElementById('vibAlarmText').textContent = `Alarm active: > ${vibThresh} mm/sec`;
  } else {
    btnVib.classList.remove('active');
    document.getElementById('vibAlarmText').textContent = `Set band for Vibration alarm`;
  }

  if (tempThresh) {
    btnTemp.classList.add('active');
    document.getElementById('tempAlarmText').textContent = `Alarm active: > ${tempThresh} °C`;
  } else {
    btnTemp.classList.remove('active');
    document.getElementById('tempAlarmText').textContent = `Set band for Temperature alarm`;
  }

  // Update chart visibility
  const vibDs = vibChartInstance.data.datasets[vibChartInstance.data.datasets.length - 1];
  vibDs.hidden = !vibThresh;
  vibDs.data = vibDs.data.map(() => vibThresh ? parseFloat(vibThresh) : null);
  vibChartInstance.update();

  const tempDs = tempChartInstance.data.datasets[tempChartInstance.data.datasets.length - 1];
  tempDs.hidden = !tempThresh;
  tempDs.data = tempDs.data.map(() => tempThresh ? parseFloat(tempThresh) : null);
  tempChartInstance.update();
}

// ==================== 9. TOAST ALERTS ====================
let lastAlarmTime = { vib: 0, temp: 0 };

function showAlarmToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `⚠️ <span>${msg}</span>`;
  container.appendChild(toast);
  
  // Remove after 6 seconds
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

function checkAlarms(blynkData) {
  const now = Date.now();
  
  // Check Vibration
  const vibThresh = localStorage.getItem('ledl_vib_alarm');
  if (vibThresh) {
    const vt = parseFloat(vibThresh);
    // Use absolute maximum across all 3 axes for vibration severity
    const maxVib = Math.max(Math.abs(blynkData.ax), Math.abs(blynkData.ay), Math.abs(blynkData.az));
    if (maxVib > vt && (now - lastAlarmTime.vib > 60000)) { // 1 minute cooldown to prevent spam
      showAlarmToast(`Vibration Alarm! Value (${maxVib.toFixed(2)} mm/s) exceeded limit of ${vt}`);
      lastAlarmTime.vib = now;
    }
  }

  // Check Temperature
  const tempThresh = localStorage.getItem('ledl_temp_alarm');
  if (tempThresh) {
    const tt = parseFloat(tempThresh);
    if (blynkData.temp > tt && (now - lastAlarmTime.temp > 60000)) {
      showAlarmToast(`Temperature Alarm! Value (${blynkData.temp.toFixed(1)} °C) exceeded limit of ${tt}`);
      lastAlarmTime.temp = now;
    }
  }
}

// ==================== 10. FILTER BUTTONS & DATA ====================
let activeFilters = { vib: 'day', temp: 'day' };

function initFilterButtons() {
  document.querySelectorAll('.filter-bar').forEach(bar => {
    const isVib = bar.closest('.chart-card').id === 'vibCard';
    bar.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        
        bar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const filter = btn.dataset.filter;
        if (isVib) {
          activeFilters.vib = filter;
          fetchFilteredChartData('vib', filter);
        } else {
          activeFilters.temp = filter;
          fetchFilteredChartData('temp', filter);
        }
      });
    });
  });

  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

async function fetchFilteredChartData(chartType, filter) {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/chart-data?filter=${filter}`);
    if (res.ok) {
      const data = await res.json();
      
      const chart = chartType === 'vib' ? vibChartInstance : tempChartInstance;
      const labels = [];
      const dsData = [[], [], []];
      
      data.forEach(row => {
        let label = row.label;
        if (filter === 'day' && label && label.includes(' ')) {
          label = label.split(' ')[1];
        }
        labels.push(label);
        if (chartType === 'vib') {
          dsData[0].push(row.ax);
          dsData[1].push(row.ay);
          dsData[2].push(row.az);
        } else {
          dsData[0].push(row.temp);
        }
      });
      
      chart.data.labels = labels;
      if (chartType === 'vib') {
        chart.data.datasets[0].data = dsData[0];
        chart.data.datasets[1].data = dsData[1];
        chart.data.datasets[2].data = dsData[2];
      } else {
        chart.data.datasets[0].data = dsData[0];
      }
      
      // Update Alarm band
      const alarmVal = localStorage.getItem(chartType === 'vib' ? 'ledl_vib_alarm' : 'ledl_temp_alarm');
      const alarmDs = chart.data.datasets[chart.data.datasets.length - 1];
      alarmDs.data = labels.map(() => alarmVal ? parseFloat(alarmVal) : null);
      
      chart.update();
    }
  } catch (e) {
    console.error('[Filter] Could not fetch data:', e);
  }
}

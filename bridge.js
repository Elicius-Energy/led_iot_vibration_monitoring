const mqtt = require('mqtt');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');

// ==================== CONFIG ====================
const MQTT_BROKER = 'mqtt://node.kaatru.org:1883';
const MQTT_TOPIC = 'ledl';
const BLYNK_TOKEN = 'XNzafq7GjeKYsZo205QKAFEja4YU-xAo';
const BLYNK_URL = `https://blynk.cloud/external/api/get?token=${BLYNK_TOKEN}`;
const PORT = 8080;
const BLYNK_POLL_INTERVAL = 900000; // 15 minutes (900000 ms)

// ==================== DATABASE ====================
const dbPath = path.join(__dirname, 'dashboard.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS mqtt_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    dTS INTEGER,
    v12 REAL, v23 REAL, v31 REAL, vll_avg REAL,
    i_avg REAL, t_kw REAL, pf_avg REAL, kwh_imp REAL,
    freq REAL
  );

  CREATE TABLE IF NOT EXISTS blynk_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    ax REAL, ay REAL, az REAL, temp REAL
  );
`);

const insertMqtt = db.prepare(`
  INSERT INTO mqtt_data (dTS, v12, v23, v31, vll_avg, i_avg, t_kw, pf_avg, kwh_imp, freq)
  VALUES (@dTS, @v12, @v23, @v31, @vll_avg, @i_avg, @t_kw, @pf_avg, @kwh_imp, @freq)
`);

const insertBlynk = db.prepare(`
  INSERT INTO blynk_data (ax, ay, az, temp)
  VALUES (@ax, @ay, @az, @temp)
`);

console.log(`[DB] SQLite database at ${dbPath}`);

// ==================== HTTP + WS SERVER ====================
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/mqtt') {
    const limit = parseInt(url.searchParams.get('limit')) || 200;
    const rows = db.prepare('SELECT * FROM mqtt_data ORDER BY id DESC LIMIT ?').all(limit);
    res.end(JSON.stringify(rows.reverse()));
  }
  else if (url.pathname === '/api/blynk') {
    const limit = parseInt(url.searchParams.get('limit')) || 200;
    const rows = db.prepare('SELECT * FROM blynk_data ORDER BY id DESC LIMIT ?').all(limit);
    res.end(JSON.stringify(rows.reverse()));
  }
  else if (url.pathname === '/api/stats') {
    // Get database stats
    const mqttCount = db.prepare('SELECT COUNT(*) as count FROM mqtt_data').get();
    const blynkCount = db.prepare('SELECT COUNT(*) as count FROM blynk_data').get();
    const mqttLast = db.prepare('SELECT timestamp FROM mqtt_data ORDER BY id DESC LIMIT 1').get();
    const blynkLast = db.prepare('SELECT timestamp FROM blynk_data ORDER BY id DESC LIMIT 1').get();
    res.end(JSON.stringify({
      mqtt_records: mqttCount.count,
      blynk_records: blynkCount.count,
      mqtt_last: mqttLast ? mqttLast.timestamp : null,
      blynk_last: blynkLast ? blynkLast.timestamp : null
    }));
  }
  else if (url.pathname === '/api/run-hours') {
    const runQuery = db.prepare(`
      SELECT 
        SUM(CASE WHEN date(timestamp) = date('now', 'localtime') THEN 1 ELSE 0 END) as today_records,
        SUM(CASE WHEN strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now', 'localtime') THEN 1 ELSE 0 END) as month_records,
        SUM(CASE WHEN strftime('%Y', timestamp) = strftime('%Y', 'now', 'localtime') THEN 1 ELSE 0 END) as year_records,
        COUNT(*) as total_records,
        COUNT(DISTINCT date(timestamp)) as active_days,
        COUNT(DISTINCT strftime('%Y-%m', timestamp)) as active_months,
        COUNT(DISTINCT strftime('%Y', timestamp)) as active_years
      FROM mqtt_data 
      WHERE i_avg > 0.5
    `).get();

    const HRS_PER_RECORD = 5 / 3600; // 5 seconds per record

    const totalHrs = (runQuery.total_records || 0) * HRS_PER_RECORD;
    res.end(JSON.stringify({
      todayHrs: (runQuery.today_records || 0) * HRS_PER_RECORD,
      monthHrs: (runQuery.month_records || 0) * HRS_PER_RECORD,
      ytdHrs: (runQuery.year_records || 0) * HRS_PER_RECORD,
      totalHrs: totalHrs,
      avgDay: totalHrs / (runQuery.active_days || 1),
      avgMonth: totalHrs / (runQuery.active_months || 1),
      avgYTD: totalHrs / (runQuery.active_years || 1)
    }));
  }
  else if (url.pathname === '/api/chart-data') {
    const filter = url.searchParams.get('filter') || 'day';
    let query = '';
    
    if (filter === 'day') {
      // Average by minute for the last 24 hours
      query = `
        SELECT 
          strftime('%Y-%m-%d %H:%M', timestamp) as label,
          AVG(ax) as ax, AVG(ay) as ay, AVG(az) as az, AVG(temp) as temp
        FROM blynk_data
        WHERE timestamp >= datetime('now', '-1 day', 'localtime')
        GROUP BY label
        ORDER BY label ASC
      `;
    } else if (filter === 'month') {
      // Average by day for the last 30 days
      query = `
        SELECT 
          date(timestamp) as label,
          AVG(ax) as ax, AVG(ay) as ay, AVG(az) as az, AVG(temp) as temp
        FROM blynk_data
        WHERE timestamp >= date('now', '-30 days', 'localtime')
        GROUP BY label
        ORDER BY label ASC
      `;
    } else if (filter === 'ytd') {
      // Average by day for the current year
      query = `
        SELECT 
          date(timestamp) as label,
          AVG(ax) as ax, AVG(ay) as ay, AVG(az) as az, AVG(temp) as temp
        FROM blynk_data
        WHERE strftime('%Y', timestamp) = strftime('%Y', 'now', 'localtime')
        GROUP BY label
        ORDER BY label ASC
      `;
    } else if (filter === 'total') {
      // Average by month for all time
      query = `
        SELECT 
          strftime('%Y-%m', timestamp) as label,
          AVG(ax) as ax, AVG(ay) as ay, AVG(az) as az, AVG(temp) as temp
        FROM blynk_data
        GROUP BY label
        ORDER BY label ASC
      `;
    }
    
    try {
      const rows = db.prepare(query).all();
      res.end(JSON.stringify(rows));
    } catch(e) {
      res.statusCode = 500;
      res.end(JSON.stringify({error: e.message}));
    }
  }
  else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const wss = new WebSocket.Server({ server });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Frontend client connected');
  ws.on('close', () => console.log('[WS] Frontend client disconnected'));
});

server.listen(PORT, () => {
  console.log(`[Server] HTTP API + WebSocket running on port ${PORT}`);
});

// ==================== MQTT ====================
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
  console.log(`[MQTT] Connected to ${MQTT_BROKER}`);
  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (!err) console.log(`[MQTT] Subscribed to: ${MQTT_TOPIC}`);
    else console.error('[MQTT] Subscribe error:', err);
  });
});

mqttClient.on('error', (err) => console.error('[MQTT] Error:', err));

mqttClient.on('message', (topic, message) => {
  if (topic !== MQTT_TOPIC) return;
  try {
    const d = JSON.parse(message.toString());

    // Store in DB
    insertMqtt.run({
      dTS: d.dTS || null,
      v12: d.v12 || null, v23: d.v23 || null, v31: d.v31 || null,
      vll_avg: d.vll_avg || null,
      i_avg: d.i_avg || null, t_kw: d.t_kw || null,
      pf_avg: d.pf_avg || null, kwh_imp: d.kwh_imp || null,
      freq: d.freq || null
    });

    // Broadcast to frontend
    broadcast({ type: 'mqtt', data: d });

  } catch (e) {
    console.error('[MQTT] Parse error:', e);
  }
});

// ==================== BLYNK POLLER ====================
let prevBlynk = { ax: null, ay: null, az: null, temp: null };

async function pollBlynk() {
  try {
    const [r0, r1, r2, r3] = await Promise.all([
      fetch(`${BLYNK_URL}&V0`), fetch(`${BLYNK_URL}&V1`),
      fetch(`${BLYNK_URL}&V2`), fetch(`${BLYNK_URL}&V3`)
    ]);
    const [axRaw, ayRaw, azRaw, tempRaw] = await Promise.all([r0.text(), r1.text(), r2.text(), r3.text()]);

    const ax   = parseFloat(axRaw)   || 0;
    const ay   = parseFloat(ayRaw)   || 0;
    const az   = parseFloat(azRaw)   || 0;
    const temp = parseFloat(tempRaw) || 0;

    // Only store & broadcast if data actually changed
    if (ax !== prevBlynk.ax || ay !== prevBlynk.ay || az !== prevBlynk.az || temp !== prevBlynk.temp) {
      prevBlynk = { ax, ay, az, temp };

      // Store in DB
      insertBlynk.run({ ax, ay, az, temp });

      // Broadcast to frontend
      broadcast({ type: 'blynk', data: { ax, ay, az, temp, timestamp: new Date().toISOString() } });

      console.log(`[Blynk] NEW: ax=${ax} ay=${ay} az=${az} temp=${temp}`);
    }
  } catch (e) {
    console.error('[Blynk] Poll error:', e);
  }
}

// Start polling
pollBlynk();
setInterval(pollBlynk, BLYNK_POLL_INTERVAL);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Closing database...');
  db.close();
  process.exit(0);
});

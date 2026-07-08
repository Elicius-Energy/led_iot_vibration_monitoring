const mqtt = require('mqtt');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');

// ==================== CONFIG ====================
const MQTT_BROKER = 'mqtt://node.kaatru.org:1883';
const MQTT_TOPIC = 'ledl';
const VIB_MQTT_BROKER = 'mqtt://3.104.55.137:1884';
const VIB_MQTT_TOPIC = 'ledl';
const PORT = 8080;

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
      // Average by minute for today only
      query = `
        SELECT 
          strftime('%Y-%m-%dT%H:%M:%SZ', timestamp) as raw_timestamp,
          AVG(ax) as ax, AVG(ay) as ay, AVG(az) as az, AVG(temp) as temp
        FROM blynk_data
        WHERE date(timestamp) = date('now', 'localtime')
        GROUP BY strftime('%Y-%m-%d %H:%M', timestamp)
        ORDER BY timestamp ASC
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

// ==================== VIBRATION MQTT ====================
const vibMqttClient = mqtt.connect(VIB_MQTT_BROKER, {
  username: 'admin',
  password: 'ledl'
});

vibMqttClient.on('connect', () => {
  console.log(`[Vib-MQTT] Connected to ${VIB_MQTT_BROKER}`);
  vibMqttClient.subscribe(VIB_MQTT_TOPIC, (err) => {
    if (!err) console.log(`[Vib-MQTT] Subscribed to: ${VIB_MQTT_TOPIC}`);
    else console.error('[Vib-MQTT] Subscribe error:', err);
  });
});

vibMqttClient.on('error', (err) => console.error('[Vib-MQTT] Error:', err));

let prevVib = { ax: null, ay: null, az: null, temp: null };

vibMqttClient.on('message', (topic, message) => {
  if (topic !== VIB_MQTT_TOPIC) return;
  try {
    const d = JSON.parse(message.toString());
    
    if (d.X !== undefined && d.Y !== undefined && d.Z !== undefined && d.Temperature !== undefined) {
      const ax = parseFloat(d.X) || 0;
      const ay = parseFloat(d.Y) || 0;
      const az = parseFloat(d.Z) || 0;
      const temp = parseFloat(d.Temperature) || 0;

      if (ax !== prevVib.ax || ay !== prevVib.ay || az !== prevVib.az || temp !== prevVib.temp) {
        prevVib = { ax, ay, az, temp };

        // Store in DB
        insertBlynk.run({ ax, ay, az, temp });

        // Broadcast to frontend
        broadcast({ type: 'blynk', data: { ax, ay, az, temp, timestamp: new Date().toISOString() } });

        console.log(`[Vib-MQTT] NEW: ax=${ax} ay=${ay} az=${az} temp=${temp}`);
      }
    }
  } catch (e) {
    console.error('[Vib-MQTT] Parse error:', e);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Closing database...');
  db.close();
  process.exit(0);
});

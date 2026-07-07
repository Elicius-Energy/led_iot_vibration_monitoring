# LEDL IoT Vibration Monitoring Dashboard

A real-time predictive maintenance and performance monitoring dashboard designed for LEDL (Elicius Energy PVT LTD) industrial motors. 

## Architecture
- **Backend**: Node.js, Express.js, SQLite3 (stores historical telemetry data), and MQTT (subscribes to `mqtt://node.kaatru.org:1883`).
- **Frontend**: Vanilla HTML/CSS/JavaScript with WebSocket for real-time updates and Chart.js for data visualization.

## Features
- **Real-Time Telemetry**: Live MQTT feed plotting vibration (ax, ay, az) and temperature metrics directly to charts.
- **Historical Trends**: View aggregate data (Day, Month, YTD, Total) powered by SQLite database time-based grouping.
- **Run Hours Tracking**: Dynamic donut charts representing operating hours out of daily, monthly, and yearly maximums.
- **Vibration Alarms**: Configurable max-threshold vibration alarms that trigger visual alerts across the dashboard.

## Local Setup

### 1. Install Dependencies
Make sure you have Node.js installed, then install the required backend packages:
```bash
npm install mqtt sqlite3 express ws cors moment
```

### 2. Run the Backend (Bridge API & WebSocket)
The backend script connects to the MQTT broker, stores data in a local SQLite database, and serves data over WebSockets/HTTP APIs.
```bash
node bridge.js
```

### 3. Run the Frontend
You must serve the frontend files using a local web server (opening `index.html` directly in the browser will block CORS/Module requests).
```bash
npx serve .
```

### 4. View Dashboard
Open your browser and navigate to the address provided by `npx serve` (usually `http://localhost:3000`).

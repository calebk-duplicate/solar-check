const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const cors = require('cors');
const express = require('express');
const Database = require('better-sqlite3');

const INVERTER_BASE_URL = (process.env.INVERTER_BASE_URL || '').replace(/\/$/, '');
const POLL_SECONDS = Number.parseInt(process.env.POLL_SECONDS || '15', 10);
const PORT = Number.parseInt(process.env.PORT || '8080', 10);

if (!INVERTER_BASE_URL) {
	throw new Error('Missing required environment variable: INVERTER_BASE_URL');
}

if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS <= 0) {
	throw new Error('POLL_SECONDS must be a positive integer');
}

if (!Number.isFinite(PORT) || PORT <= 0) {
	throw new Error('PORT must be a positive integer');
}

const app = express();
app.use(cors());
const DB_FILE = path.join(__dirname, 'solarcheck.db');
const db = new Database(DB_FILE);
const DASHBOARD_DIST_DIR = path.resolve(__dirname, '../dashboard/dist');
const DASHBOARD_INDEX_FILE = path.join(DASHBOARD_DIST_DIR, 'index.html');
const DASHBOARD_DIST_EXISTS = fs.existsSync(DASHBOARD_DIST_DIR);
const DASHBOARD_INDEX_EXISTS = fs.existsSync(DASHBOARD_INDEX_FILE);

const state = {
	startedAtMs: Date.now(),
	lastPollAtUtc: null,
	lastSuccessAtUtc: null,
	lastError: null,
	lastReadingTsUtc: null,
	pollingInProgress: false,
	consecutiveZeroLoadWithPv: 0,
	liveDataWarning: null,
};

initializeDatabase(db);

const statements = prepareStatements(db);

const api = express.Router();

api.get('/health', (_req, res) => {
	res.json({
		ok: true,
		uptime_s: Math.floor((Date.now() - state.startedAtMs) / 1000),
		poll_seconds: POLL_SECONDS,
		inverter_base_url: INVERTER_BASE_URL,
		last_poll_at_utc: state.lastPollAtUtc,
		last_success_at_utc: state.lastSuccessAtUtc,
		last_reading_ts_utc: state.lastReadingTsUtc,
		last_error: state.lastError,
	});
});

api.get('/live', (_req, res) => {
	const row = statements.getLatestReading.get();
	if (!row) {
		return res.json({
			data: null,
			data_warning: null,
			explanation: null,
			message: 'No readings yet',
		});
	}

	const data = withDerivedValues(row);
	const explanation = getLiveExplanation(data);

	return res.json({
		data: {
			...data,
			explanation,
		},
		data_warning: state.liveDataWarning,
		explanation,
	});
});

api.get('/history', (req, res) => {
	const range = parseRange(req.query.from, req.query.to, 24);

	const rows = statements.getHistoryInRange.all(range.from, range.to).map(withDerivedValues);
	res.json({
		from: range.from,
		to: range.to,
		count: rows.length,
		data: rows,
	});
});

api.get('/daily', (req, res) => {
	const range = parseRange(req.query.from, req.query.to, 24 * 7);
	const readings = statements.getHistoryInRange.all(range.from, range.to);
	const daily = aggregateDailyFromReadings(readings);

	res.json(daily);
});

app.use('/api', api);

app.get('/health', (_req, res) => {
	res.redirect(307, '/api/health');
});

if (DASHBOARD_DIST_EXISTS) {
	app.use(express.static(DASHBOARD_DIST_DIR));
}

app.use((req, res, next) => {
	if (req.path.startsWith('/api')) {
		return next();
	}

	if (DASHBOARD_INDEX_EXISTS) {
		return res.sendFile(DASHBOARD_INDEX_FILE);
	}

	return res.status(503).json({
		error: 'Dashboard build not found',
		expected: DASHBOARD_INDEX_FILE,
	});
});

app.use((err, _req, res, _next) => {
	res.status(500).json({
		error: 'Internal server error',
		details: err?.message || String(err),
	});
});

app.listen(PORT, () => {
	console.log(`Solar monitor listening on http://localhost:${PORT}`);
	console.log(`Polling ${INVERTER_BASE_URL} every ${POLL_SECONDS}s`);
	if (!DASHBOARD_DIST_EXISTS || !DASHBOARD_INDEX_EXISTS) {
		console.warn(`Dashboard build not found at ${DASHBOARD_DIST_DIR}; SPA serving is disabled until it exists.`);
	}
	startPolling();
});

function initializeDatabase(database) {
	database.pragma('journal_mode = WAL');
	database.pragma('synchronous = NORMAL');

	database.exec(`
		CREATE TABLE IF NOT EXISTS readings (
			ts_utc TEXT PRIMARY KEY,
			pv_w INTEGER NOT NULL,
			load_w INTEGER NOT NULL,
			grid_import_w INTEGER NOT NULL,
			grid_export_w INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS daily_agg (
			day TEXT PRIMARY KEY,
			pv_kwh REAL,
			load_kwh REAL,
			import_kwh REAL,
			export_kwh REAL,
			self_kwh REAL
		);
	`);
}

function prepareStatements(database) {
	return {
		insertReading: database.prepare(`
			INSERT OR IGNORE INTO readings (
				ts_utc,
				pv_w,
				load_w,
				grid_import_w,
				grid_export_w
			) VALUES (?, ?, ?, ?, ?)
		`),
		getLatestReading: database.prepare(`
			SELECT ts_utc, pv_w, load_w, grid_import_w, grid_export_w
			FROM readings
			ORDER BY ts_utc DESC
			LIMIT 1
		`),
		getHistoryInRange: database.prepare(`
			SELECT ts_utc, pv_w, load_w, grid_import_w, grid_export_w
			FROM readings
			WHERE ts_utc >= ? AND ts_utc <= ?
			ORDER BY ts_utc ASC
		`),
		upsertDailyAgg: database.prepare(`
			INSERT INTO daily_agg (day, pv_kwh, load_kwh, import_kwh, export_kwh, self_kwh)
			VALUES (@day, @pv_kwh, @load_kwh, @import_kwh, @export_kwh, @self_kwh)
			ON CONFLICT(day) DO UPDATE SET
				pv_kwh = excluded.pv_kwh,
				load_kwh = excluded.load_kwh,
				import_kwh = excluded.import_kwh,
				export_kwh = excluded.export_kwh,
				self_kwh = excluded.self_kwh
		`),
		getDailyRange: database.prepare(`
			SELECT day, pv_kwh, load_kwh, import_kwh, export_kwh, self_kwh
			FROM daily_agg
			WHERE day >= ? AND day <= ?
			ORDER BY day ASC
		`),
		getReadingsForDay: database.prepare(`
			SELECT ts_utc, pv_w, load_w, grid_import_w, grid_export_w
			FROM readings
			WHERE ts_utc >= ? AND ts_utc < ?
			ORDER BY ts_utc ASC
		`),
	};
}

function parseRange(fromRaw, toRaw, fallbackHours) {
	const toDate = toRaw ? new Date(toRaw) : new Date();
	if (Number.isNaN(toDate.getTime())) {
		throw new Error('Invalid query param: to');
	}

	const fromDate = fromRaw
		? new Date(fromRaw)
		: new Date(toDate.getTime() - fallbackHours * 60 * 60 * 1000);

	if (Number.isNaN(fromDate.getTime())) {
		throw new Error('Invalid query param: from');
	}

	if (fromDate > toDate) {
		throw new Error('Invalid range: from must be <= to');
	}

	return {
		from: fromDate.toISOString(),
		to: toDate.toISOString(),
	};
}

function withDerivedValues(row) {
	const gridNet = row.grid_import_w - row.grid_export_w;
	const selfConsumed = Math.max(0, row.load_w - row.grid_import_w);

	return {
		...row,
		grid_net_w: gridNet,
		self_consumed_w: selfConsumed,
	};
}

function aggregateDailyFromReadings(rows) {
	const dailyMap = new Map();

	for (let index = 1; index < rows.length; index += 1) {
		const prev = rows[index - 1];
		const curr = rows[index];

		const prevTs = Date.parse(prev.ts_utc);
		const currTs = Date.parse(curr.ts_utc);
		if (!Number.isFinite(prevTs) || !Number.isFinite(currTs) || currTs <= prevTs) {
			continue;
		}

		const deltaSeconds = (currTs - prevTs) / 1000;
		const factor = deltaSeconds / 3600 / 1000;
		const day = curr.ts_utc.slice(0, 10);

		if (!dailyMap.has(day)) {
			dailyMap.set(day, {
				day,
				pv_kwh: 0,
				load_kwh: 0,
				import_kwh: 0,
				export_kwh: 0,
				self_kwh: 0,
			});
		}

		const bucket = dailyMap.get(day);
		const selfW = Math.max(0, prev.load_w - prev.grid_import_w);

		bucket.pv_kwh += prev.pv_w * factor;
		bucket.load_kwh += prev.load_w * factor;
		bucket.import_kwh += prev.grid_import_w * factor;
		bucket.export_kwh += prev.grid_export_w * factor;
		bucket.self_kwh += selfW * factor;
	}

	return Array.from(dailyMap.values())
		.sort((a, b) => a.day.localeCompare(b.day))
		.map((item) => ({
			day: item.day,
			pv_kwh: round3(item.pv_kwh),
			load_kwh: round3(item.load_kwh),
			import_kwh: round3(item.import_kwh),
			export_kwh: round3(item.export_kwh),
			self_kwh: round3(item.self_kwh),
		}));
}

function getLiveExplanation(reading) {
	if (reading.pv_w > 500 && reading.grid_import_w > 200 && reading.load_w > reading.pv_w) {
		return `Importing because load (${reading.load_w}W) exceeds solar (${reading.pv_w}W).`;
	}

	if (reading.grid_export_w > 0) {
		return `Exporting surplus solar (${reading.grid_export_w}W).`;
	}

	if (reading.grid_import_w > 0) {
		return `Importing from grid (${reading.grid_import_w}W).`;
	}

	return null;
}

function startPolling() {
	pollOnce();
	setInterval(() => {
		pollOnce();
	}, POLL_SECONDS * 1000);
}

async function pollOnce() {
	if (state.pollingInProgress) {
		console.log('[poll] skipped: previous poll still in progress');
		return;
	}

	state.pollingInProgress = true;
	state.lastPollAtUtc = new Date().toISOString();
	console.log(`[poll] start ${state.lastPollAtUtc}`);

	try {
		const reading = await fetchPowerFlowReading(INVERTER_BASE_URL);
		const insertResult = statements.insertReading.run(
			reading.ts_utc,
			reading.pv_w,
			reading.load_w,
			reading.grid_import_w,
			reading.grid_export_w,
		);
		console.log(
			`[poll] parsed ts=${reading.ts_utc} pv=${reading.pv_w}W load=${reading.load_w}W import=${reading.grid_import_w}W export=${reading.grid_export_w}W`,
		);

		state.lastSuccessAtUtc = new Date().toISOString();
		state.lastError = null;
		state.lastReadingTsUtc = reading.ts_utc;

		if (reading.pv_w > 0 && reading.load_w === 0) {
			state.consecutiveZeroLoadWithPv += 1;
		} else {
			state.consecutiveZeroLoadWithPv = 0;
		}

		state.liveDataWarning = getDataWarning(reading, state.consecutiveZeroLoadWithPv);

		if (insertResult.changes > 0) {
			console.log(`[db] inserted reading ${reading.ts_utc}`);
			recomputeDailyAggForRange(db, statements, reading.ts_utc, reading.ts_utc);
		} else {
			console.log(`[db] skipped duplicate reading ${reading.ts_utc}`);
		}
	} catch (error) {
		state.lastError = error?.message || String(error);
		console.error('Poll failed:', error);
	} finally {
		state.pollingInProgress = false;
	}
}

async function fetchPowerFlowReading(baseUrl) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);

	try {
		const url = `${baseUrl}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`;
		console.log(`[poll] fetch ${url}`);
		const response = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) {
			throw new Error(`Fronius API error: HTTP ${response.status}`);
		}

		const payload = await response.json();
		console.log(JSON.stringify(payload.Body.Data, null, 2));
		return parseFroniusPayload(payload);
	} finally {
		clearTimeout(timeout);
	}
}

function parseFroniusPayload(payload) {
	const body = payload?.Body;
	const head = payload?.Head;
	const data = body?.Data;
	const site = data?.Site || {};

	const inverterMap = data?.Inverters || {};
	const inverter1Pv = inverterMap?.['1']?.P;
	const inverterPvSum = Object.values(inverterMap).reduce((sum, item) => {
		return sum + safeNumber(item?.P, 0);
	}, 0);

	const pvSource = [site.P_PV, inverter1Pv, data?.P_PV, inverterPvSum].find((value) => Number.isFinite(Number(value)));
	const loadSource = [site.P_Load, data?.P_Load].find((value) => Number.isFinite(Number(value)));
	const gridSource = [site.P_Grid].find((value) => Number.isFinite(Number(value)));

	const tsSource = head?.Timestamp || new Date().toISOString();
	const tsUtc = new Date(tsSource).toISOString();

	const pvW = Math.max(0, Math.round(safeNumber(pvSource, 0)));
	// Some Fronius payloads report load as negative by convention; use absolute watts for household consumption.
	const loadW = Math.max(0, Math.round(Math.abs(safeNumber(loadSource, 0))));

	const gridNetW = gridSource !== undefined
		? Math.round(safeNumber(gridSource, 0))
		: Math.round(loadW - pvW);

	const gridImportW = Math.max(0, gridNetW);
	const gridExportW = Math.max(0, -gridNetW);

	return {
		ts_utc: tsUtc,
		pv_w: pvW,
		load_w: loadW,
		grid_import_w: gridImportW,
		grid_export_w: gridExportW,
	};
}

function safeNumber(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function getDataWarning(reading, consecutiveZeroLoadWithPv) {
	if (consecutiveZeroLoadWithPv > 5) {
		return 'pv_w > 0 and load_w === 0 for more than 5 consecutive polls';
	}

	if (reading.load_w > reading.pv_w && reading.grid_export_w > 0) {
		return 'load_w > pv_w and grid_export_w > 0';
	}

	if (reading.grid_import_w > 0 && reading.grid_export_w > 0) {
		return 'grid_import_w > 0 and grid_export_w > 0';
	}

	return null;
}

function recomputeDailyAggForRange(database, prepared, fromIsoUtc, toIsoUtc) {
	const fromDay = fromIsoUtc.slice(0, 10);
	const toDay = toIsoUtc.slice(0, 10);
	const days = enumerateDays(fromDay, toDay);

	const tx = database.transaction((dayList) => {
		for (const day of dayList) {
			const dayStart = `${day}T00:00:00.000Z`;
			const nextDay = addDaysIso(day, 1);
			const dayEnd = `${nextDay}T00:00:00.000Z`;
			const rows = prepared.getReadingsForDay.all(dayStart, dayEnd);
			const agg = computeEnergyAggForRows(rows);
			prepared.upsertDailyAgg.run({ day, ...agg });
		}
	});

	tx(days);
}

function computeEnergyAggForRows(rows) {
	if (!rows || rows.length < 2) {
		return {
			pv_kwh: 0,
			load_kwh: 0,
			import_kwh: 0,
			export_kwh: 0,
			self_kwh: 0,
		};
	}

	let pvWh = 0;
	let loadWh = 0;
	let importWh = 0;
	let exportWh = 0;
	let selfWh = 0;

	for (let index = 0; index < rows.length - 1; index += 1) {
		const current = rows[index];
		const next = rows[index + 1];

		const t1 = Date.parse(current.ts_utc);
		const t2 = Date.parse(next.ts_utc);
		if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 <= t1) {
			continue;
		}

		const hours = (t2 - t1) / 3600000;

		const pvAvg = (current.pv_w + next.pv_w) / 2;
		const loadAvg = (current.load_w + next.load_w) / 2;
		const importAvg = (current.grid_import_w + next.grid_import_w) / 2;
		const exportAvg = (current.grid_export_w + next.grid_export_w) / 2;
		const selfAvg = Math.max(0, loadAvg - importAvg);

		pvWh += pvAvg * hours;
		loadWh += loadAvg * hours;
		importWh += importAvg * hours;
		exportWh += exportAvg * hours;
		selfWh += selfAvg * hours;
	}

	return {
		pv_kwh: round3(pvWh / 1000),
		load_kwh: round3(loadWh / 1000),
		import_kwh: round3(importWh / 1000),
		export_kwh: round3(exportWh / 1000),
		self_kwh: round3(selfWh / 1000),
	};
}

function round3(value) {
	return Math.round(value * 1000) / 1000;
}

function enumerateDays(fromDay, toDay) {
	const list = [];
	let cursor = fromDay;
	while (cursor <= toDay) {
		list.push(cursor);
		cursor = addDaysIso(cursor, 1);
	}
	return list;
}

function addDaysIso(day, daysToAdd) {
	const date = new Date(`${day}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + daysToAdd);
	return date.toISOString().slice(0, 10);
}

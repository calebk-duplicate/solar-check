const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const cors = require('cors');
const express = require('express');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

const DEFAULT_DAILY_FIXED_CENTS = 0;
const DEFAULT_TIMEZONE = 'Pacific/Auckland';
const DEFAULT_IMPORT_PERIODS = [
	{ days: 'all', start: '00:00', end: '21:00', cents_per_kwh: 32 },
	{ days: 'all', start: '21:00', end: '24:00', cents_per_kwh: 0 },
];
const DEFAULT_EXPORT_PERIODS = [
	{ days: 'all', start: '00:00', end: '24:00', cents_per_kwh: 12 },
];

const INVERTER_BASE_URL = (process.env.INVERTER_BASE_URL || '').replace(/\/$/, '');
const POLL_SECONDS = Number.parseInt(process.env.POLL_SECONDS || '15', 10);
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const ARCHIVE_BACKFILL_MINUTES = Number.parseInt(process.env.ARCHIVE_BACKFILL_MINUTES || '30', 10);
const ARCHIVE_LOOKBACK_DAYS = Number.parseInt(process.env.ARCHIVE_LOOKBACK_DAYS || '2', 10);

if (!INVERTER_BASE_URL) {
	throw new Error('Missing required environment variable: INVERTER_BASE_URL');
}

if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS <= 0) {
	throw new Error('POLL_SECONDS must be a positive integer');
}

if (!Number.isFinite(PORT) || PORT <= 0) {
	throw new Error('PORT must be a positive integer');
}

if (!Number.isFinite(ARCHIVE_BACKFILL_MINUTES) || ARCHIVE_BACKFILL_MINUTES <= 0) {
	throw new Error('ARCHIVE_BACKFILL_MINUTES must be a positive integer');
}

if (!Number.isFinite(ARCHIVE_LOOKBACK_DAYS) || ARCHIVE_LOOKBACK_DAYS <= 0) {
	throw new Error('ARCHIVE_LOOKBACK_DAYS must be a positive integer');
}

const app = express();
app.use(cors());
app.use(express.json());
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
	lastArchiveBackfillAtUtc: null,
	lastArchiveBackfillError: null,
	pollingInProgress: false,
	archiveBackfillInProgress: false,
	consecutiveZeroLoadWithPv: 0,
	liveDataWarning: null,
};

initializeDatabase(db);

const statements = prepareStatements(db);
ensureDefaultSettings(statements);

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
		last_archive_backfill_at_utc: state.lastArchiveBackfillAtUtc,
		last_archive_backfill_error: state.lastArchiveBackfillError,
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

	const rates = getRatesSettings(statements);
	const nowLocal = DateTime.now().setZone(rates.timezone);
	const hhmm = nowLocal.isValid ? nowLocal.toFormat('HH:mm') : '00:00';
	const dayGroup = nowLocal.isValid ? dayGroupFromLocalDateTime(nowLocal) : 'weekday';
	const importRate = findRateForTime(rates.import_periods, dayGroup, hhmm);
	const exportRate = findRateForTime(rates.export_periods, dayGroup, hhmm);
	const importCostPerHour = (row.grid_import_w / 1000) * importRate;
	const exportCreditPerHour = (row.grid_export_w / 1000) * exportRate;
	const netCostPerHour = importCostPerHour - exportCreditPerHour + rates.daily_fixed_cents / 24;

	const data = withDerivedValues(row);
	const explanation = getLiveExplanation(data);

	return res.json({
		data: {
			...data,
			import_cost_per_hour: round3(importCostPerHour),
			export_credit_per_hour: round3(exportCreditPerHour),
			net_cost_per_hour: round3(netCostPerHour),
			explanation,
		},
		data_warning: state.liveDataWarning,
		explanation,
	});
});

api.get('/rates', (_req, res) => {
	const rates = getRatesSettings(statements);
	res.json(rates);
});

api.put('/rates', (req, res) => {
	try {
		if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
			return res.status(400).json({ error: 'Request body must be a JSON object' });
		}

		const current = getRatesSettings(statements);
		const next = { ...current };

		if (Object.prototype.hasOwnProperty.call(req.body, 'daily_fixed_cents')) {
			const dailyFixed = Number(req.body.daily_fixed_cents);
			if (!Number.isFinite(dailyFixed) || dailyFixed < 0) {
				return res.status(400).json({ error: 'daily_fixed_cents must be a number >= 0' });
			}
			next.daily_fixed_cents = dailyFixed;
		}

		if (Object.prototype.hasOwnProperty.call(req.body, 'timezone')) {
			if (typeof req.body.timezone !== 'string' || !isValidTimezone(req.body.timezone)) {
				return res.status(400).json({ error: 'timezone must be a valid IANA timezone string' });
			}
			next.timezone = req.body.timezone;
		}

		if (Object.prototype.hasOwnProperty.call(req.body, 'import_periods')) {
			next.import_periods = validateRatePeriods(req.body.import_periods, 'import_periods');
		}

		if (Object.prototype.hasOwnProperty.call(req.body, 'export_periods')) {
			next.export_periods = validateRatePeriods(req.body.export_periods, 'export_periods');
		}

		statements.upsertSetting.run('daily_fixed_cents', JSON.stringify(next.daily_fixed_cents));
		statements.upsertSetting.run('timezone', JSON.stringify(next.timezone));
		statements.upsertSetting.run('import_periods_json', JSON.stringify(next.import_periods));
		statements.upsertSetting.run('export_periods_json', JSON.stringify(next.export_periods));

		return res.json(next);
	} catch (error) {
		return res.status(400).json({ error: error?.message || String(error) });
	}
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

api.get('/bill', (req, res) => {
	try {
		const range = parseRange(req.query.from, req.query.to, 24 * 7);
		const rates = getRatesSettings(statements);
		const sourceQuery = req.query.source;

		if (sourceQuery === 'energy_5m') {
			const energyRows = statements.getEnergy5mInRange.all(range.from, range.to);
			if (energyRows.length < 1) {
				return res.status(400).json({
					error: 'No energy_5m data found for requested range',
				});
			}

			const bill = aggregateBillFromEnergyBuckets(energyRows, rates, range.from, range.to);
			return res.json({ ...bill, source: 'energy_5m' });
		}

		if (sourceQuery === 'readings') {
			const readings = statements.getHistoryInRange.all(range.from, range.to);
			const bill = aggregateBillFromReadings(readings, rates, range.from, range.to);
			return res.json({ ...bill, source: 'readings' });
		}

		if (sourceQuery !== undefined && sourceQuery !== null && sourceQuery !== '') {
			return res.status(400).json({
				error: 'Invalid source query param; expected readings|energy_5m',
			});
		}

		const energyRows = statements.getEnergy5mInRange.all(range.from, range.to);
		if (energyRows.length >= 1) {
			const bill = aggregateBillFromEnergyBuckets(energyRows, rates, range.from, range.to);
			return res.json({ ...bill, source: 'energy_5m' });
		}

		const readings = statements.getHistoryInRange.all(range.from, range.to);
		const bill = aggregateBillFromReadings(readings, rates, range.from, range.to);
		return res.json({ ...bill, source: 'readings' });
	} catch (error) {
		return res.status(400).json({ error: error?.message || String(error) });
	}
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

app.listen(PORT, '0.0.0.0', () => {
	console.log(`Solar monitor listening on http://0.0.0.0:${PORT}`);
	console.log(`Polling ${INVERTER_BASE_URL} every ${POLL_SECONDS}s`);
	if (!DASHBOARD_DIST_EXISTS || !DASHBOARD_INDEX_EXISTS) {
		console.warn(`Dashboard build not found at ${DASHBOARD_DIST_DIR}; SPA serving is disabled until it exists.`);
	}
	startPolling();
	startArchiveBackfill();
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

		CREATE TABLE IF NOT EXISTS energy_5m (
			ts_utc TEXT PRIMARY KEY,
			import_wh REAL NOT NULL,
			export_wh REAL NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_energy_5m_ts_utc ON energy_5m(ts_utc);

		CREATE TABLE IF NOT EXISTS daily_agg (
			day TEXT PRIMARY KEY,
			pv_kwh REAL,
			load_kwh REAL,
			import_kwh REAL,
			export_kwh REAL,
			self_kwh REAL
		);

		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
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
		upsertEnergy5m: database.prepare(`
			INSERT INTO energy_5m (ts_utc, import_wh, export_wh)
			VALUES (@ts_utc, @import_wh, @export_wh)
			ON CONFLICT(ts_utc) DO UPDATE SET
				import_wh = excluded.import_wh,
				export_wh = excluded.export_wh
		`),
		getEnergy5mInRange: database.prepare(`
			SELECT ts_utc, import_wh, export_wh
			FROM energy_5m
			WHERE ts_utc >= ? AND ts_utc <= ?
			ORDER BY ts_utc ASC
		`),
		getLatestEnergy5mTs: database.prepare(`
			SELECT ts_utc
			FROM energy_5m
			ORDER BY ts_utc DESC
			LIMIT 1
		`),
		getSetting: database.prepare(`
			SELECT value
			FROM settings
			WHERE key = ?
		`),
		upsertSetting: database.prepare(`
			INSERT INTO settings (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET
				value = excluded.value
		`),
	};
}

function ensureDefaultSettings(prepared) {
	const defaults = [
		['daily_fixed_cents', JSON.stringify(DEFAULT_DAILY_FIXED_CENTS)],
		['timezone', JSON.stringify(DEFAULT_TIMEZONE)],
		['import_periods_json', JSON.stringify(DEFAULT_IMPORT_PERIODS)],
		['export_periods_json', JSON.stringify(DEFAULT_EXPORT_PERIODS)],
	];

	for (const [key, defaultValue] of defaults) {
		const existing = prepared.getSetting.get(key);
		if (!existing) {
			prepared.upsertSetting.run(key, defaultValue);
		}
	}
}

function getRatesSettings(prepared) {
	const dailyFixedRaw = parseJsonSetting(prepared.getSetting.get('daily_fixed_cents')?.value, DEFAULT_DAILY_FIXED_CENTS);
	const timezoneRaw = parseJsonSetting(prepared.getSetting.get('timezone')?.value, DEFAULT_TIMEZONE);
	const importRaw = parseJsonSetting(prepared.getSetting.get('import_periods_json')?.value, DEFAULT_IMPORT_PERIODS);
	const exportRaw = parseJsonSetting(prepared.getSetting.get('export_periods_json')?.value, DEFAULT_EXPORT_PERIODS);

	const dailyFixed = Number(dailyFixedRaw);
	const timezone = typeof timezoneRaw === 'string' && isValidTimezone(timezoneRaw) ? timezoneRaw : DEFAULT_TIMEZONE;

	return {
		daily_fixed_cents: Number.isFinite(dailyFixed) && dailyFixed >= 0 ? dailyFixed : DEFAULT_DAILY_FIXED_CENTS,
		timezone,
		import_periods: validateRatePeriods(importRaw, 'import_periods'),
		export_periods: validateRatePeriods(exportRaw, 'export_periods'),
	};
}

function parseJsonSetting(rawValue, fallback) {
	if (typeof rawValue !== 'string') {
		return fallback;
	}

	try {
		return JSON.parse(rawValue);
	} catch {
		return fallback;
	}
}

function isValidTimezone(zone) {
	return DateTime.now().setZone(zone).isValid;
}

function validateRatePeriods(periods, label) {
	if (!Array.isArray(periods) || periods.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}

	const normalized = periods.map((period, index) => {
		if (!period || typeof period !== 'object') {
			throw new Error(`${label}[${index}] must be an object`);
		}

		const days = normalizeDayGroup(period.days);
		const { start, end } = period;
		const cents = Number(period.cents_per_kwh);
		if (typeof start !== 'string' || typeof end !== 'string') {
			throw new Error(`${label}[${index}] start and end must be HH:mm strings`);
		}
		if (!Number.isFinite(cents) || cents < 0) {
			throw new Error(`${label}[${index}] cents_per_kwh must be >= 0`);
		}

		const startMinutes = parseTimeToMinutes(start, false);
		const endMinutes = parseTimeToMinutes(end, true);
		if (endMinutes <= startMinutes) {
			throw new Error(`${label}[${index}] end must be after start`);
		}

		return {
			days,
			start,
			end,
			cents_per_kwh: cents,
		};
	});

	for (const dayGroup of ['all', 'weekday', 'weekend']) {
		const sorted = normalized
			.filter((period) => period.days === dayGroup)
			.map((period) => ({
				start: parseTimeToMinutes(period.start, false),
				end: parseTimeToMinutes(period.end, true),
			}))
			.sort((a, b) => a.start - b.start);

		for (let index = 1; index < sorted.length; index += 1) {
			if (sorted[index - 1].end > sorted[index].start) {
				console.warn(`[rates] ${label} contains overlapping periods for ${dayGroup}; first matching period will be used`);
				break;
			}
		}
	}

	return normalized;
}

function normalizeDayGroup(days) {
	if (days === undefined || days === null || days === '') {
		return 'all';
	}

	if (days !== 'all' && days !== 'weekday' && days !== 'weekend') {
		throw new Error(`Invalid days value: ${days}; expected all|weekday|weekend`);
	}

	return days;
}

function parseTimeToMinutes(hhmm, allow2400) {
	if (!/^\d{2}:\d{2}$/.test(hhmm)) {
		throw new Error(`Invalid time format: ${hhmm}; expected HH:mm`);
	}

	const [hourRaw, minuteRaw] = hhmm.split(':');
	const hour = Number(hourRaw);
	const minute = Number(minuteRaw);

	if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
		throw new Error(`Invalid time value: ${hhmm}`);
	}

	if (allow2400 && hour === 24 && minute === 0) {
		return 24 * 60;
	}

	if (hour < 0 || hour > 23) {
		throw new Error(`Invalid hour in time: ${hhmm}`);
	}

	return hour * 60 + minute;
}

function findRateForTime(periods, dayGroup, hhmm) {
	const timeMinutes = parseTimeToMinutes(hhmm, false);
	const exactMatchRate = findRateForDayGroup(periods, dayGroup, timeMinutes);
	if (exactMatchRate !== null) {
		return exactMatchRate;
	}

	const allDaysRate = findRateForDayGroup(periods, 'all', timeMinutes);
	if (allDaysRate !== null) {
		return allDaysRate;
	}

	return Number(periods[periods.length - 1].cents_per_kwh);
}

function findRateForDayGroup(periods, dayGroup, timeMinutes) {
	for (const period of periods) {
		if (normalizeDayGroup(period.days) !== dayGroup) {
			continue;
		}

		const startMinutes = parseTimeToMinutes(period.start, false);
		const endMinutes = parseTimeToMinutes(period.end, true);
		if (timeMinutes >= startMinutes && timeMinutes < endMinutes) {
			return Number(period.cents_per_kwh);
		}
	}

	return null;
}

function dayGroupFromLocalDateTime(localDateTime) {
	return localDateTime.weekday === 6 || localDateTime.weekday === 7 ? 'weekend' : 'weekday';
}

function aggregateBillFromReadings(rows, rates, fromUtc, toUtc) {
	const timezone = rates.timezone;
	const dailyMap = new Map();

	for (const dayLocal of enumerateLocalDaysInRange(fromUtc, toUtc, timezone)) {
		dailyMap.set(dayLocal, {
			day_local: dayLocal,
			import_kwh: 0,
			export_kwh: 0,
			import_cost: 0,
			export_credit: 0,
			fixed_charge: Number(rates.daily_fixed_cents),
			net_cost: 0,
		});
	}

	const rateBoundaryMinutes = collectRateBoundaryMinutes(rates);

	if (rows && rows.length >= 2) {
		for (let index = 1; index < rows.length; index += 1) {
			const prev = rows[index - 1];
			const curr = rows[index];

			const prevUtc = DateTime.fromISO(prev.ts_utc, { zone: 'utc' });
			const currUtc = DateTime.fromISO(curr.ts_utc, { zone: 'utc' });
			if (!prevUtc.isValid || !currUtc.isValid || currUtc <= prevUtc) {
				continue;
			}

			const importW = Math.max(0, Number(prev.grid_import_w) || 0);
			const exportW = Math.max(0, Number(prev.grid_export_w) || 0);

			let cursorUtc = prevUtc;
			while (cursorUtc < currUtc) {
				const cursorLocal = cursorUtc.setZone(timezone);
				if (!cursorLocal.isValid) {
					break;
				}

				const nextBoundaryUtc = nextBillBoundaryUtc(cursorLocal, rateBoundaryMinutes);
				const segmentEndUtc = nextBoundaryUtc < currUtc ? nextBoundaryUtc : currUtc;
				if (!(segmentEndUtc > cursorUtc)) {
					break;
				}

				const dayLocal = cursorLocal.toFormat('yyyy-LL-dd');
				if (!dailyMap.has(dayLocal)) {
					dailyMap.set(dayLocal, {
						day_local: dayLocal,
						import_kwh: 0,
						export_kwh: 0,
						import_cost: 0,
						export_credit: 0,
						fixed_charge: Number(rates.daily_fixed_cents),
						net_cost: 0,
					});
				}

				const hours = segmentEndUtc.diff(cursorUtc, 'hours').hours;
				if (hours > 0) {
					const dayGroup = dayGroupFromLocalDateTime(cursorLocal);
					const hhmm = cursorLocal.toFormat('HH:mm');
					const importRate = findRateForTime(rates.import_periods, dayGroup, hhmm);
					const exportRate = findRateForTime(rates.export_periods, dayGroup, hhmm);

					const importKwh = (importW / 1000) * hours;
					const exportKwh = (exportW / 1000) * hours;

					const bucket = dailyMap.get(dayLocal);
					bucket.import_kwh += importKwh;
					bucket.export_kwh += exportKwh;
					bucket.import_cost += importKwh * importRate;
					bucket.export_credit += exportKwh * exportRate;
				}

				cursorUtc = segmentEndUtc;
			}
		}
	}

	const days = Array.from(dailyMap.values())
		.sort((a, b) => a.day_local.localeCompare(b.day_local))
		.map((item) => {
			const netCost = item.import_cost - item.export_credit + item.fixed_charge;
			return {
				day_local: item.day_local,
				import_kwh: round3(item.import_kwh),
				export_kwh: round3(item.export_kwh),
				import_cost: round3(item.import_cost),
				export_credit: round3(item.export_credit),
				fixed_charge: round3(item.fixed_charge),
				net_cost: round3(netCost),
			};
		});

	const summary = {
		from_utc: fromUtc,
		to_utc: toUtc,
		days: days.length,
		total_import_kwh: round3(days.reduce((sum, day) => sum + day.import_kwh, 0)),
		total_export_kwh: round3(days.reduce((sum, day) => sum + day.export_kwh, 0)),
		total_import_cost: round3(days.reduce((sum, day) => sum + day.import_cost, 0)),
		total_export_credit: round3(days.reduce((sum, day) => sum + day.export_credit, 0)),
		total_fixed_charge: round3(days.reduce((sum, day) => sum + day.fixed_charge, 0)),
		total_net_cost: round3(days.reduce((sum, day) => sum + day.net_cost, 0)),
	};

	return {
		summary,
		days,
	};
}

function aggregateBillFromEnergyBuckets(rows, rates, fromUtc, toUtc) {
	const timezone = rates.timezone;
	const dailyMap = new Map();

	for (const dayLocal of enumerateLocalDaysInRange(fromUtc, toUtc, timezone)) {
		dailyMap.set(dayLocal, {
			day_local: dayLocal,
			import_kwh: 0,
			export_kwh: 0,
			import_cost: 0,
			export_credit: 0,
			fixed_charge: Number(rates.daily_fixed_cents),
			net_cost: 0,
		});
	}

	for (const row of rows || []) {
		const utc = DateTime.fromISO(row.ts_utc, { zone: 'utc' });
		if (!utc.isValid) {
			continue;
		}

		const local = utc.setZone(timezone);
		if (!local.isValid) {
			continue;
		}

		const dayLocal = local.toFormat('yyyy-LL-dd');
		if (!dailyMap.has(dayLocal)) {
			dailyMap.set(dayLocal, {
				day_local: dayLocal,
				import_kwh: 0,
				export_kwh: 0,
				import_cost: 0,
				export_credit: 0,
				fixed_charge: Number(rates.daily_fixed_cents),
				net_cost: 0,
			});
		}

		const dayGroup = dayGroupFromLocalDateTime(local);
		const hhmm = local.toFormat('HH:mm');
		const importRate = findRateForTime(rates.import_periods, dayGroup, hhmm);
		const exportRate = findRateForTime(rates.export_periods, dayGroup, hhmm);

		const importKwh = Math.max(0, Number(row.import_wh) || 0) / 1000;
		const exportKwh = Math.max(0, Number(row.export_wh) || 0) / 1000;

		const bucket = dailyMap.get(dayLocal);
		bucket.import_kwh += importKwh;
		bucket.export_kwh += exportKwh;
		bucket.import_cost += importKwh * importRate;
		bucket.export_credit += exportKwh * exportRate;
	}

	const days = Array.from(dailyMap.values())
		.sort((a, b) => a.day_local.localeCompare(b.day_local))
		.map((item) => {
			const netCost = item.import_cost - item.export_credit + item.fixed_charge;
			return {
				day_local: item.day_local,
				import_kwh: round3(item.import_kwh),
				export_kwh: round3(item.export_kwh),
				import_cost: round3(item.import_cost),
				export_credit: round3(item.export_credit),
				fixed_charge: round3(item.fixed_charge),
				net_cost: round3(netCost),
			};
		});

	const summary = {
		from_utc: fromUtc,
		to_utc: toUtc,
		days: days.length,
		total_import_kwh: round3(days.reduce((sum, day) => sum + day.import_kwh, 0)),
		total_export_kwh: round3(days.reduce((sum, day) => sum + day.export_kwh, 0)),
		total_import_cost: round3(days.reduce((sum, day) => sum + day.import_cost, 0)),
		total_export_credit: round3(days.reduce((sum, day) => sum + day.export_credit, 0)),
		total_fixed_charge: round3(days.reduce((sum, day) => sum + day.fixed_charge, 0)),
		total_net_cost: round3(days.reduce((sum, day) => sum + day.net_cost, 0)),
	};

	return {
		summary,
		days,
	};
}

function enumerateLocalDaysInRange(fromUtc, toUtc, timezone) {
	const fromLocal = DateTime.fromISO(fromUtc, { zone: 'utc' }).setZone(timezone);
	const toLocal = DateTime.fromISO(toUtc, { zone: 'utc' }).setZone(timezone);
	if (!fromLocal.isValid || !toLocal.isValid || toLocal < fromLocal) {
		return [];
	}

	const days = [];
	let cursor = fromLocal.startOf('day');
	const end = toLocal.startOf('day');

	while (cursor <= end) {
		days.push(cursor.toFormat('yyyy-LL-dd'));
		cursor = cursor.plus({ days: 1 });
	}

	return days;
}

function collectRateBoundaryMinutes(rates) {
	const boundaries = new Set();
	const addBoundary = (hhmm, allow2400) => {
		const minute = parseTimeToMinutes(hhmm, allow2400);
		if (minute > 0 && minute < 24 * 60) {
			boundaries.add(minute);
		}
	};

	for (const period of rates.import_periods) {
		addBoundary(period.start, false);
		addBoundary(period.end, true);
	}

	for (const period of rates.export_periods) {
		addBoundary(period.start, false);
		addBoundary(period.end, true);
	}

	return Array.from(boundaries).sort((a, b) => a - b);
}

function nextBillBoundaryUtc(localDateTime, boundaryMinutes) {
	const dayStart = localDateTime.startOf('day');
	const currentMinute = localDateTime.hour * 60 + localDateTime.minute;

	for (const minute of boundaryMinutes) {
		if (minute <= currentMinute) {
			continue;
		}

		const candidateLocal = dayStart.plus({ minutes: minute });
		if (candidateLocal.isValid) {
			return candidateLocal.setZone('utc');
		}
	}

	return dayStart.plus({ days: 1 }).setZone('utc');
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

function startArchiveBackfill() {
	backfillArchiveOnce();
	setInterval(() => {
		backfillArchiveOnce();
	}, ARCHIVE_BACKFILL_MINUTES * 60 * 1000);
}

async function backfillArchiveOnce() {
	if (state.archiveBackfillInProgress) {
		console.log('[archive] skipped: previous backfill still in progress');
		return;
	}

	state.archiveBackfillInProgress = true;
	state.lastArchiveBackfillAtUtc = new Date().toISOString();

	try {
		const rates = getRatesSettings(statements);
		const timezone = rates.timezone;
		const nowLocal = DateTime.now().setZone(timezone);
		if (!nowLocal.isValid) {
			throw new Error(`Invalid timezone for archive backfill: ${timezone}`);
		}

		const localStart = nowLocal.minus({ days: ARCHIVE_LOOKBACK_DAYS - 1 }).startOf('day');
		const localEnd = nowLocal.endOf('day');

		const startLocalIso = localStart.toISO();
		const endLocalIso = localEnd.toISO();
		if (!startLocalIso || !endLocalIso) {
			throw new Error('Failed to compute archive backfill range');
		}

		const buckets = await fetchArchiveEnergyBuckets(INVERTER_BASE_URL, startLocalIso, endLocalIso);
		const secondsPerDay = 24 * 60 * 60;
		let upsertedCount = 0;

		for (const bucket of buckets) {
			const totalOffsetSeconds = Number.parseInt(String(bucket.offset_seconds), 10);
			if (!Number.isInteger(totalOffsetSeconds) || totalOffsetSeconds < 0) {
				continue;
			}

			const dayOffset = Math.floor(totalOffsetSeconds / secondsPerDay);
			const secondsIntoDay = totalOffsetSeconds % secondsPerDay;
			const bucketDayStartLocal = localStart.plus({ days: dayOffset }).startOf('day');
			const bucketLocal = bucketDayStartLocal.plus({ seconds: secondsIntoDay });
			if (!bucketLocal.isValid) {
				continue;
			}

			const tsUtc = bucketLocal.toUTC().toISO();
			if (!tsUtc) {
				continue;
			}

			const result = statements.upsertEnergy5m.run({
				ts_utc: tsUtc,
				import_wh: bucket.import_wh,
				export_wh: bucket.export_wh,
			});

			if (result.changes > 0) {
				upsertedCount += 1;
			}
		}

		state.lastArchiveBackfillError = null;
		state.lastArchiveBackfillAtUtc = new Date().toISOString();
		console.log(
			`[archive] upserted ${upsertedCount} buckets for ${startLocalIso} -> ${endLocalIso} (${timezone})`,
		);
	} catch (error) {
		state.lastArchiveBackfillError = error?.message || String(error);
		state.lastArchiveBackfillAtUtc = new Date().toISOString();
		console.error('Archive backfill failed:', error);
	} finally {
		state.archiveBackfillInProgress = false;
	}
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

async function fetchArchiveEnergyBuckets(baseUrl, startLocalIso, endLocalIso) {
	const buckets = await fetchArchiveDetail(baseUrl, startLocalIso, endLocalIso);
	return buckets.map((bucket) => ({
		offset_seconds: bucket.offsetSeconds,
		import_wh: bucket.importWh,
		export_wh: bucket.exportWh,
	}));
}

async function fetchArchiveDetail(baseUrl, startLocalIso, endLocalIso) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15000);

	try {
		const url = new URL(`${baseUrl}/solar_api/v1/GetArchiveData.cgi`);
		url.searchParams.append('Scope', 'System');
		url.searchParams.append('SeriesType', 'Detail');
		url.searchParams.append('HumanReadable', 'True');
		url.searchParams.append('StartDate', startLocalIso);
		url.searchParams.append('EndDate', endLocalIso);
		url.searchParams.append('Channel', 'EnergyReal_WAC_Sum_Consumed');
		url.searchParams.append('Channel', 'EnergyReal_WAC_Sum_Produced');

		const response = await fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: { Accept: 'application/json' },
		});

		if (response.status !== 200) {
			throw new Error(`Fronius archive API error: HTTP ${response.status}`);
		}

		const payload = await response.json();
		const statusCode = Number(payload?.Head?.Status?.Code);
		if (!Number.isFinite(statusCode) || statusCode !== 0) {
			const statusReason = payload?.Head?.Status?.Reason;
			throw new Error(`Fronius archive API status error: ${payload?.Head?.Status?.Code}${statusReason ? ` ${statusReason}` : ''}`);
		}

		return parseArchiveDetail(payload);
	} finally {
		clearTimeout(timeout);
	}
}

function parseFroniusArchiveDetail(payload) {
	const buckets = parseArchiveDetail(payload);
	return buckets.map((bucket) => ({
		offset_seconds: bucket.offsetSeconds,
		import_wh: bucket.importWh,
		export_wh: bucket.exportWh,
	}));
}

function parseArchiveDetail(payload) {
	const bodyData = payload?.Body?.Data;
	if (!bodyData || typeof bodyData !== 'object') {
		throw new Error('Invalid archive payload: missing Body.Data');
	}

	const firstNode = Object.values(bodyData).find((node) => node && typeof node === 'object');
	if (!firstNode || typeof firstNode !== 'object') {
		throw new Error('Invalid archive payload: no data nodes in Body.Data');
	}

	const nodeData = firstNode.Data;
	if (!nodeData || typeof nodeData !== 'object') {
		throw new Error('Invalid archive payload: node missing Data');
	}

	const consumedSeries = nodeData.EnergyReal_WAC_Sum_Consumed;
	const producedSeries = nodeData.EnergyReal_WAC_Sum_Produced;

	if (consumedSeries?.Unit !== undefined && consumedSeries.Unit !== 'Wh') {
		throw new Error(`Invalid unit for EnergyReal_WAC_Sum_Consumed: ${consumedSeries.Unit}`);
	}

	if (producedSeries?.Unit !== undefined && producedSeries.Unit !== 'Wh') {
		throw new Error(`Invalid unit for EnergyReal_WAC_Sum_Produced: ${producedSeries.Unit}`);
	}

	const consumedValues = consumedSeries?.Values && typeof consumedSeries.Values === 'object' ? consumedSeries.Values : {};
	const producedValues = producedSeries?.Values && typeof producedSeries.Values === 'object' ? producedSeries.Values : {};

	const offsets = new Set([...Object.keys(consumedValues), ...Object.keys(producedValues)]);
	const buckets = Array.from(offsets)
		.map((offsetKey) => {
			const offsetSeconds = Number.parseInt(offsetKey, 10);
			if (!Number.isInteger(offsetSeconds) || offsetSeconds < 0) {
				return null;
			}

			const importWh = safeNumber(consumedValues[offsetKey], 0);
			const exportWh = safeNumber(producedValues[offsetKey], 0);

			return {
				offsetSeconds,
				importWh,
				exportWh,
			};
		})
		.filter((bucket) => bucket !== null)
		.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

	return buckets;
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

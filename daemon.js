const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { loadConfig, saveConfig } = require('./config');
const { startBot, sendWebhookUpdate } = require('./discord_utils');

const PORT = 3000;
const LOG_FILE = path.join(__dirname, 'daemon.log');

// --- STATE MANAGEMENT ---
const STATE = {
    IDLE: 'IDLE',
    RUNNING: 'RUNNING',
    QUEUED: 'QUEUED',
    CANCELLING: 'CANCELLING'
};

let systemState = STATE.IDLE;
let currentJob = null; // { id, initiator, startTime, process, promiseResolve, promiseReject }
let jobQueue = []; // Array of { id, initiator, resolve, reject }
let manualRunTimestamps = []; // For rate limiting
let executionHistory = []; // { id, initiator, startTime, duration, status, error }
let serverInstance = null;

// --- HELPERS ---

function getPort() {
    return loadConfig().port || PORT;
}

function log(message, initiator = 'SYSTEM', status = 'INFO') {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${initiator}] [${status}] ${message}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

function getLogs() {
    if (!fs.existsSync(LOG_FILE)) return "";
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-200).join('\n');
}

function getAvailableNations() {
    const townsPath = path.join(__dirname, 'towns.json');
    if (!fs.existsSync(townsPath)) {
        return [];
    }

    const towns = JSON.parse(fs.readFileSync(townsPath, 'utf8')).towns || [];
    return [...new Set(towns.map((town) => town.nation).filter(Boolean))].sort();
}

function getStatusSnapshot() {
    const config = getConfig();
    let visibleState = systemState;
    if (systemState !== STATE.CANCELLING) {
        if (currentJob) visibleState = STATE.RUNNING;
        else if (jobQueue.length > 0) visibleState = STATE.QUEUED;
        else visibleState = STATE.IDLE;
    }

    return {
        state: visibleState,
        current_job: currentJob ? {
            id: currentJob.id,
            initiator: currentJob.initiator,
            startTime: currentJob.startTime,
            duration: Date.now() - currentJob.startTime
        } : null,
        queue_length: jobQueue.length,
        last_run: config.last_run,
        auto_scrape: config.auto_scrape,
        history: executionHistory.slice(-5).reverse()
    };
}

function updateConfig(newConfig) {
    const current = getConfig();
    const updated = { ...current, ...newConfig };
    if (Array.isArray(updated.webhooks)) {
        updated.webhooks = updated.webhooks
            .map((entry) => {
                if (typeof entry === 'string') {
                    return { url: entry.trim(), nations: ['Alchak_Federation'], nation_roles: {} };
                }

                if (!entry || typeof entry !== 'object') {
                    return null;
                }

                const url = String(entry.url || '').trim();
                const nations = Array.isArray(entry.nations)
                    ? entry.nations.map((nation) => String(nation).trim()).filter(Boolean)
                    : [];
                const nationRoles = entry.nation_roles && typeof entry.nation_roles === 'object' && !Array.isArray(entry.nation_roles)
                    ? Object.fromEntries(
                        Object.entries(entry.nation_roles)
                            .map(([nation, roleId]) => [String(nation).trim(), String(roleId || '').trim()])
                            .filter(([nation, roleId]) => nation && roleId)
                    )
                    : {};

                if (!url) {
                    return null;
                }

                return { url, nations, nation_roles: nationRoles };
            })
            .filter(Boolean);
    }

    saveConfig(updated);
    return updated;
}

function toTerminalLink(url, label = url) {
    if (!process.stdout.isTTY) {
        return url;
    }

    return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

function formatStatus(status = getStatusSnapshot()) {
    const lines = [
        `State: ${status.state}`,
        `Queue length: ${status.queue_length}`,
        `Last successful run: ${status.last_run || 'Never'}`,
        `Auto scrape: ${status.auto_scrape === false ? 'disabled' : 'enabled'}`
    ];

    if (status.current_job) {
        lines.push(
            `Current job: ${status.current_job.id}`,
            `Current initiator: ${status.current_job.initiator}`,
            `Current duration: ${Math.floor(status.current_job.duration / 1000)}s`
        );
    }

    if (status.history.length > 0) {
        lines.push('Recent history:');
        status.history.forEach((entry) => {
            const duration = `${(entry.duration / 1000).toFixed(1)}s`;
            const error = entry.error ? ` | ${entry.error}` : '';
            lines.push(`- ${entry.startTime} | ${entry.initiator} | ${entry.status} | ${duration}${error}`);
        });
    }

    return lines.join('\n');
}

function printHelp() {
    console.log(`Usage: node daemon.js [command]

Commands:
  shell                         Start interactive console mode (default)
  serve                         Start the HTTP dashboard server
  status                        Print current daemon status
  run [initiator]               Start or queue a scraper run
  cancel                        Cancel the current job
  logs                          Print the latest daemon log lines
  config                        Print the current config JSON
  config set <key> <value>      Update one config value
  help                          Show this help

Examples:
  node daemon.js
  node daemon.js run MANUAL
  node daemon.js config set auto_scrape false
  node daemon.js serve`);
}

function coerceConfigValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
    if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
        try {
            return JSON.parse(value);
        } catch (err) {
            return value;
        }
    }
    return value;
}

async function handleCliCommand(args) {
    const [command = 'shell', ...rest] = args;

    switch (command) {
        case 'shell':
            startConsoleShell();
            return;
        case 'serve':
            startHttpServer();
            console.log(`HTTP dashboard enabled: ${toTerminalLink(`http://localhost:${getPort()}`, 'Open dashboard')} (${`http://localhost:${getPort()}`})`);
            console.log('Press Ctrl+C to stop.');
            return;
        case 'status':
            console.log(formatStatus());
            return;
        case 'run': {
            const initiator = rest[0] || 'MANUAL';
            const message = await queueJob(initiator);
            console.log(message);
            console.log(formatStatus());
            return;
        }
        case 'cancel': {
            const message = await cancelCurrentJob();
            console.log(message);
            return;
        }
        case 'logs':
            console.log(getLogs());
            return;
        case 'config':
            if (rest[0] === 'set') {
                const key = rest[1];
                const rawValue = rest.slice(2).join(' ');
                if (!key || rawValue === '') {
                    throw new Error('Usage: node daemon.js config set <key> <value>');
                }
            const updated = updateConfig({ [key]: coerceConfigValue(rawValue) });
                console.log(JSON.stringify(updated, null, 2));
                return;
            }
            console.log(JSON.stringify(getConfig(), null, 2));
            return;
        case 'help':
        case '--help':
        case '-h':
            printHelp();
            return;
        default:
            throw new Error(`Unknown command: ${command}`);
    }
}

function startConsoleShell() {
    console.log('Console control mode. Type "help" for commands.');
    console.log(formatStatus());

    if (!process.stdin.isTTY) {
        return;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'daemon> '
    });

    rl.prompt();

    rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            rl.prompt();
            return;
        }

        if (trimmed === 'exit' || trimmed === 'quit') {
            rl.close();
            return;
        }

        const parts = trimmed.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) || [];

        try {
            await handleCliCommand(parts);
        } catch (err) {
            console.error(`Error: ${err.message || err}`);
        }

        rl.prompt();
    });

    rl.on('close', () => {
        console.log('Exiting console control mode.');
        process.exit(0);
    });
}

function validateSystem() {
    if (!fs.existsSync(path.join(__dirname, 'scraper.js'))) {
        throw new Error('scraper.js file not found.');
    }
    // Could add network check here
    return true;
}

function checkRateLimit() {
    const config = getConfig();
    const limit = config.max_manual_runs_per_hour || 5;
    const now = Date.now();
    // Filter timestamps older than 1 hour
    manualRunTimestamps = manualRunTimestamps.filter(t => now - t < 60 * 60 * 1000);
    
    if (manualRunTimestamps.length >= limit) {
        throw new Error(`Rate limit exceeded. Max ${limit} manual runs per hour.`);
    }
}

// --- EXECUTION ENGINE ---

function processQueue() {
    if (systemState === STATE.RUNNING || systemState === STATE.CANCELLING) return;
    if (jobQueue.length === 0) {
        systemState = STATE.IDLE;
        return;
    }

    const nextJob = jobQueue.shift();
    executeScraper(nextJob.initiator, nextJob.resolve, nextJob.reject);
}

function queueJob(initiator) {
    return new Promise((resolve, reject) => {
        // Validation
        try {
            validateSystem();
            if (initiator === 'MANUAL') {
                checkRateLimit();
                manualRunTimestamps.push(Date.now());
            }
        } catch (err) {
            return reject(err.message);
        }

        // Check if we can run immediately
        if (systemState === STATE.IDLE) {
            executeScraper(initiator, resolve, reject);
        } else {
            // Queue it
            if (jobQueue.length >= 3) { // Hard limit on queue size
                return reject('Queue is full (max 3 pending jobs).');
            }
            jobQueue.push({ initiator, resolve, reject });
            log(`Job queued. Position: ${jobQueue.length}`, initiator, 'QUEUED');
            resolve(`Job queued. Position: ${jobQueue.length}`);
        }
    });
}

function executeScraper(initiator, resolve, reject) {
    systemState = STATE.RUNNING;
    const startTime = Date.now();
    const jobId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    log('Starting scraper execution...', initiator, 'START');

    const child = spawn('node', ['scraper.js'], {
        cwd: __dirname,
        shell: true
    });

    currentJob = {
        id: jobId,
        initiator,
        startTime,
        process: child,
        resolve,
        reject
    };

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
        const str = data.toString();
        stdoutData += str;
        // Optional: Real-time logging of interesting lines?
        // console.log(`[Scraper] ${str.trim()}`);
    });

    child.stderr.on('data', (data) => {
        stderrData += data.toString();
    });

    child.on('close', (code) => {
        const duration = Date.now() - startTime;
        const success = code === 0;
        
        // Log history
        executionHistory.push({
            id: jobId,
            initiator,
            startTime: new Date(startTime).toISOString(),
            duration,
            status: success ? 'SUCCESS' : 'FAILED',
            error: success ? null : stderrData || 'Unknown error'
        });
        // Keep history manageable
        if (executionHistory.length > 50) executionHistory.shift();

        if (success) {
            log(`Scraper finished successfully in ${duration}ms`, initiator, 'SUCCESS');
            
            // Post-processing
            const config = getConfig();
            config.last_run = new Date().toISOString().split('T')[0];
            saveConfig(config);

            try {
                const townsData = JSON.parse(fs.readFileSync('towns.json', 'utf8')).towns;
                sendWebhookUpdate(townsData).catch((error) => {
                    log(`Discord delivery failed: ${error.message}`, initiator, 'ERROR');
                });
            } catch (e) {
                log(`Webhook trigger failed: ${e.message}`, initiator, 'ERROR');
            }

            if (currentJob && currentJob.resolve) currentJob.resolve('Scrape completed');
        } else {
            log(`Scraper failed with code ${code}. Stderr: ${stderrData}`, initiator, 'ERROR');
            if (currentJob && currentJob.reject) currentJob.reject(`Process exited with code ${code}`);
        }

        currentJob = null;
        systemState = jobQueue.length > 0 ? STATE.QUEUED : STATE.IDLE;
        
        // Process next job
        setTimeout(processQueue, 1000); // Small delay
    });
}

function getConfig() {
    return loadConfig();
}

function cancelCurrentJob() {
    return new Promise((resolve, reject) => {
        if (systemState !== STATE.RUNNING || !currentJob) {
            return reject('No running job to cancel.');
        }

        log('Cancellation requested.', 'MANUAL', 'CANCEL');
        systemState = STATE.CANCELLING;

        // Kill process
        // On Windows with shell: true, we might need taskkill
        if (process.platform === 'win32') {
             spawn('taskkill', ['/pid', currentJob.process.pid, '/f', '/t']);
        } else {
            currentJob.process.kill('SIGTERM');
        }
        
        // The 'close' event will trigger cleanup, but we might want to handle it specifically if needed.
        // For now, reliance on 'close' is safer.
        resolve('Cancellation signal sent.');
    });
}

// --- SCHEDULER ---

// Internal scheduler disabled in favor of Windows Task Scheduler + Startup Check
// function checkAndRun() {
//    const config = getConfig();
//    if (!config.auto_scrape) return;
//
//    const today = new Date().toISOString().split('T')[0];
//    if (config.last_run !== today) {
//        log(`Daily check: Last run (${config.last_run}) is not today. Scheduling auto-run.`, 'SYSTEM', 'SCHEDULE');
//        queueJob('SYSTEM').catch(err => log(`Scheduled run failed to start: ${err}`, 'SYSTEM', 'ERROR'));
//    }
// }

// Run check every hour (Disabled)
// setInterval(checkAndRun, 60 * 60 * 1000);
// Run on startup (Disabled)
// setTimeout(checkAndRun, 5000);

function startHttpServer() {
    if (serverInstance) {
        return serverInstance;
    }

    const express = require('express');
    const app = express();

    app.use(express.json());
    app.use(express.static('public'));

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });

    app.get('/api/status', (req, res) => {
        res.json(getStatusSnapshot());
    });

    app.post('/api/run', (req, res) => {
        const initiator = req.body.initiator || 'MANUAL';
        queueJob(initiator)
            .then((message) => res.json({ success: true, message }))
            .catch(err => res.status(400).json({ success: false, message: err }));
    });

    app.post('/api/cancel', (req, res) => {
        cancelCurrentJob()
            .then(msg => res.json({ success: true, message: msg }))
            .catch(err => res.status(400).json({ success: false, message: err }));
    });

    app.get('/api/logs', (req, res) => {
        res.json({ logs: getLogs() });
    });

    app.get('/api/config', (req, res) => {
        res.json(getConfig());
    });

    app.get('/api/nations', (req, res) => {
        res.json({ nations: getAvailableNations() });
    });

    app.post('/api/config', (req, res) => {
        updateConfig(req.body);
        res.json({ success: true });
    });

    const port = getPort();
    serverInstance = app.listen(port, () => {
        const url = `http://localhost:${port}`;
        log(`GUI Dashboard running at ${url}`, 'SYSTEM', 'STARTUP');
        console.log(`Dashboard link: ${toTerminalLink(url)} (${url})`);
    });

    return serverInstance;
}

const cliArgs = process.argv.slice(2);
const primaryCommand = cliArgs[0] || 'shell';

if (primaryCommand === 'shell' || primaryCommand === 'serve') {
    startBot();
}

handleCliCommand(cliArgs).catch((err) => {
    console.error(`Error: ${err.message || err}`);
    printHelp();
    process.exitCode = 1;
});

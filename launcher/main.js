/**
 * AutoTraderBot Launcher - Main Process
 * Zero-dependency desktop app launcher
 *
 * This Electron app:
 * 1. Shows a first-run setup wizard if no API keys are configured
 * 2. Saves config to the user's Application Support directory
 * 3. Serves the pre-built frontend
 * 4. Runs the backend server internally
 * 5. Provides a native desktop experience
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray } = require('electron');

// Override the default 'Electron' name shown in the macOS menu bar
app.name = 'AutoBot Trading';
const path = require('path');
const { spawn, fork, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

// ── Resolve npm/node binaries at runtime (Electron strips shell PATH) ──────
function resolveBin(name) {
    const candidates = [
        `/opt/homebrew/bin/${name}`,
        `/usr/local/bin/${name}`,
        `/opt/homebrew/Cellar/node/23.10.0_1/bin/${name}`,
        `/usr/bin/${name}`,
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    // last resort: try which
    try { return execSync(`which ${name}`, { encoding: 'utf8' }).trim(); } catch { }
    return name; // fall back to bare name and hope PATH is set
}
const NPM_BIN = resolveBin('npm');
console.log('[Launcher] Using npm:', NPM_BIN);

// ============================================================================
// Single-Instance Lock — prevent multiple copies of the app from running
// ============================================================================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    // A second instance tried to launch — focus the first one and exit immediately
    console.log('[Single-Instance] Another instance is already running. Quitting this one.');
    app.quit();
    process.exit(0);
}

// When a second instance calls LAUNCH.command while we're already running,
// Electron fires this event on the FIRST (winning) instance so we can
// bring our window to the front.
app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    console.log('[Single-Instance] Second launch attempt detected — focusing existing window.');
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    } else if (setupWindow) {
        if (setupWindow.isMinimized()) setupWindow.restore();
        setupWindow.show();
        setupWindow.focus();
    }
});

// ============================================================================
// Dynamic Port Resolution
// ============================================================================

/**
 * Returns a free TCP port, starting from `preferred` and scanning upward.
 * Uses Node's net module — no external dependencies.
 */
function findFreePort(preferred) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => {
            // preferred port is taken — try the next one
            resolve(findFreePort(preferred + 1));
        });
        server.listen(preferred, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Determine if we're in development or production
const isDev = process.argv.includes('--dev') || !app.isPackaged;

// Paths
const resourcesPath = isDev
    ? path.resolve(__dirname, '..')
    : process.resourcesPath;

const distPath = isDev
    ? path.join(resourcesPath, 'dist')
    : path.join(resourcesPath, 'dist');

const serverPath = isDev
    ? path.join(resourcesPath, 'server')
    : path.join(resourcesPath, 'server');

// Configuration — ports are preferred defaults; actual ports resolved dynamically at startup
const CONFIG = {
    PREFERRED_BACKEND_PORT: 3001,
    PREFERRED_FRONTEND_PORT: isDev ? 5173 : 3001,
    // Resolved at runtime by findFreePort() before any process is spawned:
    BACKEND_PORT: 3001,
    FRONTEND_PORT: isDev ? 5173 : 3001,
    STARTUP_TIMEOUT: 30000,
    HEALTH_CHECK_INTERVAL: 1000
};

// State
let mainWindow = null;
let setupWindow = null;
let tray = null;
let backendProcess = null;
let frontendProcess = null;
let isQuitting = false;

// ============================================================================
// First-Run Detection & Config
// ============================================================================

function getUserEnvPath() {
    return path.join(app.getPath('userData'), '.env');
}

// ── Debug logging ───────────────────────────────────────────────────────
// Persistent, secret-redacted log of backend + renderer output, written to a
// writable location (userData) for troubleshooting. Path: <userData>/debug.log
let _logStream = null;
const REDACT_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|SEED)=[^\s\n]+/gi;
function getDebugLogPath() {
    return path.join(app.getPath('userData'), 'debug.log');
}
function debugLog(tag, text) {
    try {
        if (!_logStream) {
            _logStream = fs.createWriteStream(getDebugLogPath(), { flags: 'a' });
            _logStream.write(`\n===== session started ${new Date().toISOString()} =====\n`);
        }
        const safe = String(text).replace(REDACT_PATTERN, (m) => m.slice(0, m.indexOf('=') + 1) + '[REDACTED]');
        for (const line of safe.split('\n')) {
            if (line.trim()) _logStream.write(`[${new Date().toISOString()}] [${tag}] ${line}\n`);
        }
    } catch { /* logging must never crash the app */ }
}

function loadUserEnv() {
    const envPath = getUserEnvPath();
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx < 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) process.env[key] = val;
    }
}

function checkFirstRun() {
    const envPath = getUserEnvPath();
    if (!fs.existsSync(envPath)) return true;
    const content = fs.readFileSync(envPath, 'utf8');
    // First run if HELIUS_API_KEY is missing or still a placeholder
    return !content.includes('HELIUS_API_KEY=') ||
        content.includes('HELIUS_API_KEY=your_') ||
        content.includes('HELIUS_API_KEY=\n') ||
        content.match(/HELIUS_API_KEY=\s*$/m);
}

function buildEnvFileContent(config) {
    // FIX-2: Preserve existing WALLET_ENCRYPTION_KEY and JWT_SECRET on re-run.
    // Regenerating these would make every previously encrypted wallet permanently
    // unreadable and invalidate all active sessions.
    const envPath = getUserEnvPath();
    const existingContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const extractExisting = (key) => {
        const match = existingContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
        return match ? match[1].trim() : null;
    };
    const jwtSecret = extractExisting('JWT_SECRET') || crypto.randomBytes(32).toString('hex');
    const walletKey = extractExisting('WALLET_ENCRYPTION_KEY') || crypto.randomBytes(32).toString('hex');
    const lines = [
        '# AutoBot Trading — generated by setup wizard',
        `# Updated: ${new Date().toISOString()}`,
        '',
        '# Required',
        `HELIUS_API_KEY=${config.HELIUS_API_KEY || ''}`,
        `JWT_SECRET=${jwtSecret}`,
        `WALLET_ENCRYPTION_KEY=${walletKey}`,
        '',
        '# Network',
        `SOLANA_NETWORK=${config.SOLANA_NETWORK || 'mainnet'}`,
        `PORT=3001`,
        `NODE_ENV=production`,
        '',
        '# Optional — Tavahin RPC',
        `TAVAHIN_RPC_URL=${config.TAVAHIN_RPC_URL || ''}`,
        `TAVAHIN_API_KEY=${config.TAVAHIN_API_KEY || ''}`,
        '',
        '# Optional — Geyser gRPC (0-block sniping)',
        `GEYSER_GRPC_ENDPOINT=${config.GEYSER_GRPC_ENDPOINT || ''}`,
        `GEYSER_AUTH_TOKEN=${config.GEYSER_AUTH_TOKEN || ''}`,
    ];
    return lines.join('\n') + '\n';
}

// ============================================================================
// Setup Window
// ============================================================================

function createSetupWindow() {
    setupWindow = new BrowserWindow({
        width: 820,
        height: 580,
        minWidth: 700,
        minHeight: 500,
        resizable: false,
        backgroundColor: '#0a0a0f',
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'setup-preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png'),
        show: false,
    });

    setupWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        const lvl = ['verbose', 'info', 'warning', 'error'][level] || 'info';
        debugLog(`Setup:${lvl}`, `${message} (${sourceId}:${line})`);
    });

    setupWindow.loadFile(path.join(__dirname, 'setup.html'));
    setupWindow.once('ready-to-show', () => setupWindow.show());

    setupWindow.on('closed', () => {
        setupWindow = null;
        // If user closes setup without finishing and main window isn't open, quit
        if (!mainWindow) app.quit();
    });
}

// FIX-6: save-config IPC key whitelist — only known env var names may be written.
// Prevents a compromised renderer from injecting NODE_OPTIONS or overwriting secrets.
const ALLOWED_CONFIG_KEYS = new Set([
    'HELIUS_API_KEY', 'TAVAHIN_RPC_URL', 'TAVAHIN_API_KEY',
    'GEYSER_GRPC_ENDPOINT', 'GEYSER_AUTH_TOKEN', 'SOLANA_NETWORK',
]);

ipcMain.handle('save-config', async (event, config) => {
    if (!config || typeof config !== 'object') {
        return { success: false, error: 'Invalid config payload' };
    }
    // Strip any keys not on the allowlist before building .env content
    const safeConfig = Object.fromEntries(
        Object.entries(config).filter(([k]) => ALLOWED_CONFIG_KEYS.has(k))
    );
    const envPath = getUserEnvPath();
    const content = buildEnvFileContent(safeConfig);
    fs.writeFileSync(envPath, content, 'utf8');
    console.log('Config saved to:', envPath);
    return { success: true };
});

// IPC: User clicked "Launch App" on the done screen
ipcMain.handle('skip-setup', async () => {
    loadUserEnv();
    if (setupWindow) {
        setupWindow.close();
        setupWindow = null;
    }
    if (!mainWindow) {
        await startMainApp();
    }
    return { success: true };
});

ipcMain.handle('get-platform-info', () => ({
    platform: process.platform,
    arch: process.arch,
}));

// ============================================================================
// Window Management
// ============================================================================

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        backgroundColor: '#0a0a0f',
        // Use default title bar to avoid overlap with app content
        titleBarStyle: 'default',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png'),
        show: false // Don't show until ready
    });

    // Capture the renderer console into debug.log (not visible in prod otherwise).
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        const lvl = ['verbose', 'info', 'warning', 'error'][level] || 'info';
        debugLog(`Renderer:${lvl}`, `${message} (${sourceId}:${line})`);
    });

    // Show window when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Handle window close - quit the app and kill all processes
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            isQuitting = true;
            console.log('Window closed - quitting app and stopping all processes...');

            // Stop all processes before quitting
            stopServers();

            // Destroy tray if it exists
            if (tray) {
                tray.destroy();
                tray = null;
            }
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        // Force quit after window is destroyed
        app.quit();
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');

    if (fs.existsSync(iconPath)) {
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Open AutoBot Trading',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Open in Browser',
                click: () => {
                    shell.openExternal(`http://localhost:${CONFIG.FRONTEND_PORT}`);
                }
            },
            { type: 'separator' },
            {
                label: 'Quit',
                click: () => {
                    isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('AutoBot Trading');
        tray.setContextMenu(contextMenu);

        tray.on('click', () => {
            if (mainWindow) {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.show();
                }
            }
        });
    }
}

// ============================================================================
// Server Management
// ============================================================================

async function startBackend() {
    console.log('Starting backend server...');

    // Paths
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'data.db');
    const prismaDir = path.join(resourcesPath, 'prisma');

    // Ensure userData dir exists
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });

    // Per-platform Prisma query-engine filename (audit §9.1) — the old hardcoded
    // darwin-arm64 path broke Windows AND Intel-mac builds.
    function prismaEngineFile() {
        const { platform, arch } = process;
        if (platform === 'win32') return 'query_engine-windows.dll.node';
        if (platform === 'darwin') {
            return arch === 'arm64'
                ? 'libquery_engine-darwin-arm64.dylib.node'
                : 'libquery_engine-darwin.dylib.node';
        }
        // linux: prefer whichever engine actually shipped
        const dir = path.join(resourcesPath, 'node_modules', '.prisma', 'client');
        try {
            const hit = fs.readdirSync(dir).find(f => f.startsWith('libquery_engine-') && f.includes('linux'));
            if (hit) return hit;
        } catch { /* fall through */ }
        return `libquery_engine-debian-openssl-3.0.x.so.node`;
    }
    const engineFile = prismaEngineFile();
    const enginePath = [
        path.join(resourcesPath, 'node_modules', '.prisma', 'client', engineFile),
        path.join(resourcesPath, 'node_modules', '@prisma', 'engines', engineFile),
    ].find(p => fs.existsSync(p));
    if (!enginePath) console.warn(`[Launcher] Prisma engine not found for ${process.platform}/${process.arch} (${engineFile}) — Prisma will try its own resolution.`);

    // Common env for the backend process
    const backendEnv = {
        ...process.env,
        PORT: String(CONFIG.BACKEND_PORT),
        NODE_ENV: 'production',
        ELECTRON_APP: 'true',
        // Point Prisma at the user's writable data directory (NEVER inside the
        // install dir — Program Files is read-only on Windows, audit §9.7).
        // Forward slashes: a Windows path with backslashes/space in a file: URL
        // is rejected by Prisma's SQLite connector (SQLITE_CANTOPEN / error 14).
        DATABASE_URL: `file:${dbPath.replace(/\\/g, '/')}`,
        // Point Prisma query engine to the bundled per-platform binary
        ...(enginePath ? { PRISMA_QUERY_ENGINE_LIBRARY: enginePath } : {}),
        // Frontend static files are relative to server-build/server.js
        FRONTEND_DIST_PATH: path.join(resourcesPath, 'dist'),
    };

    const serverFile = path.join(resourcesPath, 'server-build', 'server.mjs');

    if (fs.existsSync(serverFile) && !isDev) {
        // Production only: use compiled bundle (dev mode always uses tsx below)
        console.log('Using compiled server bundle:', serverFile);

        // First-launch DB init: push schema if DB doesn't exist OR is empty (0 bytes)
        const dbNeedsInit = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;
        if (dbNeedsInit) {
            console.log('First launch — initialising SQLite database...');
            try {
                // FIX-3: Removed --accept-data-loss. If the schema push requires dropping
                // data, it will now fail loudly instead of silently wiping user data.
                // §9.2: run the bundled prisma CLI via Electron's own Node runtime
                // (ELECTRON_RUN_AS_NODE) — no external node/npx needed on any platform.
                const prismaCli = path.join(resourcesPath, 'node_modules', 'prisma', 'build', 'index.js');
                execSync(
                    `"${process.execPath}" "${prismaCli}" db push --schema="${path.join(prismaDir, 'schema.prisma')}" --skip-generate`,
                    { cwd: resourcesPath, env: { ...backendEnv, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' }
                );
                console.log('Database initialised at', dbPath);
            } catch (e) {
                console.warn('Prisma db push warning (non-fatal):', e.message);
            }
        }

        // Sentinel goes AFTER the script path — it lands in process.argv,
        // not node's own flags (which would cause "bad option" error).
        // §9.2: spawn Electron's own binary as Node (ELECTRON_RUN_AS_NODE) —
        // removes the external-Node dependency on EVERY platform.
        backendProcess = spawn(process.execPath, [serverFile, BACKEND_SENTINEL], {
            cwd: resourcesPath,
            detached: false,
            env: { ...backendEnv, ELECTRON_RUN_AS_NODE: '1' },
        });
        writePid('backend', backendProcess.pid);

    } else if (isDev) {
        // Development fallback: run TypeScript source directly via tsx
        console.log('No server bundle found — falling back to tsx (dev mode)');
        // FIX-5: shell:false — prevents shell injection via compromised env vars.
        backendProcess = spawn(NPM_BIN, ['run', 'server:dev'], {
            cwd: resourcesPath,
            shell: false,
            detached: false,
            env: {
                ...backendEnv,
                PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
                NODE_ENV: 'development',
                ELECTRON_APP: 'true',
                AUTOBOT_PROCESS_SENTINEL: BACKEND_SENTINEL,
            }
        });
        writePid('backend', backendProcess.pid);
    } else {
        dialog.showErrorBox('Missing build', `server-build/server.mjs not found.\nRun: npm run build:server`);
        app.quit();
        return;
    }


    // Capture stderr so we can show it in the error dialog
    let stderrOutput = '';

    if (backendProcess.stdout) {
        backendProcess.stdout.on('data', (data) => {
            const text = data.toString();
            console.log('[Backend]', text.trim());
            debugLog('Backend', text);
        });
    }

    if (backendProcess.stderr) {
        backendProcess.stderr.on('data', (data) => {
            const text = data.toString();
            stderrOutput += text;
            console.error('[Backend Error]', text.trim());
            debugLog('Backend:stderr', text);
        });
    }

    backendProcess.on('error', (err) => {
        console.error('Backend process error:', err);
        stderrOutput += `\nProcess error: ${err.message}`;
    });

    backendProcess.on('exit', (code) => {
        clearPid('backend');
        console.log('Backend process exited with code:', code);
        if (!isQuitting && code !== 0) {
            // FIX-4: Redact sensitive env var values from crash log before writing.
            const REDACT_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|SEED)=[^\s\n]+/gi;
            const safeStderr = stderrOutput.replace(REDACT_PATTERN, (m) => {
                const eqIdx = m.indexOf('=');
                return m.slice(0, eqIdx + 1) + '[REDACTED]';
            });
            const logPath = path.join(resourcesPath, 'backend-crash.log');
            try {
                fs.writeFileSync(logPath, `Exit code: ${code}\n\n${safeStderr}`);
            } catch { }

            const preview = stderrOutput.slice(0, 400).trim() || '(no stderr output)';
            dialog.showErrorBox(
                'Backend Error',
                `Server crashed (exit code ${code}).\n\nError:\n${preview}\n\nCrash log:\n${logPath}\n\nFull debug log (backend + app console):\n${getDebugLogPath()}`
            );
        }
    });

    // Wait for backend to be ready
    await waitForServer(CONFIG.BACKEND_PORT);
    console.log('Backend server started on port', CONFIG.BACKEND_PORT);
}

async function startFrontend() {
    if (isDev) {
        console.log('Starting frontend dev server...');

        frontendProcess = spawn(NPM_BIN, ['run', 'dev'], {
            cwd: resourcesPath,
            shell: false,
            detached: true,
            env: {
                ...process.env,
                PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
                BROWSER: 'none',
                VITE_BACKEND_PORT: String(CONFIG.BACKEND_PORT),
                VITE_FRONTEND_PORT: String(CONFIG.FRONTEND_PORT),
                AUTOBOT_PROCESS_SENTINEL: FRONTEND_SENTINEL,
            }
        });
        writePid('frontend', frontendProcess.pid);

        frontendProcess.stdout.on('data', (data) => {
            console.log('[Frontend]', data.toString().trim());
        });

        frontendProcess.stderr.on('data', (data) => {
            console.error('[Frontend Error]', data.toString().trim());
        });

        frontendProcess.on('error', (err) => {
            console.error('Frontend process error:', err);
        });

        frontendProcess.on('exit', () => { clearPid('frontend'); });

        // Wait for Vite to be ready
        await waitForServer(CONFIG.FRONTEND_PORT);
        console.log('Frontend dev server started on port', CONFIG.FRONTEND_PORT);
    } else {
        // Production: Express backend serves the frontend static files
        console.log('Production mode: backend serves frontend from dist/');
    }
}

function waitForServer(port, timeout = CONFIG.STARTUP_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const check = () => {
            const req = http.get(`http://localhost:${port}`, (res) => {
                resolve(true);
            });

            req.on('error', () => {
                if (Date.now() - startTime > timeout) {
                    reject(new Error(`Timeout waiting for server on port ${port}`));
                } else {
                    setTimeout(check, CONFIG.HEALTH_CHECK_INTERVAL);
                }
            });

            req.end();
        };

        check();
    });
}

function stopServers() {
    console.log('Stopping all servers and processes...');

    const killProcessTree = (proc, name) => {
        if (!proc || !proc.pid) return;
        try {
            console.log(`Killing ${name} (PID: ${proc.pid})...`);

            // Step 1 — polite SIGTERM to the process group
            try { process.kill(-proc.pid, 'SIGTERM'); } catch (e) {
                // If group kill fails (e.g. no process group), kill the process itself
                try { proc.kill('SIGTERM'); } catch { }
            }

            // Step 2 — SIGKILL after 1 s if SIGTERM wasn't enough
            setTimeout(() => {
                try {
                    if (!proc.killed) {
                        console.log(`Force-killing ${name} (PID: ${proc.pid}) with SIGKILL...`);
                        try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) {
                            try { proc.kill('SIGKILL'); } catch { }
                        }
                    }
                } catch { /* already dead */ }
            }, 1000);

            // Step 3 — belt-and-suspenders: also kill by PID directly after 2 s
            setTimeout(() => {
                try { execSync(`kill -9 ${proc.pid} 2>/dev/null`); } catch { }
            }, 2000);

        } catch (error) {
            console.log(`Error killing ${name}:`, error.message);
        }
    };

    killProcessTree(backendProcess, 'backend');
    killProcessTree(frontendProcess, 'frontend');
    killProcessTree(pythonProcess, 'python');

    backendProcess = null;
    frontendProcess = null;
    pythonProcess = null;
}

// ============================================================================
// Safe Process Tracking — sentinel flag + start-time fingerprint
// ============================================================================

// Unique marker passed as an arg to every child process we spawn.
// This is what we look for when verifying ownership — much safer than
// checking the binary name (which could match any node/vite process).
const BACKEND_SENTINEL = '--autobot-backend';
const FRONTEND_SENTINEL = '--autobot-frontend';

function getPidFilePath(name) {
    return path.join(app.getPath('userData'), `.${name}.pid.json`);
}

/**
 * Write PID + process start time to a JSON file.
 * Start time makes PID recycling safe: if the OS reuses the PID for a
 * different process, its start time will differ and we skip it.
 */
function writePid(name, pid) {
    try {
        let startTime = '';
        if (process.platform !== 'win32') {
            try { startTime = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch { }
        }
        const record = JSON.stringify({ pid, startTime });
        fs.writeFileSync(getPidFilePath(name), record, 'utf8');
    } catch { }
}

function clearPid(name) {
    try { fs.unlinkSync(getPidFilePath(name)); } catch { }
}

/**
 * Safely kill our own stale processes from a previous session.
 *
 * Two-factor check before any kill:
 *   1. Start time must match what we recorded (guards against PID recycling)
 *   2. Process args must contain our sentinel flag (guards against name collisions)
 *
 * If either check fails we log and skip — never kill blindly.
 */
function killStalePreviousProcesses() {
    const sentinels = { backend: BACKEND_SENTINEL, frontend: FRONTEND_SENTINEL };

    for (const [name, sentinel] of Object.entries(sentinels)) {
        const pidFile = getPidFilePath(name);
        if (!fs.existsSync(pidFile)) continue;

        let record;
        try { record = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch { clearPid(name); continue; }

        const { pid, startTime } = record;
        if (!pid) { clearPid(name); continue; }

        if (process.platform !== 'win32') {
            try {
                // ── Check 1: start time fingerprint ───────────────────────────
                if (startTime) {
                    let currentStart = '';
                    try { currentStart = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch { }
                    if (!currentStart) {
                        console.log(`🧹 Stale ${name} PID ${pid} is already gone`);

                        clearPid(name);
                        continue;
                    }
                    if (currentStart !== startTime) {
                        console.log(`⚠️  PID ${pid} start time changed — OS recycled it. Skipping.`);
                        clearPid(name);
                        continue;
                    }
                }

                // ── Check 2: sentinel in args OR env (ps -Eww shows both) ─────
                let argsAndEnv = '';
                try { argsAndEnv = execSync(`ps -Eww -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch { }
                if (!argsAndEnv.includes(sentinel)) {
                    console.log(`⚠️  PID ${pid} missing sentinel '${sentinel}' — not ours. Skipping.`);
                    clearPid(name);
                    continue;
                }

                // Both checks passed — safe to kill
                process.kill(pid, 'SIGTERM');
                console.log(`🧹 Safely killed stale ${name} process (PID ${pid})`);
            } catch {
                // Process already dead — fine
            }
        } else {
            // §9.4: Windows — verify the sentinel via the process command line,
            // then tree-kill with taskkill /T /F (SIGTERM semantics don't exist).
            try {
                let cmdline = '';
                try {
                    cmdline = execSync(
                        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine"`,
                        { encoding: 'utf8', timeout: 5000 }
                    ).trim();
                } catch { }
                if (!cmdline) {
                    console.log(`🧹 Stale ${name} PID ${pid} is already gone`);
                } else if (!cmdline.includes(sentinel)) {
                    console.log(`⚠️  PID ${pid} missing sentinel '${sentinel}' — not ours. Skipping.`);
                } else {
                    execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'pipe', timeout: 5000 });
                    console.log(`🧹 Safely killed stale ${name} process tree (PID ${pid})`);
                }
            } catch {
                // Process already dead or taskkill failed — fine
            }
        }
        clearPid(name);
    }

    // Brief pause for ports to be reclaimed after SIGTERM
    if (process.platform !== 'win32') {
        try { execSync('sleep 0.5'); } catch { }
    }
}

// ============================================================================
// App Lifecycle
// ============================================================================

async function startMainApp() {
    // ── 1. Kill any processes we left running from a previous session ───────
    killStalePreviousProcesses();

    // ── 2. Resolve free ports — findFreePort scans upward from preferred ───
    CONFIG.BACKEND_PORT = await findFreePort(CONFIG.PREFERRED_BACKEND_PORT);
    if (isDev) {
        CONFIG.FRONTEND_PORT = await findFreePort(CONFIG.PREFERRED_FRONTEND_PORT);
    } else {
        CONFIG.FRONTEND_PORT = CONFIG.BACKEND_PORT; // prod: same port
    }
    console.log(`Ports resolved — backend: ${CONFIG.BACKEND_PORT}, frontend: ${CONFIG.FRONTEND_PORT}`);

    createWindow();
    createTray();
    mainWindow.loadFile(path.join(__dirname, 'loading.html'));

    try {
        await startBackend();
        if (isDev) await startFrontend();

        const appUrl = `http://localhost:${CONFIG.FRONTEND_PORT}`;
        console.log('Loading app from:', appUrl);
        mainWindow.loadURL(appUrl);

        if (process.argv.includes('--dev')) {
            mainWindow.webContents.openDevTools();
        }
    } catch (error) {
        console.error('Failed to start app:', error);
        dialog.showErrorBox('Startup Error', `Failed to start AutoBot Trading:\n\n${error.message}`);
        app.quit();
    }
}

async function initApp() {
    // Load env from userData first (overrides any bundled defaults)
    loadUserEnv();

    if (checkFirstRun()) {
        console.log('First run detected — showing setup wizard');
        createSetupWindow();
        // Main app will be launched by skip-setup IPC handler
    } else {
        console.log('Config found — launching app directly');
        await startMainApp();
    }
}

// App ready
app.whenReady().then(() => {
    // Set dock icon on macOS (BrowserWindow icon option doesn't affect the dock)
    if (process.platform === 'darwin' && app.dock) {
        const dockIcon = path.join(__dirname, 'assets', 'icon.png');
        if (fs.existsSync(dockIcon)) {
            app.dock.setIcon(dockIcon);
        }
    }
    initApp();
});

// Quit when all windows are closed (including macOS)
app.on('window-all-closed', () => {
    console.log('All windows closed - quitting app...');
    isQuitting = true;
    stopServers();
    app.quit();
});

// Activate (macOS)
app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    } else {
        mainWindow.show();
    }
});

// Before quit — stop child processes and clear PID files
app.on('before-quit', () => {
    isQuitting = true;
    stopServers();
    // Clear PID files so the next launch doesn't try to kill recycled PIDs
    clearPid('backend');
    clearPid('frontend');
    // Hard-exit after 4 s in case something hangs — ensures full cleanup
    setTimeout(() => {
        console.log('[Quit] Hard exit after timeout — forcing process.exit(0)');
        process.exit(0);
    }, 4000).unref();
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    dialog.showErrorBox('Error', error.message);
});

// ============================================================================
// IPC Handlers
// ============================================================================

ipcMain.handle('get-app-info', () => {
    return {
        version: app.getVersion(),
        isDev,
        backendPort: CONFIG.BACKEND_PORT,
        frontendPort: CONFIG.FRONTEND_PORT
    };
});

ipcMain.handle('restart-servers', async () => {
    stopServers();
    await startBackend();
    if (isDev) {
        await startFrontend();
    }
    mainWindow.loadURL(`http://localhost:${CONFIG.FRONTEND_PORT}`);
});

// SECURITY FIX: open-external must validate URLs before passing to shell.openExternal.
// A compromised renderer could otherwise redirect to phishing pages or run javascript: URIs.
const ALLOWED_EXTERNAL_ORIGINS = [
    /^https:\/\/solscan\.io\//,
    /^https:\/\/explorer\.solana\.com\//,
    /^https:\/\/jup\.ag\//,
    /^https:\/\/pump\.fun\//,
    /^https:\/\/raydium\.io\//,
    /^https:\/\/birdeye\.so\//,
    /^https:\/\/dexscreener\.com\//,
    /^https:\/\/github\.com\/CsquadHub/,
    // Allow local wallet-connect page (Electron pairing flow)
    /^http:\/\/localhost:\d+\/wallet-connect/,
    /^http:\/\/127\.0\.0\.1:\d+\/wallet-connect/,
];

ipcMain.handle('open-external', (event, url) => {
    if (typeof url !== 'string') return;
    const isAllowed = ALLOWED_EXTERNAL_ORIGINS.some(re => re.test(url));
    if (!isAllowed) {
        console.warn('[Security] Blocked open-external for non-allowlisted URL:', url);
        return;
    }
    shell.openExternal(url);
});

// ============================================================================
// Wallet Connect - Opens in system browser
// ============================================================================

// Open wallet connection page in system browser, with optional session ID for pairing
ipcMain.handle('open-wallet-connect', async (event, sessionId) => {
    const base = `http://localhost:${CONFIG.FRONTEND_PORT}/wallet-connect`;
    const walletUrl = sessionId ? `${base}?session=${sessionId}` : base;
    console.log('Opening wallet connect in browser:', walletUrl);
    await shell.openExternal(walletUrl);
    return { success: true };
});

// Handle wallet connection callback from browser
ipcMain.handle('wallet-connected', async (event, walletData) => {
    console.log('Wallet connected:', walletData.publicKey);
    // Store wallet data securely (this will be handled by the backend)
    return { success: true };
});

// ============================================================================
// Python Virtual Environment Management
// ============================================================================

let pythonProcess = null;

async function checkPythonInstalled() {
    try {
        await executeCommandSimple('python3', ['--version']);
        return true;
    } catch {
        try {
            await executeCommandSimple('python', ['--version']);
            return true;
        } catch {
            return false;
        }
    }
}

// SECURITY: executeCommandSimple uses shell: true for simplicity with Python setup commands.
// All current calls use hardcoded args - if user input is ever passed here, this becomes a
// shell injection vector. Consider refactoring to shell: false with direct executable paths.
function executeCommandSimple(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: options.cwd || resourcesPath,
            shell: true,
            env: { ...process.env, ...options.env }
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `Command failed with code ${code}`));
        });

        child.on('error', reject);
    });
}

async function setupPythonVenv() {
    const venvPath = path.join(resourcesPath, '.venv');
    const requirementsPath = path.join(resourcesPath, 'requirements.txt');

    console.log('Setting up Python virtual environment...');

    // Get python command
    let pythonCmd = 'python3';
    try {
        await executeCommandSimple('python3', ['--version']);
    } catch {
        pythonCmd = 'python';
    }

    // Create venv if it doesn't exist
    if (!fs.existsSync(venvPath)) {
        console.log('Creating Python virtual environment...');
        await executeCommandSimple(pythonCmd, ['-m', 'venv', '.venv'], {
            cwd: resourcesPath
        });
    }

    // Get pip path based on platform
    const pipPath = process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'pip')
        : path.join(venvPath, 'bin', 'pip');

    // Install requirements if they exist
    if (fs.existsSync(requirementsPath)) {
        console.log('Installing Python dependencies...');
        await executeCommandSimple(pipPath, ['install', '-r', 'requirements.txt'], {
            cwd: resourcesPath
        });
    }

    console.log('Python venv setup complete');
    return venvPath;
}

async function startPythonWorker(scriptName) {
    const venvPath = path.join(resourcesPath, '.venv');
    const pythonPath = process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'python')
        : path.join(venvPath, 'bin', 'python');

    const scriptPath = path.join(resourcesPath, scriptName);

    if (!fs.existsSync(scriptPath)) {
        console.log(`Python script not found: ${scriptName}`);
        return null;
    }

    console.log(`Starting Python worker: ${scriptName}`);

    pythonProcess = spawn(pythonPath, [scriptPath], {
        cwd: resourcesPath,
        env: {
            ...process.env,
            PYTHONUNBUFFERED: '1'
        }
    });

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Python Error] ${data.toString().trim()}`);
    });

    pythonProcess.on('error', (err) => {
        console.error('Python process error:', err);
    });

    pythonProcess.on('exit', (code) => {
        console.log(`Python worker exited with code: ${code}`);
    });

    return pythonProcess;
}

function stopPythonWorker() {
    if (pythonProcess) {
        pythonProcess.kill('SIGTERM');
        pythonProcess = null;
    }
}

// IPC handlers for Python
ipcMain.handle('check-python', async () => {
    return await checkPythonInstalled();
});

// §9.5: Python sidecar is optional — feature-flag it OFF on Windows v1
// (the win32 pip/python paths are untested; enable after a verification pass).
const PYTHON_ENABLED = process.platform !== 'win32' || process.env.AUTOBOT_ENABLE_PYTHON === '1';

ipcMain.handle('setup-python-venv', async () => {
    if (!PYTHON_ENABLED) return { success: false, error: 'Python features are disabled on Windows in this version.' };
    try {
        const venvPath = await setupPythonVenv();
        return { success: true, venvPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('start-python-worker', async (event, scriptName) => {
    if (!PYTHON_ENABLED) return { success: false, error: 'Python features are disabled on Windows in this version.' };
    try {
        const process = await startPythonWorker(scriptName);
        return { success: !!process };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('stop-python-worker', async () => {
    stopPythonWorker();
    return { success: true };
});

// Clean up Python on quit
app.on('before-quit', () => {
    stopPythonWorker();
});

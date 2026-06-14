# AutoTraderBot Desktop Launcher

This is the one-click desktop app launcher for AutoTraderBot.

## What It Does

When you double-click the app:
1. Shows a beautiful loading screen
2. Automatically starts the backend server
3. Starts the frontend (in dev mode) or serves static files (production)
4. Opens the app in an Electron window
5. Minimizes to system tray when closed

## Development

```bash
# Install dependencies
cd launcher
npm install

# Run in development mode (uses npm run dev/server:dev)
npm run dev

# Run in production mode simulation
npm start
```

## Building for Distribution

### Prerequisites
1. Build the main frontend first:
   ```bash
   cd ..
   npm run build
   ```

2. Then build the launcher:
   ```bash
   cd launcher
   npm run build:mac      # macOS (.dmg)
   npm run build:win      # Windows (.exe)
   npm run build:linux    # Linux (.AppImage, .deb)
   ```

## Output

Built apps will be in `launcher/dist/`:

| Platform | File | Size (approx) |
|----------|------|---------------|
| macOS | `AutoTraderBot-1.0.0.dmg` | ~200-300MB |
| macOS (ARM) | `AutoTraderBot-1.0.0-arm64.dmg` | ~200-300MB |
| Windows | `AutoTraderBot Setup 1.0.0.exe` | ~200-300MB |
| Linux | `AutoTraderBot-1.0.0.AppImage` | ~200-300MB |

## Architecture

```
User clicks AutoTraderBot.app
         ↓
    Electron starts
         ↓
    Shows loading.html
         ↓
    Spawns backend server (port 3001)
         ↓
    [Dev] Spawns Vite (port 5173)
    [Prod] Backend serves static files
         ↓
    Loads app in Electron window
         ↓
    User sees fully working app!
```

## Production Mode

In production, the built app includes:
- Pre-built frontend (dist/)
- Server code (server/)
- All node_modules
- Prisma binaries

The user needs NO external dependencies:
- ❌ No Node.js required
- ❌ No npm required
- ❌ No Python required
- ✅ Just double-click and run!

## System Tray

The app minimizes to system tray instead of closing:
- Click tray icon to show/hide window
- Right-click for menu (Open, Open in Browser, Quit)

## Files

| File | Purpose |
|------|---------|
| `main.js` | Electron main process, server management |
| `preload.js` | IPC bridge |
| `loading.html` | Loading screen during startup |
| `package.json` | Build configuration |
| `assets/` | Icons and resources |

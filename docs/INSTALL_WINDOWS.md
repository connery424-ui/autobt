# Installing on Windows

Two ways to run AutoBot on Windows: the **easy installer** (for normal use) or
**from source** (for developers).

---

## Option A — Easy install (recommended for friends)

No Node, no command line. Just download and run.

1. Go to the **[Releases page](https://github.com/Csquadhub/autobotnew/releases/latest)**.
2. Download the latest **`AutoBot Trading Setup x.x.x.exe`** under "Assets".
3. Double-click it and follow the installer. It installs like any normal app and
   adds an **AutoBot Trading** icon to your desktop and Start menu.
   - Windows SmartScreen may warn that the app is unsigned (we don't pay for a
     code-signing certificate). Click **More info → Run anyway**. This is expected
     for open-source apps; the source is right here in this repo if you want to verify it.
4. Launch **AutoBot Trading** from the desktop icon or Start menu.

### ⭐ First run: add your free Helius key (required)
The very first time you open the app it will work, but it can't reach Solana until
you give it a **free Helius API key**. This takes about two minutes:

1. Go to **https://helius.dev** and sign up (free tier is plenty).
2. On your Helius dashboard, copy your **API key** (a string like
   `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
3. In AutoBot, open **Settings → API Keys & RPC**, paste the key into the
   **Helius API key** field, and click **Save**.
4. That's it — the app now has its RPC + token feed. No file editing, no terminal.

> Each person uses **their own** Helius key. Don't share keys — a leaked key lets
> others burn your free quota.

Other keys you may want (also free, same Settings screen):

| Key | Where to get it (free) | Required? |
|-----|------------------------|-----------|
| **Helius API key** | https://helius.dev | **Yes** — RPC + token feed |
| **Jupiter API key** | https://portal.jup.ag | For swaps |
| Geyser endpoint/token | (advanced) | No |

Your wallet keys are generated/encrypted **locally** with AES-256-GCM and never
leave your machine. Nothing is uploaded anywhere.

> **New releases:** when a new version is published, download the new `.exe` and
> run it — it installs over the old one and keeps your local data.

---

## Option B — Run from source (developers)

Requires **[Node.js 20+](https://nodejs.org)** (the app enforces this).

```powershell
git clone https://github.com/Csquadhub/autobotnew.git
cd autobotnew

# Install EXACTLY what the lockfile pins (supply-chain safe — see SECURITY.md)
npm ci

# Copy the env template and fill in your keys
copy .env.example .env
notepad .env        # set HELIUS_API_KEY, JWT_SECRET, WALLET_ENCRYPTION_KEY, etc.

# Generate the database client and start
npx prisma generate
npm run server      # backend on :3001
npm run dev         # frontend on :5173 (separate terminal)
```

Open http://localhost:5173.

### Building your own installer
```powershell
npm run build:app
cd launcher
npm ci
npm run build:win   # produces launcher/dist/AutoBot-Setup-x.x.x.exe
```

---

## Publishing a new release (repo owner only)

The Windows/.exe is built automatically by GitHub Actions. To cut a release:

```bash
git tag v2.7.1
git push origin v2.7.1     # "origin" = the Csquadhub/autobotnew remote
```

GitHub Actions builds the Windows, macOS, and Linux installers and attaches them
to a new Release. Friends then download from the Releases page (Option A).

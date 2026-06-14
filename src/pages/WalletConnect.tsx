/**
 * WalletConnect Page - Standalone page for wallet connection
 * Opens in system browser when running in Electron
 * 
 * FULLY AUTOMATIC: Uses session ID from URL - no manual code entry needed!
 * Auto-closes after successful connection!
 */

import React, { useEffect, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';

const WalletConnect: React.FC = () => {
    const { connected, publicKey, connecting, disconnect, select } = useWallet();
    const [status, setStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
    const [sessionId, setSessionId] = useState<string>('');
    const [countdown, setCountdown] = useState(3);
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [lockHint, setLockHint] = useState<string>('');

    // Locked-wallet recovery. If the wallet was locked, its first connect request can be
    // swallowed by the unlock prompt and the adapter sticks in `connecting` with no way
    // out — the page appears to hang on "Connecting…". If we're still connecting after a
    // grace period without a publicKey, reset the adapter (disconnect + deselect) so the
    // button is clickable again, and tell the user to unlock first. A successful connect
    // clears this. Grace period is long enough not to interrupt a slow-but-working approve.
    useEffect(() => {
        if (!connecting || connected) return;
        const t = setTimeout(async () => {
            if (connected) return;
            try { await disconnect(); } catch { /* wasn't connected */ }
            try { (select as any)(null); } catch { /* ignore */ }
            setLockHint('Your wallet looks locked. Unlock it in the extension, then click Connect again.');
        }, 20000);
        return () => clearTimeout(t);
    }, [connecting, connected, disconnect, select]);

    useEffect(() => { if (connected) setLockHint(''); }, [connected]);

    // Get session ID from URL on mount
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const session = urlParams.get('session');
        if (session) {
            setSessionId(session);
                // sessionId intentionally not logged — it's a short-lived auth token
        }
    }, []);

    // When wallet connects, sync to backend automatically
    useEffect(() => {
        if (connected && publicKey && sessionId) {
            syncWalletToBackend();
        }
    }, [connected, publicKey, sessionId]);

    // Auto-close countdown after success
    useEffect(() => {
        if (status === 'success' && countdown > 0) {
            const timer = setTimeout(() => {
                setCountdown(countdown - 1);
            }, 1000);
            return () => clearTimeout(timer);
        } else if (status === 'success' && countdown === 0) {
            // Try to close the window
            window.close();
        }
    }, [status, countdown]);

    const syncWalletToBackend = async () => {
        if (!publicKey || !sessionId) return;

        setStatus('syncing');

        try {
            console.log('🔗 Syncing wallet to backend with session:', sessionId);
            console.log('📍 Calling /api/auth/electron-pair...');

            // Register the wallet with the session ID
            const response = await fetch('/api/auth/electron-pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    publicKey: publicKey.toBase58(),
                    pairingCode: sessionId // Use session ID as the pairing code
                })
            });

            console.log('📡 Response status:', response.status);
            const data = await response.json().catch(() => ({}));
            console.log('📦 Response data:', data);

            if (response.ok && data.success) {
                setStatus('success');
                console.log('✅ Wallet synced! Electron will auto-detect.');
            } else {
                // Surface the real failure instead of faking success — otherwise the
                // app keeps polling forever while this window claims it worked.
                const msg = data.error || `Pairing failed (HTTP ${response.status})`;
                console.error('Failed to sync wallet:', data);
                setErrorMsg(msg);
                setStatus('error');
            }
        } catch (error: any) {
            console.error('Sync error:', error);
            setErrorMsg(error?.message || 'Could not reach AutoBot Trading backend.');
            setStatus('error');
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-secondary/80 backdrop-blur-lg rounded-2xl shadow-2xl p-8 border border-border">
                {/* Logo */}
                <div className="text-center mb-8">
                    <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-gradient-to-br from-cyan-400 to-purple-600 p-1">
                        <div className="w-full h-full rounded-full bg-background flex items-center justify-center">
                            <img
                                src="/assets/abotlogo.svg"
                                alt="AutoTraderBot"
                                className="w-12 h-12"
                                onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = 'none';
                                }}
                            />
                        </div>
                    </div>
                    <h1 className="text-2xl font-bold text-white mb-2">AutoBot Trading</h1>
                    <p className="text-muted-foreground">Connect your Solana wallet</p>
                </div>

                {/* Success State */}
                {status === 'success' && publicKey ? (
                    <div className="text-center">
                        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                            <svg className="w-10 h-10 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <h2 className="text-2xl font-bold text-green-400 mb-2">Wallet Connected!</h2>
                        <p className="text-muted-foreground mb-2">
                            {publicKey.toBase58().slice(0, 8)}...{publicKey.toBase58().slice(-8)}
                        </p>

                        <div className="mt-6 p-4 bg-green-500/10 rounded-xl border border-green-500/30">
                            <p className="text-green-400 font-medium">
                                ✨ Return to AutoBot Trading now!
                            </p>
                            <p className="text-muted-foreground text-sm mt-1">
                                {countdown > 0
                                    ? `This window will close in ${countdown}...`
                                    : 'Closing...'
                                }
                            </p>
                        </div>

                        <button
                            onClick={() => window.close()}
                            className="mt-6 px-8 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-all text-lg"
                        >
                            Close Now
                        </button>
                    </div>
                ) : status === 'syncing' ? (
                    <div className="text-center">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-cyan-500/20 flex items-center justify-center">
                            <svg className="w-8 h-8 text-cyan-400 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                        </div>
                        <h2 className="text-xl font-semibold text-cyan-400 mb-2">Syncing...</h2>
                        <p className="text-muted-foreground">Connecting to AutoBot Trading</p>
                    </div>
                ) : status === 'error' ? (
                    <div className="text-center">
                        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                            <svg className="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </div>
                        <h2 className="text-2xl font-bold text-red-400 mb-2">Pairing failed</h2>
                        <p className="text-muted-foreground mb-4 break-words">{errorMsg}</p>
                        <button
                            onClick={() => { setStatus('idle'); setErrorMsg(''); }}
                            className="px-8 py-3 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg font-medium transition-all text-lg"
                        >
                            Try again
                        </button>
                    </div>
                ) : (
                    <>
                        {/* Unlock-first guidance — prevents the locked-wallet hang */}
                        <div className="mb-4 p-3 bg-amber-500/10 rounded-lg border border-amber-500/30 text-center">
                            <p className="text-amber-300 text-sm">
                                🔓 Unlock your wallet first, then click Connect.
                            </p>
                        </div>

                        {/* Wallet button */}
                        <div className="space-y-4">
                            <WalletMultiButton className="!w-full !bg-gradient-to-r !from-cyan-500 !to-purple-600 !hover:from-cyan-600 !hover:to-purple-700 !h-14 !rounded-xl !font-semibold !text-lg !transition-all !shadow-lg" />
                        </div>

                        {/* Locked-wallet recovery hint (shown if the adapter got stuck) */}
                        {lockHint && (
                            <div className="mt-4 p-3 bg-amber-500/10 rounded-lg border border-amber-500/40 text-center">
                                <p className="text-amber-300 text-sm">{lockHint}</p>
                            </div>
                        )}

                        {/* Session indicator */}
                        {sessionId && (
                            <div className="mt-4 p-3 bg-cyan-500/10 rounded-lg border border-cyan-500/30 text-center">
                                <p className="text-cyan-400 text-sm">
                                    🔗 Connected to AutoBot Trading session
                                </p>
                            </div>
                        )}

                        {/* Instructions */}
                        <div className="mt-6 p-4 bg-background/50 rounded-xl border border-border">
                            <h3 className="text-sm font-medium text-foreground/80 mb-2">How it works:</h3>
                            <ol className="text-sm text-muted-foreground space-y-2">
                                <li className="flex items-start gap-2">
                                    <span className="text-cyan-400 font-bold">1.</span>
                                    Click the button above to connect your wallet
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-cyan-400 font-bold">2.</span>
                                    Approve the connection in your wallet
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-cyan-400 font-bold">3.</span>
                                    <strong className="text-green-400">Done!</strong> This window will close automatically
                                </li>
                            </ol>
                        </div>

                        {/* Supported wallets */}
                        <div className="mt-6 text-center">
                            <p className="text-xs text-muted-foreground mb-2">Supported wallets</p>
                            <div className="flex justify-center gap-4 text-muted-foreground text-sm">
                                <span>Phantom</span>
                                <span>•</span>
                                <span>Solflare</span>
                                <span>•</span>
                                <span>Backpack</span>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default WalletConnect;

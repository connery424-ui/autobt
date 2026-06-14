/**
 * ElectronWalletButton - Smart wallet button that works in both browser and Electron
 * 
 * In browser: Uses standard WalletMultiButton
 * In Electron: Opens wallet connection in system browser with AUTO-SYNC
 */

import React, { useState, useEffect, useRef } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

// Check if running in Electron
const isElectron = (): boolean => {
    if (typeof window === 'undefined') return false;
    if ((window as any).isElectronApp === true) return true;
    if ((window as any).autotrader?.isElectron === true) return true;
    if (navigator.userAgent.toLowerCase().includes('electron')) return true;
    return false;
};

const getAutotraderAPI = () => (window as any).autotrader;

const generateSessionId = () => 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

interface ElectronWalletButtonProps {
    className?: string;
}

const ElectronWalletButton: React.FC<ElectronWalletButtonProps> = ({ className }) => {
    const [isOpening, setIsOpening] = useState(false);
    const [isPolling, setIsPolling] = useState(false);
    const [pollStatus, setPollStatus] = useState('');
    const [inElectron, setInElectron] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const pollingRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        const detected = isElectron();
        setInElectron(detected);
        console.log('🔍 Electron detected:', detected);

        // Check if already authenticated
        const token = localStorage.getItem('auth_token');
        if (token) {
            setIsConnected(true);
        }
    }, []);

    useEffect(() => {
        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current);
        };
    }, []);

    if (!inElectron) {
        return <WalletMultiButton className={className} />;
    }

    const startPolling = (sessionId: string) => {
        setIsPolling(true);
        setPollStatus('Waiting for wallet...');
        console.log('🔄 Polling started for:', sessionId);

        let attempts = 0;

        pollingRef.current = setInterval(async () => {
            attempts++;

            try {
                const response = await fetch('/api/auth/electron-claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pairingCode: sessionId })
                });

                if (response.ok) {
                    const data = await response.json();
                    console.log('📦 Claim response:', data);

                    if (data.success && data.token) {
                        console.log('🎉 SUCCESS! Got token, authenticating...');

                        // Stop polling immediately
                        clearInterval(pollingRef.current!);
                        pollingRef.current = null;

                        // Store the token
                        localStorage.setItem('auth_token', data.token);
                        console.log('💾 Token stored in localStorage');

                        // Update UI
                        setIsPolling(false);
                        setPollStatus('Connected!');
                        setIsConnected(true);

                        // Force reload after a moment
                        console.log('🔄 Reloading page in 1 second...');
                        setTimeout(() => {
                            console.log('🔄 Reloading now!');
                            window.location.reload();
                        }, 1000);

                        return;
                    }
                }
            } catch (error) {
                // Silently continue polling
            }

            if (attempts % 5 === 0) {
                setPollStatus(`Waiting... (${attempts}s)`);
            }

            if (attempts >= 120) {
                clearInterval(pollingRef.current!);
                setIsPolling(false);
                setPollStatus('Timeout - try again');
            }
        }, 1000);
    };

    const handleClick = async () => {
        if (isConnected) return;

        if (isPolling) {
            if (pollingRef.current) clearInterval(pollingRef.current);
            setIsPolling(false);
            setPollStatus('');
            return;
        }

        setIsOpening(true);
        const sessionId = generateSessionId();
        console.log('🆔 Session:', sessionId);

        try {
            const api = getAutotraderAPI();
            const url = `${window.location.origin}/wallet-connect?session=${sessionId}`;
            console.log('🌐 Opening:', url);

            // Prefer openWalletConnect (passes sessionId directly via shell.openExternal,
            // bypassing the open-external allowlist which blocks localhost)
            if (api?.openWalletConnect) {
                await api.openWalletConnect(sessionId);
            } else if (api?.openExternal) {
                await api.openExternal(url);
            } else {
                window.open(url, '_blank');
            }

            startPolling(sessionId);
        } catch (error) {
            console.error('Error:', error);
        } finally {
            setIsOpening(false);
        }
    };

    if (isConnected) {
        return (
            <div className="flex items-center gap-2 px-4 py-2 bg-green-500/20 border border-green-500/50 rounded-lg">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                <span className="text-sm text-green-400 font-medium">Wallet Connected</span>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3">
            {isPolling && (
                <div className="flex items-center gap-2 text-cyan-400 text-sm animate-pulse">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    {pollStatus}
                </div>
            )}

            <button
                onClick={handleClick}
                disabled={isOpening}
                className={`
          ${isPolling ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'} 
          text-white font-medium h-10 px-6 rounded-lg transition-all shadow-lg hover:scale-105
        `}
            >
                {isOpening ? 'Opening...' : isPolling ? 'Cancel' : 'Connect Wallet'}
            </button>
        </div>
    );
};

export default ElectronWalletButton;

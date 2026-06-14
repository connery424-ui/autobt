import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings as SettingsIcon, ExternalLink, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

/**
 * GlobalSettingsMenu — gear dropdown in the app header (audit §8.1).
 * Quick status (network, API keys) + link to the full /settings page.
 * The sniper page's own button is "Sniper Filters" — this is the ONE global Settings.
 */

interface KeyStatus { set: boolean; masked?: string; value?: string }

const GlobalSettingsMenu: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [keys, setKeys] = useState<Record<string, KeyStatus> | null>(null);
    const [network, setNetwork] = useState<string>('…');
    const ref = useRef<HTMLDivElement>(null);
    const { sessionToken } = useAuth();

    // Close on outside click
    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    // Lazy-load status when first opened
    useEffect(() => {
        if (!open || keys) return;
        fetch('/api/config/rpc-endpoint')
            .then(r => r.json())
            .then(d => setNetwork(d.network || 'unknown'))
            .catch(() => setNetwork('unknown'));
        if (sessionToken) {
            fetch('/api/config/api-keys', { headers: { Authorization: `Bearer ${sessionToken}` } })
                .then(r => r.json())
                .then(d => setKeys(d.config || {}))
                .catch(() => setKeys({}));
        } else {
            setKeys({});
        }
    }, [open, keys, sessionToken]);

    const keyRow = (label: string, k?: KeyStatus) => (
        <div className="flex items-center justify-between text-xs py-1">
            <span className="text-muted-foreground">{label}</span>
            {k?.set
                ? <span className="flex items-center gap-1 text-green-400"><CheckCircle2 className="w-3 h-3" /> set</span>
                : <span className="flex items-center gap-1 text-yellow-500"><XCircle className="w-3 h-3" /> missing</span>}
        </div>
    );

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen(o => !o)}
                className="p-2 rounded-lg hover:bg-secondary transition-colors"
                title="Global settings"
            >
                <SettingsIcon className="w-5 h-5 text-muted-foreground" />
            </button>

            {open && (
                <div className="absolute right-0 top-12 w-72 glass rounded-xl border border-border shadow-2xl p-4 z-[60]">
                    <h3 className="text-sm font-semibold mb-3">Quick Settings</h3>

                    <div className="flex items-center justify-between text-xs py-1">
                        <span className="text-muted-foreground">Network</span>
                        <span className="font-mono">{network}</span>
                    </div>

                    <div className="border-t border-border my-2" />
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">API Keys</p>
                    {keyRow('Helius', keys?.HELIUS_API_KEY)}
                    {keyRow('Custom RPC', keys?.TAVAHIN_RPC_URL)}

                    <div className="border-t border-border my-2" />
                    <Link
                        to="/settings"
                        onClick={() => setOpen(false)}
                        className="flex items-center justify-between text-sm text-primary hover:underline py-1"
                    >
                        Open full Settings
                        <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                </div>
            )}
        </div>
    );
};

export default GlobalSettingsMenu;

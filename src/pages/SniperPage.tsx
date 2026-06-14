import React, { useState } from 'react';
import { Target, Crosshair, ListChecks } from 'lucide-react';
import SniperDashboard from './SniperDashboard';
import SniperConfigMain from './SniperConfigMain';
import { useIsAuthenticated } from '../hooks/useSimpleAuth';
import { AlertCircle } from 'lucide-react';

/**
 * SniperPage — merged Auto Sniper + Sniper Config (audit §2).
 * One route (/sniper), one sidebar entry, two tabs:
 *   • Live Feed — global filter-based auto-sniper + live token table (ex /auto-sniper)
 *   • Targets   — per-token sniper configs CRUD (ex /sniper)
 * Settings stores stay separate by design: snipe_settings (global automation)
 * vs sniper_configs (per-token targets) — only the UI is merged.
 */

type SniperTab = 'feed' | 'targets';
const TAB_STORAGE_KEY = 'sniper:activeTab';

const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const isAuthenticated = useIsAuthenticated();
    if (!isAuthenticated) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center">
                <div className="max-w-md space-y-6">
                    <div className="w-24 h-24 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
                        <Target className="w-12 h-12 text-primary" />
                    </div>
                    <div className="space-y-2">
                        <h2 className="text-2xl font-bold">Connect Your Profile Wallet</h2>
                        <p className="text-muted-foreground">
                            Connect your profile wallet using the <strong>Connect Wallet</strong> button
                            in the top right corner to access your sniper targets.
                        </p>
                    </div>
                    <div className="glass p-4 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                        <div className="flex items-center text-yellow-500">
                            <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
                            <span className="text-sm">Look for the blue "Connect Wallet" button in the header above ↗️</span>
                        </div>
                    </div>
                </div>
            </div>
        );
    }
    return <>{children}</>;
};

const SniperPage: React.FC = () => {
    const [tab, setTab] = useState<SniperTab>(() => {
        const saved = localStorage.getItem(TAB_STORAGE_KEY);
        return saved === 'targets' ? 'targets' : 'feed';
    });

    const switchTab = (t: SniperTab) => {
        setTab(t);
        localStorage.setItem(TAB_STORAGE_KEY, t);
    };

    const tabBtn = (t: SniperTab, label: string, Icon: typeof Crosshair) => (
        <button
            onClick={() => switchTab(t)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
        >
            <Icon className="w-4 h-4" />
            {label}
        </button>
    );

    return (
        <div className="space-y-4">
            {/* Header + tab bar */}
            <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-3">
                    <Target className="w-7 h-7 text-primary" />
                    <div>
                        <h1 className="text-2xl font-bold gradient-text">Sniper</h1>
                        <p className="text-sm text-muted-foreground">Live feed, automation & per-token targets</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {tabBtn('feed', 'Live Feed', Crosshair)}
                    {tabBtn('targets', 'Targets', ListChecks)}
                </div>
            </div>

            {/* Keep Live Feed mounted while on Targets so polling/WS state survives tab switches */}
            <div className={tab === 'feed' ? '' : 'hidden'}>
                <SniperDashboard />
            </div>
            {tab === 'targets' && (
                <AuthGate>
                    <SniperConfigMain />
                </AuthGate>
            )}
        </div>
    );
};

export default SniperPage;

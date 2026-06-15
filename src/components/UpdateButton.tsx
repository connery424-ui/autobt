import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, RotateCw, CheckCircle2, AlertCircle, ArrowRight } from 'lucide-react';

/**
 * UpdateButton — fully-manual update control in the app header (left of the gear).
 *
 * Nothing is checked or downloaded automatically. The user clicks "Check for
 * Update"; if a newer release exists, a modal shows the version + changelog and
 * the user must accept before anything downloads. After download, the user
 * clicks "Restart now" to install. All state is streamed from the launcher over
 * the `update-status` IPC channel (see launcher/main.js + preload.js).
 *
 * Renders nothing outside the Electron app (the web build has no updater).
 */

type UpdateState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'up-to-date'
    | 'error';

interface UpdateStatus {
    state: 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
    version?: string;
    releaseNotes?: string;
    releaseDate?: string;
    percent?: number;
    message?: string;
    dev?: boolean;
    silent?: boolean; // background check — update the button only, no popup/noise
}

const getAPI = () => (window as any).autotrader;
const isElectron = () =>
    (window as any).isElectronApp === true || getAPI()?.isElectron === true;

// Release bodies can contain light HTML/markdown — strip tags for safe display.
const cleanNotes = (raw?: string): string => {
    if (!raw) return '';
    return raw
        .replace(/<\/?(p|div|li|ul|ol|h\d|br)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const UpdateButton: React.FC = () => {
    const [state, setState] = useState<UpdateState>('idle');
    const [version, setVersion] = useState<string>('');        // available/downloaded version
    const [currentVersion, setCurrentVersion] = useState<string>('');
    const [notes, setNotes] = useState<string>('');
    const [percent, setPercent] = useState<number>(0);
    const [error, setError] = useState<string>('');
    const [modalOpen, setModalOpen] = useState(false);
    const [isDev, setIsDev] = useState(false);
    const upToDateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Subscribe to launcher update events + read current version once.
    useEffect(() => {
        if (!isElectron()) return;
        const api = getAPI();
        api?.getVersion?.().then((v: string) => setCurrentVersion(v)).catch(() => {});

        const unsubscribe = api?.onUpdateStatus?.((status: UpdateStatus) => {
            switch (status.state) {
                case 'checking':
                    if (status.silent) break; // background check — stay quiet
                    setError('');
                    setState('checking');
                    break;
                case 'available':
                    setVersion(status.version || '');
                    setNotes(cleanNotes(status.releaseNotes));
                    setState('available');
                    // Only auto-open the changelog for a user-initiated check.
                    // A background find just turns the button blue.
                    if (!status.silent) setModalOpen(true);
                    break;
                case 'downloading':
                    setPercent(status.percent || 0);
                    setState('downloading');
                    break;
                case 'downloaded':
                    setVersion(status.version || version);
                    setState('downloaded');
                    setModalOpen(true);
                    break;
                case 'not-available':
                    if (status.silent) break; // background check found nothing — leave button as-is
                    setIsDev(!!status.dev);
                    setState('up-to-date');
                    setModalOpen(false);
                    if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
                    upToDateTimer.current = setTimeout(() => setState('idle'), 3500);
                    break;
                case 'error':
                    if (status.silent) break; // background errors stay silent
                    setError(status.message || 'Update check failed');
                    setState('error');
                    break;
            }
        });

        return () => {
            if (upToDateTimer.current) clearTimeout(upToDateTimer.current);
            unsubscribe?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Escape closes the modal + lock background scroll while it's open.
    useEffect(() => {
        if (!modalOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModalOpen(false); };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [modalOpen]);

    const handleCheck = useCallback(() => {
        const api = getAPI();
        setError('');
        setState('checking');
        api?.checkForUpdates?.().catch((e: any) => {
            setError(String(e?.message || e));
            setState('error');
        });
    }, []);

    const handleAccept = useCallback(() => {
        const api = getAPI();
        setState('downloading');
        setPercent(0);
        api?.downloadUpdate?.().catch((e: any) => {
            setError(String(e?.message || e));
            setState('error');
        });
    }, []);

    const handleInstall = useCallback(() => {
        getAPI()?.installUpdate?.();
    }, []);

    // Click behavior depends on the current state.
    const handleButtonClick = useCallback(() => {
        if (state === 'available' || state === 'downloaded') {
            setModalOpen(true);
            return;
        }
        if (state === 'downloading' || state === 'checking') return;
        handleCheck();
    }, [state, handleCheck]);

    if (!isElectron()) return null;

    // --- Button appearance per state ---
    const baseBtn =
        'flex items-center gap-2 h-10 px-3 rounded-lg font-medium text-sm transition-all duration-200 glass border';
    let btnClass = `${baseBtn} border-border text-muted-foreground hover:text-foreground hover:bg-secondary`;
    let btnContent: React.ReactNode = (
        <>
            <RefreshCw className="w-4 h-4" /> Check for Update
        </>
    );
    let disabled = false;

    switch (state) {
        case 'checking':
            btnContent = (
                <>
                    <RefreshCw className="w-4 h-4 animate-spin" /> Checking…
                </>
            );
            disabled = true;
            break;
        case 'available':
            btnClass = `${baseBtn} border-blue-500/40 bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 hover:border-blue-500/60 animate-pulse`;
            btnContent = (
                <>
                    <Download className="w-4 h-4" /> Update available
                </>
            );
            break;
        case 'downloading':
            btnClass = `${baseBtn} border-blue-500/40 bg-blue-500/10 text-blue-300`;
            btnContent = (
                <>
                    <Download className="w-4 h-4 animate-pulse" /> Downloading… {percent}%
                </>
            );
            break;
        case 'downloaded':
            btnClass = `${baseBtn} border-green-500/40 bg-green-500/15 text-green-300 hover:bg-green-500/25 hover:border-green-500/60`;
            btnContent = (
                <>
                    <RotateCw className="w-4 h-4" /> Restart to update
                </>
            );
            break;
        case 'up-to-date':
            btnClass = `${baseBtn} border-green-500/30 text-green-400`;
            btnContent = (
                <>
                    <CheckCircle2 className="w-4 h-4" /> Up to date
                </>
            );
            break;
        case 'error':
            btnClass = `${baseBtn} border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20`;
            btnContent = (
                <>
                    <AlertCircle className="w-4 h-4" /> Check for Update
                </>
            );
            break;
    }

    return (
        <>
            <button
                onClick={handleButtonClick}
                disabled={disabled}
                title={
                    state === 'error'
                        ? error
                        : state === 'idle' || state === 'up-to-date'
                            ? `Current version ${currentVersion ? 'v' + currentVersion : ''}`
                            : undefined
                }
                className={`${btnClass} ${disabled ? 'opacity-70 cursor-default' : ''}`}
            >
                {btnContent}
            </button>

            {modalOpen && createPortal(
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
                    onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
                >
                <div className="glass border border-border rounded-lg max-w-lg w-full p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    {state === 'downloaded' ? (
                        <>
                            <div className="mb-4">
                                <h3 className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
                                    <CheckCircle2 className="w-5 h-5 text-green-400" />
                                    Update downloaded
                                </h3>
                            </div>
                            <p className="text-sm text-muted-foreground">
                                AutoBot Trading <span className="text-foreground font-medium">v{version}</span> is
                                ready to install. The app will restart to finish.
                            </p>
                            <div className="mt-6 flex justify-end gap-3">
                                <button
                                    onClick={() => setModalOpen(false)}
                                    className="h-10 px-4 rounded-lg text-sm font-medium glass border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
                                >
                                    Later
                                </button>
                                <button
                                    onClick={handleInstall}
                                    className="h-10 px-4 rounded-lg text-sm font-medium bg-green-600 hover:bg-green-700 text-white transition-all flex items-center gap-2"
                                >
                                    <RotateCw className="w-4 h-4" /> Restart now
                                </button>
                            </div>
                        </>
                    ) : state === 'downloading' ? (
                        <>
                            <div className="mb-4">
                                <h3 className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
                                    <Download className="w-5 h-5 text-blue-400" />
                                    Downloading update
                                </h3>
                            </div>
                            <p className="text-sm text-muted-foreground mb-3">
                                Getting AutoBot Trading <span className="text-foreground font-medium">v{version}</span>…
                            </p>
                            <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
                                <div
                                    className="h-full bg-blue-500 transition-all duration-200"
                                    style={{ width: `${percent}%` }}
                                />
                            </div>
                            <div className="text-right text-xs text-muted-foreground mt-1">{percent}%</div>
                        </>
                    ) : (
                        // 'available'
                        <>
                            <div className="mb-4">
                                <h3 className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
                                    <Download className="w-5 h-5 text-blue-400" />
                                    Update available
                                </h3>
                            </div>
                            <div className="flex items-center gap-2 text-sm mb-3">
                                <span className="text-muted-foreground">
                                    {currentVersion ? `v${currentVersion}` : 'current'}
                                </span>
                                <ArrowRight className="w-4 h-4 text-muted-foreground" />
                                <span className="text-foreground font-semibold">v{version}</span>
                            </div>
                            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                                What's new
                            </div>
                            <div className="max-h-60 overflow-y-auto rounded-lg bg-secondary/40 border border-border p-3 text-sm text-foreground/90 whitespace-pre-wrap">
                                {notes || 'No release notes were provided for this version.'}
                            </div>
                            <div className="mt-6 flex justify-end gap-3">
                                <button
                                    onClick={() => setModalOpen(false)}
                                    className="h-10 px-4 rounded-lg text-sm font-medium glass border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
                                >
                                    Not now
                                </button>
                                <button
                                    onClick={handleAccept}
                                    className="h-10 px-4 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-all flex items-center gap-2"
                                >
                                    <Download className="w-4 h-4" /> Update now
                                </button>
                            </div>
                        </>
                    )}
                </div>
                </div>,
                document.body
            )}
        </>
    );
};

export default UpdateButton;

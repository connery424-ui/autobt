import React from 'react';
import { Link } from 'react-router-dom';
import { History, ExternalLink, ArrowUpRight, ArrowDownRight } from 'lucide-react';

/**
 * RecentTransactions — Dashboard card (audit §5).
 * Replaces the LiveTokenFeed component (which duplicated the sniper feed and
 * doubled polling load). Shows the wallet's latest trades with links out.
 */

export interface RecentTxRow {
    id: string;
    txId?: string;
    tokenName?: string;
    tokenSymbol?: string;
    type: 'buy' | 'sell';
    amount: number;       // SOL amount
    profit?: number | string | null;
    status: string;       // confirmed | pending | failed
    timestamp: number;
}

const relTime = (ts: number) => {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
};

interface Props {
    transactions: RecentTxRow[];
    loading?: boolean;
    limit?: number;
}

const RecentTransactions: React.FC<Props> = ({ transactions, loading, limit = 10 }) => {
    const rows = transactions.slice(0, limit);

    return (
        <div className="glass p-6 rounded-xl">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                    <History className="h-5 w-5" />
                    Recent Transactions
                </h2>
                <Link to="/transactions" className="text-sm text-primary hover:underline">
                    View all →
                </Link>
            </div>

            {loading ? (
                <div className="space-y-3">
                    {[...Array(4)].map((_, i) => (
                        <div key={i} className="flex items-center gap-4 p-3 glass rounded-lg animate-pulse">
                            <div className="w-8 h-8 bg-muted rounded-full" />
                            <div className="flex-1 space-y-2">
                                <div className="h-4 bg-muted rounded w-3/4" />
                                <div className="h-3 bg-muted rounded w-1/2" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : rows.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground text-sm">
                    No transactions yet — they'll appear here after your first trade.
                </div>
            ) : (
                <div className="divide-y divide-border">
                    {rows.map((tx) => {
                        const profit = typeof tx.profit === 'string' ? parseFloat(tx.profit) : (tx.profit ?? 0);
                        const confirmed = tx.status === 'confirmed' || tx.status === 'success';
                        const failed = tx.status === 'failed';
                        const showLink = !!tx.txId && tx.txId !== 'pending' && !tx.txId.startsWith('simulated');
                        return (
                            <div key={tx.id} className="flex items-center gap-3 py-2.5">
                                <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                    tx.type === 'buy'
                                        ? 'bg-green-500/15 text-green-400'
                                        : 'bg-red-500/15 text-red-400'
                                }`}>
                                    {tx.type === 'buy' ? <ArrowDownRight className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
                                    {tx.type.toUpperCase()}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{tx.tokenSymbol || tx.tokenName || 'Unknown'}</p>
                                    <p className="text-xs text-muted-foreground">{relTime(tx.timestamp)} ago{failed ? ' · failed' : !confirmed ? ' · pending' : ''}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm font-mono">{tx.amount?.toFixed?.(4) ?? tx.amount} SOL</p>
                                    {profit !== 0 && (
                                        <p className={`text-xs font-mono ${profit > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {profit > 0 ? '+' : ''}{profit.toFixed(4)}
                                        </p>
                                    )}
                                </div>
                                {showLink && (
                                    <a
                                        href={`https://solscan.io/tx/${tx.txId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-muted-foreground hover:text-foreground"
                                        title="View on Solscan"
                                    >
                                        <ExternalLink className="w-4 h-4" />
                                    </a>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default RecentTransactions;

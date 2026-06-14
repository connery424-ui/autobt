/**
 * Global trade notifications (2026-06-12).
 * Opens one app-wide WebSocket and shows bottom-right toasts for every
 * verified trade the server records: green for buys, red for sells, 10s each.
 * Started once from SimpleLayout, so it works on every page.
 */
import toast from './toast-shim';

let started = false;

export function startTradeToasts(sessionToken?: string | null): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const connect = () => {
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws${
        sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : ''
      }`;
      const ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data?.type !== 'trade_notification' || !data.trade) return;
          const t = data.trade;
          const label = t.tokenSymbol || t.tokenName || 'token';
          const sol = typeof t.solAmount === 'number' ? t.solAmount.toFixed(4) : '?';
          if (t.side === 'buy') {
            toast.trade(`🟢 BUY  ${label} — ${sol} SOL spent (${t.dex || ''})`, 'buy');
          } else {
            toast.trade(`🔴 SELL ${label} — ${sol} SOL received (${t.dex || ''})`, 'sell');
          }
        } catch { /* malformed message — ignore */ }
      };

      // Auto-reconnect with a gentle backoff so toasts survive server restarts
      ws.onclose = () => { setTimeout(connect, 5000); };
      ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
    } catch {
      setTimeout(connect, 5000);
    }
  };

  connect();
}

// Real toast implementation for UI display
const toast = (message: string) => {
  showToastUI(message, 'default');
  console.log(`[TOAST] ${message}`);
  return 'toast-id';
};

toast.success = (message: string) => {
  showToastUI(message, 'success');
  console.log(`[TOAST SUCCESS] ${message}`);
  return 'toast-id';
};

toast.error = (message: string) => {
  showToastUI(message, 'error');
  console.error(`[TOAST ERROR] ${message}`);
  return 'toast-id';
};

toast.info = (message: string) => {
  showToastUI(message, 'info');
  console.log(`[TOAST INFO] ${message}`);
  return 'toast-id';
};

toast.loading = (message: string) => {
  showToastUI(message, 'loading');
  console.log(`[TOAST LOADING] ${message}`);
  return 'toast-id';
};

toast.warning = (message: string) => {
  showToastUI(message, 'warning');
  console.log(`[TOAST WARNING] ${message}`);
  return 'toast-id';
};

// Trade notifications — green buys / red sells, slower (10s) so they're readable
toast.trade = (message: string, side: 'buy' | 'sell', durationMs = 10000) => {
  showToastUI(message, side === 'buy' ? 'success' : 'error', durationMs);
  console.log(`[TOAST TRADE ${side.toUpperCase()}] ${message}`);
  return 'toast-id';
};

// Stacked toast container (2026-06-12): toasts used to be individually
// position:fixed at the same spot, so simultaneous toasts overlapped.
function getToastContainer(): HTMLElement {
  let c = document.getElementById('toast-stack-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-stack-container';
    c.style.position = 'fixed';
    c.style.bottom = '20px';
    c.style.right = '20px';
    c.style.zIndex = '9999';
    c.style.display = 'flex';
    c.style.flexDirection = 'column';
    c.style.alignItems = 'flex-end';
    c.style.gap = '10px';
    document.body.appendChild(c);
  }
  return c;
}

// Helper function to show toast UI (durationMs configurable — default 4s)
function showToastUI(
  message: string,
  type: 'default' | 'success' | 'error' | 'info' | 'loading' | 'warning',
  durationMs = 4000,
) {
  // Guard against running in a non-browser environment (like tests)
  if (typeof document === 'undefined') return;

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.style.backgroundColor = getBackgroundColor(type);
  toast.style.color = '#fff';
  toast.style.padding = '12px 24px';
  toast.style.borderRadius = '8px';
  toast.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
  toast.style.minWidth = '300px';
  toast.style.maxWidth = '80vw';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(20px)';
  toast.style.transition = 'all 0.3s ease';
  toast.innerText = message;

  // Append to the stacking container (newest at the bottom)
  getToastContainer().appendChild(toast);

  // Animate in
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  }, 10);

  // Auto remove after durationMs
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => {
      toast.parentElement?.removeChild(toast);
    }, 300);
  }, durationMs);
}

// Helper to get background color based on toast type
type ToastType = 'default' | 'success' | 'error' | 'info' | 'loading' | 'warning';

const toastColors: Record<ToastType, string> = {
  success: '#10b981', // green
  error: '#ef4444',   // red
  info: '#3b82f6',    // blue
  warning: '#f59e0b', // amber
  loading: '#6366f1', // indigo
  default: '#6b7280', // gray
};

function getBackgroundColor(type: ToastType): string {
  return toastColors[type] || toastColors.default;
}

// Add global CSS for toast
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    .toast-notification {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 500;
      line-height: 1.5;
    }

    @media (max-width: 768px) {
      .toast-notification {
        right: 10px;
        left: 10px;
        width: calc(100% - 20px);
        max-width: none;
      }
    }
  `;
  document.head.appendChild(style);
}

toast.custom = () => {
  console.log('[TOAST CUSTOM]');
  return 'toast-id';
};

toast.dismiss = () => {
  console.log('[TOAST DISMISSED]');
  if (typeof document === 'undefined') return;
  const toasts = document.querySelectorAll('.toast-notification');
  toasts.forEach(toast => {
    toast.remove();
  });
};

toast.promise = <T>(promise: Promise<T>, opts: any) => {
  console.log('[TOAST PROMISE]', opts);
  return promise;
};

toast.remove = (id: string) => {
  console.log(`[TOAST REMOVED] ${id}`);
};

// Named exports
export { toast };
export const Toaster = () => null;

// Default export
export default toast; 
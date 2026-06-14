import React from 'react';

/**
 * PageShell — standard page chrome (audit §3.1).
 * Gradient title + optional subtitle on the left, action slot on the right.
 * Every page uses this so headers are identical app-wide.
 */
interface PageShellProps {
    title: string;
    subtitle?: string;
    icon?: React.ReactNode;
    actions?: React.ReactNode;
    children: React.ReactNode;
}

const PageShell: React.FC<PageShellProps> = ({ title, subtitle, icon, actions, children }) => (
    <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
                {icon}
                <div>
                    <h1 className="text-2xl font-bold gradient-text">{title}</h1>
                    {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
                </div>
            </div>
            {actions && <div className="flex items-center gap-3">{actions}</div>}
        </div>
        {children}
    </div>
);

export default PageShell;

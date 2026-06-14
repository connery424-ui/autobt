import React from 'react';

/**
 * GlassCard — standard glass card wrapper (audit §3.1).
 * Use instead of ad-hoc gray-card divs so card chrome is identical app-wide.
 * (Named GlassCard because shadcn's card.tsx already exists and macOS
 * filesystems are case-insensitive.)
 */
interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
    padded?: boolean;
}

const GlassCard: React.FC<GlassCardProps> = ({ padded = true, className = '', children, ...rest }) => (
    <div className={`glass rounded-xl ${padded ? 'p-6' : ''} ${className}`} {...rest}>
        {children}
    </div>
);

export default GlassCard;

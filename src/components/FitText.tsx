import { useLayoutEffect, useRef } from 'react';

/**
 * FitText — scales its text down to fit the parent's width.
 *
 * Renders the value at `max` px, then shrinks the font (down to `min` px)
 * until it fits the available width. Re-fits on container resize via
 * ResizeObserver. Pure presentation — no layout/logic side effects.
 *
 * The element this sits in must have a bounded width (e.g. a `min-w-0 flex-1`
 * parent) so there is a real constraint to scale against.
 */
export function FitText({
  children,
  max = 24,
  min = 10,
  className = '',
}: {
  children: React.ReactNode;
  max?: number;
  min?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    const fit = () => {
      let size = max;
      el.style.fontSize = `${size}px`;
      // Shrink until the text fits the parent's content width (or hit min).
      while (el.scrollWidth > parent.clientWidth && size > min) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  });

  return (
    <span
      ref={ref}
      className={className}
      style={{ whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%', lineHeight: 1.1 }}
    >
      {children}
    </span>
  );
}

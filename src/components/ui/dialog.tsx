import React from 'react';
import { cn } from '../../lib/utils';

interface DialogProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const Dialog: React.FC<DialogProps> = ({ 
  children, 
  open = false, 
  onOpenChange 
}) => {
  React.useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open && onOpenChange) {
        onOpenChange(false);
      }
    };

    if (open) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [open, onOpenChange]);

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Only close if clicking directly on the backdrop (not on child elements)
    if (event.target === event.currentTarget && onOpenChange) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    }
  };

  return open ? (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50"
      onClick={handleBackdropClick}
    >
      {children}
    </div>
  ) : null;
};

interface DialogTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

const DialogTrigger = React.forwardRef<HTMLButtonElement, DialogTriggerProps>(
  ({ className, asChild = false, ...props }, ref) => {
    if (asChild) {
      return React.cloneElement(props.children as React.ReactElement, {
        ref,
        ...props,
      });
    }
    return (
      <button
        className={cn(className)}
        ref={ref}
        {...props}
      />
    );
  }
);
DialogTrigger.displayName = 'DialogTrigger';

interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, onClick, ...props }, ref) => {
    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
      // Prevent event bubbling to backdrop
      event.stopPropagation();
      if (onClick) {
        onClick(event);
      }
    };

    return (
      <div
        className={cn(
          'bg-background relative rounded-lg max-w-lg w-full p-6 shadow-lg animate-in fade-in-90 slide-in-from-bottom-10',
          className
        )}
        ref={ref}
        onClick={handleClick}
        {...props}
      />
    );
  }
);
DialogContent.displayName = 'DialogContent';

interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

const DialogHeader = React.forwardRef<HTMLDivElement, DialogHeaderProps>(
  ({ className, ...props }, ref) => (
    <div
      className={cn('flex flex-col space-y-2 text-center sm:text-left mb-4', className)}
      ref={ref}
      {...props}
    />
  )
);
DialogHeader.displayName = 'DialogHeader';

interface DialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

const DialogTitle = React.forwardRef<HTMLHeadingElement, DialogTitleProps>(
  ({ className, ...props }, ref) => (
    <h3
      className={cn(
        'text-lg font-semibold leading-none tracking-tight',
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
DialogTitle.displayName = 'DialogTitle';

export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle }; 
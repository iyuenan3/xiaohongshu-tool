import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';

export interface ConfirmDialogHandle {
  show(info: { name: string; args: unknown }): Promise<boolean>;
}

const ConfirmDialog = forwardRef<ConfirmDialogHandle>((_, ref) => {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ name: string; args: unknown } | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  useImperativeHandle(ref, () => ({
    show: (i) =>
      new Promise<boolean>((resolve) => {
        setInfo(i);
        setOpen(true);
        resolverRef.current = resolve;
      }),
  }));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') decide(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const decide = (v: boolean) => {
    setOpen(false);
    resolverRef.current?.(v);
    resolverRef.current = null;
  };

  if (!open || !info) return null;

  return (
    <div className="confirm-overlay" onClick={() => decide(false)}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <span className="confirm-icon">!</span>
          <h3>AI 想要执行敏感操作</h3>
        </header>
        <div className="confirm-body">
          <p>
            工具: <code>{info.name}</code>
          </p>
          <p>参数:</p>
          <pre>{JSON.stringify(info.args, null, 2)}</pre>
        </div>
        <footer>
          <button onClick={() => decide(false)}>取消 (Esc)</button>
          <button className="primary" onClick={() => decide(true)}>确认执行</button>
        </footer>
      </div>
    </div>
  );
});

ConfirmDialog.displayName = 'ConfirmDialog';
export default ConfirmDialog;

import { useEffect, useRef, type ReactNode } from "react";
export function Modal({
  children,
  label,
  close,
}: {
  children: ReactNode;
  label: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = prior;
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal-overlay"
      aria-labelledby={label}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      {children}
    </dialog>
  );
}

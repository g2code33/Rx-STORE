import React from 'react';
import { useEditMode, EditType } from './EditMode';

interface EditableProps {
  id: string;
  type?: EditType;
  label: string;
  children: React.ReactNode;
  className?: string;
  /** Collection editor: outline the whole block instead of inline text */
  group?: boolean;
}

/**
 * Wraps any piece of public content. For visitors (and in Preview mode) it
 * renders children untouched. In Builder Edit mode it carries an outline +
 * Edit pencil on hover; clicking opens the Inspector for that exact content.
 */
export default function Editable({ id, type = 'text', label, children, className = '', group = false }: EditableProps) {
  const edit = useEditMode();
  if (!edit || !edit.editMode || edit.interact) return <>{children}</>;
  return (
    <span
      className={`rx-ed ${group ? 'rx-ed-group block' : ''} ${className}`}
      role="button"
      title={`Edit — ${label}`}
      onClickCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
        edit.openInspector({ id, type, label });
      }}
    >
      {children}
      <span className="rx-ed-btn">✏️ Edit</span>
    </span>
  );
}

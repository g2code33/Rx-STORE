import React, { createContext, useContext } from 'react';

/** Types of editable content the Inspector knows how to edit. */
export type EditType =
  | 'text' | 'textarea' | 'link' | 'image' | 'color'
  | 'textList' | 'features' | 'platformCards' | 'categories'
  | 'stackCards' | 'statsLabels' | 'linkList' | 'design' | 'blocks';

export interface EditDescriptor { id: string; type: EditType; label: string }

export interface EditCtxType {
  editMode: boolean;
  interact: boolean;
  inspector: EditDescriptor | null;
  openInspector: (d: EditDescriptor) => void;
  closeInspector: () => void;
  /** App-card pencil: builder hands this to open the full AppEditor */
  onEditApp?: (app: any) => void;
}

export const EditModeContext = createContext<EditCtxType | null>(null);

/** Null outside the admin builder — public pages never see edit chrome. */
export function useEditMode() {
  return useContext(EditModeContext);
}

/**
 * Builder host store — the Admin page (owner of builder state) publishes the
 * live builder ctx here; App.tsx provides it to the WHOLE tree (Header, Footer
 * and MobileTabBar included) so edit chrome works everywhere, not just inside
 * the admin route. Null ctx = visitors & normal browsing see nothing.
 */
let builderCtx: EditCtxType | null = null;
const builderListeners = new Set<() => void>();

export function setBuilderCtx(ctx: EditCtxType | null) {
  if (builderCtx === ctx) return;
  builderCtx = ctx;
  builderListeners.forEach((l) => l());
}
export function getBuilderCtx(): EditCtxType | null { return builderCtx; }
export function subscribeBuilder(listener: () => void): () => void {
  builderListeners.add(listener);
  return () => { builderListeners.delete(listener); };
}

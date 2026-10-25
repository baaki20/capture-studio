import { createContext, useContext } from 'react';
import type { EditorServices } from './services';

export const EditorContext = createContext<EditorServices | null>(null);

/** The editor window's services (`services.ts`); only inside `<EditorContext>`. */
export function useEditor(): EditorServices {
  const services = useContext(EditorContext);
  if (!services) throw new Error('useEditor outside the editor');
  return services;
}

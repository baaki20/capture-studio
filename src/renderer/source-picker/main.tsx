import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/theme.css';
import { SourcePickerApp } from './SourcePickerApp';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <SourcePickerApp />
  </StrictMode>,
);

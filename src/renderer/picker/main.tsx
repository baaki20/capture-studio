import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/theme.css';
import { PickerApp } from './PickerApp';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <PickerApp />
  </StrictMode>,
);

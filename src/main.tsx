import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installEnglishUi } from './domain/english-ui';
import './styles.css';

installEnglishUi();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LightStimulusWindow } from './components/LightStimulusWindow';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('stimulus')==='light'?<LightStimulusWindow/>:<App />}
  </React.StrictMode>
);

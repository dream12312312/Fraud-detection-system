import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './bank.css';
import './theme.css';
import './shell.css';
import { initTheme } from './theme.jsx';

initTheme();

createRoot(document.getElementById('root')).render(<App />);

import { createRoot } from 'react-dom/client';
import { App } from './app.js';

const root = document.querySelector('#root');
if (root === null) {
    throw new Error('Missing application root.');
}
createRoot(root).render(<App />);

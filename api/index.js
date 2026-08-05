// Vercel serverless entry point. Vercel routes every request here (see vercel.json)
// and drives the exported Express app; server.js skips app.listen() when VERCEL is set.
export { default } from '../src/server.js';

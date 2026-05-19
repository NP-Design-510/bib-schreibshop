import { handleExport } from '../lib/biblio-core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    return await handleExport(req, res);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Export fehlgeschlagen.' });
  }
}

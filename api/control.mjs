import { logFailure } from '../lib/diagnostics.mjs';
import { createHandler } from '../lib/http-handler.mjs';
import { database } from '../lib/db.mjs';
import { Repository } from '../lib/repository.mjs';
export default async function handler(req, res) {
  try { return await createHandler({ repository: new Repository(database()) })(req, res); }
  catch (error) {
    const diagnostic = logFailure('control_initialization_failed', error);
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: diagnostic.error }));
  }
}

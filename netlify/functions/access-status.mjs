/**
 * GET /api/access-status
 *
 * Lets the UI show an honest open/closed state using the *server's* clock
 * rather than the device's.
 */
import { evaluateAccess } from '../../shared/access.js';
import { json, loadConfig } from '../lib/http.mjs';
import { publicStatus } from '../lib/status.mjs';

export default async () => {
  const config = await loadConfig();
  return json(publicStatus(config, evaluateAccess(config, new Date())));
};

export const config = { path: '/api/access-status' };

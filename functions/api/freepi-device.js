import { handleFreePiDevice } from '../../server/ai/handlers.mjs';
import { jsonRes } from '../../server/ai/common.mjs';
import { mismoOrigen } from '../../server/imageSearch.mjs';

export async function onRequest({ request }) {
  if (!mismoOrigen(request.headers)) return jsonRes({ error: 'forbidden' }, 403);
  return await handleFreePiDevice(request);
}

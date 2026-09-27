/**
 * The workspace link is the credential, so no response may let the browser
 * send it on in a `Referer` header. Static assets get this header from
 * `public/_headers`; that file doesn't cover responses the Worker creates, so
 * the Worker adds it here.
 */
export function withReferrerPolicy(response: Response): Response {
  // A WebSocket upgrade (101) is passed through untouched: it isn't a
  // document, so the header would do nothing, and there's no reason to
  // rebuild a response that carries a live socket.
  if (response.status === 101) return response;
  const copy = new Response(response.body, response);
  copy.headers.set("Referrer-Policy", "no-referrer");
  return copy;
}

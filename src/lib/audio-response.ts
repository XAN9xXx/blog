/** Development endpoint supports seeking; production serves the generated static file. */
export function audioResponse(bytes: Uint8Array, type: string, range: string | null = null): Response {
  const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes' });
  let start = 0, end = bytes.length - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return unsatisfied();
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
    else { start = Math.max(0, bytes.length - Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) return unsatisfied();
    headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
  }
  const body = new Uint8Array(bytes.subarray(start, end + 1));
  headers.set('Content-Length', String(body.length));
  return new Response(body, { status: range ? 206 : 200, headers });
  function unsatisfied() {
    headers.set('Content-Range', `bytes */${bytes.length}`);
    return new Response(null, { status: 416, headers });
  }
}

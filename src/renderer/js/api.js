// Thin wrapper around the preload bridge. Main-process handlers answer
// { ok, data } or { ok: false, error: { code, params } }; errors are rethrown
// as ApiError so pages can show the translated message.

export class ApiError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params || {};
  }
}

let onAuthRequired = () => {};

export function setAuthRequiredHandler(fn) {
  onAuthRequired = fn;
}

export async function call(channel, payload) {
  const res = await window.api.invoke(channel, payload);
  if (res && res.ok) return res.data;
  const error = (res && res.error) || { code: 'error.unexpected', params: {} };
  if (error.code === 'error.auth.required' && !channel.startsWith('auth:')) onAuthRequired();
  throw new ApiError(error.code, error.params);
}

import { describe, expect, it, vi } from 'vitest';
import { createNativeGoogleAuth } from './index.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

function fakePlugin({ loginToken = 'login-token', silentToken = 'silent-token', initFailures = 0 } = {}) {
  let failuresLeft = initFailures;
  return {
    initialize: vi.fn(async () => {
      if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('init failed'); }
    }),
    login: vi.fn(async () => ({ provider: 'google', result: { accessToken: loginToken ? { token: loginToken } : null } })),
    refresh: vi.fn(async () => {}),
    getAuthorizationCode: vi.fn(async () => ({ accessToken: silentToken })),
    logout: vi.fn(async () => {}),
  };
}

/** Fake Google tokeninfo: reports `expiresIn` seconds left, or fails with `status`. */
function fakeTokenInfo({ expiresIn = 1800, status = 200 } = {}) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => ({ expires_in: String(expiresIn) }) }));
}

function build({ plugin = fakePlugin(), fetchImpl = fakeTokenInfo() } = {}) {
  const auth = createNativeGoogleAuth({ webClientId: 'web-client', fetchImpl, loadPlugin: async () => plugin });
  return { auth, plugin, fetchImpl };
}

describe('nativeGoogleAuth.js', () => {
  describe('createNativeGoogleAuth', () => {
    describe('requestToken', () => {
      it('asks for Drive access interactively and reports the time the token has left', async () => {
        const { auth, plugin } = build();

        const token = await auth.requestToken({ interactive: true });

        expect([token, plugin.login.mock.calls[0][0].options.scopes.includes(DRIVE_SCOPE)])
          .toEqual([{ access_token: 'login-token', expires_in: 1800 }, true]);
      });

      it('renews silently without showing the account sheet', async () => {
        const { auth, plugin } = build();

        const token = await auth.requestToken({ interactive: false });

        expect([token, plugin.refresh.mock.calls.length, plugin.login.mock.calls.length])
          .toEqual([{ access_token: 'silent-token', expires_in: 1800 }, 1, 0]);
      });

      it.each([
        ['Google returned no access token', { plugin: fakePlugin({ loginToken: null }) }],
        ['Google says the token is not valid', { fetchImpl: fakeTokenInfo({ status: 400 }) }],
        ['the token has no time left', { fetchImpl: fakeTokenInfo({ expiresIn: 0 }) }],
      ])('resolves null when %s', async (_name, options) => {
        const { auth } = build(options);

        expect(await auth.requestToken({ interactive: true })).toBeNull();
      });

      it('rejects rather than reporting a denied grant when the token check itself fails', async () => {
        const { auth } = build({ fetchImpl: fakeTokenInfo({ status: 503 }) });

        await expect(auth.requestToken({ interactive: true })).rejects.toThrow('503');
      });

      it('initialises the plugin once with the web client id, and retries after a failed start', async () => {
        const plugin = fakePlugin({ initFailures: 1 });
        const { auth } = build({ plugin });

        await expect(auth.requestToken({ interactive: true })).rejects.toThrow('init failed');
        await auth.requestToken({ interactive: true });
        await auth.requestToken({ interactive: false });

        expect(plugin.initialize.mock.calls).toEqual([
          [{ google: { webClientId: 'web-client', mode: 'online' } }],
          [{ google: { webClientId: 'web-client', mode: 'online' } }],
        ]);
      });
    });

    describe('signOut', () => {
      it('signs the Google account out on the device', async () => {
        const { auth, plugin } = build();

        await auth.signOut();

        expect(plugin.logout).toHaveBeenCalledWith({ provider: 'google' });
      });
    });
  });
});

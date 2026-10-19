/**
 * Google sign-in for the Android app.
 *
 * Google refuses OAuth inside an embedded WebView, so the browser token popup
 * cannot run in the Capacitor shell. This asks Android itself (Credential
 * Manager + AuthorizationClient, via @capgo/capacitor-social-login) for the
 * `drive.appdata` access token, and can renew it without any UI once the user
 * has granted it, which the browser flow cannot.
 *
 * Returns tokens in the shape Google's browser token client uses
 * (`{ access_token, expires_in }`) so @joka-7/drive-sync treats both alike.
 */

const SCOPES = ["https://www.googleapis.com/auth/drive.appdata", "email", "profile"];
const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

export interface TokenResponse { access_token: string; expires_in: number }

/** The part of the SocialLogin plugin this module calls. */
export interface SocialLoginPlugin {
  initialize(options: { google: { webClientId: string; mode: "online" } }): Promise<unknown>;
  login(options: { provider: "google"; options: { scopes: string[] } }): Promise<{ result?: { accessToken?: { token?: string } | null } }>;
  refresh(options: { provider: "google"; options: { scopes: string[] } }): Promise<unknown>;
  getAuthorizationCode(options: { provider: "google" }): Promise<{ accessToken?: string | null }>;
  logout(options: { provider: "google" }): Promise<unknown>;
}

const loadSocialLogin = async (): Promise<SocialLoginPlugin> =>
  (await import("@capgo/capacitor-social-login")).SocialLogin as unknown as SocialLoginPlugin;

export interface NativeGoogleAuthOptions {
  /**
   * The OAuth *Web* client ID. Android matches it to the Android client
   * registered for this package and signing key.
   */
  webClientId: string;
  fetchImpl: typeof fetch;
  loadPlugin?: () => Promise<SocialLoginPlugin>;
}

export function createNativeGoogleAuth({ webClientId, fetchImpl, loadPlugin = loadSocialLogin }: NativeGoogleAuthOptions) {
  let ready: Promise<SocialLoginPlugin> | null = null;

  function plugin(): Promise<SocialLoginPlugin> {
    ready ??= loadPlugin()
      .then(async (socialLogin) => {
        await socialLogin.initialize({ google: { webClientId, mode: "online" } });
        return socialLogin;
      })
      .catch((err) => { ready = null; throw err; });
    return ready;
  }

  /** The plugin does not report expiry, and a cached token may be part-way through its hour. */
  async function withExpiry(accessToken: string | null | undefined): Promise<TokenResponse | null> {
    if (!accessToken) return null;
    const res = await fetchImpl(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
    // 400 is Google saying the token is invalid; anything else is a failed
    // check, which must not be reported to the user as "access denied".
    if (res.status === 400) return null;
    if (!res.ok) throw new Error(`Could not check the Google token (${res.status}).`);
    const info = await res.json();
    const expiresIn = Number(info.expires_in);
    return Number.isFinite(expiresIn) && expiresIn > 0 ? { access_token: accessToken, expires_in: expiresIn } : null;
  }

  return {
    /**
     * Interactive shows Google's account sheet; silent renews a token the user
     * already granted, and rejects if that needs the user. Resolves `null`
     * when Google returned no usable Drive token.
     */
    async requestToken({ interactive }: { interactive: boolean }): Promise<TokenResponse | null> {
      const socialLogin = await plugin();
      if (interactive) {
        const { result } = await socialLogin.login({ provider: "google", options: { scopes: SCOPES } });
        return withExpiry(result?.accessToken?.token);
      }
      await socialLogin.refresh({ provider: "google", options: { scopes: SCOPES } });
      const { accessToken } = await socialLogin.getAuthorizationCode({ provider: "google" });
      return withExpiry(accessToken);
    },

    async signOut(): Promise<void> {
      const socialLogin = await plugin();
      await socialLogin.logout({ provider: "google" });
    },
  };
}

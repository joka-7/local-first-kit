export const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

export interface TokenProvider {
  getToken(interactive?: boolean): Promise<string>;
  signOut(): void;
}

interface GisTokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
}
interface GisWindow {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient(cfg: {
          client_id: string;
          scope: string;
          callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void;
        }): GisTokenClient;
        revoke(token: string, done?: () => void): void;
      };
    };
  };
}

function loadGis(): Promise<void> {
  if ((window as GisWindow).google) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
}

/** Web sign-in with Google Identity Services. Token stays in memory only. */
export function createWebAuth(clientId: string): TokenProvider {
  let token: string | null = null;
  let expiresAt = 0;
  return {
    async getToken(interactive = true) {
      if (token && Date.now() < expiresAt - 30_000) return token;
      if (!interactive) throw new Error("Sign-in required");
      await loadGis();
      const oauth2 = (window as GisWindow).google!.accounts.oauth2;
      return new Promise<string>((resolve, reject) => {
        oauth2
          .initTokenClient({
            client_id: clientId,
            scope: DRIVE_APPDATA_SCOPE,
            callback: (r) => {
              if (!r.access_token) return reject(new Error(r.error ?? "Sign-in failed"));
              token = r.access_token;
              expiresAt = Date.now() + (r.expires_in ?? 3600) * 1000;
              resolve(token);
            },
          })
          .requestAccessToken();
      });
    },
    signOut() {
      if (token) (window as GisWindow).google?.accounts.oauth2.revoke(token);
      token = null;
      expiresAt = 0;
    },
  };
}

/** Mobile: wrap a native plugin (see capacitor-template) that returns an access token. */
export function createNativeAuth(nativeGetToken: (interactive: boolean) => Promise<string>, nativeSignOut: () => void): TokenProvider {
  return { getToken: (i = true) => nativeGetToken(i), signOut: nativeSignOut };
}

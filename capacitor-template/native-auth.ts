import { SocialLogin } from "@capgo/capacitor-social-login";
import { createNativeAuth, DRIVE_APPDATA_SCOPE } from "@joka-7/drive-sync";

export function createCapacitorAuth(webClientId: string) {
  let token: string | null = null;
  let initialized = false;
  return createNativeAuth(
    async (interactive) => {
      if (token) return token;
      if (!interactive) throw new Error("Sign-in required");
      if (!initialized) {
        await SocialLogin.initialize({ google: { webClientId } });
        initialized = true;
      }
      const res = await SocialLogin.login({
        provider: "google",
        options: { scopes: [DRIVE_APPDATA_SCOPE] },
      });
      const access = (res.result as { accessToken?: { token?: string } }).accessToken?.token;
      if (!access) throw new Error("Google sign-in returned no access token");
      token = access;
      return access;
    },
    () => {
      token = null;
      void SocialLogin.logout({ provider: "google" });
    },
  );
}

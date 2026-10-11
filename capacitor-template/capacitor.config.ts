import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.joka7.REPLACE_ME",
  appName: "REPLACE_ME",
  webDir: "dist",
  plugins: {
    GoogleAuth: {
      scopes: ["https://www.googleapis.com/auth/drive.appdata"],
      serverClientId: "REPLACE_WITH_WEB_OAUTH_CLIENT_ID",
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;

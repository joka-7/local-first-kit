export interface DriveSyncErrorOptions {
  status?: number;
  code?: string;
  cause?: unknown;
}

/** Error raised for any failed Drive or Google sign-in request. */
export class DriveSyncError extends Error {
  status: number;
  code: string;

  constructor(message: string, { status = 0, code = "", cause }: DriveSyncErrorOptions = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DriveSyncError";
    this.status = status;
    this.code = code;
  }
}

/** Raised when Google cannot be reached at all: the work is kept and retried once the network is back. */
export function offlineError(cause?: unknown): DriveSyncError {
  return new DriveSyncError("Cannot reach Google Drive.", { code: "offline", cause });
}

/** Errors that retrying will not fix, so the file is skipped rather than failing the read. */
export const isPermanentlyUnreadable = (err: unknown): boolean => {
  const e = err as Partial<DriveSyncError> | null | undefined;
  return e?.status === 404 || e?.code === "corrupt-file" || e?.code === "unsupported-version";
};

/** User-facing message for a failed "Connect Drive". */
export function formatSignInError(err: unknown): string {
  const e = err as Partial<DriveSyncError> | null | undefined;
  const code = e?.code || "";
  if (code === "popup_failed_to_open") return "Popup blocked. Allow popups for this site, then try again.";
  if (code === "popup_closed" || code === "access_denied") return "Sign-in cancelled.";
  if (code === "gis-load-failed") return "Could not reach Google. Check your connection or ad blocker.";
  if (code === "not-configured") return "Google Drive sync is not configured for this build.";
  return e?.message || "Sign-in failed.";
}
